/**
 * Bit-identity check: the memoized spline evaluator vs. a verbatim copy of the OLD one.
 * The refactor is only legitimate if every sample is EXACTLY equal (===, not approx) —
 * curve.ts backs render:compare:pixels, where a 1-ULP drift becomes a diff pixel.
 */
import { evaluateCurve, evaluatePeriodicCurve, type CurvePoint } from "../../packages/shared/src/color/curve";

/* ---------------- verbatim pre-refactor implementation ---------------- */
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function identityCurvePoints(): CurvePoint[] {
  return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
}
function sanitizePoints(points: CurvePoint[] | undefined): CurvePoint[] {
  if (!points || points.length === 0) return identityCurvePoints();
  const cleaned = points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })).sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const point of cleaned) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - point.x) < 1e-6) out[out.length - 1] = point;
    else out.push(point);
  }
  return out.length >= 2 ? out : identityCurvePoints();
}
function oldEvaluateHermite(pts: CurvePoint[], x: number): number {
  const n = pts.length;
  if (n === 0) return 0;
  if (n === 1) return clamp01(pts[0]!.y);
  if (x <= pts[0]!.x) return clamp01(pts[0]!.y);
  if (x >= pts[n - 1]!.x) return clamp01(pts[n - 1]!.y);
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = pts[i + 1]!.x - pts[i]!.x;
    h.push(dx);
    delta.push((pts[i + 1]!.y - pts[i]!.y) / dx);
  }
  const m: number[] = new Array(n).fill(0);
  m[0] = delta[0]!;
  m[n - 1] = delta[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    if (delta[i - 1]! * delta[i]! <= 0) m[i] = 0;
    else m[i] = (delta[i - 1]! + delta[i]!) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i]! / delta[i]!;
    const b = m[i + 1]! / delta[i]!;
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * delta[i]!; m[i + 1] = t * b * delta[i]!; }
  }
  let seg = 0;
  for (let i = 0; i < n - 1; i += 1) {
    if (x >= pts[i]!.x && x <= pts[i + 1]!.x) { seg = i; break; }
  }
  const t = (x - pts[seg]!.x) / h[seg]!;
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return clamp01(h00 * pts[seg]!.y + h10 * h[seg]! * m[seg]! + h01 * pts[seg + 1]!.y + h11 * h[seg]! * m[seg + 1]!);
}
const oldEvaluateCurve = (points: CurvePoint[], x: number) => oldEvaluateHermite(sanitizePoints(points), clamp01(x));
const wrap01 = (v: number) => { const r = v - Math.floor(v); return r < 0 ? r + 1 : r; };
function oldEvaluatePeriodicCurve(points: CurvePoint[], x: number): number {
  const base = sanitizePoints(points);
  const shifted = (dx: number) => base.map((p) => ({ x: p.x + dx, y: p.y }));
  const tiled = [...shifted(-1), ...base, ...shifted(1)];
  const ext: CurvePoint[] = [];
  for (const p of tiled) {
    const prev = ext[ext.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 1e-6) ext[ext.length - 1] = p;
    else ext.push(p);
  }
  return oldEvaluateHermite(ext, wrap01(x));
}

/* ---------------- randomized + adversarial comparison ---------------- */
let seed = 0x2f6e2b1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };

const curves: CurvePoint[][] = [
  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
  [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }],
  [{ x: 0, y: 1 }, { x: 1, y: 0 }],                                  // decreasing
  [{ x: 0, y: 0.3 }, { x: 0.4, y: 0.3 }, { x: 1, y: 0.9 }],          // flat segment (delta === 0)
  [{ x: 0.2, y: 0.1 }, { x: 0.2000001, y: 0.9 }, { x: 1, y: 1 }],    // near-duplicate x
  [{ x: 1, y: 0.2 }, { x: 0, y: 0.8 }, { x: 0.5, y: 0.4 }],          // unsorted
  [{ x: -0.3, y: 1.4 }, { x: 0.5, y: -0.2 }, { x: 1.8, y: 0.6 }],    // out of range
  [{ x: 0, y: 0.5 }],                                                 // single point
  [],                                                                 // empty
  [{ x: 0, y: 0 }, { x: 0.02, y: 0.9 }, { x: 0.04, y: 0.1 }, { x: 1, y: 1 }] // steep (tangent limiter)
];
for (let c = 0; c < 40; c += 1) {
  const n = 2 + Math.floor(rnd() * 7);
  const pts: CurvePoint[] = [];
  for (let i = 0; i < n; i += 1) pts.push({ x: rnd(), y: rnd() });
  curves.push(pts);
}

// Every control-point x is a boundary — exactly where a binary search could pick a different segment.
const xs: number[] = [];
for (let i = 0; i <= 4096; i += 1) xs.push(i / 4096);
for (const extra of [-0.5, -1e-9, 1 + 1e-9, 1.5, 2, 1 / 3, 1 / 7]) xs.push(extra);

let checked = 0;
let worst = 0;
const fail: string[] = [];
for (const pts of curves) {
  const boundaries = pts.map((p) => p.x);
  for (const x of [...xs, ...boundaries, ...boundaries.map((b) => b + 1e-12)]) {
    for (const periodic of [false, true]) {
      const a = periodic ? oldEvaluatePeriodicCurve(pts, x) : oldEvaluateCurve(pts, x);
      const b = periodic ? evaluatePeriodicCurve(pts, x) : evaluateCurve(pts, x);
      checked += 1;
      if (!Object.is(a, b)) {
        worst = Math.max(worst, Math.abs(a - b));
        if (fail.length < 5) fail.push(`periodic=${periodic} x=${x} old=${a} new=${b} pts=${JSON.stringify(pts)}`);
      }
    }
  }
}

// Mutation safety: the cache is keyed on array identity, so an in-place edit MUST be seen.
const live: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 1 }];
const before = evaluateCurve(live, 0.5);
live[1]!.y = 0.9; // mutate in place, same array reference
const after = evaluateCurve(live, 0.5);
const mutationSeen = before !== after && Object.is(after, oldEvaluateCurve(live, 0.5));

console.log(`compared ${checked} samples across ${curves.length} curves`);
console.log(fail.length === 0 ? "EXACT MATCH — every sample bit-identical" : `MISMATCH (${fail.length} shown, worst |Δ| ${worst})`);
for (const f of fail) console.log("  " + f);
console.log(mutationSeen ? "in-place point mutation observed (cache not stale)" : "STALE CACHE — in-place mutation missed");
process.exit(fail.length === 0 && mutationSeen ? 0 : 1);
