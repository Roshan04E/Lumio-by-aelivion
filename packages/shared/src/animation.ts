import type {
  AnimatedValue,
  KeyframeHandle,
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
  // Premiere/AE-style TWO-SIDED interpolation (2026-07-12): a segment's easing is the
  // combination of the OUTGOING keyframe's leave behavior (its out-handle / easeOut) and
  // the INCOMING keyframe's arrive behavior (its in-handle / easeIn). Previously only
  // `previous.interpolation` shaped the whole segment, so "Ease In" on a keyframe eased
  // the WRONG side (the segment after it) and bezier in-handles were ignored unless the
  // left neighbor was also bezier. Every non-hold segment now evaluates as one cubic
  // bezier whose ends are derived per keyframe:
  //   leave  (previous): bezier → temporal.out;  easeOut/easeInOut/ease/autoBezier → flat; else linear
  //   arrive (next):     bezier → temporal.in;   easeIn/easeInOut/ease/autoBezier  → flat; else linear
  // Flat (dy 0) = zero speed at the keyframe (AE Easy Ease); linear (|dy|=|dx|) keeps
  // straight-line speed on that side.
  const easeFlat = 1 / 3;
  const outHandle: KeyframeHandle =
    previous.interpolation === "bezier"
      ? previous.temporal.out ?? { dx: easeFlat, dy: 0 }
      : previous.interpolation === "easeOut" ||
          previous.interpolation === "easeInOut" ||
          previous.interpolation === "ease" ||
          previous.interpolation === "autoBezier"
        ? { dx: easeFlat, dy: 0 }
        : { dx: easeFlat, dy: easeFlat };
  const inHandle: KeyframeHandle =
    next.interpolation === "bezier"
      ? next.temporal.in ?? { dx: -easeFlat, dy: 0 }
      : next.interpolation === "easeIn" ||
          next.interpolation === "easeInOut" ||
          next.interpolation === "ease" ||
          next.interpolation === "autoBezier"
        ? { dx: -easeFlat, dy: 0 }
        : { dx: -easeFlat, dy: -easeFlat };
  const isLinearSegment =
    outHandle.dx === easeFlat && outHandle.dy === easeFlat && inHandle.dx === -easeFlat && inHandle.dy === -easeFlat;
  const progress =
    previous.interpolation === "hold"
      ? 0
      : isLinearSegment
        ? clamp(rawProgress, 0, 1)
        : bezierProgress(rawProgress, outHandle, inHandle);

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

// ---------------------------------------------------------------------------
// Easing authoring helpers (2026-07-12, graph editor).
//
// PURE, ADDITIVE helpers — they never change how existing data evaluates. Each
// returns explicit `temporal` bezier handles for `interpolation: "bezier"`
// keyframes, so anything authored with them renders identically in the web
// preview and the Remotion export through the evaluator above. Handle semantics
// match `bezierProgress`: dx/dy are FRACTIONS of the neighboring segment's
// duration / value delta.
// ---------------------------------------------------------------------------

export interface TangentKeyframeSample {
  timeSeconds: number;
  value: number;
}

/**
 * Catmull-Rom style auto tangents for a keyframe between two neighbors: the
 * through-slope `(next.value − prev.value) / (next.time − prev.time)` applied to
 * both handles, overshoot-clamped so the curve stays within the neighbor values
 * (the After Effects "auto bezier" feel). Boundary keyframes (missing neighbor)
 * get a flat handle on the open side.
 */
export function computeAutoTangents(
  prev: TangentKeyframeSample | undefined,
  keyframe: TangentKeyframeSample,
  next: TangentKeyframeSample | undefined,
  influence = 1 / 3
): { in?: KeyframeHandle; out?: KeyframeHandle } {
  const slope =
    prev && next && next.timeSeconds - prev.timeSeconds > 1e-6
      ? (next.value - prev.value) / (next.timeSeconds - prev.timeSeconds)
      : 0;

  const result: { in?: KeyframeHandle; out?: KeyframeHandle } = {};
  if (prev) {
    const duration = Math.max(1e-6, keyframe.timeSeconds - prev.timeSeconds);
    const valueDelta = keyframe.value - prev.value;
    const rawDy =
      Math.abs(valueDelta) < 1e-9 ? 0 : (slope * (influence * duration)) / valueDelta;
    // Clamp so the handle never overshoots the segment's value span (monotone-safe).
    result.in = { dx: -influence, dy: -clamp(rawDy, -1, 1) };
  }
  if (next) {
    const duration = Math.max(1e-6, next.timeSeconds - keyframe.timeSeconds);
    const valueDelta = next.value - keyframe.value;
    const rawDy =
      Math.abs(valueDelta) < 1e-9 ? 0 : (slope * (influence * duration)) / valueDelta;
    result.out = { dx: influence, dy: clamp(rawDy, -1, 1) };
  }
  return result;
}

/**
 * AE-style easing preset handles. `influencePct` is the classic Easy Ease 33%.
 * A flat handle (dy 0) means zero speed at the keyframe; dy = dx keeps the
 * segment linear on that side.
 */
export function easyEaseHandles(
  kind: "both" | "in" | "out",
  influencePct = 33
): { in: KeyframeHandle; out: KeyframeHandle } {
  const influence = clamp(influencePct, 1, 100) / 100;
  const flat = { dx: influence, dy: 0 };
  const linear = { dx: influence, dy: influence };
  return {
    in: kind === "out" ? { dx: -linear.dx, dy: -linear.dy } : { dx: -flat.dx, dy: -flat.dy },
    out: kind === "in" ? linear : flat
  };
}
