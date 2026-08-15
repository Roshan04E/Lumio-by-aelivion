/**
 * ADR-023 D9a — text warp as a MATTE operation: rasterize with shaping, then deform.
 *
 * The engine this replaces laid text out with `opentype.js` `getPath()` and pushed the resulting
 * bezier control points through the envelope. `getPath()` is glyph LOOKUP, not shaping: no cursive
 * joining, no contextual forms, no reordering, no mark positioning. Arabic warped to the wrong
 * glyphs, silently, from the day warp shipped — which is why S0 had to detect shaping-dependent
 * scripts and refuse warp outright (T-12), an interim this file exists to retire.
 *
 * The fix is a change of ORDER, not of maths. The text is rasterized first, by the browser, through
 * exactly the same `fillText` path every other text layer uses — so it is shaped, joined, reordered
 * and mark-positioned by Chromium's own shaper — and the envelope is then applied to the RASTER.
 * Warp stops being a thing that knows about glyphs and becomes a thing that knows about coverage,
 * which is what D10 says an operation whose input and output are both coverage should be.
 *
 * **The field is unchanged and deliberately shared.** `warpPoint` in `text-warp-mesh.ts` is the same
 * function the outline path called; this module samples it on a grid instead of at control points.
 * One field, two samplings — a warp cannot come to mean two different shapes.
 *
 * **What this gains beyond shaping**, none of it asked for and all of it falling out of the order
 * change: warped text now carries every style the unwarped path has (shadow stacks, gradient and
 * image glyph fills, per-line pills, paint order), because what is deformed is the finished raster
 * rather than a set of outlines with a fill colour. The old path returned early before any of it.
 * Multi-line warped text also works: the outline path concatenated every run into ONE line, having
 * no wrap step of its own.
 *
 * **What it costs, stated plainly:** the output is a raster, so warped text no longer has a vector
 * form. Nothing consumed one (the SVG overlay was rasterized by the browser at paint time either
 * way), and ADR-023 §6/§8 records `harfbuzzjs` as the named path if vector warped output is ever
 * scoped. Resolution is handled by supersampling from the field's own magnification, below.
 */

import type { TextWarp } from "../types";
import { normalizeTextWarp } from "../text-warp";
import { warpAmplitude, warpPoint, type WarpBounds } from "../text-warp-mesh";

/** Both the main thread's 2D context and the Worker's OffscreenCanvas 2D context. */
type Ctx = (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) & { letterSpacing?: string };
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * Grid resolution of the deformation mesh. The field is smooth (sines and parabolas over the box),
 * so the error of a piecewise-affine approximation falls with the square of the cell size; these
 * are chosen so a full-strength bend over a 1080p-wide text box has sub-pixel facet error, and they
 * are CAPPED because each cell costs two clipped `drawImage` calls and the raster is cached anyway.
 */
const MESH_COLS = 48;
const MESH_ROWS = 12;

/**
 * Triangles are inflated by this many destination px about their centroid before clipping.
 *
 * The problem it solves, and why the obvious value is wrong. Canvas anti-aliases a clip edge, so two
 * triangles meeting at a shared edge each contribute ~50% coverage there; composited over the
 * background that sums to ~75%, and the whole mesh shows up as a lattice of darker hairlines drawn
 * across the glyphs. The fix is overlap — but the overlap has to be wide enough that each
 * anti-aliased edge is covered by a neighbour's SOLID INTERIOR, not by the neighbour's own
 * anti-aliased edge, which just moves the problem.
 *
 * MEASURED on the `text-warp` fixture, because "looks about right" is how the first two values were
 * chosen and both were wrong:
 *   0     — the full triangular lattice is plainly visible over the letterforms.
 *   0.5   — lattice gone, but fine diagonal seams remain along the cell diagonals: two AA edges
 *           overlapping, double-composited rather than covered.
 *   1.5   — clean. No seam, no lattice, stroke intact.
 *
 * The cost of the overlap is that its band is drawn twice, from two cells whose affine maps differ
 * by the field's curvature over one cell — sub-pixel at this mesh resolution, which is why the
 * remedy does not smear the deformation.
 */
const SEAM_INFLATE = 1.5;

export interface WarpFieldInput {
  /** The box the envelope is defined over, in the same space as the mesh coordinates below. */
  bounds: WarpBounds;
  warp: TextWarp;
  /** From `warpAmplitude(fontSize)` — passed in so caller and callee cannot disagree about scale. */
  amp: number;
}

