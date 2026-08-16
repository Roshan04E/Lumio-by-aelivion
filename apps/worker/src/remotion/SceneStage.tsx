import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  cancelRender,
  continueRender,
  delayRender,
  useCurrentFrame,
  useVideoConfig,
  type OnVideoFrame
} from "remotion";
import type { RenderManifest, RenderManifestLayer } from "@orreris/render-templates";
import type { FontRef, InstalledFontFace } from "@orreris/shared";
import {
  MediaWebGLRenderer,
  SceneCompositor,
  SceneMaskMatteCache,
  SceneTextRasterizer,
  buildSceneDraws,
  colorPipelineCacheKey,
  normalizeProjectColorSettings,
  type ColorEffectLight,
  effectiveTransitionDuration,
  effectsWithLayerRegionMask,
  findTransitionPairs,
  findTransitionPairsWithGroupJunctions,
  getActiveTransition,
  getCompositionColorPipeline,
  getCompositionFilterEffects,
  getCompositionMediaEffects,
  getCompositionObjectFit,
  getCompositionVolume,
  getTrackAudioGainAt,
  graphicAnimationBakeTime,
  collectFlarexVirtualLayers,
  isFlarexGeneratorVirtualLayer,
  graphicAnimationFrameAt,
  graphicToAnimatedDataUrl,
  resolveGraphicAnimation,
  resolveTransitionWindowSides,
  getLayerHoldFps,
  layerHeldLocalSeconds,
  layerSourceTimeSeconds,
  registerEffectManifests,
  registerLookManifests,
  registerTransitionManifests,
  type ColorPipeline,
  type FlarexComp,
  type Mask,
  type NestedGroupSpec,
  type SceneFrameSpec,
  type ScenePreviewTransition,
  type TimelineLayer,
  type TransitionSpec,
  type TransitionWindowSides
} from "@orreris/shared";

/**
 * Method-3 Phase 6.4 — Remotion SceneStage (default cloud compositor; see `getRemotionCompositor`).
 *
 * SceneStage composites the WHOLE frame into ONE WebGL2 canvas through the SAME shared `SceneCompositor` +
 * `buildSceneDraws` logic used by the editor preview and local export, so "preview IS export" holds for
 * Remotion too.
 *
 * Supported: media (image + video) with object-fit + transform (incl. 3D tilt) + opacity + blend + color grade
 * + media effects + blur/glow + clip (vector) masks + junction transitions, text/shape rasterization,
 * person-extraction mattes, and source-within-frame content transforms, all from the shared builder.
 *
 * Audio/sequencing/mux are unchanged: audio layers still render as `<Audio>` inside `<Sequence>` exactly like
 * the legacy path, so the muxed output keeps its sound.
 */

/** Read the Remotion compositor flag. SceneStage is the default; `legacy` is retained only as a retired hint. */
export function getRemotionCompositor(): "legacy" | "scene" {
  const value = typeof process !== "undefined" ? process.env?.REMOTION_COMPOSITOR : undefined;
  return value === "legacy" ? "legacy" : "scene";
}

/** A `<canvas>`/`OffscreenCanvas` graded source plus its natural pixel size, as `buildSceneDraws` expects. */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

interface RawFrame {
  source: CanvasImageSource;
  width: number;
  height: number;
}

function frameSourceWidth(frame: CanvasImageSource): number {
  if (frame instanceof HTMLImageElement) return frame.naturalWidth;
  if (frame instanceof HTMLVideoElement) return frame.videoWidth;
  return (frame as { width?: number }).width ?? 0;
}
function frameSourceHeight(frame: CanvasImageSource): number {
  if (frame instanceof HTMLImageElement) return frame.naturalHeight;
  if (frame instanceof HTMLVideoElement) return frame.videoHeight;
  return (frame as { height?: number }).height ?? 0;
}

// Decoded images are cached so an animated grade redraws without re-decoding (mirrors WebglMediaLayerRemotion).
const imageCache = new Map<string, HTMLImageElement>();
function loadImageOnce(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached?.complete && cached.naturalWidth > 0) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * R3.1: the handle-aware window sides for a junction pair, from the manifest's own data (layer
 * `sourceInSeconds`/`speed` + asset durations). Same shared math as the web preview
 * (`resolveTransitionWindowSides`), so the worker's window placement — and therefore its Sequence
 * mounts and `trimBefore` — stays pixel-aligned with the preview. Crucially the pre-roll never
 * exceeds the incoming's head handle, so `trimBefore = sourceIn - preroll*speed` can never clamp
 * at 0 and silently misalign the clip after the cut.
 */
function manifestTransitionSides(
  incoming: RenderManifestLayer,
  outgoing: RenderManifestLayer,
  getAssetDurationSeconds: (assetId: string | undefined) => number | undefined
): TransitionWindowSides {
  return resolveTransitionWindowSides({
    durationSeconds: effectiveTransitionDuration(incoming.transitionIn?.durationSeconds ?? 0, incoming.durationSeconds),
    incoming: { type: incoming.type, sourceInSeconds: incoming.sourceInSeconds, speed: incoming.speed },
    outgoing: { type: outgoing.type, sourceInSeconds: outgoing.sourceInSeconds, speed: outgoing.speed, durationSeconds: outgoing.durationSeconds },
    outgoingAssetDurationSeconds: getAssetDurationSeconds(outgoing.assetId),
    alignment: incoming.transitionIn?.alignment,
  });
}

/**
 * A clip's post-roll: how long it keeps rendering past its out-point to sit under the next clip's
 * transition. R3 (centered-on-cut) / R3.1 (handle-aware): the slice of the window past the cut —
 * up to the whole window when the incoming clip has no head handle ("start at cut").
 */
function outgoingPostrollSeconds(
  layer: RenderManifestLayer,
  layers: RenderManifestLayer[],
  getAssetDurationSeconds: (assetId: string | undefined) => number | undefined
): number {
  const end = layer.startSeconds + layer.durationSeconds;
  let best = 0;
  for (const other of layers) {
    if (other.id === layer.id || other.trackId !== layer.trackId || !other.transitionIn) continue;
    if (Math.abs(other.startSeconds - end) < 0.05) {
      best = Math.max(best, manifestTransitionSides(other, layer, getAssetDurationSeconds).postrollSeconds);
    }
  }
  return best;
}

