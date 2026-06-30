/**
 * SceneCompositor frame-builder inputs (Method 3, Phase 6.1).
 *
 * Pure, render-safe logic promoted out of apps/web so the editor preview, the local export, and the
 * future Remotion SceneStage all build their SceneCompositor draw lists from one place. No React, no
 * editor state, no DOM-preview wiring lives here — only canvas2D/WebGL-safe rasterization + draw-list
 * construction. The React/editor wiring stays in apps/web and imports from this barrel.
 */

export * from "./canvas-2d";
export * from "./text-shape";
export * from "./scene-mask-matte";
export * from "./scene-text-raster";
export * from "./build-scene-draws";
