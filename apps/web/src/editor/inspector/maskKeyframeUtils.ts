import {
  getMaskScalarBase,
  type Mask,
  type MaskPathKeyframe,
  type MaskPoint,
  type MaskScalarProperty,
  type KeyframeInterpolation,
  type TimelineKeyframeV2,
  type TimelineLayer
} from "@reelforge/shared";
import { clamp, isKeyframeAt, keyframeTimeTolerance } from "./keyframeUtils";

/**
 * Mask keyframe mutations — the mask analogue of the transform/effect helpers in `keyframeUtils.ts`.
 * Scalar mask props (feather/expansion/opacity/transform.*) animate through the layer `animations`
 * array with `scope: "mask"` + `maskId`; the outline path animates through `mask.pathKeyframes`.
 * Evaluation lives in `@reelforge/shared` (clip-masks) so preview AND export resolve identically.
 */

// --- scalar props --------------------------------------------------------------------------------

export function getMaskScalarKeyframes(
  layer: TimelineLayer,
  maskId: string,
  property: MaskScalarProperty
): TimelineKeyframeV2[] {
  return (layer.animations ?? [])
    .filter((kf) => kf.target.scope === "mask" && kf.target.maskId === maskId && kf.target.property === property)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
}

export function getActiveMaskScalarKeyframe(
  layer: TimelineLayer,
  maskId: string,
  property: MaskScalarProperty,
  layerTime: number
) {
  return getMaskScalarKeyframes(layer, maskId, property).find((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
}

export function findMaskScalarKeyframeTime(
  layer: TimelineLayer,
  maskId: string,
  property: MaskScalarProperty,
  layerTime: number,
  direction: -1 | 1
) {
  const keyframes = getMaskScalarKeyframes(layer, maskId, property);
  if (direction < 0) {
    return [...keyframes].reverse().find((kf) => kf.timeSeconds < layerTime - keyframeTimeTolerance)?.timeSeconds;
  }
  return keyframes.find((kf) => kf.timeSeconds > layerTime + keyframeTimeTolerance)?.timeSeconds;
}

/** Pure setter for a mask scalar's static base value. */
export function setMaskScalarValue(mask: Mask, property: MaskScalarProperty, value: number): Mask {
  switch (property) {
    case "feather":
      return { ...mask, feather: value };
    case "expansion":
      return { ...mask, expansion: value };
    case "opacity":
      return { ...mask, opacity: value };
    case "transform.x":
      return { ...mask, transform: { ...mask.transform, x: value } };
    case "transform.y":
      return { ...mask, transform: { ...mask.transform, y: value } };
    case "transform.scaleX":
      return { ...mask, transform: { ...mask.transform, scaleX: value } };
    case "transform.scaleY":
      return { ...mask, transform: { ...mask.transform, scaleY: value } };
    case "transform.rotation":
      return { ...mask, transform: { ...mask.transform, rotation: value } };
    default:
      return mask;
  }
}

/**
 * Apply `fn` to the mask with `maskId` wherever it lives — a clip mask in `layer.masks` OR an effect-region
 * mask in some `layer.effects[].masks`. This lets every mask keyframe/path helper below work for both kinds
 * (their keyframes live in `layer.animations` by `maskId`, which is container-agnostic).
 */
function mapMask(layer: TimelineLayer, maskId: string, fn: (mask: Mask) => Mask): TimelineLayer {
  if ((layer.masks ?? []).some((mask) => mask.id === maskId)) {
    return { ...layer, masks: (layer.masks ?? []).map((mask) => (mask.id === maskId ? fn(mask) : mask)) };
  }
  return {
    ...layer,
    effects: layer.effects.map((effect) => {
      const masks = effect.masks;
      if (!Array.isArray(masks) || !masks.some((mask) => mask.id === maskId)) return effect;
      return { ...effect, masks: masks.map((mask) => (mask.id === maskId ? fn(mask) : mask)) };
    })
  };
}

/** Static (non-keyframed) patch of a mask's own fields (mode/invert/name/shape/…), in either container. */
export function updateMaskById(layer: TimelineLayer, maskId: string, patch: Partial<Mask>): TimelineLayer {
  return mapMask(layer, maskId, (mask) => ({ ...mask, ...patch }));
}

/** Drop every keyframe (scope "mask") belonging to a mask — used when deleting the mask. */
export function clearAllMaskKeyframes(layer: TimelineLayer, maskId: string): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).filter((kf) => !(kf.target.scope === "mask" && kf.target.maskId === maskId))
  };
}

