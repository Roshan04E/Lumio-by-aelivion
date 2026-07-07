/**
 * Degradation controller (Phase 4 of the preview-never-freezes plan, 2026-07-06):
 * degrade instead of dying with "page unresponsive".
 *
 * Two independent guards, both feeding the single background-work gate (backgroundScheduler.ts):
 *
 *  - PRESSURE: sustained main-thread long-task load (fed live by perfDiagnostics' longtask
 *    observer). When more than {@link PRESSURE_BLOCKED_RATIO} of the trailing window was spent
 *    inside >50ms tasks, background work is suspended ("pressure"), the adaptive quality cap steps
 *    down one rung (only if the transport's Auto mode is on), and a one-shot notice explains the
 *    softness. Released after {@link RELEASE_AFTER_CLEAN_MS} without a single long task.
 *
 *  - MEMORY (Chrome only — `performance.memory`): JS heap above {@link MEM_PRESSURE_RATIO} of the
 *    limit clears the regenerable LRU caches (filmstrips/posters/audio peaks) and suspends
 *    background work ("memory") until usage falls back under the ratio.
 *
 * Deliberately conservative: hysteresis on both sides, one notice per activation (not per sample),
 * and it only ever SUSPENDS deferrable work / LOWERS quality — playback and editing are untouched.
 * Telemetry: `window.__rfDegradation`.
 */

import { onLongTask } from "../../lib/perfDiagnostics";
import { setNotice } from "../../lib/noticeStore";
import { clearThumbnailCaches } from "../../lib/videoThumbnails";
import { clearAudioPeakCaches } from "../../lib/audioPeaks";
import { setBackgroundGate } from "./backgroundScheduler";
import { forceAdaptiveStepDown } from "./adaptive-quality";

const WINDOW_MS = 5000;
/** Activate when >30% of the trailing window was inside long tasks (main thread visibly wedging). */
const PRESSURE_BLOCKED_RATIO = 0.3;
const RELEASE_AFTER_CLEAN_MS = 8000;
const MEM_CHECK_INTERVAL_MS = 10_000;
const MEM_PRESSURE_RATIO = 0.85;
/** Don't re-toast the same condition more often than this. */
const NOTICE_COOLDOWN_MS = 60_000;

type DegradationStats = {
  pressureActive: boolean;
  memoryActive: boolean;
  pressureActivations: number;
  memoryActivations: number;
  lastBlockedRatio: number;
  lastHeapRatio: number | null;
};

const stats: DegradationStats = {
  pressureActive: false,
  memoryActive: false,
  pressureActivations: 0,
  memoryActivations: 0,
  lastBlockedRatio: 0,
  lastHeapRatio: null,
};

let started = false;
let tasks: Array<{ at: number; ms: number }> = [];
let lastLongTaskAt = 0;
let lastNoticeAt = 0;
let releaseTimer: number | null = null;

function maybeNotice(message: string): void {
  const now = Date.now();
  if (now - lastNoticeAt < NOTICE_COOLDOWN_MS) return;
  lastNoticeAt = now;
  setNotice(message);
}

function evaluatePressure(now: number): void {
  tasks = tasks.filter((t) => now - t.at < WINDOW_MS);
  let blocked = 0;
  for (const t of tasks) blocked += t.ms;
  stats.lastBlockedRatio = blocked / WINDOW_MS;
  if (!stats.pressureActive && stats.lastBlockedRatio > PRESSURE_BLOCKED_RATIO) {
    stats.pressureActive = true;
    stats.pressureActivations += 1;
    setBackgroundGate("pressure", true);
    forceAdaptiveStepDown();
    maybeNotice("Performance mode: background tasks paused while the system catches up");
  }
  armReleaseCheck();
}

/** Release only after a fully clean window — one timer, re-armed while pressure persists. */
function armReleaseCheck(): void {
  if (!stats.pressureActive || releaseTimer !== null) return;
  releaseTimer = window.setTimeout(() => {
    releaseTimer = null;
    if (!stats.pressureActive) return;
    if (performance.now() - lastLongTaskAt >= RELEASE_AFTER_CLEAN_MS) {
      stats.pressureActive = false;
      setBackgroundGate("pressure", false);
    } else {
      armReleaseCheck();
    }
  }, RELEASE_AFTER_CLEAN_MS / 2);
}

function checkMemory(): void {
  const memory = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!memory || !memory.jsHeapSizeLimit) return;
  const ratio = memory.usedJSHeapSize / memory.jsHeapSizeLimit;
  stats.lastHeapRatio = Math.round(ratio * 100) / 100;
  if (ratio > MEM_PRESSURE_RATIO) {
    if (!stats.memoryActive) {
      stats.memoryActive = true;
      stats.memoryActivations += 1;
      setBackgroundGate("memory", true);
      maybeNotice("Memory is tight — cleared preview caches and paused background tasks");
    }
    // Clear on every over-threshold sample: the caches refill lazily between samples.
    clearThumbnailCaches();
    clearAudioPeakCaches();
  } else if (stats.memoryActive) {
    stats.memoryActive = false;
    setBackgroundGate("memory", false);
  }
}

/** Idempotent; EditorPage calls this on mount (the gate's consumers only exist in the editor). */
export function ensureDegradationControllerStarted(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  onLongTask((ms) => {
    const now = performance.now();
    lastLongTaskAt = now;
    tasks.push({ at: now, ms });
    evaluatePressure(now);
  });
  window.setInterval(checkMemory, MEM_CHECK_INTERVAL_MS);

  Object.defineProperty(window, "__rfDegradation", {
    configurable: true,
    get: () => ({ ...stats }),
  });
}
