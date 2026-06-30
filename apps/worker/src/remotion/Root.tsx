import React, { useEffect, useMemo, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  Img,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import type { RenderManifest, RenderManifestLayer } from "@reelforge/render-templates";
import { MaskedVideo } from "./MaskedVideo";
import { SceneStage, getRemotionCompositor } from "./SceneStage";
import { WebglMediaImageRemotion, WebglMediaVideoRemotion } from "./WebglMediaLayerRemotion";
import {
  MediaWebGLRenderer,
  TransitionCompositor,
  WebglColorApplicator,
  bakeMatteLut3d,
  bakePipelineToLut3d,
  buildColorFilterDefs,
  buildMaskDefsSvg,
  getCompositionMaskCss,
  buildWarpedTextPathSvg,
  compositionTransformCss,
  configureFontResolver,
  findTransitionPairs,
  getActiveTransition,
  getCompositionColorFilter,
  getCompositionColorPipeline,
  getCompositionMediaEffects,
  getMaskedEffectOverlays,
  getCompositionFontsUsed,
  getTransition,
  isWebgl2ColorSupported,
  getCompositionMediaStyle,
  getCompositionObjectFit,
  getCompositionShapeStyle,
  getCompositionTextRunStyle,
  getCompositionTextStyle,
  getCompositionTransform,
  getCompositionTransition,
  getCompositionVolume,
  getVisibleTextRuns,
  hasTextWarp,
  normalizeTextWarp,
  warpFontFile,
  type ColorPipeline,
  type TextWarp,
  type TransitionSpec
} from "@reelforge/shared";

// Text-warp outline engine: resolve warp font families to the binaries served from the
// Remotion public/ dir, so the exported warp matches the editor preview exactly.
configureFontResolver((family) => staticFile(warpFontFile(family)));

export const compositionId = "ReelForgeTimeline";

const fallbackManifest: RenderManifest = {
  id: "fallback",
  schemaVersion: 1,
  animationVersion: 1,
  projectId: "fallback",
  quality: "final",
  output: {
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 1,
    durationInFrames: 30,
    format: "mp4"
  },
  assets: [],
  layers: [],
  createdAt: new Date(0).toISOString(),
  renderer: {
    engine: "reelforge-manifest",
    version: 1,
    note: "Fallback manifest"
  }
};

export function RemotionRoot() {
  return (
    <Composition
      id={compositionId}
      component={TimelineComposition}
      durationInFrames={fallbackManifest.output.durationInFrames}
      fps={fallbackManifest.output.fps}
      width={fallbackManifest.output.width}
      height={fallbackManifest.output.height}
      defaultProps={{ manifest: fallbackManifest }}
      calculateMetadata={({ props }) => ({
        durationInFrames: props.manifest.output.durationInFrames,
        fps: props.manifest.output.fps,
        width: props.manifest.output.width,
        height: props.manifest.output.height
      })}
    />
  );
}

function TimelineComposition({ manifest }: { manifest: RenderManifest }) {
  // Method-3 Phase 6.2: when REMOTION_COMPOSITOR=scene, composite the whole frame through the shared
  // SceneCompositor (preview IS export). Default OFF — the legacy per-clip DOM composite below is unchanged.
  if (getRemotionCompositor() === "scene") {
    return <SceneStage manifest={manifest} />;
  }
  return <LegacyTimelineComposition manifest={manifest} />;
}

function LegacyTimelineComposition({ manifest }: { manifest: RenderManifest }) {
  const layers = useMemo(() => [...manifest.layers].sort((a, b) => a.zIndex - b.zIndex), [manifest.layers]);
  const adjustmentLayers = useMemo(() => layers.filter((layer) => layer.type === "adjustment"), [layers]);
  const renderLayers = useMemo(() => layers.filter((layer) => layer.type !== "adjustment"), [layers]);
  useLoadedCompositionFonts(layers);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000", overflow: "hidden" }}>
      {renderLayers.map((layer) => (
        <LayerSequence
          adjustmentLayers={adjustmentLayers}
          key={layer.id}
          layer={layer}
          postrollSeconds={outgoingPostrollSeconds(layer, layers)}
        />
      ))}
      {/* Unified GPU transition engine: each active junction renders its two-clip mix ON TOP of the
          normal clip sequences for the duration of the transition window. WebGL-path only (the mix is
          a real shader); legacy mode falls back to the per-clip single-texture reveal. */}
      {useWebglMediaPath() ? <TransitionSequences layers={renderLayers} /> : null}
    </AbsoluteFill>
  );
}