/**
 * R3: the symmetric counterpart of `outgoingPostrollSeconds` — how long BEFORE its own start `layer`
 * must start rendering/decoding because it's the incoming side of a junction transition whose window
 * (R3.1: handle-aware, never more than the clip's own head handle) began before the cut.
 */
function incomingPrerollSeconds(
  layer: RenderManifestLayer,
  layers: RenderManifestLayer[],
  getAssetDurationSeconds: (assetId: string | undefined) => number | undefined
): number {
  if (!layer.transitionIn) return 0;
  const start = layer.startSeconds;
  for (const other of layers) {
    if (other.id === layer.id || other.trackId !== layer.trackId) continue;
    const end = other.startSeconds + other.durationSeconds;
    if (Math.abs(end - start) < 0.05) {
      return manifestTransitionSides(layer, other, getAssetDurationSeconds).prerollSeconds;
    }
  }
  return 0;
}

/** Merge active adjustment-clip effects into a layer (same rule as the legacy path: higher zIndex affects lower). */
function mergedLayer(
  layer: RenderManifestLayer,
  adjustments: RenderManifestLayer[],
  t: number
): RenderManifestLayer {
  const extra = adjustments
    .filter((a) => a.zIndex > layer.zIndex && t >= a.startSeconds && t < a.startSeconds + a.durationSeconds)
    .flatMap((a) => effectsWithLayerRegionMask(a as unknown as { masks?: Mask[]; effects: TimelineLayer["effects"] }));
  if (!extra.length) return layer;
  return { ...layer, effects: [...layer.effects, ...extra] };
}

/** A media layer is video/image; text/shape are not graded here (Phase 6.2 gap). */
function isMedia(layer: RenderManifestLayer): boolean {
  return layer.type === "video" || layer.type === "image";
}

/**
 * Owns the single WebGL2 `SceneCompositor`, the clip-mask matte cache, and a small pool of per-layer
 * media-grade renderers. `composite()` grades every active media layer's already-decoded frame and runs the
 * shared `buildSceneDraws` + `SceneCompositor.renderFrame` — returning false (incomplete) when a media layer's
 * decoded frame hasn't arrived yet, so the caller keeps the Remotion frame blocked until it has.
 */
