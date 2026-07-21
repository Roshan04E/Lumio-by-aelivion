/**
 * Professional Color System (Phase 3) — HSL-domain operations (13C.3).
 * Lumetri-style **Hue/Saturation curves** and the **HSL Secondary** keyer. These are
 * cross-channel, per-pixel RGB→RGB functions (operate in HSL, return RGB), so — unlike
 * the matrix + 1D-curve stages — SVG can't express them. They ride in the SAME pipeline
 * and get baked into the float 3D LUT (`applyPipelineToRgb` → `bakePipelineToLut3d`), so
 * the WebGL preview and export apply them identically; the SVG path simply omits them
 * (which is why the WebGL engine is the default backbone for color).
 *
 * Curve convention: the domain (hue / luma / sat) is the x axis; **neutral is a flat line
 * at y = 0.5** (NOT the tone-curve diagonal). y above 0.5 pushes positive, below pulls
 * negative. Hue-domain curves wrap periodically (red at 0 == red at 1). We sample the
 * PCHIP spline from `curve.ts` so the editor's drawn path and the renderer's LUT agree.
 */

import { evaluateCurve, evaluatePeriodicCurve, type CurvePoint } from "./curve";

/* ------------------------------------------------------------------ sRGB ↔ HSL */

// Local alias; the canonical exported `Rgb` lives in cpu.ts (same shape).
type Rgb = [number, number, number];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Wrap a value into [0,1) — used for periodic hue. */
function wrap01(v: number): number {
  const r = v - Math.floor(v);
  return r < 0 ? r + 1 : r;
}

/** sRGB (0..1) → HSL (h,s,l all 0..1). Standard HSL; h is undefined-as-0 for grays. */
export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return [wrap01(h), clamp01(s), clamp01(l)];
}

function hue2rgb(p: number, q: number, t: number): number {
  const tt = wrap01(t);
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

/** HSL (0..1) → sRGB (0..1). Inverse of `rgbToHsl`. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s < 1e-9) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [clamp01(hue2rgb(p, q, h + 1 / 3)), clamp01(hue2rgb(p, q, h)), clamp01(hue2rgb(p, q, h - 1 / 3))];
}

/* ----------------------------------------------------------------- Hue/Sat curves */

/**
 * The five Lumetri hue/sat curves. Each is a list of control points over its domain
 * (x), with y measured from a 0.5 neutral baseline. Absent / flat-at-0.5 == no change.
 *  - hueVsHue  : domain hue  → hue shift      (periodic)
 *  - hueVsSat  : domain hue  → saturation gain (periodic)
 *  - hueVsLuma : domain hue  → luma gain        (periodic)
 *  - lumaVsSat : domain luma → saturation gain
 *  - satVsSat  : domain sat  → saturation gain
 */
export interface HueSatCurves {
  hueVsHue?: CurvePoint[] | undefined;
  hueVsSat?: CurvePoint[] | undefined;
  hueVsLuma?: CurvePoint[] | undefined;
  lumaVsSat?: CurvePoint[] | undefined;
  satVsSat?: CurvePoint[] | undefined;
}

/** Max hue rotation at a full-deflection (y=1 → +0.5 turn = +180°, y=0 → −180°). */
const HUE_SHIFT_RANGE = 1.0;
/** Sat/luma gain mapping: y=0.5→1×, y=1→×4, y=0→×0.25 (exponential, symmetric). */
function gain(y: number): number {
  return Math.pow(2, (y - 0.5) * 4);
}

function isFlatHalf(points: CurvePoint[] | undefined): boolean {
  if (!points || points.length === 0) return true;
  return points.every((p) => Math.abs(p.y - 0.5) < 1e-4);
}

export function hueSatCurvesAreIdentity(c: HueSatCurves): boolean {
  return (
    isFlatHalf(c.hueVsHue) &&
    isFlatHalf(c.hueVsSat) &&
    isFlatHalf(c.hueVsLuma) &&
    isFlatHalf(c.lumaVsSat) &&
    isFlatHalf(c.satVsSat)
  );
}

/** Default neutral points for a hue/sat curve: a flat line at 0.5. */
export function neutralHueCurvePoints(): CurvePoint[] {
  return [
    { x: 0, y: 0.5 },
    { x: 1, y: 0.5 }
  ];
}

/**
 * Evaluate a curve at `x`, treating a flat/absent curve as the 0.5 neutral. `periodic`
 * extends the control points across the 0/1 seam so hue curves wrap continuously.
 */
function evalCurveAt(points: CurvePoint[] | undefined, x: number, periodic: boolean): number {
  if (!points || points.length === 0) return 0.5;
  if (points.length === 1) return clamp01(points[0]!.y);
  // Periodic hue domain: `evaluatePeriodicCurve` tiles the control points a full period on
  // each side and evaluates WITHOUT clamping x to [0,1], so the spline is continuous across
  // the red seam (hue 0 ≡ hue 1). The old inline extension routed through `evaluateCurve`,
  // whose sanitize clamps x back into [0,1] and collapsed the wrap anchors onto 0/1 —
  // discarding the seam's own control value and making hue curves jump. See curve.ts.
  return periodic ? evaluatePeriodicCurve(points, x) : evaluateCurve(points, x);
}

/**
 * Public sampler for one hue/sat curve at `x` (the editor draws with this exact fn so the
 * graph matches the render). `periodic` wraps the 0/1 seam (hue-domain curves). Absent /
 * single-point curves behave as the engine does (0.5 neutral / constant).
 */
export function sampleHueSatCurve(points: CurvePoint[] | undefined, x: number, periodic: boolean): number {
  return evalCurveAt(points, x, periodic);
}

/** Apply the hue/sat curves to one RGB triplet (0..1). */
export function applyHueSatCurves(c: HueSatCurves, rgb: Rgb): Rgb {
  const [h0, s0, l0] = rgbToHsl(rgb);

  const hueShift = c.hueVsHue ? (evalCurveAt(c.hueVsHue, h0, true) - 0.5) * HUE_SHIFT_RANGE : 0;

  let satMul = 1;
  if (c.hueVsSat) satMul *= gain(evalCurveAt(c.hueVsSat, h0, true));
  if (c.lumaVsSat) satMul *= gain(evalCurveAt(c.lumaVsSat, l0, false));
  if (c.satVsSat) satMul *= gain(evalCurveAt(c.satVsSat, s0, false));

  const lumMul = c.hueVsLuma ? gain(evalCurveAt(c.hueVsLuma, h0, true)) : 1;

  const h = wrap01(h0 + hueShift);
  const s = clamp01(s0 * satMul);
  const l = clamp01(l0 * lumMul);
  return hslToRgb(h, s, l);
}

/* --------------------------------------------------------------- HSL Secondary */

/**
 * HSL Secondary keyer + correction. The key selects pixels by hue / saturation / luma
 * band (each with a soft feather); the correction (hue shift + sat/luma gain) is applied
 * scaled by the key value. `showMask` is an editor-only display flag (renders the key as a
 * grayscale matte) — handled by the WebGL view, ignored by export.
 */
export interface HslSecondary {
  hueCenter: number; // 0..1
  hueWidth: number; // half-width, 0..0.5 (0.5 = whole circle)
  satMin: number; // 0..1
  satMax: number; // 0..1
  lumMin: number; // 0..1
  lumMax: number; // 0..1
  softness: number; // 0..1 feather applied to every edge
  invert: boolean;
  hueShift: number; // -0.5..0.5 (turns)
  satScale: number; // 0..2 (1 = neutral)
  lumScale: number; // 0..2 (1 = neutral)
  showMask: boolean;
}

export const NEUTRAL_SECONDARY: HslSecondary = {
  hueCenter: 0,
  hueWidth: 0.5,
  satMin: 0,
  satMax: 1,
  lumMin: 0,
  lumMax: 1,
  softness: 0.1,
  invert: false,
  hueShift: 0,
  satScale: 1,
  lumScale: 1,
  showMask: false
};

/**
 * True when the secondary's CORRECTION is neutral (no grade stage needed). `showMask` is
 * intentionally NOT considered here — a show-mask-only secondary contributes no grade
 * stage but still surfaces a `previewMatte` (handled by the pipeline compiler).
 */
export function secondaryIsIdentity(s: HslSecondary): boolean {
  return Math.abs(s.hueShift) < 1e-4 && Math.abs(s.satScale - 1) < 1e-4 && Math.abs(s.lumScale - 1) < 1e-4;
}

/** Shortest distance between two hues on the unit circle (0..0.5). */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(wrap01(a) - wrap01(b));
  return d > 0.5 ? 1 - d : d;
}

