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
  /**
   * NEW video frames presented per second (requestVideoFrameCallback count across playing video
   * layers) — the MOTION-delivery rate, distinct from `fps` (the compositor's repaint rate, which
   * runs at display refresh and happily redraws an unchanged video frame). A 30fps proxy under a
   * 75Hz compositor reads fps≈75, mediaFps≈30 — exactly the gap the 2026-07-19 "½ quality feels
   * low-fps" report lived in. 0 when no video layer is playing (stills/text-only comps).
   *
   * SUMS across layers — kept for compatibility with existing readers, but this is NOT a health
   * signal on its own: a 6-layer comp where 3 layers deliver 25fps and 3 are stalled at 0 sums to
   * the same 75 as 6 layers evenly delivering 12.5fps, and the two are very different pictures. See
   * `minMediaFps`.
   */
  mediaFps: number;
  /**
   * The WORST per-layer media delivery rate currently playing, in fps — 0 if any playing video
   * layer has gone silent (its own `requestVideoFrameCallback` has not ticked within
   * {@link MEDIA_STALL_MS}), regardless of how well the others are doing. This is the number that
   * would have caught the 2026-08-17 clean-room finding: FPS 62 (compositor repaint, healthy) over a
   * frozen picture, because `mediaFps` summed 75 across 6 layers while several sat stalled. Null when
   * no video layer is currently playing (nothing to take a minimum of — distinct from a real 0).
   */
  minMediaFps: number | null;
  /** How many distinct video layers are contributing to `minMediaFps` right now. */
  activeMediaLayers: number;
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
  mediaFps: 0,
  minMediaFps: null,
  activeMediaLayers: 0,
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
// Media-frame rate: a bare counter bumped by recordMediaFrame (allocation-free hot path); the rate
// is computed lazily over the elapsed window whenever a snapshot is built.
let mediaFrameCount = 0;
let mediaWindowStartAt = 0;
let lastMediaFps = 0;

/**
 * Per-layer media delivery, keyed by the caller's own stable identity (one `WebglMediaLayer` mount =
 * one key, for its whole life — see that file's `useId()`-based key). A `Map`, not a ring buffer: the
 * set of playing layers changes shape constantly (mount/unmount/pause), unlike the fixed-size
 * playback-frame window above.
 */
interface MediaLayerEntry {
  count: number;
  windowStart: number;
  rate: number;
  lastFrameAt: number;
}
const mediaLayerStats = new Map<string, MediaLayerEntry>();
/** A layer that stops ticking without releasing its key (a real stall, not an unmount) reports 0
 *  once this long has passed since its last frame — matching the ~1s window this file already uses
 *  for the aggregate rate, so "stalled" and "just between window refreshes" are not conflated. */
const MEDIA_STALL_MS = 1000;

const listeners = new Set<() => void>();

function currentMediaFps(now: number): number {
  const elapsed = now - mediaWindowStartAt;
  // Refresh the published rate once enough window has accumulated; between refreshes the last
  // published value holds (rates over tiny windows are noise, not signal).
  if (elapsed >= 900) {
    lastMediaFps = mediaWindowStartAt === 0 ? 0 : (mediaFrameCount * 1000) / elapsed;
    mediaFrameCount = 0;
    mediaWindowStartAt = now;
  }
  return lastMediaFps;
}

/** Refreshes every tracked layer's own rate on the same ~900ms cadence as the aggregate, applies the
 *  stall rule, and returns the worst one — the number `minMediaFps` publishes. */
function currentMinMediaFps(now: number): { min: number | null; activeLayers: number } {
  if (mediaLayerStats.size === 0) return { min: null, activeLayers: 0 };
  let min = Infinity;
  for (const entry of mediaLayerStats.values()) {
    const elapsed = now - entry.windowStart;
    if (elapsed >= 900) {
      entry.rate = entry.windowStart === 0 ? 0 : (entry.count * 1000) / elapsed;
      entry.count = 0;
      entry.windowStart = now;
    }
    const stalled = now - entry.lastFrameAt > MEDIA_STALL_MS;
    const rate = stalled ? 0 : entry.rate;
    if (rate < min) min = rate;
  }
  return { min, activeLayers: mediaLayerStats.size };
}

function computeSnapshot(): FrameStatsSnapshot {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { min: minMediaFps, activeLayers: activeMediaLayers } = currentMinMediaFps(now);
  if (count === 0) {
    return { ...EMPTY_SNAPSHOT, renderScale, playing, mediaFps: currentMediaFps(now), minMediaFps, activeMediaLayers };
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
    mediaFps: currentMediaFps(now),
    minMediaFps,
    activeMediaLayers,
  };
}

/**
 * Record one NEW video frame presented by a playing video layer (requestVideoFrameCallback tick).
 * `key` is the caller's own stable per-mount identity (one `WebglMediaLayer` instance = one key for
 * its whole life) — it is what makes `minMediaFps` possible; the aggregate `mediaFps` this also
 * feeds is a plain sum and does not need it, but every call site now has a key anyway so there is no
 * reason to keep a keyless path. Allocation-free on the hot (already-registered) branch.
 */
export function recordMediaFrame(key: string): void {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (mediaWindowStartAt === 0) mediaWindowStartAt = now;
  mediaFrameCount += 1;

  let entry = mediaLayerStats.get(key);
  if (!entry) {
    entry = { count: 0, windowStart: now, rate: 0, lastFrameAt: now };
    mediaLayerStats.set(key, entry);
  }
  entry.count += 1;
  entry.lastFrameAt = now;
}

/** A layer stopped playing (paused, unmounted, source changed) — remove it from the minimum rather
 *  than letting it decay to a false "stalled" 0 it never earned. Idempotent. */
export function releaseMediaFrameKey(key: string): void {
  mediaLayerStats.delete(key);
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
