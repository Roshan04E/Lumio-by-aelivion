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

/** Push a new playhead time and notify subscribers. Called from the playback rAF loop and on seek. */
export function setPlaybackClock(time: number): void {
  if (time === clockTime) {
    return;
  }
  clockTime = time;
  for (const listener of listeners) {
    listener();
  }
}

/** Read the current playhead time imperatively (e.g. to flush the exact time on stop). */
export function getPlaybackClock(): number {
  return clockTime;
}

function subscribe(listener: () => void): () => void {
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
