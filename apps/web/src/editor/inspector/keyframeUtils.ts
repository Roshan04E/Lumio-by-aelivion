import {
  evaluateTimelineTransform,
  evaluateTimelineEffectParam,
  getLayerAnimations,
  getTimelineEffectDefinition,
  normalizeTimelineEffect,
  type KeyframeInterpolation,
  type TimelineKeyframeV2,
  type TimelineLayer,
  type TimelineEffectParamDefinition
} from "@reelforge/shared";
export { evaluateTextRevealProgress, sliceTextRuns, getVisibleTextRuns } from "@reelforge/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransformAnimationProperty =
  | "transform.position.x"
  | "transform.position.y"
  | "transform.scale"
  | "transform.rotation"
  | "transform.opacity"
  | "transform.rotateX"
  | "transform.rotateY"
  | "transform.perspective";

export type GraphTarget =
  | {
      kind: "transform";
      label: string;
      max: number;
      min: number;
      property: TransformAnimationProperty;
      step: number;
    }
  | {
      effectId: string;
      kind: "effect";
      label: string;
      max: number;
      min: number;
      property: string;
      step: number;
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const keyframeTimeTolerance = 0.025;

export const interpolationOptions: Array<{ label: string; value: KeyframeInterpolation }> = [
  { label: "Hold", value: "hold" },
  { label: "Linear", value: "linear" },
  { label: "Ease In", value: "easeIn" },
  { label: "Ease Out", value: "easeOut" },
  { label: "Ease In/Out", value: "easeInOut" },
  { label: "Auto Bezier", value: "autoBezier" }
];

export const transformPropertyConfigs: Array<{
  label: string;
  max: number;
  min: number;
  property: TransformAnimationProperty;
  step: number;
}> = [
  { label: "X", property: "transform.position.x", min: 0, max: 100, step: 1 },
  { label: "Y", property: "transform.position.y", min: 0, max: 100, step: 1 },
  { label: "Scale", property: "transform.scale", min: 0.01, max: 100, step: 0.05 },
  { label: "Rotate", property: "transform.rotation", min: -180, max: 180, step: 1 },
  { label: "Opacity", property: "transform.opacity", min: 0, max: 100, step: 1 },
  { label: "Tilt X", property: "transform.rotateX", min: -180, max: 180, step: 1 },
  { label: "Tilt Y", property: "transform.rotateY", min: -180, max: 180, step: 1 },
  { label: "Persp", property: "transform.perspective", min: 0, max: 4000, step: 20 }
];

export const transformGraphTargets: GraphTarget[] = transformPropertyConfigs.map((item) => ({
  ...item,
  kind: "transform"
}));

export const animationPresets = [
  { id: "popIn", label: "Pop In" },
  { id: "smoothSlide", label: "Smooth Slide" },
  { id: "drift", label: "Drift" },
  { id: "zoomPulse", label: "Zoom Pulse" },
  { id: "bounce", label: "Bounce" },
  { id: "fadeInOut", label: "Fade In/Out" },
  { id: "typewriter", label: "Typewriter", textOnly: true }
] as const;

export type AnimationPresetId = (typeof animationPresets)[number]["id"];

// ---------------------------------------------------------------------------
// Micro-utils (private to this module, re-exported for graph editor)
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function snap(value: number, step: number) {
  return Math.round(value / step) * step;
}

// ---------------------------------------------------------------------------
// Transform property accessors
// ---------------------------------------------------------------------------

export function getTransformPropertyValue(
  transform: TimelineLayer["transform"],
  property: TransformAnimationProperty
) {
  if (property === "transform.position.x") return transform.position.x;
  if (property === "transform.position.y") return transform.position.y;
  if (property === "transform.scale") return transform.scale;
  if (property === "transform.rotation") return transform.rotation;
  if (property === "transform.rotateX") return transform.rotateX ?? 0;
  if (property === "transform.rotateY") return transform.rotateY ?? 0;
  if (property === "transform.perspective") return transform.perspective ?? 0;
  return transform.opacity;
}

export function setTransformPropertyValue(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  value: number
): TimelineLayer {
  if (property === "transform.position.x") {
    return { ...layer, transform: { ...layer.transform, position: { ...layer.transform.position, x: value } } };
  }
  if (property === "transform.position.y") {
    return { ...layer, transform: { ...layer.transform, position: { ...layer.transform.position, y: value } } };
  }
  if (property === "transform.scale") {
    return { ...layer, transform: { ...layer.transform, scale: value } };
  }
  if (property === "transform.rotation") {
    return { ...layer, transform: { ...layer.transform, rotation: value } };
  }
  if (property === "transform.rotateX") {
    return { ...layer, transform: { ...layer.transform, rotateX: value } };
  }
  if (property === "transform.rotateY") {
    return { ...layer, transform: { ...layer.transform, rotateY: value } };
  }
  if (property === "transform.perspective") {
    return { ...layer, transform: { ...layer.transform, perspective: value } };
  }
  return { ...layer, transform: { ...layer.transform, opacity: value } };
}

export function legacyKeyframeProperty(
  property: TransformAnimationProperty
): TimelineLayer["keyframes"][number]["property"] | null {
  if (property === "transform.position.x") return "position.x";
  if (property === "transform.position.y") return "position.y";
  if (property === "transform.scale") return "scale";
  if (property === "transform.rotation") return "rotation";
  if (property === "transform.opacity") return "opacity";
  // 3D tilt (rotateX/rotateY/perspective) is keyframed only via the V2 animations
  // track — it has no legacy keyframe equivalent.
  return null;
}

// ---------------------------------------------------------------------------
// Keyframe accessors
// ---------------------------------------------------------------------------

export function getTransformKeyframes(layer: TimelineLayer, property: TransformAnimationProperty) {
  return getLayerAnimations(layer)
    .filter((kf) => kf.target.scope === "layer" && kf.target.property === property)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
}

export function getEffectParamKeyframes(layer: TimelineLayer, effectId: string, paramKey: string) {
  return (layer.animations ?? [])
    .filter(
      (kf) => kf.target.scope === "effect" && kf.target.effectId === effectId && kf.target.property === paramKey
    )
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
}

export function isKeyframeAt(timeSeconds: number, targetTimeSeconds: number) {
  return Math.abs(timeSeconds - targetTimeSeconds) <= keyframeTimeTolerance;
}

export function hasTransformKeyframeAt(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  layerTime: number
) {
  return getTransformKeyframes(layer, property).some((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
}

export function getActiveTransformKeyframe(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  layerTime: number
) {
  return getTransformKeyframes(layer, property).find((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
}

export function getActiveEffectParamKeyframe(
  layer: TimelineLayer,
  effectId: string,
  paramKey: string,
  layerTime: number
) {
  return getEffectParamKeyframes(layer, effectId, paramKey).find((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
}

export function findTransformKeyframeTime(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  layerTime: number,
  direction: -1 | 1
) {
  const keyframes = getTransformKeyframes(layer, property);
  if (direction < 0) {
    return [...keyframes].reverse().find((kf) => kf.timeSeconds < layerTime - keyframeTimeTolerance)?.timeSeconds;
  }
  return keyframes.find((kf) => kf.timeSeconds > layerTime + keyframeTimeTolerance)?.timeSeconds;
}

// ---------------------------------------------------------------------------
// Transform property mutations
// ---------------------------------------------------------------------------

export function updateTransformPropertyAtTime(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  layerTime: number,
  value: number
) {
  const legacyProperty = legacyKeyframeProperty(property);
  const hasAnimationKeyframe = (layer.animations ?? []).some(
    (kf) => kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime)
  );
  const hasLegacyKeyframe = layer.keyframes.some(
    (kf) => kf.property === legacyProperty && isKeyframeAt(Math.max(0, kf.timeSeconds - layer.startSeconds), layerTime)
  );

  if (!hasAnimationKeyframe && !hasLegacyKeyframe) {
    return setTransformPropertyValue(layer, property, value);
  }

  return {
    ...layer,
    keyframes: layer.keyframes.map((kf) =>
      kf.property === legacyProperty && isKeyframeAt(Math.max(0, kf.timeSeconds - layer.startSeconds), layerTime)
        ? { ...kf, value }
        : kf
    ),
    animations: (layer.animations ?? []).map((kf) =>
      kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime)
        ? { ...kf, value }
        : kf
    )
  };
}

export function toggleTransformKeyframe(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  layerTime: number,
  value: number
): TimelineLayer {
  const legacyProperty = legacyKeyframeProperty(property);
  if (hasTransformKeyframeAt(layer, property, layerTime)) {
    return {
      ...layer,
      keyframes: layer.keyframes.filter(
        (kf) =>
          !(kf.property === legacyProperty && isKeyframeAt(Math.max(0, kf.timeSeconds - layer.startSeconds), layerTime))
      ),
      animations: (layer.animations ?? []).filter(
        (kf) =>
          !(kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime))
      )
    };
  }

  const keyframe: TimelineKeyframeV2 = {
    id: `kf_${Date.now()}_${property.replaceAll(".", "_")}`,
    target: { scope: "layer", property },
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

export function clearTransformKeyframes(
  layer: TimelineLayer,
  property: TransformAnimationProperty
): TimelineLayer {
  const legacyProperty = legacyKeyframeProperty(property);
  return {
    ...layer,
    keyframes: layer.keyframes.filter((kf) => kf.property !== legacyProperty),
    animations: (layer.animations ?? []).filter(
      (kf) => !(kf.target.scope === "layer" && kf.target.property === property)
    )
  };
}

export function setTransformKeyframeInterpolation(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  layerTime: number,
  interpolation: KeyframeInterpolation
): TimelineLayer {
  const activeKeyframe = getActiveTransformKeyframe(layer, property, layerTime);
  if (!activeKeyframe) {
    return layer;
  }

  const legacyProperty = legacyKeyframeProperty(property);
  const matchingLegacy = layer.keyframes.find(
    (kf) =>
      kf.id === activeKeyframe.id ||
      (kf.property === legacyProperty && isKeyframeAt(Math.max(0, kf.timeSeconds - layer.startSeconds), layerTime))
  );
  const nextAnimations = (layer.animations ?? []).map((kf) =>
    kf.id === activeKeyframe.id ? { ...kf, interpolation } : kf
  );

  if (!matchingLegacy || nextAnimations.some((kf) => kf.id === activeKeyframe.id)) {
    return { ...layer, animations: nextAnimations };
  }

  const migratedKeyframe: TimelineKeyframeV2 = {
    id: matchingLegacy.id,
    target: { scope: "layer", property },
    timeSeconds: Math.max(0, matchingLegacy.timeSeconds - layer.startSeconds),
    value: matchingLegacy.value,
    interpolation,
    temporal: {}
  };

  return {
    ...layer,
    keyframes: layer.keyframes.filter((kf) => kf.id !== matchingLegacy.id),
    animations: [...nextAnimations, migratedKeyframe].sort((a, b) => a.timeSeconds - b.timeSeconds)
  };
}

export function updateTransformKeyframe(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  keyframeId: string,
  patch: { timeSeconds?: number | undefined; value?: number | undefined }
): TimelineLayer {
  const legacyProperty = legacyKeyframeProperty(property);
  const existingAnimation = (layer.animations ?? []).find((kf) => kf.id === keyframeId);
  if (existingAnimation) {
    return {
      ...layer,
      animations: (layer.animations ?? [])
        .map((kf) =>
          kf.id === keyframeId
            ? {
                ...kf,
                timeSeconds: clamp(patch.timeSeconds ?? kf.timeSeconds, 0, layer.durationSeconds),
                value: patch.value ?? (kf.value as number)
              }
            : kf
        )
        .sort((a, b) => a.timeSeconds - b.timeSeconds)
    };
  }

  const existingLegacy = layer.keyframes.find((kf) => kf.id === keyframeId && kf.property === legacyProperty);
  if (!existingLegacy) {
    return layer;
  }

  const migratedKeyframe: TimelineKeyframeV2 = {
    id: existingLegacy.id,
    target: { scope: "layer", property },
    timeSeconds: clamp(
      patch.timeSeconds ?? Math.max(0, existingLegacy.timeSeconds - layer.startSeconds),
      0,
      layer.durationSeconds
    ),
    value: patch.value ?? existingLegacy.value,
    interpolation: existingLegacy.easing,
    temporal: {}
  };

  return {
    ...layer,
    keyframes: layer.keyframes.filter((kf) => kf.id !== keyframeId),
    animations: [...(layer.animations ?? []), migratedKeyframe].sort((a, b) => a.timeSeconds - b.timeSeconds)
  };
}

export function updateTransformKeyframeHandle(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  keyframeId: string,
  handle: "in" | "out",
  nextHandle: { dx: number; dy: number },
  linked: boolean
): TimelineLayer {
  const keyframe = getTransformKeyframes(layer, property).find((item) => item.id === keyframeId);
  if (!keyframe) {
    return layer;
  }

  const layerWithAnimation = (layer.animations ?? []).some((item) => item.id === keyframeId)
    ? layer
    : updateTransformKeyframe(layer, property, keyframeId, {});

  return {
    ...layerWithAnimation,
    animations: (layerWithAnimation.animations ?? []).map((item) => {
      if (item.id !== keyframeId) {
        return item;
      }
      const mirroredHandle = { dx: -nextHandle.dx, dy: -nextHandle.dy };
      return {
        ...item,
        interpolation: "bezier" as const,
        temporal: {
          ...item.temporal,
          [handle]: nextHandle,
          ...(linked ? { [handle === "in" ? "out" : "in"]: mirroredHandle } : {}),
          linked
        }
      };
    })
  };
}

export function setTransformKeyframeLinked(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  keyframeId: string,
  linked: boolean
): TimelineLayer {
  const layerWithAnimation = (layer.animations ?? []).some((item) => item.id === keyframeId)
    ? layer
    : updateTransformKeyframe(layer, property, keyframeId, {});

  return {
    ...layerWithAnimation,
    animations: (layerWithAnimation.animations ?? []).map((kf) =>
      kf.id === keyframeId ? { ...kf, temporal: { ...kf.temporal, linked } } : kf
    )
  };
}

// ---------------------------------------------------------------------------
// Position keyframe helpers
// ---------------------------------------------------------------------------

export function updatePositionKeyframesAtTime(
  layer: TimelineLayer,
  layerTime: number,
  position: { x: number; y: number }
): TimelineLayer {
  const nextLayer = updateTransformPropertyAtTime(layer, "transform.position.x", layerTime, position.x);
  const withX = hasTransformKeyframeAt(nextLayer, "transform.position.x", layerTime)
    ? nextLayer
    : toggleTransformKeyframe(nextLayer, "transform.position.x", layerTime, position.x);
  const withYValue = updateTransformPropertyAtTime(withX, "transform.position.y", layerTime, position.y);
  return hasTransformKeyframeAt(withYValue, "transform.position.y", layerTime)
    ? withYValue
    : toggleTransformKeyframe(withYValue, "transform.position.y", layerTime, position.y);
}

export function updatePositionSpatialHandleAtTime(
  layer: TimelineLayer,
  layerTime: number,
  handle: "in" | "out",
  tangent: { x: number; y: number },
  linked: boolean
): TimelineLayer {
  const withPositionKeyframes = updatePositionKeyframesAtTime(layer, layerTime, positionFromLayerAtTime(layer, layerTime));
  const mirrored = { x: -tangent.x, y: -tangent.y };
  return {
    ...withPositionKeyframes,
    animations: (withPositionKeyframes.animations ?? []).map((kf) =>
      kf.target.scope === "layer" &&
      (kf.target.property === "transform.position.x" || kf.target.property === "transform.position.y") &&
      isKeyframeAt(kf.timeSeconds, layerTime)
        ? {
            ...kf,
            spatial: {
              ...(kf.spatial ?? { interpolation: "bezier" as const }),
              interpolation: "bezier" as const,
              [handle === "in" ? "inTangent" : "outTangent"]: tangent,
              ...(linked ? { [handle === "in" ? "outTangent" : "inTangent"]: mirrored } : {}),
              linked
            }
          }
        : kf
    )
  };
}

export function positionFromLayerAtTime(layer: TimelineLayer, layerTime: number) {
  const transform = evaluateTimelineTransform({
    transform: layer.transform,
    startSeconds: layer.startSeconds,
    keyframes: layer.keyframes,
    animations: layer.animations,
    timeSeconds: layer.startSeconds + layerTime
  });
  return transform.position;
}

// ---------------------------------------------------------------------------
// Effect param keyframe mutations
// ---------------------------------------------------------------------------

export function updateEffectParamAtTime(
  layer: TimelineLayer,
  effectId: string,
  paramKey: string,
  layerTime: number,
  value: number
): TimelineLayer {
  if (!getActiveEffectParamKeyframe(layer, effectId, paramKey, layerTime)) {
    return {
      ...layer,
      effects: layer.effects.map((effect) =>
        effect.id === effectId
          ? { ...effect, params: { ...(effect.params ?? {}), [paramKey]: value } }
          : effect
      )
    };
  }

  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) =>
      kf.target.scope === "effect" &&
      kf.target.effectId === effectId &&
      kf.target.property === paramKey &&
      isKeyframeAt(kf.timeSeconds, layerTime)
        ? { ...kf, value }
        : kf
    )
  };
}

export function toggleEffectParamKeyframe(
  layer: TimelineLayer,
  effectId: string,
  paramKey: string,
  layerTime: number,
  value: number
): TimelineLayer {
  if (getActiveEffectParamKeyframe(layer, effectId, paramKey, layerTime)) {
    return {
      ...layer,
      animations: (layer.animations ?? []).filter(
        (kf) =>
          !(
            kf.target.scope === "effect" &&
            kf.target.effectId === effectId &&
            kf.target.property === paramKey &&
            isKeyframeAt(kf.timeSeconds, layerTime)
          )
      )
    };
  }

  const keyframe: TimelineKeyframeV2 = {
    id: `kf_${Date.now()}_${effectId}_${paramKey}`,
    target: { scope: "effect", effectId, property: paramKey },
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

export function setEffectParamInterpolation(
  layer: TimelineLayer,
  effectId: string,
  paramKey: string,
  layerTime: number,
  interpolation: KeyframeInterpolation
): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) =>
      kf.target.scope === "effect" &&
      kf.target.effectId === effectId &&
      kf.target.property === paramKey &&
      isKeyframeAt(kf.timeSeconds, layerTime)
        ? { ...kf, interpolation }
        : kf
    )
  };
}

// ---------------------------------------------------------------------------
// Graph target helpers (unified transform + effect param)
// ---------------------------------------------------------------------------

export function getEffectParamBaseValue(
  layer: TimelineLayer,
  effectId: string,
  paramKey: string,
  fallback: number
) {
  const effect = layer.effects.find((item) => item.id === effectId);
  const value = effect?.params?.[paramKey];
  return typeof value === "number" ? value : fallback;
}

export function graphTargetKey(target: GraphTarget) {
  return target.kind === "transform"
    ? `transform:${target.property}`
    : `effect:${target.effectId}:${target.property}`;
}

export function shortKeyframeProperty(property: string) {
  if (property === "transform.position.x") return "X";
  if (property === "transform.position.y") return "Y";
  if (property === "transform.scale") return "Scale";
  if (property === "transform.rotation") return "Rotate";
  if (property === "transform.opacity") return "Opacity";
  if (property === "textRevealProgress") return "Reveal";
  return property;
}

export function interpolationLabel(interpolation: KeyframeInterpolation) {
  return interpolationOptions.find((option) => option.value === interpolation)?.label ?? interpolation;
}

export function buildEffectGraphTargets(layer: TimelineLayer): GraphTarget[] {
  return layer.effects.flatMap((effect) => {
    const normalizedEffect = normalizeTimelineEffect(effect);
    const definition = getTimelineEffectDefinition(normalizedEffect.type);
    return (definition?.params ?? [])
      .filter(
        (param): param is Extract<TimelineEffectParamDefinition, { type: "number" }> =>
          param.type === "number" && Boolean(param.keyframeable)
      )
      .map((param) => ({
        effectId: normalizedEffect.id,
        kind: "effect" as const,
        label: `${normalizedEffect.name} · ${param.label}`,
        max: param.max,
        min: param.min,
        property: param.key,
        step: param.step
      }));
  });
}

export function updateGraphTargetKeyframe(
  layer: TimelineLayer,
  target: GraphTarget,
  keyframeId: string,
  patch: { timeSeconds?: number | undefined; value?: number | undefined }
): TimelineLayer {
  if (target.kind === "transform") {
    return updateTransformKeyframe(layer, target.property, keyframeId, patch);
  }

  return {
    ...layer,
    animations: (layer.animations ?? [])
      .map((kf) =>
        kf.id === keyframeId
          ? {
              ...kf,
              timeSeconds: clamp(patch.timeSeconds ?? kf.timeSeconds, 0, layer.durationSeconds),
              value: patch.value ?? (kf.value as number)
            }
          : kf
      )
      .sort((a, b) => a.timeSeconds - b.timeSeconds)
  };
}

export function setGraphTargetInterpolation(
  layer: TimelineLayer,
  target: GraphTarget,
  keyframeId: string,
  interpolation: KeyframeInterpolation
): TimelineLayer {
  if (target.kind === "transform") {
    const layerWithAnimation = (layer.animations ?? []).some((item) => item.id === keyframeId)
      ? layer
      : updateTransformKeyframe(layer, target.property, keyframeId, {});

    return {
      ...layerWithAnimation,
      animations: (layerWithAnimation.animations ?? []).map((kf) =>
        kf.id === keyframeId ? { ...kf, interpolation } : kf
      )
    };
  }

  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) =>
      kf.id === keyframeId ? { ...kf, interpolation } : kf
    )
  };
}

