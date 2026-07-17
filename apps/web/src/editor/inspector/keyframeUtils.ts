import {
  evaluateAnimatedValue,
  evaluateTimelineTransform,
  evaluateTimelineEffectParam,
  getLayerAnimations,
  getTimelineEffectDefinition,
  normalizeTimelineEffect,
  resolveGraphicAnimation,
  GRAPHIC_DURATION_PROPERTY,
  GRAPHIC_PROGRESS_PROPERTY,
  type KeyframeInterpolation,
  type SourceTextKeyframe,
  type TextRun,
  type TimelineKeyframeV2,
  type TimelineLayer,
  type TimelineEffectParamDefinition
} from "@kimera-by-aelivion/shared";
export { evaluateTextRevealProgress, sliceTextRuns, getVisibleTextRuns } from "@kimera-by-aelivion/shared";

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
      /** Draw/edit this curve with an inverted Y axis (position.y: canvas percent grows DOWNWARD,
       *  so "drag the curve up = clip moves up" needs the graph band flipped). */
      invertY?: boolean;
    }
  | {
      effectId: string;
      kind: "effect";
      label: string;
      max: number;
      min: number;
      property: string;
      step: number;
    }
  | {
      /** SOURCE TEXT (Premiere-style): hold keys on `layer.sourceTextKeyframes` — a flat lane in
       *  the graph (no value curve); keys can be moved in time, added, and deleted. */
      kind: "sourceText";
      label: string;
      max: number;
      min: number;
      property: string;
      step: number;
    }
  | {
      /** Generic layer-scope numeric track in `layer.animations` (e.g. `textRevealProgress` — the
       *  Typewriter reveal — or the `style.*` text-style tracks). Full curve editing. */
      kind: "layer";
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
  invertY?: boolean;
}> = [
  // Position range matches the inspector's scrub fields (-200..300): off-canvas positions are
  // legitimate (slide-in/out animations) — the old 0..100 clamp blocked graph drags below 0.
  { label: "X", property: "transform.position.x", min: -200, max: 300, step: 1 },
  // invertY: position.y percent grows DOWNWARD on the canvas, so without the flip "dragging the
  // curve up" moved the clip DOWN — the reported inverted Y feel. The flag flips draw + drag + hit
  // consistently (see curveNorm/curveValue in graph-scene.ts).
  { label: "Y", property: "transform.position.y", min: -200, max: 300, step: 1, invertY: true },
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
  { id: "roll", label: "Roll (credits)", textOnly: true },
  { id: "crawl", label: "Crawl (ticker)", textOnly: true },
  { id: "typewriter", label: "Typewriter", textOnly: true }
] as const;

export type AnimationPresetId = (typeof animationPresets)[number]["id"];

// ---------------------------------------------------------------------------
// Micro-utils (private to this module, re-exported for graph editor)
// ---------------------------------------------------------------------------

/**
 * Mint a collision-free keyframe id. `Date.now()` alone collides when several keyframes are
 * created in the same millisecond — which is exactly what a multiselect broadcast does (one
 * toggle → one mint per selected layer in the same tick). The graph editor selects/scrubs purely
 * by keyframe id, so cross-layer duplicates made selection ambiguous.
 */
