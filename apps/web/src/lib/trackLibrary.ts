import type { TrackingPathArtifactData } from "@lumio-by-aelivion/shared";

/**
 * A single named, saved tracking result that can be attached to any timeline layer
 * (text, shape, image, video) any number of times via trackingPathToPositionKeyframes,
 * without re-tracking. Persisted in `editableFields.trackLibrary` so it survives
 * reloads - tracking is expensive (a real per-frame local computation), so once a
 * subject/point is tracked it should be reusable across the whole project.
 */
export interface SavedTrack {
  id: string;
  label: string;
  trackingPath: TrackingPathArtifactData;
}

/** Real post-track confidence (mean of the per-frame NCC-derived confidence). */
export function averageTrackConfidence(trackingPath: TrackingPathArtifactData): number {
  const points = trackingPath.points;
  if (!points.length) {
    return 0;
  }
  return points.reduce((sum, point) => sum + point.confidence, 0) / points.length;
}

/** Linear-interpolated tracked position at an arbitrary time - used to seed a fix marker at a scrubbed frame. */
export function trackPositionAtTime(trackingPath: TrackingPathArtifactData, timeSeconds: number): { x: number; y: number } | undefined {
  const points = trackingPath.points;
  if (!points.length) {
    return undefined;
  }
  const first = points[0]!;
  if (timeSeconds <= first.timeSeconds) {
    return { x: first.position.x, y: first.position.y };
  }
  const last = points[points.length - 1]!;
  if (timeSeconds >= last.timeSeconds) {
    return { x: last.position.x, y: last.position.y };
  }
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (timeSeconds <= b.timeSeconds) {
      const span = b.timeSeconds - a.timeSeconds || 1;
      const f = (timeSeconds - a.timeSeconds) / span;
      return { x: a.position.x + (b.position.x - a.position.x) * f, y: a.position.y + (b.position.y - a.position.y) * f };
    }
  }
  return { x: last.position.x, y: last.position.y };
}
