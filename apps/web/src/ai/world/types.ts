/**
 * Kimera OS — World Model contracts (K1, see KIMERA_OS.md → Layer 2).
 *
 * The World Model is the typed-query layer the cognitive tiers consult for FACTS about the
 * project's media and composition. Three laws, enforced by these types:
 *
 *  1. **Facts are cached values; cost lives on the access path.** A `Fact` carries value +
 *     confidence + provenance + freshness. `estCostMs`/`estConfidence` live on the OBSERVER
 *     (the access path) — one query may have several routes and the query planner picks the
 *     cheapest sufficient one (knowledge.ts).
 *  2. **Truth maintenance via input signatures.** Every fact records the deterministic
 *     signature of its observer's input at observation time. Signature mismatch on read =
 *     stale = the fact is dead, and death cascades through `dependencies` (the plan-cache-v2
 *     byte-identical rule promoted to the whole knowledge layer).
 *  3. **The model is dumb about meaning.** It answers typed queries; relevance is the
 *     caller's (planner's) job. No "give me everything relevant" API exists on purpose.
 *
 * K1 scope honesty: the store is in-memory + bounded (facts at fidelity L0–L2 are cheap to
 * recompute); OPFS persistence is a K2 concern. `inputSignature` is a cheap deterministic
 * field signature, not a byte hash — same stand-in the source-proxy engine uses.
 */

import type { SourceAsset, TimelineComposition } from "@kimera-by-aelivion/shared";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * K2 note: "system" / "user" / "project" are the World Model's non-media state branches
 * (KIMERA_OS.md → Layer 2). Editor state (selection/playhead/mode) deliberately stays in
 * BrainContext instead of becoming facts: it is ephemeral and free to read, so there is no
 * acquisition cost to amortize — caching it would only create staleness.
 */
export type WorldTargetKind = "asset" | "composition" | "system" | "user" | "project";

export interface WorldTarget {
  kind: WorldTargetKind;
  id: string;
}

/** Canonical map key for a target — `asset:<id>` / `composition:<id>`. */
export function targetKey(target: WorldTarget): string {
  return `${target.kind}:${target.id}`;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface FactProvenance {
  observerId: string;
  observerVersion: number;
  /**
   * Deterministic signature of the observer's input at observation time. Compared against the
   * observer's CURRENT signature on every read; mismatch invalidates the fact (+ cascade).
   */
  inputSignature: string;
  /** Seconds-into-source ranges actually sampled (honesty: "3 frames", not "the whole clip"). */
  sampledRanges?: Array<[number, number]> | undefined;
}

export interface Fact<V = unknown> {
  /** `${type}|${targetKey}` — one live fact per (type, target). */
  id: string;
  type: string;
  /** targetKey() of the observed target. */
  target: string;
  value: V;
  /** 0..1 — how sure the observer is about THIS value. */
  confidence: number;
  /** Epoch ms at observation. */
  observedAt: number;
  provenance: FactProvenance;
  /** Fact ids this fact was derived from. Invalidation cascades through these. */
  dependencies: string[];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface FactQuery {
  type: string;
  target: WorldTarget;
  /** Reject answers below this confidence (default 0 — anything goes). */
  minConfidence?: number | undefined;
  /** Acquisition budget: only access paths with estCostMs ≤ budget are eligible (default 5000). */
  budgetMs?: number | undefined;
  /** Reject cached facts older than this even when their signature still matches. */
  maxAgeMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Observers (the access paths)
// ---------------------------------------------------------------------------

/**
 * Everything an observer may look at. Built by the caller (route/panel: live editor state;
 * eval: synthetic fixtures) — observers never reach into stores themselves, which keeps them
 * pure enough to run under node/tsx.
 */
export interface WorldContext {
  composition?: TimelineComposition | undefined;
  assets: SourceAsset[];
}

/** One value an observation produced. `observe()` may emit several sibling facts in one run. */
export interface ObservedFact<V = unknown> {
  type: string;
  value: V;
  confidence: number;
  sampledRanges?: Array<[number, number]> | undefined;
}

/** Perception fidelity ladder (KIMERA_OS.md): L0 metadata … L4 inferred meaning. */
export type ObserverFidelity = 0 | 1 | 2 | 3 | 4;

export interface WorldObserver {
  id: string;
  /** Bump when the algorithm changes — versions part of the memo key, so stale facts die. */
  version: number;
  /** Fact types this observer can produce. The access-path table derives from this. */
  factTypes: readonly string[];
  fidelity: ObserverFidelity;
  /** Access-path economics (estimates; the ledger keeps them honest over time). */
  estCostMs: number;
  estConfidence: number;
  /**
   * Deterministic signature of this observer's input for `target`, or null when the target
   * cannot be observed here (wrong kind, missing asset, no DOM in node…). MUST be cheap and
   * synchronous — it runs on every cached read for truth maintenance.
   */
  signature(target: WorldTarget, ctx: WorldContext): string | null;
  observe(target: WorldTarget, ctx: WorldContext): Promise<ObservedFact[]>;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit — the repo-idiomatic cheap deterministic signature for small strings. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
