/**
 * One user gesture = one committed transaction.
 *
 * The timeline already works this way: a clip drag is handled imperatively and calls
 * `updateComposition` **once**, on drop. The parameter path did not — `NumberControl` fires
 * `onChange` per pointer-move, so a 20-move drag produced 20 graph writes and **19 undo
 * entries**, meaning nineteen Ctrl+Z presses to undo one slider adjustment.
 *
 * That was measured, not assumed (`apps/worker/src/oris-write-grain-probe.ts`; results in
 * `plans/oris-outcome-seam-design.md` §14.0). The editor had two different definitions of
 * "a user action" and no policy anywhere had chosen either.
 *
 * This module is the missing gesture concept. It does NOT suppress writes — live preview
 * depends on them, and the timeline's imperative approach is not available to a controlled
 * React input. It coalesces the **history entry**: the first write in a gesture records the
 * pre-gesture state, and the rest amend it. The undo stack therefore holds one entry per
 * gesture, which is what a human means by "a change" and what the Experience Stream should
 * later record as one committed transaction.
 *
 * Deliberately module-level rather than context: the write choke point is not inside the React
 * tree that owns the control, and threading a provider through every inspector panel would be a
 * far larger change to a far more load-bearing file for no additional correctness.
 */

/**
 * What a caller DECLARES about a commit it is making.
 *
 * The write choke point sees a whole composition: it witnesses *that* a commit happened and
 * *when*, never *who* asked for it or *what* operation it was. The registry knows those, but
 * the AI path funnels through `commitComposition → updateComposition` and drops them on the
 * way, so at the choke point an AI commit and a human commit are indistinguishable.
 *
 * Rather than infer (ADR-016 I2/I10 — a plausible attribution is a fabrication), the seam
 * carries an optional declaration from callers that genuinely know, and **nothing at all** from
 * callers that do not. Absence is the honest record, not missing data.
 */
export interface CommitIntent {
  /** Only ever set by a caller that actually knows. Absent ⇒ undeclared, NOT "user". */
  initiator?: "ai" | "user";
  /**
   * The registry actions this commit carries, where the caller came through the registry and
   * kept their identity. A LIST, not a scalar: the chat panel executes several actions and
   * commits once, so a scalar would silently record only the last one.
   */
  actionIds?: string[];
  /** Human-readable, for explainability. Never parsed — ADR-015 D4. */
  summary?: string;
}

let depth = 0;
let pushedDuringGesture = false;

/** Open a gesture scope. Call on pointer-down of a continuous control. Re-entrant. */
export function beginEditGesture(): void {
  if (depth === 0) {
    pushedDuringGesture = false;
  }
  depth += 1;
}

/** Close a gesture scope. Call on pointer-up AND pointer-cancel — a cancel is still an end. */
export function endEditGesture(): void {
  depth = Math.max(0, depth - 1);
  if (depth === 0) {
    pushedDuringGesture = false;
  }
}

/**
 * Should this write push a NEW undo entry?
 *
 * Outside a gesture: always yes — unchanged behaviour for every existing caller, which is what
 * keeps this safe to add to the write choke point.
 * Inside a gesture: only the first write, so the entry captures the state before the gesture
 * began rather than the state one pointer-move ago.
 */
export function shouldRecordHistoryEntry(): boolean {
  if (depth === 0) {
    return true;
  }
  if (pushedDuringGesture) {
    return false;
  }
  pushedDuringGesture = true;
  return true;
}

/** Test/probe visibility only. */
export function isEditGestureOpen(): boolean {
  return depth > 0;
}
