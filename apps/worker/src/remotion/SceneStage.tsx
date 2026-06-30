import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  useCurrentFrame,
  useVideoConfig,
  type OnVideoFrame
} from "remotion";
import type { RenderManifest, RenderManifestLayer } from "@reelforge/render-templates";
import {
  MediaWebGLRenderer,
  SceneCompositor,
  SceneMaskMatteCache,
  buildSceneDraws,
  findTransitionPairs,
  getActiveTransition,
  getCompositionColorPipeline,
  getCompositionMediaEffects,
  getCompositionObjectFit,
  getCompositionVolume,
  type ColorPipeline,
  type SceneFrameSpec,
  type ScenePreviewTransition,
  type TimelineLayer,
  type TransitionSpec
} from "@reelforge/shared";

/**
 * Method-3 Phase 6.2 — Remotion SceneStage (FLAGGED OFF by default; see `getRemotionCompositor`).
 *
 * The legacy Remotion path (Root.tsx) lays every clip out as its OWN DOM/canvas sibling and lets Chrome
 * composite them — a different composite than the editor preview + local export, which both run the shared
 * `SceneCompositor` + `buildSceneDraws`. SceneStage closes that gap on the cloud/Remotion side: it composites
 * the WHOLE frame into ONE WebGL2 canvas through the SAME shared logic, so (once complete) "preview IS export"
 * holds for Remotion too.
 *
 * Phase 6.2 is deliberately MINIMAL: media (image + video) with object-fit + transform (incl. 3D tilt the
 * compositor already does) + opacity + blend + color grade + media effects + blur/glow + clip (vector) masks +
 * junction transitions, all from the shared builder. Text/shape layers, person-extraction mattes, and
 * source-within-frame content transforms are NOT wired here yet (see the gaps note at the bottom) — they fall
 * back to nothing in this path. The legacy Root.tsx path is untouched and remains the default.
 *
 * Audio/sequencing/mux are unchanged: audio layers still render as `<Audio>` inside `<Sequence>` exactly like
 * the legacy path, so the muxed output keeps its sound.
 */

