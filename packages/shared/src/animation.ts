import type {
  AnimatedValue,
  KeyframeHandle,
  KeyframeInterpolation,
  TimelineKeyframe,
  TimelineKeyframeV2,
  TimelineTransform
} from "./types";

export interface EvaluateAnimatedValueInput<T extends AnimatedValue> {
  baseValue: T;
  keyframes: TimelineKeyframeV2[] | undefined;
  property: string;
  scope?: "effect" | "layer" | "mask" | undefined;
  timeSeconds: number;
}

export function migrateTimelineKeyframes(keyframes: TimelineKeyframe[] | undefined, layerStartSeconds = 0): TimelineKeyframeV2[] {
  return (keyframes ?? []).map((keyframe) => ({
    id: keyframe.id,
    target: {
      scope: "layer",
      property: legacyPropertyPath(keyframe.property)
    },
    timeSeconds: Math.max(0, keyframe.timeSeconds - layerStartSeconds),
    value: keyframe.value,
    interpolation: keyframe.easing,
    temporal: {}
  }));
}

export function getLayerAnimations(layer: {
  startSeconds?: number | undefined;
  keyframes?: TimelineKeyframe[] | undefined;
  animations?: TimelineKeyframeV2[] | undefined;
}) {
  return [...migrateTimelineKeyframes(layer.keyframes, layer.startSeconds ?? 0), ...(layer.animations ?? [])];
}

export function evaluateAnimatedValue<T extends AnimatedValue>({
  baseValue,
  keyframes,
  property,
  scope = "layer",
  timeSeconds
}: EvaluateAnimatedValueInput<T>): T {
  const propertyKeyframes = (keyframes ?? [])
    .filter((keyframe) => keyframe.target.scope === scope && keyframe.target.property === property)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);

  if (!propertyKeyframes.length) {
    return baseValue;
  }

  const first = propertyKeyframes[0]!;
  if (timeSeconds <= first.timeSeconds) {
    return first.value as T;
  }

  const last = propertyKeyframes[propertyKeyframes.length - 1]!;
  if (timeSeconds >= last.timeSeconds) {
    return last.value as T;
  }

  const nextIndex = propertyKeyframes.findIndex((keyframe) => keyframe.timeSeconds >= timeSeconds);
  const previous = propertyKeyframes[Math.max(0, nextIndex - 1)]!;
  const next = propertyKeyframes[nextIndex]!;
  const duration = Math.max(0.0001, next.timeSeconds - previous.timeSeconds);
  const rawProgress = (timeSeconds - previous.timeSeconds) / duration;
  const progress =
    previous.interpolation === "hold"
      ? 0
      : previous.interpolation === "bezier"
        ? bezierProgress(rawProgress, previous.temporal.out, next.temporal.in)
        : easeProgress(rawProgress, previous.interpolation);

  return interpolateValue(previous.value, next.value, progress) as T;
}

export function evaluateTimelineEffectParam(input: {
  animations?: TimelineKeyframeV2[] | undefined;
  baseValue: number;
  effectId: string;
  paramKey: string;
  timeSeconds?: number | undefined;
}) {
  if (typeof input.timeSeconds !== "number") {
    return input.baseValue;
  }

  const keyframes = (input.animations ?? []).filter(
    (keyframe) =>
      keyframe.target.scope === "effect" &&
      keyframe.target.effectId === input.effectId &&
      keyframe.target.property === input.paramKey
  );

  return evaluateAnimatedValue({
    baseValue: input.baseValue,
    keyframes,
    property: input.paramKey,
    scope: "effect",
    timeSeconds: input.timeSeconds
  });
}

export function evaluateTimelineTransform(input: {
  transform: TimelineTransform;
  startSeconds?: number | undefined;
  keyframes?: TimelineKeyframe[] | undefined;
  animations?: TimelineKeyframeV2[] | undefined;
  timeSeconds?: number | undefined;
}): TimelineTransform {
  if (typeof input.timeSeconds !== "number") {
    return input.transform;
  }

  const animations = getLayerAnimations(input);
  const layerTimeSeconds = Math.max(0, input.timeSeconds - (input.startSeconds ?? 0));
  const position = evaluateSpatialPosition(input.transform.position, animations, layerTimeSeconds);
  return {
    position,
    scale: evaluateAnimatedValue({
      baseValue: input.transform.scale,
      keyframes: animations,
      property: "transform.scale",
      timeSeconds: layerTimeSeconds
    }),
    rotation: evaluateAnimatedValue({
      baseValue: input.transform.rotation,
      keyframes: animations,
      property: "transform.rotation",
      timeSeconds: layerTimeSeconds
    }),
    opacity: evaluateAnimatedValue({
      baseValue: input.transform.opacity,
      keyframes: animations,
      property: "transform.opacity",
      timeSeconds: layerTimeSeconds
    }),
    rotateX: evaluateAnimatedValue({
      baseValue: input.transform.rotateX ?? 0,
      keyframes: animations,
      property: "transform.rotateX",
      timeSeconds: layerTimeSeconds
    }),
    rotateY: evaluateAnimatedValue({
      baseValue: input.transform.rotateY ?? 0,
      keyframes: animations,
      property: "transform.rotateY",
      timeSeconds: layerTimeSeconds
    }),
    perspective: evaluateAnimatedValue({
      baseValue: input.transform.perspective ?? 0,
      keyframes: animations,
      property: "transform.perspective",
      timeSeconds: layerTimeSeconds
    }),
    z: evaluateAnimatedValue({
      baseValue: input.transform.z ?? 0,
      keyframes: animations,
      property: "transform.z",
      timeSeconds: layerTimeSeconds
    })
  };
}

