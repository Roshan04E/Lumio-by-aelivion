import type { TimelineComposition, TimelineLayer } from "./types";

/**
 * Clip references — the layer that lets a person (typing now, speaking later) name a clip and
 * lets the editor pick a "reference clip" when none is named.
 *
 * Every layer already has a stable internal id (`layer_abc123`), but a person can't say that. So we
 * compute a POSITIONAL ordinal per layer ("clip 4") that follows what the eye sees (left-to-right by
 * start time, top track first), recomputed on every edit — like line numbers in a code editor, not a
 * permanent identity. The resolver then answers "which clip does this command target?" from, in
 * priority order: an explicit id the planner already resolved → a spoken ordinal ("clip 4") → the
 * single selected clip → the single clip under the playhead → ambiguous/none.
 *
 * Pure functions over a TimelineComposition (no React, no web imports) so the planner, the executor,
 * and the timeline badge all share one source of truth.
 */

export interface LayerOrdinal {
  /** 1-based global position across all clips, in eye order — the number shown on the clip badge. */
  ordinal: number;
  /** Spoken label, e.g. "clip 4" — what the user says and what the badge means. */
  label: string;
}

/** `adjustment` layers aren't user-facing clips → they get no number/badge. Everything else does. */
function isBadgedLayer(type: TimelineLayer["type"]): boolean {
  return type !== "adjustment";
}

/**
 * A visual, editable layer that "this clip" (playhead/selection) can point at. Any of these can take
 * a blur/color/opacity/etc. edit. Audio and adjustment are excluded from the playhead "this clip"
 * guess (audio usually spans everything; adjustment isn't a user clip).
 */
export function isVisualTargetLayer(type: TimelineLayer["type"]): boolean {
  return type === "video" || type === "image" || type === "text" || type === "shape";
}

interface FlatLayer {
  layer: TimelineLayer;
  trackIndex: number;
}

/** All layers flattened with their track index, in eye order (start time asc, then top track first). */
function flattenInEyeOrder(composition: TimelineComposition): FlatLayer[] {
  const flat: FlatLayer[] = [];
  composition.tracks.forEach((track, trackIndex) => {
    for (const layer of track.layers) {
      flat.push({ layer, trackIndex });
    }
  });
  return flat.sort((a, b) => a.layer.startSeconds - b.layer.startSeconds || a.trackIndex - b.trackIndex);
}

/**
 * Assign each layer a single GLOBAL positional ordinal in eye order. Flat (not per-type) so the
 * number on the badge and the number the user says ("clip 4") are always the same thing — the Nth
 * clip counting left-to-right, top track first. Adjustment layers get no entry.
 */
export function computeLayerOrdinals(composition: TimelineComposition): Map<string, LayerOrdinal> {
  const result = new Map<string, LayerOrdinal>();
  let counter = 0;
  for (const { layer } of flattenInEyeOrder(composition)) {
    if (!isBadgedLayer(layer.type)) {
      continue;
    }
    counter += 1;
    result.set(layer.id, { ordinal: counter, label: `clip ${counter}` });
  }
  return result;
}

/** Convenience for the timeline badge: layerId → its ordinal number (all kinds). */
export function ordinalsByLayerId(composition: TimelineComposition): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [layerId, entry] of computeLayerOrdinals(composition)) {
    out[layerId] = entry.ordinal;
  }
  return out;
}

export interface ClipReference {
  /** The global clip number the user named ("clip 4" → 4). */
  ordinal: number;
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10
};

// The nouns a user uses for "a clip on the timeline". Flat numbering means any of them → the Nth clip.
const CLIP_WORDS = "clip|layer|video|image|footage|element|track|caption|title|text|shape";
const ORDINAL_WORD_KEYS = Object.keys(ORDINAL_WORDS).join("|");

// "clip 4", "clip #4", "clip number 4"
const NUMERIC_RE = new RegExp(`\\b(?:${CLIP_WORDS})\\s*(?:#|number\\s*)?(\\d{1,3})\\b`, "i");
// "the 4th clip", "4th clip"
const NTH_RE = new RegExp(`\\b(\\d{1,3})(?:st|nd|rd|th)\\s+(?:${CLIP_WORDS})\\b`, "i");
// "second clip", "the fourth layer"
const WORD_RE = new RegExp(`\\b(${ORDINAL_WORD_KEYS})\\s+(?:${CLIP_WORDS})\\b`, "i");

