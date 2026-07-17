/**
 * Kimera OS — the Knowledge Service query planner (K1). The single read seam of the World
 * Model: callers ask typed `FactQuery`s; this module picks the cheapest access path that
 * satisfies (budget, minConfidence) — cached fact first, then observers cheapest-first —
 * exactly like a database query planner choosing indexes over table scans.
 *
 * Truth maintenance happens HERE, on read: a cached fact is only served while its observer's
 * CURRENT input signature still matches the one it was observed under (and its observer
 * version is current). Any mismatch invalidates the fact — cascading through dependents —
 * and the planner falls through to re-observation.
 *
 * Precision-first, like every brain tier: no eligible path within budget/confidence → the
 * query DECLINES (returns null). It never serves a fact it can't stand behind.
 */

import { getStoredFact, invalidateFact, storeObservation } from "./fact-store";
import { getObserver, observersForFactType } from "./observers";
import { schedulePerception, type PerceptionPriority } from "./scheduler";
import type { Fact, FactQuery, WorldContext } from "./types";
import { targetKey } from "./types";

export interface KnowledgeResult<V = unknown> {
  fact: Fact<V>;
  /** "cached" or the observer id that ran — the honest route label for provenance UI. */
  path: string;
  ms: number;
}

const DEFAULT_BUDGET_MS = 5_000;

export async function queryFact<V = unknown>(
  query: FactQuery,
  ctx: WorldContext,
  priority: PerceptionPriority = "user-blocking"
): Promise<KnowledgeResult<V> | null> {
  const startedAt = Date.now();
  const key = targetKey(query.target);
  const minConfidence = query.minConfidence ?? 0;
  const budgetMs = query.budgetMs ?? DEFAULT_BUDGET_MS;

  // ---- Access path 0: the cache, signature-verified ----
  const stored = getStoredFact<V>(query.type, key);
  if (stored) {
    const observer = getObserver(stored.provenance.observerId);
    const currentSignature = observer ? observer.signature(query.target, ctx) : null;
    const fresh =
      observer !== undefined &&
      observer.version === stored.provenance.observerVersion &&
      currentSignature !== null &&
      currentSignature === stored.provenance.inputSignature &&
      (query.maxAgeMs === undefined || Date.now() - stored.observedAt <= query.maxAgeMs);
    if (fresh && stored.confidence >= minConfidence) {
      return { fact: stored, path: "cached", ms: Date.now() - startedAt };
    }
    if (!fresh) {
      // Stale input → the fact is dead, and so is everything derived from it.
      invalidateFact(stored.id);
    }
  }

  // ---- Access paths 1..n: observers, cheapest first ----
  for (const observer of observersForFactType(query.type)) {
    if (observer.estConfidence < minConfidence || observer.estCostMs > budgetMs) {
      continue;
    }
    const signature = observer.signature(query.target, ctx);
    if (signature === null) {
      continue; // can't observe this target here (wrong kind / missing asset / no DOM)
    }
    try {
      const observed = await schedulePerception(priority, () => observer.observe(query.target, ctx));
      const factsStored = storeObservation(observer, query.target, signature, observed);
      const match = factsStored.find((fact) => fact.type === query.type) as Fact<V> | undefined;
      if (match && match.confidence >= minConfidence) {
        return { fact: match, path: observer.id, ms: Date.now() - startedAt };
      }
    } catch {
      // Observation failed (decode error, CORS taint, …) — try the next path, else decline.
    }
  }

  return null;
}
