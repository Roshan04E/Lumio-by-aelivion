/**
 * Orreris OS — observer registry (K1). Observers are plugins from day one: anything —
 * built-in analyzers, future browser-ML models, cloud services — enters through
 * `registerObserver()` and becomes an access path the query planner can choose.
 * The runtime never knows HOW an observer works, only its declared economics.
 */

import type { WorldObserver } from "./types";

const observers = new Map<string, WorldObserver>();

export function registerObserver(observer: WorldObserver): void {
  observers.set(observer.id, observer);
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