/** Set a mask scalar at the playhead: writes the active keyframe's value, or the base when not animated. */
export function updateMaskScalarAtTime(
  layer: TimelineLayer,
  maskId: string,
  property: MaskScalarProperty,
  layerTime: number,
  value: number
): TimelineLayer {
  if (!getActiveMaskScalarKeyframe(layer, maskId, property, layerTime)) {
    return mapMask(layer, maskId, (mask) => setMaskScalarValue(mask, property, value));
  }
  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) =>
      kf.target.scope === "mask" &&
      kf.target.maskId === maskId &&
      kf.target.property === property &&
      isKeyframeAt(kf.timeSeconds, layerTime)
        ? { ...kf, value }
        : kf
    )
  };
}

export function toggleMaskScalarKeyframe(
  layer: TimelineLayer,
  maskId: string,
  property: MaskScalarProperty,
  layerTime: number,
  value: number
): TimelineLayer {
  if (getActiveMaskScalarKeyframe(layer, maskId, property, layerTime)) {
    return {
      ...layer,
      animations: (layer.animations ?? []).filter(
        (kf) =>
          !(
            kf.target.scope === "mask" &&
            kf.target.maskId === maskId &&
            kf.target.property === property &&
            isKeyframeAt(kf.timeSeconds, layerTime)
          )
      )
    };
  }

  const keyframe: TimelineKeyframeV2 = {
    id: `kf_${Date.now()}_mask_${maskId}_${property.replaceAll(".", "_")}`,
    target: { scope: "mask", maskId, property },
    timeSeconds: clamp(layerTime, 0, layer.durationSeconds),
    value,
    interpolation: "linear",
    temporal: {}
  };
  return {
    ...layer,
    animations: [...(layer.animations ?? []), keyframe].sort((a, b) => a.timeSeconds - b.timeSeconds)
  };
}

export function clearMaskScalarKeyframes(
  layer: TimelineLayer,
  maskId: string,
  property: MaskScalarProperty
): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).filter(
      (kf) => !(kf.target.scope === "mask" && kf.target.maskId === maskId && kf.target.property === property)
    )
  };
}

export function setMaskScalarInterpolation(
  layer: TimelineLayer,
  maskId: string,
  property: MaskScalarProperty,
  layerTime: number,
  interpolation: KeyframeInterpolation
): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) =>
      kf.target.scope === "mask" &&
      kf.target.maskId === maskId &&
      kf.target.property === property &&
      isKeyframeAt(kf.timeSeconds, layerTime)
        ? { ...kf, interpolation }
        : kf
    )
  };
}

/** All scalar keyframe targets present on a mask, used to show counts / clear-all in the inspector. */
export function maskScalarKeyframeCount(layer: TimelineLayer, maskId: string): number {
  return (layer.animations ?? []).filter((kf) => kf.target.scope === "mask" && kf.target.maskId === maskId).length;
}

// --- mask tracking (attach a saved track's motion to a mask) -------------------------------------
// Track-generated keyframes (scope "mask", transform.x/y) are tagged with a per-track id prefix so a
// layer can carry several attached tracks and re-attaching one only replaces its own keyframes.

/** Whether any keyframe generated by the given track-attach prefix is present on the layer. */
export function isTrackAttachedToMask(layer: TimelineLayer, keyPrefix: string): boolean {
  return (layer.animations ?? []).some((kf) => kf.id.startsWith(keyPrefix));
}

/** Replace the keyframes for one attached track: drop this prefix's existing keyframes, then add the new set. */
export function attachTrackToMask(
  layer: TimelineLayer,
  keyframes: TimelineKeyframeV2[],
  keyPrefix: string
): TimelineLayer {
  const kept = (layer.animations ?? []).filter((kf) => !kf.id.startsWith(keyPrefix));
  return {
    ...layer,
    animations: [...kept, ...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds)
  };
}