/** One windowed Sequence per active junction transition, mixing the two clips via the shared engine. */
function TransitionSequences({ layers }: { layers: RenderManifestLayer[] }) {
  const { fps } = useVideoConfig();
  const byId = useMemo(() => new Map(layers.map((l) => [l.id, l])), [layers]);
  const pairs = useMemo(() => findTransitionPairs(layers), [layers]);
  return (
    <>
      {pairs.map((pair) => {
        const incoming = byId.get(pair.incomingId);
        const outgoing = byId.get(pair.outgoingId);
        if (!incoming || !outgoing) return null;
        const from = Math.max(0, Math.round(incoming.startSeconds * fps));
        const durationInFrames = Math.max(1, Math.round(pair.spec.durationSeconds * fps));
        return (
          <Sequence key={`tr_${pair.outgoingId}_${pair.incomingId}`} from={from} durationInFrames={durationInFrames}>
            <TransitionLayerRemotion outgoing={outgoing} incoming={incoming} spec={pair.spec} />
          </Sequence>
        );
      })}
    </>
  );
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

/**
 * The two clips of a junction transition, graded through `MediaWebGLRenderer` into offscreen canvases
 * and mixed by the shared `TransitionCompositor` — the SAME engine path the editor preview + local export
 * use, so the result is pixel-identical. Fills the comp box (per-clip object-fit is suspended during the
 * transition, matching the preview overlay). Drawn on top of the normal clip Sequences.
 */
function TransitionLayerRemotion({
  outgoing,
  incoming,
  spec
}: {
  outgoing: RenderManifestLayer;
  incoming: RenderManifestLayer;
  spec: TransitionSpec;
}) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const currentTimeSeconds = incoming.startSeconds + frame / fps;
  const def = getTransition(spec.kind);

  const visibleRef = React.useRef<HTMLCanvasElement | null>(null);
  const compRef = React.useRef<TransitionCompositor | null>(null);
  const fromR = React.useRef<MediaWebGLRenderer | null>(null);
  const toR = React.useRef<MediaWebGLRenderer | null>(null);
  const fromCv = React.useRef<HTMLCanvasElement | null>(null);
  const toCv = React.useRef<HTMLCanvasElement | null>(null);
  const fromHas = React.useRef(false);
  const toHas = React.useRef(false);
  const fromImg = React.useRef<HTMLImageElement | null>(null);
  const toImg = React.useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    fromCv.current = document.createElement("canvas");
    toCv.current = document.createElement("canvas");
    try {
      fromR.current = new MediaWebGLRenderer(fromCv.current);
      toR.current = new MediaWebGLRenderer(toCv.current);
      if (visibleRef.current) {
        compRef.current = new TransitionCompositor(visibleRef.current);
        if (def) compRef.current.prepare(def);
      }
    } catch {
      /* leave blank on GL failure */
    }
    return () => {
      try { fromR.current?.dispose(); } catch { /* ignore */ }
      try { toR.current?.dispose(); } catch { /* ignore */ }
      try { compRef.current?.dispose(); } catch { /* ignore */ }
      fromR.current = toR.current = null;
      compRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def?.id]);

  function mix() {
    const comp = compRef.current;
    if (!comp || !def || !fromHas.current || !toHas.current || !fromCv.current || !toCv.current) return;
    const active = getActiveTransition(spec, { currentTimeSeconds, startSeconds: incoming.startSeconds });
    if (!active) return;
    try {
      comp.draw(def, {
        from: fromCv.current,
        to: toCv.current,
        width,
        height,
        transitionId: active.transitionId,
        progress: active.progress,
        params: active.params,
        fromFit: fit(outgoing) as "cover" | "contain" | "fill",
        toFit: fit(incoming) as "cover" | "contain" | "fill"
      });
    } catch {
      /* ignore transient texture-not-ready */
    }
  }

  function gradeFrom(src: CanvasImageSource, w: number, h: number) {
    const r = fromR.current;
    if (!r || !w || !h) return;
    const pipeline = getCompositionColorPipeline(outgoing, { currentTimeSeconds });
    r.setPipeline(pipeline);
    r.draw({ source: src as TexImageSource, sourceWidth: w, sourceHeight: h, pipeline, mediaEffects: getCompositionMediaEffects(outgoing, { currentTimeSeconds }) });
    fromHas.current = true;
    mix();
  }
  function gradeTo(src: CanvasImageSource, w: number, h: number) {
    const r = toR.current;
    if (!r || !w || !h) return;
    const pipeline = getCompositionColorPipeline(incoming, { currentTimeSeconds });
    r.setPipeline(pipeline);
    r.draw({ source: src as TexImageSource, sourceWidth: w, sourceHeight: h, pipeline, mediaEffects: getCompositionMediaEffects(incoming, { currentTimeSeconds }) });
    toHas.current = true;
    mix();
  }

  // Preload image sides once (delayRender-gated).
  useEffect(() => {
    if (outgoing.type !== "image" || !outgoing.assetUrl) return undefined;
    const handle = delayRender("tr-from-image");
    let cancelled = false;
    void loadImageOnce(outgoing.assetUrl).then((img) => { if (!cancelled) fromImg.current = img; continueRender(handle); }).catch(() => continueRender(handle));
    return () => { cancelled = true; continueRender(handle); };
  }, [outgoing.assetUrl, outgoing.type]);
  useEffect(() => {
    if (incoming.type !== "image" || !incoming.assetUrl) return undefined;
    const handle = delayRender("tr-to-image");
    let cancelled = false;
    void loadImageOnce(incoming.assetUrl).then((img) => { if (!cancelled) toImg.current = img; continueRender(handle); }).catch(() => continueRender(handle));
    return () => { cancelled = true; continueRender(handle); };
  }, [incoming.assetUrl, incoming.type]);

  // Grade image sides every frame (cheap; the video sides grade in onVideoFrame).
  useEffect(() => {
    if (outgoing.type === "image" && fromImg.current) gradeFrom(fromImg.current, fromImg.current.naturalWidth, fromImg.current.naturalHeight);
    if (incoming.type === "image" && toImg.current) gradeTo(toImg.current, toImg.current.naturalWidth, toImg.current.naturalHeight);
  });

  const fromTrim = Math.max(0, Math.round((outgoing.sourceInSeconds ?? 0) * fps)) || undefined;
  const toTrim = Math.max(0, Math.round((incoming.sourceInSeconds ?? 0) * fps)) || undefined;

  return (
    <AbsoluteFill>
      {outgoing.type === "video" && outgoing.assetUrl ? (
        <OffthreadVideo muted src={outgoing.assetUrl} trimBefore={fromTrim} style={{ display: "none" }} onVideoFrame={(f) => gradeFrom(f, frameSourceWidth(f), frameSourceHeight(f))} />
      ) : null}
      {incoming.type === "video" && incoming.assetUrl ? (
        <OffthreadVideo muted src={incoming.assetUrl} trimBefore={toTrim} style={{ display: "none" }} onVideoFrame={(f) => gradeTo(f, frameSourceWidth(f), frameSourceHeight(f))} />
      ) : null}
      <canvas ref={visibleRef} style={{ width: "100%", height: "100%", objectFit: "fill" }} />
    </AbsoluteFill>
  );
}

