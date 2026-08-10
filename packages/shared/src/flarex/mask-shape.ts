/**
 * Flarex mask-node OUTLINE: the payload format, and the one place it is resolved to a shape at a time.
 *
 * `polygonMask`/`bezierMask` store their outline in node params as JSON, because Flarex node params are
 * a flat `Record<string, string | number | boolean>` (node-defs' own constraint) and an outline is
 * neither a number nor a boolean. Two params carry it:
 *
 *   points          — the BASE outline. Comp fractions (0..1).
 *   shapeKeyframes  — optional outline ANIMATION: snapshots of the same point form at times.
 *
 * ── Why this module exists rather than a second evaluator ───────────────────────────────────────────
 * The app already animates mask outlines, correctly, for CLIP masks: `MaskPathKeyframe` +
 * `getMaskPathAtTime` (clip-masks.ts) interpolate point-for-point INCLUDING tangents, and hold when the
 * point counts differ. That evaluator ships and runs in production. This module does not reimplement any
 * of it — it parses the node's param form, builds the `Mask` the shared evaluator already understands,
 * and calls `getMaskPathAtTime`. One evaluator, two callers (the compiler and the editor's overlay
 * bridge), which is also what stops the preview and the export from resolving the same outline two
 * slightly different ways.
 *
 * ── The point form, and why both shapes are accepted ────────────────────────────────────────────────
 *   [x, y]                              — a corner. What every comp saved before this slice contains.
 *   [x, y, inX, inY, outX, outY]        — a corner plus its two bezier control handles, as DELTAS from
 *                                         the point, in comp fractions like the point itself.
 * Both are read; the 2-tuple is written back whenever a point has no tangents, so a polygon-only comp
 * round-trips byte-identical through this module and does not grow a payload it does not use.
 *
 * Tangents were previously DISCARDED on commit (`flarex-mask-bridge.ts` said so in its own header): the
 * rasterizer has always drawn cubics when a point carries handles (`maskShapeToPathD`), so a `bezierMask`
 * curved but could not be AUTHORED curved. The 6-tuple is what closes that.
 *
 * ── Time ───────────────────────────────────────────────────────────────────────────────────────────
 * Callers pass the EVALUATION time, not the frame time. Inside a TimeSpeed subtree those differ, and a
 * matte resolved on the playhead while its image comes from another moment is exactly the drift T4
 * (slice S6.1) removed from `rasterizeMatte`. The compiler passes `at` for the same reason.
 *
 * ── Known cost, stated rather than discovered ──────────────────────────────────────────────────────
 * `resolveFlarexShapeAtTime` re-parses both payloads on every frame. For a STATIC outline that is what
 * the compiler already did (one `JSON.parse` of `points`) plus an empty-string test, so nothing
 * regresses for the common case. For an animated one it also parses the whole track each frame, which
 * grows with key count — a heavily-keyed roto pays for keys it is nowhere near. Acceptable here because
 * the shape it produces is then keyed by geometry in `SceneMaskMatteCache` (so the expensive part, the
 * canvas raster, still only runs when the outline actually changed), and because the profiler's
 * `compile.*` counters make it visible if it ever matters. The fix, if it does, is a parse memo on
 * `(nodeId, raw)` — not a second evaluator.
 */

import { getMaskPathAtTime } from "../clip-masks";
import type { KeyframeInterpolation, Mask, MaskPathKeyframe, MaskPoint } from "../types";

/** A point as stored in node params: corner only, or corner + in/out tangent deltas. */
export type FlarexShapePoint = [number, number] | [number, number, number, number, number, number];

/** One outline snapshot at a comp-local time. `e` (easing) is optional; absent reads as linear. */
interface RawShapeKeyframe {
  t: number;
  p: FlarexShapePoint[];
  e?: string | undefined;
}

/** The default outline per node type — the shape a fresh node shows, and the soft-fail target for a
 *  malformed payload. Mirrors the Zod defaults in `node-defs.ts`; kept here because the compiler, the
 *  editor bridge and the parser all need the same fallback and only one of them owns the schema. */
