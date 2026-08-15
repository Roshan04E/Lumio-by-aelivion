import type { TextWarp, TextWarpStyle } from "./types";
import { normalizeTextWarp } from "./text-warp";

/**
 * Pure envelope-mesh math for text warp — no opentype/DOM dependency so it stays
 * unit-testable and runs identically in the web preview and Remotion.
 *
 * The Photoshop/Illustrator model, applied to COVERAGE rather than to outlines (ADR-023 D9a): the
 * text is rasterized by the browser, with the browser's shaping, and `scene/text-warp-deform.ts`
 * samples the envelope below on a grid to deform that raster. Until D9a this field was sampled at
 * `opentype.js` bezier control points instead, which is why warp could not handle a script that
 * needs shaping — the geometry here was never the problem, the stage it ran at was.
 */

export type PathCommandType = "M" | "L" | "C" | "Q" | "Z";

/** opentype.js-compatible path command (absolute coords, y-down). */
export interface PathCommand {
  type: PathCommandType;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

/** Local box the outline occupies, in the same coord space as the commands. */
export interface WarpBounds {
  x0: number;
  width: number;
  top: number;
  height: number;
  /** baseline y (where v == ascent fraction). */
  baseline: number;
}

const TWO_PI = Math.PI * 2;

/** Parabola peaking at the centre (1 at u=0.5, 0 at the ends). */
function peak(u: number): number {
  const c = 2 * u - 1;
  return 1 - c * c;
}

/**
 * Maps a single point through the warp envelope. `u` is the normalized horizontal
 * position (0..1), `v` the normalized vertical position (0=top, 1=bottom), and the
 * returned offsets are in px relative to the input point.
 */
function envelope(
  style: TextWarpStyle,
  u: number,
  v: number,
  amp: number,
  bend: number,
  vSigned: number
): { dx: number; dy: number; sx: number; sy: number } {
  // dx/dy = translation; sx/sy = scale about the box centre (1 = no scale).
  let dx = 0;
  let dy = 0;
  let sx = 1;
  let sy = 1;
  const A = amp * bend;

  switch (style) {
    case "arc":
      // Whole block bends; glyphs stay upright (top + bottom edges curve together).
      dy = -A * peak(u);
      break;
    case "arcLower":
      // Only the lower edge curves (weight by distance below the top).
      dy = -A * peak(u) * v;
      break;
    case "arch": {
      // Rounder bridge shape (sine rather than parabola), bends both edges.
      dy = -A * Math.sin(Math.PI * u);
      break;
    }
    case "bulge":
      // Edges bow apart in the middle -> mid glyphs grow taller (vertical scale).
      sy = 1 + bend * 0.85 * peak(u);
      break;
    case "wave":
      // Baseline follows a full sine S-curve.
      dy = -A * Math.sin(TWO_PI * u);
      break;
    case "flag":
      // Wave whose amplitude grows toward the trailing edge.
      dy = -A * Math.sin(TWO_PI * u) * u;
      break;
    case "fisheye":
      // Radial magnification at the centre: spread x outward + grow y in the middle.
      sy = 1 + bend * 0.7 * peak(u);
      dx = bend * amp * 0.5 * (2 * u - 1) * peak(u);
      break;
    case "none":
    default:
      break;
  }
  // vSigned is consumed by the distortion stage (kept in signature for clarity).
  void vSigned;
  return { dx, dy, sx, sy };
}

/**
 * Amplitude convention, shared so every consumer of the field agrees on its scale. Font-relative so
 * a bend reads the same across sizes.
 */
export function warpAmplitude(fontSize: number): number {
  return fontSize * 0.9;
}

/**
 * The deformation field itself: box space → warped box space. Exported as of D9a because it now has
 * a second consumer — the rasterize-then-deform path pushes a MESH through the same function the
 * outline path used to push bezier control points through. That is the whole point of the rework:
 * one field, two samplings of it, so a warp cannot mean two different shapes.
 */
export function warpPoint(x: number, y: number, b: WarpBounds, warp: TextWarp, amp: number): { x: number; y: number } {
  const width = b.width || 1;
  const height = b.height || 1;
  const u = (x - b.x0) / width;
  const v = (y - b.top) / height;
  const yMid = b.top + height / 2;
  const xMid = b.x0 + width / 2;
  const vSigned = (y - yMid) / (height / 2);
  const uSigned = 2 * u - 1;

  const bend = warp.bend / 100;
  const dh = warp.distortH / 100;
  const dv = warp.distortV / 100;

  const env = envelope(warp.style, u, v, amp, bend, vSigned);

  // Style envelope: scale about the box centre, then translate.
  let nx = xMid + (x - xMid) * env.sx + env.dx;
  let ny = yMid + (y - yMid) * env.sy + env.dy;

  // Horizontal distortion: perspective trapezoid — horizontal spread varies with v.
  if (dh !== 0) {
    nx = xMid + (nx - xMid) * (1 + dh * vSigned);
  }
  // Vertical distortion: perspective trapezoid — vertical stretch varies with u.
  if (dv !== 0) {
    ny = yMid + (ny - yMid) * (1 + dv * uSigned);
  }

  return { x: nx, y: ny };
}

/**
 * ADR-023 D9a (2026-08-15): `warpPathCommands` lived here — it pushed opentype.js bezier control
 * points through the field above and serialized an SVG path `d`. Deleted with the outline engine
 * that fed it. The FIELD is untouched and is now sampled on a grid by `scene/text-warp-deform.ts`
 * instead, which is the whole of the D9a change: same geometry, applied after shaping rather than
 * instead of it.
 *
 * `PathCommand` stays exported because `font-outlines.ts` still describes opentype.js's `getPath`
 * signature for D2's name-table ingest parse.
 */
