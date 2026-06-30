/**
 * Local export — scene-driven frame compositor (Method 3, Phase 5).
 *
 * A drop-in replacement for {@link FrameCompositor} that composites each export frame through the SAME
 * shared `SceneCompositor` + `buildSceneDraws` the EDITOR preview uses, instead of the canvas2D path. So
 * the on-screen preview literally becomes the exported MP4 — the Method 3 goal — collapsing the last of
 * the three separate composite implementations the gates kept in sync by hand.
 *
 * It shares the exact same interface as `FrameCompositor` — `constructor(composition, canvas, getSource)`,
 * `async renderFrame(t)`, `dispose()` — so `export-core` selects between them with one flag-gated branch and
 * the encode loop is untouched. The output canvas is a WebGL2 surface (the compositor presents to it via a
 * fullscreen quad), so `new VideoFrame(canvas)` in the encoder reads the GPU-composited frame directly.
 *
 * The ONLY thing this does that the editor's `ScenePreviewCanvas` gets "for free":
 *   1. **Grade media inline** — the editor reads each media layer's graded canvas from a hidden
 *      `WebglMediaLayer` (`gradedRef`); here we decode the WebCodecs frame and grade it through a per-layer
 *      `MediaWebGLRenderer` (the same engine, the same `gradeMediaLayer` logic the canvas2D export uses).
 *   2. **Await all async work up front** — `buildSceneDraws` reads media grades + text rasters
 *      synchronously (the editor tolerates a 1-frame lag; an export frame must be complete). So we await
 *      every media grade AND `rasterizer.ensure()` for every text/shape layer BEFORE building the draw list,
 *      guaranteeing the synchronous reads inside `buildSceneDraws` are cache hits.
 *
 * Everything else — object-fit, clip masks, blend, blur/glow, 3D tilt, junction transitions, adjustment
 * stacking, region-effect expansion (done upstream in `export-core`) — is the shared builder's job, so it
 * stays byte-for-byte aligned with the preview by construction.
 */

import {
  MediaWebGLRenderer,
  SceneCompositor,
  findTransitionPairs,
  getActiveGlContextCount,
  getActiveTransition,
  getCompositionColorPipeline,
  getCompositionFilterEffects,
  getCompositionMediaEffects,
  getCompositionObjectFit,
  isTrackEnabled,
  type SceneFrameSpec,
  type TimelineComposition,
  type TimelineLayer,
  type TransitionSpec,
} from "@reelforge/shared";
import { logExportGl, warnExportGlThresholdOnce } from "./export-gl-debug";
import type { FrameProvider } from "./source-decoder";
import { buildSceneDraws, type ScenePreviewTransition } from "../scene/build-scene-draws";
import { SceneMaskMatteCache } from "../components/scene-mask-matte";
import { SceneTextRasterizer } from "../components/scene-text-raster";

/** A `<canvas>` (main-thread fallback) or `OffscreenCanvas` (export Worker). */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * WebGL context budget. Only ~1 media clip (2 during a transition) is active on any frame, so we reuse a
 * tiny pool of `MediaWebGLRenderer`s across clips instead of one-per-clip — bounding live contexts well
 * under the browser's ~16 cap. `MAX_POOLED_MEDIA_RENDERERS` is the idle free-list size (reused before a
 * `new` context is created, disposed past this so a long export doesn't hoard); `SAFE_CONTEXT_THRESHOLD`
 * is the live-count past which we warn (we're nearing eviction — the preview's context is at risk).
 */
const MAX_POOLED_MEDIA_RENDERERS = 2;
const SAFE_CONTEXT_THRESHOLD = 8;

interface FlatLayer {
  layer: TimelineLayer;
  trackIndex: number;
  layerIndex: number;
}

export class SceneFrameCompositor {
  private readonly width: number;
  private readonly height: number;
  private readonly compositor: SceneCompositor;
  private readonly matteCache: SceneMaskMatteCache;
  private readonly rasterizer: SceneTextRasterizer;
  // Driver-owned media-grade renderers (one GL context each), keyed by the layer CURRENTLY using them.
  // Bounded by a free-list pool (pruneMediaRenderers): a clip leaving the active set returns its renderer
  // to `freeMediaRenderers` for the next clip to reuse, so live media contexts ≈ concurrent-active media
  // (1–2) + the small free-list — NOT one-per-clip. Distinct from the `gradeRenderers` pool below, which
  // `buildSceneDraws` owns for OVERLAY (text/shape) grading.
  private readonly mediaRenderers = new Map<string, MediaWebGLRenderer>();
  private readonly freeMediaRenderers: MediaWebGLRenderer[] = [];
  private readonly mediaPipelineKeys = new Map<string, string>();
  private peakContextCount = 0;
  // Pools `buildSceneDraws` lazily fills + prunes: per-text/shape-layer overlay-grade renderers and
  // per-active-junction transition mix engines. We own them so they persist + get disposed with us.
  private readonly gradeRenderers = new Map<string, { renderer: MediaWebGLRenderer; pipelineKey: string }>();
  private readonly flat: FlatLayer[];
  private readonly adjustments: FlatLayer[];
  private readonly flatById = new Map<string, FlatLayer>();

