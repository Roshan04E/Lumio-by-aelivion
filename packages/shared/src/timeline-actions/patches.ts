import { applyPatches, enablePatches, produceWithPatches, type Patch } from "immer";
import type { TimelineComposition } from "../types";
import type { TimelineActionResult } from "./types";

enablePatches();

export type { Patch };

export interface MutationResult {
  after: TimelineComposition;
  patch: Patch[];
  undoPatch: Patch[];
}

/**
 * Run an in-place style mutation on a draft of the composition and capture the
 * forward + inverse JSON patches. The base is never mutated.
 */
export function runMutation(
  before: TimelineComposition,
  mutate: (draft: TimelineComposition) => void
): MutationResult {
  const [after, patch, undoPatch] = produceWithPatches(before, (draft) => {
    mutate(draft as TimelineComposition);
  });
  return { after, patch: [...patch], undoPatch: [...undoPatch] };
}

/**
 * Wrap a pure op that returns a whole new composition (e.g. `splitLayerAtTime`).
 * Produces coarse but always-correct patches (top-level field replacement) — the
 * snapshot before/after remain the reliable undo source.
 */
export function runReplace(
  before: TimelineComposition,
  compute: (before: TimelineComposition) => TimelineComposition
): MutationResult {
  const next = compute(before);
  return runMutation(before, (draft) => {
    draft.tracks = next.tracks;
    draft.durationSeconds = next.durationSeconds;
    draft.backgroundColor = next.backgroundColor;
    if (next.settings !== undefined) {
      draft.settings = next.settings;
    }
  });
}

/** Apply a forward (or inverse) patch set to a composition — used for redo/undo-by-patch. */
export function applyPatch(composition: TimelineComposition, patch: Patch[]): TimelineComposition {
  return applyPatches(composition, patch);
}

/** Assemble the public action result from a mutation + a human summary. */
export function actionResult(
  before: TimelineComposition,
  mutation: MutationResult,
  summary: string
): TimelineActionResult {
  return {
    before,
    after: mutation.after,
    patch: mutation.patch,
    undoPatch: mutation.undoPatch,
    summary
  };
}
