import { useSyncExternalStore } from "react";

/**
 * High-frequency playback clock, decoupled from the editor's React state.
 *
 * The editor preview, timeline playhead, transport readout, and scopes need the playhead time at
 * ~playback frequency (up to one update per animation frame). Driving that through `EditorPage`'s
 * `currentTime` useState re-rendered the ENTIRE ~4000-line editor tree on every tick — the
 * inspector, asset bin, effects panel and toolbars included — which churned allocations and produced
 * the periodic GC freeze ("~300 ms frozen / ~700 ms smooth").
 *
 * This store is the hot path: the playback loop pushes ticks here, and only the few leaves that
 * actually animate (`VideoPreview`, the transport time label, the scopes) subscribe via
 * {@link usePlaybackClock}. `EditorPage` keeps its own `currentTime` state as a low-rate mirror for
 * the cold render path (inspector keyframe readouts, clip-under-playhead logic) — committed at a
 * fraction of the tick rate — so a tick no longer re-renders the world.
 */

let clockTime = 0;
const listeners = new Set<() => void>();

// React subscribers (usePlaybackClock) are notified at most ONCE PER ANIMATION FRAME. Scrubbing
// pushes the clock once per pointermove (125–1000Hz), and a synchronous notify made every React
// clock consumer — VideoPreview above all, ~50ms/render in dev — re-render PER POINTER EVENT:
// renders arrived faster than they completed and the timeline felt gluey while scrubbing
// (2026-07-04 soak: 276 VideoPreview renders in one scrub pass). Imperative subscribers
// (subscribePlaybackClock — the timeline playhead DOM write) stay synchronous, so the playhead
// itself still tracks the pointer with zero added latency; only the React re-render is coalesced
// to display rate. The snapshot read is always live (getPlaybackClock), so a deferred notify
// renders with the LATEST time — never a stale one.
const reactListeners = new Set<() => void>();
let reactNotifyRaf: number | null = null;
function notifyReactListeners(): void {
  if (reactListeners.size === 0 || reactNotifyRaf !== null) {
    return;
  }
  if (typeof requestAnimationFrame !== "function") {
    for (const listener of reactListeners) listener();
    return;
  }
  reactNotifyRaf = requestAnimationFrame(() => {
    reactNotifyRaf = null;
    for (const listener of reactListeners) listener();
  });
}

// COLD mirror of the same clock value: consumers that only need the playhead at a low rate (inspector
// keyframe readouts, color scopes, audio-mixer readouts) subscribe here instead of forcing EditorPage
// to hold `currentTime` in React state. Notifications are coalesced to at most one per
// COLD_NOTIFY_MS — the exact role EditorPage's old 120ms trailing `setCurrentTime` commit played,
// but WITHOUT re-rendering the whole editor tree (only the leaves that subscribe re-render). The value
// read is always `getPlaybackClock()` (live); only the NOTIFICATION is throttled, so a cold consumer
// re-rendered for any other reason still sees the latest time (no tearing).
const COLD_NOTIFY_MS = 120;
const coldListeners = new Set<() => void>();
let coldNotifyTimer: ReturnType<typeof setTimeout> | null = null;
// Cold notifications are SUSPENDED during active playback: the editor deliberately freezes the cold
// panels (inspector readouts, scopes, mixer) while playing so their re-renders never compete with
// playback smoothness — only the hot leaves (preview/playhead/timecode) update per frame. The exact
// stop frame is settled via flushColdPlaybackNotify on pause/stop. Mirrors the old behavior where the
// playback loop never mirrored `currentTime` into React state.
let coldSuspended = false;
export function setColdPlaybackSuspended(suspended: boolean): void {
  coldSuspended = suspended;
}
function scheduleColdNotify(): void {
  if (coldSuspended || coldListeners.size === 0) {
    return;
  }
  // DEBOUNCE, not throttle: reset the timer on every push so the cold panels (inspector/scopes/mixer)
  // re-render ONCE, ~120ms after the playhead SETTLES — not repeatedly during a continuous scrub. This
  // is exactly what EditorPage's old trailing `setCurrentTime` commit did; a throttle here re-rendered
  // those heavy panels ~8×/sec mid-scrub and brought the "it feels slow again" regression back.
  if (coldNotifyTimer !== null) {
    clearTimeout(coldNotifyTimer);
  }
  coldNotifyTimer = setTimeout(() => {
    coldNotifyTimer = null;
    for (const listener of coldListeners) {
      listener();
    }
  }, COLD_NOTIFY_MS);
}

