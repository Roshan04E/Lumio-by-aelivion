/**
 * Readiness Barrier (ADR-012 I-1/I-6, Part 7 T3 — slice S4.4) — the LATEST COHERENT MOMENT.
 *
 * ## The question the old barrier could not answer
 *
 * `shouldHoldForCoherence` returns a boolean, and its very first line is
 * `if (!enabled || playing || …) return false`. It does nothing during playback — by construction,
 * not by accident, because "hold or don't" has no useful answer while the transport is moving. Holding
 * every frame in which one source lags freezes the picture; holding none presents a frame whose sources
 * represent different moments. Neither is coherent, so the gate was simply switched off for the state
 * that matters most, and `tolerateLag` was invented to paper over the consequences.
 *
 * A different question does have an answer while playing: **not "is everything ready at t?" but "what is
 * the latest moment at which everything IS ready?"** That is `effectiveTime`, and once the barrier
 * returns one, playback presents a coherent picture at a declared, bounded lag instead of an incoherent
 * one at the requested time (ADR-012 §6.9). This is the architecture's explicit answer to the question
 * the current runtime avoids by disabling coherence during playback.
 *
 * ## Why the BARRIER owns `effectiveTime`, and nothing else may mint one
 *
 * `time.ts` deliberately shipped without an `effectiveTime` constructor in S4.1, with a note saying the
 * derivation belongs here. The reason is ownership, not tidiness: `effectiveTime` is the ONLY time
 * evaluation is allowed to see (T3), so whoever can mint one decides what the whole frame renders. If
 * any caller could construct it, every caller would be free to invent its own idea of "close enough" —
 * which is precisely the state `tolerateLag`, `NOT_READY_HOLD_MS`, `WC_HOLD_LAG_S` and the paused-only
 * barrier are in today: four independent notions of tolerable lag, none of which can be reconciled
 * because none of them is expressed in the same terms.
 *
 * The barrier can own it because it is the one place that sees ALL participants at once. A single
 * source cannot know the latest common moment; only something holding the whole set can compute it.
 *
 * ## The rule: a minimum, not an average
 *
 * The effective time is the OLDEST served time among participants that constrain the frame — the
 * moment every participant can actually show. Averaging, or taking the newest, produces a time some
 * participant has no pixels for, which is the incoherence this exists to remove.
 *
 * A participant that is time-invariant (a still, a generator raster, a solid) constrains nothing and is
 * excluded: it is coherent at every moment, so letting it vote would be letting `null` win a minimum.
 * This is why {@link ReadinessParticipant.servedTime} is optional and its absence is not zero.
 *
 * ## What this MUST NOT do
 *
 * It does not substitute content — that is I-27, and the host-clip fallback S4.5 deletes is the exact
 * construct it forbids. A participant with no pixels at all cannot be served by moving time backwards;
 * there is no moment at which it has something to show. Such a participant is reported in
 * {@link ReadinessVerdict.degraded} and the frame is declared degraded, never silently filled from
 * somewhere else. Declared absence beats a confident wrong answer.
 *
 * I-36: no DOM, no GL, no decoder. The barrier ranks times and returns a verdict; the host decides what
 * to draw with it.
 */

import { kernelDiagnostics } from "./diagnostics";
import type { RuntimeSession } from "./session";
import { effectiveTimeFromBarrier, type EffectiveTime, type ServedTime, type TargetTime } from "./time";

/**
 * One participant in a frame.
 *
 * `servedTime` absent means TIME-INVARIANT — coherent at every moment, constrains nothing. `null` is a
 * different statement: the participant is time-dependent and has NO pixels, which no choice of
 * effective time can fix. Collapsing the two is how a still ends up dragging a frame backwards, or a
 * dead source ends up looking coherent.
 */
export interface ReadinessParticipant {
  readonly id: string;
  readonly servedTime?: ServedTime | null | undefined;
}

export type ReadinessOutcome =
  /** Every participant can show the requested moment. `effectiveTime === targetTime`. */
  | "coherent"
  /** Coherent, but at a moment behind the request. The declared, bounded lag of §6.9. */
  | "lagged"
  /** At least one participant has no pixels at any moment. Declared, never substituted. */
  | "degraded";

export interface ReadinessVerdict {
  readonly effectiveTime: EffectiveTime;
  readonly outcome: ReadinessOutcome;
  /** How far behind the request the frame is, in seconds. 0 when coherent. */
  readonly lagSeconds: number;
  /** Participants with no pixels at any moment — I-29, every degradation is a declared state. */
  readonly degraded: readonly string[];
  /** Participants whose served time set the effective time. The reason the frame is where it is. */
  readonly constrainedBy: readonly string[];
}