export function mintKeyframeId(suffix: string): string {
  return `kf_${Date.now()}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
}

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

/**
 * The nearest keyframe strictly before (`direction: -1`) or after (`direction: 1`) `layerTime` — the
 * single implementation behind every `find*Keyframe` prev/next lookup (transform, effect param,
 * content, layer property, style, mask).
 *
 * Returns the KEYFRAME, never its `timeSeconds`. A keyframe at layer-local time 0 — the clip's first
 * frame, where the first key of most ramps lives — is a perfectly valid hit, but `0` is falsy, so a
 * time-returning API silently reports "no keyframe" under `Boolean(...)`/`if (t)` and disables the
 * nav button that should jump to it. An object is truthy whenever it exists, so the check callers
 * reach for first is the correct one. Callers wanting the time take `?.timeSeconds`.
 */
export function findKeyframeIn<T extends { timeSeconds: number }>(
  keyframes: T[],
  layerTime: number,
  direction: -1 | 1
): T | undefined {
  if (direction < 0) {
    return [...keyframes].reverse().find((kf) => kf.timeSeconds < layerTime - keyframeTimeTolerance);
  }
  return keyframes.find((kf) => kf.timeSeconds > layerTime + keyframeTimeTolerance);
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

export function findTransformKeyframe(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  layerTime: number,
  direction: -1 | 1
) {
  return findKeyframeIn(getTransformKeyframes(layer, property), layerTime, direction);
}

/** Effect-param counterpart of findTransformKeyframe — same prev/next lookup, keyed by effect+param instead of a transform property. */
export function findEffectParamKeyframe(
  layer: TimelineLayer,
  effectId: string,
  paramKey: string,
  layerTime: number,
  direction: -1 | 1
) {
  return findKeyframeIn(getEffectParamKeyframes(layer, effectId, paramKey), layerTime, direction);
}

/** Effect-param counterpart of clearTransformKeyframes. */
export function clearEffectParamKeyframes(layer: TimelineLayer, effectId: string, paramKey: string): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).filter(
      (kf) => !(kf.target.scope === "effect" && kf.target.effectId === effectId && kf.target.property === paramKey)
    )
  };
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
    id: mintKeyframeId(property.replaceAll(".", "_")),
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
    id: mintKeyframeId(`${effectId}_${paramKey}`),
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
// Auto-keyframe write semantics (the single "where does an edit land" rule)
// ---------------------------------------------------------------------------

export interface AutoKeyframeOptions {
  /** When true, editing a not-yet-animated property drops its first keyframe at the playhead. */
  autoKeyframe?: boolean | undefined;
}

/**
 * Route a transform value edit to the correct place, matching After Effects / Premiere:
 *  - keyframe at the playhead        → update it in place
 *  - property already animated       → INSERT a keyframe at the playhead
 *    (fixes the old bug where such edits wrote to the ignored base field and did nothing)
 *  - auto-keyframe mode ON           → INSERT the property's first keyframe at the playhead
 *  - otherwise                       → set the static base value
 */
export function applyTransformValueAtTime(
  layer: TimelineLayer,
  property: TransformAnimationProperty,
  layerTime: number,
  value: number,
  options: AutoKeyframeOptions = {}
): TimelineLayer {
  const hasKeyframeAtPlayhead = hasTransformKeyframeAt(layer, property, layerTime);
  const isAnimated = getTransformKeyframes(layer, property).length > 0;
  if (!hasKeyframeAtPlayhead && (isAnimated || options.autoKeyframe)) {
    return toggleTransformKeyframe(layer, property, layerTime, value);
  }
  return updateTransformPropertyAtTime(layer, property, layerTime, value);
}

/** Effect-param counterpart of {@link applyTransformValueAtTime} — same four-way rule. */
export function applyEffectParamValueAtTime(
  layer: TimelineLayer,
  effectId: string,
  paramKey: string,
  layerTime: number,
  value: number,
  options: AutoKeyframeOptions = {}
): TimelineLayer {
  const hasKeyframeAtPlayhead = Boolean(getActiveEffectParamKeyframe(layer, effectId, paramKey, layerTime));
  const isAnimated = getEffectParamKeyframes(layer, effectId, paramKey).length > 0;
  if (!hasKeyframeAtPlayhead && (isAnimated || options.autoKeyframe)) {
    return toggleEffectParamKeyframe(layer, effectId, paramKey, layerTime, value);
  }
  return updateEffectParamAtTime(layer, effectId, paramKey, layerTime, value);
}

// ---------------------------------------------------------------------------
// Content transform (source-within-frame pan/zoom/crop) keyframes — layer-scope V2 only
// (no legacy equivalent). Base values live on `layer.content`; the shared evaluator reads
// `content.*` keyframes in getCompositionContentTransform so all three renderers stay aligned.
// ---------------------------------------------------------------------------

export type ContentAnimationProperty =
  | "content.scale"
  | "content.offsetX"
  | "content.offsetY"
  | "content.crop.top"
  | "content.crop.right"
  | "content.crop.bottom"
  | "content.crop.left";

export function getContentBaseValue(layer: TimelineLayer, property: ContentAnimationProperty): number {
  const c = layer.content ?? {};
  switch (property) {
    case "content.scale":
      return c.scale ?? 1;
    case "content.offsetX":
      return c.offsetX ?? 0;
    case "content.offsetY":
      return c.offsetY ?? 0;
    case "content.crop.top":
      return c.crop?.top ?? 0;
    case "content.crop.right":
      return c.crop?.right ?? 0;
    case "content.crop.bottom":
      return c.crop?.bottom ?? 0;
    case "content.crop.left":
      return c.crop?.left ?? 0;
    default:
      return 0;
  }
}

function setContentBaseValue(layer: TimelineLayer, property: ContentAnimationProperty, value: number): TimelineLayer {
  const c = layer.content ?? {};
  if (property.startsWith("content.crop.")) {
    const edge = property.slice("content.crop.".length) as "top" | "right" | "bottom" | "left";
    return { ...layer, content: { ...c, crop: { ...(c.crop ?? {}), [edge]: value } } };
  }
  const field = property.slice("content.".length) as "scale" | "offsetX" | "offsetY";
  return { ...layer, content: { ...c, [field]: value } };
}

export function getContentKeyframes(layer: TimelineLayer, property: ContentAnimationProperty) {
  return (layer.animations ?? [])
    .filter((kf) => kf.target.scope === "layer" && kf.target.property === property)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
}

export function getActiveContentKeyframe(layer: TimelineLayer, property: ContentAnimationProperty, layerTime: number) {
  return getContentKeyframes(layer, property).find((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
}

export function findContentKeyframe(
  layer: TimelineLayer,
  property: ContentAnimationProperty,
  layerTime: number,
  direction: -1 | 1
) {
  return findKeyframeIn(getContentKeyframes(layer, property), layerTime, direction);
}

export function clearContentKeyframes(layer: TimelineLayer, property: ContentAnimationProperty): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).filter(
      (kf) => !(kf.target.scope === "layer" && kf.target.property === property)
    )
  };
}

export function toggleContentKeyframe(
  layer: TimelineLayer,
  property: ContentAnimationProperty,
  layerTime: number,
  value: number
): TimelineLayer {
  if (getActiveContentKeyframe(layer, property, layerTime)) {
    return {
      ...layer,
      animations: (layer.animations ?? []).filter(
        (kf) => !(kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime))
      )
    };
  }
  const keyframe: TimelineKeyframeV2 = {
    id: mintKeyframeId(property.replaceAll(".", "_")),
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

/** Four-way content write — same auto-keyframe rule as {@link applyTransformValueAtTime}. */
export function applyContentValueAtTime(
  layer: TimelineLayer,
  property: ContentAnimationProperty,
  layerTime: number,
  value: number,
  options: AutoKeyframeOptions = {}
): TimelineLayer {
  const hasKeyframeAtPlayhead = Boolean(getActiveContentKeyframe(layer, property, layerTime));
  const isAnimated = getContentKeyframes(layer, property).length > 0;
  if (!hasKeyframeAtPlayhead && (isAnimated || options.autoKeyframe)) {
    return toggleContentKeyframe(layer, property, layerTime, value);
  }
  if (hasKeyframeAtPlayhead) {
    return {
      ...layer,
      animations: (layer.animations ?? []).map((kf) =>
        kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime)
          ? { ...kf, value }
          : kf
      )
    };
  }
  return setContentBaseValue(layer, property, value);
}

// ---------------------------------------------------------------------------
// Generic layer-scope NUMERIC keyframes (V2 only, no legacy equivalent) — same shape as the
// `content.*` helpers above, but the base value lives wherever the caller keeps it (so a property
// whose base isn't on `layer.content` can still be keyframed). Used by the animated-graphic
// `graphicProgress` / `graphicDuration` rows. Times are LAYER-LOCAL, like every other V2 keyframe.
// ---------------------------------------------------------------------------

export function getLayerPropertyKeyframes(layer: TimelineLayer, property: string) {
  return (layer.animations ?? [])
    .filter((kf) => kf.target.scope === "layer" && kf.target.property === property)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
}

export function getActiveLayerPropertyKeyframe(layer: TimelineLayer, property: string, layerTime: number) {
  return getLayerPropertyKeyframes(layer, property).find((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
}

export function findLayerPropertyKeyframe(layer: TimelineLayer, property: string, layerTime: number, direction: -1 | 1) {
  return findKeyframeIn(getLayerPropertyKeyframes(layer, property), layerTime, direction);
}

export function clearLayerPropertyKeyframes(layer: TimelineLayer, property: string): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).filter((kf) => !(kf.target.scope === "layer" && kf.target.property === property))
  };
}

export function toggleLayerPropertyKeyframe(layer: TimelineLayer, property: string, layerTime: number, value: number): TimelineLayer {
  if (getActiveLayerPropertyKeyframe(layer, property, layerTime)) {
    return {
      ...layer,
      animations: (layer.animations ?? []).filter(
        (kf) => !(kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime))
      )
    };
  }
  const keyframe: TimelineKeyframeV2 = {
    id: mintKeyframeId(property.replaceAll(".", "_")),
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

/** Set the interpolation of the layer-property keyframe at the playhead (the diamond menu's action). */
export function setLayerPropertyKeyframeInterpolation(
  layer: TimelineLayer,
  property: string,
  layerTime: number,
  interpolation: KeyframeInterpolation
): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) =>
      kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime)
        ? { ...kf, interpolation }
        : kf
    )
  };
}

/**
 * Four-way layer-property write — same auto-keyframe rule as {@link applyTransformValueAtTime}. When the
 * property is un-keyframed the value goes to the caller's own base storage via `setBase`.
 */
export function applyLayerPropertyValueAtTime(
  layer: TimelineLayer,
  property: string,
  layerTime: number,
  value: number,
  setBase: (layer: TimelineLayer, value: number) => TimelineLayer,
  options: AutoKeyframeOptions = {}
): TimelineLayer {
  const hasKeyframeAtPlayhead = Boolean(getActiveLayerPropertyKeyframe(layer, property, layerTime));
  const isAnimated = getLayerPropertyKeyframes(layer, property).length > 0;
  if (!hasKeyframeAtPlayhead && (isAnimated || options.autoKeyframe)) {
    return toggleLayerPropertyKeyframe(layer, property, layerTime, value);
  }
  if (hasKeyframeAtPlayhead) {
    return {
      ...layer,
      animations: (layer.animations ?? []).map((kf) =>
        kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime)
          ? { ...kf, value }
          : kf
      )
    };
  }
  return setBase(layer, value);
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
  if (target.kind === "transform") return `transform:${target.property}`;
  if (target.kind === "sourceText") return "sourceText";
  if (target.kind === "layer") return `layer:${target.property}`;
  return `effect:${target.effectId}:${target.property}`;
}

/**
 * Animated-graphic lanes — only for a layer whose graphic actually carries SMIL (a static SVG has no
 * phase to curve). Progress is in CYCLES (1 = one full loop) and Duration is the cycle length the
 * phase integrates over; keying Progress supersedes Duration, exactly as in the Graphic inspector.
 *
 * Ranges/steps MIRROR the Graphic panel's rows on purpose: the graph clamps drags with `min`/`max`,
 * so a lane that clamped differently from its inspector row would let one surface author a value the
 * other refuses to show.
 */
export function buildGraphicGraphTargets(layer: TimelineLayer): GraphTarget[] {
  if (!resolveGraphicAnimation(layer.graphic, { animations: layer.animations })) {
    return [];
  }
  return [
    { kind: "layer", label: "Progress", min: -100, max: 100, property: GRAPHIC_PROGRESS_PROPERTY, step: 0.01 },
    { kind: "layer", label: "Duration", min: 0.05, max: 60, property: GRAPHIC_DURATION_PROPERTY, step: 0.05 }
  ];
}

/** Typewriter reveal lane (`textRevealProgress` 0..1) — shows when the preset wrote keys. */
export const typewriterGraphTarget: GraphTarget = {
  kind: "layer",
  label: "Typewriter reveal",
  min: 0,
  max: 1,
  property: "textRevealProgress",
  step: 0.05
};

/** The single source-text graph lane (text layers). */
export const sourceTextGraphTarget: GraphTarget = {
  kind: "sourceText",
  label: "Source Text",
  min: 0,
  max: 1,
  property: "sourceText",
  step: 1
};

/** Source-text keys as pseudo keyframes (hold, value 0) so the graph machinery can draw/move them. */
export function sourceTextTargetKeyframes(layer: TimelineLayer): TimelineKeyframeV2[] {
  return [...(layer.sourceTextKeyframes ?? [])]
    .sort((a, b) => a.timeSeconds - b.timeSeconds)
    .map((key) => ({
      id: key.id,
      target: { scope: "layer", property: "sourceText" },
      timeSeconds: key.timeSeconds,
      value: 0,
      interpolation: "hold" as const,
      temporal: {}
    }));
}

/** Add/remove a source-text key at `layerTime` (hold; adding captures the text governing that time). */
export function toggleSourceTextKeyframe(layer: TimelineLayer, layerTime: number): TimelineLayer {
  const keys = layer.sourceTextKeyframes ?? [];
  const existing = keys.find((key) => isKeyframeAt(key.timeSeconds, layerTime));
  if (existing) {
    const remaining = keys.filter((key) => key.id !== existing.id);
    return { ...layer, sourceTextKeyframes: remaining.length ? remaining : undefined };
  }
  const ordered = [...keys].sort((a, b) => a.timeSeconds - b.timeSeconds);
  let governing = ordered[0];
  for (const key of ordered) {
    if (key.timeSeconds <= layerTime + keyframeTimeTolerance) governing = key;
    else break;
  }
  const runs: TextRun[] = governing
    ? governing.runs.map((run) => ({ ...run }))
    : layer.textRuns?.length
      ? layer.textRuns.map((run) => ({ ...run }))
      : [{ text: layer.text ?? "" }];
  const captured: SourceTextKeyframe = {
    id: `stk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    timeSeconds: clamp(layerTime, 0, layer.durationSeconds),
    runs
  };
  return { ...layer, sourceTextKeyframes: [...keys, captured].sort((a, b) => a.timeSeconds - b.timeSeconds) };
}