/** Push a new playhead time and notify subscribers. Called from the playback rAF loop and on seek. */
export function setPlaybackClock(time: number): void {
  if (time === clockTime) {
    return;
  }
  clockTime = time;
  // Imperative subscribers (playhead DOM write) synchronously — zero latency.
  for (const listener of listeners) {
    listener();
  }
  // React subscribers coalesced to one notify per frame (see reactListeners above).
  notifyReactListeners();
  scheduleColdNotify();
}

/** Read the current playhead time imperatively (e.g. to flush the exact time on stop). */
export function getPlaybackClock(): number {
  return clockTime;
}

/**
 * Notify cold subscribers IMMEDIATELY (bypassing the {@link COLD_NOTIFY_MS} throttle). Used by the
 * discrete, non-scrub playhead events that must land the inspector/scopes exactly — pause, stop,
 * end-of-playback, composition-shrink clamp — where a trailing 120ms delay would leave the readouts
 * a few frames behind where the playhead actually settled. Seeks/scrubs deliberately DON'T flush:
 * their throttled trailing notify is the intended low-rate cold cadence.
 */
export function flushColdPlaybackNotify(): void {
  if (coldNotifyTimer !== null) {
    clearTimeout(coldNotifyTimer);
    coldNotifyTimer = null;
  }
  for (const listener of coldListeners) {
    listener();
  }
}

/**
 * LIVE playhead time at sub-commit precision. The store above is only committed every
 * `playbackCommitIntervalMs` while playing, so right after play starts it can trail the true
 * anchor-derived time by a full interval — the audio-master authority gate compared against that
 * stale value, elected a cold-starting element, and the hard resync yanked the playhead back to
 * the element's start latency ("playhead moves ~0.5–1s then jumps back to start", user report
 * 2026-07-03, second occurrence). `EditorPage` registers its anchor-derived reader while mounted;
 * without one this falls back to the committed clock (fixtures, tests).
 */
let liveTimeReader: (() => number) | null = null;

export function setLivePlaybackTimeReader(reader: (() => number) | null): void {
  liveTimeReader = reader;
}

export function getLivePlaybackTime(): number {
  return liveTimeReader ? liveTimeReader() : clockTime;
}

// React (useSyncExternalStore) subscriptions — notified via the per-frame coalescer above.
function subscribe(listener: () => void): () => void {
  reactListeners.add(listener);
  return () => {
    reactListeners.delete(listener);
    if (reactListeners.size === 0 && reactNotifyRaf !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(reactNotifyRaf);
      reactNotifyRaf = null;
    }
  };
}

/**
 * Imperative (non-React) subscription to clock pushes. For DOM-write-only consumers — e.g. the
 * timeline playhead position while paused/scrubbing — where a React re-render per seek is pure
 * overhead. Notified SYNCHRONOUSLY on every push (unlike React subscribers, which are coalesced
 * to one notification per animation frame). Returns the unsubscribe function.
 */
export function subscribePlaybackClock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to the high-frequency playhead time.
 *
 * Pass `live = false` (e.g. when paused, or in a fixture with a fixed time) to read `fallback`
 * instead — the component still subscribes, but the store only changes during playback, so a paused
 * consumer never re-renders from the clock.
 */
export function usePlaybackClock(fallback: number, live: boolean): number {
  const time = useSyncExternalStore(subscribe, getPlaybackClock, getPlaybackClock);
  return live ? time : fallback;
}

function subscribeCold(listener: () => void): () => void {
  coldListeners.add(listener);
  return () => {
    coldListeners.delete(listener);
    if (coldListeners.size === 0 && coldNotifyTimer !== null) {
      clearTimeout(coldNotifyTimer);
      coldNotifyTimer = null;
    }
  };
}

/**
 * LOW-RATE playhead time (≤ one update per {@link COLD_NOTIFY_MS}). This is the replacement for
 * EditorPage's old `currentTime` React state: components that must reflect the playhead but not at
 * frame rate (inspector keyframe readouts, color scopes, audio-mixer readouts) subscribe here, so a
 * playhead move re-renders only THEM at a fraction of the tick rate — never the whole editor. Hot,
 * per-frame consumers (the preview, the timeline playhead) use {@link usePlaybackClock} instead.
 */
export function useColdPlaybackTime(): number {
  return useSyncExternalStore(subscribeCold, getPlaybackClock, getPlaybackClock);
}
