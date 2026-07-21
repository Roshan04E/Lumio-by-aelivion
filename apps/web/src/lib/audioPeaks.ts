import { useEffect, useMemo, useState } from "react";
import { whenBackgroundIdle } from "../editor/performance/backgroundScheduler";
import { bufferToPeaks, buildPyramid, hiresBucketCount, resampleOne } from "./waveform/peakDsp";
import type { HiresPeaks, WaveformPeaks } from "./waveform/peakDsp";
import type { PeaksWorkerRequest, PeaksWorkerResponse } from "./waveform/peaksWorkerProtocol";

/**
 * Real audio-waveform peaks for timeline clips. Decodes an audio (or video) asset once — off the
 * main thread via `peaks.worker.ts` when available, falling back to an in-page decode otherwise —
 * into a multi-resolution LOD pyramid, and caches the result by URL so every clip backed by the
 * same asset shares one decode. Used by the timeline `Waveform` so audio clips show their ACTUAL
 * waveform, not a placeholder.
 *
 * The DSP itself (peak+RMS extraction, normalization, dB display-compression, silence gate, LOD
 * pyramid construction) lives in `./waveform/peakDsp.ts` so the worker and the main-thread
 * fallback share one implementation. See WAVEFORM_QA.md — the display math here is frozen
 * (Phase 1); this module only changes WHERE/HOW it's computed and cached (Phase 2).
 */

export type { WaveformPeaks, HiresPeaks } from "./waveform/peakDsp";

/** A source's full LOD pyramid (finest → coarsest) plus its decoded duration. */
export type Pyramid = { levels: HiresPeaks[]; duration: number };

const PEAK_BUCKETS = 220;

// Bounded LRU: pyramids are larger and variable-sized, so we evict by a BYTE budget (summed
// across all levels of a pyramid) rather than a fixed entry count.
const MAX_CACHE_BYTES = 96 * 1024 * 1024; // ~96MB; holds hundreds of songs / dozens of long sources
const cache = new Map<string, Pyramid>();
const inflight = new Map<string, Promise<Pyramid | null>>();
let cacheBytes = 0;

const pyramidBytes = (pyramid: Pyramid): number =>
  pyramid.levels.reduce((sum, level) => sum + level.max.byteLength + level.min.byteLength + level.rms.byteLength, 0);

/** Memory-pressure relief (degradation controller): drop cached peaks — they re-decode lazily. */
export function clearAudioPeakCaches(): void {
  cache.clear();
  cacheBytes = 0;
}

function cacheGet(url: string): Pyramid | undefined {
  const value = cache.get(url);
  if (value !== undefined) {
    cache.delete(url);
    cache.set(url, value);
  }
  return value;
}
function cacheSet(url: string, pyramid: Pyramid): void {
  const existing = cache.get(url);
  if (existing) cacheBytes -= pyramidBytes(existing);
  cache.delete(url);
  cache.set(url, pyramid);
  cacheBytes += pyramidBytes(pyramid);
  // Keep at least the just-inserted entry (a single pyramid is always well under budget).
  while (cacheBytes > MAX_CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest);
    if (evicted) cacheBytes -= pyramidBytes(evicted);
    cache.delete(oldest);
  }
}

// Shared decode context (main-thread fallback only), CLOSED after an idle window: the old context
// lived (and held its audio thread) for the whole session even though it's only needed for the
// seconds a decode runs.
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

/** Decode + build the LOD pyramid off the main thread. Rejects on any failure (worker missing,
 * crash, or `OfflineAudioContext` unsupported there) so the caller can fall back. */
function decodeInWorker(url: string): Promise<Pyramid> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./waveform/peaks.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const cleanup = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<PeaksWorkerResponse>) => {
      const message = event.data;
      if (message.type === "done") {
        cleanup();
        resolve({
          duration: message.duration,
          levels: message.levels.map((level) => ({
            max: new Float32Array(level.max),
            min: new Float32Array(level.min),
            rms: new Float32Array(level.rms)
          }))
        });
      } else {
        cleanup();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "peaks-worker-crashed"));
    };
    worker.postMessage({ type: "start", url } satisfies PeaksWorkerRequest);
  });
}

