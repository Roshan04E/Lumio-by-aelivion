import type { TimelineComposition, TimelineKeyframeV2, TimelineLayer, TimelineMarker } from "./types";
import { getLayerAnimations } from "./animation";
import { getLayerSpeedAt, layerSourceTimeSeconds, shiftSpeedKeyframes } from "./timeline";

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
function cloneLayerWithNewIds(layer: TimelineLayer, idPrefix: string): TimelineLayer {
  const id = freshId(idPrefix);
  return {
    ...layer,
    id,
    linkedGroupId: undefined,
    effects: layer.effects.map((effect, index) => ({ ...effect, id: `${id}_fx_${index}` })),
    keyframes: layer.keyframes.map((keyframe, index) => ({ ...keyframe, id: `${id}_kf_${index}` })),
    animations: (layer.animations ?? []).map((animation, index) => ({ ...animation, id: `${id}_anim_${index}` }))
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
      right.animations = (layer.animations ?? [])
        .filter((animation) => animation.timeSeconds > localSplit + EPSILON)
        .map((animation, animIndex) => ({ ...animation, id: `${right.id}_anim_${animIndex}`, timeSeconds: animation.timeSeconds - localSplit }));

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
  const headDelta = nextStartSeconds - layer.startSeconds;
  const nextEndSeconds = nextStartSeconds + nextDurationSeconds;
  const headMoved = Math.abs(headDelta) > EPSILON;
  const animations = (layer.animations ?? [])
    .filter((animation) => animation.timeSeconds >= headDelta - EPSILON)
    .map((animation) => (headMoved ? { ...animation, timeSeconds: animation.timeSeconds - headDelta } : animation))
    .filter((animation) => animation.timeSeconds <= nextDurationSeconds + EPSILON);
  const keyframes = layer.keyframes.filter(
    (keyframe) => keyframe.timeSeconds >= nextStartSeconds - EPSILON && keyframe.timeSeconds <= nextEndSeconds + EPSILON
  );
  const ramp = headMoved ? shiftSpeedKeyframes(layer, headDelta) : layer.speedKeyframes;
  return { keyframes, animations, ...(ramp ? { speedKeyframes: ramp } : {}) };
}

/**
 * Trim/extend a layer's HEAD by `delta` (positive = trim: start moves right; negative =
 * extend: start moves left). Content stays pinned to the timeline: media `sourceInSeconds`
 * moves with the edge, v2 animations rebase with the content, v1 absolute keyframes outside
 * the new span are dropped — the `rippleTrimLayer`/`splitLayerAtTime` conventions.
 */
function adjustLayerHead(layer: TimelineLayer, delta: number): TimelineLayer {
  const nextStart = layer.startSeconds + delta;
  // Ramp-aware head math: a trim (delta>0) consumes the speed INTEGRAL of the trimmed span; an
  // extension (delta<0) adds head material at the ramp's first value (edge hold) — mirrored by
  // shiftSpeedKeyframes so the surviving content plays identically.
  const nextSourceIn =
    delta >= 0
      ? layerSourceTimeSeconds(layer, delta)
      : (layer.sourceInSeconds ?? 0) + delta * getLayerSpeedAt(layer, 0);
  return {
    ...layer,
    startSeconds: nextStart,
    durationSeconds: layer.durationSeconds - delta,
    ...(isSourceMedia(layer) ? { sourceInSeconds: Math.max(0, nextSourceIn) } : {}),
    ...trimLayerKeyframesTo(layer, nextStart, layer.durationSeconds - delta)
  };
}

/** Trim/extend a layer's TAIL by `delta` (positive = extend, negative = trim). */
function adjustLayerTail(layer: TimelineLayer, delta: number): TimelineLayer {
  return {
    ...layer,
    durationSeconds: layer.durationSeconds + delta,
    ...trimLayerKeyframesTo(layer, layer.startSeconds, layer.durationSeconds + delta)
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
): { minDelta: number; maxDelta: number } | null {
  const minDuration = options.minDurationSeconds ?? EPSILON;
  for (const trackItem of composition.tracks) {
    const left = trackItem.layers.find((item) => item.id === leftLayerId);
    const right = trackItem.layers.find((item) => item.id === rightLayerId);
    if (!left || !right) continue;
    if (Math.abs(right.startSeconds - (left.startSeconds + left.durationSeconds)) > CUT_TOUCH_EPSILON) return null;
    const maxDelta = Math.min(maxDurationFor(left, composition, options) - left.durationSeconds, right.durationSeconds - minDuration);
    // Extending the RIGHT clip's head: media is bounded by its head material (`sourceInSeconds`
    // decreases with the edge — the max-duration map is "max playable from the CURRENT sourceIn",
    // which grows in step, so it is NOT the constraint); non-media by the max-duration cap.
    const minDelta = -Math.min(
      left.durationSeconds - minDuration,
      isSourceMedia(right)
        ? (right.sourceInSeconds ?? 0) / getLayerSpeedAt(right, 0) // head material in TIMELINE seconds (edge rate under a ramp)
        : maxDurationFor(right, composition, options) - right.durationSeconds
    );
    return { minDelta: Math.min(0, minDelta), maxDelta: Math.max(0, maxDelta) };
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
): { minDelta: number; maxDelta: number; previousLayerId: string; nextLayerId: string } | null {
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
    const maxDelta = Math.min(maxDurationFor(previous, composition, options) - previous.durationSeconds, next.durationSeconds - minDuration);
    // Same head-extension bound as rollEditLimits: media = its head material, non-media = the cap.
    const minDelta = -Math.min(
      previous.durationSeconds - minDuration,
      isSourceMedia(next)
        ? (next.sourceInSeconds ?? 0) / getLayerSpeedAt(next, 0)
        : maxDurationFor(next, composition, options) - next.durationSeconds
    );
    return { minDelta: Math.min(0, minDelta), maxDelta: Math.max(0, maxDelta), previousLayerId: previous.id, nextLayerId: next.id };
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
        const headroom = isSourceMedia(layer) ? (layer.sourceInSeconds ?? 0) / getLayerSpeedAt(layer, 0) : layer.startSeconds;
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

/**
 * Sorted unique edit points for playhead navigation (the up/down-arrow "go to previous/next
 * edit" op): every clip start/end across all tracks, plus 0 and the composition end.
 */
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
  /**
   * Keyframes riding along with the attributes: effect-scope keys (carrying the SOURCE effect ids —
   * remapped to the fresh ids at apply time) and layer-scope `transform.*` keys. Times are
   * layer-local, so they apply as-is; keys past a shorter target clip are simply never reached.
   * Undefined = pre-keyframe snapshot (old saved presets) → apply leaves target animations alone.
   */
  animations?: TimelineKeyframeV2[] | undefined;
}

let clipboardAttributes: LayerAttributes | null = null;

function isTransformKeyframe(keyframe: TimelineKeyframeV2): boolean {
  return keyframe.target?.scope === "layer" && keyframe.target.property.startsWith("transform.");
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
        isTransformKeyframe(keyframe)
    )
    .map((keyframe) => cloneKeyframe(keyframe));
  return {
    effects: layer.effects.map((effect) => ({ ...effect, params: { ...effect.params } })),
    transform: layer.transform ? { ...layer.transform, position: { ...layer.transform.position } } : layer.transform,
    fit: layer.fit,
    animations
  };
}

/** Snapshot a clip's attributes (effects/transform/fit) into the attribute clipboard. */
export function copyLayerAttributes(layer: TimelineLayer): void {
  clipboardAttributes = snapshotLayerAttributes(layer);
}

export function hasClipboardAttributes(): boolean {
  return clipboardAttributes !== null;
}

/**
 * Apply the copied attributes to every target layer: effects are REPLACED with fresh-id clones
 * (per-layer ids so editing one pasted effect never aliases another), transform/fit copied when
 * the source had them, and the source's effect/transform keyframes travel too (effect keys are
 * remapped to the fresh effect ids; the target's own keys in the replaced scopes are dropped,
 * mask/other-scope keys untouched). Content and timing are untouched.
 */
export function pasteLayerAttributes(composition: TimelineComposition, layerIds: string[]): TimelineComposition {
  return applyLayerAttributes(composition, layerIds, clipboardAttributes);
}

/**
 * Apply an explicit attribute snapshot (from the clipboard OR a saved preset) to target layers.
 * Same replacement semantics as paste: fresh per-layer effect ids, transform/fit copied when present.
 */
export function applyLayerAttributes(
  composition: TimelineComposition,
  layerIds: string[],
  attributes: LayerAttributes | null
): TimelineComposition {
  if (!attributes || !layerIds.length) return composition;
  const targets = new Set(layerIds);
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((item) => (targets.has(item.id) ? applyAttributesToLayer(item, attributes) : item))
    }))
  };
}

