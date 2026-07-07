/**
 * Playback frame telemetry (P0 instrumentation — see the 2026-07-02 NLE gap analysis).
 *
 * Measures REAL playback smoothness from inside the scene compositor's rAF loop: the interval between
 * consecutive composited playback frames (the honest "did we hold 60/30fps" signal) and the CPU cost of
 * each composite (`drawMs`). Consumers: the viewer Stats HUD (`PreviewStatsOverlay`) and the adaptive
 * quality controller (`adaptive-quality.ts`), which steps the playback render scale down/up from this.
 *
 * Hot-path contract: `recordPlaybackFrame` is called once per composited frame while playing. It is
 * allocation-free (preallocated ring buffers, plain arithmetic) so it can never introduce jank of its
 * own, and subscriber notification is throttled to `NOTIFY_INTERVAL_MS` so React consumers re-render a
 * couple of times per second, never per frame. Debug snapshot: `window.__rfFrameStats`.
 */

const RING_SIZE = 180; // ~3s of samples at 60fps
const NOTIFY_INTERVAL_MS = 500;
// A frame interval above this misses the 30fps floor badly enough to read as a visible hitch at 60Hz.
const DROPPED_FRAME_MS = 28;
const SEVERE_FRAME_MS = 50;

export interface FrameStatsSnapshot {
  /** Frames per second over the sample window (0 when idle / no samples). */
  fps: number;
  /** Mean interval between composited playback frames (ms). */
  avgFrameMs: number;
  /** Mean CPU time of the scene composite call (ms). */
  avgDrawMs: number;
  /** Worst frame interval in the window (ms). */
  maxFrameMs: number;
  /** Fraction of window frames slower than {@link DROPPED_FRAME_MS}. */
  droppedRatio: number;
  /** Frames in the window slower than {@link SEVERE_FRAME_MS}. */
  severeCount: number;
  /** Samples currently in the window. */
  sampleCount: number;
  /** Effective playback render scale currently applied by the viewer (1 / 0.5 / 0.25). */
  renderScale: number;
  /** True while the editor is playing (stats only accumulate during playback). */
  playing: boolean;
}

const EMPTY_SNAPSHOT: FrameStatsSnapshot = {
  fps: 0,
  avgFrameMs: 0,
  avgDrawMs: 0,
  maxFrameMs: 0,
  droppedRatio: 0,
  severeCount: 0,
  sampleCount: 0,
  renderScale: 1,
  playing: false,
};

const intervals = new Float64Array(RING_SIZE);
const draws = new Float64Array(RING_SIZE);
let head = 0;
let count = 0;
let playing = false;
let renderScale = 1;
let lastNotifyAt = 0;
let snapshot: FrameStatsSnapshot = EMPTY_SNAPSHOT;
let snapshotDirty = false;

const listeners = new Set<() => void>();

function computeSnapshot(): FrameStatsSnapshot {
  if (count === 0) {
    return { ...EMPTY_SNAPSHOT, renderScale, playing };
  }
  let sumInterval = 0;
  let sumDraw = 0;
  let maxInterval = 0;
  let dropped = 0;
  let severe = 0;
  for (let i = 0; i < count; i++) {
    const interval = intervals[i]!;
    sumInterval += interval;
    sumDraw += draws[i]!;
    if (interval > maxInterval) maxInterval = interval;
    if (interval > DROPPED_FRAME_MS) dropped += 1;
    if (interval > SEVERE_FRAME_MS) severe += 1;
  }
  const avgFrameMs = sumInterval / count;
  return {
    fps: avgFrameMs > 0 ? 1000 / avgFrameMs : 0,
    avgFrameMs,
    avgDrawMs: sumDraw / count,
    maxFrameMs: maxInterval,
    droppedRatio: dropped / count,
    severeCount: severe,
    sampleCount: count,
    renderScale,
    playing,
  };
}

function notifyThrottled(now: number) {
  if (now - lastNotifyAt < NOTIFY_INTERVAL_MS) return;
  lastNotifyAt = now;
  snapshotDirty = true;
  for (const listener of listeners) listener();
}

/**
 * Record one composited playback frame. `intervalMs` is the time since the PREVIOUS playback frame
 * (caller resets its baseline across pauses/suspends so pause gaps are never counted); `drawMs` is the
 * CPU cost of the composite. Allocation-free; safe to call at rAF rate.
 */
export function recordPlaybackFrame(intervalMs: number, drawMs: number): void {
  // Ignore nonsense samples (tab was backgrounded, clock jumped). 1s+ gaps are not "frames".
  if (!(intervalMs > 0) || intervalMs > 1000) return;
  intervals[head] = intervalMs;
  draws[head] = drawMs;
  head = (head + 1) % RING_SIZE;
  if (count < RING_SIZE) count += 1;
  notifyThrottled(typeof performance !== "undefined" ? performance.now() : Date.now());
}

/** Playback started/stopped. Starting clears the window so stale samples never drive decisions. */
export function notePlaybackActive(active: boolean): void {
  if (playing === active) return;
  playing = active;
  if (active) {
    head = 0;
    count = 0;
  }
  snapshotDirty = true;
  for (const listener of listeners) listener();
}

/** The viewer reports the render scale it is actually applying (display-only context for the HUD). */
export function noteRenderScale(scale: number): void {
  if (renderScale === scale) return;
  renderScale = scale;
  snapshotDirty = true;
}

export function getFrameStatsSnapshot(): FrameStatsSnapshot {
  if (snapshotDirty) {
    snapshot = computeSnapshot();
    snapshotDirty = false;
  }
  return snapshot;
}

export function subscribeFrameStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Always-on debug handle, matching the repo's __rf* telemetry convention (`__rfGlContextBudget` etc.).
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__rfFrameStats", {
    configurable: true,
    get: () => computeSnapshot(),
  });
}
