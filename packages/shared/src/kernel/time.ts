/**
 * Time provenance (ADR-012 Part 7, slice S4.1) — **one authority, named derivations, no inference.**
 *
 * THE PROBLEM THIS SOLVES. The audit found four unreconciled clocks and needed four files open to
 * establish which consumer read which. Every one of them is a `number` called `time` or `currentTime`,
 * so the compiler could not tell them apart and neither could a reader. The cost is on record: the
 * audio-master authority gate compared a live anchor-derived time against the COMMITTED store value,
 * which trails it by up to one commit interval, elected a cold-starting element on that stale
 * comparison, and hard-resynced the playhead back to the element's start latency — "playhead moves
 * ~0.5-1s then jumps back to start", reported twice (2026-07-03). Nothing about that mistake was
 * visible at the call site: both sides were `number`.
 *
 * Rule T2 says a subsystem may not hold an unlabelled time. This module makes that MECHANICAL rather
 * than aspirational: the labelled types are not assignable from a bare `number`, so a time that has not
 * come from a named derivation cannot be passed where a labelled one is expected. Unlabelled becomes
 * unrepresentable, which is the slice's stated done-when.
 *
 * ZERO RUNTIME COST. The labels are compile-time brands on `number` — no wrapper object, no allocation,
 * no property read. This is not an optimisation, it is a requirement: these values are produced and
 * consumed per source per frame, and programme risk R1 says instrumentation must not perturb the thing
 * it measures. A `{ seconds, provenance }` box would allocate per source per frame and would make the
 * time model itself a frame-budget item. The brand erases completely; `deriveDecodeTime(t, r)` compiles
 * to arithmetic.
 *
 * Because the brand is a subtype of `number`, arithmetic and comparison keep working unchanged — the
 * asymmetry is the point. Reading a labelled time as a number is free; producing one requires saying
 * where it came from.
 *
 * WHAT IS DELIBERATELY NOT HERE. No `effectiveTime` derivation: that is the Readiness Barrier's to own
 * (S4.4), and the type exists here only so the barrier has something to return and downstream consumers
 * have something to demand. Publishing a way to mint an `EffectiveTime` before the barrier exists would
 * let a caller fabricate the one value T3 says everything downstream must obey.
 */

/**
 * The provenance vocabulary of ADR-012 Part 7, plus one derivation the table does not name.
 *
 * `committed` is an IMPLEMENTATION FINDING, not a re-litigation of the frozen model. Part 7 has a single
 * "timeline time" owned by the Playback Clock, but the running clock has two readers: a live
 * anchor-derived one and a store that is only committed every `playbackCommitIntervalMs`. They differ by
 * up to a commit interval, and confusing them is the documented 2026-07-03 defect above. Collapsing both
 * onto one label would give the slice the ceremony of provenance without the property that makes
 * provenance worth having — that the compiler rejects the confusion that actually happens here.
 */
export type TimeProvenance =
  /** The transport's position; audio-mastered. Owner: Transport. Consumer: Playback Clock only. (T1) */
  | "authoritative"
  /** Authoritative time in composition coordinates — the live, sub-commit value. Owner: Playback Clock. */
  | "timeline"
  /** The latched copy of timeline time that React consumers last observed. Trails `timeline`. */
  | "committed"
  /** The timeline time a frame AIMS to represent. Owner: Frame Scheduler. */
  | "target"
  /** The latest timeline time every admitted source can actually represent; ≤ target. Owner: Barrier. */
  | "effective"
  /** Effective time as transformed by ADR-011 context transforms for a subtree. Owner: Eval Context. */
  | "evaluation"
  /** Per-source media time after retime, in-point and clamping. Owner: Media Manager. */
  | "decode"
  /** The media time a delivered frame ACTUALLY represents. Owner: Decoder Manager. */
  | "served"
  /** The effective time of the frame on screen. Owner: Presentation Barrier. */
  | "presentation";

declare const provenanceBrand: unique symbol;

/** Seconds, labelled with where the value came from. Erases to `number`; see the file header. */
export type Time<P extends TimeProvenance> = number & { readonly [provenanceBrand]: P };

export type AuthoritativeTime = Time<"authoritative">;
export type TimelineTime = Time<"timeline">;
export type CommittedTime = Time<"committed">;
export type TargetTime = Time<"target">;
export type EffectiveTime = Time<"effective">;
export type EvaluationTime = Time<"evaluation">;
export type DecodeTime = Time<"decode">;
export type ServedTime = Time<"served">;
export type PresentationTime = Time<"presentation">;