/** Read the Remotion compositor flag. `scene` enables SceneStage; anything else keeps the legacy DOM composite. */
export function getRemotionCompositor(): "legacy" | "scene" {
  const value = typeof process !== "undefined" ? process.env?.REMOTION_COMPOSITOR : undefined;
  return value === "scene" ? "scene" : "legacy";
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

/** A clip's post-roll: how long it keeps rendering past its out-point to sit under the next clip's transition. */
function outgoingPostrollSeconds(layer: RenderManifestLayer, layers: RenderManifestLayer[]): number {
  const end = layer.startSeconds + layer.durationSeconds;
  let best = 0;
  for (const other of layers) {
    if (other.id === layer.id || other.trackId !== layer.trackId || !other.transitionIn) continue;
    if (Math.abs(other.startSeconds - end) < 0.05) best = Math.max(best, other.transitionIn.durationSeconds);
  }
  return best;
}

/** Merge active adjustment-clip effects into a layer (same rule as the legacy path: higher zIndex affects lower). */
function mergedLayer(
  layer: RenderManifestLayer,
  adjustments: RenderManifestLayer[],
  t: number
): RenderManifestLayer {
  const extra = adjustments
    .filter((a) => a.zIndex > layer.zIndex && t >= a.startSeconds && t < a.startSeconds + a.durationSeconds)
    .flatMap((a) => a.effects);
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
  private readonly mediaRenderers = new Map<string, MediaWebGLRenderer>();
  private readonly mediaPipelineKeys = new Map<string, string>();
  private readonly gradeRenderers = new Map<string, { renderer: MediaWebGLRenderer; pipelineKey: string }>();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly width: number,
    private readonly height: number,
    private readonly backgroundColor: string
  ) {
    this.compositor = new SceneCompositor(canvas, width, height);
    this.matteCache = new SceneMaskMatteCache(width, height);
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
  private gradeMedia(layer: RenderManifestLayer, raw: RawFrame, t: number): AnyCanvas {
    const renderer = this.mediaRendererFor(layer.id);
    const pipeline = getCompositionColorPipeline(layer as unknown as TimelineLayer, { currentTimeSeconds: t });
    const mediaEffects = getCompositionMediaEffects(layer as unknown as TimelineLayer, { currentTimeSeconds: t });
    const pipelineKey = JSON.stringify(pipeline);
    if (this.mediaPipelineKeys.get(layer.id) !== pipelineKey) {
      renderer.setPipeline(pipeline);
      this.mediaPipelineKeys.set(layer.id, pipelineKey);
    }
    renderer.draw({
      source: raw.source as TexImageSource,
      sourceWidth: raw.width,
      sourceHeight: raw.height,
      matte: null,
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
  composite(
    activeLayers: RenderManifestLayer[],
    rawById: Map<string, RawFrame>,
    transitions: ScenePreviewTransition[],
    t: number
  ): boolean {
    const activeMediaIds = new Set(activeLayers.filter(isMedia).map((l) => l.id));
    this.pruneRenderers(activeMediaIds);

    // Every active media layer must have its decoded frame before we can build a complete composite.
    for (const layer of activeLayers) {
      if (isMedia(layer) && !rawById.has(layer.id)) return false;
    }

    const gradedById = new Map<string, AnyCanvas>();
    for (const layer of activeLayers) {
      if (!isMedia(layer)) continue;
      const raw = rawById.get(layer.id);
      if (!raw || raw.width === 0 || raw.height === 0) return false;
      gradedById.set(layer.id, this.gradeMedia(layer, raw, t));
    }

    const draws = buildSceneDraws({
      layers: activeLayers as unknown as TimelineLayer[],
      width: this.width,
      height: this.height,
      currentTime: t,
      renderScale: 1,
      transitions,
      // Phase 6.2: text/shape are not rasterized here yet → the builder drops them (no raster).
      rasterizer: null,
      matteCache: this.matteCache,
      gradeRenderers: this.gradeRenderers,
      getMediaGraded: (id) => gradedById.get(id) ?? null,
      createCanvas: () => document.createElement("canvas")
    });

    const spec: SceneFrameSpec = {
      width: this.width,
      height: this.height,
      backgroundColor: this.backgroundColor || "#000000",
      layers: draws
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
  onFrame
}: {
  layer: RenderManifestLayer;
  onFrame: (id: string, raw: RawFrame) => void;
}) {
  const { fps } = useVideoConfig();
  const trimBeforeFrames = Math.max(0, Math.round((layer.sourceInSeconds ?? 0) * fps)) || undefined;
  const onVideoFrame: OnVideoFrame = useCallback(
    (frame) => {
      const w = frameSourceWidth(frame);
      const h = frameSourceHeight(frame);
      if (w && h) onFrame(layer.id, { source: frame, width: w, height: h });
    },
    [layer.id, onFrame]
  );
  if (!layer.assetUrl) return null;
  return (
    <OffthreadVideo muted src={layer.assetUrl} trimBefore={trimBeforeFrames} style={{ display: "none" }} onVideoFrame={onVideoFrame} />
  );
}

/** Hidden image decoder: blocks the frame (delayRender) until the image is decoded, then hands it to `onFrame`. */
function ImageGrabber({
  layer,
  onFrame
}: {
  layer: RenderManifestLayer;
  onFrame: (id: string, raw: RawFrame) => void;
}) {
  const src = layer.assetUrl;
  useEffect(() => {
    if (!src) return undefined;
    const handle = delayRender(`scene-stage image ${layer.id}`);
    let cancelled = false;
    void loadImageOnce(src)
      .then((img) => {
        if (!cancelled) onFrame(layer.id, { source: img, width: img.naturalWidth, height: img.naturalHeight });
        continueRender(handle);
      })
      .catch(() => continueRender(handle));
    return () => {
      cancelled = true;
      continueRender(handle);
    };
  }, [src, layer.id, onFrame]);
  return null;
}

/**
 * SceneStage — the flagged Remotion single-canvas composite. Renders one output `<canvas>` the shared
 * `SceneCompositor` composites into, plus hidden media decoders that feed it and the unchanged audio sequences.
 */
export function SceneStage({ manifest }: { manifest: RenderManifest }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  // Back-to-front (z ascending = drawn first/bottom). Matches the legacy DOM order + the editor's z-order.
  const sorted = useMemo(() => [...manifest.layers].sort((a, b) => a.zIndex - b.zIndex), [manifest.layers]);
  const adjustments = useMemo(() => sorted.filter((l) => l.type === "adjustment"), [sorted]);
  const audioLayers = useMemo(() => sorted.filter((l) => l.type === "audio" && l.assetUrl), [sorted]);
  // Media layers carry their own Sequence (with post-roll) so OffthreadVideo gets the correct source time and
  // an outgoing clip keeps decoding under the next clip's transition reveal.
  const mediaLayers = useMemo(() => sorted.filter(isMedia), [sorted]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const rawRef = useRef<Map<string, RawFrame>>(new Map());
  const [mediaTick, bumpMediaTick] = useState(0);
  const bump = useCallback(() => bumpMediaTick((v) => v + 1), []);
  const onFrame = useCallback(
    (id: string, raw: RawFrame) => {
      rawRef.current.set(id, raw);
      bump();
    },
    [bump]
  );

  // Create / dispose the controller with the canvas (re-create only when comp dimensions change).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    try {
      controllerRef.current = new SceneController(canvas, width, height, "#000000");
    } catch (error) {
      console.error("SceneStage: SceneCompositor init failed", error);
      controllerRef.current = null;
    }
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, [width, height]);

  // Per-frame composite, gated by a delayRender held until every active media frame has arrived + composited.
  const pendingRef = useRef<{ frame: number; id: number } | null>(null);
  const continuedFrameRef = useRef<number>(-1);
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;

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
      const postroll = outgoingPostrollSeconds(layer, sorted);
      return t >= layer.startSeconds && t < layer.startSeconds + layer.durationSeconds + postroll;
    });
    const merged = active.map((layer) => mergedLayer(layer, adjustments, t));

    // Active junction transitions only — the shared builder folds both sides (graded) into the GPU mix.
    const byId = new Map(merged.map((layer) => [layer.id, layer]));
    const transitions: ScenePreviewTransition[] = [];
    for (const pair of findTransitionPairs(merged as unknown as TimelineLayer[])) {
      const incoming = byId.get(pair.incomingId);
      const outgoing = byId.get(pair.outgoingId);
      if (!incoming || !outgoing) continue;
      const activeTransition = getActiveTransition(pair.spec as TransitionSpec, {
        currentTimeSeconds: t,
        startSeconds: incoming.startSeconds
      });
      if (!activeTransition) continue;
      transitions.push({
        outgoingId: pair.outgoingId,
        incomingId: pair.incomingId,
        spec: pair.spec as TransitionSpec,
        startSeconds: incoming.startSeconds,
        fromFit: getCompositionObjectFit(outgoing as unknown as TimelineLayer) as "cover" | "contain" | "fill",
        toFit: getCompositionObjectFit(incoming as unknown as TimelineLayer) as "cover" | "contain" | "fill"
      });
    }

    let complete = false;
    try {
      complete = controller.composite(merged, rawRef.current, transitions, t);
    } catch (error) {
      console.error("SceneStage: composite failed", error);
      complete = true; // don't deadlock the render — ship whatever landed
    }
    if (complete && pendingRef.current && pendingRef.current.frame === frame) {
      try {
        continueRender(pendingRef.current.id);
      } catch {
        /* ignore */
      }
      continuedFrameRef.current = frame;
      pendingRef.current = null;
    }
    // `mediaTick` re-runs this when a media frame arrives; `t`/`frame` cover the timeline advancing.
  }, [frame, t, sorted, adjustments, mediaTick]);

  // Continue any outstanding handle on unmount so a teardown mid-frame can't hang the render.
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
          const from = Math.max(0, Math.round(layer.startSeconds * fps));
          const durationInFrames = Math.max(
            1,
            Math.round((layer.durationSeconds + outgoingPostrollSeconds(layer, sorted)) * fps)
          );
          return (
            <Sequence key={layer.id} from={from} durationInFrames={durationInFrames}>
              {layer.type === "video" ? <VideoGrabber layer={layer} onFrame={onFrame} /> : <ImageGrabber layer={layer} onFrame={onFrame} />}
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
            <Audio
              src={layer.assetUrl!}
              volume={(f) => getCompositionVolume(layer as unknown as TimelineLayer, { currentTimeSeconds: layer.startSeconds + f / fps })}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