export function updateGraphTargetHandle(
  layer: TimelineLayer,
  target: GraphTarget,
  keyframeId: string,
  handle: "in" | "out",
  nextHandle: { dx: number; dy: number },
  linked: boolean
): TimelineLayer {
  if (target.kind === "transform") {
    return updateTransformKeyframeHandle(layer, target.property, keyframeId, handle, nextHandle, linked);
  }

  const mirroredHandle = { dx: -nextHandle.dx, dy: -nextHandle.dy };
  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) =>
      kf.id === keyframeId
        ? {
            ...kf,
            interpolation: "bezier" as const,
            temporal: {
              ...kf.temporal,
              [handle]: nextHandle,
              ...(linked ? { [handle === "in" ? "out" : "in"]: mirroredHandle } : {}),
              linked
            }
          }
        : kf
    )
  };
}

export function setGraphTargetLinked(
  layer: TimelineLayer,
  target: GraphTarget,
  keyframeId: string,
  linked: boolean
): TimelineLayer {
  if (target.kind === "transform") {
    return setTransformKeyframeLinked(layer, target.property, keyframeId, linked);
  }

  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) =>
      kf.id === keyframeId ? { ...kf, temporal: { ...kf.temporal, linked } } : kf
    )
  };
}

// ---------------------------------------------------------------------------
// Animation presets
// ---------------------------------------------------------------------------

