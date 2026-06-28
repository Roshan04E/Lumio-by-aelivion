/**
 * Professional Color System (Phase 3) — curve math (13C.1).
 * Real graph curves: the user drags control points; we interpolate a smooth,
 * **monotonic** curve through them (PCHIP / Fritsch–Carlson) so the tone response
 * never overshoots or wiggles between points — the behavior pro curve editors give.
 * The SAME sampler drives the editor's drawn path and the renderer's LUT, so what
 * you see is what renders.
 */

import { TONE_LUT_SIZE, type ToneCurve } from "./types";

export interface CurvePoint {
  /** Input level, 0..1. */
  x: number;
  /** Output level, 0..1. */
  y: number;
}

/** Per-channel control points. Missing/short channels = identity (no change). */
export interface ChannelCurves {
  master?: CurvePoint[] | undefined;
  red?: CurvePoint[] | undefined;
  green?: CurvePoint[] | undefined;
  blue?: CurvePoint[] | undefined;
}

/** The default identity curve: a straight line from black to white. */
export function identityCurvePoints(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 }
  ];
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Sort, clamp, and de-duplicate control points by x so interpolation is well-posed. */
function sanitizePoints(points: CurvePoint[] | undefined): CurvePoint[] {
  if (!points || points.length === 0) {
    return identityCurvePoints();
  }
  const cleaned = points
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const point of cleaned) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - point.x) < 1e-6) {
      out[out.length - 1] = point; // later point wins on an x collision
    } else {
      out.push(point);
    }
  }
  return out.length >= 2 ? out : identityCurvePoints();
}

/**
 * Evaluate the monotonic cubic Hermite (Fritsch–Carlson) spline through `points`
 * at input `x` (0..1). Linear outside the control-point range; identity-ish when
 * fewer than 2 usable points.
 */
export function evaluateCurve(points: CurvePoint[], x: number): number {
  const pts = sanitizePoints(points);
  const n = pts.length;
  const xi = clamp01(x);

  if (xi <= pts[0]!.x) return pts[0]!.y;
  if (xi >= pts[n - 1]!.x) return pts[n - 1]!.y;

  // Secant slopes between consecutive points.
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = pts[i + 1]!.x - pts[i]!.x;
    h.push(dx);
    delta.push((pts[i + 1]!.y - pts[i]!.y) / dx);
  }

  // Tangents (Fritsch–Carlson): preserve monotonicity, no overshoot.
  const m: number[] = new Array(n).fill(0);
  m[0] = delta[0]!;
  m[n - 1] = delta[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    if (delta[i - 1]! * delta[i]! <= 0) {
      m[i] = 0;
    } else {
      m[i] = (delta[i - 1]! + delta[i]!) / 2;
    }
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / delta[i]!;
    const b = m[i + 1]! / delta[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * delta[i]!;
      m[i + 1] = t * b * delta[i]!;
    }
  }

  // Find the segment containing xi and evaluate the Hermite basis.
  let seg = 0;
  for (let i = 0; i < n - 1; i += 1) {
    if (xi >= pts[i]!.x && xi <= pts[i + 1]!.x) {
      seg = i;
      break;
    }
  }
  const t = (xi - pts[seg]!.x) / h[seg]!;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const y = h00 * pts[seg]!.y + h10 * h[seg]! * m[seg]! + h01 * pts[seg + 1]!.y + h11 * h[seg]! * m[seg + 1]!;
  return clamp01(y);
}

/** Sample a curve into a `size`-entry LUT (0..1 → 0..1). */
export function curvePointsToLut(points: CurvePoint[] | undefined, size = TONE_LUT_SIZE): number[] {
  const pts = sanitizePoints(points);
  const lut = new Array<number>(size);
  for (let i = 0; i < size; i += 1) {
    lut[i] = evaluateCurve(pts, i / (size - 1));
  }
  return lut;
}

/** True when a channel's points are absent or an exact identity line. */
function isIdentityChannel(points: CurvePoint[] | undefined): boolean {
  if (!points || points.length < 2) return true;
  const pts = sanitizePoints(points);
  return pts.every((p) => Math.abs(p.x - p.y) < 1e-6) && pts[0]!.x === 0 && pts[pts.length - 1]!.x === 1 && pts.length === 2;
}

/** True when every channel is identity (so the whole curves effect is a no-op). */
export function channelCurvesAreIdentity(curves: ChannelCurves): boolean {
  return (
    isIdentityChannel(curves.master) &&
    isIdentityChannel(curves.red) &&
    isIdentityChannel(curves.green) &&
    isIdentityChannel(curves.blue)
  );
}

/**
 * Build a per-channel `ToneCurve` from control points. The master curve is applied
 * first (to all channels), then each per-channel curve composes on top — matching
 * the Lumetri/Resolve "master + RGB" curve model: `out_c = curve_c(master(x))`.
 */
export function channelCurvesToToneCurve(curves: ChannelCurves, size = TONE_LUT_SIZE): ToneCurve {
  const master = curvePointsToLut(curves.master, size);
  const buildChannel = (channel: CurvePoint[] | undefined): number[] => {
    const channelLut = curvePointsToLut(channel, size);
    // Compose: sample the channel curve at the master's output.
    return master.map((mv) => {
      const pos = clamp01(mv) * (size - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, size - 1);
      return channelLut[lo]! + (channelLut[hi]! - channelLut[lo]!) * (pos - lo);
    });
  };
  return { r: buildChannel(curves.red), g: buildChannel(curves.green), b: buildChannel(curves.blue) };
}
