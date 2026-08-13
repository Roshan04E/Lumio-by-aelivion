/**
 * Local export — fast source decode via WebCodecs + mp4box (Phase L3).
 *
 * Replaces per-frame <video> seeking (the dominant export cost) with a forward, bounded
 * `VideoDecoder` fed from an mp4box demux. Export reads time monotonically, so we decode
 * forward and hold the current frame; a backward jump (a new clip starting earlier in the
 * same source) resets to the nearest keyframe. Returns null when the file can't be
 * demuxed/decoded so the caller falls back to the <video> provider.
 *
 * STREAMING DEMUX (wcDecode flip blocker 1): mp4box only ever sees the byte ranges needed to
 * parse the sample TABLE (moov; `appendBuffer`'s return value jumps over mdat for moov-at-end
 * files), and encoded chunks are materialized on demand from `blob.slice()` in a bounded window
 * around the feed position (`WINDOW_MAX_SAMPLES` / `WINDOW_MAX_SPAN_BYTES`, whole-window replace).
 * The WINDOW's RAM is therefore O(one GOP window), not O(file).
 *
 * WHERE THE SOURCE BYTES LIVE, and what that costs (DEBT-019, measured 2026-08-12). This comment
 * used to claim `response.blob()` gives a "disk-backed Blob … Peak RAM O(one GOP window), not
 * O(file)". The window half was true; the Blob half was FALSE and cost real memory: a fetched Blob
 * measured 86.5 MB resident for a 76.8 MB file, so per-source residency scaled with clip LENGTH
 * (~4.9 MB for a 3s source vs ~86.5 MB for a 2-minute one — 17.6× for 40× the duration).
 *
 * So the bytes now come from whichever of these applies, in order:
 *   1. an object URL we minted ourselves (`object-url-registry.ts`) — the LOCAL-FIRST path, and
 *      the common one. OPFS/IndexedDB assets and the user's own picked Files are already
 *      disk-backed and already sliceable, so we hand the original Blob straight to the window and
 *      copy NOTHING. `blob.slice()` reads the window off disk on demand.
 *   2. a `RangedRemoteByteSource` — remote http(s) sources whose Range support is CONFIRMED by a real
 *      206 response, not assumed from an `Accept-Ranges` header (`remoteByteSourceFor`). It pages the
 *      SAME window shape over HTTP that local sources page over disk, so a remote source no longer
 *      holds more than one window's bytes at once either. DEBT-019's remote half.
 *   3. `fetchSourceBlob`'s `fetch(url).blob()` — the fallback for a URL that fails the Range probe (a
 *      server that ignores Range and returns 200, a dead URL, an unusable `Content-Range`). Still a
 *      whole-file RAM copy, charged as `copiedBytes` exactly as before so a degrade cannot be mistaken
 *      for a win in the residency numbers.
 * `sourceResidentBytes()` reports the difference in BYTES, never in provider count — a count is
 * only a proxy for bytes while clip lengths are similar, which is the assumption that broke.
 *
 * Fragmented MP4s (empty sample table, moof-driven) fall back to a full sequential
 * extraction pass — rare for user uploads, and still cheaper than v1 because mp4box's
 * internal buffers are released as chunks are captured. That fallback holds every chunk in RAM by
 * construction, so it is O(file) for BOTH source kinds — the pass-through does not help it.
 */

import { createFile, DataStream, type MP4File, type MP4VideoTrackInfo } from "mp4box";
import { resolveObjectUrlBlob } from "../lib/object-url-registry";
import { rotationFromMatrix, type SourceRotation } from "./source-color";
import type { FrameProvider } from "./source-decoder";

/**
 * FETCHED source Blobs — remote http(s) only. LRU so long sessions can't pin every source.
 *
 * Locally-backed sources deliberately never enter this map: they are resolved from the object-URL
 * registry with no copy and no retention, so caching them would reintroduce exactly the residency
 * this cache's entries still carry. Every Blob in here is a whole-file RAM copy; see
 * `sourceResidentBytes()`.
 */
const sourceBlobCache = new Map<string, Promise<Blob>>();
const SOURCE_BLOB_CACHE_MAX = 12;

/**
 * Resident encoded-source bytes, IN BYTES, split by whether we own a copy.
 *
 * `copiedBytes` is what this module actually costs the process: the sum of every fetched whole-file
 * Blob it is holding. `passthroughBytes` is the size of the sources it is serving WITHOUT holding
 * their bytes (disk-backed Files sliced in place) — reported so the two are visibly different
 * quantities rather than one aggregate that hides which is which.
 *
 * Deliberately NOT a provider count. DEBT-019's Detection clause names a count-denominated budget
 * as *extending* the debt, because a count only proxies bytes while clip lengths are similar.
 * Whatever ends up enforcing ADR-021's I-P6 budget should read `copiedBytes`.
 */
const residency = {
  copiedBytes: 0,
  passthroughBytes: 0,
  copiedSources: 0,
  passthroughSources: 0,
  /**
   * Sample-table bytes held by live providers — the OTHER duration-scaled term, and the one the
   * pass-through could not touch. Reported so it is measured directly instead of being inferred from
   * a working-set delta, which was how it got mis-attributed in the first place.
   */
  indexBytes: 0,
  indexSamples: 0,
  /**
   * DEBT-019 remote half. A remote http(s) source whose Range support was CONFIRMED (not assumed —
   * see `probeAndBuildRangedSource`) is charged here at its logical file size, same framing as
   * `passthroughBytes`: this is what is being served WITHOUT a whole-file copy, not what is resident
   * at any instant (the actual resident bytes are the same transient, ≤`WINDOW_MAX_SPAN_BYTES` window
   * every source kind already pays, local or remote). A URL that failed the probe and degraded to a
   * whole-file fetch is charged as `copiedBytes` instead, honestly — it did not become cheap by being
   * attempted.
   */
  rangedBytes: 0,
  rangedSources: 0,
};

/** On-heap cost of one sample: Float64 offset + Uint32 size + Float64 ts + Uint32 duration + Uint8 key. */
const INDEX_BYTES_PER_SAMPLE = 8 + 4 + 8 + 4 + 1;

export function sourceResidentBytes(): Readonly<typeof residency> {
  return residency;
}

/**
 * Byte size of each fetched Blob this module still holds, so eviction can credit the right amount
 * back. CAVEAT worth stating rather than hiding: `copiedBytes` counts what THIS CACHE retains. A
 * provider constructed before an eviction keeps its own reference alive, so during heavy churn the
 * true process cost can exceed this figure. It is an accurate floor, not a ceiling.
 */
const copiedSizes = new Map<string, number>();

/** URLs already counted into `passthroughBytes`, so the gauge counts sources and not calls. */
const passthroughSeen = new Set<string>();

function releaseCopied(url: string): void {
  const size = copiedSizes.get(url);
  if (size === undefined) return;
  copiedSizes.delete(url);
  residency.copiedBytes -= size;
  residency.copiedSources -= 1;
}

if (typeof window !== "undefined") {
  try {
    Object.defineProperty(window, "__rfSourceResidency", { configurable: true, get: () => residency });
  } catch {
    /* read-only window in some embeds — telemetry is best-effort */
  }
}

/** Which demux path providers took this session — asserted by the wc-decoder gate + soak telemetry. */
export const wcDecoderStats = { streaming: 0, fragmented: 0 };

/**
 * Decoder-internal reset telemetry (`window.__rfWcDecoder`). A hardware `decoder.reset()+configure()`
 * tears down the decode session; `hardReset` counts every such reset (backward seeks/shuttle, forward
 * GOP crossings past the fed cursor, export). A high count during steady forward playback signals the
 * session is thrashing rather than streaming. Observational only — never gates behavior.
 */
export const wcDecoderResetStats = { hardReset: 0 };
if (typeof window !== "undefined") {
  try {
    Object.defineProperty(window, "__rfWcDecoder", { configurable: true, get: () => wcDecoderResetStats });
  } catch {
    /* read-only window in some embeds — telemetry is best-effort */
  }
}

/**
 * The demuxed sample table — metadata only, bytes stay in the Blob until windowed in.
 *
 * COLUMNS, NOT ROWS (DEBT-019). This was `SampleIndexEntry[]`: one JS object per sample, five
 * properties each. MEASURED at 57 bytes/sample of retained heap (`tmp/debt019-index-shape-probe.ts`,
 * 360k samples, two runs) against 25 bytes of payload; as five typed arrays it is `length × 25`
 * exactly, with no per-sample allocation and no GC pressure. The table is held for the provider's
 * whole life because seeking is what it is for, and it is the last term in this file that grows with
 * clip DURATION — 3600 samples for a 2-minute 30fps source, 18000 for a 10-minute one.
 *
 * DO NOT read this as the fix for per-source residency; it is not, and the entry says so. The term is
 * ~0.09 MB per 2-minute source, roughly 0.3% of that source's measured residency — phase 2a attributed
 * ~7 MB/source here by subtraction and was wrong by ~80×. This shape is right on its own merits.
 *
 * Widths are chosen for real files, not for typical ones:
 *   - `offset` is Float64 because a sample offset exceeds 2^32 in any file over 4 GB.
 *   - `timestamp` is Float64 because 2^31 micros is only ~36 minutes, and cts is not clamped to the
 *     clip we happen to be showing.
 *   - `duration` is Uint32 (max ~71 min per sample) and non-negative by construction; callers that
 *     already `Math.max(0, …)` it keep doing so.
 */
