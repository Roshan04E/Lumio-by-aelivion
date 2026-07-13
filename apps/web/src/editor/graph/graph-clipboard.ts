/**
 * Keyframe clipboard for the graph editor — module-level (not the system
 * clipboard), time-relative paste at the playhead. Cross-property paste works
 * whenever the copied curve's property still exists on the layer; values are
 * clamped into the destination target's range.
 */
import type { KeyframeHandle, KeyframeInterpolation, TimelineKeyframeV2, TimelineLayer } from "@kimera-by-aelivion/shared";
import { graphTargetKey, type GraphTarget } from "../inspector/keyframeUtils";

export interface ClipboardKeyframe {
  curveKey: string;
  /** Offset from the earliest copied keyframe. */
  relativeTime: number;
  value: number;
  interpolation: KeyframeInterpolation;
  temporal: { in?: KeyframeHandle | undefined; out?: KeyframeHandle | undefined; linked?: boolean | undefined };
}

let clipboard: ClipboardKeyframe[] = [];

export function copyKeyframes(entries: Array<{ curveKey: string; keyframe: TimelineKeyframeV2 }>): number {
  if (!entries.length) return 0;
  const minTime = Math.min(...entries.map((entry) => entry.keyframe.timeSeconds));
  clipboard = entries.map(({ curveKey, keyframe }) => ({
    curveKey,
    relativeTime: keyframe.timeSeconds - minTime,
    value: Number(keyframe.value),
    interpolation: keyframe.interpolation,
    temporal: {
      in: keyframe.temporal.in ? { ...keyframe.temporal.in } : undefined,
      out: keyframe.temporal.out ? { ...keyframe.temporal.out } : undefined,
      linked: keyframe.temporal.linked
    }
  }));
  return clipboard.length;
}

export function hasClipboardKeyframes(): boolean {
  return clipboard.length > 0;
}

function keyframeTarget(target: GraphTarget): TimelineKeyframeV2["target"] {
  if (target.kind === "effect") return { scope: "effect", effectId: target.effectId, property: target.property };
  // transform + generic layer-scope tracks (sourceText never reaches paste — see pasteKeyframes).
  return { scope: "layer", property: target.property };
}

/**
 * Paste at `playheadTime` (layer-local). Returns the updated layer and the new
 * keyframe ids (for selection). Existing keyframes within half a frame of a
 * pasted one on the same curve are replaced.
 */
export function pasteKeyframes(
  layer: TimelineLayer,
  targets: GraphTarget[],
  playheadTime: number,
  fps: number
): { layer: TimelineLayer; ids: string[] } {
  if (!clipboard.length) return { layer, ids: [] };
  const targetByKey = new Map(targets.map((target) => [graphTargetKey(target), target]));
  const stamp = Date.now();
  const ids: string[] = [];
  const added: TimelineKeyframeV2[] = [];
  const replaced = new Set<string>();

  clipboard.forEach((entry, index) => {
    const target = targetByKey.get(entry.curveKey);
    if (!target) return;
    // Source-text keys aren't numeric — they can't round-trip through the value clipboard.
    if (target.kind === "sourceText") return;
    const timeSeconds = playheadTime + entry.relativeTime;
    if (timeSeconds < -1e-6 || timeSeconds > layer.durationSeconds + 1e-6) return;
    const id = `kf_${stamp}_paste_${index}`;
    ids.push(id);
    replaced.add(`${entry.curveKey}@${Math.round(timeSeconds * fps)}`);
    added.push({
      id,
      target: keyframeTarget(target),
      timeSeconds: Math.min(Math.max(timeSeconds, 0), layer.durationSeconds),
      value: Math.min(Math.max(entry.value, target.min), target.max),
      interpolation: entry.interpolation,
      temporal: {
        ...(entry.temporal.in ? { in: { ...entry.temporal.in } } : {}),
        ...(entry.temporal.out ? { out: { ...entry.temporal.out } } : {}),
        ...(entry.temporal.linked !== undefined ? { linked: entry.temporal.linked } : {})
      }
    });
  });
  if (!added.length) return { layer, ids: [] };

  // Drop any existing keyframe that lands on the same curve + frame as a pasted one.
  const keptAnimations = (layer.animations ?? []).filter((kf) => {
    const key =
      kf.target.scope === "layer"
        ? `transform:${kf.target.property}`
        : kf.target.scope === "effect"
          ? `effect:${kf.target.effectId}:${kf.target.property}`
          : undefined;
    if (!key) return true;
    return !replaced.has(`${key}@${Math.round(kf.timeSeconds * fps)}`);
  });

  return {
    layer: { ...layer, animations: [...keptAnimations, ...added] },
    ids
  };
}
