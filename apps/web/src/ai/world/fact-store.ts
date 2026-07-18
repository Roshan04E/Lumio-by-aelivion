/**
 * Orreris OS — the fact store (K1). In-memory, bounded, provenance-keyed.
 *
 * One live fact per (type, target). Truth maintenance is the store's whole job:
 *  - facts remember the input signature they were observed under (provenance),
 *  - `invalidateFact` removes a fact AND every fact whose `dependencies` chain reaches it
 *    (derived meanings die with their inputs — no confidently-stale L4 answers),
 *  - the store never decides freshness itself; knowledge.ts compares signatures on read.
 *
 * Deliberately session-memory only in K1: L0–L2 facts are cheap to recompute and the memo
 * keys (observer version + input signature) make recomputation exact. Persistence = K2.
 */

import type { Fact, ObservedFact, WorldObserver, WorldTarget } from "./types";
import { targetKey } from "./types";

const MAX_FACTS = 500;
// K2 persistence: facts survive a refresh via localStorage (bounded JSON, same convention as
// the routing ledger). This is CORRECTNESS-FREE caching — every read is signature-verified by
// knowledge.ts, so a stale persisted fact simply invalidates on first touch. Deliberately not
// OPFS: <500 small JSON facts is localStorage territory (tables-first, ORRERIS_OS invariant 6).
const STORAGE_KEY = "orreris.world.facts.v1";
const PERSIST_DEBOUNCE_MS = 500;

const facts = new Map<string, Fact>();
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function ensureHydrated(): void {
  if (hydrated) {
    return;
  }
  hydrated = true;
  try {
    if (typeof localStorage !== "undefined") {
      const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(parsed)) {
        for (const fact of parsed as Fact[]) {
          if (fact && typeof fact.id === "string" && fact.provenance) {
            facts.set(fact.id, fact);
          }
        }
      }
    }
  } catch {
    // Corrupt/unavailable storage → start empty; observers simply re-measure.
  }
}

function schedulePersist(): void {
  if (persistTimer !== undefined) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(facts.values())));
      }
    } catch {
      // Quota/private mode — the in-memory store still works this session.
    }
  }, PERSIST_DEBOUNCE_MS);
}

export function factId(type: string, target: string): string {
  return `${type}|${target}`;
}

export function getStoredFact<V = unknown>(type: string, target: string): Fact<V> | undefined {
  ensureHydrated();
  return facts.get(factId(type, target)) as Fact<V> | undefined;
}

/** Store every fact one observation run produced, all under the same provenance. */
export function storeObservation(
  observer: WorldObserver,
  target: WorldTarget,
  inputSignature: string,
  observed: ObservedFact[],
  dependencies: string[] = []
): Fact[] {
  ensureHydrated();
  const key = targetKey(target);
  const stored: Fact[] = [];
  for (const item of observed) {
    const fact: Fact = {
      id: factId(item.type, key),
      type: item.type,
      target: key,
      value: item.value,
      confidence: item.confidence,
      observedAt: Date.now(),
      provenance: {
        observerId: observer.id,
        observerVersion: observer.version,
        inputSignature,
        sampledRanges: item.sampledRanges
      },
      // Per-fact dependencies (inference rules) win over the whole-run default.
      dependencies: item.dependencies ?? dependencies
    };
    // Replacing a fact is a change of its value → anything derived FROM the old value is stale.
    if (facts.has(fact.id)) {
      cascadeDependents(fact.id);
    }
    facts.set(fact.id, fact);
    stored.push(fact);
  }
  evictIfOverflowing();
  schedulePersist();
  return stored;
}

/** Remove a fact and cascade through everything derived from it (recursively). */
export function invalidateFact(id: string): void {
  ensureHydrated();
  if (!facts.delete(id)) {
    return;
  }
  cascadeDependents(id);
  schedulePersist();
}

/** Drop every fact about a target (e.g. asset bytes replaced). Cascades like invalidateFact. */
export function invalidateTarget(target: WorldTarget): void {
  ensureHydrated();
  const key = targetKey(target);
  for (const fact of Array.from(facts.values())) {
    if (fact.target === key) {
      invalidateFact(fact.id);
    }
  }
}

function cascadeDependents(deadId: string): void {
  for (const fact of Array.from(facts.values())) {
    if (fact.dependencies.includes(deadId)) {
      invalidateFact(fact.id);
    }
  }
}

function evictIfOverflowing(): void {
  if (facts.size <= MAX_FACTS) {
    return;
  }
  const oldestFirst = Array.from(facts.values()).sort((a, b) => a.observedAt - b.observedAt);
  for (const fact of oldestFirst.slice(0, facts.size - MAX_FACTS)) {
    facts.delete(fact.id);
  }
}

export function listFacts(): Fact[] {
  ensureHydrated();
  return Array.from(facts.values());
}

export function clearFactStore(): void {
  facts.clear();
  hydrated = true; // an explicit clear must not resurrect persisted facts
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // best-effort
  }
}

/** TEST-ONLY: drop the in-memory map + hydration flag so eval can simulate a page reload. */
export function __resetFactStoreMemoryForTests(): void {
  facts.clear();
  hydrated = false;
}
