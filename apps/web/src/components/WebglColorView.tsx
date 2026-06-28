import { useEffect, useRef, type CSSProperties } from "react";
import { WebglColorApplicator, bakeMatteLut3d, bakePipelineToLut3d, type ColorPipeline } from "@reelforge/shared";

/**
 * Professional Color System (Phase 3) — WebGL color OVERLAY for images (flag-gated).
 * Non-destructive: the `<img>` underneath always renders (SVG filter = fallback); this
 * canvas sits on top (pointer-events: none) and covers it with the float 3D-LUT grade.
 *
 * Sizing: the canvas drawing buffer is the source's NATIVE resolution and the full frame
 * is graded 1:1; the canvas's CSS `object-fit` (copied from the image style) lets the
 * BROWSER do the fit — exactly like the `<img>` — so there's no manual crop math to get
 * wrong. Every GL call is guarded; on failure it stops and the SVG image shows through.
 */

export function WebglColorView({
  src,
  pipeline,
  amount = 1,
  style
}: {
  src: string;
  pipeline: ColorPipeline;
  amount?: number;
  style?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const applicatorRef = useRef<WebglColorApplicator | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
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

  // Re-bake only when the grade changes (pipeline is a fresh object each render).
  const pipelineKey = JSON.stringify(pipeline);
  useEffect(() => {
    if (failedRef.current) return;
    try {
      // "Show mask" on an HSL-secondary swaps the grade for the grayscale key matte.
      const lut = pipeline.previewMatte ? bakeMatteLut3d(pipeline.previewMatte) : bakePipelineToLut3d(pipeline);
      applicatorRef.current?.setLut(lut);
      draw();
    } catch {
      failedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineKey]);

  useEffect(() => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      imageRef.current = image;
      draw();
    };
    image.src = src;
    return () => {
      image.onload = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  function draw() {
    if (failedRef.current) return;
    const applicator = applicatorRef.current;
    const image = imageRef.current;
    if (!applicator || !image || image.naturalWidth === 0) return;
    try {
      // Buffer = native source size; the browser's object-fit (from style) does the fit.
      applicator.draw(image, image.naturalWidth, image.naturalHeight, amount);
    } catch {
      failedRef.current = true;
    }
  }

  // `preview-media` supplies the absolute positioning/sizing the inline left/top/transform
  // rely on — without it the canvas collapses into the corner (cover only top-left).
  return <canvas ref={canvasRef} className="preview-media" aria-hidden="true" style={{ ...style, filter: undefined, pointerEvents: "none" }} />;
}
