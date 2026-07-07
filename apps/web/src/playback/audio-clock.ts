/**
 * Audio-master playback clock (P0 — see the 2026-07-02 NLE gap analysis).
 *
 * The editor's playback clock was pure wall-time (`playbackStart` anchor + rAF), while every audible
 * `<audio>` element free-ran with NO drift correction during playback — so audio start latency, a
 * decode stall, or main-thread jank became a persistent A/V offset. Professional NLEs do the
 * opposite: the audio device clock is the MASTER and the picture follows it.
 *
 * Design (deliberately gentle — the playhead must stay smooth):
 *  - Every playing `AudioPreviewLayer` registers a reader that maps its element's `currentTime` back
 *    to timeline time. The MASTER is the valid reader whose clip started earliest (deterministic,
 *    stable across ties by layer id).
 *  - The playback tick (`EditorPage`) measures drift = masterTime − wallTime and SERVOs the shared
 *    `playbackStart` anchor toward it: ≤ {@link MAX_SERVO_PER_TICK_S} per tick (sub-frame, invisible)
 *    for small drift, one hard re-anchor for large drift (> {@link HARD_RESYNC_S} — a real stall).
 *    Because the timeline playhead, transport, preview and proxy layers ALL derive from that same
 *    anchor, the whole UI follows audio in lockstep; and since audio also runs in real time, the
 *    proxy `<video>` alignment rationale for the wall clock still holds.
 *  - NON-master audio layers drift-correct against the clock every ~500ms while playing (they had no
 *    playback correction at all before); the master is never corrected — it *defines* time.
 *  - No audible clip → pure wall clock, exactly as before.
 *
 * Kill switch (repo convention): `?audioClock=0` → localStorage `lumio.audioClock` →
 * `VITE_AUDIO_CLOCK` → ON. Telemetry: `window.__rfAudioClock` + the Stats HUD "A/V drift" row.
 */

export const HARD_RESYNC_S = 0.25;
export const MAX_SERVO_PER_TICK_S = 0.004;
/** Convergence rate: fraction of the measured drift applied per tick (bounded by MAX_SERVO_PER_TICK_S). */
export const SERVO_GAIN = 0.12;
/**
 * Authority gate: an element whose mapped time is further than this from the CURRENT clock is not
 * a valid master (it's cold-starting — play() latency, first-decode — or badly stalled). Without
 * this, a late-starting element got elected ~1s into playback and the hard resync yanked the whole
 * clock BACKWARD by its start latency: picture played, jumped back, replayed ("looks hung", user
 * report 2026-07-03). Gated out, the clock stays wall-time and the 500ms non-master drift
 * corrector seeks the element FORWARD onto the clock instead — it then becomes master smoothly.
 * Must be > HARD_RESYNC_S so genuine mid-play stalls inside the gate still hard-resync.
 */
export const AUDIO_MASTER_GATE_S = 0.5;

export interface AudioClockReader {
  layerId: string;
  startSeconds: number;
  /** Timeline seconds derived from the element's currentTime, or null when not authoritative
   *  (paused/seeking/ended/underbuffered). */
  read(): number | null;
}

/** Resolution order: `?audioClock=0|1` → localStorage `lumio.audioClock` → `VITE_AUDIO_CLOCK` → true. */
export function getAudioClockEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("audioClock")) {
        return truthy(new URLSearchParams(window.location.search).get("audioClock"));
      }
      const stored = window.localStorage?.getItem("lumio.audioClock");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AUDIO_CLOCK;
  return env == null ? true : truthy(env);
}

const readers = new Map<string, AudioClockReader>();
let masterId: string | null = null;
let lastDriftMs: number | null = null;

export function registerAudioClockSource(reader: AudioClockReader): () => void {
  readers.set(reader.layerId, reader);
  return () => {
    readers.delete(reader.layerId);
    if (masterId === reader.layerId) masterId = null;
  };
}

/**
 * Timeline time according to the master audio element, or null when no audible clip is playing.
 * Master selection is sticky (no churn between overlapping clips) and deterministic on re-election.
 */
export function getAudioMasterTime(): number | null {
  if (readers.size === 0) {
    masterId = null;
    return null;
  }
  if (masterId != null) {
    const current = readers.get(masterId);
    const time = current?.read();
    if (time != null) return time;
    masterId = null; // master went invalid (clip ended / stalled) — fall through to re-elect
  }
  let best: { reader: AudioClockReader; time: number } | null = null;
  for (const reader of readers.values()) {
    const time = reader.read();
    if (time == null) continue;
    if (
      !best ||
      reader.startSeconds < best.reader.startSeconds ||
      (reader.startSeconds === best.reader.startSeconds && reader.layerId < best.reader.layerId)
    ) {
      best = { reader, time };
    }
  }
  if (!best) return null;
  masterId = best.reader.layerId;
  return best.time;
}

/** True when this layer's element currently defines playback time (it must never be drift-corrected). */
export function isAudioClockMaster(layerId: string): boolean {
  return masterId === layerId;
}

/** The playback tick reports the measured drift for the HUD/telemetry; null = wall clock (no master). */
export function noteAudioClockDrift(driftMs: number | null): void {
  lastDriftMs = driftMs;
}

export function getAudioClockDriftMs(): number | null {
  return lastDriftMs;
}

// Debug handle, matching the repo's __rf* telemetry convention.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__rfAudioClock", {
    configurable: true,
    get: () => ({ enabled: getAudioClockEnabled(), masterId, driftMs: lastDriftMs, sources: readers.size }),
  });
}