  constructor(
    private readonly composition: TimelineComposition,
    canvas: AnyCanvas,
    private readonly getSource: (assetId: string) => FrameProvider | undefined
  ) {
    this.width = composition.width;
    this.height = composition.height;
    this.compositor = new SceneCompositor(canvas, this.width, this.height);
    this.matteCache = new SceneMaskMatteCache(this.width, this.height);
    // No `onReady` callback: the export AWAITS `rasterizer.ensure()` per frame, so there's no draw loop to
    // re-arm (unlike the editor's fire-and-forget `get()`).
    this.rasterizer = new SceneTextRasterizer();

    const flat: FlatLayer[] = [];
    this.composition.tracks.forEach((track, trackIndex) => {
      track.layers.forEach((layer, layerIndex) => flat.push({ layer, trackIndex, layerIndex }));
    });
    this.adjustments = flat.filter((f) => f.layer.type === "adjustment");
    // Back-to-front: track 0 is the TOP track → draw highest trackIndex first, ties by layerIndex asc.
    // Identical to FrameCompositor + the editor's renderedLayerEntries, so z-order matches exactly.
    this.flat = flat
      .slice()
      .sort((a, b) => (a.trackIndex !== b.trackIndex ? b.trackIndex - a.trackIndex : a.layerIndex - b.layerIndex));
    for (const item of flat) this.flatById.set(item.layer.id, item);
  }

  /** A detached `<canvas>` on the main thread, or an `OffscreenCanvas` inside the export Worker. */
  private makeCanvas(): AnyCanvas {
    return typeof document !== "undefined"
      ? document.createElement("canvas")
      : new OffscreenCanvas(this.width, this.height);
  }

  /**
   * Adjustment-clip effects that sit above `target` and are active at `t`, merged into the layer — mirrors
   * FrameCompositor.mergedLayer + the editor's applyActiveAdjustmentEffects. An adjustment affects layers on
   * lower-in-the-stack (higher-index) tracks: `adjustment.trackIndex < target.trackIndex`. Both media (whose
   * grade reads the merged pipeline) AND text/shape (whose grade/blur `buildSceneDraws` reads off effects)
   * must carry the merge, so we apply it to every layer handed to the builder.
   */
  private mergedLayer(target: FlatLayer, t: number): TimelineLayer {
    const extra = this.adjustments
      .filter(
        (a) =>
          a.trackIndex < target.trackIndex &&
          t >= a.layer.startSeconds &&
          t < a.layer.startSeconds + a.layer.durationSeconds
      )
      .flatMap((a) => a.layer.effects);
    if (!extra.length) return target.layer;
    return { ...target.layer, effects: [...target.layer.effects, ...extra] };
  }

  /**
   * How long this clip keeps rendering past its out-point: the duration of the next same-track clip's
   * `transitionIn` (the window the outgoing clip is composited under). 0 if none. Matches FrameCompositor.
   */
  private postrollSeconds(item: FlatLayer): number {
    const track = this.composition.tracks[item.trackIndex];
    if (!track) return 0;
    const end = item.layer.startSeconds + item.layer.durationSeconds;
    let best = 0;
    for (const other of track.layers) {
      if (other.id === item.layer.id || !other.transitionIn) continue;
      if (Math.abs(other.startSeconds - end) < 0.05) best = Math.max(best, other.transitionIn.durationSeconds);
    }
    return best;
  }

  private mediaRendererFor(id: string): MediaWebGLRenderer {
    let renderer = this.mediaRenderers.get(id);
    if (!renderer) {
      // Reuse a pooled renderer (a clip that just left the active set) before creating a new GL context.
      // `mediaPipelineKeys` has no entry for this id, so the next gradeMediaLayer re-bakes setPipeline →
      // the reused renderer fully adopts the new layer's grade. Only allocate when the pool is empty.
      renderer = this.freeMediaRenderers.pop();
      if (renderer) {
        logExportGl(() => `media renderer reused from pool (free=${this.freeMediaRenderers.length})`);
      } else {
        renderer = new MediaWebGLRenderer(this.makeCanvas());
        logExportGl(() => `media renderer created (active contexts=${getActiveGlContextCount()})`);
      }
      this.mediaRenderers.set(id, renderer);
    }
    return renderer;
  }

