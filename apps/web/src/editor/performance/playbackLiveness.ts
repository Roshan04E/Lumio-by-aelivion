/**
 * IS PLAYBACK ACTUALLY DELIVERING, OR ONLY RUNNING? (DEBT-033, 2026-09-04)
 *
 * THE TRAP THIS EXISTS TO BREAK. Deferrable work — above all ingest-proxy builds — is suspended while
 * the transport plays, because a transcode running against live playback starved the decode path (the
 * "plays ~4s then freezes" report, 2026-07-06). That rule is right and stays. But it is stated in terms
 * of `isPlaying`, which is a claim about the TRANSPORT, not about whether anything reaches the screen.
 *
 * On a cold 4K timeline the preview is frozen 100% of the time (measured: canvas unchanged across 23
 * samples spanning 18.1s of advancing clock, DEBT-033 update (c)). In that state pressing play suspends
 * the proxy builds that are the ONLY thing that will end the freeze — so the user's instinct, press play
 * again and scrub around, extends the exact window causing the problem. We were protecting smooth
 * playback that was not occurring.
 *
 * WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT. It reports one narrow fact: playback is
 * running and provably delivering NOTHING. It does not decide policy; the gate's owner does. The signal
 * is `minMediaFps` — the per-layer MINIMUM shipped earlier in this chapter, which read 0.0 in every
 * frozen arm while `fps` (the compositor's repaint rate) read 56-67 over a picture that had not moved.
 *
 * WHY THE CONDITIONS ARE THIS CONSERVATIVE — each one exists to avoid resurrecting the 2026-07-06 bug:
 *   - `activeMediaLayers > 0`: a still/text-only comp delivers no video frames BY DESIGN. Zero layers
 *     is not a stall, and treating it as one would let builds run against a perfectly healthy preview.
 *   - `minMediaFps === 0`, not "low": degraded-but-delivering playback is exactly what the suspension
 *     rule protects. Only total absence counts.
 *   - sustained for {@link STALL_CONFIRM_MS}: startup, a seek, and a source swap all produce brief
 *     gaps. A rule that fires on those would suspend nothing and protect nothing.
 *   - recovery at the FIRST delivered frame ({@link RECOVERY_FPS}), with no dwell: the moment playback
 *     is alive again the protection must be back, because that is the state the scar is about. Slow to
 *     conclude dead, instant to concede alive.
 */

import { getFrameStatsSnapshot, subscribeFrameStats } from "./frame-stats";

/** How long total non-delivery must persist before it counts as a stall rather than a gap. */
const STALL_CONFIRM_MS = 3_000;
/** Any real delivery at or above this ends the stall immediately. */
const RECOVERY_FPS = 1;

let stalled = false;
let zeroSince = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

function evaluate(): void {
  const stats = getFrameStatsSnapshot();
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();

  // Not playing, or nothing that COULD deliver video: never a stall. Reset so a later playback starts
  // its confirmation window fresh rather than inheriting an old one.
  if (!stats.playing || stats.activeMediaLayers === 0 || stats.minMediaFps == null) {
    zeroSince = 0;
    if (stalled) {
      stalled = false;
      notify();
    }
    return;
  }

  if (stats.minMediaFps >= RECOVERY_FPS) {
    zeroSince = 0;
    if (stalled) {
      stalled = false;
      notify(); // alive again — concede immediately, the scar is about this direction
    }
    return;
  }

  if (zeroSince === 0) zeroSince = now;
  if (!stalled && now - zeroSince >= STALL_CONFIRM_MS) {
    stalled = true;
    notify();
  }
}

let started = false;
/** Idempotent. Subscribes to the frame-stats store (throttled to ~2Hz), so this costs nothing per frame. */
export function startPlaybackLivenessWatch(): () => void {
  if (started) return () => undefined;
  started = true;
  const unsubscribe = subscribeFrameStats(evaluate);
  return () => {
    unsubscribe();
    started = false;
    stalled = false;
    zeroSince = 0;
  };
}

/**
 * TRUE only while the transport is playing, at least one video layer is mounted, and NOT ONE of them
 * has delivered a frame for {@link STALL_CONFIRM_MS}. False in every other state, including
 * degraded-but-delivering playback.
 */
export function isPlaybackStalled(): boolean {
  return stalled;
}

export function subscribePlaybackLiveness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "__rfPlaybackStalled", {
    configurable: true,
    get: () => ({ stalled, zeroSince })
  });
}