/**
 * The maximum a frame may lag the transport before the barrier stops walking time backwards.
 *
 * Beyond this the frame is declared degraded rather than presented ever-further behind: a picture two
 * seconds late is not a coherent picture, it is a stopped one with a plausible excuse. ADR-012 Open
 * Question 2 flags the exact magnitude as needing measurement on the integrated-GPU target before it
 * becomes normative — this is the declared starting value, not the answer, and it is configuration
 * (§6.12) while conformance to it is not.
 */
export const MAX_PRESENTATION_LAG_S = 0.5;

/**
 * Resolve the latest moment every time-dependent participant can show.
 *
 * Pure and total: same inputs, same verdict, no clock read. That is what lets the same barrier run in
 * the preview, an export and a headless harness (I-37) — and what lets the conformance harness assert
 * its behaviour without a browser.
 */
export function resolveReadiness(
  targetTime: TargetTime,
  participants: readonly ReadinessParticipant[]
): ReadinessVerdict {
  const degraded: string[] = [];
  let oldest = Number.POSITIVE_INFINITY;
  let constrainedBy: string[] = [];

  for (const participant of participants) {
    // Absent = time-invariant. Constrains nothing, votes on nothing.
    if (participant.servedTime === undefined) continue;
    // Null = time-dependent with no pixels. No effective time repairs this, so it is a DECLARED
    // degradation rather than an input to the minimum. Letting it vote would be inventing a moment.
    if (participant.servedTime === null || !Number.isFinite(participant.servedTime)) {
      degraded.push(participant.id);
      continue;
    }
    const served = participant.servedTime as number;
    if (served < oldest) {
      oldest = served;
      constrainedBy = [participant.id];
    } else if (served === oldest) {
      constrainedBy.push(participant.id);
    }
  }

  // Nothing time-dependent to satisfy: the request itself is coherent. A frame of stills is not
  // "lagged by infinity", it is simply on time.
  if (!Number.isFinite(oldest)) {
    return {
      effectiveTime: effectiveTimeFromBarrier(targetTime as number),
      outcome: degraded.length > 0 ? "degraded" : "coherent",
      lagSeconds: 0,
      degraded,
      constrainedBy: [],
    };
  }

  // Never walk FORWARD. A participant serving ahead of the request (a backward seek still holding its
  // old frame — tracker v33's 35-second reading) must not drag the frame into the future; the request
  // is the ceiling. The barrier answers "how far back", never "how far on".
  const effective = Math.min(oldest, targetTime as number);
  const lagSeconds = (targetTime as number) - effective;

  // Past the budget, lagging further is not coherence, it is a stall wearing coherence's clothes.
  // Declared degraded, and the frame is presented at the request rather than dragged back further.
  if (lagSeconds > MAX_PRESENTATION_LAG_S) {
    return {
      effectiveTime: effectiveTimeFromBarrier(targetTime as number),
      outcome: "degraded",
      lagSeconds,
      degraded: [...degraded, ...constrainedBy],
      constrainedBy,
    };
  }

  return {
    effectiveTime: effectiveTimeFromBarrier(effective),
    outcome: degraded.length > 0 ? "degraded" : lagSeconds > 0 ? "lagged" : "coherent",
    lagSeconds,
    degraded,
    constrainedBy,
  };
}

/** Record a barrier verdict worth reading. Allocation-free when diagnostics are off (R1). */
export function noteReadiness(session: RuntimeSession, verdict: ReadinessVerdict): void {
  if (!kernelDiagnostics.enabled) return;
  // `coherent` is the common case and recording it would drown the channel in good news.
  if (verdict.outcome === "coherent") return;
  kernelDiagnostics.record({
    kind: verdict.outcome === "degraded" ? "degradation" : "transition",
    severity: verdict.outcome === "degraded" ? "warn" : "info",
    subject: { kind: "runtime" },
    reason: `readiness:${verdict.outcome}`,
    detail: {
      lagSeconds: verdict.lagSeconds,
      // Joined, not arrays: the diagnostics detail is a flat scalar record by design, so a subject
      // list travels as text rather than forcing the sink to grow a shape for one caller.
      degraded: verdict.degraded.join(","),
      constrainedBy: verdict.constrainedBy.join(","),
    },
  });
}
