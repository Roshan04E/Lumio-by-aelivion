/**
 * Kimera OS — the fact store (K1). In-memory, bounded, provenance-keyed.
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

const facts = new Map<string, Fact>();

export function factId(type: string, target: string): string {
  return `${type}|${target}`;
}

export function getStoredFact<V = unknown>(type: string, target: string): Fact<V> | undefined {
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
      dependencies
    };
    // Replacing a fact is a change of its value → anything derived FROM the old value is stale.
    if (facts.has(fact.id)) {
      cascadeDependents(fact.id);
    }
    facts.set(fact.id, fact);
    stored.push(fact);
  }
  evictIfOverflowing();
  return stored;
}

/** Remove a fact and cascade through everything derived from it (recursively). */
export function invalidateFact(id: string): void {
  if (!facts.delete(id)) {
    return;
  }
  cascadeDependents(id);
}

/** Drop every fact about a target (e.g. asset bytes replaced). Cascades like invalidateFact. */
export function invalidateTarget(target: WorldTarget): void {
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
  return Array.from(facts.values());
}

export function clearFactStore(): void {
  facts.clear();
}
