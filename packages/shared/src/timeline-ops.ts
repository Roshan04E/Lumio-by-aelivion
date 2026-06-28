import type { TimelineComposition, TimelineLayer } from "./types";

/** Timeline interaction tools (hybrid model): smart select, blade/razor split, hand pan. */
export type TimelineToolMode = "select" | "blade" | "hand";

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
      right.sourceInSeconds = (layer.sourceInSeconds ?? 0) + localSplit;
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
