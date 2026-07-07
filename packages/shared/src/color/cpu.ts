/**
 * Professional Color System (Phase 3) — CPU reference applier.
 * Replays a `ColorPipeline` on a single RGB triplet (0..1 Rec.709 SDR code values).
 * This is the ground truth for `color:test` AND the baker input for the WebGL 3D LUT
 * (`bakePipelineToLut3d`), so whatever this function computes, the GPU applies identically.
 *
 * Two working modes, chosen by `pipeline.colorSettings.workingSpace`:
 *  - **`rec709-linear` (managed, default)** — Basic-Correction `stage.controls` are decoded to
 *    Rec.709 **linear light** and graded there without intermediate clamps (`applyControlsLinear`),
 *    encoding back to display only for the next display-referred stage (or the final output).
 *    Authored curves / wheels / HSL / .cube LUTs remain **display-referred** (they are authored on
 *    0..1 display graphs / code-value domains — running them through linear would distort them).
 *  - **legacy** — no `controls` on a stage → the old display-referred `matrix` then `curve` path.
 */

import type { ColorPipeline, ColorStage, ToneCurve } from "./types";
import { applyHueSatCurves, applySecondary, type HslSecondary, type HueSatCurves } from "./hsl";
import { sampleLut3d } from "./lut3d";
import { applyControlsLinear, type LinRgb } from "./managed";
import { rgbCodeToLinear, rgbLinearToCode } from "./color-management";

export type Rgb = [number, number, number];

/** An HSL stage is a secondary if it carries the keyer fields; otherwise hue/sat curves. */
function isSecondary(hsl: HueSatCurves | HslSecondary): hsl is HslSecondary {
  return "hueCenter" in hsl;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Apply a 3×4 (RGB + offset) matrix, clamping to 0..1 like the SVG primitive. */
function applyMatrix(m: number[], [r, g, b]: Rgb): Rgb {
  return [
    clamp01(m[0]! * r + m[1]! * g + m[2]! * b + m[3]!),
    clamp01(m[4]! * r + m[5]! * g + m[6]! * b + m[7]!),
    clamp01(m[8]! * r + m[9]! * g + m[10]! * b + m[11]!)
  ];
}

/** Sample a LUT at `x` (0..1) with linear interpolation — matches feFunc type="table". */
function sampleLut(table: number[], x: number): number {
  if (table.length === 0) return x;
  if (table.length === 1) return table[0]!;
  const clamped = clamp01(x);
  const pos = clamped * (table.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, table.length - 1);
  const frac = pos - lo;
  return table[lo]! + (table[hi]! - table[lo]!) * frac;
}

function applyCurve(curve: ToneCurve, [r, g, b]: Rgb): Rgb {
  return [sampleLut(curve.r, r), sampleLut(curve.g, g), sampleLut(curve.b, b)];
}

function mixRgb(a: Rgb, b: Rgb, amount: number): Rgb {
  const k = clamp01(amount);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** A stage is display-referred (curve/hsl/lut3d, or a legacy matrix without controls). */
function hasDisplayStage(stage: ColorStage): boolean {
  return Boolean(stage.matrix || stage.curve || stage.hsl || stage.lut3d);
}

/** Apply the display-referred (authored) part of a stage in Rec.709 SDR code-value space. */
function applyDisplayStage(stage: ColorStage, rgb: Rgb): Rgb {
  let out = rgb;
  if (stage.matrix) out = applyMatrix(stage.matrix, out);
  if (stage.curve) out = applyCurve(stage.curve, out);
  if (stage.hsl) out = isSecondary(stage.hsl) ? applySecondary(stage.hsl, out) : applyHueSatCurves(stage.hsl, out);
  if (stage.lut3d) out = mixRgb(out, sampleLut3d(stage.lut3d, out), stage.lutAmount ?? 1);
  return out;
}

/**
 * Apply the full pipeline to one Rec.709 SDR code-value triplet (0..1). In the managed
 * `rec709-linear` path, consecutive Basic-Correction `controls` stages are graded in a single
 * linear segment (decode once, encode once) so no super-white/black detail is clipped between
 * them; a display-referred stage forces an encode back to display and re-decode after.
 */
export function applyPipelineToRgb(pipeline: ColorPipeline, rgb: Rgb): Rgb {
  const managed = pipeline.colorSettings?.workingSpace === "rec709-linear";
  let out: Rgb = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  // Non-null while we're carrying an unclamped linear value across adjacent managed stages.
  let lin: LinRgb | null = null;

  const flushLinear = (): void => {
    if (lin) {
      out = rgbLinearToCode(lin) as Rgb; // encode (clamps to display 0..1)
      lin = null;
    }
  };

  for (const stage of pipeline.stages) {
    if (managed && stage.controls) {
      // Enter/continue the linear segment; grade in linear without clamping.
      if (!lin) lin = rgbCodeToLinear(out) as LinRgb;
      lin = applyControlsLinear(stage.controls, lin);
      continue; // matrix/curve on this stage are the SVG approximation of the same op — skip
    }
    if (hasDisplayStage(stage)) {
      flushLinear();
      out = applyDisplayStage(stage, out);
    }
  }
  flushLinear();
  return out;
}
