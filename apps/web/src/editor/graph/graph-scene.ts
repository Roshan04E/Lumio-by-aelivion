/**
 * Pure scene builder for the graph editor: turns a layer + a set of GraphTargets
 * into drawable curves — sampled polylines (through the SHARED animation evaluator,
 * so the graph shows exactly what the preview and the Remotion export render),
 * keyframe points, and bezier handle positions. Each curve normalizes its own
 * value range onto [0..1] so many properties overlay meaningfully.
 */
import {
  evaluateTimelineEffectParam,
  evaluateTimelineTransform,
  graphicAnimationPhase,
  resolveGraphicAnimation,
  GRAPHIC_DURATION_PROPERTY,
  GRAPHIC_PROGRESS_PROPERTY,
  type TimelineKeyframeV2,
  type TimelineLayer
} from "@kimera-by-aelivion/shared";
import {
  getEffectParamBaseValue,
  getEffectParamKeyframes,
  getStyleKeyframes,
  getTransformKeyframes,
  getTransformPropertyValue,
  graphTargetKey,
  sourceTextTargetKeyframes,
  styleValueAt,
  type GraphTarget
} from "../inspector/keyframeUtils";
import { normToPx, timeToPx, type GraphViewState, type PlotRect } from "./graph-view";

export interface GraphCurveScene {
  key: string;
  target: GraphTarget;
  color: string;
  /** Value normalization range for this curve (data-driven, padded). */
  vMin: number;
  vMax: number;
  /** Inverted Y band (position.y — canvas percent grows downward). Draw, drag and hit-test all
   *  route through curveNorm/curveValue, so the flip stays consistent everywhere. */
  invertY?: boolean | undefined;
  /** Sorted keyframes of this curve. */
  keyframes: TimelineKeyframeV2[];
  /** Sampled [timeSeconds, norm] pairs across the visible window. */
  samples: Array<[number, number]>;
}

export function curveNorm(curve: Pick<GraphCurveScene, "vMin" | "vMax"> & { invertY?: boolean | undefined }, value: number): number {
  const norm = (value - curve.vMin) / Math.max(1e-6, curve.vMax - curve.vMin);
  return curve.invertY ? 1 - norm : norm;
}

export function curveValue(curve: Pick<GraphCurveScene, "vMin" | "vMax"> & { invertY?: boolean | undefined }, norm: number): number {
  const effective = curve.invertY ? 1 - norm : norm;
  return curve.vMin + effective * (curve.vMax - curve.vMin);
}

function evaluateTargetValue(layer: TimelineLayer, target: GraphTarget, layerTime: number): number {
  if (target.kind === "transform") {
    const transform = evaluateTimelineTransform({
      transform: layer.transform,
      startSeconds: layer.startSeconds,
      keyframes: layer.keyframes,
      animations: layer.animations,
      timeSeconds: layer.startSeconds + layerTime
    });
    return getTransformPropertyValue(transform, target.property);
  }
  // Source text is a HOLD lane, not a value curve — draw it flat mid-band.
  if (target.kind === "sourceText") return 0;
  if (target.kind === "layer") {
    // Animated graphics: read the SHARED resolver rather than the raw keyframe track, so the lane
    // draws the phase the renderers actually run. It matters when Progress ISN'T keyed — the phase
    // then comes from the static cycle or a Duration ramp's integral, which no keyframe track holds.
    if (target.property === GRAPHIC_PROGRESS_PROPERTY || target.property === GRAPHIC_DURATION_PROPERTY) {
      const plan = resolveGraphicAnimation(layer.graphic, { animations: layer.animations });
      if (!plan) return 0;
      return target.property === GRAPHIC_PROGRESS_PROPERTY
        ? graphicAnimationPhase(plan, layerTime)
        : styleValueAt(layer, target.property, layerTime, plan.playDurationSeconds);
    }
    return styleValueAt(layer, target.property, layerTime, target.property === "textRevealProgress" ? 1 : target.min);
  }
  return evaluateTimelineEffectParam({
    animations: layer.animations,
    baseValue: getEffectParamBaseValue(layer, target.effectId, target.property, target.min),
    effectId: target.effectId,
    paramKey: target.property,
    timeSeconds: layerTime
  });
}

export function targetKeyframes(layer: TimelineLayer, target: GraphTarget): TimelineKeyframeV2[] {
  if (target.kind === "transform") return getTransformKeyframes(layer, target.property);
  if (target.kind === "sourceText") return sourceTextTargetKeyframes(layer);
  if (target.kind === "layer") return getStyleKeyframes(layer, target.property);
  return getEffectParamKeyframes(layer, target.effectId, target.property);
}

export function evaluateGraphTargetValue(layer: TimelineLayer, target: GraphTarget, layerTime: number): number {
  return evaluateTargetValue(layer, target, layerTime);
}

