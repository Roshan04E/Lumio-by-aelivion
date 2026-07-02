/**
 * Professional Color System (Phase 3 maturity) — shared types.
 * See COLOR_SYSTEM_PLAN.md. The `color/` module compiles color effects into ONE
 * device-independent `ColorPipeline` that both renderers apply identically:
 *  - emitted as SVG filter primitives for the DOM renderers (web preview + Remotion),
 *  - and replayable on the CPU (`applyPipelineToRgb`) for deterministic tests / fallback.
 */

/**
 * The color-interpolation space the pipeline operates in. SVG's
 * `color-interpolation-filters` defaults to linearRGB; 13C.0 pins **sRGB** so the
 * tone controls feel like standard NLE sliders and the CPU reference is a direct
 * 0..1 mapping. Linear-light grading is a 13C.1 refinement.
 */
export type ColorInterpolation = "sRGB" | "linearRGB";

/** Number of samples in a tone-curve LUT (SVG `tableValues` length). */
export const TONE_LUT_SIZE = 33;

/** Rec.709 luma weights — used for luma-preserving saturation. */
export const LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/** Per-channel tone curve, each entry a 0..1 sample over a 0..1 domain. */
export interface ToneCurve {
  r: number[];
  g: number[];
  b: number[];
}

/**
 * One color operation: an optional 3×4 (row-major, RGB + offset column) matrix
 * applied first, then an optional per-channel tone curve. A pipeline is an ordered
 * list of stages (one per source color effect) applied in sequence — this composes
 * correctly without folding, and maps 1:1 onto sequential SVG primitives.
 */
export interface ColorStage {
  /** 12 entries (3 rows × 4 cols); `null` = identity. */
  matrix: number[] | null;
  /** `null` = identity (passthrough). */
  curve: ToneCurve | null;
  /**
   * Optional HSL-domain op (Lumetri hue/sat curves OR an HSL-secondary key+correct).
   * Cross-channel, so SVG can't express it — applied only by the CPU reference and the
   * baked 3D LUT (WebGL). The SVG emitter omits any stage that has only this set.
   */
  hsl?: import("./hsl").HueSatCurves | import("./hsl").HslSecondary | null;
  /**
   * Optional external 3D LUT (imported .cube or creative look baked LUT).
   * Applied after matrix + curve + hsl via trilinear sampling (`sampleLut3d`).
   * SVG can't express 3D LUTs — this stage is WebGL/CPU only.
   */
  lut3d?: import("./lut3d").Lut3d | null;
  /** 0..1 blend amount for `lut3d`; default 1. */
  lutAmount?: number | undefined;
}

export interface ColorPipeline {
  stages: ColorStage[];
  space: ColorInterpolation;
  /** True when the pipeline is a no-op, so renderers can skip the filter entirely. */
  identity: boolean;
  /**
   * Editor-only: when an HSL-secondary has "show mask" enabled, the keyer whose matte
   * should be displayed (grayscale) instead of the grade. The WebGL view bakes this into
   * a matte LUT; the SVG path and export ignore it (it's a UI aid, not part of the look).
   */
  previewMatte?: import("./hsl").HslSecondary | null;
}

/**
 * Decoupled compiler input: a color effect with its params already resolved to
 * numbers (the caller evaluates keyframes). Keeps `color/` free of the keyframe
 * evaluator and trivially testable.
 */
export interface ColorEffectInput {
  type: string;
  /** 0..100; scales every control toward neutral. Defaults to 100 (full strength). */
  intensity?: number | undefined;
  params: Record<string, number>;
  /** For the `colorCurves` effect: parsed graph control points per channel. */
  curves?: import("./curve").ChannelCurves | undefined;
  /** For the `colorWheels` effect: parsed 3-way wheel values. */
  wheels?: import("./wheels").ColorWheels | undefined;
  /** For the `hueSatCurves` effect: parsed Lumetri hue/sat curve points. */
  hueSatCurves?: import("./hsl").HueSatCurves | undefined;
  /** For the `hslSecondary` effect: parsed key + correction. */
  secondary?: import("./hsl").HslSecondary | undefined;
  /** For the `importedLut` effect: the decoded 3D LUT (deserialized from base64 param). */
  importedLut3d?: import("./lut3d").Lut3d | undefined;
}

/** Normalized control set every supported color effect maps into. */
export interface ColorControls {
  exposure: number; // signed, neutral 0
  contrast: number; // signed, neutral 0
  highlights: number; // signed, neutral 0
  shadows: number; // signed, neutral 0
  whites: number; // signed, neutral 0
  blacks: number; // signed, neutral 0
  saturation: number; // 0..220, neutral 100
  vibrance: number; // signed, neutral 0
  temperature: number; // signed, neutral 0
  tint: number; // signed, neutral 0
}

export const NEUTRAL_CONTROLS: ColorControls = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 100,
  vibrance: 0,
  temperature: 0,
  tint: 0
};

/** Effect `type`s this engine knows how to compile. */
export const COLOR_EFFECT_TYPES: ReadonlySet<string> = new Set([
  "brightnessContrast",
  "colorGrade",
  "curves",
  "colorCurves",
  "colorWheels",
  "hueSatCurves",
  "hslSecondary",
  "creativeLook",   // 13C.4 — built-in creative look preset
  "importedLut"     // 13C.4 — user-imported .cube LUT
]);

/**
 * Pro stylize effects applied in the unified WebGL media shader (single pass, GPU,
 * lightweight). Built per-frame from a layer's effects by `getCompositionMediaEffects`
 * and consumed by `MediaWebGLRenderer.draw`. All ranges normalized 0..1 (color in 0..1
 * rgb) so the shader uniforms map 1:1. `null` fields = effect absent (branch disabled).
 */
export interface MediaEffects {
  vignette: { amount: number; size: number } | null;
  grain: { amount: number } | null;
  chromaKey: { color: [number, number, number]; tolerance: number; softness: number } | null;
  /** Composition time in seconds — deterministic grain seed (identical in preview + export). */
  timeSeconds: number;
}

/** True when every stylize branch is disabled (renderer can skip the uniforms cheaply). */
export function isIdentityMediaEffects(fx: MediaEffects | null | undefined): boolean {
  return !fx || (!fx.vignette && !fx.grain && !fx.chromaKey);
}
