import { useMemo, useState } from "react";
import { CONFIDENCE_INFO, confidenceClass } from "../../ai/confidence";
import type { AiPlan } from "../../ai/types";
import { AiReasoningLog } from "./AiReasoningLog";

const KIND_TAG: Record<string, string> = {
  timelineAction: "edit",
  tool: "tool",
  clarify: "ask"
};

/**
 * The "Lumio AI" plan review surface. Shows the ordered steps, estimated cost,
 * and confidence (with an honest explanation, never a percentage), and lets the
 * user Apply / Modify / Cancel before anything runs — AI never applies hidden edits.
 */
export function PlanReviewCard({
  plan,
  busy,
  onApply,
  onCancel,
  onModify
}: {
  plan: AiPlan;
  busy: boolean;
  /** Receives the ids of the steps the user chose to apply (a subset of the plan). */
  onApply: (stepIds: string[]) => void;
  onCancel: () => void;
  onModify?: () => void;
}) {
  const costLabel = plan.totalCredits === 0 ? "0 credits (free)" : `${plan.totalCredits} credits`;
  // Per-step opt-out, so a multi-step plan can be applied partially ("apply 2 of 4").
  // Only meaningful for runnable steps; clarify steps aren't checkboxable.
  const runnableIds = useMemo(() => plan.steps.filter((step) => step.kind !== "clarify").map((step) => step.id), [plan.steps]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const showChecks = runnableIds.length >= 2;
  const selectedIds = plan.steps.filter((step) => step.kind === "clarify" || !excluded.has(step.id)).map((step) => step.id);
  const nothingSelected = runnableIds.length > 0 && runnableIds.every((id) => excluded.has(id));
  const toggle = (id: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="ai-plan-card">
      <div className="ai-plan-card-head">
        <strong>AI</strong>
        <span className={`ai-confidence ${confidenceClass(plan.confidence)}`} title={CONFIDENCE_INFO[plan.confidence].detail}>
          {plan.confidence}
          {typeof plan.confidencePercent === "number" ? ` · ${plan.confidencePercent}%` : ""}
        </span>
      </div>

      <p className="ai-plan-confidence-detail">{CONFIDENCE_INFO[plan.confidence].detail}</p>

      {plan.reasoning ? <AiReasoningLog reasoning={plan.reasoning} provider={plan.provider} /> : null}

      <ol className="ai-plan-steps">
        {plan.steps.map((step) => {
          const checkable = showChecks && step.kind !== "clarify";
          return (
            <li key={step.id} className={`ai-plan-step ${checkable && excluded.has(step.id) ? "is-excluded" : ""}`}>
              {checkable ? (
                <input
                  type="checkbox"
                  className="ai-plan-step-check"
                  checked={!excluded.has(step.id)}
                  onChange={() => toggle(step.id)}
                  disabled={busy}
                  aria-label={`Apply: ${step.summary}`}
                />
              ) : null}
              <span className="ai-plan-step-tag">{KIND_TAG[step.kind] ?? step.kind}</span>
              <span className="ai-plan-step-summary">{step.summary}</span>
              {step.requiresInput ? <span className="ai-plan-step-flag">needs your input</span> : null}
              {step.cost.credits > 0 ? <span className="ai-plan-step-cost">{step.cost.credits}c</span> : null}
            </li>
          );
        })}
      </ol>

      {plan.notes.length > 0 ? (
        <ul className="ai-plan-notes">
          {plan.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}

      <div className="ai-plan-card-foot">
        <span className="ai-plan-cost">Estimated cost: {costLabel}</span>
        <div className="ai-plan-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {onModify ? (
            <button type="button" className="ghost" onClick={onModify} disabled={busy}>
              Modify
            </button>
          ) : null}
          <button type="button" className="primary" onClick={() => onApply(selectedIds)} disabled={busy || nothingSelected}>
            {busy ? "Applying…" : showChecks ? `Apply ${selectedIds.filter((id) => runnableIds.includes(id)).length}` : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
