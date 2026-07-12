/**
 * Lumio Brain — routing ledger (B0). Every AI request records which tier resolved it, how long
 * it took, and a rough token estimate, so the cascade's savings are MEASURABLE, not vibes
 * (see AI_ARCHITECTURE.md → Instrumentation). Bounded ring persisted to localStorage; pure
 * module with no DOM assumptions so the eval harness can import it under node/tsx.
 */

export type BrainRoute = "reflex" | "rules" | "semantic" | "llm-fast" | "loop" | "talk";

export type RouteOutcome = "answered" | "applied" | "failed" | "cancelled" | "escalated";

export interface RouteRecord {
  id: string;
  /** Epoch ms. */
  at: number;
  route: BrainRoute;
  /** Model/provider for LLM routes (e.g. "groq", "ollama:…"); absent for local tiers. */
  provider?: string | undefined;
  /** Wall time for the whole request, ms. */
  ms: number;
  /** Rough tokens for the request (chars/4 + per-call static prompt) — 0 for local tiers. */
  estTokens: number;
  outcome: RouteOutcome;
  /** Agent-loop runs: how many LLM iterations the run took. */
  iterations?: number | undefined;
}

/**
 * Rough static-prompt cost of ONE gateway call (system prompt + capability catalog), in tokens.
 * The client can't see the exact server payload; this keeps loop estimates honest-ish rather
 * than pretending only the dynamic tail costs anything.
 */
export const LLM_STATIC_TOKENS_PER_CALL = 2_500;

/** Fallback per-request saving credited to a locally-resolved request when no LLM samples exist yet. */
const DEFAULT_LLM_REQUEST_TOKENS = 2_200;

const STORAGE_KEY = "lumio.brain.ledger.v1";
const MAX_RECORDS = 200;

const LOCAL_ROUTES: ReadonlySet<BrainRoute> = new Set(["reflex", "rules", "semantic"]);

let memoryRecords: RouteRecord[] | null = null;

function loadRecords(): RouteRecord[] {
  if (memoryRecords) {
    return memoryRecords;
  }
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      memoryRecords = Array.isArray(parsed) ? (parsed as RouteRecord[]) : [];
      return memoryRecords;
    }
  } catch {
    // Corrupt/unavailable storage → start fresh in memory.
  }
  memoryRecords = [];
  return memoryRecords;
}

function saveRecords(records: RouteRecord[]): void {
  memoryRecords = records;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    }
  } catch {
    // Quota/private-mode failures are fine — the in-memory ring still works this session.
  }
}

export function recordRoute(input: Omit<RouteRecord, "id" | "at">): RouteRecord {
  const record: RouteRecord = {
    ...input,
    id: `route_${Math.random().toString(36).slice(2, 10)}`,
    at: Date.now()
  };
  const next = [...loadRecords(), record].slice(-MAX_RECORDS);
  saveRecords(next);
  return record;
}

export function listRoutes(): RouteRecord[] {
  return [...loadRecords()];
}

export interface RoutingSummary {
  total: number;
  byRoute: Partial<Record<BrainRoute, number>>;
  /** Requests resolved by a zero-token local tier. */
  instant: number;
  /** 0–1 share of requests that never touched a model. */
  instantShare: number;
  avgInstantMs: number;
  avgLlmMs: number;
  estTokensSpent: number;
  /** Estimated tokens the local tiers avoided (instant count × observed avg LLM request cost). */
  estTokensSaved: number;
}

export function summarizeRouting(): RoutingSummary {
  const records = loadRecords();
  const byRoute: Partial<Record<BrainRoute, number>> = {};
  let instant = 0;
  let instantMs = 0;
  let llmCount = 0;
  let llmMs = 0;
  let estTokensSpent = 0;
  for (const record of records) {
    byRoute[record.route] = (byRoute[record.route] ?? 0) + 1;
    estTokensSpent += record.estTokens;
    if (LOCAL_ROUTES.has(record.route)) {
      instant += 1;
      instantMs += record.ms;
    } else {
      llmCount += 1;
      llmMs += record.ms;
    }
  }
  const avgLlmTokens = llmCount > 0 ? estTokensSpent / llmCount : DEFAULT_LLM_REQUEST_TOKENS;
  return {
    total: records.length,
    byRoute,
    instant,
    instantShare: records.length > 0 ? instant / records.length : 0,
    avgInstantMs: instant > 0 ? instantMs / instant : 0,
    avgLlmMs: llmCount > 0 ? llmMs / llmCount : 0,
    estTokensSpent: Math.round(estTokensSpent),
    estTokensSaved: Math.round(instant * avgLlmTokens)
  };
}

export function clearRoutingLedger(): void {
  saveRecords([]);
}
