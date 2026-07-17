/**
 * Safe HTMLMediaElement.playbackRate writes.
 *
 * Chrome's supported playbackRate range is [0.0625, 16] — assigning outside it THROWS
 * NotSupportedError (it does not clamp). Our editing speed range dips below that floor
 * (MIN_LAYER_SPEED = 0.05), and the speed-ramp follow effects write the rate on EVERY clock tick,
 * so one 5%-speed ramp point turned into an uncaught-exception storm on a playing element — the
 * "speed ramp hangs the browser" report (project-tracker/playback-preview.md v16).
 *
 * Clamping is display-only: the element free-runs marginally fast at 5% speed (0.0625 vs 0.05),
 * and the throttled seek corrector (which uses the exact shared timeline→source mapping) pulls the
 * frame back on its next checkpoint. A hair of drift between checkpoints beats a hung tab.
 */

const BROWSER_MIN_PLAYBACK_RATE = 0.0625;
const BROWSER_MAX_PLAYBACK_RATE = 16;

export function setMediaPlaybackRate(media: HTMLMediaElement, rate: number): void {
  const sane = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const clamped = Math.min(BROWSER_MAX_PLAYBACK_RATE, Math.max(BROWSER_MIN_PLAYBACK_RATE, sane));
  if (media.playbackRate === clamped) return; // skip no-op writes — some engines treat every set as a state poke
  try {
    media.playbackRate = clamped;
  } catch {
    // Engines with a narrower supported range than Chrome's: keep the old rate; the seek
    // corrector still tracks the exact mapping.
  }
}
