/**
 * Flarex lowering degradations — the compiler's observability out-channel (slice S0.2).
 *
 * ## Why this exists
 *
 * The lowering compiler answers "what does this node draw?" and, when it cannot answer fully, it
 * degrades. The 2026-08-01 runtime audit found ten distinct degradation sites that were mutually
 * indistinguishable from outside: eight returned `null` and two silently substituted the HOST CLIP's
 * pixels. Nothing recorded which had happened, or how often, or for which node — so the single most
 * damaging construct in the runtime (a node showing another shot's picture) was invisible in
 * production and unmeasurable in review.
 *
 * This module gives every one of those outcomes a name. It changes nothing about what the compiler
 * returns.
 *
 * ## The contract, and the precedent it follows
 *
 * `FlarexLowerCtx.onDegrade` is **purely an out-channel**, exactly like `buildSceneDraws`'
 * `onLayerNotReady`: attaching it or omitting it produces byte-identical draws. Omit it (export,
 * worker, fixtures) and the compiler behaves as it always has. That equivalence is asserted by the
 * pixel gate, with the channel attached and detached.
 *
 * The compiler deliberately does NOT import the kernel diagnostics sink. Lowering stays free of
 * policy (ADR-012 I-15) and free of kernel dependencies; the caller decides what a degradation means
 * and where it is recorded. This module is vocabulary, not machinery.
 *
 * ## What this is a precondition for
 *
 * Slice S4.5 deletes the host-clip fallback (ADR-012 §0.3, I-27). Deleting it trades a wrong picture
 * for a missing one, and that trade cannot be evaluated without knowing how often the substitution
 * actually fires in real projects, on which nodes, and under which of its three causes. `substituted`
 * below is that measurement.
 */

import type { FlarexNodeType } from "./types";

/**
 * Why a node produced less than it was asked for. Deliberately closed and deliberately fine-grained:
 * the three `host-substituted:*` reasons share an outcome but have completely different fixes, and
 * collapsing them is what made this class of bug hard to see in the first place.
 */
export type FlarexDegradationReason =
  /** No `resolveSourceDraw` on the ctx at all (Phase-1 callers, fixtures). Host clip substituted. */
  | "host-substituted:no-resolver"
  /** The resolver returned `null` — no loader owns this node. Host clip substituted. */
  | "host-substituted:no-loader"
  /** The resolver returned `"pending"` at an UN-retimed time — same moment, so the host is a genuine
   *  soft-degrade rather than a different moment. Host clip substituted. */
  | "host-substituted:pending"
  /** The source ran past its own duration (short clip in a longer comp). Produces nothing. */
  | "source-ended"
  /** A loader owns this node but has no picture yet, under a retime — so the host would be a
   *  DIFFERENT moment, not a degraded one. Produces nothing. (ADR-011 / the 2026-07-29 fix.) */
  | "source-pending-retimed"
  /** A generator (Text+/Background) whose backing virtual layer is absent or not rasterized. */
  | "generator-unbacked"
  /** The node type is declared but not implemented by the lowering compiler (e.g. `aiMatte`). */
  | "node-unimplemented"
  /** A cycle was detected during traversal. Degrades rather than hanging. */
  | "graph-cycle"
  /** An edge referenced a node id that is not in the comp. The healer should have caught this. */
  | "node-missing"
  /** A node with no usable upstream input. Structural (a disconnected node), not a runtime failure. */
  | "input-missing";

export interface FlarexDegradation {
  readonly nodeId: string;
  /** `undefined` only for `node-missing`, where there is no node to read a type from. */
  readonly nodeType: FlarexNodeType | undefined;
  readonly reason: FlarexDegradationReason;
  /**
   * **The field this slice exists for.** `true` means the node emitted content belonging to a
   * DIFFERENT source — the host clip — rather than declaring absence. Every `true` is an instance of
   * the ADR-012 I-27 violation that S4.5 deletes, and the count is what makes that deletion a
   * measured decision instead of a hopeful one.
   */
  readonly substituted: boolean;
  /**
   * The time this node was being evaluated at, which under a TimeSpeed is NOT the frame's time. Both
   * are reported because the difference between them is exactly what distinguishes
   * `host-substituted:pending` (same moment, honest degrade) from `source-pending-retimed`
   * (different moment, would have been a lie).
   */
  readonly atTimeSeconds: number;
  readonly frameTimeSeconds: number;
}

/** The out-channel signature. Attaching it must never change what the compiler returns. */
export type FlarexOnDegrade = (degradation: FlarexDegradation) => void;

/**
 * Does this reason mean the node emitted someone else's pixels? Kept beside the union so a new reason
 * cannot be added without deciding the question — the whole point of the record.
 */
export function isSubstitutionReason(reason: FlarexDegradationReason): boolean {
  return reason === "host-substituted:no-resolver" || reason === "host-substituted:no-loader" || reason === "host-substituted:pending";
}
