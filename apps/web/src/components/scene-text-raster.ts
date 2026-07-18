/**
 * Compatibility shim (Method 3, Phase 6.1).
 *
 * The text/shape rasterizer moved into `@orreris/shared` (packages/shared/src/scene/scene-text-raster.ts)
 * so the editor preview, local export, and the future Remotion SceneStage share one rasterizer. This file
 * is intentionally kept at its original path because the raster diagnostic probes load it by URL
 * (`/src/components/scene-text-raster.ts`); it just re-exports the canonical shared implementation.
 */

export { SceneTextRasterizer, type SceneRaster } from "@orreris/shared";