export function shortKeyframeProperty(property: string) {
  if (property === "transform.position.x") return "X";
  if (property === "transform.position.y") return "Y";
  if (property === "transform.scale") return "Scale";
  if (property === "transform.rotation") return "Rotate";
  if (property === "transform.opacity") return "Opacity";
  if (property === "textRevealProgress") return "Reveal";
  if (property === GRAPHIC_PROGRESS_PROPERTY) return "Progress";
  if (property === GRAPHIC_DURATION_PROPERTY) return "Duration";
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
  if (target.kind === "sourceText") {
    // Hold lane: only TIME moves (value drags are meaningless for text keys).
    if (patch.timeSeconds === undefined) return layer;
    return {
      ...layer,
      sourceTextKeyframes: (layer.sourceTextKeyframes ?? [])
        .map((key) => (key.id === keyframeId ? { ...key, timeSeconds: clamp(patch.timeSeconds!, 0, layer.durationSeconds) } : key))
        .sort((a, b) => a.timeSeconds - b.timeSeconds)
    };
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
  if (target.kind === "sourceText") return layer; // hold-only lane
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
  if (target.kind === "sourceText") return layer; // hold-only lane
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
  if (target.kind === "sourceText") return layer; // hold-only lane
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
// Text-style keyframes (scope "layer", property "style.<field>") — evaluated by
// getCompositionTextStyle's animStyleNumber in every renderer (2026-07-12).
// ---------------------------------------------------------------------------

/** The flat layer field a `style.<field>` keyframe track shadows (its static base value). */
function styleFieldOf(property: string): keyof TimelineLayer {
  return property.slice("style.".length) as keyof TimelineLayer;
}

export function getStyleKeyframes(layer: TimelineLayer, property: string) {
  return (layer.animations ?? [])
    .filter((kf) => kf.target.scope === "layer" && kf.target.property === property)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
}

export function hasStyleKeyframeAt(layer: TimelineLayer, property: string, layerTime: number) {
  return getStyleKeyframes(layer, property).some((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
}

export function getActiveStyleKeyframe(layer: TimelineLayer, property: string, layerTime: number) {
  return getStyleKeyframes(layer, property).find((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
}

export function findStyleKeyframe(layer: TimelineLayer, property: string, layerTime: number, direction: -1 | 1) {
  return findKeyframeIn(getStyleKeyframes(layer, property), layerTime, direction);
}

export function toggleStyleKeyframe(layer: TimelineLayer, property: string, layerTime: number, value: number): TimelineLayer {
  if (hasStyleKeyframeAt(layer, property, layerTime)) {
    return {
      ...layer,
      animations: (layer.animations ?? []).filter(
        (kf) => !(kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime))
      )
    };
  }
  const keyframe: TimelineKeyframeV2 = {
    id: mintKeyframeId(property.replaceAll(".", "_")),
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

export function setStyleKeyframeInterpolation(
  layer: TimelineLayer,
  property: string,
  layerTime: number,
  interpolation: KeyframeInterpolation
): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) =>
      kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime)
        ? { ...kf, interpolation }
        : kf
    )
  };
}

export function clearStyleKeyframes(layer: TimelineLayer, property: string): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).filter((kf) => !(kf.target.scope === "layer" && kf.target.property === property))
  };
}

