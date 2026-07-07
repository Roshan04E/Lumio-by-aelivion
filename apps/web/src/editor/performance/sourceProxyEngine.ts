/**
 * Source-proxy transcode engine: builds the per-asset ingest proxies described in
 * sourceProxyStore.ts (Premiere's proxy model — small file, dense keyframes, edit-invariant).
 *
 * Recipe: H.264 MP4, long edge ≤854 (~480p), 30fps, keyframe EVERY SECOND (the whole point:
 * playhead drops land within ~15 delta frames of a sync point), AAC audio when the source has an
 * audio track (so the proxy is a drop-in for every preview consumer — viewer modal, audio layers,
 * hover scrub — not just the video path).
 *
 * Scheduling: one transcode at a time, FIFO, entirely background. The decode side runs
 * `preferSoftware` so it never competes with playback for the ~3 hardware decoder sessions; the
 * encode side keeps the hardware encoder (idle during preview). Every frame round-trips through
 * awaited promises + a periodic breather sleep, so the main thread stays responsive.
 *
 * Consumers call `ensureSourceProxy(asset, onReady)`. Fast path: a valid persisted proxy resolves
 * from OPFS immediately. Slow path: the asset joins the queue and `onReady` fires (possibly many
 * minutes later) with a session object URL to patch into `SourceAsset.proxyUrl`. Failures are
 * remembered per-asset for the session (no retry storms). Telemetry: `window.__rfSourceProxy`.
 */

import { getAssetBlobStore } from "../../lib/asset-blob-store";
import { createFrameProvider } from "../../export/source-decoder";
import { MediaEncoder } from "../../export/video-encoder";
import { markHotSpot } from "../../lib/perfDiagnostics";
import { getSourceProxy, saveSourceProxy, sourceProxyStoreAvailable } from "./sourceProxyStore";
import type { SourceProxyWorkerRequest, SourceProxyWorkerResponse } from "./sourceProxyWorkerProtocol";
import type { SourceAsset } from "@lumio-by-aelivion/shared";

const PROXY_LONG_EDGE = 854; // ≈480p — Premiere-ballpark ingest proxy size for phone-vertical media
const PROXY_FPS = 30;
const PROXY_KEYFRAME_S = 1;
const PROXY_BITS_PER_PIXEL_FRAME = 0.1;
/** Below this the original is already cheap to decode — don't spend a transcode on it. */
const MIN_SOURCE_BYTES = 12 * 1024 * 1024;
/** Safety cap: don't background-transcode an hour-long screen recording in v1. */
const MAX_SOURCE_DURATION_S = 15 * 60;
/** Longer breather every N frames so a busy tab never feels the transcode. */
const BREATHER_EVERY_FRAMES = 30;
const BREATHER_MS = 15;
/** Audio encode yields every N chunks so it never holds the main thread (was a ~1s freeze/clip). */
const AUDIO_YIELD_EVERY_CHUNKS = 24;

/**
 * Release the main thread so QUEUED tasks — crucially the user's input handlers — can run between
 * units of transcode work. MessageChannel, not setTimeout(0): browsers clamp nested timeouts to ~4ms
 * and we want to yield after EVERY frame without pacing the transcode into the ground. `scheduler.yield`
 * (Chromium) is even better — it yields at a lower priority so input pre-empts us — so prefer it.
 */
const yieldToMain: () => Promise<void> = (() => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") {
    return () => scheduler.yield!();
  }
  if (typeof MessageChannel === "undefined") {
    return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const channel = new MessageChannel();
  let pending: Array<() => void> = [];
  channel.port1.onmessage = () => {
    const callbacks = pending;
    pending = [];
    for (const cb of callbacks) cb();
  };
  return () =>
    new Promise<void>((resolve) => {
      pending.push(resolve);
      channel.port2.postMessage(0);
    });
})();

