import React, { useCallback, useRef } from "react";
import { AbsoluteFill, OffthreadVideo, useVideoConfig, type OnVideoFrame } from "remotion";
import { compositeMatteToImageData, type MatteRef } from "@reelforge/shared";

/**
 * Remotion half of the parity-critical compositor (see matte.ts and
 * apps/web/src/components/MaskedVideoLayer.tsx). Per frame, draws the decoded
 * source and matte frames to two off-screen canvases and runs the exact same
 * compositeMatteToImageData() the web preview uses, so an exported MP4 matches
 * the editor's cutout pixel for pixel - never duplicate this alpha-multiply math.
 *
 * During an actual Remotion render (not interactive Studio playback),
 * <OffthreadVideo> never mounts a real <video> element - it fetches each frame
 * as an image server-side and renders Remotion's own <Img>, gated behind
 * Remotion's delayRender/continueRender so the frame is guaranteed decoded
 * before the next step runs. `onVideoFrame` is the supported hook for exactly
 * this: it fires synchronously with the decoded <img> once ready, inside that
 * same delayRender-gated layout effect - so doing the canvas composite directly
 * in this callback (not in a separate effect keyed on a DOM query) is what
 * actually works under the real renderer. An earlier version of this component
 * queried for a `<video>` element that is never present during a real render,
 * so the canvas was silently never drawn into - confirmed by rendering a still
 * frame through the real @remotion/renderer pipeline and seeing a blank output.
 */
export function MaskedVideo({
  assetUrl,
  matte,
  sourceInSeconds = 0,
  objectFit
}: {
  assetUrl: string;
  matte: MatteRef;
  sourceInSeconds?: number;
  objectFit: "cover" | "contain" | "fill";
}) {
  const { fps } = useVideoConfig();
  const trimBeforeFrames = Math.max(0, Math.round(sourceInSeconds * fps)) || undefined;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceFrameRef = useRef<CanvasImageSource | null>(null);
  const matteFrameRef = useRef<CanvasImageSource | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const matteCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const drawIfReady = useCallback(() => {
    const canvas = canvasRef.current;
    const sourceFrame = sourceFrameRef.current;
    const matteFrame = matteFrameRef.current;
    if (!canvas || !sourceFrame || !matteFrame) {
      return;
    }

    const frameWidth = frameSourceWidth(sourceFrame);
    const frameHeight = frameSourceHeight(sourceFrame);
    if (!frameWidth || !frameHeight) {
      return;
    }

    if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
      canvas.width = frameWidth;
      canvas.height = frameHeight;
    }

    const workCanvas = (workCanvasRef.current ??= document.createElement("canvas"));
    const matteCanvas = (matteCanvasRef.current ??= document.createElement("canvas"));
    workCanvas.width = frameWidth;
    workCanvas.height = frameHeight;
    matteCanvas.width = frameWidth;
    matteCanvas.height = frameHeight;

    const workCtx = workCanvas.getContext("2d");
    const matteCtx = matteCanvas.getContext("2d");
    const outCtx = canvas.getContext("2d");
    if (!workCtx || !matteCtx || !outCtx) {
      return;
    }

    workCtx.drawImage(sourceFrame, 0, 0, frameWidth, frameHeight);
    matteCtx.drawImage(matteFrame, 0, 0, frameWidth, frameHeight);
    const rgba = workCtx.getImageData(0, 0, frameWidth, frameHeight);
    const matteLuma = matteCtx.getImageData(0, 0, frameWidth, frameHeight);
    compositeMatteToImageData(rgba.data, matteLuma.data, frameWidth, frameHeight, {
      feather: matte.feather,
      edgeMode: matte.edgeMode,
      invert: matte.invert,
      opacity: matte.opacity
    });
    outCtx.putImageData(rgba, 0, 0);
  }, [matte.edgeMode, matte.feather, matte.invert, matte.opacity]);

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

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <OffthreadVideo muted src={assetUrl} trimBefore={trimBeforeFrames} style={{ display: "none" }} onVideoFrame={onSourceFrame} />
      <OffthreadVideo muted src={matte.uri ?? assetUrl} trimBefore={trimBeforeFrames} style={{ display: "none" }} onVideoFrame={onMatteFrame} />
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", objectFit }} />
    </AbsoluteFill>
  );
}

function frameSourceWidth(frame: CanvasImageSource): number {
  if (frame instanceof HTMLImageElement) {
    return frame.naturalWidth;
  }
  if (frame instanceof HTMLVideoElement) {
    return frame.videoWidth;
  }
  return (frame as { width?: number }).width ?? 0;
}

function frameSourceHeight(frame: CanvasImageSource): number {
  if (frame instanceof HTMLImageElement) {
    return frame.naturalHeight;
  }
  if (frame instanceof HTMLVideoElement) {
    return frame.videoHeight;
  }
  return (frame as { height?: number }).height ?? 0;
}
