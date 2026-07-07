import { useEffect, useMemo, useState } from "react";
import { whenBackgroundIdle } from "../editor/performance/backgroundScheduler";

/**
 * Real audio-waveform peaks for timeline clips. Decodes an audio (or video) asset once via
 * the Web Audio API, downsamples it to a fixed number of normalized peaks (0..1), and caches
 * the result by URL so every clip backed by the same asset shares one decode. Used by the
 * timeline `Waveform` so audio clips show their ACTUAL waveform, not a placeholder.
 */

const PEAK_BUCKETS = 220;
// We decode each asset once to a high-resolution peak array, then cheaply resample
// it down to whatever bucket count a clip currently needs. This lets the waveform
// gain detail as the clip gets wider (zoom / horizontal resize) without re-decoding.
const HIRES_BUCKETS = 2000;

// Bounded LRU (Phase 2): hi-res peak arrays are ~16KB each and the old Map never evicted — a long
// session accumulated one per asset URL forever. `durations` is evicted in lockstep.
const MAX_CACHED_PEAKS = 100;
const cache = new Map<string, number[]>();
const inflight = new Map<string, Promise<number[] | null>>();
// Decoded asset duration (seconds), captured alongside the peaks. The hi-res peak array maps linearly onto
// [0, duration], so this lets a trimmed clip render only the slice of peaks under it.
const durations = new Map<string, number>();

/** Memory-pressure relief (degradation controller): drop cached peaks — they re-decode lazily. */
export function clearAudioPeakCaches(): void {
  cache.clear();
  durations.clear();
}

function cacheGet(url: string): number[] | undefined {
  const value = cache.get(url);
  if (value !== undefined) {
    cache.delete(url);
    cache.set(url, value);
  }
  return value;
}
function cacheSet(url: string, peaks: number[], duration: number): void {
  cache.delete(url);
  cache.set(url, peaks);
  durations.set(url, duration);
  while (cache.size > MAX_CACHED_PEAKS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
    durations.delete(oldest);
  }
}

// Shared decode context, CLOSED after an idle window (Phase 2): the old context lived (and held its
// audio thread) for the whole session even though it's only needed for the seconds a decode runs.
const CONTEXT_IDLE_CLOSE_MS = 30_000;
let sharedContext: AudioContext | null = null;
let contextCloseTimer: ReturnType<typeof setTimeout> | null = null;
function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (contextCloseTimer !== null) {
    clearTimeout(contextCloseTimer);
    contextCloseTimer = null;
  }
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedContext || sharedContext.state === "closed") sharedContext = new Ctor();
  return sharedContext;
}
function scheduleContextClose(): void {
  if (contextCloseTimer !== null) clearTimeout(contextCloseTimer);
  contextCloseTimer = setTimeout(() => {
    contextCloseTimer = null;
    if (inflight.size === 0 && sharedContext && sharedContext.state !== "closed") {
      void sharedContext.close().catch(() => undefined);
      sharedContext = null;
    }
  }, CONTEXT_IDLE_CLOSE_MS);
}

/** Downsample a decoded buffer to `buckets` peaks, taking the max abs sample per bucket. */
function bufferToPeaks(buffer: AudioBuffer, buckets: number): number[] {
  const channel = buffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(channel.length / buckets));
  const peaks: number[] = new Array(buckets).fill(0);
  let max = 0;
  for (let i = 0; i < buckets; i += 1) {
    const start = i * blockSize;
    let peak = 0;
    for (let j = 0; j < blockSize; j += 1) {
      const v = Math.abs(channel[start + j] ?? 0);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  // Normalize so the loudest peak fills the lane (with a small floor so silence still reads).
  const norm = max > 0 ? 1 / max : 1;
  return peaks.map((p) => Math.max(0.04, p * norm));
}

/** Resample a hi-res peak array down to `buckets` peaks by taking the max per segment. */
function resamplePeaks(hires: number[], buckets: number): number[] {
  if (buckets >= hires.length) return hires;
  const out: number[] = new Array(buckets).fill(0);
  const step = hires.length / buckets;
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.min(hires.length, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const v = hires[j] ?? 0;
      if (v > peak) peak = v;
    }
    out[i] = Math.max(0.04, peak);
  }
  return out;
}