interface SampleIndex {
  readonly length: number;
  readonly offset: Float64Array;
  readonly size: Uint32Array;
  readonly timestamp: Float64Array;
  readonly duration: Uint32Array;
  /** 1 = sync sample. Uint8, not boolean[] — a boolean array is a pointer array. */
  readonly isKey: Uint8Array;
}

/** Allocate an index of exactly `count` samples. Both demux paths know the count up front. */
function allocSampleIndex(count: number): {
  index: SampleIndex;
  set: (i: number, offset: number, size: number, timestamp: number, duration: number, isKey: boolean) => void;
} {
  const index: SampleIndex = {
    length: count,
    offset: new Float64Array(count),
    size: new Uint32Array(count),
    timestamp: new Float64Array(count),
    duration: new Uint32Array(count),
    isKey: new Uint8Array(count),
  };
  const set = (i: number, offset: number, size: number, timestamp: number, duration: number, isKey: boolean) => {
    index.offset[i] = offset;
    index.size[i] = Math.max(0, size);
    index.timestamp[i] = timestamp;
    // Uint32 wraps a negative, and a garbage duration on the LAST sample becomes the clip's
    // decodable end — clamp here, once, rather than at every read.
    index.duration[i] = Math.max(0, duration);
    index.isKey[i] = isKey ? 1 : 0;
  };
  return { index, set };
}

/** Feed-window bounds: how much encoded data may be RAM-resident per provider at once. */
const WINDOW_MAX_SAMPLES = 96; // ≥ WARMUP_MAX so warmup never starves on window edges
const WINDOW_MAX_SPAN_BYTES = 24 << 20; // byte SPAN in the file (may include interleaved audio)
const INDEX_SLICE_BYTES = 4 << 20;
const INDEX_MAX_ROUNDS = 512;

function webcodecsDebugEnabled(): boolean {
  try {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("exportDecodeDebug") === "1" || params.get("exportGlDebug") === "1") return true;
      if (window.localStorage?.getItem("orreris.exportDecodeDebug") === "1" || window.localStorage?.getItem("orreris.exportGlDebug") === "1") {
        return true;
      }
    }
  } catch {
    /* no window/localStorage */
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_EXPORT_DECODE_DEBUG === "1" || env?.VITE_EXPORT_DECODE_DEBUG === "true";
}

/**
 * The source bytes for `url`, copying only when we have no choice.
 *
 * THE PASS-THROUGH (DEBT-019). If we minted this object URL ourselves, we still have the Blob it
 * points at, and for OPFS/IndexedDB assets and picked Files that Blob is a disk-backed handle — no
 * bytes resident, `slice()` reads on demand. `fetch(url).blob()` over the very same URL would
 * instead materialise the whole file in RAM (measured: +226 MB for 192 MB of files), which is
 * pure loss, since the only consumer is a chunk window that wants ≤24 MB of it at a time.
 *
 * Returns the original Blob for anything the registry knows, and range-pages remote http(s) sources
 * (`remoteByteSourceFor`) instead of copying them whole.
 */
function sourceBlobFor(url: string): Promise<ByteSource> {
  const local = resolveObjectUrlBlob(url);
  if (local) {
    // No cache entry: there is nothing to cache. We hold no bytes, so a second call is free.
    // Counted once per URL, not once per call — this is a gauge of what is being served without
    // residency, and re-deriving a provider for the same source must not inflate it.
    if (!passthroughSeen.has(url)) {
      passthroughSeen.add(url);
      residency.passthroughBytes += local.size;
      residency.passthroughSources += 1;
    }
    return Promise.resolve(local);
  }
  return remoteByteSourceFor(url);
}

function fetchSourceBlob(url: string): Promise<Blob> {
  let cached = sourceBlobCache.get(url);
  if (!cached) {
    cached = (async () => {
      const controller = new AbortController();
      // 15s to headers (dead URL / stalled connect fails fast → <video> fallback), then a generous
      // body budget: response.blob() streams to disk and a large source on a slow link legitimately
      // takes longer than any per-frame timeout.
      let timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), 120_000);
        const blob = await response.blob();
        // This IS a whole-file RAM copy — the remaining half of DEBT-019, and the reason the number
        // is reported in bytes. Charged on arrival, credited back when evicted below.
        copiedSizes.set(url, blob.size);
        residency.copiedBytes += blob.size;
        residency.copiedSources += 1;
        return blob;
      } finally {
        clearTimeout(timer);
      }
    })().catch((error) => {
      sourceBlobCache.delete(url);
      throw error;
    });
    sourceBlobCache.set(url, cached);
    while (sourceBlobCache.size > SOURCE_BLOB_CACHE_MAX) {
      const oldest = sourceBlobCache.keys().next().value;
      if (oldest === undefined) break;
      sourceBlobCache.delete(oldest);
      releaseCopied(oldest);
    }
  } else {
    // LRU refresh: re-insert on hit so the busiest sources survive eviction.
    sourceBlobCache.delete(url);
    sourceBlobCache.set(url, cached);
  }
  return cached;
}

/**
 * The source bytes for `demuxIndex`/`createBlobChunkWindow`, whichever kind actually backs them.
 * Both call sites only ever do `.size` and `.slice(start, end).arrayBuffer()` — `Blob` already
 * satisfies this structurally, so a `RangedRemoteByteSource` slots in with zero changes to demux or
 * window code: the SAME 4 MB index-parse rounds and the SAME ≤24 MB feed window that already bound a
 * local read now bound a Range GET instead of a `Blob.slice()`.
 */
interface ByteSource {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** How many bytes the Range-support probe requests — deliberately `INDEX_SLICE_BYTES`, so a
 * confirmed-supported source's own probe response IS `demuxIndex`'s first round, not a wasted one. */
const RANGE_PROBE_BYTES = INDEX_SLICE_BYTES;
const RANGE_FETCH_TIMEOUT_MS = 20_000;
const RANGE_RETRY_MAX = 3;
const RANGE_RETRY_BASE_MS = 300;

/** Thrown by `probeAndBuildRangedSource` when the URL demonstrably does not honor Range — as opposed
 * to a network-level failure, which says nothing about Range support and must not poison future
 * attempts the way this does. */
class NotRangeableError extends Error {}

/**
 * Bounded, retried HTTP Range read for one [start, end) span. A dropped ranged request mid-scrub is a
 * decode stall, not a memory problem — it is the failure users would actually notice — so this
 * retries with backoff before surfacing to the caller, which already treats a thrown `ensure()`/
 * `slice()` as provider failure (`win.ensure()`'s catch → `failed = true` → `<video>` fallback).
 */
async function fetchRange(url: string, start: number, end: number): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RANGE_RETRY_MAX; attempt += 1) {
    if (attempt > 0) await sleepMs(RANGE_RETRY_BASE_MS * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RANGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      if (response.status === 206) return await response.arrayBuffer();
      if (response.status === 200) {
        // The server stopped honoring Range mid-session (a CDN/proxy hop can drop the header even
        // when the origin advertised support at probe time). It DID answer, just not the way we
        // asked — slice out what was actually wanted rather than fail a request that succeeded.
        const whole = await response.arrayBuffer();
        if (webcodecsDebugEnabled()) {
          console.warn(`[export] range fetch got 200 (not 206) for ${url} bytes=${start}-${end - 1} — server stopped honoring Range mid-session`);
        }
        return whole.slice(start, Math.min(end, whole.byteLength));
      }
      throw new Error(`range fetch HTTP ${response.status} for ${url} bytes=${start}-${end - 1}`);
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * A remote http(s) source, windowed over HTTP Range instead of held whole. `size` is the confirmed
 * total from the probe's `Content-Range`; `primed` is that same probe response, reused for the exact
 * first `slice(0, N)` call `demuxIndex` makes so detection costs nothing on the happy path.
 */
class RangedRemoteByteSource implements ByteSource {
  readonly size: number;
  private readonly url: string;
  private primed: { end: number; buffer: ArrayBuffer } | null;

  constructor(url: string, size: number, primed: { end: number; buffer: ArrayBuffer }) {
    this.url = url;
    this.size = size;
    this.primed = primed;
  }

  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } {
    const clampedEnd = Math.min(end, this.size);
    return {
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        if (clampedEnd <= start) return new ArrayBuffer(0);
        const primed = this.primed;
        if (primed && start === 0 && clampedEnd <= primed.end) {
          this.primed = null; // one-shot: the window never re-reads [0, N) once past it
          return primed.buffer.slice(0, clampedEnd);
        }
        this.primed = null; // any other first read means the prime went unused — don't hold it forever
        return fetchRange(this.url, start, clampedEnd);
      },
    };
  }
}

