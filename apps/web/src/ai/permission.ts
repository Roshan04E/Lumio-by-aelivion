import type { AiPlan, PermissionMode } from "./types";

export interface PermissionModeInfo {
  id: PermissionMode;
  label: string;
  description: string;
}

export const PERMISSION_MODES: PermissionModeInfo[] = [
  {
    id: "quick",
    label: "Quick",
    description: "Auto-applies small, safe edits instantly. Risky ones still ask."
  },
  {
    id: "professional",
    label: "Professional",
    description: "Always shows a plan to approve before changing anything."
  },
  {
    id: "agent",
    label: "Agent",
    description: "Runs multi-step workflows, applying confidently as it goes."
  },
  {
    id: "talk",
    label: "Talk",
    description: "Just brainstorm — the AI shares ideas and direction, and suggests prompts you can run."
  }
];

/**
 * A plan is "small / safe" if every step is a free, local timeline action that
 * needs no user input and isn't a clarification. These are the only plans Quick
 * mode auto-applies; anything cloud/interactive/ambiguous still wants a review.
 */
export function isSafeAutoApply(plan: AiPlan): boolean {
  if (plan.steps.length === 0) {
    return false;
  }
  return plan.steps.every(
    (step) =>
      step.kind === "timelineAction" &&
      !step.requiresInput &&
      step.cost.credits === 0
  );
}

/** Below this raw model confidence, never auto-apply — route to review/clarify instead. */
const MIN_AUTO_APPLY_CONFIDENCE = 60;

/** Decide whether a freshly-built plan should skip the review card and apply now. */
export function shouldAutoApply(plan: AiPlan, mode: PermissionMode): boolean {
  if (mode === "professional") {
    return false;
  }
  // Low model confidence always wants a human look (confidence layer).
  if (typeof plan.confidencePercent === "number" && plan.confidencePercent < MIN_AUTO_APPLY_CONFIDENCE) {
    return false;
  }
  // Both quick and agent auto-apply safe plans; agent additionally tolerates
  // interactive tool steps (it drives them), but still never auto-applies a plan
  // that is only a clarification question.
  if (plan.steps.every((step) => step.kind === "clarify")) {
    return false;
  }
  if (mode === "quick") {
    return isSafeAutoApply(plan);
  }
  // agent
  return plan.confidence === "Exact" || plan.confidence === "High Quality";
}