/** Layer-scoped application of an attribute snapshot (used by paste and by saved effect presets). */
export function applyAttributesToLayer(item: TimelineLayer, attributes: LayerAttributes): TimelineLayer {
  const effects = attributes.effects.map((effect, index) => ({
    ...effect,
    id: `${item.id}_pfx_${index}_${freshId("e").slice(-6)}`,
    params: { ...effect.params }
  }));
  const next: TimelineLayer = {
    ...item,
    effects,
    ...(attributes.transform ? { transform: { ...attributes.transform, position: { ...attributes.transform.position } } } : {}),
    ...(attributes.fit !== undefined && (item.type === "video" || item.type === "image") ? { fit: attributes.fit } : {})
  };
  if (attributes.animations !== undefined) {
    // Remap snapshot effect ids → the fresh per-target ids minted above (index-aligned).
    const freshEffectIdByOldId = new Map<string, string>();
    attributes.effects.forEach((effect, index) => freshEffectIdByOldId.set(effect.id, effects[index]!.id));
    const applyTransformKeys = attributes.transform !== undefined;
    // Replace semantics per scope: the whole effect stack was just replaced, so ALL of the
    // target's effect-scope keys are orphans; transform.* keys are replaced only when the
    // snapshot carries a transform. Mask/track/other-scope keys are never touched.
    const kept = (item.animations ?? []).filter(
      (keyframe) => keyframe.target?.scope !== "effect" && !(applyTransformKeys && isTransformKeyframe(keyframe))
    );
    const incoming: TimelineKeyframeV2[] = [];
    for (const keyframe of attributes.animations) {
      if (keyframe.target?.scope === "effect") {
        const freshEffectId = keyframe.target.effectId ? freshEffectIdByOldId.get(keyframe.target.effectId) : undefined;
        if (!freshEffectId) continue; // key no longer maps to a snapshotted effect
        const clone = cloneKeyframe(keyframe, freshId("kf"));
        clone.target.effectId = freshEffectId;
        incoming.push(clone);
      } else if (applyTransformKeys && isTransformKeyframe(keyframe)) {
        incoming.push(cloneKeyframe(keyframe, freshId("kf")));
      }
    }
    next.animations = [...kept, ...incoming];
    if (applyTransformKeys && item.keyframes?.length) {
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