/**
 * Parse a spoken/typed clip reference out of free text. Forgiving: returns `undefined` when no clip
 * is named, so the caller falls back to selection/playhead. Handles "clip 4", "clip #4",
 * "clip number 4", "the 4th clip", "second clip", "layer 2", etc. Requires a clip-noun so that a
 * bare number inside an unrelated phrase ("make it 2x bigger") never matches.
 */
export function parseClipReference(text: string): ClipReference | undefined {
  const numeric = NUMERIC_RE.exec(text);
  if (numeric) {
    const ordinal = Number(numeric[1]);
    if (ordinal > 0) {
      return { ordinal };
    }
  }
  const nth = NTH_RE.exec(text);
  if (nth) {
    const ordinal = Number(nth[1]);
    if (ordinal > 0) {
      return { ordinal };
    }
  }
  const word = WORD_RE.exec(text);
  if (word) {
    const ordinal = ORDINAL_WORDS[word[1]!.toLowerCase()];
    if (ordinal) {
      return { ordinal };
    }
  }
  return undefined;
}

export interface ResolveTargetInput {
  /** Currently selected layer ids. */
  selection: string[];
  /** Playhead time in seconds. */
  nowSeconds: number;
  /** An explicit spoken reference ("clip 4"), when one was parsed. */
  reference?: ClipReference | undefined;
  /** A layer id the planner already resolved — highest priority. */
  explicitLayerId?: string | undefined;
}

/** The layer id at a given global clip ordinal, or undefined. */
export function layerIdForOrdinal(composition: TimelineComposition, ordinal: number): string | undefined {
  for (const [layerId, entry] of computeLayerOrdinals(composition)) {
    if (entry.ordinal === ordinal) {
      return layerId;
    }
  }
  return undefined;
}

export type ResolveTargetReason = "explicit" | "reference" | "selection" | "playhead" | "ambiguous" | "none";

export interface ResolveTargetResult {
  layerId?: string | undefined;
  /** Set when several clips sit under the playhead and no single target could be chosen. */
  candidates?: string[] | undefined;
  reason: ResolveTargetReason;
}

function findLayerById(composition: TimelineComposition, layerId: string): TimelineLayer | undefined {
  for (const track of composition.tracks) {
    const found = track.layers.find((layer) => layer.id === layerId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Resolve the reference clip for a command. Priority: explicit id → spoken ordinal → single
 * selection → single clip under the playhead → ambiguous (several under playhead) → none.
 */
export function resolveTargetLayer(composition: TimelineComposition, input: ResolveTargetInput): ResolveTargetResult {
  // 1. An id the planner already resolved.
  if (input.explicitLayerId && findLayerById(composition, input.explicitLayerId)) {
    return { layerId: input.explicitLayerId, reason: "explicit" };
  }

  // 2. A spoken ordinal ("clip 4").
  if (input.reference) {
    const layerId = layerIdForOrdinal(composition, input.reference.ordinal);
    return layerId ? { layerId, reason: "reference" } : { reason: "none" };
  }

  // 3. Exactly one selected layer that still exists.
  const existingSelection = input.selection.filter((id) => findLayerById(composition, id));
  if (existingSelection.length === 1) {
    return { layerId: existingSelection[0]!, reason: "selection" };
  }

  // 4. Visual layers active at the playhead — the natural "this clip". Any editable visual type
  //    (video/image/graphic/text/shape) qualifies, because edits like blur/color/opacity apply to
  //    all of them. Audio is excluded (it usually spans the whole timeline, so it's a poor "this
  //    clip" guess) and adjustment layers aren't user clips.
  const activeClips: { layerId: string; trackIndex: number }[] = [];
  composition.tracks.forEach((track, trackIndex) => {
    for (const layer of track.layers) {
      if (!isVisualTargetLayer(layer.type)) {
        continue;
      }
      if (input.nowSeconds >= layer.startSeconds && input.nowSeconds <= layer.startSeconds + layer.durationSeconds) {
        activeClips.push({ layerId: layer.id, trackIndex });
      }
    }
  });
  if (activeClips.length === 1) {
    return { layerId: activeClips[0]!.layerId, reason: "playhead" };
  }
  if (activeClips.length > 1) {
    // Prefer the top track as the default, but report the ambiguity so a caller can ask.
    const top = [...activeClips].sort((a, b) => a.trackIndex - b.trackIndex)[0]!;
    return { layerId: top.layerId, candidates: activeClips.map((c) => c.layerId), reason: "ambiguous" };
  }

  // 5. Nothing to target.
  return { reason: "none" };
}
