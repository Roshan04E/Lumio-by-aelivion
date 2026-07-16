import { createTimelineEffect, type KeyframeHandle, type KeyframeInterpolation, type TimelineKeyframeV2, type TimelineLayer } from "@kimera-by-aelivion/shared";
import { getEffectParamBaseValue, getEffectParamKeyframes, mintKeyframeId } from "./inspector/keyframeUtils";

/**
 * Audio volume envelope helpers — the timeline rubber-band reads/writes the clip's `volume` effect `gain`
 * keyframes (percent, 100 = unity), the exact data `getCompositionVolume` resolves for preview + export. So
 * editing the envelope is heard live (AudioPreviewLayer's GainNode) and bakes into renders for free.
 */

/** Gain envelope range in percent: unity is 100, headroom to 200 (boost). */
export const VOLUME_MAX = 200;
export const VOLUME_UNITY = 100;
/** Default Bézier handle offsets (segment-normalized, matching the evaluator's bezierProgress defaults). */
export const VOLUME_HANDLE_OUT_DX = 0.33;
export const VOLUME_HANDLE_IN_DX = -0.33;

/** One envelope point: layer-local time (seconds) + gain (percent). `id` is the backing keyframe id. */
export interface VolumePoint {
  id: string;
  t: number;
  gain: number;
  interpolation: KeyframeInterpolation;
  temporal: { in?: KeyframeHandle | undefined; out?: KeyframeHandle | undefined };
}

const clampGain = (g: number) => Math.max(0, Math.min(VOLUME_MAX, Math.round(g)));
const clampTime = (t: number, duration: number) => Math.max(0, Math.min(duration, t));

export function getVolumeEffectId(layer: TimelineLayer): string | undefined {
  return layer.effects.find((effect) => effect.type === "volume")?.id;
}

/** The static (un-keyframed) base gain, or 100 when there's no volume effect yet. */
export function getVolumeBase(layer: TimelineLayer): number {
  const effectId = getVolumeEffectId(layer);
  return effectId ? getEffectParamBaseValue(layer, effectId, "gain", VOLUME_UNITY) : VOLUME_UNITY;
}

/** Envelope points (gain keyframes) sorted by time; empty when the gain isn't animated. */
export function getVolumePoints(layer: TimelineLayer): VolumePoint[] {
  const effectId = getVolumeEffectId(layer);
  if (!effectId) return [];
  return getEffectParamKeyframes(layer, effectId, "gain").map((kf) => ({
    id: kf.id,
    t: kf.timeSeconds,
    gain: Number(kf.value),
    interpolation: kf.interpolation,
    temporal: { in: kf.temporal?.in, out: kf.temporal?.out }
  }));
}

/** Ensure the clip has a `volume` effect, returning the (possibly new) layer + its effect id. */
function ensureVolumeEffect(layer: TimelineLayer): { layer: TimelineLayer; effectId: string } {
  const existing = getVolumeEffectId(layer);
  if (existing) return { layer, effectId: existing };
  const effect = createTimelineEffect("volume");
  return { layer: { ...layer, effects: [...layer.effects, effect] }, effectId: effect.id };
}

/** Set the base gain (no keyframes) — dragging the flat line. */
export function setVolumeBase(layer: TimelineLayer, gain: number): TimelineLayer {
  const { layer: withEffect, effectId } = ensureVolumeEffect(layer);
  return {
    ...withEffect,
    effects: withEffect.effects.map((effect) =>
      effect.id === effectId ? { ...effect, params: { ...(effect.params ?? {}), gain: clampGain(gain) } } : effect
    )
  };
}

/** Add an envelope point at a layer-local time + gain; returns the layer and the new point id. */
export function addVolumePoint(layer: TimelineLayer, t: number, gain: number): { layer: TimelineLayer; id: string } {
  const { layer: withEffect, effectId } = ensureVolumeEffect(layer);
  const time = clampTime(t, withEffect.durationSeconds);
  const keyframe: TimelineKeyframeV2 = {
    id: mintKeyframeId(`${effectId}_gain_${Math.round(time * 1000)}`),
    target: { scope: "effect", effectId, property: "gain" },
    timeSeconds: time,
    value: clampGain(gain),
    // Smooth (auto-Bézier) by default so the envelope reads as a curve, not pointed linear segments —
    // matches how pro NLEs default volume automation. Cycle to Linear/Hold via the point's interp toggle.
    interpolation: "autoBezier",
    temporal: {}
  };
  return {
    layer: { ...withEffect, animations: [...(withEffect.animations ?? []), keyframe].sort((a, b) => a.timeSeconds - b.timeSeconds) },
    id: keyframe.id
  };
}

/** Move a point in time + gain (by keyframe id), keeping the list ordered. */
export function moveVolumePoint(layer: TimelineLayer, id: string, t: number, gain: number): TimelineLayer {
  const time = clampTime(t, layer.durationSeconds);
  return {
    ...layer,
    animations: (layer.animations ?? [])
      .map((kf) => (kf.id === id ? { ...kf, timeSeconds: time, value: clampGain(gain) } : kf))
      .sort((a, b) => a.timeSeconds - b.timeSeconds)
  };
}

/** Remove an envelope point (double-click a point). */
export function removeVolumePoint(layer: TimelineLayer, id: string): TimelineLayer {
  return { ...layer, animations: (layer.animations ?? []).filter((kf) => kf.id !== id) };
}

/** The envelope interpolation modes a point cycles through (the segment leaving that point). */
const VOLUME_INTERPOLATIONS: KeyframeInterpolation[] = ["linear", "autoBezier", "hold"];

/** Human label for a point's interpolation (shown in its tooltip). */
export function volumeInterpolationLabel(interpolation: KeyframeInterpolation | undefined): string {
  if (interpolation === "autoBezier") return "Smooth";
  if (interpolation === "hold") return "Hold";
  return "Linear";
}

/** Advance an envelope point's interpolation: Linear → Smooth → Hold → Linear. */
export function cycleVolumePointInterpolation(layer: TimelineLayer, id: string): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) => {
      if (kf.id !== id) return kf;
      const index = VOLUME_INTERPOLATIONS.indexOf(kf.interpolation);
      const next = VOLUME_INTERPOLATIONS[(index + 1) % VOLUME_INTERPOLATIONS.length]!;
      return { ...kf, interpolation: next };
    })
  };
}

/**
 * Set a Bézier tangent handle on an envelope point. The evaluator (animation.ts) is TWO-SIDED: for a
 * segment it reads the LEFT keyframe's `temporal.out` and the RIGHT keyframe's `temporal.in`, each
 * gated on THAT keyframe's own `interpolation === "bezier"`. So BOTH the in- and out-handle live on
 * (and must make `bezier`) the point they belong to — `out` shapes the segment leaving it, `in` shapes
 * the segment arriving at it. (Previously `in` set the *previous* keyframe to bezier, which the
 * two-sided evaluator ignores — so the left handle did nothing.)
 */
export function setVolumePointHandle(
  layer: TimelineLayer,
  id: string,
  which: "in" | "out",
  dx: number,
  dy: number
): TimelineLayer {
  return {
    ...layer,
    animations: (layer.animations ?? []).map((kf) => {
      if (kf.id !== id) return kf;
      const temporal = { ...kf.temporal, [which]: { dx, dy } };
      return { ...kf, temporal, interpolation: "bezier" };
    })
  };
}
