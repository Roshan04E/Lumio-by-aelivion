/**
 * Single-context GPU-first preview (Phase 5, flag `orreris.singleCtxPreview`) — the seam between
 * `WebglMediaLayer` (frame PRODUCER) and `ScenePreviewCanvas` (in-context GRADER).
 *
 * When the flag is on, a scene-composited media layer stops creating its own `MediaWebGLRenderer`
 * context/canvas. Instead it registers ONE stable {@link ScenePreviewMediaSource} descriptor whose
 * `snapshot()` exposes the layer's RAW frame source (the pooled `<video>` element, the held WebCodecs
 * `VideoFrame` clone, the full-res settle frame, or the decoded still bitmap) together with the grade
 * inputs the layer's own shader pass used to bake (`ColorPipeline` / matte / stylize effects / amount /
 * baked opacity). `ScenePreviewCanvas` then uploads the raw frame ONCE and grades it through a
 * shared-context `MediaWebGLRenderer` + `RenderTarget` on the SceneCompositor's own WebGL2 context —
 * the exact single-context architecture the EXPORT path already ships
 * (`SceneFrameCompositor.gradeMediaLayer`, `exportSingleContext`).
 *
 * All fields are read at COMPOSITE time (the compositor calls `snapshot()` per composited frame), so
 * the descriptor must always reflect the layer's live props — implementations read refs, never close
 * over render-time values. `frameVersion` + the keys drive the compositor's re-grade skip: an
 * unchanged key set means the cached graded `RenderTarget` is reused with zero uploads (the static
 * photo win the producer-version upload skip used to provide).
 */

import type { ColorPipeline, MediaEffects, MediaTransition } from "@orreris/shared";

export interface ScenePreviewMediaFrame {
  /** The raw decode source to upload (video element / VideoFrame clone / ImageBitmap / img). */
  source: TexImageSource;
  width: number;
  height: number;
}

export interface ScenePreviewMediaSnapshot {
  /** Current raw frame, or null when nothing is decoded yet (layer draws nothing this frame). */
  frame: ScenePreviewMediaFrame | null;
  /** Monotonic counter, bumped by the layer whenever a NEW frame is published. */
  frameVersion: number;
  pipeline: ColorPipeline | null;
  /** Memoized JSON of `pipeline` (drives the shared renderer's LUT re-bake skip). */
  pipelineKey: string;
  mediaEffects: MediaEffects | null;
  mediaEffectsKey: string;
  /** Grade intensity 0..1. */
  amount: number;
  /**
   * Opacity to BAKE into the grade (1 when the compositor applies opacity live at composite —
   * mirrors the `bakeOpacity` prop split between scene media and transition sources).
   */
  bakedOpacity: number;
  /** Luma matte ready to sample this frame, or null. Matte presence disables the re-grade skip
   *  (a playing matte video changes pixels without any versioned signal). */
  matte: { source: TexImageSource; invert: boolean; opacity: number } | null;
  /** Legacy per-clip reveal (wipe/iris/dip) — null in scene mode (junctions fold in-compositor). */
  transition: MediaTransition | null;
  transitionKey: string;
}

/** Registered by `WebglMediaLayer`; polled by `ScenePreviewCanvas` at composite time. */
export interface ScenePreviewMediaSource {
  snapshot(): ScenePreviewMediaSnapshot;
}

/** Handed to `WebglMediaLayer` by `VideoPreview` (per layer). Presence of this prop IS the mode
 *  switch: when set, the layer never creates its own GL context. */
export interface SceneMediaSink {
  /** Publish/withdraw this layer's descriptor (called on mount/unmount of the single-ctx mode). */
  register(source: ScenePreviewMediaSource | null): void;
  /** A new raw frame landed — re-arm the scene recomposite (cheap; the analog of onGradedFrame). */
  onFrame(): void;
}