/** URLs a probe already proved do NOT honor Range — skip straight to `fetchSourceBlob` rather than
 * re-probing (and re-paying its bytes) on every provider a project builds against the same source. */
const rangeUnsupported = new Set<string>();
const rangedSourceCache = new Map<string, Promise<RangedRemoteByteSource>>();
const RANGED_SOURCE_CACHE_MAX = 12;
/** Per-URL charge into `residency.rangedBytes`, so eviction can credit back the right amount. */
const rangedSizes = new Map<string, number>();

function creditRanged(url: string): void {
  const size = rangedSizes.get(url);
  if (size === undefined) return;
  rangedSizes.delete(url);
  residency.rangedBytes -= size;
  residency.rangedSources -= 1;
}

/**
 * Detect Range support for real — a `206` on an actual byte-range GET, not an `Accept-Ranges` header
 * taken on faith — and build the paged source from that same response. Any other outcome throws
 * `NotRangeableError` so the caller can degrade honestly instead of silently falling back to
 * behavior that looks the same as success.
 */
async function probeAndBuildRangedSource(url: string): Promise<RangedRemoteByteSource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Range: `bytes=0-${RANGE_PROBE_BYTES - 1}` },
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 206) {
    if (webcodecsDebugEnabled()) {
      console.warn(`[export] ${url} did not honor Range (status ${response.status}) — falling back to a whole-file fetch`);
    }
    throw new NotRangeableError(`not rangeable: status ${response.status}`);
  }
  // Content-Range/Accept-Ranges must be on the CORS Expose-Headers allowlist for a cross-origin read
  // to see this at all (see the /storage CORS middleware) — a same-origin dev proxy hides that gap.
  const contentRange = response.headers.get("Content-Range");
  const total = contentRange ? Number(contentRange.split("/")[1]) : NaN;
  if (!Number.isFinite(total) || total <= 0) {
    if (webcodecsDebugEnabled()) {
      console.warn(`[export] ${url} returned 206 without a usable Content-Range ("${contentRange}") — falling back to a whole-file fetch`);
    }
    throw new NotRangeableError("206 without a usable Content-Range");
  }
  const buffer = await response.arrayBuffer();
  return new RangedRemoteByteSource(url, total, { end: buffer.byteLength, buffer });
}

/**
 * The remote-source half of `sourceBlobFor`. Confirmed-rangeable URLs page over HTTP Range, bounded
 * to the same window the local pass-through already uses; anything else — probe failure, a server
 * that ignores Range, a malformed 206 — degrades to `fetchSourceBlob`'s existing whole-file copy, and
 * that degrade is charged as `copiedBytes`, the same bucket a real whole-file fetch already uses, so
 * it cannot be mistaken for a win in the residency numbers.
 */
function remoteByteSourceFor(url: string): Promise<ByteSource> {
  if (rangeUnsupported.has(url)) return fetchSourceBlob(url);
  let cached = rangedSourceCache.get(url);
  if (!cached) {
    cached = probeAndBuildRangedSource(url)
      .then((source) => {
        rangedSizes.set(url, source.size);
        residency.rangedBytes += source.size;
        residency.rangedSources += 1;
        return source;
      })
      .catch((error) => {
        rangedSourceCache.delete(url);
        // Only a demonstrated non-206 (or an unusable 206) means "this URL does not do Range" — a
        // network-level failure (dead URL, timeout) says nothing about Range support and must not
        // poison later attempts against the same URL once the network recovers.
        if (error instanceof NotRangeableError) rangeUnsupported.add(url);
        throw error;
      });
    rangedSourceCache.set(url, cached);
    while (rangedSourceCache.size > RANGED_SOURCE_CACHE_MAX) {
      const oldest = rangedSourceCache.keys().next().value;
      if (oldest === undefined) break;
      rangedSourceCache.delete(oldest);
      creditRanged(oldest);
    }
  } else {
    // LRU refresh: re-insert on hit so the busiest sources survive eviction.
    rangedSourceCache.delete(url);
    rangedSourceCache.set(url, cached);
  }
  return cached.catch(() => fetchSourceBlob(url));
}

function getDescription(file: MP4File, trackId: number): Uint8Array | undefined {
  const entry = file.getTrackById(trackId)?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  const box = entry?.avcC ?? entry?.hvcC ?? entry?.vpcC ?? entry?.av1C;
  if (!box) return undefined;
  const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("mp4box timeout")), ms));
}

/** Paced wait for stalled rounds (decoder busy, nothing to feed) — don't busy-spin the fast yield. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Yield to the event loop so decoder output callbacks can run. MessageChannel instead of
 * setTimeout(0): browsers clamp nested timeouts to ~4ms, which made a long catch-up decode
 * (sparse-keyframe source after a rewind) take seconds of mostly-idle waiting.
 */
const yieldTask: () => Promise<void> = (() => {
  if (typeof MessageChannel === "undefined") {
    return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const channel = new MessageChannel();
  let pending: Array<() => void> = [];
  channel.port1.onmessage = () => {
    const callbacks = pending;
    pending = [];
    for (const callback of callbacks) callback();
  };
  return () =>
    new Promise<void>((resolve) => {
      pending.push(resolve);
      channel.port2.postMessage(0);
    });
})();

async function appendBlobSlice(file: MP4File, blob: ByteSource, start: number, end: number): Promise<number> {
  const part = (await blob.slice(start, end).arrayBuffer()) as ArrayBuffer & { fileStart: number };
  part.fileStart = start;
  const next = file.appendBuffer(part);
  return typeof next === "number" ? next : 0;
}

interface DemuxedIndex {
  track: MP4VideoTrackInfo;
  description: Uint8Array | undefined;
  index: SampleIndex;
  /** Non-null only on the fragmented-MP4 fallback path (chunks fully RAM-resident). */
  ramChunks: EncodedVideoChunk[] | null;
  /**
   * Container display rotation (`tkhd` matrix, phone footage). WebCodecs emits CODED-orientation
   * frames — unlike the `<video>` fallback, which auto-rotates — so the provider must bake this
   * quarter-turn or rotated sources export/proxy tilted (2026-07-12 user report).
   */
  rotationDegrees: SourceRotation;
}

/**
 * Parse the sample TABLE from the Blob without buffering media data: follow mp4box's own
 * next-parse-position (it jumps over an incomplete mdat once it knows the box size, so a
 * moov-at-end file costs a head slice + tail slices, not a full read).
 */
async function demuxIndex(blob: ByteSource): Promise<DemuxedIndex | null> {
  const file = createFile();
  let readyInfo: { track: MP4VideoTrackInfo; description: Uint8Array | undefined; fragmented: boolean } | null = null;
  let parseError: string | null = null;
  file.onError = (error) => {
    parseError = String(error);
  };
  file.onReady = (info) => {
    const track = info.videoTracks?.[0];
    if (!track) {
      parseError = "no video track";
      return;
    }
    readyInfo = {
      track,
      description: getDescription(file, track.id),
      fragmented: Boolean((info as { isFragmented?: boolean }).isFragmented),
    };
  };

  let pos = 0;
  let rounds = 0;
  while (!readyInfo && !parseError && pos < blob.size && rounds++ < INDEX_MAX_ROUNDS) {
    const end = Math.min(pos + INDEX_SLICE_BYTES, blob.size);
    let next = 0;
    try {
      next = await appendBlobSlice(file, blob, pos, end);
    } catch {
      return null;
    }
    // Advance to whatever mp4box asks for next (may jump over mdat); never move backward.
    pos = next > pos ? Math.min(next, blob.size) : end;
    await yieldTask();
  }
  if (parseError || !readyInfo) return null;
  const { track, description, fragmented } = readyInfo as {
    track: MP4VideoTrackInfo;
    description: Uint8Array | undefined;
    fragmented: boolean;
  };
  let rotationDegrees: SourceRotation = 0;
  try {
    rotationDegrees = rotationFromMatrix(file.getTrackById(track.id)?.tkhd?.matrix);
  } catch {
    /* no tkhd → no rotation */
  }

  // FRAGMENTED MP4 with a streaming-friendly layout (Pexels downloads, CMAF): at onReady the sample
  // table only holds the fragments parsed so far — for these files that's the FIRST ~8-10s fragment.
  // The old code accepted that partial table as the whole movie (every entry has a valid offset/size,
  // so nothing looked wrong), the decoder clamped every later request to the last indexed sample, and
  // playback/proxy builds froze at exactly the fragment boundary — with the frozen tail BAKED into
  // ingest proxies, because a clamped frame is not null so the frozen-tail guard never fired
  // (2026-07-06 user experiment: same source re-encoded by Clipchamp = fine; Pexels original = frozen
  // at 8.5s/10.4s/16.8s depending on variant). Keep following mp4box's next-parse positions to EOF so
  // every fragment's samples land in the index; sample offsets/sizes are absolute, so the normal
  // streaming blob-window path works unchanged afterwards. Transient cost: mp4box pins roughly the
  // appended bytes until this function returns (measured ~1× file size) — one-time, per source.
  if (fragmented) {
    while (!parseError && pos < blob.size && rounds++ < INDEX_MAX_ROUNDS) {
      const end = Math.min(pos + INDEX_SLICE_BYTES, blob.size);
      let next = 0;
      try {
        next = await appendBlobSlice(file, blob, pos, end);
      } catch {
        return null;
      }
      pos = next > pos ? Math.min(next, blob.size) : end;
      // Best-effort: free per-sample data references + drained buffers as fragments parse.
      try {
        const fileWithRelease = file as unknown as {
          releaseUsedSamples?: (id: number, upTo: number) => void;
          stream?: { cleanBuffers?: () => void };
        };
        const parsed = file.getTrackSamplesInfo?.(track.id) ?? [];
        if (parsed.length > 0) fileWithRelease.releaseUsedSamples?.(track.id, parsed.length);
        fileWithRelease.stream?.cleanBuffers?.();
      } catch {
        /* memory hygiene only — the index is what matters */
      }
      await yieldTask();
    }
  }

  const timescale = track.timescale || 1;
  const toMicros = (t: number) => Math.round((t / timescale) * 1_000_000);
  const samples = file.getTrackSamplesInfo?.(track.id) ?? [];
  file.stop();

  if (samples.length > 0 && samples.every((s) => typeof s.offset === "number" && typeof s.size === "number" && s.size > 0)) {
    // Some demuxes don't flag sync samples (no `stss` box → every `is_sync` is false). Feeding the
    // decoder all-"delta" chunks means it silently waits forever for a keyframe and emits nothing →
    // black/slow-fallback. If NO sample is flagged sync, assume the first is a keyframe so the
    // decoder can start (the probe still falls back if that assumption is wrong for this file).
    const syncCount = samples.reduce((n, s) => n + (s.is_sync ? 1 : 0), 0);
    const { index, set } = allocSampleIndex(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]!;
      set(i, sample.offset ?? 0, sample.size ?? 0, toMicros(sample.cts), toMicros(sample.duration), sample.is_sync || (syncCount === 0 && i === 0));
    }
    if (webcodecsDebugEnabled()) {
      console.log(
        `[export] webcodecs streaming index: ${index.length} samples, ${syncCount} sync, codec="${track.codec}"${fragmented ? ", fragmented" : ""}, parsed ${rounds} slice(s) of ${blob.size}B`
      );
    }
    wcDecoderStats.streaming += 1;
    return { track, description, index, ramChunks: null, rotationDegrees };
  }

  // Fragmented MP4 (sample table lives in moofs): sequential full-extraction fallback. Chunks are
  // RAM-resident like v1, but mp4box's internal buffers are released as we capture each sample.
  return demuxFragmented(blob, track, description, toMicros, rotationDegrees);
}