  /**
   * Return renderers whose clip is no longer active to the free-list for reuse (rule 4: only keep GL
   * renderers for clips visible on the current frame). The free-list is capped at MAX_POOLED_MEDIA_RENDERERS
   * — overflow is disposed immediately (rule 5) so a long timeline doesn't hoard one context per clip.
   */
  private pruneMediaRenderers(activeMediaIds: Set<string>): void {
    for (const [id, renderer] of this.mediaRenderers) {
      if (activeMediaIds.has(id)) continue;
      this.mediaRenderers.delete(id);
      this.mediaPipelineKeys.delete(id);
      if (this.freeMediaRenderers.length < MAX_POOLED_MEDIA_RENDERERS) {
        this.freeMediaRenderers.push(renderer);
      } else {
        renderer.dispose();
      }
    }
  }

  /**
   * Decode, matte, and color-grade a media layer's frame at `t` into its `MediaWebGLRenderer`, returning the
   * graded canvas (color + matte + media-effects baked, **opacity NOT baked** — the composite quad applies
   * it live, matching the editor's `bakeOpacity={false}` scene-media path) or null if no frame yet. This is
   * the export's inline equivalent of the hidden `WebglMediaLayer` that fills the editor's `gradedRef`.
   */
  private async gradeMediaLayer(item: FlatLayer, t: number): Promise<AnyCanvas | null> {
    const { layer } = item;
    if (!layer.assetId) return null;
    const source = this.getSource(layer.assetId);
    if (!source) return null;

    const sourceTime = layer.type === "video" ? (layer.sourceInSeconds ?? 0) + (t - layer.startSeconds) : 0;
    const frame = await source.getFrame(sourceTime);
    if (!frame || source.width === 0 || source.height === 0) return null;

    let matteFrame: CanvasImageSource | null = null;
    if (layer.matte?.uri) {
      const matteSource = this.getSource(`matte:${layer.id}`);
      if (matteSource) {
        const mf = await matteSource.getFrame(sourceTime);
        if (mf && matteSource.width > 0) matteFrame = mf;
      }
    }

    const merged = this.mergedLayer(item, t);
    const pipeline = getCompositionColorPipeline(merged, { currentTimeSeconds: t });
    const mediaEffects = getCompositionMediaEffects(merged, { currentTimeSeconds: t });

    const renderer = this.mediaRendererFor(layer.id);
    const pipelineKey = JSON.stringify(pipeline);
    if (this.mediaPipelineKeys.get(layer.id) !== pipelineKey) {
      renderer.setPipeline(pipeline);
      this.mediaPipelineKeys.set(layer.id, pipelineKey);
    }
    renderer.draw({
      source: frame as TexImageSource,
      sourceWidth: source.width,
      sourceHeight: source.height,
      matte: matteFrame as TexImageSource | null,
      matteInvert: layer.matte?.invert ?? false,
      matteOpacity: layer.matte?.opacity ?? 1,
      pipeline,
      amount: 1,
      opacity: 1, // NOT baked — buildSceneDraws applies opacity via the quad (live, like the editor)
      mediaEffects,
      transition: null, // junction transitions are the unified engine's job (buildSceneDraws), not a reveal
    });
    return renderer.canvas as AnyCanvas;
  }

