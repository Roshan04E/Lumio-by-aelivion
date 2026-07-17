import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type HTMLAttributes } from "react";
import { compositeMatteToImageData, type MatteRef } from "@kimera-by-aelivion/shared";
import { setMediaPlaybackRate } from "../playback/media-rate";

/**
 * Renders a video layer through its person-extraction matte. This is the web
 * half of the parity-critical compositor described in matte.ts. The Remotion
 * side now applies mattes through SceneStage's shared MediaWebGLRenderer path so
 * the editor preview and the exported video show the same cutout. Do not
 * reimplement the alpha-multiply math here.
 *
 * Strategy: decode the source video and the matte video into two hidden <video>
 * elements, draw both to off-screen canvases each frame, composite, and blit the
 * result onto the visible canvas. The visible canvas receives the *same* style
 * object the plain <video> path would have used (object-fit/position/transform
 * all apply to <canvas> exactly like they do to <video>), so layout stays identical.
 *
 * The forwarded ref exposes the real source <video> element (not a wrapper) so
 * VideoPreview's existing play/pause/seek sync effects keep working unmodified
 * whether or not the layer is masked.
 */
export const MaskedVideoLayer = forwardRef<HTMLVideoElement, {
  mediaUrl: string;
  matte: MatteRef;
  currentTime: number;
  isPlaying: boolean;
  layerStartSeconds: number;
  sourceInSeconds?: number | undefined;
  /** Clip playback rate (rate stretch). Default 1. */
  speedFactor?: number | undefined;
  className?: string | undefined;
  style: CSSProperties;
  onLoadedMetadata?: ((event: React.SyntheticEvent<HTMLVideoElement>) => void) | undefined;
  dragHandlers?: HTMLAttributes<HTMLCanvasElement> | undefined;
}>(function MaskedVideoLayer(
  { mediaUrl, matte, currentTime, isPlaying, layerStartSeconds, sourceInSeconds = 0, speedFactor = 1, className, style, onLoadedMetadata, dragHandlers },
  forwardedRef
) {
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const matteVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const matteCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useImperativeHandle(forwardedRef, () => sourceVideoRef.current as HTMLVideoElement, []);

  useEffect(() => {
    const matteVideo = matteVideoRef.current;
    if (!matteVideo) {
      return;
    }
    // The matte video is sampled across the source media, so it must use the
    // same source-aware offset as the source video itself.
    setMediaPlaybackRate(matteVideo, speedFactor);
    const nextTime = sourceInSeconds + Math.max(0, currentTime - layerStartSeconds) * speedFactor;
    if (Number.isFinite(nextTime) && Math.abs(matteVideo.currentTime - nextTime) > 0.08 * Math.max(1, speedFactor)) {
      matteVideo.currentTime = nextTime;
    }
  }, [currentTime, layerStartSeconds, sourceInSeconds, speedFactor]);

  useEffect(() => {
    const matteVideo = matteVideoRef.current;
    if (!matteVideo) {
      return;
    }
    if (isPlaying) {
      void matteVideo.play().catch(() => undefined);
    } else {
      matteVideo.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    function drawFrame() {
      const sourceVideo = sourceVideoRef.current;
      const matteVideo = matteVideoRef.current;
      const canvas = canvasRef.current;
      if (sourceVideo && matteVideo && canvas && sourceVideo.videoWidth && sourceVideo.videoHeight) {
        const width = sourceVideo.videoWidth;
        const height = sourceVideo.videoHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        const workCanvas = (workCanvasRef.current ??= document.createElement("canvas"));
        const matteCanvas = (matteCanvasRef.current ??= document.createElement("canvas"));
        workCanvas.width = width;
        workCanvas.height = height;
        matteCanvas.width = width;
        matteCanvas.height = height;

        const workCtx = workCanvas.getContext("2d");
        const matteCtx = matteCanvas.getContext("2d");
        const outCtx = canvas.getContext("2d");
        if (workCtx && matteCtx && outCtx) {
          workCtx.drawImage(sourceVideo, 0, 0, width, height);
          matteCtx.drawImage(matteVideo, 0, 0, width, height);
          const rgba = workCtx.getImageData(0, 0, width, height);
          const matteLuma = matteCtx.getImageData(0, 0, width, height);
          compositeMatteToImageData(rgba.data, matteLuma.data, width, height, {
            feather: matte.feather,
            edgeMode: matte.edgeMode,
            invert: matte.invert,
            opacity: matte.opacity
          });
          outCtx.putImageData(rgba, 0, 0);
        }
      }
      rafRef.current = requestAnimationFrame(drawFrame);
    }

    rafRef.current = requestAnimationFrame(drawFrame);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [matte.edgeMode, matte.feather, matte.invert, matte.opacity]);

  return (
    <>
      <video
        ref={sourceVideoRef}
        crossOrigin="anonymous"
        src={mediaUrl}
        muted
        playsInline
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        style={{ display: "none" }}
      />
      <video crossOrigin="anonymous" ref={matteVideoRef} src={matte.uri} muted playsInline preload="auto" style={{ display: "none" }} />
      <canvas ref={canvasRef} className={className} style={style} {...dragHandlers} />
    </>
  );
});
