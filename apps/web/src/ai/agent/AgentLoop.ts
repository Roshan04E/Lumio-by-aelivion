import type { AiPlan, ConversationTurn, PlanEventHandler, PlannerContext, PlannerProvider } from "../types";

/**
 * The agentic loop — the Claude-Code mechanism: observe → think → act → observe the REAL result →
 * decide the next action. Each iteration re-plans against a fresh timeline context plus a compact
 * log of what was actually executed (with real registry outcomes), so step 2 can react to what
 * step 1 truly did — something the one-shot plan→execute flow could never do.
 *
 * Token economy (hard requirements — see plan B2.5):
 * - The system prompt + capability catalog are static per iteration (provider prefix-cache hits);
 *   the only growing content is the compact action log.
 * - Action results ride as ONE-LINE "ACTION RESULT:" turns, capped at the most recent
 *   `MAX_ACTION_LINES`; the model's own reasoning is display-only and NEVER echoed back.
 * - Batching bias lives in the prompt (AGENTIC MODE): typical asks finish in 1–2 iterations.
 * - Per-mode iteration caps + a char-budget guard: at 80% spent the model is told to FINISH NOW
 *   (apply its best remaining plan as one batch), and the cap is surfaced honestly to the user.
 */

const MAX_ACTION_LINES = 8;
/** Rough per-run dynamic budget (chars ≈ tokens×4). Static prompt/capabilities are excluded —
 * they're cacheable; this bounds only the growth the loop itself causes. */
const RUN_CHAR_BUDGET = 24_000;

export const AGENT_ITERATION_CAPS: Record<string, number> = {
  quick: 3,
  professional: 8,
  agent: 12
};

export interface AgentBatchOutcome {
  /** One-line real results, e.g. `splitClip → ok: Split "beach" at 4.10s`. */
  lines: string[];
  applied: number;
  failed: number;
  skipped: number;
}

export interface AgentLoopDeps {
  planner: PlannerProvider;
  /** Fresh planner context each iteration (slice/selection/history from the panel). */
  buildContext: () => PlannerContext;
  /** Execute one validated plan batch via the real executor; resolves with real outcomes. */
  executeBatch: (plan: AiPlan) => Promise<AgentBatchOutcome>;
  /**
   * Professional mode: called ONCE before the first mutating batch — resolves with the approved
   * (possibly per-step-filtered) plan, or null to cancel. After one approval the loop free-runs.
   * Absent → auto-run (Agent/Quick).
   */
  requestApproval?: ((plan: AiPlan) => Promise<AiPlan | null>) | undefined;
  /** Ask the user a clarify question inline; resolves with their answer (null = dismissed). */
  askUser: (question: string) => Promise<string | null>;
  /**
   * Resolve a capability's full doc CLIENT-side for `inspect` steps (free, instant, no mutation) —
   * the agent "reading the tool manual". Null when the id matches nothing.
   */
  inspectCapability: (capabilityId: string) => string | null;
  /** Surface an inspect step in the transcript (id + whether a doc was found). */
  onInspected?: ((capabilityId: string, found: boolean) => void) | undefined;
  /** Final conversational answer / run summary from the model. */
  onAnswer: (text: string) => void;
  /** Honest surface for cap/budget/degrade notices. */
  onNotice: (text: string, tone: "info" | "warn" | "error") => void;
  /** Live planner stream events (phases/reasoning/provider) for the thinking UI. */
  onEvent: PlanEventHandler;
  /** Called when a plan arrives, BEFORE execution — lets the panel fold the thought row. */
  onPlanned?: ((plan: AiPlan, iteration: number) => void) | undefined;
  /** Checked between iterations — the panel's Stop button. */
  isCancelled: () => boolean;
  maxIterations: number;
  useLocalLlm?: boolean | undefined;
}

export interface AgentRunReport {
  iterations: number;
  applied: number;
  failed: number;
  skipped: number;
  stopped: "done" | "cancelled" | "cap" | "error" | "offline";
  /** Dynamic chars this run sent/produced (plan JSON + action log) — feeds the routing ledger's token estimate. */
  estChars: number;
}

