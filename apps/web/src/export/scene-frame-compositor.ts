/**
 * Local export — scene-driven frame compositor (Method 3, Phase 5).
 *
 * The SOLE local export compositor (Phase 5 retired the canvas2D path): it composites each export frame
 * through the SAME shared `SceneCompositor` + `buildSceneDraws` the EDITOR preview uses. So the on-screen
 * preview literally becomes the exported MP4 — the Method 3 goal — collapsing the last of the three
 * separate composite implementations the gates kept in sync by hand.
 *
 * Interface: `constructor(composition, canvas, getSource, options?)`, `async renderFrame(t)`, `dispose()` —
 * `export-core` constructs it unconditionally and the encode loop is untouched. The output canvas is a
 * WebGL2 surface (the compositor presents to it via a fullscreen quad), so `new VideoFrame(canvas)` in the
 * encoder reads the GPU-composited frame directly.
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
  RenderTarget,
  SceneCompositor,
  findTransitionPairs,
  getActiveGlContextCount,
  getActiveTransition,
  getCompositionColorPipeline,
  getCompositionFilterEffects,
  getCompositionMediaEffects,
  getCompositionObjectFit,
  isSceneTextureSource,
  isTrackEnabled,
  buildSceneDraws,
  buildRegionBlurCloneAliases,
  SceneMaskMatteCache,
  SceneTextRasterizer,
  layerSourceTimeSeconds,
  type ColorPipeline,
  type NestedGroupSpec,
  type SceneCompositorDebugSnapshot,
  type SceneDraw,
  type SceneFrameSpec,
  type SceneLayerDraw,
  type SceneTextureSource,
  type ScenePreviewTransition,
  type TimelineComposition,
  type TimelineLayer,
  type TransitionSpec,
} from "@lumio-by-aelivion/shared";
import { getExportSingleContext, getRegionPassesEnabled } from "../color/render-engine";
import { logExportGl, warnExportGlThresholdOnce } from "./export-gl-debug";
import { clipSourceKey, type FrameProvider } from "./source-decoder";

/** A `<canvas>` (main-thread fallback) or `OffscreenCanvas` (export Worker). */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

