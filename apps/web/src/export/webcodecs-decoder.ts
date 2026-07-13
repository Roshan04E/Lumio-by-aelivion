/**
 * Local export — fast source decode via WebCodecs + mp4box (Phase L3).
 *
 * Replaces per-frame <video> seeking (the dominant export cost) with a forward, bounded
 * `VideoDecoder` fed from an mp4box demux. Export reads time monotonically, so we decode
 * forward and hold the current frame; a backward jump (a new clip starting earlier in the
 * same source) resets to the nearest keyframe. Returns null when the file can't be
 * demuxed/decoded so the caller falls back to the <video> provider.
 *
 * STREAMING DEMUX (wcDecode flip blocker 1): the source is held as a disk-backed Blob
 * (`response.blob()` — Chromium spools large bodies to disk), NOT a RAM ArrayBuffer. mp4box
 * only ever sees the byte ranges needed to parse the sample TABLE (moov; `appendBuffer`'s
 * return value jumps over mdat for moov-at-end files), and encoded chunks are materialized
 * on demand from `blob.slice()` in a bounded window around the feed position. Peak RAM is
 * O(one GOP window), not O(file), which is what a 4GB machine needs when the preview pool
 * (`preview-frame-pool.ts`) runs this same provider on the UI thread.
 * Fragmented MP4s (empty sample table, moof-driven) fall back to a full sequential
 * extraction pass — rare for user uploads, and still cheaper than v1 because mp4box's
 * internal buffers are released as chunks are captured.
 */

import { createFile, DataStream, type MP4File, type MP4VideoTrackInfo } from "mp4box";
import { rotationFromMatrix, type SourceRotation } from "./source-color";
import type { FrameProvider } from "./source-decoder";

/** Disk-backed source Blobs (browser spools to disk); LRU so long sessions can't pin every source. */
const sourceBlobCache = new Map<string, Promise<Blob>>();
const SOURCE_BLOB_CACHE_MAX = 12;

/** Which demux path providers took this session — asserted by the wc-decoder gate + soak telemetry. */
export const wcDecoderStats = { streaming: 0, fragmented: 0 };

/** One demuxed sample-table entry — metadata only, bytes stay in the Blob until windowed in. */
interface SampleIndexEntry {
  offset: number;
  size: number;
  timestamp: number; // micros
  duration: number; // micros
  isKey: boolean;
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
      if (window.localStorage?.getItem("kimera.exportDecodeDebug") === "1" || window.localStorage?.getItem("kimera.exportGlDebug") === "1") {
        return true;
      }
    }
  } catch {
    /* no window/localStorage */
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_EXPORT_DECODE_DEBUG === "1" || env?.VITE_EXPORT_DECODE_DEBUG === "true";
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
        return await response.blob();
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
    }
  } else {
    // LRU refresh: re-insert on hit so the busiest sources survive eviction.
    sourceBlobCache.delete(url);
    sourceBlobCache.set(url, cached);
  }
  return cached;
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

async function appendBlobSlice(file: MP4File, blob: Blob, start: number, end: number): Promise<number> {
  const part = (await blob.slice(start, end).arrayBuffer()) as ArrayBuffer & { fileStart: number };
  part.fileStart = start;
  const next = file.appendBuffer(part);
  return typeof next === "number" ? next : 0;
}

