/**
 * ADR-020 slice F — ONE definition of "a starved source may re-ask now", consumed by every acquire site.
 *
 * ## Why this is a module and not a second copy of the effect
 *
 * Slice D shipped its boundary detector inside `WebglMediaLayer`. Slice E then made permissions
 * available, and D still reported `attempts 0` — attribution showed **`0/5 starved sources are layers
 * the D trigger can see`**: every starved source came from the pool's OTHER acquire site,
 * `useFlarexCompProxies`, which had no trigger at all.
 *
 * The obvious repair is to add a detector there too, and it is the wrong one. Two triggers deciding
 * "is this a boundary" independently is exactly the drift that `freeCapacityFor` was extracted to
 * remove one slice earlier: one site would treat a 0.4s scrub as a boundary and the other would not,
 * and no reading would say which was right. So the PREDICATE lives here, once.
 *
 * What stays per-site is only what genuinely differs: **which keys a site owns**. A layer owns one
 * `src`; the comp-proxy site owns a set of keys and mints a fresh blob URL per attempt. That is real
 * variation, not duplicated policy.
 *
 * ## Why the clock and not each site's own time
 *
 * The two sites observe transport differently — a layer re-renders on `props.currentTime`, the
 * comp-proxy hook does not re-render on transport at all, which is the second reason its trigger could
 * not simply be copied. Driving both from `subscribePlaybackClock` gives them the same events from the
 * same source, so "when is a boundary" cannot diverge either.
 */
import { useEffect, useRef } from "react";
import { getLivePlaybackTime, subscribePlaybackClock } from "./playback-clock";

/**
 * A transport step larger than this is a SEEK, not playback advancing.
 *
 * Sized well above a frame at any rate this editor plays (a 24fps frame is ~0.042s) and well below any
 * deliberate jump, so ordinary playback never reads as a boundary. Wrong in one direction only: too
 * large merely misses re-acquire opportunities, while too small would let a starved source re-acquire
 * mid-playback, which C-D2 forbids because that teardown is a visible hitch on a working source.
 */
export const SEEK_DISCONTINUITY_S = 0.5;

/**
 * Is moving from `previous` to `next` a moment at which a starved source may re-acquire?
 *
 * Pure, exported, and unit-checkable — the whole point of the extraction. While PAUSED any transport
 * change qualifies (nothing is being decoded continuously, so a rebuild costs nothing visible); while
 * PLAYING only a discontinuity does, because at a seek the decode break is already happening and
 * already invisible.
 */
export function isTransportBoundary(previous: number | null, next: number, playing: boolean): boolean {
  if (!playing) return true;
  return previous !== null && Math.abs(next - previous) > SEEK_DISCONTINUITY_S;
}

/**
 * Call `onBoundary` at each transport boundary. Both acquire sites use this and then consult the pool
 * about their OWN keys.
 *
 * ## A CALLBACK, not a state counter — and the soak is why
 *
 * The first version returned an incrementing epoch from `useState`. That re-renders every consumer on
 * every boundary, and both consumers are hot: a media layer per clip, and the hook that owns comp-proxy
 * reconciliation. The decoder soak moved immediately and reproducibly — `created 11 → 14`,
 * `unmet 1 → 3` — against a change that was supposed to be inert until a source is actually permitted
 * to re-ask. Bisecting the retry BODY changed nothing, because the cost was never in the body; it was
 * in the subscription's re-render.
 *
 * So the boundary is delivered as a call. Nothing re-renders unless a consumer decides it really is
 * going to re-ask, which is rare by construction — the pool must have granted that key a permission
 * first. A trigger whose observation cost scales with boundaries rather than with re-asks is the same
 * R1 mistake the release path was written to avoid.
 *
 * The pause EDGE is a boundary in its own right and arrives as a change of `playing` rather than of
 * time, so it is delivered separately — a source starved at the moment the user pauses would otherwise
 * wait for the next seek.
 */
export function useTransportBoundary(playing: boolean, onBoundary: () => void): void {
  const lastTimeRef = useRef<number | null>(null);
  // Both read inside a subscription registered ONCE, which must not close over stale values.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const callbackRef = useRef(onBoundary);
  callbackRef.current = onBoundary;

  useEffect(() => {
    // Transitions of `playing` in BOTH directions: stopping is the pause boundary, and starting is the
    // moment a source that lost the mount-storm lottery is about to matter again.
    callbackRef.current();
  }, [playing]);

  useEffect(
    () =>
      subscribePlaybackClock(() => {
        const now = getLivePlaybackTime();
        const previous = lastTimeRef.current;
        lastTimeRef.current = now;
        if (isTransportBoundary(previous, now, playingRef.current)) callbackRef.current();
      }),
    []
  );
}