/** Decode an asset once into a cached hi-res peak array (cheap to resample afterwards). */
export async function getAudioPeaks(url: string): Promise<number[] | null> {
  if (!url) return null;
  const cached = cacheGet(url);
  if (cached) return cached;
  const pending = inflight.get(url);
  if (pending) return pending;

  const task = (async () => {
    try {
      // Background-gate first (Phase 2): a whole-file fetch + decodeAudioData + the synchronous
      // bucket loop must never land during playback / a gesture / an export.
      await whenBackgroundIdle();
      const ctx = getContext();
      if (!ctx) return null;
      // no-store: Chromium can't range-cache the dev server's /storage media responses and
      // throws ERR_CACHE_OPERATION_NOT_SUPPORTED when asked to (same fix as the export decoders).
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      const peaks = bufferToPeaks(buffer, HIRES_BUCKETS);
      cacheSet(url, peaks, buffer.duration);
      return peaks;
    } catch {
      return null; // CORS / decode failure → caller falls back to a placeholder
    } finally {
      inflight.delete(url);
      if (inflight.size === 0) scheduleContextClose();
    }
  })();
  inflight.set(url, task);
  return task;
}

/**
 * React hook: returns the asset's peaks resampled to `buckets`, or `null` while
 * loading/unavailable. The underlying asset is decoded once at high resolution and
 * cached; changing `buckets` only re-resamples (no re-decode), so a wider clip can
 * ask for more bars and gain detail instantly.
 */
export function useAudioPeaks(url: string | undefined, buckets = PEAK_BUCKETS): number[] | null {
  const [hires, setHires] = useState<number[] | null>(() => (url ? cacheGet(url) ?? null : null));
  useEffect(() => {
    if (!url) {
      setHires(null);
      return;
    }
    const cached = cacheGet(url);
    if (cached) {
      setHires(cached);
      return;
    }
    let active = true;
    void getAudioPeaks(url).then((result) => {
      if (active) setHires(result);
    });
    return () => {
      active = false;
    };
  }, [url]);
  return useMemo(() => (hires ? resamplePeaks(hires, buckets) : null), [hires, buckets]);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Slice a hi-res peak array to the `[startFrac, endFrac]` portion, then resample to `buckets`. */
function slicePeaks(hires: number[], startFrac: number, endFrac: number, buckets: number): number[] {
  const start = Math.floor(startFrac * hires.length);
  const end = Math.max(start + 1, Math.ceil(endFrac * hires.length));
  const slice = hires.slice(start, Math.min(hires.length, end));
  return slice.length ? resamplePeaks(slice, buckets) : resamplePeaks(hires, buckets);
}

/**
 * React hook: the peaks for just the **trimmed window** of a clip — the portion of the asset between
 * `sourceInSeconds` and `sourceInSeconds + durationSeconds`, resampled to `buckets`. The hi-res peaks map
 * linearly onto the decoded duration, so trimming/slipping a clip shows exactly the waveform under it (beats
 * line up). Falls back to the whole array until the decoded duration is known (or on decode failure).
 */
export function useAudioPeaksSlice(
  url: string | undefined,
  sourceInSeconds: number,
  durationSeconds: number,
  buckets = PEAK_BUCKETS
): number[] | null {
  const [hires, setHires] = useState<number[] | null>(() => (url ? cacheGet(url) ?? null : null));
  useEffect(() => {
    if (!url) {
      setHires(null);
      return;
    }
    const cached = cacheGet(url);
    if (cached) {
      setHires(cached);
      return;
    }
    let active = true;
    void getAudioPeaks(url).then((result) => {
      if (active) setHires(result);
    });
    return () => {
      active = false;
    };
  }, [url]);

  return useMemo(() => {
    if (!hires) return null;
    const duration = url ? durations.get(url) : undefined;
    if (!duration || duration <= 0 || durationSeconds <= 0) return resamplePeaks(hires, buckets);
    const startFrac = clamp01(sourceInSeconds / duration);
    const endFrac = clamp01((sourceInSeconds + durationSeconds) / duration);
    if (endFrac <= startFrac) return resamplePeaks(hires, buckets);
    return slicePeaks(hires, startFrac, endFrac, buckets);
  }, [hires, url, sourceInSeconds, durationSeconds, buckets]);
}
