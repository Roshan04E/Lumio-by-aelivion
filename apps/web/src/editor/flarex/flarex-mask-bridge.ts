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
 * ── The limit that used to be here is gone ─────────────────────────────────────────────────────────
 * This header used to record an honest limit: `MaskPoint` carries bezier TANGENTS, the node param was
 * `[x, y]` pairs only, so pulling a handle did not persist. The param form now carries them
 * (`mask-shape.ts`, the 6-tuple) and both directions below preserve them. The deferred slice landed.
 *
 * ── Time ───────────────────────────────────────────────────────────────────────────────────────────
 * The outline can now ANIMATE (`shapeKeyframes`), so the bridge takes a time and presents the shape at
 * the playhead — through `resolveFlarexShapeAtTime`, the same function the compiler lowers through. Two
 * resolvers would mean the overlay's handles could sit somewhere other than the rasterized edge, which
 * is the specific failure a bridge exists to prevent.
 */

import {
  FLAREX_DEFAULT_MASK_POINTS,
  FLAREX_SHAPE_KEY_EPSILON,
  flarexMaskPointsToShape,
  readFlarexShapeKeyframes,
  resolveFlarexShapeAtTime,
  serializeFlarexShapePoints,
  writeFlarexShapeKeyframes,
} from "@orreris/shared";
import type { FlarexNode, FlarexShapePoint, Mask, MaskPoint, TimelineLayer } from "@orreris/shared";

/** Stable synthetic ids. Not persisted anywhere — they exist for the duration of one edit session. */
export const FLAREX_MASK_LAYER_ID = "flarexmask:layer";
export const FLAREX_MASK_ID = "flarexmask:mask";

export type FlarexMaskNodeType = "polygonMask" | "bezierMask";

export function isFlarexMaskNode(node: FlarexNode | null | undefined): node is FlarexNode & { type: FlarexMaskNodeType } {
  return node?.type === "polygonMask" || node?.type === "bezierMask";
}

export interface FlarexMaskBridge {
  layer: TimelineLayer;
  masks: Mask[];
}

/**
 * Present a mask node as the layer+mask pair `MaskEditorOverlay` expects, at comp-local `timeSeconds`.
 *
 * The outline is resolved through the compiler's own resolver, so an animated shape is presented at the
 * playhead and the handles sit exactly on the rasterized edge. Never null on a well-formed node: the
 * resolver soft-fails to the node type's default shape, which is what the compiler will draw too.
 */
export function buildFlarexMaskBridge(
  node: FlarexNode,
  compWidth: number,
  compHeight: number,
  timeSeconds: number,
): FlarexMaskBridge | null {
  if (!isFlarexMaskNode(node)) return null;
  const points = resolveFlarexShapeAtTime({
    points: node.params.points,
    shapeKeyframes: node.params.shapeKeyframes,
    fallback: FLAREX_DEFAULT_MASK_POINTS[node.type],
    width: compWidth,
    height: compHeight,
    idPrefix: FLAREX_MASK_ID,
    timeSeconds,
  });
  if (points.length < 3) return null;

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
 * Anchors are clamped to 0..1 (the overlay lets you drag outside the frame and the parser clamps
 * anyway, so clamping here means the number in the inspector is the number that renders); tangent
 * deltas are not, because a handle outside the frame still describes a curve inside it.
 */
export function flarexMaskPointsToParam(points: MaskPoint[], compWidth: number, compHeight: number): string {
  return serializeFlarexShapePoints(flarexMaskPointsToShape(points, compWidth, compHeight));
}

/**
 * The param patch for a committed outline edit — where the edit LANDS depends on whether the node is
 * animated, which is the auto-key rule `MaskItemBody` already uses for clip masks:
 *
 *   not animated  → rewrite the base `points`. Today's behaviour, unchanged, and the common case.
 *   animated      → write a keyframe AT THE PLAYHEAD, replacing one already there.
 *
 * Dragging a point on an animated shape and having it silently overwrite the base outline (which the
 * keyframes then override, so nothing visibly happens) is the failure this rule exists to prevent —
 * the same class as the tangents this bridge used to discard.
 */
export function flarexMaskCommitPatch(
  node: FlarexNode,
  points: MaskPoint[],
  compWidth: number,
  compHeight: number,
  timeSeconds: number,
): Record<string, string> {
  const shape: FlarexShapePoint[] = flarexMaskPointsToShape(points, compWidth, compHeight);
  const existing = readFlarexShapeKeyframes(node.params.shapeKeyframes);
  if (existing.length === 0) return { points: serializeFlarexShapePoints(shape) };
  return {
    shapeKeyframes: writeFlarexShapeKeyframes([
      ...existing.filter((entry) => Math.abs(entry.timeSeconds - timeSeconds) > FLAREX_SHAPE_KEY_EPSILON),
      { timeSeconds, points: shape, interpolation: "linear" },
    ]),
  };
}
