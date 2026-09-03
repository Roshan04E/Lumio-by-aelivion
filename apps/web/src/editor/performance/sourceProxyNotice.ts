/**
 * The words the editor says about proxy builds. Pure functions, no browser dependency, so the claims
 * they make can be asserted by a millisecond-scale script instead of a browser gate.
 *
 * WHY THEY ARE HERE (DEBT-033, 2026-08-17). Two of the notices were untrue:
 *
 *   "Media optimization finished — proxies rebuilt at full quality" fired at drain end regardless of
 *   outcome, including the 11x4K run where 6 of 11 assets never got a proxy. Silence leaves a user
 *   uncertain; a FALSE SUCCESS closes the question, so they stop looking for the cause of a preview
 *   that is still frozen. That makes it worse than saying nothing.
 *
 *   "Playback may be softer until it finishes" is a 1080p description. At 4K the measured truth is a
 *   preview that does not advance at all, so the sentence is not an understatement, it is the wrong
 *   claim. And the user's instinct on a frozen preview — press play again, scrub around — is exactly
 *   wrong here: playback SUSPENDS the builds that would end the freeze (see
 *   `setSourceProxyBuildSuspended`), so pressing play extends the window that causes the problem.
 *   Nothing in the product told them that waiting is the winning move. That is the difference between
 *   a slow feature and a trap, so the copy now says it.
 */
import type { SourceProxyDrainSummary } from "./sourceProxyEngine";

/**
 * Above this source height, "softer" is the wrong word: the 2026-08-17 measurement showed the canvas
 * not advancing at all while 4K originals play. 1440 rather than 2160 so 1440p/5K/6K/8K sources are
 * described by the honest branch too — the ceiling is about decode cost, and 1080p is the only tier
 * we have actually measured as merely-softer.
 */
const FROZEN_PREVIEW_MIN_SOURCE_HEIGHT = 1440;

/**
 * What playing costs WHILE builds are pending, told truthfully for this source's resolution, plus the
 * non-obvious instruction that follows from build suspension.
 */
export function describeProxyPlaybackCost(sourceHeight: number | null): string {
  const waitingWins = "Playing pauses optimizing, so leaving it parked finishes soonest";
  if (sourceHeight === null) {
    // Resolution not probed yet — cover both tiers rather than picking the flattering one.
    return `Playback may be degraded until it finishes — softer on HD, frozen on 4K. ${waitingWins}`;
  }
  if (sourceHeight >= FROZEN_PREVIEW_MIN_SOURCE_HEIGHT) {
    return `Playing this ${sourceHeight >= 2160 ? "4K" : "high-resolution"} source will freeze the preview until it finishes. ${waitingWins}`;
  }
  return `Playback may be softer until it finishes. ${waitingWins}`;
}

/**
 * The completion notice. Speaks only from counts, and never claims success it did not have.
 * `null` (no summary recorded) is itself a thing we cannot vouch for, so it says so.
 */
export function describeProxyDrainOutcome(summary: SourceProxyDrainSummary | null): string {
  if (!summary || summary.total === 0) {
    return "Media optimization finished — no outcome recorded for this batch";
  }
  const { total, built, failed, skipped } = summary;
  const parts: string[] = [];
  if (built > 0) parts.push(`${built} of ${total} optimized`);
  if (skipped > 0) parts.push(`${skipped} needed none`);
  if (failed > 0) parts.push(`${failed} failed`);
  const head = built === total ? `Media optimization finished — all ${total} optimized` : `Media optimization finished — ${parts.join(", ")}`;
  if (failed === 0) return head;
  // The consequence, not just the count: a failed proxy is not cosmetic, it is a clip that will keep
  // playing its original for the rest of the session.
  return `${head}. Those clips keep playing their originals and may freeze the preview at 4K — rebuild from the source viewer`;
}