interface SourceProxyStats {
  built: number;
  failed: number;
  skipped: number;
  queued: number;
  active: string | null;
  lastBuildMs: number;
  recent: Array<{ assetId: string; outcome: "built" | "failed" | "skipped"; ms: number; note?: string }>;
}

function stats(): SourceProxyStats {
  const w = window as unknown as { __rfSourceProxy?: SourceProxyStats };
  return (w.__rfSourceProxy ??= { built: 0, failed: 0, skipped: 0, queued: 0, active: null, lastBuildMs: 0, recent: [] });
}

function record(assetId: string, outcome: "built" | "failed" | "skipped", ms: number, note?: string): void {
  const s = stats();
  s[outcome === "built" ? "built" : outcome === "failed" ? "failed" : "skipped"] += 1;
  s.lastBuildMs = Math.round(ms);
  s.recent.push({ assetId, outcome, ms: Math.round(ms), ...(note ? { note } : {}) });
  if (s.recent.length > 20) s.recent.shift();
  try {
    if (localStorage.getItem("lumio.perfLog") === "1") {
      console.info(`[source-proxy] ${assetId}: ${outcome}${note ? ` (${note})` : ""} in ${Math.round(ms)}ms`);
    }
  } catch {
    /* ignore */
  }
}

type ReadyCallback = (assetId: string, proxyUrl: string) => void;

// COLD-ORIGIN SIGNAL (2026-07-06): fires ONCE per session, the first time a REAL transcode starts
// (rehydrations and skips don't count) — a fresh browser origin (e.g. the vite-preview :4173 build,
// whose OPFS is separate from dev's :5173) has no proxies yet, and the UI shows a passive
// "optimizing media" notice so softer first-session playback is expected, not alarming.
let firstBuildNotified = false;
let firstBuildListener: (() => void) | null = null;
export function setSourceProxyFirstBuildListener(listener: (() => void) | null): void {
  firstBuildListener = listener;
}
function notifyFirstBuild(): void {
  if (firstBuildNotified) return;
  firstBuildNotified = true;
  firstBuildListener?.();
}

