/**
 * Pure geometry for the Graphics-tab Align + Distribute controls. No React, no
 * side effects — so the math is unit-testable in isolation (see §3 BUILD SPEC / S8
 * in GRAPHICS_TAB.md) and shared by both the frame-align and selection-align paths.
 *
 * UNITS: everything is in composition PERCENT. `cx`/`w` are percent-of-WIDTH (0..100),
 * `cy`/`h` are percent-of-HEIGHT. Each axis is self-consistent in its own percent
 * space, so horizontal ops use cx/w and vertical ops use cy/h without pixel
 * conversion. Rotation is intentionally ignored in v1 (boxes are the unrotated,
 * scaled layout box — matches how the layer stack + contentFractions already work).
 */

import { containContentRect, getCompositionTransform, type TimelineLayer } from "@orreris/shared";

export type AlignTarget = "left" | "centerH" | "right" | "top" | "middle" | "bottom";
export type AlignMode = "frame" | "selection";
export type DistributeAxis = "h" | "v";
export type DistributeMethod = "centers" | "gaps";

/** A layer's painted box at a moment, in percent. `cx`/`cy` are the box CENTER. */
export interface PaintedBox {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  locked: boolean;
}

export interface SelectionBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
}

/** Per-layer position write, in percent. Absent axis = leave that axis untouched. */
export type AlignWrite = { x?: number; y?: number };

/**
 * The layer's painted box as fractions of the comp (before the layer transform's scale).
 * Media/graphics: the `contain` content rect from the natural aspect (full frame for
 * cover/fill or unknown aspect). Shapes: their percent box. Text: wrap width + a
 * line-count height estimate (Premiere aligns the text BOX, not glyph ink).
 * Nested/compound clips (nestedCompositionId) fall through to the media branch.
 */
export function contentFractions(layer: TimelineLayer, compWidth: number, compHeight: number): { w: number; h: number } {
  if (layer.type === "shape") {
    return { w: (layer.widthPercent ?? 40) / 100, h: (layer.heightPercent ?? 40) / 100 };
  }
  if (layer.type === "text") {
    const lines = (layer.text ?? "").split("\n").length || 1;
    const fontSize = layer.fontSize ?? 64;
    const lineHeight = layer.lineHeight ?? 1.2;
    return {
      w: (layer.textWidthPercent ?? 80) / 100,
      h: Math.min(1, (lines * fontSize * lineHeight) / compHeight)
    };
  }
  const aspect =
    layer.graphic?.naturalWidth && layer.graphic.naturalHeight
      ? layer.graphic.naturalWidth / layer.graphic.naturalHeight
      : undefined;
  if ((layer.fit ?? (layer.graphic ? "contain" : "cover")) === "contain") {
    const rect = containContentRect(compWidth, compHeight, aspect);
    if (rect) return { w: rect.width / compWidth, h: rect.height / compHeight };
  }
  return { w: 1, h: 1 };
}

/**
 * The layer's painted box (center + size, percent) evaluated at `currentTime` (absolute seconds).
 *
 * `contentFraction` overrides the analytic `contentFractions` estimate — the align panel passes a
 * MEASURED fraction for text layers (whose real box hugs the glyphs / wraps in a frame and can't be
 * derived from props). Media/shape callers omit it and use the analytic box.
 *
 * NOTE: the box is intentionally NOT clamped to the frame. A scaled-up layer genuinely extends past
 * the frame; clamping the half-span (the old behavior) collapsed such a box to the center and made
 * align a silent no-op. Honest sizes → align/distribute land the real box.
 */
export function paintedBoxAt(
  layer: TimelineLayer,
  comp: { width: number; height: number },
  currentTime: number,
  contentFraction?: { w: number; h: number }
): PaintedBox {
  const resolved = getCompositionTransform(layer, { currentTimeSeconds: currentTime });
  const scale = resolved.scale || 1;
  const frac = contentFraction ?? contentFractions(layer, comp.width, comp.height);
  return {
    id: layer.id,
    cx: resolved.x,
    cy: resolved.y,
    w: frac.w * scale * 100,
    h: frac.h * scale * 100,
    locked: layer.locked === true
  };
}

