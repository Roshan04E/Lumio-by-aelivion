/**
 * Orreris Brain — per-rule feedback trust (the first slice of B6, pulled forward). Every
 * brain-resolved turn shows 👍/👎; the counts gate whether that rule may keep fast-pathing:
 * a rule the user keeps rejecting LOSES TRUST and stops firing (its prompts escalate to the
 * model instead). This is the honest "reinforcement from feedback" — bandit-style counters on
 * our own rules, no model training, per-user, on-device (AI_ARCHITECTURE.md → Learning loop).
 */

export interface RuleStats {
  /** Times the rule resolved a turn (shown to the user). */
  fired: number;
  /** 👍 — the instant result was what the user wanted. */
  confirmed: number;
  /** 👎 — the user rejected it and re-ran through the model. */
  rejected: number;
}

const STORAGE_KEY = "orreris.brain.rulestats.v1";

let memoryStats: Record<string, RuleStats> | null = null;

function loadStats(): Record<string, RuleStats> {
  if (memoryStats) {
    return memoryStats;
  }
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      memoryStats = parsed && typeof parsed === "object" ? (parsed as Record<string, RuleStats>) : {};
      return memoryStats;
    }
  } catch {
    // Corrupt/unavailable storage → fresh in-memory stats.
  }
  memoryStats = {};
  return memoryStats;
}

function saveStats(stats: Record<string, RuleStats>): void {
  memoryStats = stats;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
    }
  } catch {
    // Persisting is best-effort; the session still learns.
  }
}

function bump(ruleId: string, field: keyof RuleStats): void {
  const stats = loadStats();
  const entry = stats[ruleId] ?? { fired: 0, confirmed: 0, rejected: 0 };
  entry[field] += 1;
  saveStats({ ...stats, [ruleId]: entry });
}

export function recordRuleFired(ruleId: string): void {
  bump(ruleId, "fired");
}

export function recordRuleConfirmed(ruleId: string): void {
  bump(ruleId, "confirmed");
  appendFeedbackEvent(ruleId, "confirmed");
}

export function recordRuleRejected(ruleId: string): void {
  bump(ruleId, "rejected");
  appendFeedbackEvent(ruleId, "rejected");
}

/**
 * May this rule still fast-path? Laplace-smoothed confirm score; a rule needs ≥2 explicit
 * feedback signals before it can be distrusted, and recovers if later 👍s outweigh the 👎s.
 * Distrusted rules escalate silently — the model takes over for THIS user.
 */
export function isRuleTrusted(ruleId: string): boolean {
  const stats = loadStats()[ruleId];
  if (!stats) {
    return true;
  }
  const signals = stats.confirmed + stats.rejected;
  if (signals < 2) {
    return true;
  }
  const score = (stats.confirmed + 1) / (signals + 2);
  return score >= 0.5;
}

/** All per-rule stats (copy) — consumed by the World Model's user-profile observer (K2). */
export function listRuleStats(): Record<string, RuleStats> {
  return { ...loadStats() };
}

export function getRuleStats(ruleId: string): RuleStats | undefined {
  return loadStats()[ruleId];
}

export function clearRuleStats(): void {
  saveStats({});
}

// ---------------------------------------------------------------------------
// Two-stage learning (user requirement, 2026-07-09): STAGE 1 is the local per-user
// trust above (ships now, on-device). STAGE 2 is universal — the same events, anonymized
// and aggregated server-side behind consent, train the editor's shared rule/recipe
// confidence for everyone (AI_ARCHITECTURE.md → Learning loop / B6-B8). The raw event log
// below is the aggregate-ready feed: bounded locally today, drained by the future sync
// worker later. No prompt text ever rides in an event — ruleId + outcome only.
// ---------------------------------------------------------------------------

export interface FeedbackEvent {
  ruleId: string;
  outcome: "confirmed" | "rejected";
  /** Epoch ms. */
  at: number;
}

const EVENTS_KEY = "orreris.brain.feedback-events.v1";
const MAX_EVENTS = 500;

function loadEvents(): FeedbackEvent[] {
  try {
    if (typeof localStorage !== "undefined") {
      const parsed: unknown = JSON.parse(localStorage.getItem(EVENTS_KEY) ?? "[]");
      return Array.isArray(parsed) ? (parsed as FeedbackEvent[]) : [];
    }
  } catch {
    // fall through
  }
  return [];
}

function saveEvents(events: FeedbackEvent[]): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(EVENTS_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
    }
  } catch {
    // best-effort
  }
}

export function appendFeedbackEvent(ruleId: string, outcome: FeedbackEvent["outcome"]): void {
  saveEvents([...loadEvents(), { ruleId, outcome, at: Date.now() }]);
}

/** For the future universal-learning sync worker: read + clear the pending event feed. */
export function drainFeedbackEvents(): FeedbackEvent[] {
  const events = loadEvents();
  saveEvents([]);
  return events;
}
