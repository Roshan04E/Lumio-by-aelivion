/**
 * Responsive Pin (§1) — pure re-anchor math. No React, no DOM, no renderer knowledge, so it is
 * unit-testable in isolation and shared by the web reflow driver (and any future consumer).
 *
 * MODEL (see GRAPHICS_TAB.md §1): positions are stored as PERCENT of the frame and both renderers
 * consume them identically. When the canvas is reframed, a pinned layer should keep its chosen EDGE
 * (or center) at a constant percent while its painted box takes its natural size in the NEW frame.
 * We therefore bake a new center% at reframe time — the manifest stays plain percents and neither
 * renderer changes.
 *
 * UNITS: everything is composition PERCENT (0..100), matching `paintedBoxAt`. `cx`/`w` are
 * percent-of-WIDTH, `cy`/`h` percent-of-HEIGHT; each axis is self-consistent so we never convert to
 * pixels here. The caller supplies the box measured in the OLD frame and just the SIZE measured in
 * the NEW frame (same transform) — this resolver only re-places the center.
 */

import type { LayerResponsivePin } from "./types";

/** Painted box in the old frame: center + size, percent. Same shape as `PaintedBox` sans id/locked. */
export interface PinBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Box size (percent) as it would be in the NEW frame under the SAME transform. */
export interface PinSize {
  w: number;
  h: number;
}

/** True when the pin actually anchors an edge on some axis (center/center is a no-op). */
export function pinIsActive(pin: LayerResponsivePin | undefined): boolean {
  if (!pin) return false;
  const activeX = pin.x === "left" || pin.x === "right";
  const activeY = pin.y === "top" || pin.y === "bottom";
  return activeX || activeY;
}

/**
 * New CENTER position (percent) for a pinned box after reframe. Per axis:
 *  - "center"/unset → center held constant (identical to today's percent behavior).
 *  - "left"/"top"   → the box's LEFT/TOP edge percent is held; center = edge + newHalfSize.
 *  - "right"/"bottom" → the RIGHT/BOTTOM edge percent is held; center = edge - newHalfSize.
 * `sizeNew` differs from `boxOld` only for boxes whose size is frame-dependent (contain-fit media,
 * text height via absolute fontSize); for frame-relative boxes it equals the old size → no shift.
 */
export function reflowPinnedCenter(
  pin: LayerResponsivePin | undefined,
  boxOld: PinBox,
  sizeNew: PinSize
): { x: number; y: number } {
  const x = anchorAxis(pin?.x, boxOld.cx, boxOld.w, sizeNew.w, "left", "right");
  const y = anchorAxis(pin?.y, boxOld.cy, boxOld.h, sizeNew.h, "top", "bottom");
  return { x, y };
}

function anchorAxis(
  mode: string | undefined,
  centerOld: number,
  sizeOld: number,
  sizeNew: number,
  low: "left" | "top",
  high: "right" | "bottom"
): number {
  if (mode === low) {
    return centerOld - sizeOld / 2 + sizeNew / 2; // hold the low (left/top) edge percent
  }
  if (mode === high) {
    return centerOld + sizeOld / 2 - sizeNew / 2; // hold the high (right/bottom) edge percent
  }
  return centerOld; // "center" or unset — unchanged
}