async function demuxFragmented(
  blob: ByteSource,
  infoTrack: MP4VideoTrackInfo,
  infoDescription: Uint8Array | undefined,
  toMicros: (t: number) => number,
  rotationDegrees: SourceRotation
): Promise<DemuxedIndex | null> {
  const file = createFile();
  const ramChunks: EncodedVideoChunk[] = [];
  let sawSync = false;
  let failed = false;
  file.onError = () => {
    failed = true;
  };
  const ready = new Promise<{ track: MP4VideoTrackInfo; description: Uint8Array | undefined }>((resolve, reject) => {
    file.onReady = (info) => {
      const track = info.videoTracks?.[0];
      if (!track) {
        reject(new Error("no video track"));
        return;
      }
      file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples || 1_000_000 });
      file.start();
      resolve({ track, description: getDescription(file, track.id) });
    };
  });
  let trackId = 0;
  file.onSamples = (_id, _user, list) => {
    for (const sample of list) {
      if (sample.is_sync) sawSync = true;
      ramChunks.push(
        new EncodedVideoChunk({
          type: sample.is_sync || (!sawSync && ramChunks.length === 0) ? "key" : "delta",
          timestamp: toMicros(sample.cts),
          duration: toMicros(sample.duration),
          data: sample.data!,
        })
      );
      if (trackId && sample.number != null) file.releaseUsedSamples?.(trackId, sample.number);
    }
  };

  let resolved: { track: MP4VideoTrackInfo; description: Uint8Array | undefined };
  try {
    const readyRace = Promise.race([ready, rejectAfter(8000)]);
    // Poll-safe view of ready: never rejects, so racing it against an immediate null inside the
    // append loop can't leave an unhandled rejection behind.
    const readySoFar = readyRace.catch(() => null);
    for (let offset = 0; offset < blob.size && !failed; offset += INDEX_SLICE_BYTES) {
      await appendBlobSlice(file, blob, offset, Math.min(offset + INDEX_SLICE_BYTES, blob.size));
      if (trackId === 0) {
        // ready resolves during the first appends; grab the track id so releaseUsedSamples engages.
        const maybe = await Promise.race([readySoFar, Promise.resolve(null)]);
        if (maybe) trackId = maybe.track.id;
      }
      await yieldTask();
    }
    file.flush();
    resolved = await readyRace;
    file.stop();
  } catch {
    return null;
  }
  if (failed || !ramChunks.length) return null;
  if (webcodecsDebugEnabled()) {
    console.log(`[export] webcodecs fragmented fallback: ${ramChunks.length} chunks fully extracted`);
  }
  wcDecoderStats.fragmented += 1;
  const { index, set } = allocSampleIndex(ramChunks.length);
  for (let i = 0; i < ramChunks.length; i += 1) {
    const chunk = ramChunks[i]!;
    set(i, 0, chunk.byteLength, chunk.timestamp, chunk.duration ?? 0, chunk.type === "key");
  }
  return { track: resolved.track ?? infoTrack, description: resolved.description ?? infoDescription, index, ramChunks, rotationDegrees };
}

/**
 * Bounded on-demand chunk window over the Blob. `ensure(from)` materializes chunks
 * [from, from+N) within the byte-span cap and evicts everything before `from`; `chunkAt`
 * is synchronous for the feed loop. The fragmented fallback wraps its RAM array instead.
 */
interface ChunkWindow {
  chunkAt(i: number): EncodedVideoChunk | null;
  ensure(from: number): Promise<void>;
  dispose(): void;
}

function createBlobChunkWindow(blob: ByteSource, index: SampleIndex): ChunkWindow {
  let loaded = new Map<number, EncodedVideoChunk>();
  return {
    chunkAt(i) {
      return loaded.get(i) ?? null;
    },
    async ensure(from) {
      if (from >= index.length) return;
      // Already have a reasonable runway? Keep it (also evict behind `from` so long forward
      // playback doesn't accumulate).
      if (loaded.has(from)) {
        for (const key of loaded.keys()) {
          if (key < from) loaded.delete(key);
        }
        return;
      }
      // Grow the window forward from `from`, bounded by count AND file-byte span (interleaved
      // audio sits inside the span, so span — not sample-size sum — is what the read costs).
      let spanStart = index.offset[from]!;
      let spanEnd = spanStart + index.size[from]!;
      let to = from + 1;
      while (to < index.length && to - from < WINDOW_MAX_SAMPLES) {
        const sOffset = index.offset[to]!;
        const nextStart = Math.min(spanStart, sOffset);
        const nextEnd = Math.max(spanEnd, sOffset + index.size[to]!);
        if (nextEnd - nextStart > WINDOW_MAX_SPAN_BYTES && to > from + 1) break;
        spanStart = nextStart;
        spanEnd = nextEnd;
        to += 1;
      }
      const buffer = await blob.slice(spanStart, spanEnd).arrayBuffer();
      const next = new Map<number, EncodedVideoChunk>();
      for (let i = from; i < to; i += 1) {
        next.set(
          i,
          new EncodedVideoChunk({
            type: index.isKey[i] ? "key" : "delta",
            timestamp: index.timestamp[i]!,
            duration: index.duration[i]!,
            data: new Uint8Array(buffer, index.offset[i]! - spanStart, index.size[i]!),
          })
        );
      }
      loaded = next; // whole-window replace = strict memory bound
    },
    dispose() {
      loaded.clear();
    },
  };
}