function makeKeyframe(
  presetId: string,
  property: string,
  timeSeconds: number,
  value: number,
  duration: number,
  interpolation: KeyframeInterpolation = "easeOut"
): TimelineKeyframeV2 {
  return {
    id: `kf_${Date.now()}_${presetId}_${property.replaceAll(".", "_")}_${Math.round(timeSeconds * 1000)}`,
    target: { scope: "layer", property },
    timeSeconds: clamp(timeSeconds, 0, duration),
    value,
    interpolation,
    temporal: {}
  };
}

export function applyAnimationPreset(layer: TimelineLayer, presetId: AnimationPresetId): TimelineLayer {
  const duration = Math.max(0.5, layer.durationSeconds);
  const short = Math.min(0.6, duration * 0.35);
  const middle = duration * 0.5;
  const base = layer.transform;

  const add = (
    property: TransformAnimationProperty,
    timeSeconds: number,
    value: number,
    interpolation: KeyframeInterpolation = "easeOut"
  ): TimelineKeyframeV2 =>
    makeKeyframe(presetId, property, timeSeconds, value, duration, interpolation);

  let keyframes: TimelineKeyframeV2[] = [];

  if (presetId === "popIn") {
    keyframes = [
      add("transform.scale", 0, Math.max(0.2, base.scale * 0.72), "easeOut"),
      add("transform.scale", short, base.scale * 1.06, "easeOut"),
      add("transform.scale", short * 1.55, base.scale, "easeInOut"),
      add("transform.opacity", 0, 0, "easeOut"),
      add("transform.opacity", short, base.opacity, "linear")
    ];
  } else if (presetId === "smoothSlide") {
    keyframes = [
      add("transform.position.x", 0, base.position.x - 22, "easeOut"),
      add("transform.position.x", Math.min(1, duration), base.position.x, "easeOut"),
      add("transform.opacity", 0, 0, "easeOut"),
      add("transform.opacity", Math.min(0.45, duration), base.opacity, "linear")
    ];
  } else if (presetId === "drift") {
    keyframes = [
      add("transform.position.x", 0, base.position.x - 4, "easeInOut"),
      add("transform.position.x", duration, base.position.x + 4, "easeInOut"),
      add("transform.position.y", 0, base.position.y + 2, "easeInOut"),
      add("transform.position.y", duration, base.position.y - 2, "easeInOut")
    ];
  } else if (presetId === "zoomPulse") {
    keyframes = [
      add("transform.scale", 0, base.scale, "easeInOut"),
      add("transform.scale", middle, base.scale * 1.12, "easeInOut"),
      add("transform.scale", duration, base.scale, "easeInOut")
    ];
  } else if (presetId === "bounce") {
    keyframes = [
      add("transform.position.y", 0, base.position.y + 16, "easeOut"),
      add("transform.position.y", short, base.position.y - 5, "easeInOut"),
      add("transform.position.y", short * 1.8, base.position.y + 2, "easeInOut"),
      add("transform.position.y", short * 2.4, base.position.y, "easeOut")
    ];
  } else if (presetId === "fadeInOut") {
    keyframes = [
      add("transform.opacity", 0, 0, "linear"),
      add("transform.opacity", Math.min(0.45, duration * 0.2), base.opacity, "linear"),
      add("transform.opacity", Math.max(0.5, duration - Math.min(0.45, duration * 0.2)), base.opacity, "linear"),
      add("transform.opacity", duration, 0, "linear")
    ];
  } else if (presetId === "typewriter") {
    // Reveals text characters left-to-right over the first 80% of the layer,
    // then holds at full reveal. Only meaningful for text layers — the renderers
    // read textRevealProgress (0–1) and slice visible characters.
    const revealEnd = Math.min(duration * 0.8, duration);
    keyframes = [
      makeKeyframe(presetId, "textRevealProgress", 0, 0, duration, "linear"),
      makeKeyframe(presetId, "textRevealProgress", revealEnd, 1, duration, "linear")
    ];
  }

  const properties = new Set(keyframes.map((kf) => kf.target.property));
  return {
    ...layer,
    animations: [
      ...(layer.animations ?? []).filter(
        (kf) => !(kf.target.scope === "layer" && properties.has(kf.target.property))
      ),
      ...keyframes
    ].sort((a, b) => a.timeSeconds - b.timeSeconds)
  };
}

// evaluateTextRevealProgress, sliceTextRuns, getVisibleTextRuns re-exported from @reelforge/shared above.
