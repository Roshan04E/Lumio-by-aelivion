/**
 * Professional Color System (Phase 3 maturity) — shared color engine.
 * See COLOR_SYSTEM_PLAN.md. One pipeline, two engines: compiled here, emitted as SVG
 * filter primitives for the DOM renderers, replayable on the CPU for tests/fallback.
 */
export * from "./types";
export * from "./color-management";
export * from "./curve";
export * from "./wheels";
export * from "./hsl";
export * from "./pipeline";
export * from "./svg";
export * from "./cpu";
export * from "./lut3d";
export * from "./shader";
export * from "./webgl-applicator";
export * from "./media-shader";
export * from "./media-renderer";
export * from "./transitions/registry";
export * from "./transition-compositor";
export * from "./fragment-effects/registry";
export * from "./gl-context";
export * from "./blend";
export * from "./scene-compositor";
export * from "./cube-parser";
export * from "./looks";
export * from "./grade-intent";
