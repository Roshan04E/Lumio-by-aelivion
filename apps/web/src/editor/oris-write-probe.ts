/**
 * ORIS — Q5 write-grain probe. **A measurement instrument, not a feature.**
 *
 * `plans/oris-outcome-seam-design.md` Q5 asks whether the committed-transaction boundary is
 * already the natural observation boundary for a user-action producer, or whether gestures
 * write per-frame and coalescing has to be invented. That is an empirical question about the
 * running editor, and it was going to be answered by intuition otherwise.
 *
 * Gated on `?orisWriteProbe=1`, off by every other path, and deliberately incapable of
 * affecting what it measures:
 *  - it never reads composition state, so it cannot retain anything;
 *  - it never throws into the write path (the whole body is inside a try/catch);
 *  - with the flag off, `note()` is a single boolean check.
 *
 * This is NOT the user-action producer. It writes nothing to the Experience Stream: under
 * ADR-016 I13/I14 an instrument's readings are not evidence about the organism, and a probe
 * that quietly seeded the corpus would be exactly the contamination ADR-016 exists to prevent.
 */

import type { CommitIntent } from "./gesture-scope";

export interface GraphWriteSample {
  /** ms since probe start — relative, because only INTERVALS matter for grain. */
  at: number;
  /** Did the write actually change the graph (i.e. would it push an undo entry)? */
  changed: boolean;
  /** Undo depth BEFORE this write. Its growth is the per-gesture entry count. */
  undoDepth: number;
  /** False for history-suppressed writes — undo/redo and metadata saves take this path. */
  recordsHistory: boolean;
  /** What the caller DECLARED. `null` = undeclared, which is a reading, not a gap. */
  initiator: "ai" | "user" | null;
  /** Registry actions this commit carried, where the caller kept their identity. */
  actionIds: string[] | null;
}

const FLAG = "orisWriteProbe";
const MAX_SAMPLES = 5000;

const samples: GraphWriteSample[] = [];
let started = 0;

/**
 * Installed EAGERLY at module load, not lazily on first write.
 *
 * The lazy version was wrong in the way this whole programme is about: with no write yet, the
 * global was absent, and a reader could not distinguish "the probe is off" from "the probe is
 * on and nothing has been written". The harness's proof-of-life check (ADR-016 I13) caught it
 * on the first real run — which is the check earning its place, since the alternative was a
 * report of all zeros that looked like a finding.
 */
const enabled: boolean = (() => {
  try {
    if (new URLSearchParams(window.location.search).get(FLAG) !== "1") {
      return false;
    }
  } catch {
    return false;
  }
  started = performance.now();
  (window as unknown as Record<string, unknown>).__orisWriteProbe = {
    samples: () => samples.slice(),
    reset: () => {
      samples.length = 0;
      started = performance.now();
    }
  };
  return true;
})();

/** Called from the graph write choke point. Must stay cheap and must never throw. */
export function orisNoteGraphWrite(
  changed: boolean,
  undoDepth: number,
  recordsHistory: boolean,
  intent?: CommitIntent
): void {
  try {
    if (!enabled || samples.length >= MAX_SAMPLES) {
      return;
    }
    samples.push({
      at: Math.round(performance.now() - started),
      changed,
      undoDepth,
      recordsHistory,
      initiator: intent?.initiator ?? null,
      actionIds: intent?.actionIds ?? null
    });
  } catch {
    // An instrument may never break the thing it observes.
  }
}