/** smoothstep 0..1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Feathered membership of `v` inside [min,max] with `soft` falloff outside the band. */
function bandMembership(v: number, min: number, max: number, soft: number): number {
  const f = Math.max(1e-4, soft);
  const rising = smoothstep(min - f, min + f, v);
  const falling = 1 - smoothstep(max - f, max + f, v);
  return clamp01(Math.min(rising, falling));
}

/** Key value (0..1) for one pixel — the matte the secondary correction is scaled by. */
export function secondaryKey(s: HslSecondary, rgb: Rgb): number {
  const [h, sat, lum] = rgbToHsl(rgb);
  const f = Math.max(1e-4, s.softness);
  // Hue: distance from center within the half-width, feathered.
  const hueKey = s.hueWidth >= 0.5 ? 1 : 1 - smoothstep(s.hueWidth - f * 0.5, s.hueWidth + f * 0.5, hueDistance(h, s.hueCenter));
  const satKey = bandMembership(sat, s.satMin, s.satMax, f);
  const lumKey = bandMembership(lum, s.lumMin, s.lumMax, f);
  let key = clamp01(hueKey * satKey * lumKey);
  if (s.invert) key = 1 - key;
  return key;
}

/** Apply the secondary correction to one RGB triplet (0..1). */
export function applySecondary(s: HslSecondary, rgb: Rgb): Rgb {
  const key = secondaryKey(s, rgb);
  if (key < 1e-5) return rgb;
  const [h, sat, lum] = rgbToHsl(rgb);
  const nh = wrap01(h + s.hueShift * key);
  const ns = clamp01(sat * (1 + (s.satScale - 1) * key));
  const nl = clamp01(lum * (1 + (s.lumScale - 1) * key));
  return hslToRgb(nh, ns, nl);
}