function sampleField(input: WarpFieldInput, cols: number, rows: number): Array<{ x: number; y: number; wx: number; wy: number }> {
  const { bounds, warp, amp } = input;
  const out: Array<{ x: number; y: number; wx: number; wy: number }> = [];
  for (let j = 0; j <= rows; j += 1) {
    const y = bounds.top + (bounds.height * j) / rows;
    for (let i = 0; i <= cols; i += 1) {
      const x = bounds.x0 + (bounds.width * i) / cols;
      const p = warpPoint(x, y, bounds, warp, amp);
      out.push({ x, y, wx: p.x, wy: p.y });
    }
  }
  return out;
}

/**
 * How far the field pushes ink OUTSIDE the text box, in px — the margin a tight-box raster needs so
 * a bend is not clipped by the box it bends out of.
 *
 * Measured from the field rather than derived from the parameters, because each style scales its
 * amplitude differently (`arc` by a parabola, `arch` by a sine, `bulge` not at all in y-translation
 * but by a vertical SCALE) and a formula per style is a list that drifts — the T-15 class. Sampling
 * the actual function cannot drift from the actual function.
 */
export function warpOverhang(input: WarpFieldInput): number {
  const { bounds } = input;
  let over = 0;
  for (const s of sampleField(input, 24, 8)) {
    over = Math.max(
      over,
      bounds.x0 - s.wx,
      s.wx - (bounds.x0 + bounds.width),
      bounds.top - s.wy,
      s.wy - (bounds.top + bounds.height)
    );
  }
  return Math.max(0, over);
}

/**
 * The field's maximum LOCAL magnification — the largest factor by which it stretches a neighbourhood.
 *
 * This is what the supersample scale is derived from, and deriving it rather than picking a constant
 * is the point (D9a scope). A fixed 2× multiplier is simultaneously wasteful for a gentle arc, which
 * magnifies nothing, and insufficient for a strong bulge or fisheye, whose centre can stretch a
 * region past 2× and would resample soft text out of a raster that had the detail before it was
 * deformed. Estimated from the mesh's own edge lengths: for each cell, the ratio of its deformed
 * edge to its source edge, in both axes. That is a finite-difference Jacobian at exactly the
 * resolution the mesh will actually be evaluated at, which is the resolution that matters.
 */
export function warpMaxMagnification(input: WarpFieldInput): number {
  const cols = 24;
  const rows = 8;
  const grid = sampleField(input, cols, rows);
  const at = (i: number, j: number) => grid[j * (cols + 1) + i]!;
  let max = 1;
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      const p = at(i, j);
      if (i < cols) {
        const q = at(i + 1, j);
        const src = Math.hypot(q.x - p.x, q.y - p.y);
        if (src > 0) max = Math.max(max, Math.hypot(q.wx - p.wx, q.wy - p.wy) / src);
      }
      if (j < rows) {
        const q = at(i, j + 1);
        const src = Math.hypot(q.x - p.x, q.y - p.y);
        if (src > 0) max = Math.max(max, Math.hypot(q.wx - p.wx, q.wy - p.wy) / src);
      }
    }
  }
  return max;
}

/**
 * Supersample factor for a warped raster: the field's magnification, bounded.
 *
 * The lower bound is 1 — a field that only translates or compresses needs no extra pixels, and
 * asking for them would cost memory for nothing. The upper bound exists because `warpMaxMagnification`
 * is a maximum over the box, so one extreme cell would otherwise size the whole canvas; past 4× the
 * remaining softness is confined to a region the eye reads as intentionally stretched anyway.
 */
export function warpSupersampleScale(input: WarpFieldInput): number {
  return Math.min(4, Math.max(1, warpMaxMagnification(input)));
}

function inflate(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number
): [number, number, number, number, number, number] {
  const gx = (ax + bx + cx) / 3;
  const gy = (ay + by + cy) / 3;
  const push = (x: number, y: number): [number, number] => {
    const dx = x - gx;
    const dy = y - gy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * SEAM_INFLATE, y + (dy / len) * SEAM_INFLATE];
  };
  const [nax, nay] = push(ax, ay);
  const [nbx, nby] = push(bx, by);
  const [ncx, ncy] = push(cx, cy);
  return [nax, nay, nbx, nby, ncx, ncy];
}

export interface WarpDeformOptions extends WarpFieldInput {
  /** The unwarped raster. Its pixel size is `boxW*srcScale` × `boxH*srcScale`. */
  source: AnyCanvas;
  /** Source raster scale (supersample × the caller's own raster scale). */
  srcScale: number;
  /**
   * Where the source raster's top-left sits, in the same box space as `bounds`. A raster carries a
   * margin for shadow/stroke overhang, so this is normally negative on both axes.
   */
  srcOriginX: number;
  srcOriginY: number;
  /** Source raster extent in box space. */
  srcWidth: number;
  srcHeight: number;
}