export const FLAREX_DEFAULT_MASK_POINTS: Record<"polygonMask" | "bezierMask", FlarexShapePoint[]> = {
  polygonMask: [[0.3, 0.2], [0.7, 0.2], [0.5, 0.85]],
  bezierMask: [[0.25, 0.2], [0.75, 0.25], [0.7, 0.8], [0.3, 0.75]],
};

/**
 * Two shape keys closer together than this are the SAME key.
 *
 * Shared, and load-bearing: the inspector's diamond decides "is there a key here" and the overlay's
 * drag-commit decides "replace the key here" with the same question. Two tolerances would let a drag
 * append a duplicate key a hair away from the one the diamond is showing as active — a track that
 * grows silently and interpolates over a zero-length span.
 */
export const FLAREX_SHAPE_KEY_EPSILON = 1e-4;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Tangent deltas are NOT clamped to 0..1 — a handle legitimately points outside the frame, and the
 *  curve it describes can still pass entirely inside it. Only the anchor is clamped. */
function toShapePoint(raw: unknown): FlarexShapePoint | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 2 && raw.every(finite)) return [clamp01(raw[0] as number), clamp01(raw[1] as number)];
  if (raw.length === 6 && raw.every(finite)) {
    const [x, y, ix, iy, ox, oy] = raw as number[];
    return [clamp01(x!), clamp01(y!), ix!, iy!, ox!, oy!];
  }
  return null;
}

/**
 * Parse a `points` payload. Soft-fails to `fallback` exactly as the compiler's original parser did —
 * a malformed outline must render the node's default shape, never blank the frame.
 */
export function parseFlarexShapePoints(raw: unknown, fallback: FlarexShapePoint[]): FlarexShapePoint[] {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const points = parsed.map(toShapePoint).filter((p): p is FlarexShapePoint => p !== null);
    return points.length >= 3 ? points : fallback;
  } catch {
    return fallback;
  }
}

/** Parse a `shapeKeyframes` payload. Empty (the default, and every comp saved before this slice) means
 *  "not animated" — the caller then uses `points` unchanged, and nothing about its cost changes. */
export function parseFlarexShapeKeyframes(raw: unknown): RawShapeKeyframe[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): RawShapeKeyframe | null => {
        if (!entry || typeof entry !== "object") return null;
        const t = (entry as { t?: unknown }).t;
        if (!finite(t)) return null;
        const p = (entry as { p?: unknown }).p;
        if (!Array.isArray(p)) return null;
        const points = p.map(toShapePoint).filter((q): q is FlarexShapePoint => q !== null);
        if (points.length < 3) return null;
        const e = (entry as { e?: unknown }).e;
        return { t, p: points, e: typeof e === "string" ? e : undefined };
      })
      .filter((entry): entry is RawShapeKeyframe => entry !== null)
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

/** Comp-fraction points → the comp-pixel `MaskPoint`s the rasterizer and the mask editor both use. */
export function flarexShapeToMaskPoints(points: FlarexShapePoint[], width: number, height: number, idPrefix: string): MaskPoint[] {
  return points.map((p, index) => {
    const point: MaskPoint = { id: `${idPrefix}_p${index}`, x: p[0] * width, y: p[1] * height };
    if (p.length === 6) {
      // Zero handles are the same shape as no handles, and omitting them keeps a dragged-flat point
      // from forcing `maskShapeToPathD` down its cubic branch for a curve that is a straight line.
      if (p[2] !== 0 || p[3] !== 0) point.inTangent = { x: p[2] * width, y: p[3] * height };
      if (p[4] !== 0 || p[5] !== 0) point.outTangent = { x: p[4] * width, y: p[5] * height };
    }
    return point;
  });
}

/** `MaskPoint`s (comp pixels, from the mask editor) → the node param form. Emits the 2-tuple when a
 *  point has no handles, so a polygon round-trips unchanged; the 6-tuple only where it is carrying
 *  information. Anchors are clamped because the overlay lets you drag outside the frame. */