/** Fallback: decode + build the pyramid on the main thread (used when the worker path fails). */
async function decodeOnMain(url: string): Promise<Pyramid | null> {
  const ctx = getContext();
  if (!ctx) return null;
  // no-store: Chromium can't range-cache the dev server's /storage media responses and throws
  // ERR_CACHE_OPERATION_NOT_SUPPORTED when asked to (same fix as the export decoders).
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.arrayBuffer();
  const buffer = await ctx.decodeAudioData(data);
  const base = bufferToPeaks(buffer, hiresBucketCount(buffer.duration));
  return { duration: buffer.duration, levels: buildPyramid(base) };
}

// --- Durable peak persistence (IndexedDB) -----------------------------------
// The pyramid cache used to be memory-only: every refresh re-decoded the whole source, and a
// memory-pressure clearAudioPeakCaches() made already-mounted clips lose their waveform for the
// rest of the session (nothing re-triggered a decode). Persist the FINEST level per STABLE key —
// the asset id, because blob: object URLs change every session — and rebuild the LOD pyramid on
// read (pure math, far cheaper than a re-decode).
const PEAKS_DB = "orreris-waveform-peaks";
const PEAKS_STORE = "pyramids";
let peaksDbPromise: Promise<IDBDatabase | null> | null = null;

