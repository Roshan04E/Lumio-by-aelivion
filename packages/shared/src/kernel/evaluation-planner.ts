/**
 * Incremental evaluation planning (ADR-012 §5.6, slice S6.6; ADR-009 R2, I-18/I-23).
 *
 * ## The payoff slice, and the one with the sharpest failure mode
 *
 * S6.4 gave a node identity across frames. S6.5 said which nodes can still change. This is the slice
 * that finally spends those: a node that is clean, has a result from a previous frame, and whose
 * result is still USABLE does not need to be evaluated again. On a static comp that should approach
 * zero evaluation per frame while producing identical pixels.
 *
 * "Identical pixels" is the whole contract. A plan that skips a node it should have evaluated does not
 * fail loudly — it shows the previous frame's pixels, on a frame that should have looked different,
 * which is the stale-hit class ADR-009 calls unforgivable. So this module inherits S6.5's rule that
 * absence of information resolves toward WORK, and adds a second gate that S6.5 alone cannot provide.
 *
 * ## Clean is NOT sufficient — the third gate
 *
 * S6.4 deliberately shipped write-only, and this is the reason: a node's cached result is a draw whose
 * textures live in pool entries the host may have disposed since. "Nothing about this node changed" and
 * "this node's result can still be drawn" are different claims, and only the second one keeps a frame
 * correct. So reuse requires all three:
 *
 *   1. the node is not in S6.5's dirty closure           (its inputs did not change)
 *   2. a record exists for this node in THIS context     (there is something to reuse)
 *   3. the caller confirms the record is still usable    (its resources are alive — S5.2 handles)
 *
 * Gate 3 is a caller callback rather than a kernel check, and deliberately so: the kernel owns record
 * lifetime and identity, the caller owns meaning (the same split `EvaluationRecord.value: unknown`
 * already draws). A kernel that could tell whether a draw's textures were alive would be a kernel that
 * understands draws. What it CAN do is refuse to let the question go unasked — omit the callback and
 * nothing is reused, because a validity question nobody answered is not a yes.
 *
 * ## Node-blind, and honest about what it skipped
 *
 * Every node in `evaluate` carries a reason. A plan that cannot say why it scheduled work is a plan
 * that cannot be debugged when it schedules too much — and, worse, cannot be audited when it schedules
 * too little.
 */

import { evaluationRecord, type EvaluationRecord } from "./evaluation-records";
import { kernelDiagnostics } from "./diagnostics";
import type { RuntimeSession } from "./session";

/**
 * Why a node was scheduled for evaluation.
 *
 * Every value except `dirty` is an ABSENCE resolving toward work — which is what conservatism looks
 * like once it is written down.
 */
export type PlanReason =
  /** In S6.5's dirty closure: something it depends on changed. */
  | "dirty"
  /** No record from a previous frame — nothing exists to reuse. */
  | "no-record"
  /** A record exists, but the caller says its resources are no longer usable. */
  | "stale-resource"
  /** No validity callback was supplied, so reuse was never permissible at all. */
  | "unvalidated";

export interface EvaluationPlan {
  /** Nodes that must be evaluated this frame. A superset of what strictly must be, by design. */
  readonly evaluate: ReadonlySet<string>;
  /** Nodes whose previous result may be reused verbatim. */
  readonly reuse: ReadonlySet<string>;
  /** Why each scheduled node was scheduled. */
  readonly reasons: ReadonlyMap<string, PlanReason>;
}

export interface PlanRequest {
  /** Every node in the comp. The plan covers exactly this set — nothing is inferred from the tables. */
  readonly nodeIds: readonly string[];
  /** S6.5's closure for this frame. */
  readonly dirty: ReadonlySet<string>;
  /** The evaluation context key for each node, matching what S6.4 recorded under. */
  readonly contextKeyOf: (nodeId: string) => string;
  /**
   * Gate 3. Return true only if this record's result can still be drawn — for a Flarex draw that means
   * every texture handle it holds still resolves (S5.2 generations). OMIT IT and nothing is reused: a
   * validity question nobody answered is not a yes.
   */
  readonly isReusable?: ((record: EvaluationRecord) => boolean) | undefined;
  readonly nowMs: number;
}

export interface ReuseQuery {
  readonly nodeId: string;
  readonly contextKey: string;
  readonly dirty: ReadonlySet<string>;
  readonly isReusable?: ((record: EvaluationRecord) => boolean) | undefined;
  readonly nowMs: number;
}

export type ReuseDecision =
  | { readonly reuse: true; readonly record: EvaluationRecord }
  | { readonly reuse: false; readonly reason: PlanReason };

/**
 * The three gates, for ONE node — the single place they are implemented.
 *
 * A live host cannot use {@link planEvaluation} directly, because a plan has to name each node's
 * evaluation context up front and only the compiler knows that: the context key is `evalKey`'s, minted
 * mid-traversal and folding the evaluation time a retime may have changed. So the host answers per node
 * as it is asked. `planEvaluation` is this function in a loop, which is what keeps the batch view and
 * the live path from drifting into two subtly different notions of reusable.
 *
 * Gate order is deliberate: dirty short-circuits, so a dirty node never looks up a record. Consulting a
 * record for a node already known to be stale is how a reuse path grows an accidental dependency on
 * data it must not trust.
 */
export function reuseDecision(session: RuntimeSession, query: ReuseQuery): ReuseDecision {
  if (query.dirty.has(query.nodeId)) return { reuse: false, reason: "dirty" };
  if (!query.isReusable) return { reuse: false, reason: "unvalidated" };
  const record = evaluationRecord(session, query.nodeId, query.contextKey, query.nowMs);
  if (!record) return { reuse: false, reason: "no-record" };
  if (!query.isReusable(record)) return { reuse: false, reason: "stale-resource" };
  return { reuse: true, record };
}

/** Batch form: {@link reuseDecision} over a known node set, for stats and headless assertions. */
export function planEvaluation(session: RuntimeSession, request: PlanRequest): EvaluationPlan {
  const evaluate = new Set<string>();
  const reuse = new Set<string>();
  const reasons = new Map<string, PlanReason>();

  for (const nodeId of request.nodeIds) {
    const decision = reuseDecision(session, {
      nodeId,
      contextKey: request.contextKeyOf(nodeId),
      dirty: request.dirty,
      isReusable: request.isReusable,
      nowMs: request.nowMs,
    });
    if (decision.reuse) {
      reuse.add(nodeId);
      continue;
    }
    evaluate.add(nodeId);
    reasons.set(nodeId, decision.reason);
  }

  if (kernelDiagnostics.enabled && reuse.size > 0) {
    kernelDiagnostics.record({
      kind: "cache",
      severity: "info",
      subject: { kind: "runtime" },
      reason: "evaluation-plan",
      detail: { evaluated: evaluate.size, reused: reuse.size },
    });
  }

  return { evaluate, reuse, reasons };
}

/**
 * How much of the comp a plan skipped, as the number the done-when is judged on.
 *
 * A static comp should approach 1. Anything below that on an UNCHANGED comp names a gate that is
 * refusing reuse, and `reasons` says which one — which is the difference between "incremental
 * evaluation does not pay off here" and "incremental evaluation never engaged".
 */
export function planReuseRatio(plan: EvaluationPlan): number {
  const total = plan.evaluate.size + plan.reuse.size;
  return total === 0 ? 0 : plan.reuse.size / total;
}
