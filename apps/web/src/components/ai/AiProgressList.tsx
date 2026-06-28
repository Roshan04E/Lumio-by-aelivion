import type { PlanStep, StepProgress } from "../../ai/types";

const STATUS_GLYPH: Record<StepProgress["status"], string> = {
  pending: "○",
  running: "⏳",
  done: "✓",
  failed: "✕",
  skipped: "–"
};

export function AiProgressList({
  steps,
  progress
}: {
  steps: PlanStep[];
  progress: Record<string, StepProgress>;
}) {
  return (
    <ul className="ai-progress-list" aria-label="AI execution progress">
      {steps.map((step) => {
        const status = progress[step.id]?.status ?? "pending";
        const detail = progress[step.id]?.detail;
        return (
          <li key={step.id} className={`ai-progress-item is-${status}`}>
            <span className="ai-progress-glyph" aria-hidden>
              {STATUS_GLYPH[status]}
            </span>
            <span className="ai-progress-label">
              {step.summary}
              {detail && status === "failed" ? <em className="ai-progress-detail"> — {detail}</em> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