function openPeaksDb(): Promise<IDBDatabase | null> {
  if (peaksDbPromise) return peaksDbPromise;
  peaksDbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(PEAKS_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PEAKS_STORE)) {
          request.result.createObjectStore(PEAKS_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return peaksDbPromise;
}

type StoredPeaks = { duration: number; max: ArrayBuffer; min: ArrayBuffer; rms: ArrayBuffer };

async function loadPersistedPyramid(key: string): Promise<Pyramid | null> {
  const db = await openPeaksDb();
  if (!db) return null;
  try {
    const stored = await new Promise<StoredPeaks | undefined>((resolve, reject) => {
      const request = db.transaction(PEAKS_STORE, "readonly").objectStore(PEAKS_STORE).get(key);
      request.onsuccess = () => resolve(request.result as StoredPeaks | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!stored || !(stored.duration > 0)) return null;
    const base: HiresPeaks = {
      max: new Float32Array(stored.max),
      min: new Float32Array(stored.min),
      rms: new Float32Array(stored.rms)
    };
    if (base.max.length === 0) return null;
    return { duration: stored.duration, levels: buildPyramid(base) };
  } catch {
    return null;
  }
}

function persistPyramid(key: string, pyramid: Pyramid): void {
  void (async () => {
    const db = await openPeaksDb();
    const base = pyramid.levels[0];
    if (!db || !base) return;
    try {
      const payload: StoredPeaks = {
        duration: pyramid.duration,
        max: base.max.slice().buffer,
        min: base.min.slice().buffer,
        rms: base.rms.slice().buffer
      };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PEAKS_STORE, "readwrite");
        tx.objectStore(PEAKS_STORE).put(payload, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* best-effort — the in-memory cache still has it */
    }
  })();
}

/** Remove a persisted waveform (call when an asset's bytes are deleted/replaced). */
export async function removePersistedPeaks(key: string): Promise<void> {
  const db = await openPeaksDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PEAKS_STORE, "readwrite");
      tx.objectStore(PEAKS_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

/**
 * Decode an asset once into a cached LOD pyramid (cheap to resample afterwards).
 * `persistKey` (the asset id — stable across sessions, unlike blob: URLs) additionally
 * round-trips the peaks through IndexedDB so refresh/eviction never costs a re-decode.
 */
export async function getAudioPeaks(url: string, persistKey?: string): Promise<Pyramid | null> {
  if (!url) return null;
  const cached = cacheGet(url);
  if (cached) return cached;
  const pending = inflight.get(url);
  if (pending) return pending;

  const task = (async () => {
    try {
      // Durable hit first: rebuilding the pyramid from persisted peaks skips fetch+decode entirely.
      if (persistKey) {
        const persisted = await loadPersistedPyramid(persistKey);
        if (persisted) {
          cacheSet(url, persisted);
          return persisted;
        }
      }
      // Background-gate first: a whole-file fetch + decode + bucket loop must never land during
      // playback / a gesture / an export. The worker path still runs off-thread, but gating the
      // START keeps network/decode load off the critical moments too.
      await whenBackgroundIdle();
      let pyramid: Pyramid | null;
      try {
        pyramid = await decodeInWorker(url);
      } catch {
        pyramid = await decodeOnMain(url); // worker missing/crashed/unsupported → main-thread fallback
      }
      if (pyramid) {
        cacheSet(url, pyramid);
        if (persistKey) persistPyramid(persistKey, pyramid);
      }
      return pyramid;
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

/** Resample all envelopes (max + min + rms) of one hi-res level to `buckets` display columns. */
function resampleLevel(level: HiresPeaks, buckets: number): WaveformPeaks {
  return {
    max: resampleOne(level.max, buckets, "max"),
    min: resampleOne(level.min, buckets, "min"),
    rms: resampleOne(level.rms, buckets, "max")
  };
}

/** Read a source's cached pyramid without triggering a decode (for the GL renderer). Returns
 * `undefined` until `getAudioPeaks(url)` has populated it. */
export function getCachedPyramid(url: string | undefined): Pyramid | undefined {
  if (!url) return undefined;
  return cacheGet(url);
}

/** Pick the finest pyramid level whose length fits within `maxLength` — used to size a GPU texture
 * to the largest resolution the hardware allows without exceeding MAX_TEXTURE_SIZE. */
export function getTextureLevel(pyramid: Pyramid, maxLength: number): HiresPeaks | undefined {
  let best: HiresPeaks | undefined;
  for (const level of pyramid.levels) {
    if (level.max.length <= maxLength) {
      best = level;
      break; // levels are finest → coarsest; first that fits is the highest-res that fits
    }
  }
  return best ?? pyramid.levels[pyramid.levels.length - 1];
}

/**
 * Budget on how many hi-res samples the visible window may span before we drop to a coarser LOD —
 * chosen to mirror the GL overlay's MAX_TEXTURE_SIZE cap so the Canvas path draws from the SAME
 * resolution the GPU path does. (A previous, tighter LOD picked a level ~2× coarser than GL, which
 * made the default renderer look visibly blockier than `?glWaveform=1` even though both share the
 * DSP. resampleOne is max/min-preserving and O(window), trivial per clip at this budget.)
 */
const MAX_RESAMPLE_SAMPLES = 16384;

/**
 * Pick the FINEST pyramid level whose slice of the requested window still fits the resample budget
 * (falling back to coarser levels only for extremely long windows) — matching the GL path's
 * "finest level that fits the texture" rule so both renderers show identical detail.
 */
function selectLevelIndex(levels: HiresPeaks[], startFrac: number, endFrac: number): number {
  const span = Math.max(1e-6, endFrac - startFrac);
  for (let i = 0; i < levels.length; i += 1) {
    if (span * (levels[i]?.max.length ?? 0) <= MAX_RESAMPLE_SAMPLES) return i;
  }
  return levels.length - 1;
}

/** Slice the best-fit pyramid level to the `[startFrac, endFrac]` window, then resample to `buckets`. */
function slicePyramid(levels: HiresPeaks[], startFrac: number, endFrac: number, buckets: number): WaveformPeaks {
  const level = levels[selectLevelIndex(levels, startFrac, endFrac)];
  if (!level) return { max: [], min: [], rms: [] };
  const len = level.max.length;
  const start = Math.floor(startFrac * len);
  const end = Math.min(len, Math.max(start + 1, Math.ceil(endFrac * len)));
  if (end <= start) return resampleLevel(level, buckets);
  return {
    max: resampleOne(level.max.subarray(start, end), buckets, "max"),
    min: resampleOne(level.min.subarray(start, end), buckets, "min"),
    rms: resampleOne(level.rms.subarray(start, end), buckets, "max")
  };
}

/**
 * VIEWPORT-RENDERER contract. Sample the peaks for a source-time window `[startSec, endSec]` at
 * exactly ONE bucket per device pixel (`round(pixelWidth × dpr)` columns). The provider decides HOW
 * MANY samples (density == screen resolution); the caller only decides WHERE (the window). This
 * guarantees the `1 device pixel = 1 column = 1 bucket` invariant, so a column rasterizer never
 * stretches a bucket at any zoom. Returns `null` for an empty/degenerate window. Read the pyramid
 * with `getCachedPyramid` first (no decode is triggered here).
 */
export function sampleWaveformWindow(
  pyramid: Pyramid,
  startSec: number,
  endSec: number,
  pixelWidth: number,
  dpr: number
): WaveformPeaks | null {
  const duration = pyramid.duration;
  if (!(duration > 0) || !(endSec > startSec) || !(pixelWidth > 0)) return null;
  const columns = Math.max(1, Math.min(16384, Math.round(pixelWidth * Math.max(1, dpr))));
  const startFrac = clamp01(startSec / duration);
  const endFrac = clamp01(endSec / duration);
  if (endFrac <= startFrac) return null;
  return slicePyramid(pyramid.levels, startFrac, endFrac, columns);
}

/**
 * React hook: returns the asset's peaks resampled to `buckets`, or `null` while
 * loading/unavailable. The underlying asset is decoded once into an LOD pyramid and cached;
 * changing `buckets` only re-resamples the best-fit level (no re-decode), so a wider clip can
 * ask for more bars and gain detail instantly.
 */
export function useAudioPeaks(url: string | undefined, buckets = PEAK_BUCKETS): WaveformPeaks | null {
  const [pyramid, setPyramid] = useState<Pyramid | null>(() => (url ? cacheGet(url) ?? null : null));
  useEffect(() => {
    if (!url) {
      setPyramid(null);
      return;
    }
    const cached = cacheGet(url);
    if (cached) {
      setPyramid(cached);
      return;
    }
    let active = true;
    void getAudioPeaks(url).then((result) => {
      if (active) setPyramid(result);
    });
    return () => {
      active = false;
    };
  }, [url]);
  return useMemo(() => (pyramid ? slicePyramid(pyramid.levels, 0, 1, buckets) : null), [pyramid, buckets]);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * React hook: the peaks for just the **trimmed window** of a clip — the portion of the asset between
 * `sourceInSeconds` and `sourceInSeconds + durationSeconds`, resampled to `buckets`. The pyramid maps
 * linearly onto the decoded duration, so trimming/slipping a clip shows exactly the waveform under it
 * (beats line up). Falls back to the whole array until the decoded duration is known (or on decode failure).
 */
export function useAudioPeaksSlice(
  url: string | undefined,
  sourceInSeconds: number,
  durationSeconds: number,
  buckets = PEAK_BUCKETS
): WaveformPeaks | null {
  const [pyramid, setPyramid] = useState<Pyramid | null>(() => (url ? cacheGet(url) ?? null : null));
  useEffect(() => {
    if (!url) {
      setPyramid(null);
      return;
    }
    const cached = cacheGet(url);
    if (cached) {
      setPyramid(cached);
      return;
    }
    let active = true;
    void getAudioPeaks(url).then((result) => {
      if (active) setPyramid(result);
    });
    return () => {
      active = false;
    };
  }, [url]);

  return useMemo(() => {
    if (!pyramid) return null;
    const duration = pyramid.duration;
    if (!duration || duration <= 0 || durationSeconds <= 0) return slicePyramid(pyramid.levels, 0, 1, buckets);
    const startFrac = clamp01(sourceInSeconds / duration);
    const endFrac = clamp01((sourceInSeconds + durationSeconds) / duration);
    if (endFrac <= startFrac) return slicePyramid(pyramid.levels, 0, 1, buckets);
    return slicePyramid(pyramid.levels, startFrac, endFrac, buckets);
  }, [pyramid, durationSeconds, sourceInSeconds, buckets]);
}
