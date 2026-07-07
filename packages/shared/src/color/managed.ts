/**
 * Professional Color System — managed Rec.709 SDR correction (linear-light).
 *
 * This is the EXACT correction math for the WebGL/CPU backbone. Unlike the SVG
 * approximation (a display-referred `matrix` + 1D `curve` on a `ColorStage`), the managed
 * path decodes the incoming Rec.709 SDR code values to **linear light**, applies white
 * balance / exposure / tone / saturation there **without intermediate clamps**, and encodes
 * back to display only at the very end — so tone and saturation math no longer clips detail
 * the way the old sRGB-code-value pipeline did.
 *
 * `applyControlsLinear` operates on a single **linear** RGB triplet (already decoded by the
 * caller in `cpu.ts`). Neutral controls (`NEUTRAL_CONTROLS`) are an exact identity, which
 * the tests pin. Only the Basic-Correction controls run here; authored curves / wheels /
 * HSL / .cube LUTs stay display-referred (see `cpu.ts`).
 */

import { LUMA_WEIGHTS, type ColorControls } from "./types";
import { rec709CodeToLinear, rec709LinearToCode } from "./color-management";

export type LinRgb = [number, number, number];

/** Tuning constants — the "strength" of each control at full deflection (±100 / 0..220). */
const MAX_EXPOSURE_STOPS = 2.0; // ±100 exposure → ±2 photographic stops (was a shallow ±0.8)
const CONTRAST_RANGE = 0.6; // contrast exponent = 1 ± this at extremes, pivoted on mid-grey
// Pivot the contrast power curve on the LINEAR value of display middle-grey (0.5 code), so a
// contrast change leaves a mid-grey pixel fixed (matches NLE "contrast about the middle").
const CONTRAST_PIVOT = rec709CodeToLinear(0.5); // ≈ 0.214
const SHADOW_RANGE = 0.5; // shadows/highlights multiplicative reach on their luma mask
const HIGHLIGHT_RANGE = 0.5;
const WHITE_RANGE = 0.45; // whites gain on the highlight mask
const BLACK_LIFT = 0.06; // blacks additive lift (linear) on the shadow mask
const WB_TEMP_R = 0.5; // temperature warm/cool reach (per-channel linear gain)
const WB_TEMP_B = 0.5;
const WB_TINT_G = 0.3; // tint green/magenta reach
const WB_TINT_RB = 0.15;
const VIBRANCE_RANGE = 0.6; // vibrance saturation reach, protected on already-saturated pixels

function linLuma([r, g, b]: LinRgb): number {
  return LUMA_WEIGHTS[0] * r + LUMA_WEIGHTS[1] * g + LUMA_WEIGHTS[2] * b;
}

/** Perceptual 0..1 tone position for luma-mask shaping (display-encoded luma). */
function tonePosition(linear: number): number {
  const l = linear < 0 ? 0 : linear > 1 ? 1 : linear;
  return rec709LinearToCode(l);
}

/**
 * Apply the managed Basic-Correction controls to one **linear** RGB triplet.
 * Order follows Lumetri processing order: white balance → exposure → tone (blacks/whites,
 * shadows/highlights, contrast) → saturation/vibrance. No clamps: values may transiently
 * exceed 1 (super-white) or dip below 0; the caller clamps once at the final display encode.
 */
export function applyControlsLinear(c: ColorControls, rgb: LinRgb): LinRgb {
  let r = rgb[0];
  let g = rgb[1];
  let b = rgb[2];

  // 1. White balance (per-channel linear gain; identity at temperature=tint=0).
  if (c.temperature !== 0 || c.tint !== 0) {
    const t = c.temperature / 100;
    const ti = c.tint / 100;
    r *= (1 + WB_TEMP_R * t) * (1 + WB_TINT_RB * ti);
    g *= 1 - WB_TINT_G * ti;
    b *= (1 - WB_TEMP_B * t) * (1 + WB_TINT_RB * ti);
  }

  // 2. Exposure (linear multiply → real photographic stops).
  if (c.exposure !== 0) {
    const gain = Math.pow(2, (c.exposure / 100) * MAX_EXPOSURE_STOPS);
    r *= gain;
    g *= gain;
    b *= gain;
  }

  // 3. Tone: luminance-weighted shadow/highlight/white gains + black lift.
  if (c.shadows !== 0 || c.highlights !== 0 || c.whites !== 0 || c.blacks !== 0) {
    const p = tonePosition(linLuma([r, g, b]));
    const shadowMask = (1 - p) * (1 - p);
    const highlightMask = p * p;
    let gain = 1;
    if (c.shadows !== 0) gain *= 1 + (c.shadows / 100) * SHADOW_RANGE * shadowMask;
    if (c.highlights !== 0) gain *= 1 + (c.highlights / 100) * HIGHLIGHT_RANGE * highlightMask;
    if (c.whites !== 0) gain *= 1 + (c.whites / 100) * WHITE_RANGE * highlightMask;
    const lift = c.blacks !== 0 ? (c.blacks / 100) * BLACK_LIFT * shadowMask : 0;
    r = r * gain + lift;
    g = g * gain + lift;
    b = b * gain + lift;
  }

  // 4. Contrast: power curve pivoted on linear middle-grey (identity at contrast=0).
  if (c.contrast !== 0) {
    const k = 1 + (c.contrast / 100) * CONTRAST_RANGE;
    r = contrastChannel(r, k);
    g = contrastChannel(g, k);
    b = contrastChannel(b, k);
  }

  // 5. Saturation + vibrance (Rec.709 luma-preserving, in linear).
  if (c.saturation !== 100 || c.vibrance !== 0) {
    const l = linLuma([r, g, b]);
    let s = c.saturation / 100;
    if (c.vibrance !== 0) {
      // Estimate current saturation to protect already-saturated pixels (vibrance behavior).
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const pixelSat = mx > 1e-6 ? (mx - mn) / mx : 0;
      s += (c.vibrance / 100) * VIBRANCE_RANGE * (1 - pixelSat);
    }
    if (s < 0) s = 0;
    r = l + (r - l) * s;
    g = l + (g - l) * s;
    b = l + (b - l) * s;
  }

  return [r, g, b];
}

/** Contrast power curve around the linear middle-grey pivot; safe for non-positive input. */
function contrastChannel(v: number, k: number): number {
  if (v <= 0) return v; // preserve sign/zero; negatives are clamped at the final encode
  return CONTRAST_PIVOT * Math.pow(v / CONTRAST_PIVOT, k);
}