export function buildCurveScene(
  layer: TimelineLayer,
  target: GraphTarget,
  color: string,
  timeStart: number,
  timeEnd: number,
  sampleCount = 160,
  /** Freeze normalization to this range (used during drags so curves don't re-fit mid-gesture). */
  fixedRange?: { vMin: number; vMax: number }
): GraphCurveScene {
  const keyframes = targetKeyframes(layer, target);
  const start = Math.max(0, timeStart);
  const end = Math.min(layer.durationSeconds, Math.max(start + 1e-3, timeEnd));

  const samples: Array<[number, number]> = [];
  const rawSamples: number[] = [];
  for (let index = 0; index <= sampleCount; index += 1) {
    const t = start + ((end - start) * index) / sampleCount;
    rawSamples.push(evaluateTargetValue(layer, target, t));
  }

  // Normalization range: keyframe values ∪ sampled values (bezier overshoot shows),
  // padded 10%; a flat curve gets a symmetric band so it draws mid-plot.
  let vMin = Number.POSITIVE_INFINITY;
  let vMax = Number.NEGATIVE_INFINITY;
  for (const kf of keyframes) {
    const value = Number(kf.value);
    if (Number.isFinite(value)) {
      vMin = Math.min(vMin, value);
      vMax = Math.max(vMax, value);
    }
  }
  for (const value of rawSamples) {
    if (Number.isFinite(value)) {
      vMin = Math.min(vMin, value);
      vMax = Math.max(vMax, value);
    }
  }
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) {
    vMin = target.min;
    vMax = target.max;
  }
  if (vMax - vMin < 1e-6) {
    const pad = Math.max(Math.abs(vMin) * 0.2, target.step * 10, 1);
    vMin -= pad;
    vMax += pad;
  } else {
    const pad = (vMax - vMin) * 0.1;
    vMin -= pad;
    vMax += pad;
  }
  if (fixedRange) {
    vMin = fixedRange.vMin;
    vMax = fixedRange.vMax;
  }

  const invertY = "invertY" in target && target.invertY === true;
  const curve = { vMin, vMax, invertY };
  for (let index = 0; index <= sampleCount; index += 1) {
    const t = start + ((end - start) * index) / sampleCount;
    samples.push([t, curveNorm(curve, rawSamples[index]!)]);
  }

  return { key: graphTargetKey(target), target, color, vMin, vMax, invertY, keyframes, samples };
}

export interface GraphHandlePoint {
  timeSeconds: number;
  value: number;
  neighbor: TimelineKeyframeV2;
  storedHandle: { dx: number; dy: number };
}

/**
 * Bezier temporal handle position in curve domain — same math as the shared
 * evaluator's handle semantics (dx/dy are fractions of the segment).
 */
export function bezierHandlePoint(
  curve: GraphCurveScene,
  keyframe: TimelineKeyframeV2,
  handle: "in" | "out"
): GraphHandlePoint | undefined {
  const index = curve.keyframes.findIndex((item) => item.id === keyframe.id);
  if (index === -1) return undefined;
  const neighbor = handle === "in" ? curve.keyframes[index - 1] : curve.keyframes[index + 1];
  if (!neighbor) return undefined;
  const duration = Math.max(1e-4, Math.abs(keyframe.timeSeconds - neighbor.timeSeconds));
  const valueDelta =
    Number(handle === "in" ? keyframe.value : neighbor.value) -
    Number(handle === "in" ? neighbor.value : keyframe.value);
  const defaultHandle = handle === "in" ? { dx: -0.33, dy: -0.33 } : { dx: 0.33, dy: 0.33 };
  const storedHandle = keyframe.temporal[handle] ?? defaultHandle;
  return {
    timeSeconds: keyframe.timeSeconds + storedHandle.dx * duration,
    value: Number(keyframe.value) + storedHandle.dy * valueDelta,
    neighbor,
    storedHandle
  };
}

export type GraphHit =
  | { type: "point"; curveKey: string; keyframeId: string }
  | { type: "handle"; curveKey: string; keyframeId: string; handle: "in" | "out" }
  | { type: "curve"; curveKey: string; timeSeconds: number };

/**
 * Hit-test priority: handles of selected keyframes > points > curve strokes.
 * Coordinates in canvas px.
 */
export function hitTestScene(
  scenes: GraphCurveScene[],
  selectedIds: ReadonlySet<string>,
  view: GraphViewState,
  plot: PlotRect,
  px: number,
  py: number
): GraphHit | undefined {
  const pointRadius = 6;
  const handleRadius = 6;

  for (const curve of scenes) {
    for (const kf of curve.keyframes) {
      // Handles show for EVERY selected keyframe (AE behavior) — grabbing one on a
      // non-bezier key converts it to bezier at drag start.
      if (!selectedIds.has(kf.id)) continue;
      for (const handle of ["in", "out"] as const) {
        const point = bezierHandlePoint(curve, kf, handle);
        if (!point) continue;
        const hx = timeToPx(view, plot, point.timeSeconds);
        const hy = normToPx(view, plot, curveNorm(curve, point.value));
        if (Math.hypot(px - hx, py - hy) <= handleRadius) {
          return { type: "handle", curveKey: curve.key, keyframeId: kf.id, handle };
        }
      }
    }
  }

  let bestPoint: { hit: GraphHit; distance: number } | undefined;
  for (const curve of scenes) {
    for (const kf of curve.keyframes) {
      const kx = timeToPx(view, plot, kf.timeSeconds);
      const ky = normToPx(view, plot, curveNorm(curve, Number(kf.value)));
      const distance = Math.hypot(px - kx, py - ky);
      if (distance <= pointRadius && (!bestPoint || distance < bestPoint.distance)) {
        bestPoint = { hit: { type: "point", curveKey: curve.key, keyframeId: kf.id }, distance };
      }
    }
  }
  if (bestPoint) return bestPoint.hit;

  // Curve stroke: nearest sample within 6px vertically at this x.
  let bestCurve: { hit: GraphHit; distance: number } | undefined;
  for (const curve of scenes) {
    for (const [t, norm] of curve.samples) {
      const sx = timeToPx(view, plot, t);
      if (Math.abs(sx - px) > 5) continue;
      const sy = normToPx(view, plot, norm);
      const distance = Math.abs(sy - py);
      if (distance <= 6 && (!bestCurve || distance < bestCurve.distance)) {
        bestCurve = { hit: { type: "curve", curveKey: curve.key, timeSeconds: t }, distance };
      }
    }
  }
  return bestCurve?.hit;
}
