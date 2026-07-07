import { getLayerSpeed, type TimelineComposition, type TimelineLayer } from "@lumio-by-aelivion/shared";

export type ThreePointOp = "insert" | "overwrite";

export type ThreePointEditRequest = {
  trackId: string;
  layer: TimelineLayer;
};

const MIN_LAYER_SECONDS = 0.05;

function round3(value: number) {
  return Number(value.toFixed(3));
}

/**
 * Applies a source-monitor Insert/Overwrite edit to a composition. Pure function — the caller
 * (EditorPage) commits the result via updateComposition, so this stays a single undo step.
 * Only touches the track each request targets (video track + its linked companion audio track,
 * one request per track) — never other tracks.
 */
export function applyThreePointEdit(composition: TimelineComposition, edits: ThreePointEditRequest[], op: ThreePointOp): TimelineComposition {
  let next = composition;
  for (const edit of edits) {
    next = op === "insert" ? applyInsert(next, edit) : applyOverwrite(next, edit);
  }
  return next;
}

function applyOverwrite(composition: TimelineComposition, edit: ThreePointEditRequest): TimelineComposition {
  const { trackId, layer } = edit;
  const start = layer.startSeconds;
  const end = start + layer.durationSeconds;

  return {
    ...composition,
    tracks: composition.tracks.map((track) => {
      if (track.id !== trackId) return track;

      const nextLayers: TimelineLayer[] = [];
      for (const existing of track.layers) {
        const exStart = existing.startSeconds;
        const exEnd = existing.startSeconds + existing.durationSeconds;
        const overlaps = exStart < end && exEnd > start;
        if (!overlaps) {
          nextLayers.push(existing);
          continue;
        }

        const speed = getLayerSpeed(existing);
        const coveredFully = exStart >= start && exEnd <= end;
        if (coveredFully) {
          continue;
        }

        const overlapsHead = exStart < start && exEnd > start && exEnd <= end;
        const overlapsTail = exStart >= start && exStart < end && exEnd > end;
        const overlapsBoth = exStart < start && exEnd > end;

        if (overlapsHead) {
          const trimmed = round3(start - exStart);
          if (trimmed >= MIN_LAYER_SECONDS) {
            nextLayers.push({ ...existing, durationSeconds: trimmed });
          }
          continue;
        }

        if (overlapsTail) {
          const delta = round3(end - exStart);
          const remaining = round3(exEnd - end);
          if (remaining >= MIN_LAYER_SECONDS) {
            nextLayers.push({
              ...existing,
              startSeconds: round3(end),
              durationSeconds: remaining,
              sourceInSeconds: round3((existing.sourceInSeconds ?? 0) + delta * speed)
            });
          }
          continue;
        }

        if (overlapsBoth) {
          const headDuration = round3(start - exStart);
          if (headDuration >= MIN_LAYER_SECONDS) {
            nextLayers.push({ ...existing, durationSeconds: headDuration });
          }
          const tailDuration = round3(exEnd - end);
          if (tailDuration >= MIN_LAYER_SECONDS) {
            nextLayers.push({
              ...existing,
              id: `${existing.id}_ow_${Date.now()}`,
              startSeconds: round3(end),
              durationSeconds: tailDuration,
              sourceInSeconds: round3((existing.sourceInSeconds ?? 0) + (end - exStart) * speed)
            });
          }
          continue;
        }
      }

      nextLayers.push(layer);
      return { ...track, layers: nextLayers };
    })
  };
}

function applyInsert(composition: TimelineComposition, edit: ThreePointEditRequest): TimelineComposition {
  const { trackId, layer } = edit;
  const start = layer.startSeconds;
  const insertDuration = layer.durationSeconds;

  return {
    ...composition,
    tracks: composition.tracks.map((track) => {
      if (track.id !== trackId) return track;

      const nextLayers: TimelineLayer[] = [];
      for (const existing of track.layers) {
        const exStart = existing.startSeconds;
        const exEnd = existing.startSeconds + existing.durationSeconds;

        if (exStart >= start) {
          nextLayers.push({ ...existing, startSeconds: round3(exStart + insertDuration) });
          continue;
        }

        if (exEnd > start) {
          const speed = getLayerSpeed(existing);
          const headDuration = round3(start - exStart);
          if (headDuration >= MIN_LAYER_SECONDS) {
            nextLayers.push({ ...existing, durationSeconds: headDuration });
          }
          const tailDuration = round3(exEnd - start);
          if (tailDuration >= MIN_LAYER_SECONDS) {
            nextLayers.push({
              ...existing,
              id: `${existing.id}_ins_${Date.now()}`,
              startSeconds: round3(start + insertDuration),
              durationSeconds: tailDuration,
              sourceInSeconds: round3((existing.sourceInSeconds ?? 0) + (start - exStart) * speed)
            });
          }
          continue;
        }

        nextLayers.push(existing);
      }

      nextLayers.push(layer);
      return { ...track, layers: nextLayers };
    })
  };
}