function createRamChunkWindow(chunks: EncodedVideoChunk[]): ChunkWindow {
  return {
    chunkAt(i) {
      return chunks[i] ?? null;
    },
    async ensure() {
      /* fully resident */
    },
    dispose() {
      chunks.length = 0;
    },
  };
}

/**
 * True DECODABLE end of a video source, in seconds, from its sample table — `lastSample.timestamp +
 * lastSample.duration`. This is authoritative where container `duration` metadata is not: many MP4s
 * report a `duration` that overshoots the last real sample by a frame to ~1s, and a clip authored to
 * that metadata length freezes on its final frame for the overshoot (the decoder clamps every
 * beyond-EOF getFrame to the last sample). Callers clamp clip length to this to avoid the frozen tail.
 *
 * Returns null when the file can't be demuxed here (non-MP4, parse failure) — the caller then keeps
 * its metadata duration unchanged.
 */
export async function probeDecodableEndSeconds(blobOrUrl: Blob | string): Promise<number | null> {
  if (typeof VideoDecoder === "undefined") return null;
  let blob: ByteSource;
  try {
    blob = typeof blobOrUrl === "string" ? await sourceBlobFor(blobOrUrl) : blobOrUrl;
  } catch {
    return null;
  }
  let demuxed: DemuxedIndex | null;
  try {
    demuxed = await Promise.race([demuxIndex(blob), rejectAfter(20_000)]);
  } catch {
    return null;
  }
  if (!demuxed || !demuxed.index.length) return null;
  const lastAt = demuxed.index.length - 1;
  const endMicros = demuxed.index.timestamp[lastAt]! + demuxed.index.duration[lastAt]!;
  return endMicros > 0 ? endMicros / 1_000_000 : null;
}

