import React, { useCallback, useEffect, useRef } from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  continueRender,
  delayRender,
  useVideoConfig,
  type OnVideoFrame
} from "remotion";
import { MediaWebGLRenderer, type ColorPipeline, type MatteRef, type MediaEffects, type MediaTransition } from "@reelforge/shared";

/**
 * Remotion half of the unified WebGL render path (rendererMode=webgl).
 *
 * Mirrors apps/web/src/components/WebglMediaLayer.tsx: the SAME `MediaWebGLRenderer`
 * shader grades + composites the matte + applies opacity in one WebGL2 pass, so the
 * exported MP4 is pixel-identical to the editor preview by construction. No SVG color
 * filter and no canvas-2D matte path run on these layers — the shader is the single
 * source of truth.
 *
 * Object-fit stays a CSS property on the output `<canvas>` (same as the legacy
 * `LutGradedImage` / `MaskedVideo`), so layout matches the DOM path exactly.
 *
 * During a real Remotion render `<OffthreadVideo>` never mounts a `<video>` element —
 * it supplies each decoded frame through `onVideoFrame` inside Remotion's own
 * delayRender-gated layout effect (see MaskedVideo.tsx). So the source/matte frames
 * are captured in that callback and drawn through the shared renderer there.
 */

// Decoded source images are cached so an animated grade redraws without re-decoding.
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

export function WebglMediaImageRemotion({
  src,
  pipeline,
  mediaEffects = null,
  transition = null,
  objectFit
}: {
  src: string;
  pipeline: ColorPipeline | null;
  mediaEffects?: MediaEffects | null;
  transition?: MediaTransition | null;
  objectFit: React.CSSProperties["objectFit"];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<MediaWebGLRenderer | null>(null);
  const pipelineKey = JSON.stringify(pipeline);
  const mediaEffectsKey = JSON.stringify(mediaEffects);
  // Redraw per frame while a wipe/iris is in progress (progress changes each frame).
  const transitionKey = JSON.stringify(transition);

  // Tear down the renderer (and its GL context) on unmount.
  useEffect(() => {
    return () => {
      try {
        rendererRef.current?.dispose();
      } catch {
        /* ignore */
      }
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handle = delayRender("webgl-media-image");
    let cancelled = false;
    void loadImageOnce(src)
      .then((img) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) {
          continueRender(handle);
          return;
        }
        try {
          const renderer = (rendererRef.current ??= new MediaWebGLRenderer(canvas));
          renderer.setPipeline(pipeline);
          renderer.draw({
            source: img,
            sourceWidth: img.naturalWidth,
            sourceHeight: img.naturalHeight,
            pipeline,
            mediaEffects,
            transition
          });
        } catch {
          /* leave the canvas blank on GL failure */
        }
        continueRender(handle);
      })
      .catch(() => continueRender(handle));
    return () => {
      cancelled = true;
      continueRender(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, pipelineKey, mediaEffectsKey, transitionKey]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", objectFit }} />;
}

export function WebglMediaVideoRemotion({
  assetUrl,
  matte,
  sourceInSeconds = 0,
  pipeline,
  mediaEffects = null,
  transition = null,
  objectFit
}: {
  assetUrl: string;
  matte?: MatteRef | undefined;
  sourceInSeconds?: number;
  pipeline: ColorPipeline | null;
  mediaEffects?: MediaEffects | null;
  transition?: MediaTransition | null;
  objectFit: React.CSSProperties["objectFit"];
}) {
  const { fps } = useVideoConfig();
  const trimBeforeFrames = Math.max(0, Math.round(sourceInSeconds * fps)) || undefined;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<MediaWebGLRenderer | null>(null);
  const sourceFrameRef = useRef<CanvasImageSource | null>(null);
  const matteFrameRef = useRef<CanvasImageSource | null>(null);
  // The transition reveal changes every frame — read the latest from a ref inside the per-frame draw.
  const transitionRef = useRef<MediaTransition | null>(transition);
  transitionRef.current = transition;
  const pipelineKey = JSON.stringify(pipeline);
  const mediaEffectsKey = JSON.stringify(mediaEffects);
  const hasMatte = Boolean(matte?.uri);

  const drawIfReady = useCallback(() => {
    const canvas = canvasRef.current;
    const source = sourceFrameRef.current;
    if (!canvas || !source) return;
    // With a matte, wait until both frames have arrived so the composite is complete.
    if (hasMatte && !matteFrameRef.current) return;

    const w = frameSourceWidth(source);
    const h = frameSourceHeight(source);
    if (!w || !h) return;

    try {
      const renderer = (rendererRef.current ??= new MediaWebGLRenderer(canvas));
      renderer.setPipeline(pipeline);
      // OffthreadVideo always supplies an <img>/<canvas> frame (never SVGImageElement), so the
      // CanvasImageSource → TexImageSource narrowing is safe under the real renderer.
      renderer.draw({
        source: source as TexImageSource,
        sourceWidth: w,
        sourceHeight: h,
        matte: hasMatte ? (matteFrameRef.current as TexImageSource) : null,
        matteInvert: matte?.invert ?? false,
        matteOpacity: matte?.opacity ?? 1,
        pipeline,
        mediaEffects,
        transition: transitionRef.current
      });
    } catch {
      /* leave the canvas blank on GL failure */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineKey, mediaEffectsKey, hasMatte, matte?.invert, matte?.opacity]);

  const onSourceFrame: OnVideoFrame = useCallback(
    (frame) => {
      sourceFrameRef.current = frame;
      drawIfReady();
    },
    [drawIfReady]
  );
  const onMatteFrame: OnVideoFrame = useCallback(
    (frame) => {
      matteFrameRef.current = frame;
      drawIfReady();
    },
    [drawIfReady]
  );

  useEffect(() => {
    return () => {
      try {
        rendererRef.current?.dispose();
      } catch {
        /* ignore */
      }
      rendererRef.current = null;
    };
  }, []);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <OffthreadVideo
        muted
        src={assetUrl}
        trimBefore={trimBeforeFrames}
        style={{ display: "none" }}
        onVideoFrame={onSourceFrame}
      />
      {hasMatte && matte?.uri ? (
        <OffthreadVideo
          muted
          src={matte.uri}
          trimBefore={trimBeforeFrames}
          style={{ display: "none" }}
          onVideoFrame={onMatteFrame}
        />
      ) : null}
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", objectFit }} />
    </AbsoluteFill>
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
