/**
 * Orreris OS — observer registry (K1; SDK v1 surface). Observers are plugins from day one:
 * anything — built-in analyzers, browser-ML models, cloud services — enters through
 * `registerObserver()` and becomes an access path the query planner can choose.
 * The runtime never knows HOW an observer works, only its declared economics.
 *
 * SDK v1 contract (ORRERIS_SDK.md): registration VALIDATES the declaration — an observer
 * that lies about its shape is rejected loudly (console + false) instead of corrupting the
 * planner's candidate table. Duplicate ids overwrite (last write wins): that keeps Vite HMR
 * re-registration and deliberate plugin overrides working; version bumps invalidate memos.
 */

import type { WorldObserver } from "./types";

const observers = new Map<string, WorldObserver>();

/** Why a registration violates the SDK contract, or null when it's valid. */
export function observerContractIssue(observer: WorldObserver): string | null {
  if (!observer || typeof observer !== "object") return "not an object";
  if (typeof observer.id !== "string" || !/^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*$/i.test(observer.id)) {
    return `id must be "<name>@<namespace>" (got ${JSON.stringify(observer.id)})`;
  }
  if (!Number.isInteger(observer.version) || observer.version < 1) return "version must be an integer ≥ 1";
  if (!Array.isArray(observer.factTypes) || observer.factTypes.length === 0 || observer.factTypes.some((t) => typeof t !== "string" || !t)) {
    return "factTypes must be a non-empty string array";
  }
  if (!Number.isInteger(observer.fidelity) || observer.fidelity < 0 || observer.fidelity > 4) return "fidelity must be an integer 0–4";
  if (!Number.isFinite(observer.estCostMs) || observer.estCostMs <= 0) return "estCostMs must be > 0 (declare an honest price)";
  if (!Number.isFinite(observer.estConfidence) || observer.estConfidence <= 0 || observer.estConfidence > 1) {
    return "estConfidence must be in (0, 1]";
  }
  if (typeof observer.signature !== "function" || typeof observer.observe !== "function") {
    return "signature() and observe() are required";
  }
  return null;
}

/** Register an observer. Returns false (with a loud console warning) on a contract violation. */
export function registerObserver(observer: WorldObserver): boolean {
  const issue = observerContractIssue(observer);
  if (issue) {
    console.warn(`[orreris-sdk] observer registration rejected: ${issue}`);
    return false;
  }
  observers.set(observer.id, observer);
  return true;
}

export function getObserver(id: string): WorldObserver | undefined {
  return observers.get(id);
}

/** Access paths for a fact type, cheapest first — the query planner's candidate table. */
export function observersForFactType(type: string): WorldObserver[] {
  return Array.from(observers.values())
    .filter((observer) => observer.factTypes.includes(type))
    .sort((a, b) => a.estCostMs - b.estCostMs);
}

export function listObservers(): WorldObserver[] {
  return Array.from(observers.values());
}