// SUSPEND (2026-07-06, supersedes the full-quality-only rule): builds park during ANY playback —
// on a cold origin the build started the moment play did and starved the live decode path (the
// build-only "plays ~4s then freezes" report). EditorPage suspends the engine whenever isPlaying;
// builds resume on pause. Checked between builds AND inside the frame loop (worker builds get the
// flag forwarded as a message), so an in-flight transcode parks within one frame.
let buildSuspended = false;
const suspendListeners = new Set<(suspended: boolean) => void>();
export function setSourceProxyBuildSuspended(suspended: boolean): void {
  buildSuspended = suspended;
  for (const notify of suspendListeners) notify(suspended);
}
async function waitWhileSuspended(): Promise<void> {
  while (buildSuspended) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Session memory: settled assets (built / permanently skipped / failed) + in-queue ids.
const settled = new Set<string>();
const inQueue = new Set<string>();
const queue: Array<{ asset: SourceAsset; onReady: ReadyCallback }> = [];
let draining = false;

/**
 * Make sure `asset` has an ingest proxy: resolves an existing one immediately, otherwise queues a
 * background transcode. `onReady` fires at most once, only on success. Safe to call repeatedly
 * (idempotent per session).
 */
export function ensureSourceProxy(asset: SourceAsset, onReady: ReadyCallback): void {
  if (settled.has(asset.id) || inQueue.has(asset.id)) return;
  if (!asset.fileType?.startsWith("video/")) {
    settled.add(asset.id);
    return;
  }
  inQueue.add(asset.id);
  queue.push({ asset, onReady });
  stats().queued = queue.length;
  if (!draining) {
    draining = true;
    // Start the drain only when the tab is IDLE, so a background transcode never lands on top of the
    // user's initial open-and-edit burst. requestIdleCallback fires when the main thread has spare
    // time (and re-checks each build via the same gate through drainQueue → whenIdle); a timeout
    // fallback guarantees it still runs on browsers without rIC.
    whenIdle(() => void drainQueue());
  }
}

/** Resolve when the main thread is idle (requestIdleCallback), or after a short fallback delay. */
function whenIdle(run: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (typeof ric === "function") {
    ric(run, { timeout: 4000 });
  } else {
    setTimeout(run, 1500);
  }
}

async function drainQueue(): Promise<void> {
  try {
    if (!(await sourceProxyStoreAvailable())) {
      // No OPFS → feature off for this session; mark everything settled so we don't loop.
      for (const item of queue.splice(0)) {
        settled.add(item.asset.id);
        inQueue.delete(item.asset.id);
      }
      return;
    }
    while (queue.length > 0) {
      const item = queue.shift()!;
      stats().queued = queue.length;
      // Wait for an idle window before starting each build so an active editing burst always wins
      // the main thread; the per-frame yields inside buildOne keep it responsive once running.
      await new Promise<void>((resolve) => whenIdle(resolve));
      await waitWhileSuspended();
      stats().active = item.asset.id;
      const started = performance.now();
      try {
        const url = await buildOne(item.asset);
        if (url) {
          record(item.asset.id, "built", performance.now() - started);
          item.onReady(item.asset.id, url);
        }
      } catch (error) {
        record(item.asset.id, "failed", performance.now() - started, error instanceof Error ? error.message : String(error));
      } finally {
        settled.add(item.asset.id);
        inQueue.delete(item.asset.id);
        stats().active = null;
      }
    }
  } finally {
    draining = false;
    // Work may have arrived while the tail of the loop ran.
    if (queue.length > 0 && !draining) {
      draining = true;
      void drainQueue();
    }
  }
}

/** Returns the proxy URL, or null when skipped (already settled via `record`). Throws on failure. */
async function buildOne(asset: SourceAsset): Promise<string | null> {
  const store = await getAssetBlobStore();
  let blob = await store.getBlob(asset.id);
  let sourceUrl = blob ? await store.getObjectUrl(asset.id) : null;
  let revokeSourceUrl = false;
  if (!blob) {
    // Server-hosted asset (API upload / stock download): the bytes live behind an http URL, not in
    // the on-device store. Fetch them ONCE for the transcode — the 2026-07-04 soak showed every
    // real project asset skipping as "no local bytes" because this path didn't exist.
    const remote = asset.fileUrl && /^https?:/i.test(asset.fileUrl) ? asset.fileUrl : null;
    if (!remote) {
      record(asset.id, "skipped", 0, "no local bytes");
      return null;
    }
    // Cheap pre-check via HEAD-ish metadata: a persisted proxy validates against byte size, so we
    // need the size anyway — and downloading a below-threshold file just to skip it is waste.
    try {
      const response = await fetch(remote);
      if (!response.ok) throw new Error(`fetch ${response.status}`);
      blob = await response.blob();
    } catch (error) {
      record(asset.id, "skipped", 0, `fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    sourceUrl = URL.createObjectURL(blob);
    revokeSourceUrl = true;
  }
  try {
    return await buildFromBlob(asset, blob, sourceUrl);
  } finally {
    if (revokeSourceUrl && sourceUrl) URL.revokeObjectURL(sourceUrl);
  }
}

async function buildFromBlob(asset: SourceAsset, blob: Blob, sourceUrl: string | null): Promise<string | null> {
  // Fast path: a previous session already built it.
  const existing = await getSourceProxy(asset.id, blob.size);
  if (existing) {
    record(asset.id, "built", 0, "rehydrated");
    return existing.url;
  }
  if (blob.size < MIN_SOURCE_BYTES) {
    record(asset.id, "skipped", 0, "source small enough");
    return null;
  }
  if (!sourceUrl) {
    record(asset.id, "skipped", 0, "no object url");
    return null;
  }

  const meta = await probeMetadata(sourceUrl);
  if (!meta) {
    record(asset.id, "skipped", 0, "metadata probe failed");
    return null;
  }
  if (meta.durationSeconds > MAX_SOURCE_DURATION_S) {
    record(asset.id, "skipped", 0, `too long (${Math.round(meta.durationSeconds)}s)`);
    return null;
  }
  const scale = Math.min(1, PROXY_LONG_EDGE / Math.max(meta.width, meta.height));
  if (scale >= 1 && blob.size < MIN_SOURCE_BYTES * 2) {
    // Already at/below proxy resolution and not huge — the original decodes fine.
    record(asset.id, "skipped", 0, "already proxy-sized");
    return null;
  }
  const width = Math.max(2, Math.round((meta.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((meta.height * scale) / 2) * 2);

  // Past every skip/fast path — a real transcode is about to start (cold-origin UX signal).
  notifyFirstBuild();

  // Audio first (cheap — decodeAudioData is internally off-thread — and tells the muxer whether to
  // open an audio track at all). Decoded HERE because AudioContext can't run in a Worker; the PCM
  // planes are copied and transferred to the worker.
  const audio = await decodeAudioTrack(blob);

  // WORKER-FIRST (2026-07-06): the decode→scale→encode body runs in sourceProxy.worker.ts so a build
  // can never hold the editor's main thread (root of the build-only playback freeze). Fall back to
  // the in-page loop below only for infrastructure failures — WebCodecs can't open the source inside
  // the worker (no <video> fallback there) or the worker chunk failed to boot. Deterministic build
  // failures (frozen-tail guard, no frames) rethrow: the fallback decodes through the same
  // WebCodecs-first path and would fail identically after doubling the work.
  let encoded: TranscodeResult;
  try {
    encoded = await transcodeInWorker(sourceUrl, meta.durationSeconds, width, height, audio);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/WEBCODECS_REQUIRED_NO_DOM|WORKER_CRASHED/.test(message)) {
      throw error;
    }
    try {
      if (localStorage.getItem("lumio.perfLog") === "1") {
        console.info(`[source-proxy] ${asset.id}: worker unavailable (${message}) — main-thread fallback`);
      }
    } catch {
      /* ignore */
    }
    // The transferred PCM planes are detached now — re-decode audio for the fallback.
    encoded = await transcodeOnMainThread(sourceUrl, meta.durationSeconds, width, height, await decodeAudioTrack(blob));
  }
  const url = await saveSourceProxy(
    {
      assetId: asset.id,
      sourceByteSize: blob.size,
      width,
      height,
      durationSeconds: encoded.encodedFrames / encoded.fps,
      hasAudio: Boolean(audio),
    },
    encoded.blob
  );
  if (!url) throw new Error("proxy persist failed");
  return url;
}

interface TranscodeResult {
  blob: Blob;
  encodedFrames: number;
  fps: number;
}

/** Run the transcode body in the dedicated worker; suspension changes are forwarded live. */
function transcodeInWorker(
  sourceUrl: string,
  durationSeconds: number,
  width: number,
  height: number,
  audio: DecodedAudio | null
): Promise<TranscodeResult> {
  return new Promise<TranscodeResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./sourceProxy.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(new Error(`WORKER_CRASHED: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const onSuspend = (suspended: boolean) =>
      worker.postMessage({ type: "suspend", suspended } satisfies SourceProxyWorkerRequest);
    suspendListeners.add(onSuspend);
    const cleanup = () => {
      suspendListeners.delete(onSuspend);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<SourceProxyWorkerResponse>) => {
      const message = event.data;
      cleanup();
      if (message.type === "done") {
        resolve({
          blob: new Blob([message.buffer], { type: message.mime || "video/mp4" }),
          encodedFrames: message.encodedFrames,
          fps: message.fps,
        });
      } else {
        reject(new Error(message.message || "source-proxy worker failed"));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(`WORKER_CRASHED: ${event.message || "source-proxy worker crashed"}`));
    };
    // Copy the PCM planes before transferring: getChannelData views alias the AudioBuffer's own
    // memory — transferring those buffers would detach the decoder's internals.
    const transfer: Transferable[] = [];
    let audioPayload: { sampleRate: number; channels: number; frames: number; planes: ArrayBuffer[] } | null = null;
    if (audio) {
      const planes = audio.planes.map((plane) => plane.slice().buffer as ArrayBuffer);
      audioPayload = { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, planes };
      transfer.push(...planes);
    }
    worker.postMessage(
      {
        type: "start",
        payload: {
          sourceUrl,
          width,
          height,
          durationSeconds,
          maxFps: PROXY_FPS,
          keyFrameIntervalSeconds: PROXY_KEYFRAME_S,
          bitsPerPixelFrame: PROXY_BITS_PER_PIXEL_FRAME,
          audio: audioPayload,
          suspended: buildSuspended,
        },
      } satisfies SourceProxyWorkerRequest,
      transfer
    );
  });
}

/** Main-thread fallback (sources the worker's WebCodecs path can't open). Same recipe + guards. */
async function transcodeOnMainThread(
  sourceUrl: string,
  durationSeconds: number,
  width: number,
  height: number,
  audio: DecodedAudio | null
): Promise<TranscodeResult> {
  // Software decode: never steal a hardware session from live playback.
  const provider = await createFrameProvider(sourceUrl, "video", { preferSoftware: true });
  // Sample at the SOURCE's own cadence (capped at PROXY_FPS): forcing 24fps content onto a hardcoded
  // 30fps grid duplicated every 4th frame — a visible judder/jerk the user caught by eye (2026-07-04).
  // At source fps every proxy frame maps 1:1 to a real source frame, and shorter sources need fewer
  // decode round-trips. The <video> fallback provider has no nominalFps → keep PROXY_FPS.
  const fps = Math.min(PROXY_FPS, provider.nominalFps ?? PROXY_FPS);
  const encoder = new MediaEncoder({
    width,
    height,
    fps,
    format: "mp4",
    videoBitrate: Math.round(width * height * fps * PROXY_BITS_PER_PIXEL_FRAME),
    keyFrameIntervalSeconds: PROXY_KEYFRAME_S,
    audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels } : undefined,
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { desynchronized: true });
    if (!ctx) throw new Error("no 2d context for proxy scale");

    // FROZEN-TAIL GUARD: once the decoder fails mid-file (corrupt sample, decoder error) getFrame
    // returns null FOREVER — the old loop kept encoding the stale canvas, baking a video that plays
    // and then freezes into a photo INTO THE PROXY ITSELF (Venice soak, 2026-07-04: "played till
    // ~22s then stuck like a photo till the last"). A brief null gap (≤ ~0.5s) is tolerated as a
    // held frame; a longer run within the body of the clip ABORTS the build — no proxy at all beats
    // a corrupt proxy, playback simply keeps using the original. Nulls in the last quarter-second
    // (duration metadata often overshoots the sample table) end the encode cleanly instead.
    const maxNullRun = Math.max(2, Math.ceil(fps * 0.5));
    let nullRun = 0;
    let decodedAny = false;
    const frameCount = Math.max(1, Math.ceil(durationSeconds * fps));
    let encodedFrames = 0;
    for (let i = 0; i < frameCount; i += 1) {
      // Parks an in-flight transcode within one frame when playback starts (see
      // setSourceProxyBuildSuspended); resumes exactly here on pause. The audio pre-decode is a
      // single non-interruptible decodeAudioData call — if play starts during it, it finishes
      // (sub-second) and the build parks at frame 0.
      await waitWhileSuspended();
      const frame = await provider.getFrame(i / fps);
      if (frame) {
        nullRun = 0;
        decodedAny = true;
        ctx.drawImage(frame as CanvasImageSource, 0, 0, width, height);
      } else {
        nullRun += 1;
        if (decodedAny && i / fps > durationSeconds - 0.25) {
          break; // tail overshoot — finish with what we have
        }
        if (nullRun > maxNullRun) {
          throw new Error(`decoder stopped producing frames at ~${(i / fps).toFixed(1)}s — aborted (frozen-tail guard)`);
        }
      }
      await encoder.addVideoFrame(canvas, i);
      encodedFrames += 1;
      // Yield after EVERY frame so the transcode never holds the main thread longer than one frame's
      // work — the user's clicks/scrubs interleave instead of waiting behind a batch. A longer
      // setTimeout breather every N frames additionally lets the browser do paint/GC.
      await yieldToMain();
      if (i % BREATHER_EVERY_FRAMES === 0) {
        await new Promise((resolve) => setTimeout(resolve, BREATHER_MS));
      }
    }
    if (!decodedAny) {
      throw new Error("decoder produced no frames — aborted");
    }
    if (audio) {
      await feedAudio(encoder, audio);
    }
    const proxyBlob = await encoder.finalize();
    return { blob: proxyBlob, encodedFrames, fps };
  } catch (error) {
    encoder.dispose();
    throw error;
  } finally {
    provider.dispose();
  }
}

async function probeMetadata(url: string): Promise<{ width: number; height: number; durationSeconds: number } | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("metadata timeout")), 15_000);
      video.addEventListener(
        "loadedmetadata",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      video.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("metadata error"));
        },
        { once: true }
      );
    });
    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0) {
      return null;
    }
    return { width: video.videoWidth, height: video.videoHeight, durationSeconds: video.duration };
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

