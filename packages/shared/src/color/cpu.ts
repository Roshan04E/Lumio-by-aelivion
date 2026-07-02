/**
 * Professional Color System (Phase 3) — CPU reference applier.
 * Replays a `ColorPipeline` on a single RGB triplet (0..1, in the pipeline's space).
 * This is the ground truth for `color:test` and the fallback for any non-DOM render
 * path (e.g. a Remotion env without GL once the WebGL phases land). It MUST mirror the
 * SVG emitter's math: matrix first (clamped), then per-channel tone-curve lookup.
 */

import type { ColorPipeline, ToneCurve } from "./types";
import { applyHueSatCurves, applySecondary, type HslSecondary, type HueSatCurves } from "./hsl";
import { sampleLut3d } from "./lut3d";

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

/** Apply the full pipeline to one RGB triplet (0..1). */
export function applyPipelineToRgb(pipeline: ColorPipeline, rgb: Rgb): Rgb {
  let out: Rgb = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  for (const stage of pipeline.stages) {
    if (stage.matrix) {
      out = applyMatrix(stage.matrix, out);
    }
    if (stage.curve) {
      out = applyCurve(stage.curve, out);
    }
    if (stage.hsl) {
      out = isSecondary(stage.hsl) ? applySecondary(stage.hsl, out) : applyHueSatCurves(stage.hsl, out);
    }
    if (stage.lut3d) {
      out = mixRgb(out, sampleLut3d(stage.lut3d, out), stage.lutAmount ?? 1);
    }
  }
  return out;
}
