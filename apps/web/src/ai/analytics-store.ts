import {
  getActionAnalytics,
  hydrateActionAnalytics,
  subscribeActionAnalytics,
  type ActionAnalyticsSnapshot
} from "@lumio-by-aelivion/shared";

/**
 * Host-side persistence for the shared analytics counters (P7). The shared
 * package keeps the live in-memory store; this bridge hydrates it from
 * localStorage on boot and writes back on every change so the Missing-Capability
 * Dashboard survives reloads. Call `initAnalyticsPersistence()` once at startup.
 */

const STORAGE_KEY = "lumio.ai.analytics.v1";
let initialized = false;

export function initAnalyticsPersistence(): void {
  if (initialized || typeof localStorage === "undefined") {
    return;
  }
  initialized = true;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      hydrateActionAnalytics(JSON.parse(raw) as Partial<ActionAnalyticsSnapshot>);
    }
  } catch {
    /* corrupt payload — start fresh */
  }

  subscribeActionAnalytics((snapshot) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      /* quota — best effort */
    }
  });
}

export function readAnalytics(): ActionAnalyticsSnapshot {
  return getActionAnalytics();
}
