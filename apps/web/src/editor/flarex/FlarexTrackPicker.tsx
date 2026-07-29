/**
 * Tracker node — attach a SAVED TRACK from the project's track library.
 *
 * The Tracker node shipped able to follow a track but with nothing to give it one: its params are a
 * `trackingPathId` (provenance) and a `trackingPathData` JSON blob, and the generic schema renderer
 * showed the blob as a text row — a serialized point array in a single-line input, which is not an
 * affordance, it is the absence of one (2026-07-29: "tracker and mask don't have workable UI").
 *
 * This is the picker. It reads the SAME `editableFields.trackLibrary` the clip-mask tracker reads
 * (`MaskItemBody`), labels entries the same way — name plus mean confidence — and writes BOTH params
 * in one edit: the id so the node remembers which saved track it came from, and the data EMBEDDED so
 * the renderers actually receive it. That embedding is a parity decision, not a storage one:
 * `editableFields` lives on `ProjectGraph`, which no renderer sees, so a by-id-only Tracker would
 * follow in the preview and sit still in the export (node-defs states this at the param).
 *
 * Deliberately NOT a tracking UI. Computing a track is the Track Workspace's job; this attaches one
 * that already exists. A node that offered to "track" and then quietly did nothing would be the same
 * mistake in a new place.
 */

import { Unlink } from "lucide-react";
import type { TrackingPathArtifactData } from "@orreris/shared";
import { ThemedSelect, type ThemedSelectGroup } from "../inspector/controls/ThemedSelect";
import { averageTrackConfidence, type SavedTrack } from "../../lib/trackLibrary";

export interface FlarexTrackPickerProps {
  /** `trackingPathId` — the saved track this node was attached from (may name a deleted track). */
  value: string;
  /** `trackingPathData` — the embedded payload the renderers read. Present ⇔ the node really follows. */
  data: TrackingPathArtifactData | null;
  tracks: SavedTrack[];
  onAttach: (track: SavedTrack) => void;
  onDetach: () => void;
}

/** Points + span, so "is this attached, and to what" is answerable without opening the graph editor. */
function describeTrack(data: TrackingPathArtifactData): string {
  const points = data.points.length;
  const span = data.durationSeconds;
  const duration = Number.isFinite(span) && span > 0 ? `${span.toFixed(2)}s` : "unknown length";
  return `${points} point${points === 1 ? "" : "s"} · ${duration}`;
}

export function FlarexTrackPicker({ value, data, tracks, onAttach, onDetach }: FlarexTrackPickerProps) {
  const groups: ThemedSelectGroup<string>[] = [
    {
      label: "Tracks",
      options: tracks.map((track) => ({
        value: track.id,
        label: `${track.label} (${Math.round(averageTrackConfidence(track.trackingPath) * 100)}%)`,
      })),
    },
  ];

  // An id with no matching library entry means the saved track was deleted after it was attached.
  // The node keeps WORKING — the payload is embedded — so this is provenance rot, not breakage, and
  // saying so beats showing an empty select that implies nothing is attached.
  const orphaned = Boolean(value) && !tracks.some((track) => track.id === value);

  return (
    <div className="flarex-track-picker">
      {tracks.length === 0 ? (
        <p className="flarex-track-picker-empty">
          No saved tracks yet. Track a subject in the Track workspace and it appears here.
        </p>
      ) : (
        <ThemedSelect
          value={orphaned ? "" : value}
          groups={groups}
          placeholder="Follow a track…"
          onChange={(next) => {
            const track = tracks.find((item) => item.id === next);
            if (track) onAttach(track);
          }}
        />
      )}
      {data ? (
        <div className="flarex-track-picker-status">
          <span className="flarex-track-picker-meta">{describeTrack(data)}</span>
          <button type="button" className="ui-btn ui-btn-ghost" title="Stop following this track" onClick={onDetach}>
            <Unlink size={13} /> Detach
          </button>
        </div>
      ) : null}
      {orphaned ? (
        <p className="flarex-track-picker-note">
          The saved track this came from was deleted. The node still follows the motion it captured.
        </p>
      ) : null}
    </div>
  );
}