interface DemuxedIndex {
  track: MP4VideoTrackInfo;
  description: Uint8Array | undefined;
  index: SampleIndexEntry[];
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
async function demuxIndex(blob: Blob): Promise<DemuxedIndex | null> {
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
    const index: SampleIndexEntry[] = samples.map((sample, i) => ({
      offset: sample.offset ?? 0,
      size: sample.size ?? 0,
      timestamp: toMicros(sample.cts),
      duration: toMicros(sample.duration),
      isKey: sample.is_sync || (syncCount === 0 && i === 0),
    }));
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
  blob: Blob,
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
  const index: SampleIndexEntry[] = ramChunks.map((chunk) => ({
    offset: 0,
    size: chunk.byteLength,
    timestamp: chunk.timestamp,
    duration: chunk.duration ?? 0,
    isKey: chunk.type === "key",
  }));
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

function createBlobChunkWindow(blob: Blob, index: SampleIndexEntry[]): ChunkWindow {
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
      const first = index[from]!;
      let spanStart = first.offset;
      let spanEnd = first.offset + first.size;
      let to = from + 1;
      while (to < index.length && to - from < WINDOW_MAX_SAMPLES) {
        const s = index[to]!;
        const nextStart = Math.min(spanStart, s.offset);
        const nextEnd = Math.max(spanEnd, s.offset + s.size);
        if (nextEnd - nextStart > WINDOW_MAX_SPAN_BYTES && to > from + 1) break;
        spanStart = nextStart;
        spanEnd = nextEnd;
        to += 1;
      }
      const buffer = await blob.slice(spanStart, spanEnd).arrayBuffer();
      const next = new Map<number, EncodedVideoChunk>();
      for (let i = from; i < to; i += 1) {
        const s = index[i]!;
        next.set(
          i,
          new EncodedVideoChunk({
            type: s.isKey ? "key" : "delta",
            timestamp: s.timestamp,
            duration: s.duration,
            data: new Uint8Array(buffer, s.offset - spanStart, s.size),
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
  let blob: Blob;
  try {
    blob = typeof blobOrUrl === "string" ? await fetchSourceBlob(blobOrUrl) : blobOrUrl;
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
  const last = demuxed.index[demuxed.index.length - 1]!;
  const endMicros = last.timestamp + Math.max(0, last.duration);
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

  let blob: Blob;
  try {
    blob = await fetchSourceBlob(url);
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

  const keyIndices: number[] = [];
  index.forEach((entry, i) => {
    if (entry.isKey) keyIndices.push(i);
  });
  if (!keyIndices.length) keyIndices.push(0);

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
  const lastSampleMicros = chunkCount > 0 ? index[chunkCount - 1]!.timestamp : 0;
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
  // index[].timestamp is cts (presentation) order — B-frame streams aren't strictly sorted, so a
  // plain binary search is unsafe. The scan stays linear, but a FORWARD CURSOR makes monotonic
  // playback/export amortized O(1): every entry below the cursor already satisfied ts ≤ cursorMicros
  // ≤ micros, so resuming there returns the same break point the from-zero scan would (backward
  // seeks fall back to a full rescan — today's cost, today's result). Previously each getFrame
  // rescanned from 0, O(n²) across a long clip.
  let chunkCursorMicros = Number.NEGATIVE_INFINITY;
  let chunkCursorJ = 0;
  const chunkIndexForMicros = (micros: number) => {
    let j = micros >= chunkCursorMicros ? chunkCursorJ : 0;
    while (j < chunkCount && index[j]!.timestamp <= micros) j += 1;
    chunkCursorMicros = micros;
    chunkCursorJ = j;
    return Math.max(0, j - 1);
  };

  function resetTo(chunkIndex: number) {
    try {
      decoder.reset();
      configure();
    } catch {
      failed = true;
    }
    for (const frame of queue) frame.close();
    queue.length = 0;
    if (current) {
      current.close();
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
      if (opts.frameBudgetMs && (current || queue.length) && Date.now() - startedAt > opts.frameBudgetMs) break;
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
        if (needKey && !index[fed]!.isKey) fed = keyAtOrBefore(fed);
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
      `[export] WebCodecs probe-decode produced no frame → <video> fallback. outputs=${outputCount} state=${decoder.state} failed=${failed} qsize=${decoder.decodeQueueSize} firstChunkKey=${index[0]?.isKey}`
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
  let nominalFps: number | undefined;
  {
    const deltas: number[] = [];
    for (let i = 1; i < Math.min(index.length, 121); i += 1) {
      const delta = index[i]!.timestamp - index[i - 1]!.timestamp;
      if (delta > 0) deltas.push(delta);
    }
    if (deltas.length >= 4) {
      deltas.sort((a, b) => a - b);
      const fps = 1_000_000 / deltas[deltas.length >> 1]!;
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

  const provider: FrameProvider = {
    get width() {
      return displaySize().w;
    },
    get height() {
      return displaySize().h;
    },
    nominalFps,
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
      clearReverseCache();
      try {
        decoder.close();
      } catch {
        /* already closed */
      }
      win.dispose();
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