/** Remove all keyframes generated by a track-attach prefix (Detach). */
export function detachTrackFromMask(layer: TimelineLayer, keyPrefix: string): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).filter((kf) => !kf.id.startsWith(keyPrefix))
  };
}

// --- path keyframes ------------------------------------------------------------------------------

export function getMaskPathKeyframes(mask: Mask): MaskPathKeyframe[] {
  return [...(mask.pathKeyframes ?? [])].sort((a, b) => a.timeSeconds - b.timeSeconds);
}

export function hasMaskPathKeyframeAt(mask: Mask, layerTime: number): boolean {
  return getMaskPathKeyframes(mask).some((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
}

export function findMaskPathKeyframeTime(mask: Mask, layerTime: number, direction: -1 | 1) {
  const keyframes = getMaskPathKeyframes(mask);
  if (direction < 0) {
    return [...keyframes].reverse().find((kf) => kf.timeSeconds < layerTime - keyframeTimeTolerance)?.timeSeconds;
  }
  return keyframes.find((kf) => kf.timeSeconds > layerTime + keyframeTimeTolerance)?.timeSeconds;
}

function clonePoints(points: MaskPoint[]): MaskPoint[] {
  return points.map((pt) => ({
    ...pt,
    ...(pt.inTangent ? { inTangent: { ...pt.inTangent } } : {}),
    ...(pt.outTangent ? { outTangent: { ...pt.outTangent } } : {})
  }));
}

/** Snapshot/clear a path keyframe at the playhead. First snapshot also captures time 0 if empty so the
 *  shape holds before the first key (matches scalar behaviour). */
export function toggleMaskPathKeyframe(layer: TimelineLayer, maskId: string, layerTime: number): TimelineLayer {
  return mapMask(layer, maskId, (mask) => {
    const time = clamp(layerTime, 0, layer.durationSeconds);
    if (hasMaskPathKeyframeAt(mask, time)) {
      const remaining = getMaskPathKeyframes(mask).filter((kf) => !isKeyframeAt(kf.timeSeconds, time));
      return { ...mask, pathKeyframes: remaining.length ? remaining : undefined };
    }
    const snapshot: MaskPathKeyframe = {
      id: `mpk_${Date.now()}_${Math.round(time * 1000)}`,
      timeSeconds: time,
      points: clonePoints(mask.points),
      interpolation: "linear"
    };
    return { ...mask, pathKeyframes: [...getMaskPathKeyframes(mask), snapshot].sort((a, b) => a.timeSeconds - b.timeSeconds) };
  });
}

/** Record edited outline points: when the mask is path-animated, write/insert a keyframe at the
 *  playhead; otherwise overwrite the static points. The overlay calls this on every committed edit. */
export function recordMaskPoints(
  layer: TimelineLayer,
  maskId: string,
  layerTime: number,
  points: MaskPoint[]
): TimelineLayer {
  return mapMask(layer, maskId, (mask) => {
    const animated = (mask.pathKeyframes ?? []).length > 0;
    if (!animated) {
      return { ...mask, points: clonePoints(points) };
    }
    const time = clamp(layerTime, 0, layer.durationSeconds);
    const existing = getMaskPathKeyframes(mask);
    const at = existing.find((kf) => isKeyframeAt(kf.timeSeconds, time));
    const nextKeyframes = at
      ? existing.map((kf) => (kf.id === at.id ? { ...kf, points: clonePoints(points) } : kf))
      : [
          ...existing,
          {
            id: `mpk_${Date.now()}_${Math.round(time * 1000)}`,
            timeSeconds: time,
            points: clonePoints(points),
            interpolation: "linear" as KeyframeInterpolation
          }
        ].sort((a, b) => a.timeSeconds - b.timeSeconds);
    // also keep `points` as the latest edit so a non-animated render path still looks right.
    return { ...mask, points: clonePoints(points), pathKeyframes: nextKeyframes };
  });
}

export { getMaskScalarBase };