export function flarexMaskPointsToShape(points: MaskPoint[], width: number, height: number): FlarexShapePoint[] {
  const fx = (n: number): number => (width > 0 ? n / width : 0);
  const fy = (n: number): number => (height > 0 ? n / height : 0);
  return points.map((p): FlarexShapePoint => {
    const x = clamp01(fx(p.x));
    const y = clamp01(fy(p.y));
    if (!p.inTangent && !p.outTangent) return [x, y];
    return [x, y, fx(p.inTangent?.x ?? 0), fy(p.inTangent?.y ?? 0), fx(p.outTangent?.x ?? 0), fy(p.outTangent?.y ?? 0)];
  });
}

/** Serialize the node param form. */
export function serializeFlarexShapePoints(points: FlarexShapePoint[]): string {
  return JSON.stringify(points);
}

export interface FlarexShapeKeyframeEntry {
  timeSeconds: number;
  points: FlarexShapePoint[];
  interpolation: KeyframeInterpolation;
}

/** Read `shapeKeyframes` as an editable list (the inspector's set/remove/step-to affordances). */
export function readFlarexShapeKeyframes(raw: unknown): FlarexShapeKeyframeEntry[] {
  return parseFlarexShapeKeyframes(raw).map((entry) => ({
    timeSeconds: entry.t,
    points: entry.p,
    interpolation: (entry.e ?? "linear") as KeyframeInterpolation,
  }));
}

export function writeFlarexShapeKeyframes(entries: FlarexShapeKeyframeEntry[]): string {
  if (entries.length === 0) return "";
  return JSON.stringify(
    [...entries]
      .sort((a, b) => a.timeSeconds - b.timeSeconds)
      .map((entry) => ({ t: entry.timeSeconds, p: entry.points, ...(entry.interpolation === "linear" ? {} : { e: entry.interpolation }) })),
  );
}

/** True when the outline actually animates. The compiler and the content hash both ask this, and they
 *  must agree: a hash that treats a node as static while the compiler animates it is a stale picture. */
export function flarexShapeIsAnimated(raw: unknown): boolean {
  return parseFlarexShapeKeyframes(raw).length > 0;
}

/**
 * The outline at `timeSeconds`, in comp pixels — the single resolution site.
 *
 * Delegates to the shared `getMaskPathAtTime`, so node masks inherit its exact semantics: hold before
 * the first key and after the last, per-point + per-tangent interpolation between, and HOLD (not morph)
 * when two adjacent keys have different point counts. Shape morphing across differing counts is
 * deliberately out of scope for this slice; inheriting the rule rather than inventing one is how it
 * stays out of scope without a second behaviour to explain.
 */
export function resolveFlarexShapeAtTime(params: {
  points: unknown;
  shapeKeyframes: unknown;
  fallback: FlarexShapePoint[];
  width: number;
  height: number;
  idPrefix: string;
  timeSeconds: number;
}): MaskPoint[] {
  const base = flarexShapeToMaskPoints(
    parseFlarexShapePoints(params.points, params.fallback),
    params.width,
    params.height,
    params.idPrefix,
  );
  const keys = parseFlarexShapeKeyframes(params.shapeKeyframes);
  if (keys.length === 0) return base;

  const pathKeyframes: MaskPathKeyframe[] = keys.map((entry, index) => ({
    id: `${params.idPrefix}_k${index}`,
    timeSeconds: entry.t,
    points: flarexShapeToMaskPoints(entry.p, params.width, params.height, params.idPrefix),
    interpolation: (entry.e ?? "linear") as KeyframeInterpolation,
  }));
  // A minimal Mask is all `getMaskPathAtTime` reads (`points` + `pathKeyframes`); building a full one
  // here would mean inventing feather/mode/transform values that the caller is about to overwrite.
  return getMaskPathAtTime({ points: base, pathKeyframes } as Mask, params.timeSeconds);
}
