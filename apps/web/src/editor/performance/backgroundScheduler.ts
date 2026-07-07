/**
 * Background-work gate (Phase 2 of the preview-never-freezes plan, 2026-07-06).
 *
 * Single authority for whether DEFERRABLE work — ingest-proxy transcodes, span-proxy generation,
 * filmstrip/poster extraction, waveform decodes, still-proxy generation — may run right now.
 * Playback, an active timeline gesture, and a running export each close the gate. Producers don't
 * subscribe to each condition separately (that's how the pre-Phase-1 engine ended up transcoding
 * against live playback); they ask this module.
 *
 * Two consumption styles:
 *  - `waitWhileBackgroundBlocked()` inside a work loop: parks mid-task within one unit of work.
 *  - `whenBackgroundIdle()` before starting a task: additionally waits for the gate to have been
 *    open for a short debounce, so deferred work never lands on the first beat after a pause —
 *    that beat belongs to the settle frame / UI.
 *
 * Telemetry: `window.__rfBgGate` (live reasons + how often work was held).
 */

// "pressure"/"memory" are owned by the degradation controller (degradation.ts): sustained
// main-thread long-task pressure or high JS-heap usage close the gate until conditions clear.
export type BackgroundGateReason = "playing" | "gesture" | "exporting" | "pressure" | "memory";

const reasons = new Set<BackgroundGateReason>();
const listeners = new Set<() => void>();
let holds = 0;

const IDLE_DEBOUNCE_MS = 600;
const POLL_MS = 250;

// When the gate last TRANSITIONED to open — the idle debounce is measured from here, so a
// long-open gate costs a work loop nothing per iteration.
let openedAt = Date.now();

export function setBackgroundGate(reason: BackgroundGateReason, blocked: boolean): void {
  const had = reasons.has(reason);
  if (blocked === had) return;
  if (blocked) {
    reasons.add(reason);
  } else {
    reasons.delete(reason);
    if (reasons.size === 0) openedAt = Date.now();
  }
  for (const listener of Array.from(listeners)) listener();
}

export function isBackgroundWorkAllowed(): boolean {
  return reasons.size === 0;
}

export function subscribeBackgroundGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Park until the gate is open. For per-unit checks inside long work loops. */
export async function waitWhileBackgroundBlocked(): Promise<void> {
  if (isBackgroundWorkAllowed()) return;
  holds += 1;
  while (!isBackgroundWorkAllowed()) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Resolve once the gate has been open CONTINUOUSLY for the idle debounce. For task starts. */
export async function whenBackgroundIdle(): Promise<void> {
  for (;;) {
    await waitWhileBackgroundBlocked();
    const remaining = IDLE_DEBOUNCE_MS - (Date.now() - openedAt);
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, remaining + 10));
    if (isBackgroundWorkAllowed() && Date.now() - openedAt >= IDLE_DEBOUNCE_MS) return;
  }
}

// Debug handle, matching the repo's __rf* telemetry convention.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__rfBgGate", {
    configurable: true,
    get: () => ({ reasons: Array.from(reasons), holds }),
  });
}