function evaluateSpatialPosition(basePosition: TimelineTransform["position"], animations: TimelineKeyframeV2[], timeSeconds: number) {
  const xKeyframes = animations
    .filter((keyframe) => keyframe.target.scope === "layer" && keyframe.target.property === "transform.position.x")
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
  const yKeyframes = animations
    .filter((keyframe) => keyframe.target.scope === "layer" && keyframe.target.property === "transform.position.y")
    .sort((a, b) => a.timeSeconds - b.timeSeconds);

  const keyedPositions = xKeyframes
    .map((xKeyframe) => {
      const yKeyframe = yKeyframes.find((candidate) => Math.abs(candidate.timeSeconds - xKeyframe.timeSeconds) < 0.001);
      return yKeyframe
        ? {
            timeSeconds: xKeyframe.timeSeconds,
            x: Number(xKeyframe.value),
            y: Number(yKeyframe.value),
            spatial: xKeyframe.spatial ?? yKeyframe.spatial
          }
        : undefined;
    })
    .filter((point): point is NonNullable<typeof point> => Boolean(point));

  if (keyedPositions.length < 2) {
    return {
      x: evaluateAnimatedValue({
        baseValue: basePosition.x,
        keyframes: animations,
        property: "transform.position.x",
        timeSeconds
      }),
      y: evaluateAnimatedValue({
        baseValue: basePosition.y,
        keyframes: animations,
        property: "transform.position.y",
        timeSeconds
      })
    };
  }

  const first = keyedPositions[0]!;
  if (timeSeconds <= first.timeSeconds) {
    return { x: first.x, y: first.y };
  }

  const last = keyedPositions[keyedPositions.length - 1]!;
  if (timeSeconds >= last.timeSeconds) {
    return { x: last.x, y: last.y };
  }

  const nextIndex = keyedPositions.findIndex((point) => point.timeSeconds >= timeSeconds);
  const previous = keyedPositions[Math.max(0, nextIndex - 1)]!;
  const next = keyedPositions[nextIndex]!;
  const duration = Math.max(0.0001, next.timeSeconds - previous.timeSeconds);
  const progress = (timeSeconds - previous.timeSeconds) / duration;

  if (previous.spatial?.interpolation === "bezier" || next.spatial?.interpolation === "bezier") {
    const previousOut = previous.spatial?.outTangent ?? { x: (next.x - previous.x) * 0.33, y: (next.y - previous.y) * 0.33 };
    const nextIn = next.spatial?.inTangent ?? { x: (previous.x - next.x) * 0.33, y: (previous.y - next.y) * 0.33 };
    return {
      x: cubicBezier(previous.x, previous.x + previousOut.x, next.x + nextIn.x, next.x, progress),
      y: cubicBezier(previous.y, previous.y + previousOut.y, next.y + nextIn.y, next.y, progress)
    };
  }

  return {
    x: lerp(previous.x, next.x, progress),
    y: lerp(previous.y, next.y, progress)
  };
}

function legacyPropertyPath(property: TimelineKeyframe["property"]) {
  if (property === "position.x") return "transform.position.x";
  if (property === "position.y") return "transform.position.y";
  if (property === "scale") return "transform.scale";
  if (property === "rotation") return "transform.rotation";
  return "transform.opacity";
}

function easeProgress(progress: number, interpolation: KeyframeInterpolation) {
  const t = clamp(progress, 0, 1);
  if (interpolation === "easeIn") return t * t * t;
  if (interpolation === "easeOut") return 1 - (1 - t) * (1 - t) * (1 - t);
  if (interpolation === "easeInOut" || interpolation === "ease" || interpolation === "autoBezier" || interpolation === "bezier") {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  return t;
}

function bezierProgress(progress: number, outHandle: KeyframeHandle | undefined, inHandle: KeyframeHandle | undefined) {
  const x = clamp(progress, 0, 1);
  const p1 = {
    x: clamp(outHandle?.dx ?? 0.33, 0.01, 0.99),
    y: outHandle?.dy ?? 0
  };
  const p2 = {
    x: clamp(1 + (inHandle?.dx ?? -0.33), 0.01, 0.99),
    y: 1 + (inHandle?.dy ?? 0)
  };

  let low = 0;
  let high = 1;
  for (let index = 0; index < 16; index += 1) {
    const mid = (low + high) / 2;
    if (cubicBezier(0, p1.x, p2.x, 1, mid) < x) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return cubicBezier(0, p1.y, p2.y, 1, (low + high) / 2);
}

function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number) {
  const inverse = 1 - t;
  return inverse * inverse * inverse * p0 + 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t * p3;
}

function interpolateValue(from: AnimatedValue, to: AnimatedValue, progress: number): AnimatedValue {
  if (typeof from === "number" && typeof to === "number") {
    return lerp(from, to, progress);
  }

  if (isVector(from) && isVector(to)) {
    return {
      x: lerp(from.x, to.x, progress),
      y: lerp(from.y, to.y, progress)
    };
  }

  if (isColor(from) && isColor(to)) {
    return {
      r: lerp(from.r, to.r, progress),
      g: lerp(from.g, to.g, progress),
      b: lerp(from.b, to.b, progress),
      a: from.a === undefined && to.a === undefined ? undefined : lerp(from.a ?? 1, to.a ?? 1, progress)
    };
  }

  return progress < 1 ? from : to;
}

function isVector(value: AnimatedValue): value is { x: number; y: number } {
  return typeof value === "object" && value !== null && "x" in value && "y" in value;
}

function isColor(value: AnimatedValue): value is { r: number; g: number; b: number; a?: number | undefined } {
  return typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value;
}

function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
