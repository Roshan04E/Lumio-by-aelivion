import type { TimelineComposition, TimelineLayer } from "@orreris/shared";

/**
 * Visible-range helpers (Phase 3 interface; consumed by preview + timeline in
 * Phase 5). Only layers intersecting the on-screen time window need to be
 * rendered/decoded — the key to keeping large compositions cheap.
 */
export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

/** Does a layer overlap the given time window? */
export function layerIntersectsRange(layer: TimelineLayer, range: TimeRange): boolean {
  const layerEnd = layer.startSeconds + layer.durationSeconds;
  return layerEnd > range.startSeconds && layer.startSeconds < range.endSeconds;
}

/** All layers (flattened) that intersect the range — render/decoder candidates. */
export function layersInRange(composition: TimelineComposition, range: TimeRange): TimelineLayer[] {
  return composition.tracks
    .flatMap((track) => track.layers)
    .filter((layer) => layerIntersectsRange(layer, range));
}

/** Window around the playhead for preview prefetch/culling. */
export function playheadRange(currentSeconds: number, paddingSeconds = 1): TimeRange {
  return { startSeconds: Math.max(0, currentSeconds - paddingSeconds), endSeconds: currentSeconds + paddingSeconds };
}
