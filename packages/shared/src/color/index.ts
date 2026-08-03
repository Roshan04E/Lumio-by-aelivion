/**
 * Professional Color System (Phase 3 maturity) — shared color engine.
 * See COLOR_SYSTEM_PLAN.md. One pipeline, two engines: compiled here, emitted as SVG
 * filter primitives for the DOM renderers, replayable on the CPU for tests/fallback.
 */
export * from "./types";
export * from "./color-management";
// Stage 2a input transforms. Exported so Stage 3 can find them; NOTHING consumes them in a renderer
// yet, and most carry verification: "spec-pending" — see plans/log-raw-source-color.md before wiring.
export * from "./input-transform";
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
export * from "./transitions/pipeline";
export * from "./transitions/pipeline-assembler";
export * from "./transition-compositor";
export * from "./fragment-effects/registry";
export * from "./fragment-effects/builtins";
export * from "./gl-context";
export * from "./frame-profiler";
export * from "./blend";
export * from "./scene-compositor";
export * from "./cube-parser";
export * from "./cube-writer";
export * from "./looks";
export * from "./grade-intent";