interface DecodedAudio {
  sampleRate: number;
  channels: number;
  planes: Float32Array[];
  frames: number;
}

/** Decode the source's audio track to 48k PCM (≤2 channels). Null = no usable audio. */
async function decodeAudioTrack(blob: Blob): Promise<DecodedAudio | null> {
  if (typeof OfflineAudioContext === "undefined") return null;
  try {
    const started = performance.now();
    const buffer = await new OfflineAudioContext(2, 1, 48_000).decodeAudioData(await blob.arrayBuffer());
    markHotSpot("source-proxy-audio-decode", started, `${Math.round(buffer.duration)}s`);
    if (!buffer.length) return null;
    const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
    const planes: Float32Array[] = [];
    for (let c = 0; c < channels; c += 1) {
      planes.push(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
    }
    return { sampleRate: buffer.sampleRate, channels, planes, frames: buffer.length };
  } catch {
    return null; // no audio track (or undecodable) — video-only proxy
  }
}

/**
 * Push the decoded PCM through the AAC encoder in planar chunks. ASYNC + yields every
 * AUDIO_YIELD_EVERY_CHUNKS: a 2-min clip is ~1600 chunks, and running them back-to-back froze the
 * main thread for ~1s per proxy (the "unknown" long tasks that correlated 1:1 with builds). Yielding
 * lets the user's input interleave so a background build never stutters the editor.
 */
async function feedAudio(encoder: MediaEncoder, audio: DecodedAudio): Promise<void> {
  const CHUNK = 4096;
  let chunkIndex = 0;
  for (let offset = 0; offset < audio.frames; offset += CHUNK) {
    const frames = Math.min(CHUNK, audio.frames - offset);
    const data = new Float32Array(frames * audio.channels);
    for (let c = 0; c < audio.channels; c += 1) {
      const plane = audio.planes[c];
      if (plane) data.set(plane.subarray(offset, offset + frames), c * frames);
    }
    encoder.encodeAudio(
      new AudioData({
        format: "f32-planar",
        sampleRate: audio.sampleRate,
        numberOfFrames: frames,
        numberOfChannels: audio.channels,
        timestamp: Math.round((offset / audio.sampleRate) * 1_000_000),
        data,
      })
    );
    if (++chunkIndex % AUDIO_YIELD_EVERY_CHUNKS === 0) {
      await yieldToMain();
    }
  }
}