/**
 * The single unchecked entry point into the labelled world, for the values that genuinely originate
 * outside it: the transport's own position, a decoder reporting what it decoded, a test fixture.
 *
 * Named to be conspicuous in review and greppable in an audit. Every OTHER label must be reached by a
 * derivation below — if a new call site needs this, the question to ask is which derivation is missing,
 * because "I have a number and I need it to be a T" is precisely the inference T2 forbids.
 */
export function unsafeLabelTime<P extends TimeProvenance>(seconds: number, _provenance: P): Time<P> {
  return seconds as Time<P>;
}

/** The transport's position enters the model here and nowhere else (T1). */
export function authoritativeTime(seconds: number): AuthoritativeTime {
  return seconds as AuthoritativeTime;
}

/**
 * Authoritative → timeline. Composition coordinates today equal transport seconds, so this is identity;
 * it exists so the crossing has a name and a place to grow an offset, and so that a consumer wanting
 * timeline time cannot simply read the transport (the shape of the T3 violation, one level up).
 */
export function deriveTimelineTime(authoritative: AuthoritativeTime): TimelineTime {
  return authoritative as number as TimelineTime;
}

/** Timeline → committed. The latch: called by whatever publishes the clock to React consumers. */
export function commitTimelineTime(timeline: TimelineTime): CommittedTime {
  return timeline as number as CommittedTime;
}

/**
 * Committed → timeline, for readers with no live source registered (fixtures, export, worker). Explicit
 * because it is a claim — "no commit latency applies here" — and a claim made silently at a live call
 * site is the 2026-07-03 bug. The fallback in `getLivePlaybackTime` is exactly this case and is the only
 * legitimate use during playback.
 */
export function assumeLiveFromCommitted(committed: CommittedTime): TimelineTime {
  return committed as number as TimelineTime;
}

/** Timeline → target: the moment this frame aims at. Owner: Frame Scheduler (ADR-012 3.3). */
export function deriveTargetTime(timeline: TimelineTime): TargetTime {
  return timeline as number as TargetTime;
}

/**
 * Effective → evaluation, through an ADR-011 context transform. `transform` receives plain seconds
 * because a context transform is arithmetic on a moment, not a provenance change — the change of label
 * IS this function, which is why the transform cannot be applied anywhere else and still typecheck.
 */
export function deriveEvaluationTime(
  effective: EffectiveTime,
  transform: (seconds: number) => number = (seconds) => seconds
): EvaluationTime {
  return transform(effective) as EvaluationTime;
}

/**
 * Evaluation → decode, per source: retime, in-point, clamp. This is the one derivation that is genuinely
 * per-source, and the clamp is not incidental — an unclamped decode time past a source's available media
 * is the tail ping-pong / seek storm this repo has already paid for once.
 */
export function deriveDecodeTime(
  evaluation: EvaluationTime,
  options: { sourceInSeconds?: number; rate?: number; durationSeconds?: number } = {}
): DecodeTime {
  const { sourceInSeconds = 0, rate = 1, durationSeconds } = options;
  const raw = sourceInSeconds + (evaluation as number) * rate;
  const upper = durationSeconds != null && Number.isFinite(durationSeconds) ? durationSeconds : Infinity;
  return Math.max(0, Math.min(upper, raw)) as DecodeTime;
}

/**
 * The media time a delivered frame actually represents (T5). A source that cannot report one is
 * time-invariant BY DECLARATION or is not-ready — never "assume it's the time we asked for", which is
 * the assumption the staleness clamp was silently making.
 */
export function servedTime(seconds: number): ServedTime {
  return seconds as ServedTime;
}

/** The effective time of a frame on screen. Owner: Presentation Barrier (T8 enforces monotonicity). */
export function derivePresentationTime(effective: EffectiveTime): PresentationTime {
  return effective as number as PresentationTime;
}

/**
 * How far a delivered frame is from the moment it was supposed to represent, in seconds. Positive means
 * the frame is BEHIND. The staleness question, asked once, in the vocabulary that makes both operands
 * unambiguous — the previous formulation of it took two bare numbers and a comment explaining which was
 * which, and reported the clamp's output rather than its input until 2026-08-01.
 */
export function coherenceGap(target: TargetTime | EffectiveTime, served: ServedTime): number {
  return (target as number) - (served as number);
}
