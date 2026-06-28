import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { WebglColorApplicator, bakeMatteLut3d, bakePipelineToLut3d, type ColorPipeline } from "@reelforge/shared";

/**
 * Professional Color System (Phase 3) — WebGL video grading overlay (flag-gated).
 * Non-destructive: the existing `<video>` keeps ALL its logic (playback, seek sync,
 * drag, source-trim) and acts as the pixel source; this canvas sits on top
 * (pointer-events: none — drags pass through) and draws each frame through the float
 * 3D-LUT engine. A rAF / `requestVideoFrameCallback` loop runs only while playing; when
 * paused it redraws on seek. Used only when `?colorEngine=webgl` + WebGL2 + the layer is
 * graded; otherwise the plain DOM/SVG video path renders.
 */

type VideoFrameCapableElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function WebglVideoOverlay({
  videoRef,
  pipeline,
  amount = 1,
  playing,
  currentTime,
  style,
  className
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  pipeline: ColorPipeline;
  amount?: number;
  playing: boolean;
  currentTime: number;
  style?: CSSProperties;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const applicatorRef = useRef<WebglColorApplicator | null>(null);
  const rafRef = useRef<number | null>(null);
  const vfcRef = useRef<number | null>(null);
  const failedRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    try {
      applicatorRef.current = new WebglColorApplicator(canvas);
    } catch {
      applicatorRef.current = null;
      failedRef.current = true;
    }
    return () => {
      try {
        applicatorRef.current?.dispose();
      } catch {
        /* ignore */
      }
      applicatorRef.current = null;
    };
  }, []);

  const pipelineKey = JSON.stringify(pipeline);
  useEffect(() => {
    if (failedRef.current) return;
    try {
      // "Show mask" on an HSL-secondary swaps the grade for the grayscale key matte.
      const lut = pipeline.previewMatte ? bakeMatteLut3d(pipeline.previewMatte) : bakePipelineToLut3d(pipeline);
      applicatorRef.current?.setLut(lut);
      drawOnce();
    } catch {
      failedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineKey]);

  // Redraw a paused frame when the playhead moves (seek/scrub).
  useEffect(() => {
    if (!playing) drawOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, playing]);

  // Frame loop while playing — prefer requestVideoFrameCallback for frame accuracy.
  useEffect(() => {
    if (!playing) return undefined;
    const video = videoRef.current as VideoFrameCapableElement | null;
    let active = true;

    if (video?.requestVideoFrameCallback) {
      const tick = () => {
        if (!active) return;
        draw(video);
        vfcRef.current = video.requestVideoFrameCallback!(tick);
      };
      vfcRef.current = video.requestVideoFrameCallback(tick);
      return () => {
        active = false;
        if (vfcRef.current != null) video.cancelVideoFrameCallback?.(vfcRef.current);
      };
    }

    const loop = () => {
      if (!active) return;
      drawOnce();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  function drawOnce() {
    const video = videoRef.current;
    if (video) draw(video);
  }

  function draw(video: HTMLVideoElement) {
    if (failedRef.current) return;
    const applicator = applicatorRef.current;
    if (!applicator || video.readyState < 2 || video.videoWidth === 0) return;
    try {
      // Buffer = native video size; the canvas's CSS object-fit (from style) does the fit.
      applicator.draw(video, video.videoWidth, video.videoHeight, amount);
    } catch {
      failedRef.current = true;
    }
  }

  return <canvas ref={canvasRef} className={className} style={{ ...style, filter: undefined, pointerEvents: "none" }} aria-hidden="true" />;
}
