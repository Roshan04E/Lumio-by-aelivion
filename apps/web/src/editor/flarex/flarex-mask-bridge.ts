/**
 * Flarex mask node → the app's REAL mask editor, by bridge rather than by refactor.
 *
 * `polygonMask`/`bezierMask` shipped with their `points` param rendered as rows of 0–1 number inputs:
 * you typed coordinates and guessed where they landed (2026-07-29: "mask doesn't have workable UI").
 * Meanwhile the app already owns a full on-viewer mask editor — `MaskEditorOverlay` in VideoPreview —
 * with point drag, edge insert, double-click delete, marquee, the lot.
 *
 * The founder's call was "match the clip mask editor exactly", and the cheapest correct way to do that
 * is the pattern this codebase has already proven once: `flarex-graph-bridge.ts` presents a Flarex node
 * to the 1487-line GraphEditor as a synthetic `TimelineLayer`, which is why the graph editor works on
 * nodes without the GraphEditor knowing Flarex exists. This is the same move for the mask overlay:
 * present the node as a synthetic layer carrying ONE mask, let the real editor edit it, and translate
 * the committed points back into the node's param.
 *
 * ── Why a SHAPE layer ──────────────────────────────────────────────────────────────────────────────
 * `MaskEditorOverlay` treats `text`/`shape` layers as authored in COMP space (identity transform, no
 * layer scale/rotation) and everything else as riding the layer transform. A Flarex mask node's points
 * ARE comp-relative — that is exactly the comp-space case — so the synthetic layer is a `shape`, and
 * the mapping collapses to a multiply by width/height. `shapeKind` is deliberately NOT `"pen"`: that
 * flag routes the overlay into editing a layer's own outline instead of its masks.
 *
 * ── The one honest limit ───────────────────────────────────────────────────────────────────────────
 * `MaskPoint` carries optional bezier TANGENTS; the node param is `[x, y]` pairs only. Tangents are
 * therefore dropped on commit. A `bezierMask` still curves — the compiler lowers positions through the
 * shared bezier rasterizer — so dragging points genuinely shapes the curve; what you cannot do is pull
 * a handle and have it persist. Storing them needs a param-shape change (`[x,y]` → 6-tuple) plus a
 * lowering change, which is a separate slice and was explicitly deferred. Named here rather than
 * discovered: an affordance that silently discards your edit is the Tracker's text-blob bug again.
 */

import type { FlarexNode, Mask, MaskPoint, TimelineLayer } from "@orreris/shared";

/** Stable synthetic ids. Not persisted anywhere — they exist for the duration of one edit session. */
export const FLAREX_MASK_LAYER_ID = "flarexmask:layer";
export const FLAREX_MASK_ID = "flarexmask:mask";

export type FlarexMaskNodeType = "polygonMask" | "bezierMask";

export function isFlarexMaskNode(node: FlarexNode | null | undefined): node is FlarexNode & { type: FlarexMaskNodeType } {
  return node?.type === "polygonMask" || node?.type === "bezierMask";
}

/** Mirrors the compiler's `parseFractionPoints` — same soft-fail, so the overlay and the render agree
 *  about a malformed payload instead of disagreeing about what is on screen. */
function parsePoints(raw: unknown): Array<[number, number]> {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n)))
      .map(([x, y]) => [x, y] as [number, number]);
  } catch {
    return [];
  }
}

export interface FlarexMaskBridge {
  layer: TimelineLayer;
  masks: Mask[];
}

/**
 * Present a mask node as the layer+mask pair `MaskEditorOverlay` expects, or null when the node has no
 * usable outline (fewer than 3 points — the overlay needs a shape to manipulate, and the compiler
 * soft-fails to its default at that point anyway).
 */
export function buildFlarexMaskBridge(node: FlarexNode, compWidth: number, compHeight: number): FlarexMaskBridge | null {
  if (!isFlarexMaskNode(node)) return null;
  const fractions = parsePoints(node.params.points);
  if (fractions.length < 3) return null;

  const points: MaskPoint[] = fractions.map(([fx, fy], i) => ({
    id: `${FLAREX_MASK_ID}_p${i}`,
    x: fx * compWidth,
    y: fy * compHeight,
  }));

  const mask: Mask = {
    id: FLAREX_MASK_ID,
    name: node.label ?? (node.type === "bezierMask" ? "Bezier" : "Polygon"),
    enabled: node.enabled,
    // The node type IS the outline kind, so the overlay draws what the compiler will rasterize.
    shape: node.type === "bezierMask" ? "bezier" : "polygon",
    mode: "add",
    source: "manual",
    points,
    // The node owns feather/invert as its OWN params, edited in the inspector. Neutral here so the
    // overlay's on-canvas feather widget cannot write a value the node would never read back.
    feather: 0,
    expansion: 0,
    opacity: 100,
    inverted: false,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  };

  const layer = {
    id: FLAREX_MASK_LAYER_ID,
    trackId: "__flarex_mask",
    // `shape` puts the overlay in COMP space — see the header. Not "pen": that edits a layer outline.
    type: "shape",
    shapeKind: "rectangle",
    name: mask.name,
    // Always active, always at t=0: the overlay gates on `isLayerActive` and derives a local time, and
    // a mask node's points are not animated on this path (node keyframes are the inspector's job).
    startSeconds: 0,
    // Effectively "always active" (the overlay gates on `isLayerActive`) without being a value that
    // could overflow if some consumer multiplies it by an fps. MAX_SAFE_INTEGER is a landmine here.
    durationSeconds: 1e6,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
    masks: [mask],
  } as unknown as TimelineLayer;

  return { layer, masks: [mask] };
}

/**
 * Committed overlay points → the node's `points` param JSON.
 *
 * Clamped to 0..1 because the overlay lets you drag outside the frame and the compiler's parser clamps
 * anyway — doing it here means the number you see in the inspector is the number that renders.
 * Tangents are dropped; see the header.
 */
export function flarexMaskPointsToParam(points: MaskPoint[], compWidth: number, compHeight: number): string {
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  const fractions = points.map((p) => [
    clamp01(compWidth > 0 ? p.x / compWidth : 0),
    clamp01(compHeight > 0 ? p.y / compHeight : 0),
  ]);
  return JSON.stringify(fractions);
}