export function unionBounds(boxes: PaintedBox[]): SelectionBounds | null {
  if (!boxes.length) return null;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.cx - box.w / 2);
    right = Math.max(right, box.cx + box.w / 2);
    top = Math.min(top, box.cy - box.h / 2);
    bottom = Math.max(bottom, box.cy + box.h / 2);
  }
  return { left, right, top, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

/**
 * New CENTER position (percent) per box for an align op. Locked boxes are never
 * written (they act as fixed references). Returns only the axis being aligned.
 * - Frame mode: each box aligns to the comp frame edge/center independently.
 * - Selection mode: each box aligns to the union `bounds` edge/center.
 */
export function alignTargets(
  boxes: PaintedBox[],
  target: AlignTarget,
  mode: AlignMode,
  bounds: SelectionBounds | null
): Map<string, AlignWrite> {
  const writes = new Map<string, AlignWrite>();
  const horizontal = target === "left" || target === "centerH" || target === "right";
  for (const box of boxes) {
    if (box.locked) continue;
    const halfW = box.w / 2;
    const halfH = box.h / 2;
    if (mode === "frame") {
      if (horizontal) {
        const x = target === "left" ? halfW : target === "right" ? 100 - halfW : 50;
        writes.set(box.id, { x });
      } else {
        const y = target === "top" ? halfH : target === "bottom" ? 100 - halfH : 50;
        writes.set(box.id, { y });
      }
      continue;
    }
    if (!bounds) continue;
    if (horizontal) {
      const x = target === "left" ? bounds.left + halfW : target === "right" ? bounds.right - halfW : bounds.cx;
      writes.set(box.id, { x });
    } else {
      const y = target === "top" ? bounds.top + halfH : target === "bottom" ? bounds.bottom - halfH : bounds.cy;
      writes.set(box.id, { y });
    }
  }
  return writes;
}

/**
 * New CENTER position (percent) per interior box for a distribute op. First and last
 * boxes (by position along the axis) are fixed anchors and are never written; locked
 * interior boxes keep their slot in the order but are not written either. Needs ≥3.
 * - "centers": interior centers spaced evenly between the first and last centers.
 * - "gaps": empty gap between adjacent boxes equalized (accounts for box sizes).
 */
export function distributeTargets(
  boxes: PaintedBox[],
  axis: DistributeAxis,
  method: DistributeMethod
): Map<string, AlignWrite> {
  const writes = new Map<string, AlignWrite>();
  if (boxes.length < 3) return writes;
  const center = (b: PaintedBox) => (axis === "h" ? b.cx : b.cy);
  const size = (b: PaintedBox) => (axis === "h" ? b.w : b.h);
  const sorted = [...boxes].sort((a, b) => center(a) - center(b));
  const n = sorted.length;
  const put = (id: string, value: number) => writes.set(id, axis === "h" ? { x: value } : { y: value });

  if (method === "centers") {
    const first = center(sorted[0]!);
    const last = center(sorted[n - 1]!);
    for (let i = 1; i < n - 1; i += 1) {
      const box = sorted[i]!;
      if (box.locked) continue;
      put(box.id, first + ((last - first) * i) / (n - 1));
    }
    return writes;
  }

  // gaps: span from the first box's leading edge to the last box's trailing edge,
  // minus the total box extent, split evenly into n-1 gaps; lay boxes out in order.
  const spanStart = center(sorted[0]!) - size(sorted[0]!) / 2;
  const spanEnd = center(sorted[n - 1]!) + size(sorted[n - 1]!) / 2;
  const totalSize = sorted.reduce((sum, b) => sum + size(b), 0);
  const gap = (spanEnd - spanStart - totalSize) / (n - 1);
  let cursor = spanStart;
  for (let i = 0; i < n; i += 1) {
    const box = sorted[i]!;
    const boxCenter = cursor + size(box) / 2;
    if (i !== 0 && i !== n - 1 && !box.locked) {
      put(box.id, boxCenter);
    }
    cursor += size(box) + gap;
  }
  return writes;
}
