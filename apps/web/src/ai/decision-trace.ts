/**
 * Orreris OS — the decision trace (K5, ORRERIS_OS.md → Explainability). Every layer of the
 * runtime is deterministic data, so the full "why" of an edit is serializable:
 *
 *   intent → route (tier/rule/provider) → facts consulted (with provenance) → repairs →
 *   operations applied
 *
 * The panel records one DecisionTrace at every apply/answer seam; the tier-0 WHY reflex
 * ("why did you do that?") answers from the latest record — instantly, honestly, 0 tokens.
 * No LLM-first product can produce this honestly, because their model IS the black box;
 * ours is registered data end to end. Pure module (node-safe) — covered by brain:eval.
 */

import { appendDecisionEvent } from "./experience/stream";
import type { DecisionAction, DecisionCandidate, DecisionOwner } from "./experience/stream";

export interface DecisionTrace {
  /** The user ask that produced the decision. */
  prompt: string;
  /** Honest route label: "⚡ Instant reflex (t0.remove-look)", "🌐 World Model hypothesis planner (k4.mood-blueprint)", "🤖 model (groq)". */
  route: string;
  /** True when no model was involved anywhere on the path. */
  zeroTokens: boolean;
  /** Provenance lines: facts consulted + access paths, repairs, planner notes. */
  notes: string[];
  /** Step summaries in execution order (empty for a pure answer). */
  steps: string[];
  applied: number;
  failed: number;
  /** When the decision FINISHED. Paired with `startedAt`; see that field. */
  at: number;

  // ── ORIS Stage A enrichment (ORIS_RESEARCH_PROGRAMME.md §12.1) ─────────────────────────
  // All optional: the WHY reflex and the transcript's trace row consume only the fields
  // above, so every existing call site stays valid and nothing about the runtime changes.
  // These widen the OBSERVATION surface; they do not alter behaviour.

  /** Who made the claim — structured, so attribution never parses the `route` display string. */
  owner?: DecisionOwner;
  /** The claim itself. H5 (calibration) cannot be tested without it. */
  confidence?: { label: string; percent: number | null };
  /** When the decision STARTED. A pair, not a duration — a scalar destroys temporal overlap. */
  startedAt?: number;
  /** Structured actions; `steps` remains the human-readable rendering of the same thing. */
  actions?: DecisionAction[];
  /** Hypotheses considered, including the rejected ones — the counterfactual record. */
  candidates?: DecisionCandidate[];
}

let last: DecisionTrace | null = null;

export function recordDecisionTrace(trace: DecisionTrace): void {
  last = trace;
  // ORIS Stage A (O1): the trace is also an EPISODE — one thing that happened, in order,
  // with an outcome. Appending here rather than at each call site means every apply/answer
  // seam the runtime already has, and every future one, lands in the corpus for free.
  // Purely additive: the WHY reflex still reads `last`, and a stream failure must never
  // break an edit, so the append is guarded.
  try {
    appendDecisionEvent(trace);
  } catch {
    // Observability must not be able to take down the thing it observes.
  }
}

export function getLastDecisionTrace(): DecisionTrace | null {
  return last;
}

/** Test/reset seam. */
export function clearDecisionTrace(): void {
  last = null;
}

/** The WHY answer — provenance-first, no mystique. */
export function formatDecisionTrace(trace: DecisionTrace): string {
  const lines: string[] = [`**Why the last result** — “${trace.prompt}”`];
  lines.push(`- Route: ${trace.route}${trace.zeroTokens ? " · 0 tokens" : ""}`);
  for (const note of trace.notes) {
    lines.push(`- ${note}`);
  }
  if (trace.steps.length > 0) {
    lines.push(`- Did: ${trace.steps.join(" · ")}`);
    if (trace.failed > 0) {
      lines.push(`- Outcome: ${trace.applied} applied, ${trace.failed} failed`);
    }
  } else {
    lines.push(`- Did: answered only — no edit was made`);
  }
  lines.push(`\n_Every step above is deterministic, registry-validated data — replayable and undoable._`);
  return lines.join("\n");
}