export async function runAgentLoop(prompt: string, deps: AgentLoopDeps): Promise<AgentRunReport> {
  const actionLog: string[] = [];
  let charsSpent = 0;
  let approved = !deps.requestApproval;
  let lastBatchSignature = "";
  let lastBatchFailed = false;
  let lastClarifyQuestion = "";
  let lastClarifyAnswer = "";
  let clarifyRepeats = 0;
  const totals = { applied: 0, failed: 0, skipped: 0 };

  for (let iteration = 1; iteration <= deps.maxIterations; iteration += 1) {
    if (deps.isCancelled()) {
      return { iterations: iteration - 1, ...totals, stopped: "cancelled", estChars: charsSpent };
    }

    // Compact action log rides as extra ai-turns appended to the panel's conversation history.
    const base = deps.buildContext();
    const budgetExhausted = charsSpent > RUN_CHAR_BUDGET * 0.8 || iteration === deps.maxIterations;
    const actionTurns: ConversationTurn[] = actionLog.slice(-MAX_ACTION_LINES).map((line) => ({ role: "ai", text: line }));
    if (actionTurns.length && budgetExhausted) {
      actionTurns.push({ role: "ai", text: "FINISH NOW: apply your best remaining plan as ONE batch this turn, then finish." });
    }
    const context: PlannerContext = {
      ...base,
      history: [...(base.history ?? []), ...actionTurns],
      ...(deps.useLocalLlm !== undefined ? { useLocalLlm: deps.useLocalLlm } : {})
    };

    let plan: AiPlan;
    try {
      plan = await deps.planner.plan(prompt, context, deps.onEvent);
    } catch (error) {
      deps.onNotice(`Planning failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { iterations: iteration, ...totals, stopped: "error", estChars: charsSpent };
    }
    charsSpent += JSON.stringify(plan.steps).length + actionTurns.reduce((sum, turn) => sum + turn.text.length, 0);
    deps.onPlanned?.(plan, iteration);

    // Stop pressed DURING the (long, streaming) planning call — honor it before asking anything
    // or executing: "I cancelled but it kept going" must never happen.
    if (deps.isCancelled()) {
      return { iterations: iteration, ...totals, stopped: "cancelled", estChars: charsSpent };
    }

    // Offline fallback mid-run: don't loop the keyword matcher — run its one-shot plan and stop.
    const isOffline = plan.provider === "offline";
    if (isOffline && iteration > 1) {
      deps.onNotice("The AI became unreachable mid-run — stopping after what was already applied.", "warn");
      return { iterations: iteration, ...totals, stopped: "offline", estChars: charsSpent };
    }

    // Model says it's done (or just conversation): a single answer step ends the run.
    const answers = plan.steps.filter((step) => step.kind === "answer");
    if (answers.length > 0 && answers.length === plan.steps.length) {
      deps.onAnswer(answers.map((step) => step.text ?? step.summary).join("\n\n"));
      return { iterations: iteration, ...totals, stopped: "done", estChars: charsSpent };
    }

    // A clarify-only turn: ask inline, feed the answer back, continue the SAME run.
    const clarifies = plan.steps.filter((step) => step.kind === "clarify");
    if (clarifies.length === plan.steps.length && clarifies.length > 0) {
      const question = clarifies[0]?.question ?? "Could you clarify?";
      // Clarify dedupe: the model re-emitting the IDENTICAL question after an answer is a stuck
      // loop (real voice transcript 2026-07-12: five spoken "yes"es, five re-asks). Never re-ask
      // the user — answer it ourselves ONCE, firmly; a third identical ask ends the run honestly.
      if (question.trim() === lastClarifyQuestion) {
        clarifyRepeats += 1;
        if (clarifyRepeats >= 2) {
          deps.onNotice("The model kept asking the same question — stopping.", "warn");
          return { iterations: iteration, ...totals, stopped: "error", estChars: charsSpent };
        }
        actionLog.push(
          `ACTION RESULT: the user ALREADY answered "${question.slice(0, 120)}" with: "${lastClarifyAnswer.slice(0, 200)}". Do NOT ask again — act on that answer now.`
        );
        continue;
      }
      const answer = await deps.askUser(question);
      if (deps.isCancelled()) {
        return { iterations: iteration, ...totals, stopped: "cancelled", estChars: charsSpent };
      }
      if (!answer || !answer.trim()) {
        deps.onNotice("No answer — stopped.", "info");
        return { iterations: iteration, ...totals, stopped: "done", estChars: charsSpent };
      }
      // A cancel-shaped ANSWER ends the run — feeding "don't do anything" back to the model
      // just makes it think harder and ask again (real user transcript, 2026-07-11).
      if (/^(?:cancel|stop|no|nope|nothing|never ?mind|forget it|leave it|do(?:n'?t| not) (?:do )?(?:it|anything)|not? do anything)[.!]?$/i.test(answer.trim())) {
        deps.onNotice("Okay — cancelled, nothing changed.", "info");
        return { iterations: iteration, ...totals, stopped: "cancelled", estChars: charsSpent };
      }
      lastClarifyQuestion = question.trim();
      lastClarifyAnswer = answer.trim();
      clarifyRepeats = 0;
      // An affirmative to a confirmation question must LAND — a bare `answered: "yes"` line
      // gives a weak model nothing to act on, and it just asks again.
      const confirmed = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|(?:of )?course(?: of course)?|go ahead|do (?:it|that)|please do|correct|right|confirmed?)\b/i.test(answer.trim());
      actionLog.push(
        confirmed
          ? `ACTION RESULT: asked "${question.slice(0, 120)}" → user answered: "${answer.slice(0, 200)}" — CONFIRMED. Do NOT ask again; execute now.`
          : `ACTION RESULT: asked "${question.slice(0, 120)}" → user answered: "${answer.slice(0, 200)}"`
      );
      continue;
    }

    // Mutating batch (answer steps mixed in are shown, then stripped before execution).
    for (const step of answers) {
      deps.onAnswer(step.text ?? step.summary);
    }

    // Inspect steps — resolved entirely client-side (the agent reading a tool manual). The doc goes
    // into the action log for the NEXT iteration; they never reach the executor and need no approval.
    const inspects = plan.steps.filter((step) => step.kind === "inspect");
    for (const step of inspects) {
      const capabilityId = step.capabilityId ?? "";
      const doc = deps.inspectCapability(capabilityId);
      deps.onInspected?.(capabilityId, Boolean(doc));
      const docText = doc ? doc.slice(0, 800) : "NOT FOUND — no such capability; check the CAPABILITIES list";
      actionLog.push(`ACTION RESULT: inspect ${capabilityId} →\n${docText}`);
      charsSpent += docText.length;
    }

    const batch = plan.steps.filter((step) => step.kind !== "answer" && step.kind !== "inspect");
    if (batch.length === 0) {
      // Inspect-only turn — go straight to the next iteration with the docs in context.
      if (inspects.length > 0) {
        continue;
      }
      // Nothing usable at all — treat as done to avoid spinning.
      return { iterations: iteration, ...totals, stopped: "done", estChars: charsSpent };
    }
    let executable: AiPlan = batch.length === plan.steps.length ? plan : { ...plan, steps: batch };

    // Loop-breaker: the model re-emitting the exact same batch. If the previous batch SUCCEEDED,
    // this just means a weak model forgot to emit the finishing "answer" — the work is done, end
    // the run quietly (no scary warning). Only a repeat of a FAILED batch is a real stuck-loop.
    const signature = JSON.stringify(batch.map((step) => [step.kind, step.actionId ?? step.toolSlug ?? step.skillId, step.params]));
    if (signature === lastBatchSignature) {
      if (lastBatchFailed) {
        deps.onNotice("The model kept retrying a failing action — stopping.", "warn");
        return { iterations: iteration, ...totals, stopped: "error", estChars: charsSpent };
      }
      return { iterations: iteration, ...totals, stopped: "done", estChars: charsSpent };
    }
    lastBatchSignature = signature;

    // Professional: approve ONCE per run, before the first mutating batch; then free-run.
    if (!approved && deps.requestApproval) {
      const approvedPlan = await deps.requestApproval(executable);
      if (!approvedPlan || deps.isCancelled()) {
        return { iterations: iteration, ...totals, stopped: "cancelled", estChars: charsSpent };
      }
      executable = approvedPlan;
      approved = true;
    }

    const outcome = await deps.executeBatch(executable);
    lastBatchFailed = outcome.failed > 0;
    totals.applied += outcome.applied;
    totals.failed += outcome.failed;
    totals.skipped += outcome.skipped;
    for (const line of outcome.lines) {
      actionLog.push(`ACTION RESULT: ${line}`);
      charsSpent += line.length;
    }

    // One-shot degrade: an offline plan already contains the whole keyword-matched intent — done.
    if (isOffline) {
      return { iterations: iteration, ...totals, stopped: "done", estChars: charsSpent };
    }

    // B5 final-batch contract: the model declared this batch completes the request. If every
    // step really succeeded, end the run NOW — no closing "done" LLM call. Any failure or skip
    // voids the claim and the loop continues so the model can react to the real results.
    if (plan.final && outcome.failed === 0 && outcome.skipped === 0) {
      // If the batch already carried an answer step, the user was ALREADY told — a second
      // onAnswer here spoke over it in voice mode (two overlapping TTS speaks were the
      // trigger of the self-echo loop; see round-9 changelog).
      if (answers.length === 0) {
        deps.onAnswer(plan.finalSummary?.trim() || "Done — applied the plan.");
      }
      return { iterations: iteration, ...totals, stopped: "done", estChars: charsSpent };
    }
  }

  deps.onNotice(`Stopped at the ${deps.maxIterations}-step limit — say "continue" to keep going.`, "warn");
  return { iterations: deps.maxIterations, ...totals, stopped: "cap", estChars: charsSpent };
}
