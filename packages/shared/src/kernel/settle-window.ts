/**
 * Settle-window accounting (ADR-012 slice S2.2) — the pure half.
 *
 * The viewer keeps compositing for `SCENE_SETTLE_MS` after any change, because async work may still be
 * arriving and nothing tells it when everything has landed. That number is a guess at "long enough",
 * and I-31 exists because a bounded wait whose expiry is indistinguishable from its success cannot be
 * reasoned about — when the window closes, nobody knows whether it closed because the picture was ready
 * or because time ran out.
 *
 * S2.1 gave frames identity; S2.2 gives them completion, so the guess can be replaced by an answer:
 * composite until a frame *settles*, then stop, because there is provably nothing left to wait for.
 *
 * **The switch ships behind a flag and the instrument ships in both states.** Collapsing the window is
 * only safe if every async producer re-arms it on arrival, and "most do" is not a property. So the
 * classifier below runs with the flag off too, which lets a soak measure exactly what turning it on
 * would have broken: every `load-bearing` composite is a repaint that closing the window would have
 * lost. Zero across a real session is the evidence to flip it; a non-zero count names a producer that
 * fails to announce itself — a bug to fix, not a reason to keep guessing.
 *
 * Pure and framework-free (I-36), like the coherence decisions in `playback/temporal-coherence.ts`, so
 * the interesting cases are testable without a browser, a GPU or a decoder. The flag that consumes this
 * lives in `apps/web` because reading it needs the DOM; the decision does not.
 */

/** What a settle-window composite was actually for. */
export type CompositeKind =
  /** Playing: the transport drives, the window is irrelevant. Never counted against the window. */
  | "playing"
  /** Converging: inside the window, nothing has settled yet. This is the window doing its job. */
  | "converging"
  /** Surplus: the frame already settled and nothing re-armed since. Pure waste; the flag removes it. */
  | "surplus"
  /**
   * Load-bearing: NOT settled, in a window that was not re-armed since the last settlement — so
   * something arrived without announcing itself and only the timer caught it. **Closing the window
   * would have lost this repaint.** The count that decides whether the flag is safe to flip.
   */
  | "load-bearing";

export interface CompositeContext {
  readonly playing: boolean;
  /** Did the composite BEFORE this one settle? */
  readonly previousSettled: boolean;
  /** Was the window re-armed (`requestDraw`) since that settlement? */
  readonly rearmedSinceSettled: boolean;
  /** Did THIS composite settle? Known only after it runs, which is why this is classified afterwards. */
  readonly settled: boolean;
}

/**
 * Classify one composite. Pure, so the interesting cases are testable without a browser, a GPU or a
 * decoder — the same reason the coherence decisions were extracted.
 *
 * The order of the checks is the whole content of the function. `settled` is examined BEFORE
 * `previousSettled`, because a composite that settles is never waste no matter what preceded it: it is
 * the one that produced the answer.
 */
export function classifyComposite(ctx: CompositeContext): CompositeKind {
  if (ctx.playing) return "playing";
  if (!ctx.previousSettled) return "converging";
  if (ctx.rearmedSinceSettled) return "converging";
  return ctx.settled ? "surplus" : "load-bearing";
}