/** The style track's value at the playhead (the flat field's base when unanimated) — for row display. */
export function styleValueAt(layer: TimelineLayer, property: string, layerTime: number, base: number): number {
  const keyframes = getStyleKeyframes(layer, property);
  if (!keyframes.length) return base;
  return evaluateAnimatedValue({ baseValue: base, keyframes, property, scope: "layer", timeSeconds: layerTime }) as number;
}

/** Four-way style write — same auto-keyframe rule as {@link applyTransformValueAtTime}; the
 *  static branch writes the flat layer field the track shadows (e.g. `letterSpacing`). */
export function applyStyleValueAtTime(
  layer: TimelineLayer,
  property: string,
  layerTime: number,
  value: number,
  options: AutoKeyframeOptions = {}
): TimelineLayer {
  const hasKeyframeAtPlayhead = hasStyleKeyframeAt(layer, property, layerTime);
  const isAnimated = getStyleKeyframes(layer, property).length > 0;
  if (!hasKeyframeAtPlayhead && (isAnimated || options.autoKeyframe)) {
    return toggleStyleKeyframe(layer, property, layerTime, value);
  }
  if (hasKeyframeAtPlayhead) {
    return {
      ...layer,
      animations: (layer.animations ?? []).map((kf) =>
        kf.target.scope === "layer" && kf.target.property === property && isKeyframeAt(kf.timeSeconds, layerTime)
          ? { ...kf, value }
          : kf
      )
    };
  }
  return { ...layer, [styleFieldOf(property)]: value };
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
    id: mintKeyframeId(`${presetId}_${property.replaceAll(".", "_")}_${Math.round(timeSeconds * 1000)}`),
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
  } else if (presetId === "roll") {
    // Premiere-style credits ROLL: enters from below the frame, exits above, linear speed across
    // the WHOLE clip. Off-canvas positions are legal (graph/inspector allow -200..300), and no
    // renderer clamps position — the text simply travels through the frame.
    keyframes = [
      add("transform.position.y", 0, 130, "linear"),
      add("transform.position.y", duration, -30, "linear")
    ];
  } else if (presetId === "crawl") {
    // News-ticker CRAWL: enters from the right edge, exits left, linear across the whole clip.
    keyframes = [
      add("transform.position.x", 0, 130, "linear"),
      add("transform.position.x", duration, -30, "linear")
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

// evaluateTextRevealProgress, sliceTextRuns, getVisibleTextRuns re-exported from @kimera-by-aelivion/shared above.