/**
 * How long a clip keeps rendering past its out-point so it stays under the next clip's transition reveal
 * (the outgoing side of a junction transition). = the next same-track clip's `transitionIn` duration.
 */
function outgoingPostrollSeconds(layer: RenderManifestLayer, layers: RenderManifestLayer[]): number {
  const end = layer.startSeconds + layer.durationSeconds;
  let best = 0;
  for (const other of layers) {
    if (other.id === layer.id || other.trackId !== layer.trackId || !other.transitionIn) continue;
    if (Math.abs(other.startSeconds - end) < 0.05) best = Math.max(best, other.transitionIn.durationSeconds);
  }
  return best;
}

function LayerSequence({
  adjustmentLayers,
  layer,
  postrollSeconds = 0
}: {
  adjustmentLayers: RenderManifestLayer[];
  layer: RenderManifestLayer;
  postrollSeconds?: number;
}) {
  const { fps } = useVideoConfig();
  const from = Math.max(0, Math.round(layer.startSeconds * fps));
  const durationInFrames = Math.max(1, Math.round((layer.durationSeconds + postrollSeconds) * fps));

  return (
    <Sequence from={from} durationInFrames={durationInFrames}>
      <RenderLayer adjustmentLayers={adjustmentLayers} layer={layer} />
    </Sequence>
  );
}