interface SceneFrameStageProbeOptions {
  sampleTimes: number[];
  fps: number;
  onProbe: (probe: { stage: "decode" | "rtt" | "draws" | "gl"; timeSeconds: number; meanLuma?: number; layerId?: string; assetId?: string; detail?: string }) => void;
}

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
  // Phase 2 single-context export: when ON, media + overlay grading render into RenderTargets on the
  // SceneCompositor's OWN WebGL2 context (no per-clip context, no cross-context canvas upload) — so the whole
  // export is one self-contained context (Worker-portable). OFF (default) keeps the proven own-canvas path
  // above byte-for-byte. The two pools below are used ONLY in single-context mode.
  private readonly singleContext: boolean;
  private readonly sharedGl: WebGL2RenderingContext | null;
  private readonly stageProbe: SceneFrameStageProbeOptions | null;
  private readonly mediaSharedRenderers = new Map<string, { renderer: MediaWebGLRenderer; target: RenderTarget }>();
  private readonly freeMediaShared: { renderer: MediaWebGLRenderer; target: RenderTarget }[] = [];
  private readonly overlaySharedRenderers = new Map<string, { renderer: MediaWebGLRenderer; target: RenderTarget; pipelineKey: string }>();
  // Pools `buildSceneDraws` lazily fills + prunes: per-text/shape-layer overlay-grade renderers and
  // per-active-junction transition mix engines. We own them so they persist + get disposed with us.
  private readonly gradeRenderers = new Map<string, { renderer: MediaWebGLRenderer; pipelineKey: string }>();
  // Compound-clip group specs (NESTING.md Phase C) — `composition`'s tracks already carry nested children
  // as ordinary layers (export-core nest-expands before constructing this), so this is ONLY consulted by
  // buildSceneDraws to fold those children back into a group + build the compound clip's shell.
  private readonly nestedGroups: ReadonlyMap<string, NestedGroupSpec> | undefined;
  // Per-nested-composition matte caches — mirrors `this.matteCache` but sized per nest, not the export
  // frame. See `nestMatteCaches` doc on `BuildSceneDrawsInputs`.
  private readonly nestMatteCaches = new Map<string, SceneMaskMatteCache>();
  private readonly flat: FlatLayer[];
  private readonly adjustments: FlatLayer[];
  private readonly flatById = new Map<string, FlatLayer>();

  constructor(
    private readonly composition: TimelineComposition,
    canvas: AnyCanvas,
    private readonly getSource: (assetId: string) => FrameProvider | undefined,
    options?: {
      singleContext?: boolean;
      stageProbe?: SceneFrameStageProbeOptions;
      nestedGroups?: ReadonlyMap<string, NestedGroupSpec>;
    }
  ) {
    this.width = composition.width;
    this.height = composition.height;
    this.compositor = new SceneCompositor(canvas, this.width, this.height);
    // Resolve single-context mode (default OFF). Explicit option wins (export-core/fixture can thread it);
    // otherwise read the flag (URL/localStorage/env) — which works on the main thread (Stage 2).
    this.singleContext = options?.singleContext ?? getExportSingleContext();
    this.sharedGl = this.singleContext ? this.compositor.sharedGl : null;
    this.stageProbe = options?.stageProbe ?? null;
    this.matteCache = new SceneMaskMatteCache(this.width, this.height);
    // No `onReady` callback: the export AWAITS `rasterizer.ensure()` per frame, so there's no draw loop to
    // re-arm (unlike the editor's fire-and-forget `get()`).
    this.rasterizer = new SceneTextRasterizer();
    this.nestedGroups = options?.nestedGroups;

    const flat: FlatLayer[] = [];
    this.composition.tracks.forEach((track, trackIndex) => {
      track.layers.forEach((layer, layerIndex) => flat.push({ layer, trackIndex, layerIndex }));
    });
    this.adjustments = flat.filter((f) => f.layer.type === "adjustment");
    // Back-to-front: track 0 is the TOP track → draw highest trackIndex first, ties by layerIndex asc.
    // Identical to the editor's renderedLayerEntries, so z-order matches the preview exactly.
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

  private shouldProbe(t: number): boolean {
    const probe = this.stageProbe;
    if (!probe?.sampleTimes.length) return false;
    const windowSeconds = Math.max(1 / Math.max(1, probe.fps) / 2, 1e-4);
    return probe.sampleTimes.some((sample) => Math.abs(sample - t) <= windowSeconds);
  }

  private meanLumaFromRgba(data: Uint8ClampedArray | Uint8Array, pixels: number): number {
    if (pixels <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    return sum / pixels;
  }

  private sampleSourceLuma(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): number {
    const w = Math.max(1, Math.min(64, sourceWidth));
    const h = Math.max(1, Math.round((w * sourceHeight) / Math.max(1, sourceWidth)));
    const canvas = this.makeCanvas();
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("scene-frame-compositor diagnostics: 2D sample context unavailable");
    ctx.drawImage(source, 0, 0, w, h);
    return this.meanLumaFromRgba(ctx.getImageData(0, 0, w, h).data, w * h);
  }

  private framebufferStatusName(status: number): string {
    const gl = this.sharedGl;
    if (!gl) return "no-shared-gl";
    if (status === gl.FRAMEBUFFER_COMPLETE) return "FRAMEBUFFER_COMPLETE";
    if (status === gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT) return "FRAMEBUFFER_INCOMPLETE_ATTACHMENT";
    if (status === gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT) return "FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT";
    if (status === gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS) return "FRAMEBUFFER_INCOMPLETE_DIMENSIONS";
    if (status === gl.FRAMEBUFFER_UNSUPPORTED) return "FRAMEBUFFER_UNSUPPORTED";
    if (status === gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE) return "FRAMEBUFFER_INCOMPLETE_MULTISAMPLE";
    return `0x${status.toString(16)}`;
  }

  private debugRenderTarget(target: RenderTarget): { width: number; height: number; framebufferStatus: string; framebufferComplete: boolean } {
    const gl = this.sharedGl;
    if (!gl) return { width: target.width, height: target.height, framebufferStatus: "no-shared-gl", framebufferComplete: false };
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return {
      width: target.width,
      height: target.height,
      framebufferStatus: this.framebufferStatusName(status),
      framebufferComplete: status === gl.FRAMEBUFFER_COMPLETE,
    };
  }

  private sourceKind(source: SceneLayerDraw["source"]): string {
    if (isSceneTextureSource(source)) return "RenderTarget";
    if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas) return "OffscreenCanvas";
    if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) return "HTMLCanvas";
    if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) return "ImageBitmap";
    if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) return "HTMLVideo";
    if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) return "HTMLImage";
    return "TexImageSource";
  }

  private describeLayerDraw(draw: SceneLayerDraw, order: string): string {
    const rt = isSceneTextureSource(draw.source) ? draw.source.debugTarget : null;
    const hasEffects = Boolean((draw.blurPx ?? 0) > 0 || draw.glow || draw.content || (draw.rotateX ?? 0) !== 0 || (draw.rotateY ?? 0) !== 0);
    return [
      `${order}`,
      `layer=${draw.debugLayerId ?? "unknown"}`,
      `source=${this.sourceKind(draw.source)}`,
      `draw=${draw.sourceWidth}x${draw.sourceHeight}`,
      `opacity=${draw.transform.opacity}`,
      `blend=${draw.blendMode}`,
      `fit=${draw.fit}`,
      `mask=${draw.mask ? "1" : "0"}`,
      `effects=${hasEffects ? "1" : "0"}`,
      `blur=${draw.blurPx ?? 0}`,
      `glow=${draw.glow ? "1" : "0"}`,
      `tex=${isSceneTextureSource(draw.source) && draw.source.texture ? "1" : isSceneTextureSource(draw.source) ? "0" : "n/a"}`,
      `rt=${rt ? `${rt.width}x${rt.height}:${rt.framebufferStatus}` : "n/a"}`,
    ].join(" ");
  }

  private describeDraws(draws: SceneDraw[]): string {
    if (!draws.length) return "none";
    const parts: string[] = [];
    draws.forEach((draw, index) => {
      if ((draw as { kind?: string }).kind === "transition") {
        const transition = draw as Extract<SceneDraw, { kind: "transition" }>;
        const describeGroup = (group: SceneLayerDraw[], side: string): string =>
          group.map((layer, i) => this.describeLayerDraw(layer, `${side}[${i}]`)).join(" ");
        parts.push(
          `#${index}:transition from=${transition.debugFromId ?? transition.from[0]?.debugLayerId ?? "unknown"} to=${transition.debugToId ?? transition.to[0]?.debugLayerId ?? "unknown"} ` +
            `progress=${transition.progress.toFixed(3)} from{${describeGroup(transition.from, "from")}} to{${describeGroup(transition.to, "to")}}`
        );
      } else {
        parts.push(this.describeLayerDraw(draw as SceneLayerDraw, `#${index}`));
      }
    });
    return parts.join(" | ");
  }

  private describeGlSnapshot(snapshot: SceneCompositorDebugSnapshot): string {
    const targets = Object.entries(snapshot.targets)
      .map(([name, target]) => `${name}=${target.width}x${target.height}:${target.framebufferStatus}`)
      .join(",");
    return [
      `canvas=${snapshot.canvasWidth}x${snapshot.canvasHeight}`,
      `comp=${snapshot.width}x${snapshot.height}`,
      `viewport=${snapshot.viewport.join("x")}`,
      `scissor=${snapshot.scissorTest ? "on" : "off"}:${snapshot.scissorBox.join("x")}`,
      `presentViewport=${snapshot.lastPresentViewport?.join("x") ?? "none"}`,
      `fb=${snapshot.framebufferBinding}`,
      `tex2d=${snapshot.texture2dBinding}`,
      `glError=0x${snapshot.glError.toString(16)}`,
      `contextLost=${snapshot.contextLost ? "1" : "0"}`,
      `targets=${targets}`,
    ].join(" ");
  }

  /**
   * Adjustment-clip effects that sit above `target` and are active at `t`, merged into the layer — mirrors
   * the editor's applyActiveAdjustmentEffects. An adjustment affects layers on
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
   * `transitionIn` (the window the outgoing clip is composited under). 0 if none. Matches the editor preview.
   */
  private postrollSeconds(item: FlatLayer): number {
    const track = this.composition.tracks[item.trackIndex];
    if (!track) return 0;
    const end = item.layer.startSeconds + item.layer.durationSeconds;
    let best = 0;
    for (const other of track.layers) {
      if (other.id === item.layer.id || !other.transitionIn) continue;
      // Clamp to the incoming clip's length — matches the clamped transition window (getActiveTransition).
      if (Math.abs(other.startSeconds - end) < 0.05) best = Math.max(best, Math.min(other.transitionIn.durationSeconds, other.durationSeconds));
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
    if (this.singleContext) {
      // Single-context: the renderer+RTT pairs live on the shared context (no per-clip context to bound), but
      // we still pool them by liveness so concurrent grading (a transition = 2 active) gets distinct targets.
      for (const [id, entry] of this.mediaSharedRenderers) {
        if (activeMediaIds.has(id)) continue;
        this.mediaSharedRenderers.delete(id);
        this.mediaPipelineKeys.delete(id);
        if (this.freeMediaShared.length < MAX_POOLED_MEDIA_RENDERERS) this.freeMediaShared.push(entry);
        else { entry.renderer.dispose(); entry.target.dispose(); }
      }
      return;
    }
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

  /** Single-context: get/create the {shared MediaWebGLRenderer, RenderTarget} pair grading layer `id`. */
  private mediaSharedFor(id: string): { renderer: MediaWebGLRenderer; target: RenderTarget } {
    let entry = this.mediaSharedRenderers.get(id);
    if (!entry) {
      entry = this.freeMediaShared.pop() ?? {
        renderer: new MediaWebGLRenderer({ sharedGl: this.sharedGl! }),
        target: new RenderTarget(this.sharedGl!, 1, 1),
      };
      this.mediaSharedRenderers.set(id, entry);
    }
    return entry;
  }

  /**
   * Single-context overlay grade (injected into buildSceneDraws): grade a text/shape raster into a per-layer
   * RenderTarget on the shared context and return it as a SceneTextureSource. Same LUT engine + math as the
   * built-in own-canvas overlay grade — only the output surface differs (RTT vs canvas).
   */
  private gradeOverlaySingle = (layerId: string, srcCanvas: AnyCanvas, pipeline: ColorPipeline): SceneTextureSource | null => {
    const gl = this.sharedGl;
    if (!gl) return null;
    let entry = this.overlaySharedRenderers.get(layerId);
    if (!entry) {
      entry = { renderer: new MediaWebGLRenderer({ sharedGl: gl }), target: new RenderTarget(gl, 1, 1), pipelineKey: "" };
      this.overlaySharedRenderers.set(layerId, entry);
    }
    const key = JSON.stringify(pipeline);
    if (entry.pipelineKey !== key) {
      entry.renderer.setPipeline(pipeline);
      entry.pipelineKey = key;
    }
    entry.renderer.draw({
      source: srcCanvas as TexImageSource,
      sourceWidth: srcCanvas.width,
      sourceHeight: srcCanvas.height,
      matte: null,
      pipeline,
      amount: 1,
      opacity: 1,
      mediaEffects: null,
      target: entry.target,
    });
    return { texture: entry.target.tex, width: srcCanvas.width, height: srcCanvas.height, debugTarget: this.debugRenderTarget(entry.target) };
  };

  /** Single-context: dispose overlay grade renderers/targets whose text/shape layer isn't active this frame. */
  private pruneOverlayRenderers(activeOverlayIds: Set<string>): void {
    for (const [id, entry] of this.overlaySharedRenderers) {
      if (activeOverlayIds.has(id)) continue;
      this.overlaySharedRenderers.delete(id);
      entry.renderer.dispose();
      entry.target.dispose();
    }
  }

  /**
   * Decode, matte, and color-grade a media layer's frame at `t` into its `MediaWebGLRenderer`, returning the
   * graded canvas (color + matte + media-effects baked, **opacity NOT baked** — the composite quad applies
   * it live, matching the editor's `bakeOpacity={false}` scene-media path) or null if no frame yet. This is
   * the export's inline equivalent of the hidden `WebglMediaLayer` that fills the editor's `gradedRef`.
   */
  private async gradeMediaLayer(item: FlatLayer, t: number): Promise<AnyCanvas | SceneTextureSource | null> {
    const { layer } = item;
    if (!layer.assetId) return null;
    const providerKey = layer.type === "video" ? clipSourceKey(layer.id, layer.assetId) : layer.assetId;
    const source = this.getSource(providerKey);
    // Speed-aware (rate stretch + ramps): the shared mapper — exact integral for ramped clips.
    const sourceTime = layer.type === "video" ? layerSourceTimeSeconds(layer, t - layer.startSeconds) : 0;
    if (!source) {
      if (this.stageProbe && this.shouldProbe(t)) {
        this.stageProbe.onProbe({
          stage: "decode",
          timeSeconds: t,
          meanLuma: 0,
          layerId: layer.id,
          assetId: layer.assetId,
          detail: `missing-source providerKey=${providerKey} sourceTime=${sourceTime.toFixed(3)}`,
        });
      }
      return null;
    }
    const frame = await source.getFrame(sourceTime);
    if (!frame || source.width === 0 || source.height === 0) {
      if (this.stageProbe && this.shouldProbe(t)) {
        this.stageProbe.onProbe({
          stage: "decode",
          timeSeconds: t,
          meanLuma: 0,
          layerId: layer.id,
          assetId: layer.assetId,
          detail: `no-frame providerKey=${providerKey} sourceTime=${sourceTime.toFixed(3)} provider=${source.width}x${source.height}`,
        });
      }
      return null;
    }
    if (this.stageProbe && this.shouldProbe(t)) {
      this.stageProbe.onProbe({
        stage: "decode",
        timeSeconds: t,
        layerId: layer.id,
        assetId: layer.assetId,
        meanLuma: this.sampleSourceLuma(frame, source.width, source.height),
        detail: `providerKey=${providerKey} sourceTime=${sourceTime.toFixed(3)} provider=${source.width}x${source.height}`,
      });
    }

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

    const drawParams = {
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
    } as const;

    if (this.singleContext) {
      // Single-context: grade into a shared-context RenderTarget and hand back the texture directly (no canvas).
      const { renderer, target } = this.mediaSharedFor(layer.id);
      const pipelineKey = JSON.stringify(pipeline);
      if (this.mediaPipelineKeys.get(layer.id) !== pipelineKey) {
        renderer.setPipeline(pipeline);
        this.mediaPipelineKeys.set(layer.id, pipelineKey);
      }
      renderer.draw({ ...drawParams, target });
      if (this.stageProbe && this.shouldProbe(t)) {
        const w = Math.max(1, target.width);
        const h = Math.max(1, target.height);
        const pixels = new Uint8Array(w * h * 4);
        renderer.readPixelsInto(pixels, w, h, target);
        this.stageProbe.onProbe({
          stage: "rtt",
          timeSeconds: t,
          layerId: layer.id,
          assetId: layer.assetId,
          meanLuma: this.meanLumaFromRgba(pixels, w * h),
          detail: `providerKey=${providerKey} target=${w}x${h}:${this.debugRenderTarget(target).framebufferStatus}`,
        });
      }
      return { texture: target.tex, width: source.width, height: source.height, debugTarget: this.debugRenderTarget(target) };
    }

    const renderer = this.mediaRendererFor(layer.id);
    const pipelineKey = JSON.stringify(pipeline);
    if (this.mediaPipelineKeys.get(layer.id) !== pipelineKey) {
      renderer.setPipeline(pipeline);
      this.mediaPipelineKeys.set(layer.id, pipelineKey);
    }
    renderer.draw(drawParams);
    return renderer.canvas as AnyCanvas;
  }

  /** Render the composition at `timeSeconds` onto the WebGL output canvas (the export's per-frame entry point). */
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
    // Single-context: also release overlay (text/shape) grade renderers whose layer left the frame.
    if (this.singleContext) {
      this.pruneOverlayRenderers(
        new Set(activeItems.filter((it) => it.layer.type === "text" || it.layer.type === "shape").map((it) => it.layer.id))
      );
    }

    // Adjustment-merged layer list in back-to-front (z) order — exactly what the editor passes as `sceneLayers`.
    const layers = activeItems.map((item) => this.mergedLayer(item, t));

    // Blur-only region clones reuse their base's graded frame (SHARED with the editor preview via
    // buildRegionBlurCloneAliases) — grading the clone through its OWN decoder is what dropped the masked blur
    // from the proxy when that second decoder wasn't ready, and it burned an extra GL context. Alias here so
    // the export renders the clone identically to the viewer: base graded once, clone reads it.
    const cloneAlias = buildRegionBlurCloneAliases(layers);

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
        clipDurationSeconds: incoming.durationSeconds,
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
    const gradedById = new Map<string, AnyCanvas | SceneTextureSource>();
    const regionPasses = getRegionPassesEnabled();
    await Promise.all(
      activeItems
        // Skip aliased blur-only clones — they read the base's graded frame below, so grading them (a second
        // decoder + context) is both wasteful and the source of the proxy/preview divergence. With the pass
        // model on, NO clone is graded (blur/color passes work off the layer's running nest image, and
        // export-core doesn't even load their providers).
        .filter(
          (item) =>
            (item.layer.type === "video" || item.layer.type === "image") &&
            !cloneAlias.has(item.layer.id) &&
            !(regionPasses && item.layer.id.includes("__rfx_"))
        )
        .map(async (item) => {
          const graded = await this.gradeMediaLayer(item, t);
          if (graded && graded.width > 0 && graded.height > 0) gradedById.set(item.layer.id, graded);
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
      // Resolve a blur-only clone to its base's graded frame (the alias mirrors the editor's mediaSourceAlias).
      getMediaGraded: (id) => gradedById.get(cloneAlias.get(id) ?? id) ?? null,
      // Single-context: grade text/shape overlays into shared-context RTTs too (no cross-context canvas upload).
      ...(this.singleContext ? { gradeOverlay: this.gradeOverlaySingle } : {}),
      createCanvas: () => this.makeCanvas(),
      // Same flag as the preview (query/localStorage on the main thread, VITE env in the export Worker) so
      // "preview IS export" holds. Default OFF in every renderer until the region gates pass with it on.
      regionPassModel: getRegionPassesEnabled(),
      nestedGroups: this.nestedGroups,
      nestMatteCaches: this.nestMatteCaches,
    });

    if (this.stageProbe && this.shouldProbe(t)) {
      const graded = [...gradedById.entries()]
        .map(([id, source]) => `${id}:${this.sourceKind(source)}:${source.width}x${source.height}`)
        .join(",");
      this.stageProbe.onProbe({
        stage: "draws",
        timeSeconds: t,
        detail: [
          `active=[${layers.map((layer) => layer.id).join(",") || "none"}]`,
          `activeMedia=[${[...activeMediaIds].join(",") || "none"}]`,
          `graded=[${graded || "none"}]`,
          `drawCount=${draws.length}`,
          `draws=${this.describeDraws(draws)}`,
        ].join(" "),
      });
    }

    const spec: SceneFrameSpec = {
      width: this.width,
      height: this.height,
      backgroundColor: this.composition.backgroundColor || "#000000",
      layers: draws,
    };
    this.compositor.renderFrame(spec);
    // Force GPU completion before the caller snapshots this canvas into a VideoFrame. WebGL draws are async;
    // without this, the export encoder can capture an unfinished (black) buffer — the "first frame OK, rest
    // black" bug, which only vanished when the diagnostic luma readback happened to force the same sync.
    this.compositor.finish();
    if (this.stageProbe && this.shouldProbe(t)) {
      this.stageProbe.onProbe({
        stage: "gl",
        timeSeconds: t,
        detail: this.describeGlSnapshot(this.compositor.debugSnapshot()),
      });
    }

    // Budget telemetry (rule 8): track the live WebGL context peak and warn ONCE if we cross the safe
    // threshold — we're nearing the browser's cap and risk evicting the preview's context. The pool keeps us
    // under by design; if a render still fails (e.g. lost context), export-core propagates the error so the
    // Worker run retries on the main-thread scene path rather than shipping a degraded frame.
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
    // Single-context pools live ON the compositor's context — dispose them BEFORE the compositor loses it.
    for (const e of this.mediaSharedRenderers.values()) { safe(() => e.renderer.dispose()); safe(() => e.target.dispose()); }
    this.mediaSharedRenderers.clear();
    for (const e of this.freeMediaShared) { safe(() => e.renderer.dispose()); safe(() => e.target.dispose()); }
    this.freeMediaShared.length = 0;
    for (const e of this.overlaySharedRenderers.values()) { safe(() => e.renderer.dispose()); safe(() => e.target.dispose()); }
    this.overlaySharedRenderers.clear();
    safe(() => this.compositor.dispose());
    safe(() => this.matteCache.dispose());
    for (const cache of this.nestMatteCaches.values()) safe(() => cache.dispose());
    this.nestMatteCaches.clear();
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
