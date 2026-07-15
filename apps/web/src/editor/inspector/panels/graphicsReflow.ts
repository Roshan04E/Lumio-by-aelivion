/**
 * Responsive Pin (§1) reflow driver — the editor-side "bake at reframe" step. When the canvas dims
 * change, we recompute each pinned TOP-LEVEL layer's `transform.position` so its chosen edge/center
 * stays glued on reframe. The manifest keeps plain percent positions, so BOTH renderers are untouched
 * (see GRAPHICS_TAB.md §1 — resolve time = bake, not render).
 *
 * Lives in web (not shared) because it needs `paintedBoxAt` (measures the box against comp dims).
 * The pure re-anchor math is `reflowPinnedCenter` in shared; this just feeds it before/after boxes.
 */

import { pinIsActive, reflowPinnedCenter, type TimelineComposition } from "@kimera-by-aelivion/shared";
import { getTransformKeyframes } from "../keyframeUtils";
import { paintedBoxAt } from "./graphicsAlignGeometry";

/**
 * Return `nextComp` with pinned layers re-anchored for its new dims (identity-returned if nothing
 * moved). `nextComp` already carries the NEW width/height; `oldDims` are the pre-reframe dims.
 *
 * Scope (v1): only TOP-LEVEL layers — a nested composition's own dims don't change when the outer
 * canvas is reframed, so its inner layers are left alone (they reflow when THAT comp is reframed).
 * A layer whose position is keyframed on an axis is left untouched on that axis (baking one center
 * would flatten the animation). Applies regardless of `locked` (reframe is structural, not a user
 * edit). Center/center pins are natural no-ops.
 */
export function reflowCompositionForResize(
  nextComp: TimelineComposition,
  oldDims: { width: number; height: number },
  currentTime: number
): TimelineComposition {
  let changed = false;
  const tracks = nextComp.tracks.map((track) => ({
    ...track,
    layers: track.layers.map((layer) => {
      if (!pinIsActive(layer.responsive)) return layer;
      const xKeyed = getTransformKeyframes(layer, "transform.position.x").length > 0;
      const yKeyed = getTransformKeyframes(layer, "transform.position.y").length > 0;
      if (xKeyed && yKeyed) return layer;

      const boxOld = paintedBoxAt(layer, oldDims, currentTime);
      const sizeNew = paintedBoxAt(layer, nextComp, currentTime);
      const anchored = reflowPinnedCenter(layer.responsive, boxOld, { w: sizeNew.w, h: sizeNew.h });

      const nextX = xKeyed ? layer.transform.position.x : anchored.x;
      const nextY = yKeyed ? layer.transform.position.y : anchored.y;
      if (nextX === layer.transform.position.x && nextY === layer.transform.position.y) return layer;
      changed = true;
      return {
        ...layer,
        transform: { ...layer.transform, position: { ...layer.transform.position, x: nextX, y: nextY } }
      };
    })
  }));
  return changed ? { ...nextComp, tracks } : nextComp;
}