  /** Render the composition at `timeSeconds` onto the WebGL output canvas (mirrors FrameCompositor.renderFrame). */
  async renderFrame(timeSeconds: number): Promise<void> {
    const t = timeSeconds;

    // Track enable/solo: skip layers on muted/hidden tracks or silenced by another track's solo.
    const disabledTrackIds = new Set(
      this.composition.tracks.filter((tr) => !isTrackEnabled(tr, this.composition.tracks)).map((tr) => tr.id)
    );

    // Active visual layers: in their own span, or inside the post-roll of the next clip's transition. Audio
    // and adjustment clips don't composite (adjustments fold into other layers via mergedLayer).
    const activeItems = this.flat.filter((item) => {
      const { layer } = item;
      if (disabledTrackIds.has(layer.trackId)) return false;
      if (layer.type !== "video" && layer.type !== "image" && layer.type !== "text" && layer.type !== "shape") {
        return false;
      }
      const postroll = this.postrollSeconds(item);
      return t >= layer.startSeconds && t < layer.startSeconds + layer.durationSeconds + postroll;
    });

    // Budget (rule 4): release media renderers whose clip is no longer active BEFORE grading this frame, so
    // only currently-visible clips hold a GL context. A clip active across consecutive frames keeps its
    // renderer; one that leaves goes to the free-list for the next clip to reuse.
    const activeMediaIds = new Set(
      activeItems.filter((it) => it.layer.type === "video" || it.layer.type === "image").map((it) => it.layer.id)
    );
    this.pruneMediaRenderers(activeMediaIds);

    // Adjustment-merged layer list in back-to-front (z) order — exactly what the editor passes as `sceneLayers`.
    const layers = activeItems.map((item) => this.mergedLayer(item, t));

    // Active junction transitions ONLY (an inactive pair would make buildSceneDraws wrongly skip the outgoing
    // clip, which it unconditionally treats as folded-into-the-mix). Mirrors VideoPreview.transitionPairs.
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const transitions: ScenePreviewTransition[] = [];
    for (const pair of findTransitionPairs(layers)) {
      const incoming = byId.get(pair.incomingId);
      const outgoing = byId.get(pair.outgoingId);
      if (!incoming || !outgoing) continue;
      const active = getActiveTransition(pair.spec as TransitionSpec, {
        currentTimeSeconds: t,
        startSeconds: incoming.startSeconds,
      });
      if (!active) continue;
      transitions.push({
        outgoingId: pair.outgoingId,
        incomingId: pair.incomingId,
        spec: pair.spec as TransitionSpec,
        startSeconds: incoming.startSeconds,
        fromFit: getCompositionObjectFit(outgoing) as "cover" | "contain" | "fill",
        toFit: getCompositionObjectFit(incoming) as "cover" | "contain" | "fill",
      });
    }

    // (1) Grade EVERY active media layer (incl. both sides of an active transition — the mix reads both
    // graded canvases) into a map, awaiting all of them so the synchronous getMediaGraded inside
    // buildSceneDraws is always satisfied.
    const gradedById = new Map<string, AnyCanvas>();
    await Promise.all(
      activeItems
        .filter((item) => item.layer.type === "video" || item.layer.type === "image")
        .map(async (item) => {
          const canvas = await this.gradeMediaLayer(item, t);
          if (canvas && canvas.width > 0 && canvas.height > 0) gradedById.set(item.layer.id, canvas);
        })
    );

    // (2) Pre-warm every text/shape raster so the fire-and-forget get() inside buildSceneDraws hits cache.
    // boxMode MUST match buildSceneDraws' own computation (no blur/glow → tight element-box raster).
    await Promise.all(
      layers
        .filter((layer) => layer.type === "text" || layer.type === "shape")
        .map(async (layer) => {
          const fx = getCompositionFilterEffects(layer, { currentTimeSeconds: t });
          const boxMode = !(fx.blurPx > 0 || fx.glow);
          await this.rasterizer.ensure(layer, t, this.width, this.height, boxMode);
        })
    );

    // (3) Build the shared draw list + present. renderScale=1 (export is always full resolution).
    const draws = buildSceneDraws({
      layers,
      width: this.width,
      height: this.height,
      currentTime: t,
      renderScale: 1,
      transitions,
      rasterizer: this.rasterizer,
      matteCache: this.matteCache,
      gradeRenderers: this.gradeRenderers,
      getMediaGraded: (id) => gradedById.get(id) ?? null,
      createCanvas: () => this.makeCanvas(),
    });

    const spec: SceneFrameSpec = {
      width: this.width,
      height: this.height,
      backgroundColor: this.composition.backgroundColor || "#000000",
      layers: draws,
    };
    this.compositor.renderFrame(spec);

    // Budget telemetry (rule 8): track the live WebGL context peak and warn ONCE if we cross the safe
    // threshold — we're nearing the browser's cap and risk evicting the preview's context. We do NOT
    // proactively fall back to canvas2D here (that would drop the bloom/blur the user wants in export); the
    // pool keeps us under by design, and export-core's render-error → FrameCompositor path is the real net.
    const live = getActiveGlContextCount();
    if (live > this.peakContextCount) this.peakContextCount = live;
    if (live > SAFE_CONTEXT_THRESHOLD) warnExportGlThresholdOnce(live, SAFE_CONTEXT_THRESHOLD);
  }

  /** Highest live WebGL context count observed across this export (for the stress gate + debug log). */
  getPeakContextCount(): number {
    return this.peakContextCount;
  }

  dispose(): void {
    const safe = (fn: () => void) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    };
    safe(() => this.compositor.dispose());
    safe(() => this.matteCache.dispose());
    safe(() => this.rasterizer.dispose());
    for (const renderer of this.mediaRenderers.values()) safe(() => renderer.dispose());
    this.mediaRenderers.clear();
    for (const renderer of this.freeMediaRenderers) safe(() => renderer.dispose());
    this.freeMediaRenderers.length = 0;
    this.mediaPipelineKeys.clear();
    for (const { renderer } of this.gradeRenderers.values()) safe(() => renderer.dispose());
    this.gradeRenderers.clear();
    logExportGl(() => `SceneFrameCompositor disposed (active contexts=${getActiveGlContextCount()}, peak=${this.peakContextCount})`);
  }
}
