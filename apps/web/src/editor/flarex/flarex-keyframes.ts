/**
 * Flarex node-param keyframe helpers (FLAREX.md Part 3 / plan S2). These mirror the effect-param
 * helpers in `keyframeUtils.ts`, but the animations live on `FlarexComp.animations` (NOT a layer)
 * and target `{ scope: "flarexNode", effectId: nodeId, property: paramKey }`. Times are COMP-LOCAL
 * (playhead − layer.startSeconds, clamped ≥ 0) — the same convention `compileFlarexComp` samples at.
 *
 * All functions are pure: they take a comp and return the next comp; the caller commits it through
 * the single `updateComp` → `stampFlarexComp` write seam (one gesture = one undo step).
 */

import type { FlarexComp, FlarexNode, TimelineKeyframeV2 } from "@orreris/shared";
import { clamp, findKeyframeIn, isKeyframeAt, mintKeyframeId } from "../inspector/keyframeUtils";

/** Every keyframe for one (node, param), sorted by comp-local time. */
export function getNodeParamKeyframes(comp: FlarexComp, nodeId: string, paramKey: string): TimelineKeyframeV2[] {
  return comp.animations
    .filter(
      (kf) => kf.target.scope === "flarexNode" && kf.target.effectId === nodeId && kf.target.property === paramKey
    )
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
}

export function getActiveNodeParamKeyframe(comp: FlarexComp, nodeId: string, paramKey: string, compTime: number) {
  return getNodeParamKeyframes(comp, nodeId, paramKey).find((kf) => isKeyframeAt(kf.timeSeconds, compTime));
}

export function findNodeParamKeyframe(
  comp: FlarexComp,
  nodeId: string,
  paramKey: string,
  compTime: number,
  direction: -1 | 1
) {
  return findKeyframeIn(getNodeParamKeyframes(comp, nodeId, paramKey), compTime, direction);
}

/** Add a keyframe at `compTime` with `value`, or remove the one already there (diamond toggle). */
export function toggleNodeParamKeyframe(
  comp: FlarexComp,
  nodeId: string,
  paramKey: string,
  compTime: number,
  value: number
): FlarexComp {
  if (getActiveNodeParamKeyframe(comp, nodeId, paramKey, compTime)) {
    return {
      ...comp,
      animations: comp.animations.filter(
        (kf) =>
          !(
            kf.target.scope === "flarexNode" &&
            kf.target.effectId === nodeId &&
            kf.target.property === paramKey &&
            isKeyframeAt(kf.timeSeconds, compTime)
          )
      )
    };
  }
  const keyframe: TimelineKeyframeV2 = {
    id: mintKeyframeId(`${nodeId}_${paramKey}`),
    target: { scope: "flarexNode", effectId: nodeId, property: paramKey },
    timeSeconds: Math.max(0, compTime),
    value,
    interpolation: "linear",
    temporal: {}
  };
  return {
    ...comp,
    animations: [...comp.animations, keyframe].sort((a, b) => a.timeSeconds - b.timeSeconds)
  };
}

/** Remove ALL keyframes for one (node, param) — the trash affordance. */
export function clearNodeParamKeyframes(comp: FlarexComp, nodeId: string, paramKey: string): FlarexComp {
  return {
    ...comp,
    animations: comp.animations.filter(
      (kf) => !(kf.target.scope === "flarexNode" && kf.target.effectId === nodeId && kf.target.property === paramKey)
    )
  };
}

/**
 * The four-way write rule (the animated-edit bug fix, mirrored from `applyEffectParamValueAtTime`):
 *  - keyframe at the playhead   → update it in place
 *  - param already animated     → INSERT a keyframe at the playhead (never touch the base)
 *  - otherwise                  → write the static `node.params[key]` base value
 */
export function applyNodeParamValueAtTime(
  comp: FlarexComp,
  nodeId: string,
  paramKey: string,
  compTime: number,
  value: number
): FlarexComp {
  const hasKeyframeAtPlayhead = Boolean(getActiveNodeParamKeyframe(comp, nodeId, paramKey, compTime));
  const isAnimated = getNodeParamKeyframes(comp, nodeId, paramKey).length > 0;

  if (hasKeyframeAtPlayhead) {
    return {
      ...comp,
      animations: comp.animations.map((kf) =>
        kf.target.scope === "flarexNode" &&
        kf.target.effectId === nodeId &&
        kf.target.property === paramKey &&
        isKeyframeAt(kf.timeSeconds, compTime)
          ? { ...kf, value }
          : kf
      )
    };
  }
  if (isAnimated) {
    return toggleNodeParamKeyframe(comp, nodeId, paramKey, compTime, value);
  }
  return setNodeParamBase(comp, nodeId, paramKey, value);
}

/** Write a plain param value onto the node (no keyframes involved). */
export function setNodeParamBase(
  comp: FlarexComp,
  nodeId: string,
  paramKey: string,
  value: FlarexNode["params"][string]
): FlarexComp {
  const target = comp.nodes[nodeId];
  if (!target) return comp;
  return {
    ...comp,
    nodes: { ...comp.nodes, [nodeId]: { ...target, params: { ...target.params, [paramKey]: value } } }
  };
}

export { clamp } from "../inspector/keyframeUtils";