/**
 * Phase 3 color system — injects this layer's shared SVG color-filter `<defs>`
 * (referenced by the layer style's `filter: url(#lumio-color-…)`). Same shared
 * generator the web preview uses, so export and preview stay pixel-aligned.
 */
function ColorFilterDefs({ layer, currentTimeSeconds }: { layer: RenderManifestLayer; currentTimeSeconds: number }) {
  const markup = buildColorFilterDefs([getCompositionColorFilter(layer, { currentTimeSeconds })?.svg]);
  return markup ? <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} /> : null;
}

/**
 * Injects this layer's vector-mask SVG `<defs>` (the `mask: url(#lumio-mask-…)` referenced by the layer
 * style). Same shared builder the web preview uses → the exported cutout matches the editor preview.
 */
function MaskDefs({ layer, currentTimeSeconds }: { layer: RenderManifestLayer; currentTimeSeconds: number }) {
  const { width, height } = useVideoConfig();
  const markup = buildMaskDefsSvg(layer, { width, height, currentTimeSeconds });
  return markup ? <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} /> : null;
}

/**
 * Effect-level (region) masks: each masked effect renders as a backdrop-filter overlay clipped to its
 * mask, blurring only that region of the clip behind it. Sibling of the media inside the layer's
 * (transformed) AbsoluteFill, so `inset:0` covers the media box. Matches the editor preview exactly.
 */
function MaskedEffectOverlays({ layer, currentTimeSeconds }: { layer: RenderManifestLayer; currentTimeSeconds: number }) {
  const overlays = getMaskedEffectOverlays(layer, { currentTimeSeconds });
  if (!overlays.length) return null;
  return (
    <>
      {overlays.map((overlay) => (
        <div
          key={overlay.effectId}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            backdropFilter: overlay.backdropFilter,
            WebkitBackdropFilter: overlay.backdropFilter,
            ...(overlay.maskCss as React.CSSProperties)
          }}
        />
      ))}
    </>
  );
}

let cachedWebgl2Support: boolean | null = null;
function webgl2Supported(): boolean {
  if (cachedWebgl2Support === null) cachedWebgl2Support = isWebgl2ColorSupported();
  return cachedWebgl2Support;
}

/**
 * Unified-WebGL render path toggle (mirrors apps/web getRendererMode). The shared
 * MediaWebGLRenderer does color + matte + opacity + the native stylize effects
 * (vignette/grain/chroma) in one pass, pixel-identical to the editor preview. Defaults to
 * "webgl" (the backbone, matching apps/web); set RENDERER_MODE=legacy to force the old path.
 */
function getRendererMode(): "legacy" | "webgl" {
  // Remotion injects the harness's `envVariables` into the browser-side `process.env`.
  const value = typeof process !== "undefined" ? process.env?.RENDERER_MODE : undefined;
  return value === "webgl" || value === "legacy" ? value : "webgl";
}

/** WebGL render path is active when flagged on AND the runtime supports WebGL2. */
function useWebglMediaPath(): boolean {
  return getRendererMode() === "webgl" && webgl2Supported();
}

