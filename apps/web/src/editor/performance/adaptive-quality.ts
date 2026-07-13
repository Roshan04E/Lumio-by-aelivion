/**
 * Adaptive playback quality (P0 — see the 2026-07-02 NLE gap analysis).
 *
 * Premiere/Resolve auto-degrade playback resolution when the machine can't hold the frame budget; this
 * is Kimera's equivalent. It watches the frame-stats window (`frame-stats.ts`) DURING PLAYBACK and steps
 * an additional render-scale CAP down the already-tested profile ladder (1 → 0.5 → 0.25) when frames are
 * being dropped, then recovers upward after a sustained clean run. The viewer applies
 * `min(userProfileScale, adaptiveScaleCap)` while playing — so this only ever LOWERS below the user's
 * chosen quality, never raises it, and paused/scrubbing rendering (always scale 1) is untouched.
 *
 * Deliberately conservative (the repo has been bitten by clever preview changes):
 *  - only the ladder values the compositor already exercises (1 / 0.5 / 0.25) — no novel scales;
 *  - hysteresis: one step per {@link STEP_DOWN_COOLDOWN_MS}, and {@link RECOVER_AFTER_MS} of clean
 *    playback before stepping back up — no per-frame thrash;
 *  - decisions need a half-full sample window, so a single hitch can't trigger a drop;
 *  - kill switch mirroring `getGlGovernorEnabled`: `?adaptiveQuality=0` → localStorage
 *    `kimera.adaptiveQuality` → `VITE_ADAPTIVE_QUALITY` → ON by default.
 */

import { getFrameStatsSnapshot, subscribeFrameStats } from "./frame-stats";

const SCALE_LADDER = [1, 0.5, 0.25] as const;
// Step down when more than a fifth of the window missed the 30fps floor (28ms) — visibly unsmooth.
const STEP_DOWN_DROPPED_RATIO = 0.2;
// Recover when the window is essentially clean.
const RECOVER_DROPPED_RATIO = 0.05;
const MIN_WINDOW_SAMPLES = 60; // ~1s at 60fps before any decision
const STEP_DOWN_COOLDOWN_MS = 1500;
const RECOVER_AFTER_MS = 4000;

/**
 * Resolution order: `?adaptiveQuality=0|1` → localStorage `kimera.adaptiveQuality` →
 * `VITE_ADAPTIVE_QUALITY` → true. (Same pattern as `getGlGovernorEnabled` / `getExportWorkerScene`.)
 */
export function getAdaptiveQualityEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("adaptiveQuality")) {
        return truthy(new URLSearchParams(window.location.search).get("adaptiveQuality"));
      }
      const stored = window.localStorage?.getItem("kimera.adaptiveQuality");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ADAPTIVE_QUALITY;
  return env == null ? true : truthy(env);
}

let ladderIndex = 0; // 0 = no cap (scale 1)
let lastStepDownAt = 0;
let cleanSinceAt: number | null = null;
let started = false;

const listeners = new Set<() => void>();

// Runtime override (the transport's Auto button). null = defer to the flag resolution above.
// Toggling OFF releases the cap immediately — the user's manual ¼/½/1 choice then rules alone.
let runtimeEnabled: boolean | null = null;

/** Live enabled state: the Auto button's runtime choice wins over the boot-time flag. */
export function isAdaptiveQualityOn(): boolean {
  return runtimeEnabled ?? getAdaptiveQualityEnabled();
}

/** Toggle auto-degrade at runtime (persisted to the existing `kimera.adaptiveQuality` key). */
export function setAdaptiveQualityOn(on: boolean): void {
  runtimeEnabled = on;
  try {
    window.localStorage?.setItem("kimera.adaptiveQuality", on ? "1" : "0");
  } catch {
    /* restricted storage — runtime flag still applies this session */
  }
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (!on) {
    setLadderIndex(0, now); // release any active cap right away (notifies subscribers)
  } else {
    for (const listener of listeners) listener();
  }
}

function setLadderIndex(next: number, now: number) {
  if (next === ladderIndex) return;
  ladderIndex = next;
  cleanSinceAt = null;
  if (next > 0) lastStepDownAt = now;
  for (const listener of listeners) listener();
}

/**
 * Runs on the frame-stats notify tick (throttled to ~2Hz there — this is NOT per-frame work).
 * Pure threshold/hysteresis logic; never throws.
 */
function evaluate() {
  if (!isAdaptiveQualityOn()) return; // Auto off: cap frozen at 1 (released by the setter)
  const stats = getFrameStatsSnapshot();
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (!stats.playing) {
    // Paused: keep the cap sticky (the next play resumes from the last known-good level; a clean run
    // while playing is what earns the step back up). Paused rendering itself is always full-res.
    cleanSinceAt = null;
    return;
  }
  if (stats.sampleCount < MIN_WINDOW_SAMPLES) return;

  if (stats.droppedRatio > STEP_DOWN_DROPPED_RATIO) {
    cleanSinceAt = null;
    if (ladderIndex < SCALE_LADDER.length - 1 && now - lastStepDownAt >= STEP_DOWN_COOLDOWN_MS) {
      setLadderIndex(ladderIndex + 1, now);
    }
    return;
  }

  if (ladderIndex > 0 && stats.droppedRatio < RECOVER_DROPPED_RATIO) {
    if (cleanSinceAt == null) {
      cleanSinceAt = now;
    } else if (now - cleanSinceAt >= RECOVER_AFTER_MS) {
      setLadderIndex(ladderIndex - 1, now);
    }
  } else {
    cleanSinceAt = null;
  }
}

/**
 * Degradation controller hook (degradation.ts): external pressure signal (sustained long tasks) —
 * step the cap down one rung NOW, under the same cooldown/ladder rules as frame-drop steps.
 * No-op when Auto is off (the user's manual tier choice rules) or already at the floor.
 */
export function forceAdaptiveStepDown(): void {
  if (!isAdaptiveQualityOn()) return;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (ladderIndex < SCALE_LADDER.length - 1 && now - lastStepDownAt >= STEP_DOWN_COOLDOWN_MS) {
    setLadderIndex(ladderIndex + 1, now);
  }
}

/** Idempotent; the viewer calls this once so the controller only runs when a preview is mounted. */
export function ensureAdaptiveQualityStarted(): void {
  if (started) return;
  started = true;
  // Always subscribe; evaluate() gates on the LIVE enabled state so the transport's Auto button
  // can turn auto-degrade back on without a reload. (Was: never subscribe when boot-disabled.)
  subscribeFrameStats(evaluate);
}

/** Current cap (1 / 0.5 / 0.25). The viewer applies `min(profileScale, cap)` while playing. */
export function getAdaptiveScaleCap(): number {
  return isAdaptiveQualityOn() ? SCALE_LADDER[ladderIndex]! : 1;
}

export function subscribeAdaptiveScaleCap(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
