/**
 * Main-thread responsiveness diagnostics — DATA over theories for "the UI feels laggy" reports.
 *
 * Always-on (counters are near-free); verbose console logging behind localStorage
 * `orreris.perfLog = "1"`. Everything lands on window so a soak report is one paste:
 *
 *   __rfLongTasks     — main-thread blocks >50ms: count/total/max + the last 20 with timestamps.
 *                       THE answer to "what is hanging": if clicks feel 500ms, the culprit shows
 *                       up here as 100–500ms tasks right at the click timestamps.
 *   __rfClickLatency  — pointerdown → next-paint-after-commit per click: last/worst/avg + the
 *                       last 10 with the pressed element. Distinguishes "main thread blocked"
 *                       (large longtask at the same moment) from "React commit slow".
 *   __rfLoopLag       — 500ms heartbeat drift: how late timers fire (background pressure).
 *   __rfStallStacks   — sampled JS stacks captured DURING ≥1s freezes ("Page Unresponsive"-class),
 *                       via Chrome's self-profiling API (needs the `Document-Policy: js-profiling`
 *                       response header — set in vite dev config). Unlike longtask attribution or
 *                       markHotSpot probes, this names UN-instrumented blockers with file:line.
 *
 * Reading a report: click latency high + longtask at same t → the longtask's attribution names
 * the script; click latency high + NO longtask → layout/paint cost (huge style recalc), rare.
 * A "Page Unresponsive" dialog → check __rfStallStacks (also console.warn'd unconditionally).
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
    return localStorage.getItem("orreris.perfLog") === "1";
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
 * its label + duration, plus a console.warn behind orreris.perfLog. This is how a bare
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

  // 4. Stall stack sampler — the layer that NAMES an un-instrumented freeze. A rolling 10ms
  //    sampling Profiler runs continuously; when the heartbeat below detects a ≥1s stall, the
  //    profile is stopped and the hottest stacks inside the stall window are logged with
  //    function (file:line), then the profiler re-arms. Chrome-only; silently absent elsewhere.
  interface ProfilerTrace {
    resources: string[];
    frames: { name: string; resourceId?: number; line?: number; column?: number }[];
    stacks: { frameId: number; parentId?: number }[];
    samples: { timestamp: number; stackId?: number }[];
  }
  interface ProfilerLike {
    stop(): Promise<ProfilerTrace>;
    addEventListener?(type: "samplebufferfull", listener: () => void): void;
  }
  type ProfilerCtor = new (options: { sampleInterval: number; maxBufferSize: number }) => ProfilerLike;
  const ProfilerClass = (window as unknown as { Profiler?: ProfilerCtor }).Profiler;
  const stallStacks: { at: number; blockedMs: number; top: { samples: number; where: string }[] }[] = [];
  w.__rfStallStacks = stallStacks;
  let profiler: ProfilerLike | null = null;
  const armProfiler = () => {
    if (!ProfilerClass) return;
    try {
      // 10ms samples; 10k buffer ≈ 100s. Re-armed on every stall report AND when the buffer
      // fills (otherwise a quiet stretch would exhaust it and the next freeze would go unsampled).
      profiler = new ProfilerClass({ sampleInterval: 10, maxBufferSize: 10_000 });
      profiler.addEventListener?.("samplebufferfull", () => {
        void profiler?.stop().catch(() => undefined);
        armProfiler();
      });
    } catch {
      profiler = null;
    }
  };
  armProfiler();

  /**
   * HEAP RING (2026-07-28). A stall with NO JS samples is the hardest kind to attribute: the main
   * thread was blocked while not running JS, which means GC, layout/style, or a synchronous browser
   * API — and the JS self-profiler is blind to all three by construction. Sampling the heap on the
   * same heartbeat gives the one discriminator available from inside the page: a major GC shows up as
   * a large DROP in `usedJSHeapSize` across the blocked window, and memory pressure shows up as usage
   * sitting near the limit. Neither proves GC on its own, but "heap fell 400MB during the freeze" and
   * "heap unchanged" send the investigation to completely different places.
   *
   * `performance.memory` is Chromium-only and quantized; absent elsewhere, in which case the report
   * simply says so rather than guessing.
   */
  const heapSamples: { t: number; used: number }[] = [];
  const readHeap = (): { used: number; total: number; limit: number } | null => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : null;
  };
  const mb = (bytes: number) => `${(bytes / 1048576).toFixed(0)}MB`;

  const reportStall = async (stallStart: number, stallEnd: number, blockedMs: number) => {
    const active = profiler;
    profiler = null;
    if (!active) return;
    try {
      const trace = await active.stop();
      const counts = new Map<string, number>();
      for (const sample of trace.samples) {
        if (sample.timestamp < stallStart || sample.timestamp > stallEnd || sample.stackId === undefined) continue;
        // Leaf frame + a few callers, so the line reads like a mini stack.
        const parts: string[] = [];
        let stackId: number | undefined = sample.stackId;
        for (let depth = 0; depth < 4 && stackId !== undefined; depth += 1) {
          const stack: { frameId: number; parentId?: number } | undefined = trace.stacks[stackId];
          if (!stack) break;
          const frame = trace.frames[stack.frameId];
          if (frame?.name) {
            const resource = frame.resourceId !== undefined ? trace.resources[frame.resourceId] : undefined;
            const file = resource ? resource.split("/").slice(-2).join("/") : "";
            parts.push(`${frame.name}${file ? ` (${file}:${frame.line ?? "?"})` : ""}`);
          }
          stackId = stack.parentId;
        }
        const key = parts.join(" < ") || "(anonymous/native)";
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([where, samples]) => ({ samples, where }));
      stallStacks.push({ at: Math.round(stallStart), blockedMs: Math.round(blockedMs), top });
      if (stallStacks.length > 10) stallStacks.shift();
      // Unconditional (not behind orreris.perfLog): a Page-Unresponsive-class stall IS the report.
      if (top.length > 0) {
        console.warn(`[perf] STALL ${Math.round(blockedMs)}ms — sampled culprits:`);
        for (const entry of top) console.warn(`  ${String(entry.samples).padStart(4)}×  ${entry.where}`);
      } else {
        // No JS ran, so name what CAN be measured instead of restating the category list.
        const now = readHeap();
        const before = heapSamples.filter((s) => s.t <= stallStart).pop() ?? heapSamples[0];
        console.warn(`[perf] STALL ${Math.round(blockedMs)}ms — no JS samples in window (GC / layout / synchronous browser API).`);
        if (now && before) {
          const delta = now.used - before.used;
          const pressure = (now.used / now.limit) * 100;
          console.warn(
            `  heap ${mb(before.used)} → ${mb(now.used)} (${delta >= 0 ? "+" : ""}${mb(delta)}) · ` +
              `${pressure.toFixed(0)}% of ${mb(now.limit)} limit`
          );
          // A major GC is the one cause that RECLAIMS during the freeze; the others leave the heap
          // flat or growing. This is a strong hint, not a verdict — confirm in DevTools Performance.
          if (delta < -8 * 1048576) console.warn("  ↳ heap FELL during the freeze — consistent with a major GC");
          else if (pressure > 80) console.warn("  ↳ heap near the limit — memory pressure is the first thing to chase");
          else console.warn("  ↳ heap flat — GC is UNLIKELY; look at layout/style or a synchronous browser API (DevTools Performance)");
        } else if (!now) {
          console.warn("  heap unavailable (performance.memory is Chromium-only) — use DevTools Performance");
        }
      }
    } catch {
      /* profiler already stopped (buffer-full race) */
    } finally {
      armProfiler();
    }
  };

  /**
   * VISIBILITY GATE (2026-07-28). A late timer means one of TWO things, and this watchdog reported
   * them identically for its whole life: the main thread was blocked, or the timer was THROTTLED.
   * Chrome clamps timers in a hidden tab to ~1/s and, after a few minutes, to ~1/MINUTE — so a
   * backgrounded tab produces a textbook "MAIN THREAD BLOCKED ~59.5s" with no JS samples and a flat
   * heap, which is exactly what a real non-JS freeze looks like here. Three consecutive ~59.5s
   * reports (59500 / 59498 / 59493 ms) are the giveaway: a genuine freeze does not land on the same
   * duration three times, a 60s timer clamp does.
   *
   * Overlap the blocked window against recorded hidden intervals and say which one it was.
   */
  const hiddenIntervals: { start: number; end: number }[] = [];
  let hiddenSince: number | null = document.visibilityState === "hidden" ? performance.now() : null;
  document.addEventListener("visibilitychange", () => {
    const t = performance.now();
    if (document.visibilityState === "hidden") {
      hiddenSince = t;
    } else if (hiddenSince !== null) {
      hiddenIntervals.push({ start: hiddenSince, end: t });
      hiddenSince = null;
      if (hiddenIntervals.length > 50) hiddenIntervals.shift();
    }
  });
  /** Was the page hidden at any point in [start, end]? Includes a still-open hidden interval. */
  const wasHiddenDuring = (start: number, end: number): boolean => {
    if (hiddenSince !== null && hiddenSince <= end) return true;
    return hiddenIntervals.some((iv) => iv.start <= end && iv.end >= start);
  };

  // 3. Event-loop heartbeat: how late a 500ms timer fires. A ≥1s lag is a freeze — trigger the
  //    stall stack report for the blocked window.
  let expected = performance.now() + 500;
  window.setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - expected);
    expected = now + 500;
    // Sample BEFORE the stall check, so the ring already holds a pre-freeze reading to compare against.
    const heap = readHeap();
    if (heap) {
      heapSamples.push({ t: now, used: heap.used });
      if (heapSamples.length > 240) heapSamples.shift(); // ~2 minutes at 500ms
    }
    stats.loopLag.maxMs = Math.max(stats.loopLag.maxMs, Math.round(lag));
    stats.loopLag.avgMs = Math.round((stats.loopLag.avgMs * stats.loopLag.samples + lag) / (stats.loopLag.samples + 1));
    stats.loopLag.samples += 1;
    if (lag >= 1000) {
      const windowStart = now - lag - 500;
      // Throttled ≠ blocked. Attributing a hidden-tab clamp as a freeze sent this investigation
      // chasing a phantom 59.5s stall; keep the two labelled apart at the source.
      if (wasHiddenDuring(windowStart, now)) {
        console.warn(
          `[perf] timer late ~${(lag / 1000).toFixed(1)}s while the tab was HIDDEN — background throttling, not a freeze (ignored)`
        );
        // Re-arm so the profiler buffer does not carry the throttled window into the next report.
        void profiler?.stop().catch(() => undefined);
        profiler = null;
        armProfiler();
        return;
      }
      console.warn(`[perf] MAIN THREAD BLOCKED ~${(lag / 1000).toFixed(1)}s`);
      void reportStall(windowStart, now, lag);
    }
  }, 500);
}