// Loaded source images are cached so an animated grade redraws the LUT without re-decoding.
const lutImageCache = new Map<string, HTMLImageElement>();
function loadImageOnce(src: string): Promise<HTMLImageElement> {
  const cached = lutImageCache.get(src);
  if (cached?.complete && cached.naturalWidth > 0) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      lutImageCache.set(src, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Renders an image graded through the baked float 3D LUT on a WebGL canvas — the SAME
 * engine/shader the editor preview uses, so the export is pixel-identical by construction
 * (and carries HSL hue-curves/secondary that the SVG path drops). Blocks the frame via
 * delayRender until the draw lands; redraws when the (possibly animated) pipeline changes.
 */
function LutGradedImage({ src, pipeline, objectFit }: { src: string; pipeline: ColorPipeline; objectFit: React.CSSProperties["objectFit"] }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const pipelineKey = JSON.stringify(pipeline);
  useEffect(() => {
    const handle = delayRender("color-lut-image");
    let cancelled = false;
    void loadImageOnce(src)
      .then((img) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) {
          continueRender(handle);
          return;
        }
        try {
          const applicator = new WebglColorApplicator(canvas);
          applicator.setLut(pipeline.previewMatte ? bakeMatteLut3d(pipeline.previewMatte) : bakePipelineToLut3d(pipeline));
          applicator.draw(img, img.naturalWidth, img.naturalHeight, 1);
          applicator.dispose();
        } catch {
          /* leave the canvas blank on GL failure; SVG fallback covers the common case */
        }
        continueRender(handle);
      })
      .catch(() => continueRender(handle));
    return () => {
      cancelled = true;
      continueRender(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, pipelineKey]);
  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", objectFit }} />;
}

function RenderLayer({ adjustmentLayers, layer }: { adjustmentLayers: RenderManifestLayer[]; layer: RenderManifestLayer }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTimeSeconds = layer.startSeconds + frame / fps;
  const renderLayer = applyManifestAdjustmentEffects(layer, adjustmentLayers, currentTimeSeconds);

  if (renderLayer.type === "audio") {
    if (!renderLayer.assetUrl) {
      return null;
    }
    // `f` is layer-relative (the Audio sits in the layer's Sequence); getCompositionVolume
    // subtracts startSeconds itself, so pass absolute comp time. Constant gain or fade envelope.
    return (
      <Audio
        src={renderLayer.assetUrl}
        volume={(f) => getCompositionVolume(renderLayer, { currentTimeSeconds: renderLayer.startSeconds + f / fps })}
      />
    );
  }

  if (renderLayer.type === "video") {
    if (!renderLayer.assetUrl) {
      return null;
    }
    // Source-aware: trim the source before the clip's in-point so split/trimmed
    // clips play the correct source frame (must match VideoPreview.syncVideoTime).
    const trimBeforeFrames = Math.max(0, Math.round((renderLayer.sourceInSeconds ?? 0) * fps));

    // Unified WebGL path (rendererMode=webgl): one shader does color grade + matte + opacity,
    // identical to the editor preview. No SVG ColorFilterDefs, no canvas-2D MaskedVideo.
    if (useWebglMediaPath()) {
      const colorPipeline = getCompositionColorPipeline(renderLayer, { currentTimeSeconds });
      const mediaEffects = getCompositionMediaEffects(renderLayer, { currentTimeSeconds });
      const transition = getCompositionTransition(renderLayer, { currentTimeSeconds });
      return (
        <AbsoluteFill style={visualStyle(renderLayer, currentTimeSeconds, { skipColorFilter: true })}>
          <MaskDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
          <WebglMediaVideoRemotion
            assetUrl={renderLayer.assetUrl}
            matte={renderLayer.matte}
            sourceInSeconds={renderLayer.sourceInSeconds ?? 0}
            pipeline={colorPipeline}
            mediaEffects={mediaEffects}
            transition={transition}
            objectFit={fit(renderLayer)}
          />
          <MaskedEffectOverlays layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
        </AbsoluteFill>
      );
    }

    return (
      <AbsoluteFill style={visualStyle(renderLayer, currentTimeSeconds)}>
        <ColorFilterDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
        <MaskDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
        {renderLayer.matte?.uri ? (
          <MaskedVideo assetUrl={renderLayer.assetUrl} matte={renderLayer.matte} sourceInSeconds={renderLayer.sourceInSeconds ?? 0} objectFit={fit(renderLayer)} />
        ) : (
          <OffthreadVideo
            muted
            src={renderLayer.assetUrl}
            trimBefore={trimBeforeFrames || undefined}
            style={{ width: "100%", height: "100%", objectFit: fit(renderLayer) }}
          />
        )}
        <MaskedEffectOverlays layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
      </AbsoluteFill>
    );
  }

  if (renderLayer.type === "image") {
    if (!renderLayer.assetUrl) {
      return null;
    }
    // High-end color path: a graded image's FULL pipeline (incl. HSL hue-curves/secondary
    // that SVG can't express) is baked into a float 3D LUT and applied via WebGL — the same
    // engine the editor preview uses, so export matches by construction. Falls back to the
    // SVG filter (matrix + 1D curves) when the pipeline is SVG-expressible or WebGL is off.
    const colorPipeline = getCompositionColorPipeline(renderLayer, { currentTimeSeconds });

    // Unified WebGL path (rendererMode=webgl): the shared MediaWebGLRenderer is the single
    // grading path — identical to the editor preview, and impossible to double-grade because
    // skipColorFilter strips the SVG filter from the layer style.
    if (useWebglMediaPath()) {
      const mediaEffects = getCompositionMediaEffects(renderLayer, { currentTimeSeconds });
      const transition = getCompositionTransition(renderLayer, { currentTimeSeconds });
      return (
        <AbsoluteFill style={visualStyle(renderLayer, currentTimeSeconds, { skipColorFilter: true })}>
          <MaskDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
          <WebglMediaImageRemotion src={renderLayer.assetUrl} pipeline={colorPipeline} mediaEffects={mediaEffects} transition={transition} objectFit={fit(renderLayer)} />
          <MaskedEffectOverlays layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
        </AbsoluteFill>
      );
    }

    const useLut = colorPipeline !== null && webgl2Supported();
    return (
      <AbsoluteFill style={visualStyle(renderLayer, currentTimeSeconds)}>
        <MaskDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
        {useLut && colorPipeline ? (
          <LutGradedImage src={renderLayer.assetUrl} pipeline={colorPipeline} objectFit={fit(renderLayer)} />
        ) : (
          <>
            <ColorFilterDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
            <Img src={renderLayer.assetUrl} style={{ width: "100%", height: "100%", objectFit: fit(renderLayer) }} />
          </>
        )}
        <MaskedEffectOverlays layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
      </AbsoluteFill>
    );
  }

  if (renderLayer.type === "text") {
    return <TextLayer renderLayer={renderLayer} currentTimeSeconds={currentTimeSeconds} />;
  }

  if (renderLayer.type === "shape") {
    // Clip mask: the AbsoluteFill is the comp-sized, transform-less wrapper the comp-px mask needs (the
    // shape <div> inside is content-sized + transformed). Matches the DOM preview + GPU scene path.
    return (
      <AbsoluteFill style={{ pointerEvents: "none", ...getCompositionMaskCss(renderLayer) }}>
        <MaskDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
        <ColorFilterDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
        <div style={shapeStyle(renderLayer, currentTimeSeconds)} />
      </AbsoluteFill>
    );
  }

  return null;
}

function applyManifestAdjustmentEffects(layer: RenderManifestLayer, adjustmentLayers: RenderManifestLayer[], currentTimeSeconds: number) {
  if (layer.type === "audio") {
    return layer;
  }

  const adjustmentEffects = adjustmentLayers
    .filter(
      (adjustmentLayer) =>
        adjustmentLayer.zIndex > layer.zIndex &&
        currentTimeSeconds >= adjustmentLayer.startSeconds &&
        currentTimeSeconds < adjustmentLayer.startSeconds + adjustmentLayer.durationSeconds
    )
    .flatMap((adjustmentLayer) => adjustmentLayer.effects);

  if (!adjustmentEffects.length) {
    return layer;
  }

  return {
    ...layer,
    effects: [...layer.effects, ...adjustmentEffects]
  };
}

function visualStyle(
  layer: RenderManifestLayer,
  currentTimeSeconds: number,
  options?: { skipColorFilter?: boolean }
): React.CSSProperties {
  const style = getCompositionMediaStyle(layer, { currentTimeSeconds, skipColorFilter: options?.skipColorFilter });
  return style as React.CSSProperties;
}

function textStyle(layer: RenderManifestLayer, currentTimeSeconds: number): React.CSSProperties {
  const transform = getCompositionTransform(layer, { currentTimeSeconds });
  const style = getCompositionTextStyle(layer, { currentTimeSeconds });
  return {
    ...style,
    position: "absolute",
    transform: compositionTransformCss(transform)
  };
}

function shapeStyle(layer: RenderManifestLayer, currentTimeSeconds: number): React.CSSProperties {
  const transform = getCompositionTransform(layer, { currentTimeSeconds });
  const style = getCompositionShapeStyle(layer, { currentTimeSeconds });
  return {
    ...style,
    position: "absolute",
    transform: compositionTransformCss(transform)
  };
}

/**
 * Computes the warped-text vector overlay (opentype outline + envelope mesh) and blocks
 * the frame via delayRender until it's ready, so the export matches the editor preview.
 * Returns null when warp is inactive or the font isn't available (caller shows plain text).
 */
function useWarpedTextSvgRemotion(
  warp: TextWarp | undefined,
  runs: Array<{ text: string; color?: string | undefined; fontSizeMultiplier?: number | undefined }>,
  style: React.CSSProperties
): string | null {
  const active = hasTextWarp(warp);
  const key = active
    ? JSON.stringify([
        normalizeTextWarp(warp),
        runs.map((run) => [run.text, run.color ?? "", run.fontSizeMultiplier ?? 1]),
        style.fontSize,
        style.fontFamily,
        style.color,
        style.textAlign,
        style.WebkitTextStroke
      ])
    : "";
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setSvg(null);
      return;
    }
    const handle = delayRender(`Warp text`);
    let cancelled = false;
    void buildWarpedTextPathSvg(warp, runs, style)
      .then((markup) => {
        if (!cancelled) setSvg(markup ?? null);
        continueRender(handle);
      })
      .catch(() => continueRender(handle));
    return () => {
      cancelled = true;
      continueRender(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  return active ? svg : null;
}

function TextLayer({ renderLayer, currentTimeSeconds }: { renderLayer: RenderManifestLayer; currentTimeSeconds: number }) {
  const style = textStyle(renderLayer, currentTimeSeconds);
  const textWarp = renderLayer.style?.textWarp as TextWarp | undefined;
  const visibleRuns = getVisibleTextRuns(renderLayer, currentTimeSeconds);
  const warpSvg = useWarpedTextSvgRemotion(textWarp, visibleRuns, style);
  const warpReady = warpSvg != null;

  // Clip mask: the AbsoluteFill is the comp-sized, transform-less wrapper the comp-px mask needs (the text
  // <div> inside is content-sized + transformed). Matches the DOM preview + GPU scene path.
  return (
    <AbsoluteFill style={{ pointerEvents: "none", ...getCompositionMaskCss(renderLayer) }}>
      <MaskDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
      <ColorFilterDefs layer={renderLayer} currentTimeSeconds={currentTimeSeconds} />
      <div style={style}>
        {visibleRuns.map((run, index) => (
          <span
            key={`${renderLayer.id}_run_${index}`}
            style={{ ...(getCompositionTextRunStyle(run, style) as React.CSSProperties), visibility: warpReady ? "hidden" : undefined }}
          >
            {run.text}
          </span>
        ))}
        {warpReady ? (
          <span
            aria-hidden="true"
            style={{ position: "absolute", inset: 0, visibility: "visible" }}
            dangerouslySetInnerHTML={{ __html: warpSvg }}
          />
        ) : null}
      </div>
    </AbsoluteFill>
  );
}

function fit(layer: RenderManifestLayer) {
  return getCompositionObjectFit(layer);
}

function useLoadedCompositionFonts(layers: RenderManifestLayer[]) {
  const fonts = useMemo(() => getCompositionFontsUsed(layers), [layers]);
  const fontsKey = fonts.join("|");
  const renderHandle = useMemo(() => delayRender(`Load composition fonts: ${fontsKey || "default"}`), [fontsKey]);

  useEffect(() => {
    let cancelled = false;
    const fontSet = typeof document === "undefined" ? undefined : document.fonts;

    async function loadFonts() {
      if (fontSet) {
        await Promise.all(fonts.map((fontFamily) => fontSet.load(`900 64px ${fontFamily}`).catch(() => undefined)));
        await fontSet.ready;
      }

      if (!cancelled) {
        continueRender(renderHandle);
      }
    }

    void loadFonts();

    return () => {
      cancelled = true;
    };
  }, [fonts, renderHandle]);
}

