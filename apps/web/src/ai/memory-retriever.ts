import type { AiMemoryPreferences } from "./types";
import type { MemoryFact } from "./memory";

/**
 * Phase 11 — the Memory Retriever. Never sends ALL memory to the planner. It
 * picks a small, high-confidence, recent slice (project facts override creator on
 * a key collision — "this video" beats "usually") and returns both:
 *  - `preferences` — an AiMemoryPreferences-shaped object the deterministic
 *    planner already consumes to fill defaults;
 *  - `note` — one compact human line the LLM sees as a steer.
 * Bounded like `summarizeContext()` — that's the cost rule.
 */

const DEFAULT_LIMIT = 6;
// Below this we don't trust a fact enough to steer the planner with it.
const MIN_CONFIDENCE = 0.45;

// Creator keys that map onto the legacy preferences shape the planners read.
const PREFERENCE_KEYS = new Set(["captionStyle", "colorGrade", "qualityMode", "language", "permissionMode", "textColor"]);

export interface MemorySlice {
  preferences: AiMemoryPreferences;
  /** One-line summary for the LLM, or "" when there's nothing worth saying. */
  note: string;
}

function score(fact: MemoryFact): number {
  // Confidence first, recency as a small tiebreaker.
  const recency = Date.parse(fact.lastUsedAt || "") || 0;
  return fact.confidence * 1_000_000_000 + recency / 1_000_000;
}

export function selectMemorySlice(
  facts: MemoryFact[],
  options: { projectId?: string | undefined; limit?: number | undefined } = {}
): MemorySlice {
  const { projectId, limit = DEFAULT_LIMIT } = options;

  // Relevant tiers only: creator + the active project (style is Phase 12).
  const relevant = facts.filter(
    (fact) =>
      fact.confidence >= MIN_CONFIDENCE &&
      (fact.scope === "creator" || (fact.scope === "project" && fact.projectId === projectId))
  );

  // Project overrides creator on the same key ("this video" beats "usually"),
  // regardless of confidence; within a scope, the higher score wins.
  const priority = (fact: MemoryFact) => (fact.scope === "project" ? 2 : 1);
  const byKey = new Map<string, MemoryFact>();
  for (const fact of relevant) {
    const existing = byKey.get(fact.key);
    if (!existing) {
      byKey.set(fact.key, fact);
      continue;
    }
    if (priority(fact) > priority(existing) || (priority(fact) === priority(existing) && score(fact) > score(existing))) {
      byKey.set(fact.key, fact);
    }
  }

  const chosen = [...byKey.values()].sort((a, b) => score(b) - score(a)).slice(0, limit);

  const preferences: AiMemoryPreferences = {};
  for (const fact of chosen) {
    if (PREFERENCE_KEYS.has(fact.key)) {
      (preferences as Record<string, unknown>)[fact.key] = fact.value;
    }
  }

  const note = chosen.length
    ? `Known preferences — ${chosen.map((fact) => `${fact.key}: ${formatValue(fact.value)}`).join("; ")}.`
    : "";

  return { preferences, note };
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
