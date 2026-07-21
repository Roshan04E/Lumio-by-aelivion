import type { TimelineComposition, TimelineKeyframeV2, TimelineLayer, TimelineMarker, TimelineTrack } from "./types";
import { getLayerAnimations } from "./animation";
import { getLayerSpeedAt, layerSourceTimeSeconds, shiftSpeedKeyframes, trimLayerKeyframeTracks } from "./timeline";

/** Timeline interaction tools (hybrid model): smart select, blade/razor split, hand pan, roll trim, slide. */
export type TimelineToolMode = "select" | "blade" | "hand" | "roll" | "slide";

/**
 * Pure timeline editing operations (split, ripple-delete, duplicate, nudge,
 * snapping, clipboard). Kept framework-free and side-effect-free so both the
 * editor handlers and any future tests use the same logic. Mutations return a
 * new composition; callers feed the result through the editor's normal
 * update/undo/persist path.
 *
 * Keyframe model note (matches the rest of the app): `layer.keyframes` (v1)
 * store ABSOLUTE composition time; `layer.animations` (v2) store time LOCAL to
 * the layer (0..duration). Split has to respect both.
 */

const EPSILON = 0.0001;

function freshId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${suffix}`;
}

/** Deep-clones a layer with brand-new ids (layer + its keyframes/animations/effects). */
/** Old→new effect id map for a layer clone whose effects are reminted as `<newLayerId>_fx_<index>`. */
function clonedEffectIdMap(layer: TimelineLayer, newLayerId: string): Map<string, string> {
  return new Map(layer.effects.map((effect, index) => [effect.id, `${newLayerId}_fx_${index}`]));
}

/** V2 keyframes address effects BY ID (`target.effectId`) — reminting effect ids without remapping
 *  the targets orphans every effect/mask keyframe on the copy (the animation evaluator and the
 *  inspector both look keyframes up by the effect's CURRENT id, so the copy plays static). */
function remapAnimationTarget(
  target: TimelineKeyframeV2["target"] | undefined,
  effectIdMap: Map<string, string>
): TimelineKeyframeV2["target"] {
  // Runtime data can carry a missing target (legacy/malformed V2 entries the old spread-clone
  // tolerated) — pass it through untouched instead of crashing the whole split/duplicate.
  if (!target) return target as unknown as TimelineKeyframeV2["target"];
  const remapped = target.effectId ? effectIdMap.get(target.effectId) : undefined;
  return remapped ? { ...target, effectId: remapped } : target;
}

function cloneLayerWithNewIds(layer: TimelineLayer, idPrefix: string): TimelineLayer {
  const id = freshId(idPrefix);
  const effectIdMap = clonedEffectIdMap(layer, id);
  return {
    ...layer,
    id,
    linkedGroupId: undefined,
    effects: layer.effects.map((effect) => ({ ...effect, id: effectIdMap.get(effect.id)! })),
    keyframes: layer.keyframes.map((keyframe, index) => ({ ...keyframe, id: `${id}_kf_${index}` })),
    animations: (layer.animations ?? []).map((animation, index) => ({
      ...animation,
      id: `${id}_anim_${index}`,
      target: remapAnimationTarget(animation.target, effectIdMap)
    }))
  };
}

/**
 * Splits a layer into two at an absolute composition time. The right half
 * continues from the correct source frame via `sourceInSeconds`. Keyframes are
 * partitioned to the side they fall on (v2 animations on the right are rebased
 * to the new local origin). No-op if the time isn't strictly inside the clip.
 */
export function splitLayerAtTime(
  composition: TimelineComposition,
  layerId: string,
  atSeconds: number
): TimelineComposition {
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => {
      const index = trackItem.layers.findIndex((item) => item.id === layerId);
      if (index === -1) {
        return trackItem;
      }
      const layer = trackItem.layers[index]!;
      const localSplit = atSeconds - layer.startSeconds;
      if (localSplit <= EPSILON || localSplit >= layer.durationSeconds - EPSILON) {
        return trackItem; // split point outside the clip body
      }

      const left: TimelineLayer = {
        ...layer,
        durationSeconds: localSplit,
        keyframes: layer.keyframes.filter((keyframe) => keyframe.timeSeconds <= atSeconds + EPSILON),
        animations: (layer.animations ?? []).filter((animation) => animation.timeSeconds <= localSplit + EPSILON)
      };

      const right = cloneLayerWithNewIds(layer, `${layer.id}_split`);
      right.startSeconds = atSeconds;
      right.durationSeconds = layer.durationSeconds - localSplit;
      // Ramp-aware: source consumed by the left half is the speed INTEGRAL over it, and the right
      // half's ramp points rebase to its new local 0 (value at the cut becomes its first point).
      right.sourceInSeconds = layerSourceTimeSeconds(layer, localSplit);
      const rightRamp = shiftSpeedKeyframes(layer, localSplit);
      if (rightRamp) right.speedKeyframes = rightRamp;
      right.keyframes = layer.keyframes
        .filter((keyframe) => keyframe.timeSeconds > atSeconds + EPSILON)
        .map((keyframe, kfIndex) => ({ ...keyframe, id: `${right.id}_kf_${kfIndex}` }));
      // Re-derived from the ORIGINAL layer's animations, so the right half's targets need the same
      // effect-id remap the clone's own animations got (right.effects carry the reminted ids).
      const rightEffectIds = clonedEffectIdMap(layer, right.id);
      right.animations = (layer.animations ?? [])
        .filter((animation) => animation.timeSeconds > localSplit + EPSILON)
        .map((animation, animIndex) => ({
          ...animation,
          id: `${right.id}_anim_${animIndex}`,
          timeSeconds: animation.timeSeconds - localSplit,
          target: remapAnimationTarget(animation.target, rightEffectIds)
        }));

      const nextLayers = [...trackItem.layers];
      nextLayers.splice(index, 1, left, right);
      return { ...trackItem, layers: nextLayers };
    })
  };
}

/**
 * Removes a layer and closes the gap it left: clips that started at or after the
 * removed clip's start, on the same track, shift left by its duration.
 */
export function rippleDeleteLayer(composition: TimelineComposition, layerId: string): TimelineComposition {
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => {
      const removed = trackItem.layers.find((item) => item.id === layerId);
      if (!removed) {
        return trackItem;
      }
      const gap = removed.durationSeconds;
      return {
        ...trackItem,
        layers: trackItem.layers
          .filter((item) => item.id !== layerId)
          .map((item) =>
            item.startSeconds >= removed.startSeconds - EPSILON
              ? { ...item, startSeconds: Math.max(0, item.startSeconds - gap) }
              : item
          )
      };
    })
  };
}

/**
 * Reorders `layerId` relative to `targetLayerId` in Z, WITHIN a single track (Graphics-stack
 * drag-reorder, §4). `place` is in draw-order terms: "front-of" puts the layer on top of the target,
 * "behind" puts it under. Draw order within a track is array order — higher index renders on top — so
 * "front-of" reinserts immediately AFTER the target, "behind" immediately BEFORE it.
 *
 * No-op (identity returned) unless BOTH layers live on the SAME track (so cross-track drops are
 * rejected) and they differ. Timing/tracks are otherwise untouched — this only changes stack order.
 */
export function moveLayerWithinTrack(
  composition: TimelineComposition,
  layerId: string,
  targetLayerId: string,
  place: "front-of" | "behind"
): TimelineComposition {
  if (layerId === targetLayerId) return composition;
  let changed = false;
  const tracks = composition.tracks.map((track) => {
    const moving = track.layers.find((item) => item.id === layerId);
    const hasTarget = track.layers.some((item) => item.id === targetLayerId);
    if (!moving || !hasTarget) return track; // both must be on THIS track
    const without = track.layers.filter((item) => item.id !== layerId);
    const targetIndex = without.findIndex((item) => item.id === targetLayerId);
    const insertIndex = place === "front-of" ? targetIndex + 1 : targetIndex;
    const nextLayers = [...without];
    nextLayers.splice(insertIndex, 0, moving);
    changed = true;
    return { ...track, layers: nextLayers };
  });
  return changed ? { ...composition, tracks } : composition;
}

/** Inserts a copy of the layer immediately after it on the same track. Returns the new layer id. */
export function duplicateLayer(
  composition: TimelineComposition,
  layerId: string
): { composition: TimelineComposition; newLayerId: string | null } {
  let newLayerId: string | null = null;
  const nextComposition = {
    ...composition,
    tracks: composition.tracks.map((trackItem) => {
      const index = trackItem.layers.findIndex((item) => item.id === layerId);
      if (index === -1) {
        return trackItem;
      }
      const layer = trackItem.layers[index]!;
      const copy = cloneLayerWithNewIds(layer, `${layer.id}_copy`);
      copy.startSeconds = layer.startSeconds + layer.durationSeconds;
      copy.name = `${layer.name} copy`;
      newLayerId = copy.id;
      const nextLayers = [...trackItem.layers];
      nextLayers.splice(index + 1, 0, copy);
      return { ...trackItem, layers: nextLayers };
    })
  };
  return { composition: nextComposition, newLayerId };
}

/**
 * Ripple-trims one side of a layer to an absolute composition time (the Premiere Q/W ops:
 * "head" removes everything from the clip's start up to `atSeconds`, "tail" removes from
 * `atSeconds` to the clip's end), then closes the gap: clips at/after the trimmed clip's
 * ORIGINAL end shift left by the removed duration — same per-track ripple semantics as
 * `rippleDeleteLayer`. No-op if `atSeconds` isn't strictly inside the clip.
 *
 * Keyframes follow the split conventions: a head trim drops keyframes in the removed window
 * and rebases survivors with the content (v1 absolute times shift by -delta because the clip
 * keeps its startSeconds; v2 local times likewise); a tail trim just drops keyframes past the
 * new end, like `splitLayerAtTime`'s left half.
 */
export function rippleTrimLayer(
  composition: TimelineComposition,
  layerId: string,
  atSeconds: number,
  side: "head" | "tail"
): TimelineComposition {
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => {
      const index = trackItem.layers.findIndex((item) => item.id === layerId);
      if (index === -1) {
        return trackItem;
      }
      const layer = trackItem.layers[index]!;
      const local = atSeconds - layer.startSeconds;
      if (local <= EPSILON || local >= layer.durationSeconds - EPSILON) {
        return trackItem; // trim point outside the clip body
      }
      const delta = side === "head" ? local : layer.durationSeconds - local;
      const originalEnd = layer.startSeconds + layer.durationSeconds;
      const trimmed: TimelineLayer =
        side === "head"
          ? {
              ...layer,
              durationSeconds: layer.durationSeconds - delta,
              sourceInSeconds: layerSourceTimeSeconds(layer, delta),
              ...(shiftSpeedKeyframes(layer, delta) ? { speedKeyframes: shiftSpeedKeyframes(layer, delta) } : {}),
              keyframes: layer.keyframes
                .filter((keyframe) => keyframe.timeSeconds >= atSeconds - EPSILON)
                .map((keyframe) => ({ ...keyframe, timeSeconds: keyframe.timeSeconds - delta })),
              animations: (layer.animations ?? [])
                .filter((animation) => animation.timeSeconds >= delta - EPSILON)
                .map((animation) => ({ ...animation, timeSeconds: animation.timeSeconds - delta }))
            }
          : {
              ...layer,
              durationSeconds: local,
              keyframes: layer.keyframes.filter((keyframe) => keyframe.timeSeconds <= atSeconds + EPSILON),
              animations: (layer.animations ?? []).filter((animation) => animation.timeSeconds <= local + EPSILON)
            };
      return {
        ...trackItem,
        layers: trackItem.layers.map((item, itemIndex) => {
          if (itemIndex === index) {
            return trimmed;
          }
          return item.startSeconds >= originalEnd - EPSILON
            ? { ...item, startSeconds: Math.max(0, item.startSeconds - delta) }
            : item;
        })
      };
    })
  };
}

// --- Trim suite (roll / slide / edge trim) -----------------------------------

/** Same touching tolerance the timeline's junction detection uses. */
const CUT_TOUCH_EPSILON = 0.02;

export interface TrimLimitOptions {
  /** Per-layer max playable duration (asset length for media, comp length otherwise). */
  maxDurationsSeconds?: Record<string, number> | undefined;
  /** Smallest a clip may get (typically one frame). */
  minDurationSeconds?: number | undefined;
}

function isSourceMedia(layer: TimelineLayer): boolean {
  return (layer.type === "video" || layer.type === "audio") && Boolean(layer.assetId);
}

/** |rate| at the clip's head, floored at the MIN speed. Headroom divisions use this (S2): the SIGN
 *  of a reversed rate is direction, not a scalar — dividing by it flipped bounds negative — and a
 *  near-zero ramp edge (freeze) must not produce an infinite bound. */
function edgeRateMagnitude(layer: TimelineLayer): number {
  return Math.max(0.05, Math.abs(getLayerSpeedAt(layer, 0)));
}

function maxDurationFor(layer: TimelineLayer, composition: TimelineComposition, options: TrimLimitOptions): number {
  return options.maxDurationsSeconds?.[layer.id] ?? composition.durationSeconds;
}

/**
 * Keyframe/ramp conventions for resizing a layer to `(nextStartSeconds, nextDurationSeconds)` —
 * the SINGLE source of truth for what trimming does to animation data, shared by the trim suite
 * here (`adjustLayerHead`/`adjustLayerTail`) and the timeline drag-resize
 * (`EditorPage.handleResizeLayer`), which previously left keyframes untouched: a head drag
 * shifted v2 animations off their content, and a tail drag left keyframe markers floating past
 * the clip's end (user report 2026-07-03).
 *
 * Conventions (same as `rippleTrimLayer`/`splitLayerAtTime`): a head trim drops keyframes in the
 * removed window and rebases survivors with the content (v2 local times shift by −delta; v1
 * absolute times just re-filter against the new span; the speed ramp rebases via
 * `shiftSpeedKeyframes`); a head EXTEND shifts v2 times right so the animation stays pinned to
 * its content; a tail trim drops keyframes past the new end.
 */
export function trimLayerKeyframesTo(
  layer: TimelineLayer,
  nextStartSeconds: number,
  nextDurationSeconds: number
): Pick<TimelineLayer, "keyframes" | "animations"> & { speedKeyframes?: TimelineLayer["speedKeyframes"] } {
  // The rule itself lives next to shiftSpeedKeyframes in timeline.ts so the work-area clip can share
  // it — it forgot this rebase for years precisely because the logic lived only here.
  return trimLayerKeyframeTracks(layer, nextStartSeconds - layer.startSeconds, nextDurationSeconds);
}

/**
 * Non-source-layer trim/resize counterpart to {@link trimLayerKeyframesTo}: instead of dropping
 * keyframes that fall outside the new span, PROPORTIONALLY RESCALES every keyframe's time onto the
 * new duration (factor = nextDurationSeconds / layer.durationSeconds), so the whole animated timeline
 * compresses/stretches to fit rather than getting cut off. Used for text/shape/image layers, which
 * have no source in-point to reveal/hide — unlike video/audio, there's no "content window" to keep
 * keyframes pinned to, so squeezing (not cutting) is what a user dragging a trim handle expects.
 */
export function squeezeLayerKeyframesTo(
  layer: TimelineLayer,
  nextStartSeconds: number,
  nextDurationSeconds: number
): Pick<TimelineLayer, "keyframes" | "animations"> {
  const oldDuration = layer.durationSeconds;
  if (oldDuration <= EPSILON) {
    return { keyframes: layer.keyframes, animations: layer.animations };
  }
  // Responsive Time (§5): if the clip protects an intro/outro, remap each keyframe's LOCAL time with
  // the region-aware rule (head held, tail re-anchored, middle stretched); otherwise the classic
  // uniform proportional squeeze. `remap` takes/returns layer-local seconds either way.
  const responsive = layer.responsiveTime;
  const remap = responsive
    ? (localT: number) => remapResponsiveTime(localT, oldDuration, nextDurationSeconds, responsive.introSeconds, responsive.outroSeconds)
    : (localT: number) => Math.min(nextDurationSeconds, Math.max(0, localT * (nextDurationSeconds / oldDuration)));
  const animations = (layer.animations ?? []).map((animation) => ({
    ...animation,
    timeSeconds: remap(animation.timeSeconds)
  }));
  const keyframes = layer.keyframes.map((keyframe) => ({
    ...keyframe,
    timeSeconds: nextStartSeconds + remap(keyframe.timeSeconds - layer.startSeconds)
  }));
  return { keyframes, animations };
}

/**
 * Responsive Time (§5) re-time of ONE layer-local keyframe time when a clip's duration changes from
 * `oldDur` to `newDur`, protecting the first `intro` and last `outro` seconds of animation:
 *  - a keyframe in the head zone (t ≤ intro) keeps its time (glued to the start),
 *  - a keyframe in the tail zone (t ≥ oldDur − outro) re-anchors to the NEW end (same distance from it),
 *  - a middle keyframe rescales into the leftover span [intro, newDur − outro].
 * Fit-guard: if the protected zones don't fit (intro + outro ≥ min(oldDur, newDur)), there is no middle
 * to stretch, so it falls back to the plain proportional squeeze. Pure + unit-tested.
 */
export function remapResponsiveTime(
  localT: number,
  oldDur: number,
  newDur: number,
  intro: number,
  outro: number
): number {
  const proportional = () => Math.min(newDur, Math.max(0, localT * (newDur / Math.max(EPSILON, oldDur))));
  const introClamped = Math.max(0, intro);
  const outroClamped = Math.max(0, outro);
  if (introClamped + outroClamped >= Math.min(oldDur, newDur) - EPSILON) {
    return proportional();
  }
  if (localT <= introClamped + EPSILON) {
    return localT; // protected head — held to the start
  }
  if (localT >= oldDur - outroClamped - EPSILON) {
    return newDur - (oldDur - localT); // protected tail — re-anchored to the new end
  }
  const oldMiddle = oldDur - introClamped - outroClamped;
  const newMiddle = newDur - introClamped - outroClamped;
  return introClamped + ((localT - introClamped) / oldMiddle) * newMiddle;
}

/**
 * Trim/extend a layer's HEAD by `delta` (positive = trim: start moves right; negative =
 * extend: start moves left). Content stays pinned to the timeline: media `sourceInSeconds`
 * moves with the edge, v2 animations rebase with the content, v1 absolute keyframes outside
 * the new span are dropped — the `rippleTrimLayer`/`splitLayerAtTime` conventions.
 */
function adjustLayerHead(layer: TimelineLayer, delta: number): TimelineLayer {
  const nextStart = layer.startSeconds + delta;
  const nextDuration = layer.durationSeconds - delta;
  const sourceBound = isSourceMedia(layer);
  // Ramp-aware head math: a trim (delta>0) consumes the speed INTEGRAL of the trimmed span; an
  // extension (delta<0) adds head material at the ramp's first value (edge hold) — mirrored by
  // shiftSpeedKeyframes so the surviving content plays identically.
  const nextSourceIn =
    delta >= 0
      ? layerSourceTimeSeconds(layer, delta)
      : (layer.sourceInSeconds ?? 0) + delta * getLayerSpeedAt(layer, 0);
  // Clip markers are content-glued (clip-local seconds): a head trim shifts them left by the
  // trimmed span so each flag stays on its frame; markers trimmed past either edge drop.
  const nextMarkers = layer.markers
    ?.map((marker) => ({ ...marker, timeSeconds: marker.timeSeconds - delta }))
    .filter((marker) => marker.timeSeconds >= 0 && marker.timeSeconds <= nextDuration);
  return {
    ...layer,
    startSeconds: nextStart,
    durationSeconds: nextDuration,
    ...(layer.markers ? { markers: nextMarkers && nextMarkers.length > 0 ? nextMarkers : undefined } : {}),
    ...(sourceBound ? { sourceInSeconds: Math.max(0, nextSourceIn) } : {}),
    // Non-source layers (text/shape/image) have no content window to keep keyframes pinned to, so a
    // ripple/roll trim SQUEEZES their animated timeline onto the new duration instead of cutting it.
    ...(sourceBound ? trimLayerKeyframesTo(layer, nextStart, nextDuration) : squeezeLayerKeyframesTo(layer, nextStart, nextDuration))
  };
}

/** Trim/extend a layer's TAIL by `delta` (positive = extend, negative = trim). */
function adjustLayerTail(layer: TimelineLayer, delta: number): TimelineLayer {
  const nextDuration = layer.durationSeconds + delta;
  // Tail trims drop clip markers past the new end (they're content-glued; extending restores nothing).
  const nextMarkers = layer.markers?.filter((marker) => marker.timeSeconds <= nextDuration);
  return {
    ...layer,
    durationSeconds: nextDuration,
    ...(layer.markers ? { markers: nextMarkers && nextMarkers.length > 0 ? nextMarkers : undefined } : {}),
    ...(isSourceMedia(layer)
      ? trimLayerKeyframesTo(layer, layer.startSeconds, nextDuration)
      : squeezeLayerKeyframesTo(layer, layer.startSeconds, nextDuration))
  };
}

/**
 * Signed delta range a roll edit at the cut between two touching clips may take:
 * positive delta moves the cut right (left clip extends, right clip's head trims),
 * negative moves it left. Bounded by both clips' minimum duration, the left clip's
 * available media, and the right clip's head material (`sourceInSeconds` for media).
 */
export function rollEditLimits(
  composition: TimelineComposition,
  leftLayerId: string,
  rightLayerId: string,
  options: TrimLimitOptions = {}
): { minDelta: number; maxDelta: number; minReason?: string; maxReason?: string } | null {
  const minDuration = options.minDurationSeconds ?? EPSILON;
  for (const trackItem of composition.tracks) {
    const left = trackItem.layers.find((item) => item.id === leftLayerId);
    const right = trackItem.layers.find((item) => item.id === rightLayerId);
    if (!left || !right) continue;
    if (Math.abs(right.startSeconds - (left.startSeconds + left.durationSeconds)) > CUT_TOUCH_EPSILON) return null;
    const leftTailRoom = maxDurationFor(left, composition, options) - left.durationSeconds;
    const rightMinRoom = right.durationSeconds - minDuration;
    const maxDelta = Math.min(leftTailRoom, rightMinRoom);
    const maxReason = leftTailRoom <= rightMinRoom ? "no tail material on left clip" : "right clip at minimum length";
    // Extending the RIGHT clip's head: media is bounded by its head material (`sourceInSeconds`
    // decreases with the edge — the max-duration map is "max playable from the CURRENT sourceIn",
    // which grows in step, so it is NOT the constraint); non-media by the max-duration cap.
    const leftMinRoom = left.durationSeconds - minDuration;
    const rightHeadRoom = isSourceMedia(right)
      ? (right.sourceInSeconds ?? 0) / edgeRateMagnitude(right) // head material in TIMELINE seconds (edge |rate| under a ramp)
      : maxDurationFor(right, composition, options) - right.durationSeconds;
    const minDelta = -Math.min(leftMinRoom, rightHeadRoom);
    const minReason =
      rightHeadRoom <= leftMinRoom
        ? isSourceMedia(right)
          ? "no head material on right clip"
          : "right clip at maximum length"
        : "left clip at minimum length";
    return { minDelta: Math.min(0, minDelta), maxDelta: Math.max(0, maxDelta), minReason, maxReason };
  }
  return null;
}

/**
 * Roll edit (Premiere's rolling trim / "extend edit"): move the cut between two touching
 * same-track clips by `deltaSeconds` — the left clip's tail and the right clip's head change
 * together, total timeline length unchanged. Delta is clamped to `rollEditLimits`; no-op when
 * the clips aren't a touching pair or the clamped delta is ~0.
 */
export function rollEditAtCut(
  composition: TimelineComposition,
  leftLayerId: string,
  rightLayerId: string,
  deltaSeconds: number,
  options: TrimLimitOptions = {}
): TimelineComposition {
  const limits = rollEditLimits(composition, leftLayerId, rightLayerId, options);
  if (!limits) return composition;
  const delta = Math.max(limits.minDelta, Math.min(limits.maxDelta, deltaSeconds));
  if (Math.abs(delta) <= EPSILON) return composition;
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => {
      if (!trackItem.layers.some((item) => item.id === leftLayerId)) return trackItem;
      return {
        ...trackItem,
        layers: trackItem.layers.map((item) => {
          if (item.id === leftLayerId) return adjustLayerTail(item, delta);
          if (item.id === rightLayerId) return adjustLayerHead(item, delta);
          return item;
        })
      };
    })
  };
}

/**
 * Signed delta range for sliding a clip between its two TOUCHING same-track neighbours:
 * positive slides right (previous clip's tail extends, next clip's head trims). Null when
 * the clip doesn't have touching neighbours on both sides (classic slide needs both cuts).
 */
export function slideLayerLimits(
  composition: TimelineComposition,
  layerId: string,
  options: TrimLimitOptions = {}
): { minDelta: number; maxDelta: number; minReason?: string; maxReason?: string; previousLayerId: string; nextLayerId: string } | null {
  const minDuration = options.minDurationSeconds ?? EPSILON;
  for (const trackItem of composition.tracks) {
    const layer = trackItem.layers.find((item) => item.id === layerId);
    if (!layer) continue;
    const ordered = [...trackItem.layers].sort((a, b) => a.startSeconds - b.startSeconds);
    const index = ordered.findIndex((item) => item.id === layerId);
    const previous = index > 0 ? ordered[index - 1]! : null;
    const next = index < ordered.length - 1 ? ordered[index + 1]! : null;
    if (!previous || !next) return null;
    if (Math.abs(layer.startSeconds - (previous.startSeconds + previous.durationSeconds)) > CUT_TOUCH_EPSILON) return null;
    if (Math.abs(next.startSeconds - (layer.startSeconds + layer.durationSeconds)) > CUT_TOUCH_EPSILON) return null;
    const previousTailRoom = maxDurationFor(previous, composition, options) - previous.durationSeconds;
    const nextMinRoom = next.durationSeconds - minDuration;
    const maxDelta = Math.min(previousTailRoom, nextMinRoom);
    const maxReason = previousTailRoom <= nextMinRoom ? "no tail material on previous clip" : "next clip at minimum length";
    // Same head-extension bound as rollEditLimits: media = its head material, non-media = the cap.
    const previousMinRoom = previous.durationSeconds - minDuration;
    const nextHeadRoom = isSourceMedia(next)
      ? (next.sourceInSeconds ?? 0) / edgeRateMagnitude(next)
      : maxDurationFor(next, composition, options) - next.durationSeconds;
    const minDelta = -Math.min(previousMinRoom, nextHeadRoom);
    const minReason =
      nextHeadRoom <= previousMinRoom
        ? isSourceMedia(next)
          ? "no head material on next clip"
          : "next clip at maximum length"
        : "previous clip at minimum length";
    return {
      minDelta: Math.min(0, minDelta),
      maxDelta: Math.max(0, maxDelta),
      minReason,
      maxReason,
      previousLayerId: previous.id,
      nextLayerId: next.id
    };
  }
  return null;
}

/**
 * Slide edit (Premiere's slide tool): move a clip along the timeline WITHOUT changing its
 * content or duration — the previous neighbour's tail and the next neighbour's head absorb
 * the move. Clamped to `slideLayerLimits`; no-op without touching neighbours on both sides.
 */
export function slideLayer(
  composition: TimelineComposition,
  layerId: string,
  deltaSeconds: number,
  options: TrimLimitOptions = {}
): TimelineComposition {
  const limits = slideLayerLimits(composition, layerId, options);
  if (!limits) return composition;
  const delta = Math.max(limits.minDelta, Math.min(limits.maxDelta, deltaSeconds));
  if (Math.abs(delta) <= EPSILON) return composition;
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => {
      if (!trackItem.layers.some((item) => item.id === layerId)) return trackItem;
      return {
        ...trackItem,
        layers: trackItem.layers.map((item) => {
          if (item.id === limits.previousLayerId) return adjustLayerTail(item, delta);
          if (item.id === limits.nextLayerId) return adjustLayerHead(item, delta);
          if (item.id === layerId) {
            // The slid clip's content is untouched — v1 absolute keyframes travel with it.
            return {
              ...item,
              startSeconds: item.startSeconds + delta,
              keyframes: item.keyframes.map((keyframe) => ({ ...keyframe, timeSeconds: keyframe.timeSeconds + delta }))
            };
          }
          return item;
        })
      };
    })
  };
}

/**
 * Non-ripple trim of one clip edge to an absolute time (later clips do NOT move — the
 * "extend edit to playhead" fallback when the edge has no touching neighbour to roll with).
 * Clamped by available media / neighbour overlap is the caller's concern; this clamps only
 * to the clip's own min duration and head material.
 */
export function trimLayerEdgeTo(
  composition: TimelineComposition,
  layerId: string,
  side: "head" | "tail",
  timeSeconds: number,
  options: TrimLimitOptions = {}
): TimelineComposition {
  const minDuration = options.minDurationSeconds ?? EPSILON;
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => {
      const layer = trackItem.layers.find((item) => item.id === layerId);
      if (!layer) return trackItem;
      const maxDuration = maxDurationFor(layer, composition, options);
      let delta: number;
      if (side === "head") {
        delta = timeSeconds - layer.startSeconds; // positive = trim
        const headroom = isSourceMedia(layer) ? (layer.sourceInSeconds ?? 0) / edgeRateMagnitude(layer) : layer.startSeconds;
        delta = Math.max(-Math.min(headroom, maxDuration - layer.durationSeconds), Math.min(layer.durationSeconds - minDuration, delta));
      } else {
        delta = timeSeconds - (layer.startSeconds + layer.durationSeconds); // positive = extend
        delta = Math.max(-(layer.durationSeconds - minDuration), Math.min(maxDuration - layer.durationSeconds, delta));
      }
      if (Math.abs(delta) <= EPSILON) return trackItem;
      return {
        ...trackItem,
        layers: trackItem.layers.map((item) =>
          item.id === layerId ? (side === "head" ? adjustLayerHead(item, delta) : adjustLayerTail(item, delta)) : item
        )
      };
    })
  };
}

// --- Edge trim (interactive resize primitive) --------------------------------
//
// Trimming a clip's HEAD or TAIL edge is its OWN editing primitive, distinct from move/roll/slide: it
// juggles source in/out reveal, the media/compound duration cap, min clip length, and keyframe/anim
// timing all at once. `resolveEdgeTrim` is the single geometric answer — "given this clip and a desired
// (start, duration), where do the edges legally land?" — that BOTH the interactive drag preview and the
// commit call, so the preview can no longer overshoot the source-material limit and snap back on release
// (the bug: the old preview clamped the head only by asset length, ignoring how much head material
// `sourceInSeconds` actually had, while the commit clamped correctly). `applyEdgeTrim` then writes the
// resolved edges plus the keyframe/animation patch. Caller passes the per-clip `maxDurationSeconds`
// (asset/compound length) and `minDurationSeconds` (one frame) — this stays UI/asset-free.

export interface EdgeTrimLimits {
  /** Longest the clip may play: asset length for media, nested length for a compound, else composition. */
  maxDurationSeconds: number;
  /** Shortest the clip may get (typically one frame). */
  minDurationSeconds: number;
}

export interface EdgeTrimResolution {
  startSeconds: number;
  durationSeconds: number;
  /** Set only for source-bound clips (media / compound) — the resolved source in-point. */
  sourceInSeconds: number | undefined;
  /** True when the clip reveals/hides source material (video/audio with asset, or a nested compound). */
  sourceBound: boolean;
}

/** A clip is source-bound if trimming reveals/hides real material: media-with-asset, or a nested compound. */
function isEdgeSourceBound(layer: TimelineLayer): boolean {
  return ((layer.type === "video" || layer.type === "audio") && Boolean(layer.assetId)) || Boolean(layer.nestedCompositionId);
}

/**
 * Resolve a clip's edges for a desired (start, duration) under the source/duration limits. Pure and
 * framework-free. Source-bound clips move `sourceInSeconds` with the head edge (capped so it never
 * reveals material before source-frame 0) and cap duration by the material remaining from that in-point;
 * non-source clips (text/shape/image) just clamp start/duration to the max length. This is the exact
 * math the editor's resize commit has always used — now shared so the drag preview matches it.
 */
export function resolveEdgeTrim(
  layer: TimelineLayer,
  desired: { startSeconds: number; durationSeconds: number },
  limits: EdgeTrimLimits
): EdgeTrimResolution {
  const { maxDurationSeconds, minDurationSeconds } = limits;
  const sourceBound = isEdgeSourceBound(layer);

  if (!sourceBound) {
    // No source in-point to reveal: a left-edge drag past the max length pins the start so the clip
    // keeps its end; duration clamps to [min, max].
    const oldEnd = layer.startSeconds + layer.durationSeconds;
    const nextStart =
      desired.startSeconds < layer.startSeconds && desired.durationSeconds > maxDurationSeconds
        ? Math.max(0, oldEnd - maxDurationSeconds)
        : desired.startSeconds;
    const nextDuration = clampNumber(desired.durationSeconds, minDurationSeconds, maxDurationSeconds);
    return { startSeconds: Math.max(0, nextStart), durationSeconds: nextDuration, sourceInSeconds: undefined, sourceBound: false };
  }

  const oldSourceIn = layer.sourceInSeconds ?? 0;
  const startDelta = desired.startSeconds - layer.startSeconds;
  let nextStart = desired.startSeconds;
  let nextDuration = desired.durationSeconds;
  let nextSourceIn = oldSourceIn + startDelta;

  if (nextSourceIn < 0) {
    // Can't reveal source before frame 0 — cap how far the head can extend left.
    nextStart = layer.startSeconds - oldSourceIn;
    nextDuration = layer.durationSeconds + oldSourceIn;
    nextSourceIn = 0;
  }

  const maxDurationFromIn = Math.max(minDurationSeconds, maxDurationSeconds - nextSourceIn);
  nextDuration = clampNumber(nextDuration, minDurationSeconds, maxDurationFromIn);

  return { startSeconds: Math.max(0, nextStart), durationSeconds: nextDuration, sourceInSeconds: nextSourceIn, sourceBound: true };
}

/**
 * Write a resolved edge trim onto a layer, including the keyframe/animation timing patch: source-bound
 * clips keep keyframes pinned to the content window ({@link trimLayerKeyframesTo}); non-source clips
 * squeeze their animation onto the new duration ({@link squeezeLayerKeyframesTo}).
 */
export function applyEdgeTrim(layer: TimelineLayer, resolution: EdgeTrimResolution): TimelineLayer {
  const base = { ...layer, startSeconds: resolution.startSeconds, durationSeconds: resolution.durationSeconds };
  if (resolution.sourceBound) {
    return {
      ...base,
      sourceInSeconds: resolution.sourceInSeconds ?? 0,
      ...trimLayerKeyframesTo(layer, resolution.startSeconds, resolution.durationSeconds)
    };
  }
  return { ...base, ...squeezeLayerKeyframesTo(layer, resolution.startSeconds, resolution.durationSeconds) };
}

/**
 * Sorted unique edit points for playhead navigation (the up/down-arrow "go to previous/next
 * edit" op): every clip start/end across all tracks, plus 0 and the composition end.
 */
/**
 * Resolve-style "Trim Clips" for a junction transition with insufficient tail material: shorten the
 * OUTGOING clip's out-point by `trimSeconds` (turning that span into real tail-handle media for the
 * transition window) and ripple the cut — the incoming clip and everything after it on the same
 * track shifts left so the clips stay butted (the timeline gets shorter, exactly like Resolve's
 * "Trim clips" dialog). Linked A/V companions stay in sync: a companion ending at the same cut is
 * trimmed with the outgoing clip, and companions of shifted clips shift with them (or the audio
 * track would collide/desync). The caller computes `trimSeconds` from
 * `resolveTransitionWindowSides().repeatedFramesSeconds` (kept out of here to avoid a module cycle).
 * Returns null when there's nothing to do (no junction, nothing to trim, or the outgoing clip is
 * too short to give up the material).
 */
export function trimOutgoingForTransition(
  composition: TimelineComposition,
  leftLayerId: string,
  rightLayerId: string,
  trimSeconds: number
): TimelineComposition | null {
  const track = composition.tracks.find(
    (item) => item.layers.some((layer) => layer.id === leftLayerId) && item.layers.some((layer) => layer.id === rightLayerId)
  );
  if (!track) return null;
  const left = track.layers.find((layer) => layer.id === leftLayerId)!;
  const right = track.layers.find((layer) => layer.id === rightLayerId)!;
  const leftEnd = left.startSeconds + left.durationSeconds;
  if (Math.abs(leftEnd - right.startSeconds) > 0.05) return null; // not a junction anymore
  const delta = Math.min(trimSeconds, Math.max(0, left.durationSeconds - 0.1));
  if (delta <= 1 / 240) return null;
  const cut = right.startSeconds;
  const movedIds = new Set(track.layers.filter((layer) => layer.startSeconds >= cut - EPSILON).map((layer) => layer.id));
  const movedGroupIds = new Set(
    track.layers
      .filter((layer) => movedIds.has(layer.id) && layer.linkedGroupId)
      .map((layer) => layer.linkedGroupId as string)
  );
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((layer) => {
        if (layer.id === leftLayerId) {
          return { ...layer, durationSeconds: layer.durationSeconds - delta };
        }
        // The outgoing clip's linked companion (its audio half) ending at the same cut trims with it —
        // otherwise the shifted incoming side lands on top of it on the companion's track.
        if (
          left.linkedGroupId &&
          layer.linkedGroupId === left.linkedGroupId &&
          Math.abs(layer.startSeconds + layer.durationSeconds - leftEnd) <= 0.05 &&
          layer.durationSeconds - delta > 0.05
        ) {
          return { ...layer, durationSeconds: layer.durationSeconds - delta };
        }
        const isMoved =
          trackItem.id === track.id
            ? movedIds.has(layer.id)
            : Boolean(layer.linkedGroupId && movedGroupIds.has(layer.linkedGroupId) && layer.startSeconds >= cut - 0.05);
        if (isMoved) {
          return { ...layer, startSeconds: Math.max(0, layer.startSeconds - delta) };
        }
        return layer;
      })
    }))
  };
}

/**
 * T4 — manufacture HEAD material for a junction transition: advance the INCOMING clip's source
 * in-point by `headSeconds` of timeline pre-roll (skipping the first `headSeconds` of its visible
 * content), so the transition window has real media BEFORE the cut. The clip's timeline placement is
 * untouched — its CONTENT shifts earlier under it, exactly Premiere's "trim clip" answer to
 * "insufficient media". The keyframe glue mirrors the head-trim conventions:
 *  - v2 animations shift with the content (`-headSeconds` local). Keys landing at NEGATIVE local
 *    times are KEPT (the nesting precedent: the evaluator interpolates by time, so values inside the
 *    visible span stay exact; negative keys are simply unreachable outside the pre-roll).
 *  - v1 keyframes shift the same way (the clip's start is unchanged, so absolute == local shift).
 *  - clip markers shift with the content and DROP below 0 (UI pins have no negative address).
 * Linked A/V companions cutting at the same point advance in sync (or the pair desyncs).
 * Returns null when there is nothing to do: not source media, a speed-ramped clip (v1 unsupported —
 * the ramp integral makes "pre-roll seconds" nonlinear), or no material left to give
 * (`assetDurationSeconds` known and the clip already ends at the asset's tail).
 */
export function advanceIncomingSourceForTransition(
  composition: TimelineComposition,
  rightLayerId: string,
  headSeconds: number,
  options?: { assetDurationSeconds?: number | undefined }
): TimelineComposition | null {
  const right = composition.tracks.flatMap((track) => track.layers).find((layer) => layer.id === rightLayerId);
  if (!right) return null;
  if (!((right.type === "video" || right.type === "audio") && right.assetId)) return null;
  if ((right.speedKeyframes?.length ?? 0) > 0) return null;
  const speed = getLayerSpeedAt(right, 0);
  // S2: reversed clips are rejected like ramped ones (v1) — "manufacture head material" advances
  // the in-point forward through the source, which is meaningless when the clip plays backward.
  if (speed <= 0) return null;
  let sourceDelta = Math.max(0, headSeconds) * speed;
  if (options?.assetDurationSeconds !== undefined) {
    const consumedEnd = (right.sourceInSeconds ?? 0) + right.durationSeconds * speed;
    sourceDelta = Math.min(sourceDelta, Math.max(0, options.assetDurationSeconds - consumedEnd));
  }
  if (sourceDelta <= speed / 240) return null;
  const cut = right.startSeconds;

  const advance = (layer: TimelineLayer): TimelineLayer => {
    const layerSpeed = getLayerSpeedAt(layer, 0);
    const localShift = sourceDelta / speed; // timeline seconds of content shift (same for companions)
    return {
      ...layer,
      sourceInSeconds: (layer.sourceInSeconds ?? 0) + localShift * layerSpeed,
      keyframes: layer.keyframes.map((keyframe) => ({ ...keyframe, timeSeconds: keyframe.timeSeconds - localShift })),
      animations: (layer.animations ?? []).map((animation) => ({ ...animation, timeSeconds: animation.timeSeconds - localShift })),
      ...(layer.markers?.length
        ? {
            markers: layer.markers
              .map((marker) => ({ ...marker, timeSeconds: marker.timeSeconds - localShift }))
              .filter((marker) => marker.timeSeconds >= -EPSILON)
          }
        : {})
    };
  };

  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((layer) => {
        if (layer.id === rightLayerId) return advance(layer);
        // Linked companion (the audio half) starting at the same cut advances in sync — content-wise
        // the pair must keep pointing at the same source instant. Ramped companions are left alone
        // (same v1 limitation as the main clip; a desync there is the user's explicit ramp choice).
        if (
          right.linkedGroupId &&
          layer.linkedGroupId === right.linkedGroupId &&
          (layer.type === "video" || layer.type === "audio") &&
          Boolean(layer.assetId) &&
          (layer.speedKeyframes?.length ?? 0) === 0 &&
          Math.abs(layer.startSeconds - cut) <= 0.05
        ) {
          return advance(layer);
        }
        return layer;
      })
    }))
  };
}

export function collectEditPoints(composition: TimelineComposition): number[] {
  const points = new Set<number>([0, Number(composition.durationSeconds.toFixed(4))]);
  for (const trackItem of composition.tracks) {
    for (const layer of trackItem.layers) {
      points.add(Number(layer.startSeconds.toFixed(4)));
      points.add(Number((layer.startSeconds + layer.durationSeconds).toFixed(4)));
    }
  }
  return [...points].sort((a, b) => a - b);
}

/** Shifts a layer's start by delta seconds (clamped to >= 0). */
export function nudgeLayer(composition: TimelineComposition, layerId: string, deltaSeconds: number): TimelineComposition {
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((item) =>
        item.id === layerId ? { ...item, startSeconds: Math.max(0, item.startSeconds + deltaSeconds) } : item
      )
    }))
  };
}

// --- Group move (the single move resolver) ----------------------------------
//
// ONE pure answer to "given this timeline and this gesture, where does every moved clip land?".
// Both the drag PREVIEW and the COMMIT call this, plus the `moveLayers` engine action (AI / scripting)
// — so the three paths can never drift. It replaces the old arrangement where the preview
// (getDragTrackPreview) and the commit (handleMoveLayer) each computed the move with subtly different
// clamps, which produced two shipped bugs: a multi-clip group collapsing onto one lane when any member
// hit a track edge (per-clip track clamp instead of a group clamp) and horizontal compression when a
// member hit t=0 (per-clip time clamp). Here BOTH axes are rigid-body: one shared delta clamped so the
// whole selection stays in bounds, applied uniformly, so relative spacing is always preserved.

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Resolved landing spot for one affected layer. */
export interface GroupMovePlacement {
  layerId: string;
  startSeconds: number;
  trackId: string;
  /** True for an explicitly-moved clip (can change track); false for a linked follower (time only). */
  member: boolean;
}

export interface ResolveGroupMoveInput {
  composition: TimelineComposition;
  /** The explicitly-selected clips being dragged. */
  movedLayerIds: string[];
  /** The clip under the pointer — its snapped delta is the group's shared time delta. */
  primaryLayerId: string;
  /** Desired horizontal shift in seconds (already snapped by the caller if it wants edge/frame snap). */
  deltaSeconds: number;
  /** Desired vertical shift in whole track-rows within each clip's audio/video family. 0 = no track change. */
  trackDelta?: number;
  /**
   * Optional per-composition frame grid. When set the clamped shared delta is snapped to it — used by
   * AI/scripting that pass a raw delta; the drag UI pre-snaps and omits this.
   */
  frameStepSeconds?: number;
  /** Optional upper bound on a layer's start (e.g. timeline end − clip length). Defaults to Infinity. */
  maxStartForLayer?: (layer: TimelineLayer) => number;
  /**
   * Editing-policy rules this resolve obeys. Omitted → today's defaults: `lockedTracks: "reject"`
   * (locked clips / locked destination tracks never move) and `linkedMedia: "moveTogether"` (linked
   * A/V companions follow the time shift). The resolver reads the rules FROM the policy — it no longer
   * hardcodes them — so callers (overwrite drag, an "ignore locks" override, break-sync paste) select
   * behavior instead of the resolver dictating it.
   */
  policy?: Pick<EditingPolicy, "lockedTracks" | "linkedMedia">;
}

export interface GroupMoveResolution {
  placements: GroupMovePlacement[];
  /** The clamped delta actually applied to every clip (for badge readouts / snap guides). */
  appliedDeltaSeconds: number;
  /** The clamped whole-row track delta actually applied to members. */
  appliedTrackDelta: number;
  /** Group-clamped track-delta range — the caller uses it to clamp the live pixel offset. */
  trackDeltaBounds: { min: number; max: number };
  valid: boolean;
  reason: string | null;
}

/** Tracks of the same media family (audio vs. everything else) a clip can legally live on. */
function compatibleTracksFor(composition: TimelineComposition, layer: TimelineLayer): TimelineTrack[] {
  const isAudio = layer.type === "audio";
  return composition.tracks.filter((track) => (track.type === "audio") === isAudio);
}

/**
 * Resolve a whole-group move. Pure and framework-free: no React, no DOM, no pointer maths — it only
 * answers where each clip should end up. See the block comment above for why both axes are rigid.
 */
export function resolveGroupMove(input: ResolveGroupMoveInput): GroupMoveResolution {
  const { composition, movedLayerIds, primaryLayerId, deltaSeconds, trackDelta = 0, frameStepSeconds, maxStartForLayer, policy } = input;
  // Policy owns these rules now (defaults = today's behavior). `respectLocks` false = the caller asked
  // to move locked clips / onto locked tracks anyway; `moveTogether` = drag linked companions along.
  const respectLocks = (policy?.lockedTracks ?? "reject") !== "ignore";
  const moveLinkedTogether = (policy?.linkedMedia ?? "moveTogether") === "moveTogether";

  const entryById = new Map<string, { layer: TimelineLayer; track: TimelineTrack }>();
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      entryById.set(layer.id, { layer, track });
    }
  }

  // Members: the explicitly-selected clips that can actually move. Locked clips / locked tracks are
  // excluded unless the policy says to ignore locks.
  const memberIds = [...new Set(movedLayerIds)].filter((id) => {
    const entry = entryById.get(id);
    if (!entry) return false;
    return !respectLocks || (!entry.layer.locked && !entry.track.locked);
  });
  if (memberIds.length === 0) {
    return {
      placements: [],
      appliedDeltaSeconds: 0,
      appliedTrackDelta: 0,
      trackDeltaBounds: { min: 0, max: 0 },
      valid: false,
      reason: "No movable clips"
    };
  }

  // Linked companions of any member that aren't themselves members follow the time shift (keeping A/V
  // sync intact) but never change track — matching the editor's single-clip linked-move behavior. The
  // `allowBreak` policy skips this entirely, so a companion stays put and the link is allowed to break.
  const seen = new Set(memberIds);
  const followerIds: string[] = [];
  if (moveLinkedTogether) {
    for (const id of memberIds) {
      const groupId = entryById.get(id)?.layer.linkedGroupId;
      if (!groupId) continue;
      for (const [otherId, entry] of entryById) {
        if (seen.has(otherId) || entry.layer.linkedGroupId !== groupId) continue;
        if (respectLocks && (entry.layer.locked || entry.track.locked)) continue;
        followerIds.push(otherId);
        seen.add(otherId);
      }
    }
  }
  const affectedIds = [...memberIds, ...followerIds];

  // --- Rigid TIME clamp: one shared delta that keeps EVERY affected clip within [0, maxStart]. ---
  let minDeltaTime = -Infinity;
  let maxDeltaTime = Infinity;
  for (const id of affectedIds) {
    const layer = entryById.get(id)!.layer;
    minDeltaTime = Math.max(minDeltaTime, -layer.startSeconds);
    const maxStart = maxStartForLayer?.(layer);
    if (maxStart !== undefined && Number.isFinite(maxStart)) {
      maxDeltaTime = Math.min(maxDeltaTime, maxStart - layer.startSeconds);
    }
  }
  if (!Number.isFinite(minDeltaTime)) minDeltaTime = 0;
  if (!Number.isFinite(maxDeltaTime)) maxDeltaTime = Infinity;
  if (minDeltaTime > maxDeltaTime) minDeltaTime = maxDeltaTime = 0;
  let appliedDeltaSeconds = clampNumber(deltaSeconds, minDeltaTime, maxDeltaTime);
  if (frameStepSeconds && frameStepSeconds > 0) {
    appliedDeltaSeconds = clampNumber(Math.round(appliedDeltaSeconds / frameStepSeconds) * frameStepSeconds, minDeltaTime, maxDeltaTime);
  }

  // --- Rigid TRACK clamp: intersect each member's [-index, len-1-index] family range into one. ---
  let minTrackDelta = -Infinity;
  let maxTrackDelta = Infinity;
  for (const id of memberIds) {
    const layer = entryById.get(id)!.layer;
    const family = compatibleTracksFor(composition, layer);
    const index = family.findIndex((track) => track.id === layer.trackId);
    if (index === -1) continue;
    minTrackDelta = Math.max(minTrackDelta, -index);
    maxTrackDelta = Math.min(maxTrackDelta, family.length - 1 - index);
  }
  if (!Number.isFinite(minTrackDelta) || !Number.isFinite(maxTrackDelta) || minTrackDelta > maxTrackDelta) {
    minTrackDelta = maxTrackDelta = 0;
  }
  const appliedTrackDelta = clampNumber(Math.round(trackDelta), minTrackDelta, maxTrackDelta);

  const placements: GroupMovePlacement[] = memberIds.map((id) => {
    const layer = entryById.get(id)!.layer;
    const family = compatibleTracksFor(composition, layer);
    const index = family.findIndex((track) => track.id === layer.trackId);
    let trackId = layer.trackId;
    if (index !== -1) {
      const target = family[clampNumber(index + appliedTrackDelta, 0, family.length - 1)];
      // A locked destination lane keeps the clip put — unless the policy says to ignore locks.
      trackId = target && (!respectLocks || !target.locked) ? target.id : layer.trackId;
    }
    return { layerId: id, startSeconds: Math.max(0, layer.startSeconds + appliedDeltaSeconds), trackId, member: true };
  });
  for (const id of followerIds) {
    const layer = entryById.get(id)!.layer;
    placements.push({ layerId: id, startSeconds: Math.max(0, layer.startSeconds + appliedDeltaSeconds), trackId: layer.trackId, member: false });
  }

  const moved = Math.abs(appliedDeltaSeconds) > EPSILON || appliedTrackDelta !== 0;
  return {
    placements,
    appliedDeltaSeconds,
    appliedTrackDelta,
    trackDeltaBounds: { min: minTrackDelta, max: maxTrackDelta },
    valid: moved,
    reason: moved ? null : "No movement"
  };
}

/**
 * Apply resolved placements to a composition, relocating any clip whose track changed. Pure; the
 * commit path and the `moveLayers` engine action both build the new composition through this.
 */
export function applyGroupMovePlacements(composition: TimelineComposition, placements: GroupMovePlacement[]): TimelineComposition {
  if (placements.length === 0) return composition;
  const updated = new Map<string, TimelineLayer>();
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      const placement = placements.find((item) => item.layerId === layer.id);
      if (placement) {
        updated.set(layer.id, { ...layer, startSeconds: placement.startSeconds, trackId: placement.trackId });
      }
    }
  }
  if (updated.size === 0) return composition;
  return {
    ...composition,
    tracks: composition.tracks.map((track) => {
      const kept = track.layers.flatMap((layer) => {
        const moved = updated.get(layer.id);
        if (!moved) return [layer];
        return moved.trackId === track.id ? [moved] : [];
      });
      const incoming = [...updated.values()].filter(
        (layer) => layer.trackId === track.id && !track.layers.some((existing) => existing.id === layer.id)
      );
      return { ...track, layers: [...kept, ...incoming] };
    })
  };
}

// --- Editing policy layer -----------------------------------------------------
//
// Geometry (resolveGroupMove / rollEditAtCut / slideLayer / …) answers WHERE clips want to go. POLICY
// is the separate question of whether that result is ALLOWED and how conflicts resolve. Keeping it out
// of every resolver means one place owns overlap/lock/link/snapping rules, and new features (insert
// edits, overwrite drag, magnetic timeline, drag-drop, paste) select a policy instead of each growing
// its own branch. Pipeline: resolve edit → apply policy → operation. See the roadmap in
// project-tracker/timeline.md (v7).

/** How a moved clip resolves against clips already occupying its destination span, on the same track. */
export type OverlapPolicy = "allow" | "overwrite" | "reject";
/** Whether an edit may place clips on / move off locked tracks. (Enforced geometrically today.) */
export type LockedTrackPolicy = "reject" | "ignore";
/** Whether linked A/V companions travel with an edit or may break sync. (Enforced in resolveGroupMove.) */
export type LinkedMediaPolicy = "moveTogether" | "allowBreak";

export interface EditingPolicy {
  /** Destination-collision rule. `allow` = today's behavior (clips may overlap). Consumed by `applyOverlapPolicy`. */
  overlap: OverlapPolicy;
  /** Locked-track rule (consumed by `resolveGroupMove`). `reject` = never move locked clips / onto locked tracks; `ignore` = move anyway. */
  lockedTracks: LockedTrackPolicy;
  /** Linked-media rule (consumed by `resolveGroupMove`). `moveTogether` = companions follow; `allowBreak` = leave them, break sync. */
  linkedMedia: LinkedMediaPolicy;
  /**
   * Snap edges to clip cuts / playhead / markers. SHIPPED — but in the UI gesture layer (the timeline's
   * Magnet/"N" toggle → `snapTimeWithTarget`), not yet read from here. This flag is the contract for
   * routing that same snapping through the policy so AI/scripting can request snapped edits.
   */
  snapping: boolean;
  /**
   * Magnetic timeline: clips auto-close gaps and never overlap (FCP-style). NOT built — distinct from the
   * Magnet toolbar icon, which is `snapping` above. Declared for the contract.
   */
  magnetic: boolean;
}

/** Behavior-preserving default: exactly what the editor does today, so threading a policy changes nothing. */
export const DEFAULT_EDITING_POLICY: EditingPolicy = {
  overlap: "allow",
  lockedTracks: "reject",
  linkedMedia: "moveTogether",
  snapping: true,
  magnetic: false
};

const OVERLAP_EPSILON = 0.0005;
function layerEndSeconds(layer: TimelineLayer): number {
  return layer.startSeconds + layer.durationSeconds;
}
function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd - OVERLAP_EPSILON && bStart < aEnd - OVERLAP_EPSILON;
}
function deleteLayerById(composition: TimelineComposition, layerId: string): TimelineComposition {
  return {
    ...composition,
    tracks: composition.tracks.map((track) => ({ ...track, layers: track.layers.filter((layer) => layer.id !== layerId) }))
  };
}
function findLayerById(composition: TimelineComposition, layerId: string): TimelineLayer | null {
  for (const track of composition.tracks) {
    const found = track.layers.find((layer) => layer.id === layerId);
    if (found) return found;
  }
  return null;
}
/** Split a layer and return the new RIGHT-half id (splitLayerAtTime keeps the original id on the left). */
function splitReturningRightId(composition: TimelineComposition, layerId: string, atSeconds: number): { composition: TimelineComposition; rightId: string | null } {
  const track = composition.tracks.find((item) => item.layers.some((layer) => layer.id === layerId));
  if (!track) return { composition, rightId: null };
  const beforeIds = new Set(track.layers.map((layer) => layer.id));
  const next = splitLayerAtTime(composition, layerId, atSeconds);
  const nextTrack = next.tracks.find((item) => item.id === track.id);
  const added = nextTrack?.layers.find((layer) => !beforeIds.has(layer.id));
  return { composition: next, rightId: added?.id ?? null };
}
/** Carve the span [spanStart, spanEnd) out of one clip (source/keyframe-aware via splitLayerAtTime). */
function removeSpanFromLayer(composition: TimelineComposition, layerId: string, spanStart: number, spanEnd: number): TimelineComposition {
  const layer = findLayerById(composition, layerId);
  if (!layer) return composition;
  const start = layer.startSeconds;
  const end = layerEndSeconds(layer);
  const from = Math.max(spanStart, start);
  const to = Math.min(spanEnd, end);
  if (to - from <= OVERLAP_EPSILON) return composition; // no real overlap
  const coversHead = from <= start + OVERLAP_EPSILON;
  const coversTail = to >= end - OVERLAP_EPSILON;
  if (coversHead && coversTail) return deleteLayerById(composition, layerId); // fully covered
  if (coversHead) {
    // Keep only the tail [to, end): split at `to`, drop the left (original-id) piece.
    const { composition: split } = splitReturningRightId(composition, layerId, to);
    return deleteLayerById(split, layerId);
  }
  if (coversTail) {
    // Keep only the head [start, from): split at `from`, drop the right piece.
    const { composition: split, rightId } = splitReturningRightId(composition, layerId, from);
    return rightId ? deleteLayerById(split, rightId) : split;
  }
  // Interior removal: split at `from` (right = [from, end)), split that at `to`, drop the middle.
  const first = splitReturningRightId(composition, layerId, from);
  if (!first.rightId) return first.composition;
  const second = splitReturningRightId(first.composition, first.rightId, to);
  return deleteLayerById(second.composition, first.rightId);
}

export interface OverlapPolicyResult {
  composition: TimelineComposition;
  /** False only under `reject` when the move would collide — the caller should keep the pre-move state. */
  accepted: boolean;
  reason: string | null;
}

/**
 * Resolve destination collisions between the just-moved clips (`movedLayerIds`) and the clips already
 * on their tracks, per the overlap policy. Pure. `overwrite` carves the covered span out of stationary
 * clips (leaving a gap — it does NOT ripple); `reject` reports the conflict so the caller can abort;
 * `allow` is a no-op (today's behavior). Only stationary clips are ever trimmed — moved clips are kept.
 */
export function applyOverlapPolicy(composition: TimelineComposition, movedLayerIds: string[], overlap: OverlapPolicy): OverlapPolicyResult {
  if (overlap === "allow") return { composition, accepted: true, reason: null };
  const movedSet = new Set(movedLayerIds);

  if (overlap === "reject") {
    for (const track of composition.tracks) {
      const moved = track.layers.filter((layer) => movedSet.has(layer.id));
      if (!moved.length) continue;
      const stationary = track.layers.filter((layer) => !movedSet.has(layer.id));
      const collides = stationary.some((s) =>
        moved.some((m) => spansOverlap(s.startSeconds, layerEndSeconds(s), m.startSeconds, layerEndSeconds(m)))
      );
      if (collides) return { composition, accepted: false, reason: "Move would overlap another clip" };
    }
    return { composition, accepted: true, reason: null };
  }

  // overwrite: carve every moved clip's span out of the stationary clips it lands on.
  let next = composition;
  for (const track of composition.tracks) {
    const movedIntervals = track.layers.filter((layer) => movedSet.has(layer.id)).map((layer) => [layer.startSeconds, layerEndSeconds(layer)] as const);
    if (!movedIntervals.length) continue;
    for (const [moveStart, moveEnd] of movedIntervals) {
      const trackNow = next.tracks.find((item) => item.id === track.id);
      if (!trackNow) continue;
      // Re-read stationary survivors each pass — a carve can split one clip into two new-id pieces.
      const stationary = trackNow.layers.filter((layer) => !movedSet.has(layer.id));
      for (const clip of stationary) {
        if (spansOverlap(clip.startSeconds, layerEndSeconds(clip), moveStart, moveEnd)) {
          next = removeSpanFromLayer(next, clip.id, moveStart, moveEnd);
        }
      }
    }
  }
  return { composition: next, accepted: true, reason: null };
}

/**
 * Magnetic compaction — the "no gaps, no overlaps" half of a magnetic timeline. On each given track,
 * lays the clips end-to-end in their current time order, anchored at the EARLIEST clip's start (never
 * slams to 0), so gaps and overlaps both vanish while the block keeps its left edge. Pure.
 *
 * v1 limitation: a track that contains ANY locked clip is left untouched — locked clips are immovable
 * anchors and flowing unlocked clips around them cleanly is a follow-up. `resolveGroupMove` already
 * won't move locked clips, so this stays consistent.
 */
export function applyMagneticTracks(composition: TimelineComposition, trackIds: Iterable<string>): TimelineComposition {
  const targets = new Set(trackIds);
  return {
    ...composition,
    tracks: composition.tracks.map((track) => {
      if (!targets.has(track.id) || track.layers.length < 2) return track;
      if (track.layers.some((layer) => layer.locked)) return track; // locked-anchor tracks: v1 skips
      const ordered = [...track.layers].sort((a, b) => a.startSeconds - b.startSeconds);
      let cursor = ordered[0]!.startSeconds;
      const compacted = ordered.map((layer) => {
        const placed = layer.startSeconds === cursor ? layer : { ...layer, startSeconds: cursor };
        cursor += layer.durationSeconds;
        return placed;
      });
      return { ...track, layers: compacted };
    })
  };
}

/** Tracks a move touched: every destination track plus each moved clip's original track (pre-move). */
function magneticAffectedTracks(composition: TimelineComposition, placements: GroupMovePlacement[]): Set<string> {
  const affected = new Set<string>();
  const originalTrackByLayer = new Map<string, string>();
  for (const track of composition.tracks) {
    for (const layer of track.layers) originalTrackByLayer.set(layer.id, track.id);
  }
  for (const placement of placements) {
    affected.add(placement.trackId);
    const original = originalTrackByLayer.get(placement.layerId);
    if (original) affected.add(original);
  }
  return affected;
}

/**
 * Commit a resolved group move THROUGH the editing policy: place the clips, then apply overlap/magnetic
 * rules. `magnetic` compacts the touched tracks (gapless, overlap-free) and subsumes the overlap rule;
 * otherwise the overlap rule applies and `reject` returns the ORIGINAL composition unchanged (edit
 * refused). This is the seam interactive drag, the `moveLayers` action, AI, and scripting share.
 */
export function commitGroupMove(
  composition: TimelineComposition,
  placements: GroupMovePlacement[],
  movedLayerIds: string[],
  policy: EditingPolicy = DEFAULT_EDITING_POLICY
): OverlapPolicyResult {
  const placed = applyGroupMovePlacements(composition, placements);
  if (policy.magnetic) {
    // Magnetic mode: gaps close and overlaps vanish on every track the move touched — this replaces the
    // overlap rule (compaction can't leave an overlap behind).
    return { composition: applyMagneticTracks(placed, magneticAffectedTracks(composition, placements)), accepted: true, reason: null };
  }
  const resolved = applyOverlapPolicy(placed, movedLayerIds, policy.overlap);
  if (!resolved.accepted) return { composition, accepted: false, reason: resolved.reason }; // refuse → pre-move state
  return resolved;
}

// --- Track auto-vacancy -------------------------------------------------------

/**
 * Keep exactly ONE empty visual track on top and ONE empty audio track at the bottom (CapCut/Resolve
 * behavior): dropping a clip on the outer empty track immediately grows a fresh one beyond it, and
 * surplus empty EDGE tracks collapse back to one. Only the consecutive run at each edge is touched —
 * user-created empty tracks in the middle are never removed. Applies only when at least one track of
 * that type exists (a fresh video-only comp doesn't sprout an audio track). Returns the SAME
 * reference when nothing changes, so composition-keyed memos don't invalidate for a no-op.
 *
 * Runs at the single write choke point (EditorPage's `updateComposition`), never mid-gesture, so
 * track ids stay stable during drags and the normalized state lands inside the same undo entry.
 */
export function ensureVacantEdgeTracks(composition: TimelineComposition): TimelineComposition {
  const tracks = composition.tracks;
  const isVisual = (track: TimelineTrack) => track.type !== "audio";
  // Only pads this function minted are collapsible — a user-created empty track (the explicit
  // "Add layer" buttons) must survive normalization or the buttons become no-ops.
  const isAutoPad = (track: TimelineTrack) => track.id.startsWith("track_auto_") && track.layers.length === 0;
  if (tracks.length === 0) return composition;

  // Leading consecutive empty AUTO visual pads / trailing consecutive empty AUTO audio pads.
  let leadingEmptyVisuals = 0;
  while (leadingEmptyVisuals < tracks.length && isVisual(tracks[leadingEmptyVisuals]!) && isAutoPad(tracks[leadingEmptyVisuals]!)) {
    leadingEmptyVisuals += 1;
  }
  let trailingEmptyAudio = 0;
  while (
    trailingEmptyAudio < tracks.length &&
    tracks[tracks.length - 1 - trailingEmptyAudio]!.type === "audio" &&
    isAutoPad(tracks[tracks.length - 1 - trailingEmptyAudio]!)
  ) {
    trailingEmptyAudio += 1;
  }
  const hasVisual = tracks.some(isVisual);
  const hasAudio = tracks.some((track) => track.type === "audio");
  const topTrack = tracks[leadingEmptyVisuals];
  const bottomTrack = tracks[tracks.length - 1 - trailingEmptyAudio];
  // A user-created empty track already sitting at the edge serves as the vacant pad — don't stack
  // an auto pad beyond it.
  const edgeVisualIsEmpty = topTrack !== undefined && isVisual(topTrack) && topTrack.layers.length === 0;
  const edgeAudioIsEmpty = bottomTrack !== undefined && bottomTrack.type === "audio" && bottomTrack.layers.length === 0;
  const wantVisualPad = hasVisual && leadingEmptyVisuals === 0 && !edgeVisualIsEmpty;
  const wantAudioPad = hasAudio && trailingEmptyAudio === 0 && !edgeAudioIsEmpty;
  const surplusVisuals = Math.max(0, leadingEmptyVisuals - (edgeVisualIsEmpty ? 0 : 1));
  const surplusAudio = Math.max(0, trailingEmptyAudio - (edgeAudioIsEmpty ? 0 : 1));
  if (!wantVisualPad && !wantAudioPad && surplusVisuals === 0 && surplusAudio === 0) {
    return composition;
  }

  let next = tracks.slice(surplusVisuals, tracks.length - surplusAudio);
  const stamp = Date.now().toString(36);
  if (wantVisualPad) {
    const count = tracks.filter(isVisual).length + 1;
    next = [{ id: `track_auto_${stamp}_video`, type: "video", name: `Video ${count}`, layers: [] }, ...next];
  }
  if (wantAudioPad) {
    const count = tracks.filter((track) => track.type === "audio").length + 1;
    next = [...next, { id: `track_auto_${stamp}_audio`, type: "audio", name: `Audio ${count}`, layers: [] }];
  }
  return { ...composition, tracks: next };
}

// --- Markers ------------------------------------------------------------------

/** Premiere-style marker palette (default first). Values are the actual swatch colors. */
export const TIMELINE_MARKER_COLORS = ["#22c55e", "#ef4444", "#a855f7", "#f97316", "#eab308", "#3b82f6", "#06b6d4", "#e5e7eb"] as const;

/**
 * Upgrade a stored marker list (legacy bare seconds and/or object markers) to sorted
 * {@link TimelineMarker} objects. Never mutates; safe on undefined.
 */
export function normalizeTimelineMarkers(markers: (number | TimelineMarker)[] | undefined): TimelineMarker[] {
  if (!markers?.length) return [];
  return markers
    .map((m): TimelineMarker => (typeof m === "number" ? { timeSeconds: m } : { ...m }))
    .filter((m) => Number.isFinite(m.timeSeconds))
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
}

// --- Snapping ---------------------------------------------------------------

export interface SnapTargetOptions {
  excludeLayerId?: string | undefined;
  playheadSeconds?: number | undefined;
  markers?: number[] | undefined;
}

/** Collects the times an edge can snap to: other clips' edges, the playhead, markers, and 0. */
export function computeSnapTargets(composition: TimelineComposition, options: SnapTargetOptions = {}): number[] {
  const targets = new Set<number>([0]);
  for (const trackItem of composition.tracks) {
    for (const layer of trackItem.layers) {
      if (layer.id === options.excludeLayerId) {
        continue;
      }
      targets.add(Number(layer.startSeconds.toFixed(4)));
      targets.add(Number((layer.startSeconds + layer.durationSeconds).toFixed(4)));
    }
  }
  if (typeof options.playheadSeconds === "number") {
    targets.add(Number(options.playheadSeconds.toFixed(4)));
  }
  for (const marker of options.markers ?? []) {
    targets.add(Number(marker.toFixed(4)));
  }
  return [...targets].sort((a, b) => a - b);
}

/** Snaps a value to the nearest target within tolerance. Returns the (possibly snapped) value and which target it hit. */
export function snapValue(
  value: number,
  targets: number[],
  toleranceSeconds: number
): { value: number; snappedTo: number | null } {
  let best: number | null = null;
  let bestDistance = toleranceSeconds;
  for (const target of targets) {
    const distance = Math.abs(target - value);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best === null ? { value, snappedTo: null } : { value: best, snappedTo: best };
}

// --- Paste attributes (Premiere Ctrl+Alt+C / Ctrl+Alt+V) ---------------------

/** The copyable "look" of a clip: styling + its keyframes, not content or timing. */
export interface LayerAttributes {
  effects: TimelineLayer["effects"];
  /** Undefined = "don't touch transform on apply" (effect presets strip it; clipboard keeps it). */
  transform: TimelineLayer["transform"] | undefined;
  fit: TimelineLayer["fit"];
  /** Vector clip masks. Undefined = "don't touch masks on apply". */
  masks?: TimelineLayer["masks"];
  /** Source-within-frame pan/zoom/crop. Undefined = "don't touch content on apply". */
  content?: TimelineLayer["content"];
  /** Constant playback speed. Undefined = "don't touch speed on apply". */
  speed?: TimelineLayer["speed"];
  /**
   * Keyframes riding along with the attributes: effect-scope keys (carrying the SOURCE effect ids —
   * remapped to the fresh ids at apply time), layer-scope `transform.*` keys, and layer-scope
   * `content.*` keys. Times are layer-local, so they apply as-is; keys past a shorter target clip
   * are simply never reached. Undefined = pre-keyframe snapshot (old saved presets) → apply leaves
   * target animations alone.
   */
  animations?: TimelineKeyframeV2[] | undefined;
}

/** Attribute groups the paste-attributes chooser (Ctrl+Alt+V) lets a user pick between. */
export type AttributeGroup = "transform" | "effects" | "fit" | "masks" | "content" | "speed";

export const ALL_ATTRIBUTE_GROUPS: ReadonlySet<AttributeGroup> = new Set([
  "transform",
  "effects",
  "fit",
  "masks",
  "content",
  "speed"
]);

let clipboardAttributes: LayerAttributes | null = null;

function isTransformKeyframe(keyframe: TimelineKeyframeV2): boolean {
  return keyframe.target?.scope === "layer" && keyframe.target.property.startsWith("transform.");
}

function isContentKeyframe(keyframe: TimelineKeyframeV2): boolean {
  return keyframe.target?.scope === "layer" && keyframe.target.property.startsWith("content.");
}

/** Deep clone a keyframe (targets/handles/object values) so stored snapshots and multi-target pastes never share references. */
function cloneKeyframe(keyframe: TimelineKeyframeV2, id: string = keyframe.id): TimelineKeyframeV2 {
  return {
    ...keyframe,
    id,
    target: { ...keyframe.target },
    value: typeof keyframe.value === "object" && keyframe.value !== null ? { ...keyframe.value } : keyframe.value,
    temporal: {
      ...keyframe.temporal,
      in: keyframe.temporal.in ? { ...keyframe.temporal.in } : keyframe.temporal.in,
      out: keyframe.temporal.out ? { ...keyframe.temporal.out } : keyframe.temporal.out
    },
    spatial: keyframe.spatial
      ? {
          ...keyframe.spatial,
          inTangent: keyframe.spatial.inTangent ? { ...keyframe.spatial.inTangent } : keyframe.spatial.inTangent,
          outTangent: keyframe.spatial.outTangent ? { ...keyframe.spatial.outTangent } : keyframe.spatial.outTangent
        }
      : keyframe.spatial
  };
}

/** Deep-copied attribute snapshot of a clip — safe to store (presets) or hold (clipboard). */
export function snapshotLayerAttributes(layer: TimelineLayer): LayerAttributes {
  const effectIds = new Set(layer.effects.map((effect) => effect.id));
  // getLayerAnimations folds legacy v1 keyframes in as layer-local `transform.*` V2 keys, so
  // snapshots of old clips carry their animation too.
  const animations = getLayerAnimations(layer)
    .filter(
      (keyframe) =>
        (keyframe.target?.scope === "effect" &&
          keyframe.target.effectId !== undefined &&
          effectIds.has(keyframe.target.effectId)) ||
        isTransformKeyframe(keyframe) ||
        isContentKeyframe(keyframe)
    )
    .map((keyframe) => cloneKeyframe(keyframe));
  return {
    effects: layer.effects.map((effect) => ({ ...effect, params: { ...effect.params } })),
    transform: layer.transform ? { ...layer.transform, position: { ...layer.transform.position } } : layer.transform,
    fit: layer.fit,
    masks: layer.masks?.map((mask) => ({ ...mask })),
    content: layer.content ? { ...layer.content, crop: layer.content.crop ? { ...layer.content.crop } : layer.content.crop } : undefined,
    speed: layer.speed,
    animations
  };
}

/** Snapshot a clip's attributes (effects/transform/fit/masks/content/speed) into the attribute clipboard. */
export function copyLayerAttributes(layer: TimelineLayer): void {
  clipboardAttributes = snapshotLayerAttributes(layer);
}

export function hasClipboardAttributes(): boolean {
  return clipboardAttributes !== null;
}

/**
 * Apply the copied attributes to every target layer, restricted to `groups` (default: everything —
 * matches the historical paste-all behavior). Effects are REPLACED with fresh-id clones (per-layer ids
 * so editing one pasted effect never aliases another), transform/fit/masks/content/speed copied when the
 * source had them AND their group is included, and the source's effect/transform/content keyframes
 * travel too (effect keys remapped to the fresh effect ids; the target's own keys in the replaced,
 * included scopes are dropped, other-scope keys untouched). Timing is always untouched.
 */
export function pasteLayerAttributes(
  composition: TimelineComposition,
  layerIds: string[],
  groups: ReadonlySet<AttributeGroup> = ALL_ATTRIBUTE_GROUPS
): TimelineComposition {
  return applyLayerAttributes(composition, layerIds, clipboardAttributes, groups);
}

/**
 * Apply an explicit attribute snapshot (from the clipboard OR a saved preset) to target layers.
 * Same replacement semantics as paste: fresh per-layer effect ids, transform/fit/masks/content/speed
 * copied when present and included in `groups` (default: everything).
 */
export function applyLayerAttributes(
  composition: TimelineComposition,
  layerIds: string[],
  attributes: LayerAttributes | null,
  groups: ReadonlySet<AttributeGroup> = ALL_ATTRIBUTE_GROUPS
): TimelineComposition {
  if (!attributes || !layerIds.length) return composition;
  const targets = new Set(layerIds);
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((item) => (targets.has(item.id) ? applyAttributesToLayer(item, attributes, groups) : item))
    }))
  };
}

/** Layer-scoped application of an attribute snapshot (used by paste and by saved effect presets). */
export function applyAttributesToLayer(
  item: TimelineLayer,
  attributes: LayerAttributes,
  groups: ReadonlySet<AttributeGroup> = ALL_ATTRIBUTE_GROUPS
): TimelineLayer {
  const includeEffects = groups.has("effects");
  const includeTransform = groups.has("transform") && attributes.transform !== undefined;
  const includeFit = groups.has("fit") && attributes.fit !== undefined && (item.type === "video" || item.type === "image");
  const includeMasks = groups.has("masks") && attributes.masks !== undefined;
  const includeContent = groups.has("content") && attributes.content !== undefined;
  const includeSpeed = groups.has("speed") && attributes.speed !== undefined;

  const effects = includeEffects
    ? attributes.effects.map((effect, index) => ({
        ...effect,
        id: `${item.id}_pfx_${index}_${freshId("e").slice(-6)}`,
        params: { ...effect.params }
      }))
    : item.effects;

  const next: TimelineLayer = {
    ...item,
    effects,
    ...(includeTransform ? { transform: { ...attributes.transform!, position: { ...attributes.transform!.position } } } : {}),
    ...(includeFit ? { fit: attributes.fit } : {}),
    ...(includeMasks ? { masks: attributes.masks!.map((mask) => ({ ...mask })) } : {}),
    ...(includeContent ? { content: { ...attributes.content! } } : {}),
    ...(includeSpeed ? { speed: attributes.speed } : {})
  };
  if (attributes.animations !== undefined) {
    // Remap snapshot effect ids → the fresh per-target ids minted above (index-aligned). Unset when
    // effects aren't included — no target keyframes reference the untouched effects' ids.
    const freshEffectIdByOldId = new Map<string, string>();
    if (includeEffects) {
      attributes.effects.forEach((effect, index) => freshEffectIdByOldId.set(effect.id, effects[index]!.id));
    }
    // Replace semantics per scope: an included scope's whole value was just replaced, so ALL of the
    // target's keys in that scope are orphans; excluded scopes and mask/track/other-scope keys are
    // never touched.
    const kept = (item.animations ?? []).filter((keyframe) => {
      if (includeEffects && keyframe.target?.scope === "effect") return false;
      if (includeTransform && isTransformKeyframe(keyframe)) return false;
      if (includeContent && isContentKeyframe(keyframe)) return false;
      return true;
    });
    const incoming: TimelineKeyframeV2[] = [];
    for (const keyframe of attributes.animations) {
      if (keyframe.target?.scope === "effect") {
        if (!includeEffects) continue;
        const freshEffectId = keyframe.target.effectId ? freshEffectIdByOldId.get(keyframe.target.effectId) : undefined;
        if (!freshEffectId) continue; // key no longer maps to a snapshotted effect
        const clone = cloneKeyframe(keyframe, freshId("kf"));
        clone.target.effectId = freshEffectId;
        incoming.push(clone);
      } else if (includeTransform && isTransformKeyframe(keyframe)) {
        incoming.push(cloneKeyframe(keyframe, freshId("kf")));
      } else if (includeContent && isContentKeyframe(keyframe)) {
        incoming.push(cloneKeyframe(keyframe, freshId("kf")));
      }
    }
    next.animations = [...kept, ...incoming];
    if (includeTransform && item.keyframes?.length) {
      // Legacy v1 keys are all transform.* and merge in via getLayerAnimations — leaving them
      // would double-animate the freshly replaced transform scope.
      next.keyframes = [];
    }
  }
  return next;
}

// --- Clipboard (in-memory, single slot) ------------------------------------

let clipboardLayer: TimelineLayer | null = null;

export function copyLayerToClipboard(layer: TimelineLayer): void {
  clipboardLayer = layer;
}

export function hasClipboardLayer(): boolean {
  return clipboardLayer !== null;
}

/** Returns a fresh-id clone of the clipboard layer positioned at `startSeconds`, or null if empty. */
export function pasteLayerFromClipboard(startSeconds: number): TimelineLayer | null {
  if (!clipboardLayer) {
    return null;
  }
  const copy = cloneLayerWithNewIds(clipboardLayer, `${clipboardLayer.id}_paste`);
  copy.startSeconds = Math.max(0, startSeconds);
  copy.name = `${clipboardLayer.name} copy`;
  return copy;
}