/**
 * Deform `source` through the field and paint it into `ctx`, whose current transform must already
 * place box-space (0,0) at the box's top-left.
 *
 * Piecewise affine over a grid: each cell's four corners are mapped through `warpPoint`, the cell is
 * split into two triangles, and each triangle is drawn as a clipped, affinely-transformed blit of
 * the corresponding source triangle. This is the only construction canvas 2D offers for a non-affine
 * warp — there is no mesh primitive and no per-pixel addressing short of `getImageData`, which would
 * be an order of magnitude slower and would have to reimplement filtering by hand.
 */
export function drawWarpedRaster(ctx: Ctx, options: WarpDeformOptions): void {
  const { source, srcScale, srcOriginX, srcOriginY, srcWidth, srcHeight, bounds, warp, amp } = options;
  if (srcWidth <= 0 || srcHeight <= 0) return;

  // Box space → source pixel space.
  const toSrcX = (x: number) => (x - srcOriginX) * srcScale;
  const toSrcY = (y: number) => (y - srcOriginY) * srcScale;

  const cols = MESH_COLS;
  const rows = MESH_ROWS;
  // The mesh spans the SOURCE raster, not the text box: the margin carries shadow and stroke ink,
  // and a mesh that covered only the box would leave that ink undeformed — or rather, undrawn, since
  // nothing outside the mesh is blitted at all. The FIELD is still defined over the text box (that
  // is what `bounds` is), so ink in the margin is carried by the field's continuation past the box
  // edge, which is what the outline path did too.
  for (let j = 0; j < rows; j += 1) {
    const y0 = srcOriginY + (srcHeight * j) / rows;
    const y1 = srcOriginY + (srcHeight * (j + 1)) / rows;
    for (let i = 0; i < cols; i += 1) {
      const x0 = srcOriginX + (srcWidth * i) / cols;
      const x1 = srcOriginX + (srcWidth * (i + 1)) / cols;

      const p00 = warpPoint(x0, y0, bounds, warp, amp);
      const p10 = warpPoint(x1, y0, bounds, warp, amp);
      const p11 = warpPoint(x1, y1, bounds, warp, amp);
      const p01 = warpPoint(x0, y1, bounds, warp, amp);

      const s00x = toSrcX(x0);
      const s00y = toSrcY(y0);
      const s10x = toSrcX(x1);
      const s11y = toSrcY(y1);

      blitTriangle(ctx, source, s00x, s00y, s10x, s00y, s10x, s11y, p00, p10, p11);
      blitTriangle(ctx, source, s00x, s00y, s10x, s11y, s00x, s11y, p00, p11, p01);
    }
  }
}

function blitTriangle(
  ctx: Ctx,
  source: AnyCanvas,
  u0: number, v0: number,
  u1: number, v1: number,
  u2: number, v2: number,
  d0: { x: number; y: number },
  d1: { x: number; y: number },
  d2: { x: number; y: number }
): void {
  const den = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (!den) return; // degenerate source triangle — nothing to sample

  const a = ((d1.x - d0.x) * (v2 - v0) - (d2.x - d0.x) * (v1 - v0)) / den;
  const b = ((d1.y - d0.y) * (v2 - v0) - (d2.y - d0.y) * (v1 - v0)) / den;
  const c = ((d2.x - d0.x) * (u1 - u0) - (d1.x - d0.x) * (u2 - u0)) / den;
  const d = ((d2.y - d0.y) * (u1 - u0) - (d1.y - d0.y) * (u2 - u0)) / den;
  const e = d0.x - a * u0 - c * v0;
  const f = d0.y - b * u0 - d * v0;
  if (![a, b, c, d, e, f].every(Number.isFinite)) return;

  const [ax, ay, bx, by, cx, cy] = inflate(d0.x, d0.y, d1.x, d1.y, d2.x, d2.y);

  ctx.save();
  // The clip is defined in DESTINATION space, before the source-space transform is applied — the two
  // must not be composed or the clip would be warped a second time.
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(source as CanvasImageSource, 0, 0);
  ctx.restore();
}

/** Convenience: the field a text box of `boxW`×`boxH` at `fontSize` warps under. */
export function textWarpField(warp: TextWarp | undefined, boxW: number, boxH: number, fontSize: number): WarpFieldInput {
  const normalized = normalizeTextWarp(warp);
  return {
    bounds: { x0: -boxW / 2, width: boxW, top: -boxH / 2, height: boxH, baseline: 0 },
    warp: normalized,
    amp: warpAmplitude(fontSize)
  };
}