class SceneController {
  private readonly compositor: SceneCompositor;
  private readonly matteCache: SceneMaskMatteCache;
  private readonly rasterizer: SceneTextRasterizer;
  private readonly mediaRenderers = new Map<string, MediaWebGLRenderer>();
  private readonly mediaPipelineKeys = new Map<string, string>();
  private readonly gradeRenderers = new Map<string, { renderer: MediaWebGLRenderer; pipelineKey: string }>();
  // Per-nested-composition matte caches (NESTING.md Phase C) — mirrors `this.matteCache` but sized per
  // nest. See `nestMatteCaches` doc on `BuildSceneDrawsInputs`.
  private readonly nestMatteCaches = new Map<string, SceneMaskMatteCache>();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly width: number,
    private readonly height: number,
    private readonly backgroundColor: string,
    private readonly regionPassModel: boolean,
    // Which light the effect stage mixes in (`manifest.output.color.effectLight`, normalized at manifest
    // build time). Threaded exactly like `regionPassModel` above and for the same reason: it is recorded
    // in the manifest so the cloud render mixes light the same way the preview that produced the manifest
    // did. Never default it here — an absent setting already means "display" one layer up.
    private readonly effectLight: ColorEffectLight,
    // Compound-clip group specs (from `manifest.nestedGroups`, rebuilt into a Map by the caller). `layers`
    // passed into `composite()` already carries nested children flattened in as ordinary entries; this is
    // consulted only to fold them back into a group + build the compound clip's shell.
    private readonly nestedGroups?: ReadonlyMap<string, NestedGroupSpec>,
    // Flarex node comps (FLAREX.md), carried verbatim on the manifest — `buildSceneDraws` lowers a
    // `flarexCompId` clip's draw through the shared compiler, same as preview/local export.
    private readonly flarexComps?: Record<string, FlarexComp>,
    // ADR-023 S5b: asset id -> render address, for a text/shape glyph fill. `manifest.assets` already
    // carries every referenced asset's `fileUrl` (`buildRenderManifest` now collects the fill's id
    // alongside each layer's own), so this is a lookup, not a fetch.
    private readonly resolveAssetUrl?: (assetId: string) => string | undefined,
    // ADR-023 D8 (S8): the `@font-face` rule to embed in a path-text SVG for a pinned face. The
    // worker's installed faces already carry their bytes as `data:` URLs (that is what
    // `resolveManifestFonts` produced before the browser was even started), so this is a lookup, not
    // a fetch — and an SVG drawn as an image cannot reach the page's own faces, only its own.
    private readonly resolveFontFaceCss?: (ref: FontRef) => string | undefined
  ) {
    this.compositor = new SceneCompositor(canvas, width, height);
    this.matteCache = new SceneMaskMatteCache(width, height);
    this.rasterizer = new SceneTextRasterizer(undefined, {
      resolveAssetUrl: this.resolveAssetUrl,
      resolveFontFaceCss: this.resolveFontFaceCss
    });
  }

  private mediaRendererFor(id: string): MediaWebGLRenderer {
    let renderer = this.mediaRenderers.get(id);
    if (!renderer) {
      renderer = new MediaWebGLRenderer(document.createElement("canvas"));
      this.mediaRenderers.set(id, renderer);
    }
    return renderer;
  }

  /** Color/matte/media-effects grade a raw decoded frame into its renderer canvas (opacity NOT baked — the
   *  composite quad applies it live, matching the editor's `bakeOpacity={false}` scene-media path). */
  private gradeMedia(layer: RenderManifestLayer, raw: RawFrame, matte: RawFrame | null, t: number): AnyCanvas {
    const renderer = this.mediaRendererFor(layer.id);
    const pipeline = getCompositionColorPipeline(layer as unknown as TimelineLayer, { currentTimeSeconds: t });
    const mediaEffects = getCompositionMediaEffects(layer as unknown as TimelineLayer, { currentTimeSeconds: t });
    const pipelineKey = colorPipelineCacheKey(pipeline);
    if (this.mediaPipelineKeys.get(layer.id) !== pipelineKey) {
      renderer.setPipeline(pipeline);
      this.mediaPipelineKeys.set(layer.id, pipelineKey);
    }
    renderer.draw({
      source: raw.source as TexImageSource,
      sourceWidth: raw.width,
      sourceHeight: raw.height,
      matte: matte ? (matte.source as TexImageSource) : null,
      matteInvert: layer.matte?.invert ?? false,
      matteOpacity: layer.matte?.opacity ?? 1,
      pipeline,
      amount: 1,
      opacity: 1,
      mediaEffects,
      transition: null
    });
    return renderer.canvas as AnyCanvas;
  }

  /** Free media-grade renderers whose layer is no longer active this frame (bounds live WebGL contexts). */
  private pruneRenderers(activeMediaIds: Set<string>): void {
    for (const [id, renderer] of this.mediaRenderers) {
      if (activeMediaIds.has(id)) continue;
      this.mediaRenderers.delete(id);
      this.mediaPipelineKeys.delete(id);
      try {
        renderer.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Composite the frame. `activeLayers` are the adjustment-merged visual layers (back-to-front), `rawById` the
   * decoded frame for each active media layer. Returns true when the frame was rendered, false when a media
   * frame is still missing (caller retries once it arrives).
   */
  async composite(
    activeLayers: RenderManifestLayer[],
    rawById: Map<string, RawFrame>,
    matteById: Map<string, RawFrame>,
    transitions: ScenePreviewTransition[],
    t: number,
    /** Flarex asset-source loaders live at this time (off-timeline — see `flarexVirtualLayers`). */
    activeFlarexLoaders: RenderManifestLayer[] = []
  ): Promise<boolean> {
    const activeMediaIds = new Set(activeLayers.filter(isMedia).map((l) => l.id));
    // Loaders keep their grade renderer too, or it is disposed and rebuilt every single frame.
    for (const loader of activeFlarexLoaders) activeMediaIds.add(loader.id);
    this.pruneRenderers(activeMediaIds);

    // Every active media layer must have its decoded frame before we can build a complete composite.
    for (const layer of activeLayers) {
      if (isMedia(layer) && !rawById.has(layer.id)) return false;
      if (isMedia(layer) && layer.matte?.uri && !matteById.has(layer.id)) return false;
    }

    const gradedById = new Map<string, AnyCanvas>();
    for (const layer of activeLayers) {
      if (!isMedia(layer)) continue;
      const raw = rawById.get(layer.id);
      if (!raw || raw.width === 0 || raw.height === 0) return false;
      const matte = layer.matte?.uri ? matteById.get(layer.id) ?? null : null;
      gradedById.set(layer.id, this.gradeMedia(layer, raw, matte, t));
    }

    // Grade the Flarex loaders exactly like a real clip, keyed by the VIRTUAL layer id — which is what
    // `resolveSourceDraw` looks up inside the compiler. Same "wait for the frame" contract as above: a
    // missing loader frame must retry rather than composite a hole (or fall back to the host).
    for (const loader of activeFlarexLoaders) {
      // GENERATOR loaders (Text+ / Background) are rasterized below, not decoded — they have no media
      // and will never produce a raw frame, so waiting on one here blocks the frame forever.
      if (isFlarexGeneratorVirtualLayer(loader as unknown as TimelineLayer)) continue;
      const raw = rawById.get(loader.id);
      if (!raw || raw.width === 0 || raw.height === 0) return false;
      gradedById.set(loader.id, this.gradeMedia(loader, raw, null, t));
    }

    await Promise.all(
      // Generator loaders rasterize through the SAME shared rasterizer as timeline text/shape clips —
      // that identity is what makes a node's text render the same here as in the editor.
      [...activeLayers, ...activeFlarexLoaders]
        .filter((layer) => layer.type === "text" || layer.type === "shape")
        .map(async (layer) => {
          const fx = getCompositionFilterEffects(layer as unknown as TimelineLayer, { currentTimeSeconds: t });
          const boxMode = !(fx.blurPx > 0 || fx.glow);
          await this.rasterizer.ensure(layer as unknown as TimelineLayer, t, this.width, this.height, boxMode);
        })
    );

    const draws = buildSceneDraws({
      layers: activeLayers as unknown as TimelineLayer[],
      width: this.width,
      height: this.height,
      currentTime: t,
      renderScale: 1,
      transitions,
      // Phase 6.3a: text/shape rasterize through the shared export rasterizer before the draw list is built.
      rasterizer: this.rasterizer,
      matteCache: this.matteCache,
      gradeRenderers: this.gradeRenderers,
      getMediaGraded: (id) => gradedById.get(id) ?? null,
      createCanvas: () => document.createElement("canvas"),
      // Region-effect pass model: recorded in the manifest at build time from the ONE shared
      // REGION_PASS_MODEL_DEFAULT, so the cloud render composites regions exactly like the
      // preview/local export that produced the manifest. Never hardcode a different value here.
      regionPassModel: this.regionPassModel,
      nestedGroups: this.nestedGroups,
      nestMatteCaches: this.nestMatteCaches,
      flarexComps: this.flarexComps,
      ...(activeFlarexLoaders.length > 0
        ? { flarexVirtualLayers: activeFlarexLoaders as unknown as TimelineLayer[] }
        : {})
    });

    const spec: SceneFrameSpec = {
      width: this.width,
      height: this.height,
      backgroundColor: this.backgroundColor || "#000000",
      layers: draws,
      effectLight: this.effectLight
    };
    this.compositor.renderFrame(spec);
    return true;
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
    for (const cache of this.nestMatteCaches.values()) safe(() => cache.dispose());
    this.nestMatteCaches.clear();
    safe(() => this.rasterizer.dispose());
    for (const renderer of this.mediaRenderers.values()) safe(() => renderer.dispose());
    this.mediaRenderers.clear();
    this.mediaPipelineKeys.clear();
    for (const { renderer } of this.gradeRenderers.values()) safe(() => renderer.dispose());
    this.gradeRenderers.clear();
  }
}

/** Hidden video decoder: hands each decoded frame to `onFrame` (mirrors the legacy OffthreadVideo grabbers). */
function VideoGrabber({
  layer,
  onFrame,
  leadSeconds = Math.max(0, -layer.startSeconds)
}: {
  layer: RenderManifestLayer;
  onFrame: (id: string, raw: RawFrame) => void;
  /**
   * CLIP-LOCAL seconds at this Sequence's frame 0 (0 = the clip's own nominal start). Positive when the
   * mount was clamped at the global frame-0 floor (this clip starts before the composition begins);
   * NEGATIVE during a centered-on-cut transition's pre-roll (R3) — reading source time from BEFORE the
   * clip's normal in-point. Defaults to the pre-R3 formula (no transition pre-roll) for any caller that
   * doesn't pass it.
   */
  leadSeconds?: number;
}) {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  // Rate stretch: playbackRate scales Remotion's media-time mapping (mediaTime =
  // (trimBefore + frame*playbackRate)/fps), so trimBefore stays the raw source in-point.
  // The hidden lead is in TIMELINE seconds, so it consumes lead*speed of source.
  const speed = layerSpeed(layer);
  const hiddenLeadSeconds = leadSeconds;
  // R3 step 4/edge-hold: a negative lead (pre-roll) can push source time below the clip's own
  // sourceInSeconds — clamp at that in-point (holds frame 0 of the clip's material, never negative
  // trimBefore) instead of reading before the asset's start.
  const trimBeforeFrames = Math.max(0, Math.round(((layer.sourceInSeconds ?? 0) + hiddenLeadSeconds * speed) * fps)) || undefined;
  const onVideoFrame: OnVideoFrame = useCallback(
    (frame) => {
      const w = frameSourceWidth(frame);
      const h = frameSourceHeight(frame);
      if (w && h) onFrame(layer.id, { source: frame, width: w, height: h });
    },
    [layer.id, onFrame]
  );
  if (!layer.assetUrl) return null;
  // Speed RAMP: OffthreadVideo's playbackRate is constant-only, so time-remap per frame with the
  // documented Remotion pattern — re-anchor a Sequence at the CURRENT frame and point trimBefore
  // at the exact source frame from the shared closed-form ramp integral (identical to preview +
  // local export). Render-only path; each output frame is its own render pass, so the per-frame
  // Sequence is free.
  if (layer.speedKeyframes?.length || getLayerHoldFps(layer) !== null) {
    // Frame hold ("on twos") rides the SAME per-frame remap as ramps: quantize LOCAL time to the
    // hold grid (shared floor math — identical frames to preview/local export), then map through
    // the ramp integral. Audio is untouched (the post-mix reads raw time).
    const localSeconds = layerHeldLocalSeconds(layer, hiddenLeadSeconds + frame / fps);
    const sourceSeconds = layerSourceTimeSeconds(
      { speed: layer.speed, sourceInSeconds: layer.sourceInSeconds, speedKeyframes: layer.speedKeyframes },
      localSeconds
    );
    return (
      <Sequence from={frame}>
        <OffthreadVideo
          muted
          src={layer.assetUrl}
          trimBefore={Math.max(0, Math.round(sourceSeconds * fps))}
          playbackRate={1}
          style={{ display: "none" }}
          onVideoFrame={onVideoFrame}
        />
      </Sequence>
    );
  }
  return (
    <OffthreadVideo
      muted
      src={layer.assetUrl}
      trimBefore={trimBeforeFrames}
      playbackRate={speed}
      style={{ display: "none" }}
      onVideoFrame={onVideoFrame}
    />
  );
}

/** Manifest-side equivalent of shared getLayerSpeed (RenderManifestLayer carries `speed` verbatim). */
function layerSpeed(layer: Pick<RenderManifestLayer, "speed">): number {
  const raw = layer.speed;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(16, Math.max(0.05, raw));
}

// ── FAILED COMPOSITE HANDLING (DEBT-015) ──────────────────────────────────────────────────────────
// A composite that THREW must never be reported to Remotion as a completed frame. The previous
// `catch { complete = true }` did exactly that: it released the render handle, Remotion wrote whatever
// happened to be in the canvas (blank), and the export exited 0. A customer's video silently contained
// a blank frame and only a comparison gate could see it.
//
// `complete = true` was not an accident — it stopped a delayRender() timeout hanging the export. That
// requirement is preserved: this ladder always TERMINATES, either by compositing successfully or by
// cancelRender(), so the render fails deterministically instead of hanging OR passing.
//
// The shape deliberately mirrors ScenePreviewCanvas's context-loss recovery ladder (bounded attempts,
// backoff, reset after a healthy run) rather than inventing a second recovery vocabulary for the same
// problem — see MAX_SCENE_REBUILDS / RECOVERY_BACKOFF_MS / HEALTHY_FRAMES_TO_RESET there. The one
// deliberate difference: the preview degrades to the DOM path when its budget is exhausted, because a
// viewer showing something slightly wrong beats a viewer showing nothing. An export has no such
// fallback — a wrong file IS the product — so the terminal state here is failure, not degradation.
//
// The delayRender handle stays HELD across retries, which is what guarantees nothing is emitted while
// we are still trying. Total ladder time (150+300+600ms) sits far inside Remotion's delayRender
// timeout, so the retries cannot themselves become the hang this code was written to avoid.
const MAX_COMPOSITE_RETRIES = 3;
const COMPOSITE_RETRY_BACKOFF_MS = [150, 300, 600];
// A sustained run of clean frames clears the attempt budget, so one transient early in a long export
// does not leave the rest of the render one failure away from aborting.
const HEALTHY_FRAMES_TO_RESET_COMPOSITE = 120;

// DEBT-015 instance 4 — same ladder shape as the composite handler above, sized for a single decode
// instead of a per-frame loop: no "healthy run" reset exists here because each ImageGrabber mount (a
// fresh `src`) is already an independent budget, not a shared counter that needs periodic forgiveness.
const MAX_IMAGE_RETRIES = 3;
const IMAGE_RETRY_BACKOFF_MS = [150, 300, 600];

/** Hidden image decoder: blocks the frame (delayRender) until the image is decoded, then hands it to `onFrame`. */
function ImageGrabber({
  layer,
  onFrame,
  leadSeconds = Math.max(0, -layer.startSeconds)
}: {
  layer: RenderManifestLayer;
  onFrame: (id: string, raw: RawFrame) => void;
  /** See `VideoGrabber`'s doc — same CLIP-LOCAL lead, can be negative during R3 transition pre-roll. */
  leadSeconds?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // ANIMATED vector graphic: rebuild a deep-linked data URL for THIS frame's point in the SMIL cycle
  // (`begin="-Ts"` renders frame T regardless of the frozen document clock), so the animation plays
  // instead of showing the settled final frame. `useCurrentFrame` is Sequence-local (the clip's own
  // Sequence starts at its start), and hiddenLead covers a clip starting before 0 — together that's the
  // same CLIP-LOCAL time the preview and local export feed the shared frame math, so all three align.
  // src changes per frame ⇒ the effect re-decodes it, with delayRender already blocking until ready.
  // R3 edge-hold: clamped on the TOTAL local time (not just the lead) so a negative `leadSeconds`
  // (transition pre-roll) holds the animation at its own frame 0 until the clip's real start arrives,
  // instead of jumping straight to `frame/fps` seconds in.
  const localSeconds = Math.max(0, leadSeconds + frame / fps);
  const plan = resolveGraphicAnimation(layer.graphic, { animations: layer.animations });
  // Go through the SAME frame-index quantization the pre-baked renderers use (frameAt → bakeTime), not
  // the raw continuous time — otherwise Remotion would render between their frames and drift off parity.
  const src =
    layer.graphic && plan
      ? graphicToAnimatedDataUrl(layer.graphic, graphicAnimationBakeTime(plan, graphicAnimationFrameAt(plan, localSeconds)))
      : layer.assetUrl;
  useEffect(() => {
    if (!src) return undefined;
    // DEBT-015 instance 4: the old `.catch(() => continueRender(handle))` answered a genuine decode
    // failure with completion — Remotion wrote whatever was already in the canvas (nothing, for this
    // layer) and the export exited 0. Mirrors `failComposite`'s ladder: hold ONE delayRender handle
    // across every retry (never continueRender-then-re-delayRender, which is what would let a partial
    // frame slip out between attempts) and only settle it once, on success or on terminal failure.
    const handle = delayRender(`scene-stage image ${layer.id}`);
    let cancelled = false;
    let settled = false;
    let attempt = 0;
    let retryTimer: number | null = null;

    const attemptLoad = () => {
      void loadImageOnce(src)
        .then((img) => {
          if (cancelled) return;
          onFrame(layer.id, { source: img, width: img.naturalWidth, height: img.naturalHeight });
          settled = true;
          continueRender(handle);
        })
        .catch((error) => {
          if (cancelled) return;
          if (attempt >= MAX_IMAGE_RETRIES) {
            settled = true;
            // img.onerror rejects with an Event, not an Error — build the message ourselves rather than
            // interpolating it. Truncated: `src` can be a multi-megabyte animated-graphic data URL.
            const truncatedSrc = src.length > 120 ? `${src.slice(0, 120)}…(${src.length} chars)` : src;
            const cause = error instanceof Error ? error.message : "image failed to load";
            cancelRender(
              new Error(
                `SceneStage: image load failed for layer ${layer.id} after ${MAX_IMAGE_RETRIES + 1} attempts — ` +
                  `refusing to emit a frame missing this layer (DEBT-015). src="${truncatedSrc}" cause=${cause}`
              )
            );
            return;
          }
          const delay = IMAGE_RETRY_BACKOFF_MS[Math.min(attempt, IMAGE_RETRY_BACKOFF_MS.length - 1)] ?? 600;
          attempt += 1;
          console.warn(
            `SceneStage: image load failed for layer ${layer.id}; retry ${attempt}/${MAX_IMAGE_RETRIES} in ${delay}ms`
          );
          retryTimer = window.setTimeout(attemptLoad, delay);
        });
    };
    attemptLoad();

    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      // Only release the handle here if neither success nor terminal failure already did — mirrors
      // `failComposite`: a render already failing via cancelRender must not also continueRender.
      if (!settled) continueRender(handle);
    };
  }, [src, layer.id, onFrame]);
  return null;
}

/**
 * SceneStage — the Remotion single-canvas composite. Renders one output `<canvas>` the shared
 * `SceneCompositor` composites into, plus hidden media decoders that feed it and the unchanged audio sequences.
 */
export function SceneStage({ manifest, fonts }: { manifest: RenderManifest; fonts?: InstalledFontFace[] }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  useMemo(() => {
    if (manifest.plugins?.looks?.length) {
      registerLookManifests(manifest.plugins.looks, { override: true });
    }
    if (manifest.plugins?.transitions?.length) {
      registerTransitionManifests(manifest.plugins.transitions, { override: true });
    }
    if (manifest.plugins?.effects?.length) {
      registerEffectManifests(manifest.plugins.effects, { override: true });
    }
  }, [manifest.plugins?.looks, manifest.plugins?.transitions, manifest.plugins?.effects]);

  // Back-to-front (z ascending = drawn first/bottom). Matches the legacy DOM order + the editor's z-order.
  const sorted = useMemo(() => [...manifest.layers].sort((a, b) => a.zIndex - b.zIndex), [manifest.layers]);
  // R3.1: asset durations for the handle-aware transition window (how much tail material the outgoing
  // clip really has). Unknown asset → undefined → the sides resolver assumes material exists.
  const assetDurationById = useMemo(() => {
    const byId = new Map(manifest.assets.map((asset) => [asset.id, asset.durationSeconds]));
    return (assetId: string | undefined) => (assetId != null ? byId.get(assetId) : undefined);
  }, [manifest.assets]);
  /**
   * Flarex asset-source `MediaIn` loaders (FLAREX.md Phase 2). These load media-pool assets directly, so
   * they are on NO track and `manifest.layers` cannot contain them. Without them the compiler's
   * `resolveSourceDraw` finds nothing and EVERY asset-source MediaIn soft-degrades to the host clip —
   * the cloud render drew the host three times where the preview showed three different sources
   * (user report 2026-07-27). Built from the SAME shared helper the preview and local export use, so all
   * three renderers agree by construction; `manifest.assets` already carries the url/kind/duration, so
   * no manifest change is needed. `assetUrl` is attached here because the grabbers decode by url.
   */
  const flarexVirtualLayers = useMemo(() => {
    if (!manifest.flarexComps) return [] as RenderManifestLayer[];
    const assetById = new Map(manifest.assets.map((asset) => [asset.id, asset]));
    const built = collectFlarexVirtualLayers(sorted as unknown as TimelineLayer[], manifest.flarexComps, (assetId) => {
      const asset = assetById.get(assetId);
      if (!asset) return null; // unresolvable → the compiler's documented host soft-degrade still applies
      return {
        // The REAL kind: an image decoded through the video grabber yields nothing.
        type: asset.fileType.startsWith("image/") ? "image" : "video",
        durationSeconds: asset.durationSeconds
      };
    });
    return built.map((layer) => ({
      ...(layer as unknown as RenderManifestLayer),
      assetUrl: layer.assetId ? assetById.get(layer.assetId)?.fileUrl : undefined
    }));
  }, [sorted, manifest.flarexComps, manifest.assets]);

  /** ADR-023 S5b: asset id -> `fileUrl`, for a text/shape glyph fill's `reference`. */
  const assetUrlById = useMemo(() => {
    const byId = new Map(manifest.assets.map((asset) => [asset.id, asset.fileUrl]));
    return (assetId: string) => byId.get(assetId);
  }, [manifest.assets]);

  const adjustments = useMemo(() => sorted.filter((l) => l.type === "adjustment"), [sorted]);
  const audioLayers = useMemo(() => sorted.filter((l) => l.type === "audio" && l.assetUrl), [sorted]);
  // Media layers carry their own Sequence (with post-roll) so OffthreadVideo gets the correct source time and
  // an outgoing clip keeps decoding under the next clip's transition reveal.
  const mediaLayers = useMemo(() => sorted.filter(isMedia), [sorted]);

  // Rebuild the Map once per manifest (Maps aren't JSON-safe, so the manifest carries a plain Record).
  const nestedGroups = useMemo(
    () => (manifest.nestedGroups ? new Map(Object.entries(manifest.nestedGroups)) : undefined),
    [manifest.nestedGroups]
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  // Set once this render has been failed via cancelRender (DEBT-015). Read by BOTH the controller-init
  // effect and the per-frame composite effect, so neither starts work behind a render already failing.
  const renderAbortedRef = useRef(false);
  const rawRef = useRef<Map<string, RawFrame>>(new Map());
  const matteRef = useRef<Map<string, RawFrame>>(new Map());
  const [mediaTick, bumpMediaTick] = useState(0);
  const bump = useCallback(() => bumpMediaTick((v) => v + 1), []);
  const onFrame = useCallback(
    (id: string, raw: RawFrame) => {
      rawRef.current.set(id, raw);
      bump();
    },
    [bump]
  );
  const onMatteFrame = useCallback(
    (id: string, raw: RawFrame) => {
      matteRef.current.set(id, raw);
      bump();
    },
    [bump]
  );

  /**
   * ADR-023 D8 (S8) — the pinned face, as an embeddable `@font-face` rule.
   *
   * `undefined` for a face this render does not carry is a REFUSAL: the arc declines to draw rather
   * than rendering the run in whatever the isolated SVG document falls back to. It cannot normally
   * happen — the worker aborts by name before the browser starts if any pinned ref failed to resolve
   * (T-2) — and it is written as a refusal anyway, because "cannot normally happen" is what the
   * warp catalogue said before it shipped empty.
   */
  const fontFaceCssFor = useMemo(() => {
    const byKey = new Map((fonts ?? []).map((face) => [`${face.family}|${face.weight}|${face.style}`, face]));
    return (ref: FontRef): string | undefined => {
      if (ref.source === "system") return undefined;
      const face = byKey.get(`${ref.family}|${ref.weight}|${ref.style}`);
      if (!face) return undefined;
      return `@font-face{font-family:"${face.family}";font-weight:${face.weight};font-style:${face.style};src:url(${face.src})}`;
    };
  }, [fonts]);

  // Create / dispose the controller with the canvas (re-create only when comp dimensions change).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    try {
      controllerRef.current = new SceneController(
        canvas,
        width,
        height,
        "#000000",
        manifest.regionPassModel ?? false,
        normalizeProjectColorSettings(manifest.output.color).effectLight,
        nestedGroups,
        manifest.flarexComps,
        assetUrlById,
        fontFaceCssFor
      );
    } catch (error) {
      console.error("SceneStage: SceneCompositor init failed", error);
      controllerRef.current = null;
      // DEBT-015 instance 2 — FAIL the render here. Without a controller the composite effect returns at
      // `if (!controller) return;` BEFORE any delayRender() handle is acquired, so nothing blocks the
      // frame at all: Remotion writes every frame uncomposited and exits 0. That is instance 1's blank
      // export by a shorter route — it does not even need to release a handle to ship a blank file.
      //
      // Deliberately NOT the composite path's retry ladder. That is a decision, not an omission:
      //   • init runs ONCE per render, not per frame — it is not the per-frame transient the ladder was
      //     built for;
      //   • the plausible causes (no WebGL2, context creation refused, OOM at startup) are mostly
      //     conditions a one-second retry cannot change;
      //   • a render that fails at frame 0 costs a queued job that can simply be re-run, while a silent
      //     blank export is unrecoverable — the asymmetry favours failing loudly and early over
      //     machinery for a case nobody has observed.
      // Copying the ladder here would invent a second recovery vocabulary for a case with no evidence
      // behind it. If init failures are ever SHOWN to be transient, that is a new finding and a new
      // decision — not something to pre-empt with a branch nothing has asked for.
      if (!renderAbortedRef.current) {
        renderAbortedRef.current = true;
        const cause = error instanceof Error ? error.message : String(error);
        cancelRender(
          new Error(
            `SceneStage: SceneCompositor init failed — refusing to emit an uncomposited render (DEBT-015). Cause: ${cause}`
          )
        );
      }
    }
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, [width, height, manifest.regionPassModel, nestedGroups]);

  // Per-frame composite, gated by a delayRender held until every active media frame has arrived + composited.
  const pendingRef = useRef<{ frame: number; id: number } | null>(null);
  const continuedFrameRef = useRef<number>(-1);
  const compositePassRef = useRef(0);
  // Bounded composite-failure recovery (DEBT-015; see the constants above).
  const compositeAttemptsRef = useRef(0);
  const cleanCompositesRef = useRef(0);
  const compositeRetryTimerRef = useRef<number | null>(null);
  const [compositeRetryTick, setCompositeRetryTick] = useState(0);

  /**
   * A composite threw. Retry a bounded number of times, then FAIL the render.
   *
   * Never calls continueRender: the frame did not composite, so there is no valid picture to emit and
   * releasing the handle is precisely the bug this exists to prevent.
   */
  const failComposite = useCallback((frameNumber: number, error: unknown) => {
    if (renderAbortedRef.current) return;
    console.error("SceneStage: composite failed", error);
    const attempt = compositeAttemptsRef.current;
    if (attempt >= MAX_COMPOSITE_RETRIES) {
      renderAbortedRef.current = true;
      const cause = error instanceof Error ? error.message : String(error);
      cancelRender(
        new Error(
          `SceneStage: composite failed on frame ${frameNumber} after ${MAX_COMPOSITE_RETRIES} retries — ` +
            `refusing to emit an uncomposited frame (DEBT-015). Cause: ${cause}`
        )
      );
      return;
    }
    compositeAttemptsRef.current = attempt + 1;
    cleanCompositesRef.current = 0;
    const delay = COMPOSITE_RETRY_BACKOFF_MS[Math.min(attempt, COMPOSITE_RETRY_BACKOFF_MS.length - 1)] ?? 600;
    console.warn(
      `SceneStage: composite failed on frame ${frameNumber}; retry ${attempt + 1}/${MAX_COMPOSITE_RETRIES} in ${delay}ms`
    );
    // Idempotent while a retry is already scheduled — one ladder step per failure, not one per caller.
    if (compositeRetryTimerRef.current != null) return;
    compositeRetryTimerRef.current = window.setTimeout(() => {
      compositeRetryTimerRef.current = null;
      setCompositeRetryTick((tick) => tick + 1);
    }, delay);
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    // The render is already failing; do not start new work behind cancelRender.
    if (renderAbortedRef.current) return;
    const pass = ++compositePassRef.current;

    // Acquire (or keep) this frame's render-block handle.
    if (continuedFrameRef.current !== frame && (!pendingRef.current || pendingRef.current.frame !== frame)) {
      if (pendingRef.current) {
        try {
          continueRender(pendingRef.current.id);
        } catch {
          /* ignore */
        }
      }
      pendingRef.current = { frame, id: delayRender(`scene-stage frame ${frame}`) };
    }

    const active = sorted.filter((layer) => {
      if (layer.type !== "video" && layer.type !== "image" && layer.type !== "text" && layer.type !== "shape") {
        return false;
      }
      const postroll = outgoingPostrollSeconds(layer, sorted, assetDurationById);
      const preroll = incomingPrerollSeconds(layer, sorted, assetDurationById);
      return t >= layer.startSeconds - preroll && t < layer.startSeconds + layer.durationSeconds + postroll;
    });
    const merged = active.map((layer) => mergedLayer(layer, adjustments, t));

    // Active junction transitions only — the shared builder folds both sides (graded) into the GPU mix.
    // Block 4c: compound-clip junctions only exist on the manifest's RAW junction layers (nest
    // expansion removed the compound from its track) — union them in; raw is lookup-fallback only.
    const rawJunctionLayers = (manifest.rawJunctionLayers ?? []) as unknown as typeof merged;
    const byId = new Map([...rawJunctionLayers, ...merged].map((layer) => [layer.id, layer]));
    const transitions: ScenePreviewTransition[] = [];
    for (const pair of findTransitionPairsWithGroupJunctions(merged as unknown as TimelineLayer[], rawJunctionLayers as unknown as TimelineLayer[])) {
      const incoming = byId.get(pair.incomingId);
      const outgoing = byId.get(pair.outgoingId);
      if (!incoming || !outgoing) continue;
      // R3.1: handle-aware window placement — same sides math as the activation filter above and the
      // Sequence mounts below, so window/decoders/activation can never disagree.
      const sides = manifestTransitionSides(incoming, outgoing, assetDurationById);
      const activeTransition = getActiveTransition(pair.spec as TransitionSpec, {
        currentTimeSeconds: t,
        startSeconds: incoming.startSeconds,
        clipDurationSeconds: incoming.durationSeconds,
        prerollSeconds: sides.prerollSeconds
      });
      if (!activeTransition) continue;
      transitions.push({
        outgoingId: pair.outgoingId,
        incomingId: pair.incomingId,
        spec: pair.spec as TransitionSpec,
        startSeconds: incoming.startSeconds,
        prerollSeconds: sides.prerollSeconds,
        fromFit: getCompositionObjectFit(outgoing as unknown as TimelineLayer) as "cover" | "contain" | "fill",
        toFit: getCompositionObjectFit(incoming as unknown as TimelineLayer) as "cover" | "contain" | "fill"
      });
    }

    void (async () => {
      let complete = false;
      let failure: unknown = null;
      try {
        const activeFlarexLoaders = flarexVirtualLayers.filter(
          (loader) => t >= loader.startSeconds && t < loader.startSeconds + loader.durationSeconds
        );
        complete = await controller.composite(merged, rawRef.current, matteRef.current, transitions, t, activeFlarexLoaders);
      } catch (error) {
        // Recorded, NOT converted into completion. Handled below, after the staleness check, so a
        // superseded pass cannot fail a render that has already moved on.
        failure = error instanceof Error ? error : new Error(String(error));
      }
      if (pass !== compositePassRef.current) return;
      if (failure) {
        failComposite(frame, failure);
        return;
      }
      if (complete && pendingRef.current && pendingRef.current.frame === frame) {
        try {
          continueRender(pendingRef.current.id);
        } catch {
          /* ignore */
        }
        continuedFrameRef.current = frame;
        pendingRef.current = null;
        // Healthy-run reset of the retry budget (see HEALTHY_FRAMES_TO_RESET_COMPOSITE).
        if (compositeAttemptsRef.current > 0) {
          cleanCompositesRef.current += 1;
          if (cleanCompositesRef.current >= HEALTHY_FRAMES_TO_RESET_COMPOSITE) {
            compositeAttemptsRef.current = 0;
            cleanCompositesRef.current = 0;
          }
        }
      }
    })();
    // `mediaTick` re-runs this when a media frame arrives; `t`/`frame` cover the timeline advancing.
    // `compositeRetryTick` re-runs it for a bounded retry after a failed composite (DEBT-015).
  }, [frame, t, sorted, adjustments, mediaTick, assetDurationById, flarexVirtualLayers, compositeRetryTick, failComposite]);

  // Drop any pending retry on unmount so a teardown can't resurrect a composite for a gone canvas.
  useEffect(() => {
    return () => {
      if (compositeRetryTimerRef.current != null) {
        window.clearTimeout(compositeRetryTimerRef.current);
        compositeRetryTimerRef.current = null;
      }
    };
  }, []);

  // Continue any outstanding handle on unmount so a teardown mid-frame can't hang the render.
  //
  // DEBT-015 instance 3 — READ THIS BEFORE "FIXING" IT EITHER WAY. This release is unconditional: it
  // does not distinguish a healthy pending frame from one that FAILED and is mid-ladder, so on paper it
  // is the very thing DEBT-015 forbids — an error path releasing a handle for work that did not succeed.
  // The composite ladder widened that window from ~0 (a failed composite used to resolve in the same
  // tick) to ~1s. It was measured before being left alone, and it is NOT reachable on the export path:
  //   • `SceneStage` has exactly ONE call site — `Root.tsx` renders it unconditionally as the
  //     composition root, with no key and no conditional branch — and there is no StrictMode in
  //     `apps/worker/src`, so nothing above it can drop or re-key it;
  //   • Remotion ends a render by CLOSING THE PAGE, which never runs React cleanup;
  //   • measured 2026-08-09 over both a healthy render and one where every composite failed (ladder
  //     active throughout, ending in cancelRender): 4 mounts, ZERO unmounts.
  // So this cleanup never runs — which also means its ORIGINAL purpose, stopping a mid-frame teardown
  // from hanging the render, describes a scenario that does not occur either. It has been dormant since
  // long before the ladder existed.
  //
  // It is kept, not deleted: it is a pre-existing safety net whose absence would fail SILENTLY, and
  // reachability arguments age badly. The re-arming condition is precise — the moment `SceneStage`
  // acquires a SECOND, conditionally-mounted host (a preview surface, a harness that swaps
  // compositions), unmount becomes reachable, this becomes load-bearing, and the release must then
  // distinguish "pending and healthy" (release, as today) from "pending and failed / mid-ladder"
  // (cancelRender). Do that then; do not build it now.
  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        try {
          continueRender(pendingRef.current.id);
        } catch {
          /* ignore */
        }
        pendingRef.current = null;
      }
    };
  }, []);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000", overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
      {/* Hidden media decoders — one Sequence per clip (with post-roll) so OffthreadVideo gets the right source time. */}
      <div aria-hidden="true" style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}>
        {mediaLayers.map((layer) => {
          // R3: mount the Sequence `preroll` seconds early for the incoming side of a centered-on-cut
          // transition (clamped at global frame 0, same as the pre-existing negative-startSeconds clamp
          // below) — `leadSeconds` tells the grabbers how much CLIP-LOCAL time that mount point actually
          // represents (negative during pre-roll — reading source before the clip's normal in-point).
          const preroll = incomingPrerollSeconds(layer, sorted, assetDurationById);
          const desiredMountSeconds = layer.startSeconds - preroll;
          const mountSeconds = Math.max(0, desiredMountSeconds);
          const leadSeconds = mountSeconds - layer.startSeconds;
          const from = Math.round(mountSeconds * fps);
          const durationInFrames = Math.max(
            1,
            Math.round((layer.startSeconds + layer.durationSeconds + outgoingPostrollSeconds(layer, sorted, assetDurationById) - mountSeconds) * fps)
          );
          // The matte reuses the layer's shape but MUST decode `matte.uri` — drop the graphic fields or
          // ImageGrabber would render the animated graphic as this layer's matte instead. A windowed
          // matte (Remove Background "Used in timeline") is 0-based over its slice, so shift the matte
          // layer's source in-point back by `startSeconds`: the grabber's `sourceIn + local` math then
          // samples it at `sourceTime − startSeconds`, matching the preview + local-export renderers.
          const matteLayer = layer.matte?.uri
            ? {
                ...layer,
                assetUrl: layer.matte.uri,
                sourceInSeconds: Math.max(0, (layer.sourceInSeconds ?? 0) - (layer.matte.startSeconds ?? 0)),
                graphic: undefined
              }
            : null;
          return (
            <Sequence key={layer.id} from={from} durationInFrames={durationInFrames}>
              {layer.type === "video" ? (
                <VideoGrabber layer={layer} onFrame={onFrame} leadSeconds={leadSeconds} />
              ) : (
                <ImageGrabber layer={layer} onFrame={onFrame} leadSeconds={leadSeconds} />
              )}
              {matteLayer ? (
                layer.type === "video" ? (
                  <VideoGrabber layer={matteLayer} onFrame={onMatteFrame} leadSeconds={leadSeconds} />
                ) : (
                  <ImageGrabber layer={matteLayer} onFrame={onMatteFrame} leadSeconds={leadSeconds} />
                )
              ) : null}
            </Sequence>
          );
        })}
        {/* Flarex asset-source loaders. Off-timeline, so they are absent from `mediaLayers` above and
            got no decoder at all — the cloud render then drew the HOST clip for every MediaIn. They
            mirror the host clip's span (comp-local sync), clamped to their own source length by
            `collectFlarexVirtualLayers`, so a plain Sequence over that span is the right mount: no
            transitions/pre-roll apply to a loader (it feeds a node graph, it is never a timeline clip). */}
        {flarexVirtualLayers.map((loader) => {
          const from = Math.max(0, Math.round(loader.startSeconds * fps));
          const durationInFrames = Math.max(1, Math.round(loader.durationSeconds * fps));
          if (!loader.assetUrl) return null; // unresolved asset → compiler soft-degrades to the host
          return (
            <Sequence key={loader.id} from={from} durationInFrames={durationInFrames}>
              {loader.type === "video" ? (
                <VideoGrabber layer={loader} onFrame={onFrame} leadSeconds={0} />
              ) : (
                <ImageGrabber layer={loader} onFrame={onFrame} leadSeconds={0} />
              )}
            </Sequence>
          );
        })}
      </div>
      {/* Audio/sequencing/mux unchanged: audio layers still render as <Audio> inside their Sequence. */}
      {audioLayers.map((layer) => {
        const from = Math.max(0, Math.round(layer.startSeconds * fps));
        const durationInFrames = Math.max(1, Math.round(layer.durationSeconds * fps));
        return (
          <Sequence key={layer.id} from={from} durationInFrames={durationInFrames}>
            {/* trimBefore honors the clip's source in-point (was silently ignored before 2026-07-03);
                playbackRate = rate stretch, varispeed like the local mixer / preview. */}
            <Audio
              src={layer.assetUrl!}
              {...(Math.round((layer.sourceInSeconds ?? 0) * fps) > 0
                ? { trimBefore: Math.round((layer.sourceInSeconds ?? 0) * fps) }
                : {})}
              playbackRate={layerSpeed(layer)}
              volume={(f) => {
                const t = layer.startSeconds + f / fps;
                // Clip volume × track fader (incl. fader automation) through the SHARED evaluators.
                return Math.max(
                  0,
                  getCompositionVolume(layer as unknown as TimelineLayer, { currentTimeSeconds: t }) *
                    getTrackAudioGainAt({ volume: layer.trackGain, volumeKeyframes: layer.trackVolumeKeyframes }, t)
                );
              }}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
