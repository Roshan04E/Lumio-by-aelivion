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
 * A curve's spline coefficients, solved ONCE and then evaluated per sample.
 *
 * Splitting "solve" from "evaluate" is the whole point: the tangents depend only on the control
 * points, so recomputing them per sample is pure waste — and the samples are not few. One LUT
 * re-bake is 33³ = 35,937 pixel evaluations, each of which hits up to five hue/sat curves; the
 * old shape rebuilt (and re-allocated) the spline ~180,000 times per grade tick. Measured on this
 * machine: 163 ms per bake with one curve, 390 ms with five, all of it blocking the main thread
 * on every slider tick.
 */
interface HermiteSpline {
  x: Float64Array;
  y: Float64Array;
  /** Segment widths, length n−1. */
  h: Float64Array;
  /** Per-point tangents, length n. */
  m: Float64Array;
  n: number;
}

/**
 * Solve the Fritsch–Carlson monotone tangents for points that are ALREADY sorted ascending by x
 * with distinct x values. Point x's may lie outside [0,1] — the periodic hue path tiles them.
 */
function buildHermite(pts: CurvePoint[]): HermiteSpline {
  const n = pts.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    x[i] = pts[i]!.x;
    y[i] = pts[i]!.y;
  }
  const h = new Float64Array(Math.max(0, n - 1));
  const m = new Float64Array(n);
  if (n < 2) return { x, y, h, m, n };

  // Secant slopes between consecutive points.
  const delta = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    const dx = x[i + 1]! - x[i]!;
    h[i] = dx;
    delta[i] = (y[i + 1]! - y[i]!) / dx;
  }

  // Tangents (Fritsch–Carlson): preserve monotonicity, no overshoot.
  m[0] = delta[0]!;
  m[n - 1] = delta[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    m[i] = delta[i - 1]! * delta[i]! <= 0 ? 0 : (delta[i - 1]! + delta[i]!) / 2;
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
  return { x, y, h, m, n };
}

/**
 * Evaluate a solved spline at `x`. Only the OUTPUT is clamped to [0,1]; the query may sit
 * outside the control range (the periodic path relies on that).
 */
function evalHermite(s: HermiteSpline, x: number): number {
  const { n, x: px, y: py, h, m } = s;
  if (n === 0) return 0;
  if (n === 1) return clamp01(py[0]!);
  if (x <= px[0]!) return clamp01(py[0]!);
  if (x >= px[n - 1]!) return clamp01(py[n - 1]!);

  // Smallest segment whose upper bound reaches x — identical to the former linear scan's answer,
  // which mattered enough to preserve exactly: this function backs the pixel-comparison gate.
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (px[mid + 1]! >= x) hi = mid;
    else lo = mid + 1;
  }
  const seg = lo;
  const t = (x - px[seg]!) / h[seg]!;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const y = h00 * py[seg]! + h10 * h[seg]! * m[seg]! + h01 * py[seg + 1]! + h11 * h[seg]! * m[seg + 1]!;
  return clamp01(y);
}

/**
 * Solved splines, keyed on the control-point array's identity.
 *
 * The snapshot is not paranoia. Identity alone would go stale if any caller mutated a point in
 * place — a curve editor dragging `point.y` is exactly the kind of code that does — and a stale
 * grade is a far worse bug than a slow one. Re-verifying 2n floats costs nothing next to
 * re-solving the spline, so the cache cannot be wrong, only skipped.
 */
interface CachedSpline {
  snapshot: Float64Array;
  spline: HermiteSpline;
}
const plainSplineCache = new WeakMap<CurvePoint[], CachedSpline>();
const periodicSplineCache = new WeakMap<CurvePoint[], CachedSpline>();

function snapshotMatches(snapshot: Float64Array, points: CurvePoint[]): boolean {
  if (snapshot.length !== points.length * 2) return false;
  for (let i = 0; i < points.length; i += 1) {
    if (snapshot[i * 2] !== points[i]!.x || snapshot[i * 2 + 1] !== points[i]!.y) return false;
  }
  return true;
}

function takeSnapshot(points: CurvePoint[]): Float64Array {
  const snapshot = new Float64Array(points.length * 2);
  for (let i = 0; i < points.length; i += 1) {
    snapshot[i * 2] = points[i]!.x;
    snapshot[i * 2 + 1] = points[i]!.y;
  }
  return snapshot;
}

function cachedSpline(
  cache: WeakMap<CurvePoint[], CachedSpline>,
  points: CurvePoint[],
  solve: (points: CurvePoint[]) => HermiteSpline
): HermiteSpline {
  const hit = cache.get(points);
  if (hit && snapshotMatches(hit.snapshot, points)) return hit.spline;
  const spline = solve(points);
  cache.set(points, { snapshot: takeSnapshot(points), spline });
  return spline;
}

/**
 * Evaluate the monotonic cubic Hermite (Fritsch–Carlson) spline through `points`
 * at input `x` (0..1). Linear outside the control-point range; identity-ish when
 * fewer than 2 usable points.
 */
export function evaluateCurve(points: CurvePoint[], x: number): number {
  const spline = cachedSpline(plainSplineCache, points, (pts) => buildHermite(sanitizePoints(pts)));
  return evalHermite(spline, clamp01(x));
}

/** Wrap a value into [0,1) — for the periodic (hue) domain. */
function wrap01(v: number): number {
  const r = v - Math.floor(v);
  return r < 0 ? r + 1 : r;
}

/**
 * Evaluate a **periodic** curve (hue domain: x=0 ≡ x=1) at `x`. The control points are
 * tiled one full period on each side so the monotone-Hermite tangents are continuous
 * ACROSS the 0/1 seam — the old path mirrored a single anchor at x=last−1 / x=first+1 but
 * then ran it through `evaluateCurve`, whose `sanitizePoints` clamps x back into [0,1],
 * collapsing those anchors onto 0/1 and making hue curves jump near red. Tiling + an
 * unclamped evaluator fixes that; the editor draws with this same fn so graph == render.
 */
export function evaluatePeriodicCurve(points: CurvePoint[], x: number): number {
  const spline = cachedSpline(periodicSplineCache, points, (pts) => {
    const base = sanitizePoints(pts); // sorted asc, x/y clamped to [0,1], ≥2 points
    const shifted = (dx: number): CurvePoint[] => base.map((p) => ({ x: p.x + dx, y: p.y }));
    // Three tiled periods, then drop any point whose x coincides with the previous one
    // (a base point at exactly x=0 and the −1 tile's x=1 copy would otherwise share an x).
    const tiled = [...shifted(-1), ...base, ...shifted(1)];
    const ext: CurvePoint[] = [];
    for (const p of tiled) {
      const prev = ext[ext.length - 1];
      if (prev && Math.abs(prev.x - p.x) < 1e-6) ext[ext.length - 1] = p;
      else ext.push(p);
    }
    return buildHermite(ext);
  });
  return evalHermite(spline, wrap01(x));
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