export async function createWebCodecsVideoSource(
  url: string,
  opts: {
    preferSoftware?: boolean;
    /**
     * Preview-only: max ms one getFrame call may spend decoding before returning the CURRENT
     * (stale) frame; catch-up state persists and continues on the next call. Export omits this
     * and keeps blocking-until-decoded semantics (it must never emit a stale frame).
     */
    frameBudgetMs?: number;
  } = {}
): Promise<FrameProvider | null> {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return null;

  let blob: ByteSource;
  try {
    blob = await sourceBlobFor(url);
  } catch {
    return null;
  }

  let demuxed: DemuxedIndex | null;
  try {
    demuxed = await Promise.race([demuxIndex(blob), rejectAfter(20_000)]);
  } catch {
    return null;
  }
  if (!demuxed || !demuxed.index.length) return null;
  const { track, description, index, rotationDegrees } = demuxed;
  const win = demuxed.ramChunks ? createRamChunkWindow(demuxed.ramChunks) : createBlobChunkWindow(blob, index);
  const chunkCount = index.length;
  // Charged for the provider's lifetime (credited in dispose) — the index is held precisely because
  // seeking needs it, so this is a real, permanent, duration-scaled cost and is reported as one.
  residency.indexBytes += chunkCount * INDEX_BYTES_PER_SAMPLE;
  residency.indexSamples += chunkCount;
  let indexCharged = true;

  // Key-sample positions, also a column: an all-intra source (ProRes-style proxies, screen
  // recordings) has one entry PER SAMPLE here, so a JS number[] would re-introduce a duration-scaled
  // term right next to the one we just removed.
  let keyCount = 0;
  for (let i = 0; i < chunkCount; i += 1) if (index.isKey[i]) keyCount += 1;
  const keyIndices = new Int32Array(Math.max(1, keyCount));
  {
    let k = 0;
    for (let i = 0; i < chunkCount; i += 1) if (index.isKey[i]) keyIndices[k++] = i;
    // No sync sample flagged anywhere → start at 0 (the demux already forces sample 0 to key).
  }

  const trackW = track.video?.width ?? track.track_width ?? 0;
  const trackH = track.video?.height ?? track.track_height ?? 0;

  const queue: VideoFrame[] = [];
  let failed = false;
  let reclaimed = false;
  let outputCount = 0;
  // Frozen-tail probe: last overshoot micros already logged, so the debug warning fires once per new
  // beyond-EOF region instead of every rAF while the tail sits frozen. lastSampleMicros is hoisted
  // ONCE here so the per-frame guard is a single integer compare (no index access, no debug read).
  let lastLoggedOvershootMicros = -1;
  const lastSampleMicros = chunkCount > 0 ? index.timestamp[chunkCount - 1]! : 0;
  const onOutput = (frame: VideoFrame) => {
    outputCount += 1;
    queue.push(frame);
  };
  const onError = (e: unknown) => {
    const message = (e as Error)?.message ?? String(e);
    // Chrome reclaims codecs that sit inactive (a paused clip, a provider parked warm in the
    // preview pool). The decoder is CLOSED at that point — mark it so the next getFrame recreates
    // a fresh one instead of the provider dying permanently ("clip stops rendering" soak report).
    if (/reclaimed/i.test(message)) reclaimed = true;
    failed = true;
    console.warn("[export] VideoDecoder error:", message);
  };
  let decoder = new VideoDecoder({ output: onOutput, error: onError });
  const buildConfig = (): VideoDecoderConfig => {
    const config: VideoDecoderConfig = { codec: track.codec };
    if (trackW) config.codedWidth = trackW;
    if (trackH) config.codedHeight = trackH;
    if (description) config.description = description;
    // Prefer SOFTWARE decode for export when asked. On an MP4 (H.264) export the hardware H.264 ENCODER and
    // hardware H.264 decode of an expensive source (high level / sparse keyframes) contend for the GPU's one
    // H.264 block; the decoder silently starves and the clip exports black. SW decode is LOSSLESS (identical
    // pixels) so quality is untouched, and it frees the HW block for the full-quality hardware encoder.
    if (opts.preferSoftware) config.hardwareAcceleration = "prefer-software";
    return config;
  };
  const configure = () => decoder.configure(buildConfig());
  // Fast-fail an unsupported config BEFORE the 5s probe-decode, and surface why (codec / avcC presence) so
  // we can fix the fast path rather than silently always taking the slow <video> fallback.
  try {
    const cfg = buildConfig();
    const support = await VideoDecoder.isConfigSupported(cfg).catch(() => null);
    if (!support?.supported) {
      console.warn(
        `[export] VideoDecoder config unsupported → <video> fallback. codec="${track.codec}" description=${description ? `${description.length}B` : "none"}`
      );
      return null;
    }
    configure();
  } catch (e) {
    console.warn(`[export] VideoDecoder.configure failed: codec="${track.codec}" description=${description ? `${description.length}B` : "none"}`, e);
    return null;
  }

  let fed = 0;
  let current: VideoFrame | null = null;
  // True when `current` is a CLONE of a reverse-cache frame (close it, never re-cache it).
  let currentIsClone = false;
  /**
   * The last presentable frame, retired by a seek (`resetTo`) rather than closed — preview only.
   * Returned, with its real lag, when the frame budget expires before the new position has decoded,
   * so a seek shows the previous picture and catches up progressively instead of blocking. Consumed
   * (or closed) by the end of the getFrame that set it up; never survives a call that produced a real
   * frame. See the retirement in `resetTo` for why export deliberately does not do this.
   */
  let staleHold: VideoFrame | null = null;
  let lastMicros = -1;
  let decodeCalls = 0;

  // ── Reverse-shuttle cache (flip blocker 3) ────────────────────────────────
  // Backward playback (J-shuttle) requests strictly DESCENDING times: the naive path resets to the
  // GOP keyframe and re-decodes the prefix for EVERY frame — quadratic in GOP length, and it
  // starved integrated GPUs during reverse shuttle. After 2 consecutive backward jumps we switch
  // to collect mode: the (single) key→target decode pass RETAINS its intermediate frames in a
  // byte-capped cache, and subsequent backward requests are served from it via cheap clone()s.
  // Any forward request resets the streak; the cache itself survives until evicted by the byte cap
  // or dispose (forward re-entry into a cached region also serves from it).
  const REVERSE_CACHE_MAX_BYTES = 64 << 20;
  let reverseCache: VideoFrame[] = []; // ascending timestamp
  let reverseCacheBytes = 0;
  let backwardStreak = 0;
  let collectReverse = false;
  // Keyframe index of the in-flight collect pass. Under the preview frame budget a single
  // key→target pass spans SEVERAL getFrame calls; a new (earlier) backward target inside the same
  // GOP must CONTINUE that pass, not resetTo() — resetting each call re-decodes the same prefix
  // forever on sparse-keyframe sources (shuttle starvation).
  let fillKeyIndex = -1;

  const frameBytes = (frame: VideoFrame) => Math.ceil(frame.codedWidth * frame.codedHeight * 1.5) || 1;

  function reverseCacheServe(micros: number): VideoFrame | null {
    for (let i = reverseCache.length - 1; i >= 0; i -= 1) {
      const frame = reverseCache[i]!;
      if (frame.timestamp <= micros) {
        // Only a hit when the frame actually covers the requested time (frame-accurate contract).
        return micros - frame.timestamp <= (frame.duration ?? 40_000) * 1.5 + 1 ? frame : null;
      }
    }
    return null;
  }

  function reverseCachePush(frame: VideoFrame, targetMicros: number) {
    // Frames arrive in ascending timestamp order during a fill; keep the array sorted regardless.
    let at = reverseCache.length;
    while (at > 0 && reverseCache[at - 1]!.timestamp > frame.timestamp) at -= 1;
    if (reverseCache[at]?.timestamp === frame.timestamp) {
      frame.close(); // duplicate (re-decode overlap) — keep the existing one
      return;
    }
    reverseCache.splice(at, 0, frame);
    reverseCacheBytes += frameBytes(frame);
    // Evict beyond the byte budget: shuttle walks DOWNWARD, so frames ABOVE the current target are
    // spent first; below-target frames evict oldest(lowest)-first only when nothing above remains.
    while (reverseCacheBytes > REVERSE_CACHE_MAX_BYTES && reverseCache.length > 1) {
      const top = reverseCache[reverseCache.length - 1]!;
      const victim = top.timestamp > targetMicros ? reverseCache.pop()! : reverseCache.shift()!;
      reverseCacheBytes -= frameBytes(victim);
      victim.close();
    }
  }

  function clearReverseCache() {
    for (const frame of reverseCache) frame.close();
    reverseCache = [];
    reverseCacheBytes = 0;
  }
  // WebCodecs invariant: after configure()/reset()/flush(), the next decode() MUST be a keyframe. All the
  // seek paths (first call, backward jump, resetTo) already point `fed` at a keyframe, but the mid-stream
  // drain/EOS flushes below do not — feeding the next delta after a flush throws DataError and (via the
  // catch) poisons the whole provider → the clip goes black. This flag makes flush-then-continue legal.
  let needKey = false;

  // keyIndices is ascending by construction (built by array index above) — binary-search the
  // largest key ≤ chunkIndex. When chunkIndex precedes the first key, return keyIndices[0]
  // (the historical clamp, preserved exactly).
  const keyAtOrBefore = (chunkIndex: number) => {
    let low = 0;
    let high = keyIndices.length - 1;
    let k = keyIndices[0]!;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (keyIndices[mid]! <= chunkIndex) {
        k = keyIndices[mid]!;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return k;
  };
  // index.timestamp is cts (presentation) order — B-frame streams aren't strictly sorted, so a
  // plain binary search is unsafe. The scan stays linear, but a FORWARD CURSOR makes monotonic
  // playback/export amortized O(1): every entry below the cursor already satisfied ts ≤ cursorMicros
  // ≤ micros, so resuming there returns the same break point the from-zero scan would (backward
  // seeks fall back to a full rescan — today's cost, today's result). Previously each getFrame
  // rescanned from 0, O(n²) across a long clip.
  let chunkCursorMicros = Number.NEGATIVE_INFINITY;
  let chunkCursorJ = 0;
  const chunkIndexForMicros = (micros: number) => {
    let j = micros >= chunkCursorMicros ? chunkCursorJ : 0;
    while (j < chunkCount && index.timestamp[j]! <= micros) j += 1;
    chunkCursorMicros = micros;
    chunkCursorJ = j;
    return Math.max(0, j - 1);
  };

  function resetTo(chunkIndex: number) {
    wcDecoderResetStats.hardReset += 1;
    try {
      decoder.reset();
      configure();
    } catch {
      failed = true;
    }
    for (const frame of queue) frame.close();
    queue.length = 0;
    if (current) {
      // PREVIEW: retire the presentable frame to `staleHold` instead of closing it (2026-07-27).
      // The frame budget below only engages once there is SOMETHING to show — and a reset used to
      // destroy exactly that, so every seek that lands outside the current GOP ran the catch-up loop
      // with NO time bound. Fast scrubbing resets on essentially every tick, in both directions, so
      // the budget was off for the whole gesture and the loop starved input for seconds (user report:
      // "scrub very fast → page isn't responding", and a 3-4s stall that self-recovers). Holding the
      // frame restores the documented contract — return it stale with its real lag and let the next
      // call continue the catch-up — for the seek case, not just mid-GOP.
      //
      // EXPORT (no frameBudgetMs) keeps closing it. Export must never present a frame from before a
      // seek: it blocks until decoded and returns null on a genuine failure so the caller can fall
      // back to <video>. Handing it a stale frame there would silently render the WRONG picture.
      if (opts.frameBudgetMs) {
        staleHold?.close();
        staleHold = current;
      } else {
        current.close();
      }
      current = null;
      currentIsClone = false;
    }
    fed = keyAtOrBefore(chunkIndex);
  }

  function consumeDecodedUpTo(micros: number): boolean {
    let consumed = false;
    while (queue.length && queue[0]!.timestamp <= micros) {
      if (current) {
        // Reverse collect mode: intermediate frames of the key→target pass are exactly what the
        // next (earlier) shuttle requests need — retain them instead of closing.
        if (collectReverse && !currentIsClone) reverseCachePush(current, micros);
        else current.close();
      }
      current = queue.shift()!;
      currentIsClone = false;
      consumed = true;
    }
    return consumed;
  }

  async function getFrame(sourceTimeSeconds: number): Promise<CanvasImageSource | null> {
    if (failed && reclaimed) {
      // Reclaimed decoders are closed for good — build a replacement and re-seek from a keyframe.
      try {
        try {
          decoder.close();
        } catch {
          /* already closed by the reclaim */
        }
        decoder = new VideoDecoder({ output: onOutput, error: onError });
        configure();
        for (const frame of queue) frame.close();
        queue.length = 0;
        lastMicros = -1; // force the keyframe re-seek below
        needKey = false;
        failed = false;
        reclaimed = false;
        if (webcodecsDebugEnabled()) {
          console.warn("[export] decoder reclaimed by the browser → recreated");
        }
      } catch {
        /* recreation failed — stay failed, caller falls back to <video> */
      }
    }
    if (failed) return null;
    const micros = Math.max(0, Math.round(sourceTimeSeconds * 1_000_000));
    // FROZEN-TAIL PROBE (debug only): chunkIndexForMicros clamps any micros past the final sample to
    // the last index entry, so getFrame keeps serving the same last frame (never null) — the tail
    // freezes without any heal/fallback firing. The guard is CHEAP arithmetic first (a compare against
    // a hoisted last-sample micros); the expensive webcodecsDebugEnabled() read only runs in the rare
    // beyond-EOF region, NEVER on the normal per-frame path. Logs once per new overshoot region.
    if (chunkCount > 0 && micros > lastSampleMicros && micros > lastLoggedOvershootMicros && webcodecsDebugEnabled()) {
      lastLoggedOvershootMicros = micros;
      console.warn(
        `[frozen-tail] getFrame(${sourceTimeSeconds.toFixed(3)}s) is past media end ` +
          `${(lastSampleMicros / 1e6).toFixed(3)}s — clamping to last sample ` +
          `(overshoot ${((micros - lastSampleMicros) / 1e6).toFixed(3)}s; samples=${chunkCount})`
      );
    }
    if (lastMicros < 0) {
      fed = keyAtOrBefore(chunkIndexForMicros(micros));
    } else if (micros + 1000 < lastMicros) {
      backwardStreak += 1;
      const cached = reverseCacheServe(micros);
      if (cached) {
        // Shuttle hit: serve a clone (the cache keeps ownership) with ZERO decode work.
        if (current) {
          if (collectReverse && !currentIsClone) reverseCachePush(current, micros);
          else current.close();
        }
        current = cached.clone();
        currentIsClone = true;
        lastMicros = micros;
        // Frame-accurate hit → the presenter must treat it as on-target (a stale high lag from the
        // catch-up call before this one would wrongly HOLD a perfectly good frame).
        lastServedLagSeconds = Math.max(0, (micros - current.timestamp) / 1e6);
        return current;
      }
      // ≥2 consecutive backward jumps = a shuttle, not a one-off seek: make this key→target
      // decode pass populate the cache so the rest of the shuttle is decode-free.
      const targetIndex = chunkIndexForMicros(micros);
      const targetKey = keyAtOrBefore(targetIndex);
      const sameGopFillInFlight = collectReverse && fillKeyIndex === targetKey && fed > fillKeyIndex;
      collectReverse = backwardStreak >= 2;
      if (!sameGopFillInFlight) {
        resetTo(targetIndex); // backward jump
        fillKeyIndex = collectReverse ? targetKey : -1;
      }
    } else {
      backwardStreak = 0;
      collectReverse = false;
      fillKeyIndex = -1;
      // FORWARD JUMP (2026-07-04, user: "move the playhead forward 20-30s, the video speeds"):
      // only backward jumps reseeked — a forward jump sequentially decoded EVERY chunk between
      // the current position and the target, budget-serving progressively advancing frames (the
      // fast-forward pan). When the target's keyframe lies BEYOND what we've fed, nothing between
      // here and that keyframe is needed — reseek. Targets within the current GOP (normal playback
      // advance, small steps) keep the sequential path, which is optimal there.
      const forwardKey = keyAtOrBefore(chunkIndexForMicros(micros));
      if (forwardKey > fed) {
        resetTo(chunkIndexForMicros(micros));
      }
    }
    lastMicros = micros;

    // Feed window. ONCE the decoder is emitting, keep it TIGHT: each pinned VideoFrame is ~6MB GPU memory,
    // and 32+ frames alongside the scene compositor's RTTs exhausted the export Worker's GPU process → "lost
    // WebGL context" + black tail. But BEFORE the first output the decoder is filling its reorder buffer
    // (B-frames / sparse keyframes) and needs MORE than 8 chunks queued to emit frame 1 — capping at 8 during
    // warmup looks like a false stall and used to trip the corrupting drain-flush below (the DataError black
    // clip). So allow a generous window until the first frame appears, then clamp.
    const OUTPUT_MAX = 8;
    // Warmup input-queue cap. History: 8 starved B-frame/sparse warmups (decoder needs >8 queued to
    // emit frame 1 — 2026-07-03 soak); raising it to 64 let short clips burst their ENTIRE stream
    // into the queue before EOS flush, which deterministically WEDGED Chromium's hardware H.264
    // decoder on hw-encoded high-profile files (flush timeout with ~27 still queued; the
    // worker-scene gate + the user's frozen-clip exports). 12 covers the reorder window without the
    // burst — the outer loop keeps feeding as outputs arrive, so TOTAL warmup feed is unbounded.
    const WARMUP_MAX = 12;
    // Preview access patterns (pool reuse across layers, non-monotonic seeks) can leave the decoder
    // demanding a keyframe MORE than once per call — a single one-shot retry poisoned the provider on
    // the 3rd demand (soak log: recovered at fed=76 and fed=152, hard-failed at fed=164). Retry as long
    // as the decoder made progress since the previous retry, bounded so a truly broken stream still
    // bails to the <video> fallback instead of looping.
    const KEY_RETRY_MAX = 8;
    let keyRetries = 0;
    let retryProgressMark = "";
    let guard = 0;
    /** The loop ran out of time budget (vs. bailing on a stall/failure) — only then may `staleHold` be served. */
    let budgetExpired = false;
    let stalledRounds = 0;
    let lastProgress = -1;
    let lastProgressAt = Date.now();
    const startedAt = Date.now();
    while (!failed && guard++ < 50000) {
      consumeDecodedUpTo(micros);
      if (queue.length > 0 && queue[queue.length - 1]!.timestamp > micros) break; // decoded past target
      // Preview time-box: a rewind on a sparse-keyframe source (e.g. 4 keys / 935 frames) can need
      // hundreds of chunks re-decoded to reach the target — blocking here froze the clip for
      // seconds. Once we HAVE a frame to show, return it stale and let the next call continue the
      // catch-up (fed/queue/lastMicros persist), so the clip pans forward progressively instead of
      // freezing. Never applied while there is nothing to show (warmup / just-reset) or for the
      // export (no budget → blocking-until-decoded).
      // `staleHold` counts as "something to show": after a seek it IS the only thing to show, and that
      // is precisely the case this budget has to cover (see resetTo).
      if (opts.frameBudgetMs && (current || queue.length || staleHold) && Date.now() - startedAt > opts.frameBudgetMs) {
        budgetExpired = true;
        break;
      }
      const MAX = outputCount === 0 ? WARMUP_MAX : OUTPUT_MAX;
      if (fed >= chunkCount) {
        try {
          // End of stream — flush to emit anything still buffered. Bounded so a stuck flush can't hang the
          // whole export at one frame near a clip's tail.
          await Promise.race([decoder.flush(), rejectAfter(5000)]);
          needKey = true; // post-flush: a later getFrame must resume from a keyframe
        } catch {
          failed = true;
        }
        break;
      }
      // Materialize the feed window from the Blob (no-op when already loaded / RAM fallback).
      try {
        await win.ensure(fed);
      } catch {
        failed = true;
        break;
      }
      let fedThisRound = false;
      while (fed < chunkCount && decoder.decodeQueueSize < MAX && queue.length < MAX) {
        // Post-flush/configure the decoder demands a keyframe first — rewind to the keyframe at/before the
        // target so we never feed a delta into a decoder that's waiting for an IDR (the DataError black-clip bug).
        if (needKey && !index.isKey[fed]) fed = keyAtOrBefore(fed);
        const chunk = win.chunkAt(fed);
        if (!chunk) break; // outside the loaded window (e.g. keyframe rewind) — outer loop re-ensures
        try {
          decoder.decode(chunk);
          decodeCalls += 1;
          if (chunk.type === "key") needKey = false;
          fed += 1;
          fedThisRound = true;
        } catch (e) {
          // "A key frame is required after configure()/flush()" — the decoder is waiting for an IDR but we fed
          // a delta (a stray flush left it needing a key). RECOVER instead of permanently failing: rewind to
          // the keyframe at/before here and retry once, so a single bad feed can't black out the whole clip.
          const keyRequired = /key frame is required/i.test((e as Error)?.message ?? "");
          const progressMark = `${outputCount}:${fed}`;
          if (keyRequired && keyRetries < KEY_RETRY_MAX && progressMark !== retryProgressMark) {
            keyRetries += 1;
            retryProgressMark = progressMark;
            needKey = true;
            fed = keyAtOrBefore(fed);
            if (webcodecsDebugEnabled()) {
              console.warn(
                `[export] decode() key-required → recovering (${keyRetries}/${KEY_RETRY_MAX}): rewind fed=${fed} outputs=${outputCount}`
              );
            }
            break; // leave the feed loop; outer loop re-enters and decodes the keyframe first
          }
          failed = true;
          if (webcodecsDebugEnabled()) {
            console.warn(
              `[export] decoder.decode() threw → failed. state=${decoder.state} qsize=${decoder.decodeQueueSize} fed=${fed}/${chunkCount} outputs=${outputCount}`,
              e
            );
          }
          break;
        }
      }
      // Progress = any new output OR any new feed this round. A healthy decoder emits PROGRESSIVELY, so it
      // keeps making progress and never trips the drain below — the bug before was force-flushing during
      // warmup (saturated input, output not started yet), which corrupted/stalled a working decoder.
      // Stall detection is TIME-based, not round-based: with the fast MessageChannel yield, "24 rounds"
      // elapses in <1ms and a healthy hardware decoder (first-frame latency can be hundreds of ms) got
      // declared stuck during warmup and bailed to <video> (2026-07-03 soak log: qsize=64 outputs=0).
      const progress = outputCount + fed;
      if (progress !== lastProgress) {
        stalledRounds = 0;
        lastProgress = progress;
        lastProgressAt = Date.now();
      } else {
        stalledRounds += 1;
      }
      const stalledMs = Date.now() - lastProgressAt;
      // Warmup (no output yet): the decoder is filling its reorder buffer, NOT stuck. The window already grew
      // to WARMUP_MAX above; do NOT flush it (flushing a warming decoder then feeding a delta is exactly the
      // "key frame is required" DataError that black-outed clips). If it's saturated with zero output for a
      // long stretch, it genuinely can't decode here → bail to the <video> fallback rather than corrupt it.
      if (outputCount === 0) {
        if (!fedThisRound && stalledRounds >= 24 && stalledMs > 1500) {
          if (webcodecsDebugEnabled()) {
            console.warn(`[export] warmup produced no output (qsize=${decoder.decodeQueueSize} fed=${fed}/${chunkCount}) → bail to <video>`);
          }
          break; // getFrame returns null → probe/caller falls back to the <video> decoder
        }
        await (fedThisRound ? yieldTask() : sleepMs(2));
        continue;
      }
      // Emitting but momentarily stuck: input saturated, zero NEW output, no progress for a real stretch of
      // time → some B-frame streams only release the tail on flush. Force ONE drain (safe now that output started).
      if (!fedThisRound && queue.length === 0 && stalledRounds >= 8 && stalledMs > 300) {
        const before = outputCount;
        try {
          await Promise.race([decoder.flush(), rejectAfter(5000)]);
          needKey = true; // post-flush: the next fed chunk must be a keyframe (see feed loop above)
        } catch {
          /* non-fatal — fall through to the bail check */
        }
        stalledRounds = 0;
        lastProgressAt = Date.now();
        if (outputCount === before) break; // flush yielded nothing → bail (probe → <video> fallback)
      }
      await (fedThisRound ? yieldTask() : sleepMs(2));
    }

    consumeDecodedUpTo(micros);
    if (!current && queue.length) {
      current = queue.shift()!;
      currentIsClone = false;
    }
    // Resolve the retired frame. It is served ONLY when the budget expired mid-catch-up — every other
    // exit (warmup bail, drain-flush yielded nothing, decode failure) must still return null so the
    // caller's null-count → <video> escape and the probe path keep working exactly as before. A real
    // frame always wins.
    if (staleHold) {
      if (current) {
        staleHold.close();
        staleHold = null;
      } else if (budgetExpired) {
        current = staleHold;
        currentIsClone = false;
        staleHold = null;
      } else {
        staleHold.close();
        staleHold = null;
      }
    }
    // Presentation-lag telemetry (FrameProvider.lastFrameLagSeconds): how far the served frame
    // trails THIS request. Non-zero only on the time-sliced preview path (budget expired mid
    // catch-up → stale frame returned); export blocks until decoded so it stays 0 there.
    lastServedLagSeconds = current ? Math.max(0, (micros - current.timestamp) / 1e6) : 0;
    if (!current && webcodecsDebugEnabled()) {
      console.warn(
        `[export] getFrame → null. failed=${failed} state=${decoder.state} qsize=${decoder.decodeQueueSize} queue=${queue.length} fed=${fed}/${chunkCount} outputs=${outputCount} micros=${micros} guard=${guard}`
      );
    }
    return current;
  }

  // Served-frame lag of the most recent getFrame (see the assignment at its return; declared before
  // the probe call below so the first assignment isn't a TDZ error).
  let lastServedLagSeconds = 0;

  // Probe-decode the first frame BEFORE committing to this provider. configure() can succeed for a codec
  // the decoder then can't actually decode in this context (e.g. a Worker without HW accel), which used to
  // surface as a BLACK export (every getFrame returned null). If the probe yields no frame, bail to null so
  // createFrameProvider falls back to the native <video> decoder (via WEBCODECS_REQUIRED_NO_DOM in a Worker).
  const probe = await getFrame(0).catch(() => null);
  if (failed || !probe) {
    console.warn(
      `[export] WebCodecs probe-decode produced no frame → <video> fallback. outputs=${outputCount} state=${decoder.state} failed=${failed} qsize=${decoder.decodeQueueSize} firstChunkKey=${Boolean(index.isKey[0])}`
    );
    for (const frame of queue) frame.close();
    queue.length = 0;
    (current as VideoFrame | null)?.close();
    current = null;
    clearReverseCache();
    try {
      decoder.close();
    } catch {
      /* already closed */
    }
    win.dispose();
    // Bailing to the <video> fallback drops the index too — credit it back, or a session that
    // probe-fails a few sources reports index bytes for providers that never existed.
    indexCharged = false;
    residency.indexBytes -= chunkCount * INDEX_BYTES_PER_SAMPLE;
    residency.indexSamples -= chunkCount;
    return null;
  }
  // Do NOT reset after the probe: `getFrame(0)` already decoded frame 0 and left the decoder positioned
  // exactly where the export begins (`current` = frame 0, `lastMicros` = 0, read-ahead frames queued), so the
  // first real getFrame reuses it and forward-decodes from there. A `decoder.reset()` here tears the decoder
  // down to "unconfigured" mid-flight and corrupts the FIRST GOP — invisible on multi-keyframe clips (they
  // recover at the next IDR) but fatal on a SINGLE-keyframe clip, which then renders black after a frame or two.

  // Nominal source frame rate from the sample table: median presentation-timestamp delta over the
  // first ~120 samples (median is robust to B-frame reorder and a stray VFR outlier). Consumers that
  // RESAMPLE the source (the ingest-proxy transcode) use this to sample at the source's own cadence —
  // a hardcoded 30fps grid over 24fps content duplicated every 4th frame (visible judder, 2026-07-04).
  // COUNT-BASED cadence: total samples across the composition-time (cts) span. Do NOT use a median of
  // adjacent *decode-order* cts deltas — that is fooled by B-frame reorder: a 30fps B-pyramid source
  // decodes as forward cts jumps of 2 and 5 frames with negative jumps between (the B-frames), so the
  // positive-delta median lands on ~4 frames and reports ~7.5fps. The proxy transcode then RESAMPLED to
  // that bogus rate → a ~8fps stop-motion proxy off clean 30fps footage (2026-07-24). Using min/max cts
  // over the whole index is reorder-invariant: for CFR it is the exact rate; for VFR it is the average,
  // which is what the uniform-grid proxy resample wants (frameCount ≈ source sample count, 1:1 mapping).
  let nominalFps: number | undefined;
  {
    let minCts = Infinity;
    let maxCts = -Infinity;
    for (let i = 0; i < chunkCount; i += 1) {
      const ts = index.timestamp[i]!;
      if (ts < minCts) minCts = ts;
      if (ts > maxCts) maxCts = ts;
    }
    const spanSec = (maxCts - minCts) / 1_000_000;
    if (index.length >= 4 && spanSec > 0) {
      const fps = (index.length - 1) / spanSec; // (N-1) intervals between first and last presentation ts
      if (Number.isFinite(fps) && fps >= 5 && fps <= 240) nominalFps = fps;
    }
  }

  // ── Container display rotation (phone footage) ───────────────────────────
  // Decoded frames are CODED orientation; the tkhd matrix says how to display them. Bake the
  // quarter-turn into a reused 2D canvas so EVERY consumer of this provider (export compositor,
  // preview frame pool, ingest-proxy transcode) sees display-oriented pixels and dims — matching
  // the <video> fallback provider, which the browser auto-rotates. rotation 0 (the common case)
  // takes the untouched raw-VideoFrame path below.
  let rotateCanvas: OffscreenCanvas | null = null;
  let rotateCtx: OffscreenCanvasRenderingContext2D | null = null;
  function rotateForDisplay(frame: VideoFrame): CanvasImageSource | null {
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    const outW = rotationDegrees % 180 === 0 ? w : h;
    const outH = rotationDegrees % 180 === 0 ? h : w;
    if (!rotateCanvas || rotateCanvas.width !== outW || rotateCanvas.height !== outH) {
      rotateCanvas = new OffscreenCanvas(outW, outH);
      rotateCtx = rotateCanvas.getContext("2d");
    }
    if (!rotateCtx) return frame; // no 2D context — serve unrotated rather than nothing
    rotateCtx.setTransform(1, 0, 0, 1, 0, 0);
    rotateCtx.translate(outW / 2, outH / 2);
    rotateCtx.rotate((rotationDegrees * Math.PI) / 180);
    rotateCtx.drawImage(frame, -w / 2, -h / 2, w, h);
    rotateCtx.setTransform(1, 0, 0, 1, 0, 0);
    return rotateCanvas;
  }

  const displaySize = () => {
    const w = current?.displayWidth ?? trackW;
    const h = current?.displayHeight ?? trackH;
    return rotationDegrees % 180 === 0 ? { w, h } : { w: h, h: w };
  };

  // True decodable end from the sample table — see FrameProvider.decodableEndSeconds. The proxy
  // build clamps to this so overshooting duration metadata can never bake a frozen tail again.
  const decodableEndSeconds =
    chunkCount > 0 ? Math.max(0, (index.timestamp[chunkCount - 1]! + index.duration[chunkCount - 1]!) / 1_000_000) : undefined;

  const provider: FrameProvider = {
    get width() {
      return displaySize().w;
    },
    get height() {
      return displaySize().h;
    },
    nominalFps,
    decodableEndSeconds,
    getFrame:
      rotationDegrees === 0
        ? getFrame
        : async (sourceTimeSeconds: number) => {
            const frame = await getFrame(sourceTimeSeconds);
            return frame instanceof VideoFrame ? rotateForDisplay(frame) : frame;
          },
    get lastFrameLagSeconds() {
      return lastServedLagSeconds;
    },
    dispose() {
      for (const frame of queue) frame.close();
      queue.length = 0;
      if (current) {
        current.close();
        current = null;
      }
      staleHold?.close();
      staleHold = null;
      clearReverseCache();
      try {
        decoder.close();
      } catch {
        /* already closed */
      }
      win.dispose();
      if (indexCharged) {
        indexCharged = false; // dispose() is called more than once on some teardown paths
        residency.indexBytes -= chunkCount * INDEX_BYTES_PER_SAMPLE;
        residency.indexSamples -= chunkCount;
      }
    },
  };
  // Gate/soak telemetry only (not part of the FrameProvider contract): total decoder.decode()
  // calls — the reverse-shuttle gate asserts a cached shuttle stays near ~1 GOP of decode work.
  Object.defineProperty(provider, "__wcDecodeCalls", {
    configurable: true,
    get: () => decodeCalls,
  });
  return provider;
}
