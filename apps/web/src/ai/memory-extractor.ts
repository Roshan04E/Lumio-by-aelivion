import type { AiPlan, PlanStep } from "./types";
import type { MemoryFact, MemoryValue } from "./memory";

/**
 * Phase 11 — the Memory Extractor. Distils REUSABLE signals from an *applied*
 * plan into facts. Two scopes per signal: a long-term `creator` default ("my
 * usual caption style") and a `project` fact ("keep this video consistent"). It
 * never stores the raw prompt — only small, structured choices the planner can
 * reuse to fill defaults. Confidence starts modest; repetition compounds it
 * server-side. Mirrors (and replaces) the ad-hoc textColor learning that used to
 * live inline in AiChatPanel.
 */

const NOW = () => new Date().toISOString();

function fact(scope: "creator" | "project", key: string, value: MemoryValue, projectId?: string, confidence = 0.5): MemoryFact {
  return {
    scope,
    ...(scope === "project" && projectId ? { projectId } : {}),
    key,
    value,
    confidence,
    source: "inferred",
    lastUsedAt: NOW()
  };
}

/** Both a creator default and (when we know the project) a project-scoped copy. */
function tiered(key: string, value: MemoryValue, projectId: string | undefined, confidence: number): MemoryFact[] {
  const facts = [fact("creator", key, value, undefined, confidence)];
  if (projectId) {
    facts.push(fact("project", key, value, projectId, Math.min(1, confidence + 0.1)));
  }
  return facts;
}

function stepParams(step: PlanStep): Record<string, unknown> {
  return step.params && typeof step.params === "object" ? (step.params as Record<string, unknown>) : {};
}

/**
 * Inspect the plan that was actually applied and return the facts worth keeping.
 * `quality`/`permission` come from how the user chose to run it.
 */
export function extractFacts(
  plan: AiPlan,
  context: { projectId?: string | undefined; qualityMode?: string | undefined; permissionMode?: string | undefined }
): MemoryFact[] {
  const out: MemoryFact[] = [];
  const { projectId } = context;

  for (const step of plan.steps) {
    const params = stepParams(step);

    // Text/shape color the user accepted → a likely brand color.
    if ((step.actionId === "addText" || step.actionId === "addShape") && typeof params.color === "string") {
      out.push(...tiered("textColor", params.color, projectId, 0.5));
    }

    // A color grade the user applied → preferred look.
    if (step.actionId === "addEffect" && typeof params.effectType === "string" && /grade/i.test(params.effectType)) {
      out.push(...tiered("colorGrade", params.effectType, projectId, 0.5));
    }

    // Captions tool → remember it's part of this creator's flow (style refined elsewhere).
    if (step.kind === "tool" && step.toolSlug === "auto-captions") {
      out.push(fact("creator", "usesCaptions", true, undefined, 0.5));
    }
  }

  // How they like to run the AI (only when explicitly non-default).
  if (context.qualityMode && context.qualityMode !== "balanced") {
    out.push(fact("creator", "qualityMode", context.qualityMode, undefined, 0.5));
  }

  return dedupe(out);
}

/** Collapse duplicate (scope, projectId, key) facts, keeping the highest confidence. */
function dedupe(facts: MemoryFact[]): MemoryFact[] {
  const byKey = new Map<string, MemoryFact>();
  for (const item of facts) {
    const id = `${item.scope}|${item.projectId ?? ""}|${item.key}`;
    const existing = byKey.get(id);
    if (!existing || item.confidence > existing.confidence) {
      byKey.set(id, item);
    }
  }
  return [...byKey.values()];
}
