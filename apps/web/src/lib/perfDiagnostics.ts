/**
 * Main-thread responsiveness diagnostics — DATA over theories for "the UI feels laggy" reports.
 *
 * Always-on (counters are near-free); verbose console logging behind localStorage
 * `lumio.perfLog = "1"`. Everything lands on window so a soak report is one paste:
 *
 *   __rfLongTasks     — main-thread blocks >50ms: count/total/max + the last 20 with timestamps.
 *                       THE answer to "what is hanging": if clicks feel 500ms, the culprit shows
 *                       up here as 100–500ms tasks right at the click timestamps.
 *   __rfClickLatency  — pointerdown → next-paint-after-commit per click: last/worst/avg + the
 *                       last 10 with the pressed element. Distinguishes "main thread blocked"
 *                       (large longtask at the same moment) from "React commit slow".
 *   __rfLoopLag       — 500ms heartbeat drift: how late timers fire (background pressure).
 *
 * Reading a report: click latency high + longtask at same t → the longtask's attribution names
 * the script; click latency high + NO longtask → layout/paint cost (huge style recalc), rare.
 */

import { useLayoutEffect } from "react";

type LongTaskEntry = { at: number; ms: number; source: string };

interface PerfStats {
  longTasks: { count: number; totalMs: number; maxMs: number; recent: LongTaskEntry[] };
  clicks: { last: number; worst: number; avg: number; samples: number; recent: { at: number; ms: number; target: string }[] };
  loopLag: { maxMs: number; avgMs: number; samples: number };
}

const stats: PerfStats = {
  longTasks: { count: 0, totalMs: 0, maxMs: 0, recent: [] },
  clicks: { last: 0, worst: 0, avg: 0, samples: 0, recent: [] },
  loopLag: { maxMs: 0, avgMs: 0, samples: 0 }
};

function verbose(): boolean {
  try {
    return localStorage.getItem("lumio.perfLog") === "1";
  } catch {
    return false;
  }
}

function describeTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "?";
  const cls = typeof target.className === "string" ? target.className.split(/\s+/).slice(0, 2).join(".") : "";
  return `${target.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
}

/**
 * Per-component render+commit cost → window.__rfRenderCost[name]. Measures from render start to
 * the layout effect (includes the subtree's render + DOM commit), so nesting double-counts by
 * design: EditorPage's number is the whole tree, TimelineStrip/VideoPreview/AssetBin show their
 * share of it. The 2×250ms-per-click longtask pattern (2026-07-04 log) gets NAMED by this.
 */
export function useRenderCost(name: string): void {
  const t0 = performance.now();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- unconditional in every caller
  useLayoutEffect(() => {
    const ms = performance.now() - t0;
    const w = window as unknown as { __rfRenderCost?: Record<string, { renders: number; totalMs: number; maxMs: number; lastMs: number }> };
    const store = (w.__rfRenderCost ??= {});
    const entry = (store[name] ??= { renders: 0, totalMs: 0, maxMs: 0, lastMs: 0 });
    entry.renders += 1;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, Math.round(ms));
    entry.lastMs = Math.round(ms);
    if (ms > 120 && verbose()) {
      console.warn(`[perf] slow render+commit ${Math.round(ms)}ms in ${name}`);
    }
  });
}

/**
 * Names the "unknown" long tasks: wrap a suspect synchronous stretch (WebGL renderer init, LUT
 * bake, first texture upload, demux round…) and any run >40ms lands in window.__rfHotSpots with
 * its label + duration, plus a console.warn behind lumio.perfLog. This is how a bare
 * "long task 2077ms (unknown)" inside a rAF (2026-07-04 playhead-placement report) gets a name —
 * long-task attribution can't see into rAF callbacks, but these probes can.
 */
export function markHotSpot(label: string, startMs: number, detail?: string): void {
  const ms = performance.now() - startMs;
  if (ms < 40 || typeof window === "undefined") return;
  const w = window as unknown as { __rfHotSpots?: { count: number; recent: { at: number; label: string; ms: number; detail?: string }[] } };
  const store = (w.__rfHotSpots ??= { count: 0, recent: [] });
  store.count += 1;
  store.recent.push({ at: Math.round(startMs), label, ms: Math.round(ms), ...(detail ? { detail } : {}) });
  if (store.recent.length > 40) store.recent.shift();
  if (verbose()) {
    console.warn(`[perf] hot spot ${label} ${Math.round(ms)}ms${detail ? ` (${detail})` : ""}`);
  }
}

// Live long-task feed for the degradation controller (degradation.ts) — fires per observed task
// with its duration. Kept separate from the stats object so consumers don't poll window globals.
const longTaskListeners = new Set<(ms: number) => void>();
export function onLongTask(listener: (ms: number) => void): () => void {
  longTaskListeners.add(listener);
  return () => {
    longTaskListeners.delete(listener);
  };
}

export function installPerfDiagnostics(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__rfPerfInstalled) return;
  w.__rfPerfInstalled = true;
  w.__rfLongTasks = stats.longTasks;
  w.__rfClickLatency = stats.clicks;
  w.__rfLoopLag = stats.loopLag;

  // 1. Long tasks (main-thread blocks >50ms) with best-effort attribution.
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const attribution = (entry as unknown as { attribution?: { name?: string; containerSrc?: string }[] }).attribution?.[0];
        const source = attribution?.name || attribution?.containerSrc || entry.name || "unknown";
        stats.longTasks.count += 1;
        stats.longTasks.totalMs += entry.duration;
        stats.longTasks.maxMs = Math.max(stats.longTasks.maxMs, entry.duration);
        stats.longTasks.recent.push({ at: Math.round(entry.startTime), ms: Math.round(entry.duration), source });
        if (stats.longTasks.recent.length > 20) stats.longTasks.recent.shift();
        for (const listener of longTaskListeners) listener(entry.duration);
        if (verbose()) {
          console.warn(`[perf] long task ${Math.round(entry.duration)}ms @ ${Math.round(entry.startTime)}ms (${source})`);
        }
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    /* longtask observer unsupported — click latency still works */
  }

  // 2. Click → paint latency: pointerdown (capture, so no handler can hide it) to the second rAF
  //    (first rAF can fire before the triggered commit; the second is after paint).
  window.addEventListener(
    "pointerdown",
    (event) => {
      const t0 = performance.now();
      const target = describeTarget(event.target);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const ms = performance.now() - t0;
          stats.clicks.last = Math.round(ms);
          stats.clicks.worst = Math.max(stats.clicks.worst, Math.round(ms));
          stats.clicks.avg = Math.round((stats.clicks.avg * stats.clicks.samples + ms) / (stats.clicks.samples + 1));
          stats.clicks.samples += 1;
          stats.clicks.recent.push({ at: Math.round(t0), ms: Math.round(ms), target });
          if (stats.clicks.recent.length > 10) stats.clicks.recent.shift();
          if (ms > 100 && verbose()) {
            console.warn(`[perf] slow click ${Math.round(ms)}ms on ${target}`);
          }
        });
      });
    },
    { capture: true, passive: true }
  );

  // 3. Event-loop heartbeat: how late a 500ms timer fires.
  let expected = performance.now() + 500;
  window.setInterval(() => {
    const lag = Math.max(0, performance.now() - expected);
    expected = performance.now() + 500;
    stats.loopLag.maxMs = Math.max(stats.loopLag.maxMs, Math.round(lag));
    stats.loopLag.avgMs = Math.round((stats.loopLag.avgMs * stats.loopLag.samples + lag) / (stats.loopLag.samples + 1));
    stats.loopLag.samples += 1;
  }, 500);
}
