import { listMemory, upsertMemory, deleteMemory, type MemoryFactUpsert } from "../lib/api";
import type { AiMemoryPreferences } from "./types";

/**
 * Phase 11 — AI Memory OS (client side). Small, reusable signals ("facts")
 * tiered by scope: `creator` (the user, long-term), `project` (one video),
 * `style` (a reference fingerprint — Phase 12 populates these). localStorage is
 * the OFFLINE SOURCE OF TRUTH; the server (`/api/memory`) is a sync mirror so the
 * profile follows the user across devices. Every write updates the cache
 * immediately and best-effort syncs — the app stays fully functional with no
 * backend, matching `lib/api.ts`'s client-first pattern.
 *
 * `loadMemory()`/`rememberPreferences()` remain as thin adapters over creator
 * facts so existing callers keep working unchanged (they predate the tiers).
 */

export type MemoryScope = "creator" | "project" | "style";
export type MemoryValue = string | number | boolean | string[];

export interface MemoryFact {
  /** Server id once synced (absent for cache-only facts). */
  id?: string | undefined;
  scope: MemoryScope;
  /** Set for `project` scope. */
  projectId?: string | undefined;
  key: string;
  value: MemoryValue;
  /** 0–1; compounds on re-observation. */
  confidence: number;
  source: "inferred" | "explicit";
  lastUsedAt: string;
}

const STORAGE_KEY = "kimera.ai.memory.v2";
const LEGACY_KEY = "kimera.ai.memory.v1";

// The creator-scope keys that back the legacy AiMemoryPreferences shape.
const PREFERENCE_KEYS = ["captionStyle", "colorGrade", "qualityMode", "language", "permissionMode", "textColor"] as const;

function identity(fact: { scope: string; projectId?: string | undefined; key: string }): string {
  return `${fact.scope}|${fact.projectId ?? ""}|${fact.key}`;
}

function readCache(): MemoryFact[] {
  if (typeof localStorage === "undefined") {
    return [];
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as MemoryFact[];
    }
    return migrateLegacy();
  } catch {
    return [];
  }
}

function writeCache(facts: MemoryFact[]): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(facts));
  } catch {
    /* quota / private mode — memory is best-effort */
  }
}

/** One-time lift of the old flat AiMemoryPreferences blob into creator facts. */
function migrateLegacy(): MemoryFact[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const prefs = JSON.parse(raw) as AiMemoryPreferences;
    const now = new Date().toISOString();
    const facts: MemoryFact[] = Object.entries(prefs)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => ({ scope: "creator", key, value: value as MemoryValue, confidence: 0.6, source: "inferred", lastUsedAt: now }));
    if (facts.length) writeCache(facts);
    return facts;
  } catch {
    return [];
  }
}

/** Mirror the server's confidence merge locally so the cache matches after a write. */
function mergeConfidence(previous: MemoryFact | undefined, incoming: MemoryFact): number {
  if (incoming.source === "explicit") {
    return Math.max(0.9, previous?.confidence ?? incoming.confidence);
  }
  if (previous) {
    return Math.min(1, previous.confidence + (1 - previous.confidence) * 0.3);
  }
  return incoming.confidence;
}

export function loadFacts(): MemoryFact[] {
  return readCache();
}

/** Merge facts into the cache (with the confidence bump) and best-effort sync to the server. */
export function rememberFacts(incoming: MemoryFact[]): MemoryFact[] {
  if (incoming.length === 0) {
    return readCache();
  }
  const current = readCache();
  const byId = new Map(current.map((fact) => [identity(fact), fact]));
  const now = new Date().toISOString();
  for (const fact of incoming) {
    const key = identity(fact);
    const previous = byId.get(key);
    byId.set(key, {
      ...previous,
      ...fact,
      confidence: mergeConfidence(previous, fact),
      lastUsedAt: now
    });
  }
  const next = [...byId.values()];
  writeCache(next);

  // Fire-and-forget sync; failure (offline / no DB) leaves the cache authoritative.
  const payload: MemoryFactUpsert[] = incoming.map((fact) => ({
    scope: fact.scope,
    ...(fact.projectId ? { projectId: fact.projectId } : {}),
    key: fact.key,
    value: fact.value,
    confidence: fact.confidence,
    source: fact.source
  }));
  void upsertMemory(payload).catch(() => undefined);

  return next;
}

export function rememberFact(fact: MemoryFact): MemoryFact[] {
  return rememberFacts([fact]);
}

/** Pull the server's facts and merge them into the cache (called once on panel mount). */
export async function hydrateFromServer(projectId?: string): Promise<MemoryFact[]> {
  try {
    const remote = await listMemory(projectId);
    const current = readCache();
    const byId = new Map(current.map((fact) => [identity(fact), fact]));
    for (const fact of remote) {
      byId.set(identity({ scope: fact.scope, projectId: fact.projectId ?? undefined, key: fact.key }), {
        id: fact.id,
        scope: fact.scope as MemoryScope,
        ...(fact.projectId ? { projectId: fact.projectId } : {}),
        key: fact.key,
        value: fact.value as MemoryValue,
        confidence: fact.confidence,
        source: fact.source === "explicit" ? "explicit" : "inferred",
        lastUsedAt: fact.lastUsedAt
      });
    }
    const next = [...byId.values()];
    writeCache(next);
    return next;
  } catch {
    return readCache();
  }
}

/** Forget a fact (Memory Panel, Phase 15). Removes from cache + server. */
export function forgetFact(ref: { scope: MemoryScope; projectId?: string | undefined; key: string }): void {
  const current = readCache();
  const target = current.find((fact) => identity(fact) === identity(ref));
  writeCache(current.filter((fact) => identity(fact) !== identity(ref)));
  if (target?.id) {
    void deleteMemory(target.id).catch(() => undefined);
  }
}

// --- Backward-compatible AiMemoryPreferences adapters (creator scope) --------

export function loadMemory(): AiMemoryPreferences {
  const prefs: AiMemoryPreferences = {};
  for (const fact of readCache()) {
    if (fact.scope === "creator" && (PREFERENCE_KEYS as readonly string[]).includes(fact.key)) {
      (prefs as Record<string, unknown>)[fact.key] = fact.value;
    }
  }
  return prefs;
}

export function rememberPreferences(patch: Partial<AiMemoryPreferences>): AiMemoryPreferences {
  const now = new Date().toISOString();
  const facts: MemoryFact[] = Object.entries(patch)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ scope: "creator", key, value: value as MemoryValue, confidence: 0.6, source: "inferred", lastUsedAt: now }));
  rememberFacts(facts);
  return loadMemory();
}

export function clearMemory(): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}
