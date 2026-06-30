/**
 * Tiny 2D-canvas factory shared by the scene helpers (Method 3, Phase 5).
 *
 * The scene text raster + clip-mask matte run on the MAIN THREAD in the editor (where `document` exists)
 * AND inside the export Web Worker (where it does not). This returns a real `<canvas>` on the main thread
 * and an `OffscreenCanvas` in the Worker — the same fallback `FrameCompositor.makeCanvas` already uses —
 * so the scene compositor can drive the local export headlessly.
 */

export type AnyCanvas2D = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A `<canvas>` (main thread) or `OffscreenCanvas` (Worker), sized to `width`×`height` (min 1×1). */
export function makeCanvas2D(width = 1, height = 1): AnyCanvas2D {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  return new OffscreenCanvas(w, h);
}
