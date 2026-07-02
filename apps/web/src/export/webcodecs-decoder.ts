/**
 * Local export — fast source decode via WebCodecs + mp4box (Phase L3).
 *
 * Replaces per-frame <video> seeking (the dominant export cost) with a forward, bounded
 * `VideoDecoder` fed from an mp4box demux. Export reads time monotonically, so we decode
 * forward and hold the current frame; a backward jump (a new clip starting earlier in the
 * same source) resets to the nearest keyframe. Returns null when the file can't be
 * demuxed/decoded so the caller falls back to the <video> provider.
 */

import { createFile, DataStream, type MP4File, type MP4Sample, type MP4VideoTrackInfo } from "mp4box";
import type { FrameProvider } from "./source-decoder";

const videoBufferCache = new Map<string, Promise<ArrayBuffer>>();

function webcodecsDebugEnabled(): boolean {
  try {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("exportDecodeDebug") === "1" || params.get("exportGlDebug") === "1") return true;
      if (window.localStorage?.getItem("lumio.exportDecodeDebug") === "1" || window.localStorage?.getItem("lumio.exportGlDebug") === "1") {
        return true;
      }
    }
  } catch {
    /* no window/localStorage */
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_EXPORT_DECODE_DEBUG === "1" || env?.VITE_EXPORT_DECODE_DEBUG === "true";
}

function fetchVideoBuffer(url: string): Promise<ArrayBuffer> {
  let cached = videoBufferCache.get(url);
  if (!cached) {
    cached = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        return await (await fetch(url, { signal: controller.signal, cache: "no-store" })).arrayBuffer();
      } finally {
        clearTimeout(timer);
      }
    })().catch((error) => {
      videoBufferCache.delete(url);
      throw error;
    });
    videoBufferCache.set(url, cached);
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

export async function createWebCodecsVideoSource(
  url: string,
  opts: { preferSoftware?: boolean } = {}
): Promise<FrameProvider | null> {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return null;

  let buffer: ArrayBuffer;
  try {
    // Abort a stalled fetch so a never-settling network/blob read falls back to the <video> provider
    // (or fails cleanly) instead of hanging the export at "Loading media…".
    buffer = (await fetchVideoBuffer(url)).slice(0);
  } catch {
    return null;
  }

  const file = createFile();
  const samples: MP4Sample[] = [];
  const ready = new Promise<{ track: MP4VideoTrackInfo; description: Uint8Array | undefined }>((resolve, reject) => {
    file.onError = (error) => reject(new Error(error));
    file.onReady = (info) => {
      const track = info.videoTracks?.[0];
      if (!track) {
        reject(new Error("no video track"));
        return;
      }
      resolve({ track, description: getDescription(file, track.id) });
    };
  });
  file.onSamples = (_id, _user, list) => {
    for (const sample of list) samples.push(sample);
  };

  const view = buffer as ArrayBuffer & { fileStart: number };
  view.fileStart = 0;
  let track: MP4VideoTrackInfo;
  let description: Uint8Array | undefined;
  try {
    file.appendBuffer(view);
    file.flush();
    const resolved = await Promise.race([ready, rejectAfter(8000)]);
    track = resolved.track;
    description = resolved.description;
    file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples || 1_000_000 });
    file.start();
    file.flush();
    file.stop();
  } catch {
    return null;
  }
  if (!samples.length) return null;

  const timescale = track.timescale || 1;
  const toMicros = (t: number) => Math.round((t / timescale) * 1_000_000);
  // Some demuxes don't flag sync samples (no `stss` box → every `is_sync` is false). Feeding the decoder
  // all-"delta" chunks means it silently waits forever for a keyframe and emits nothing (no frame, no error)
  // → the reported black/slow-fallback. If NO sample is flagged sync, assume the first is a keyframe so the
  // decoder can start (the probe still falls back if that assumption is wrong for this file).
  const syncCount = samples.reduce((n, s) => n + (s.is_sync ? 1 : 0), 0);
  if (webcodecsDebugEnabled()) {
    console.log(`[export] webcodecs: ${samples.length} chunks, ${syncCount} sync, codec="${track.codec}", desc=${description ? `${description.length}B` : "none"}`);
  }
  const chunks = samples.map(
    (sample, i) =>
      new EncodedVideoChunk({
        type: sample.is_sync || (syncCount === 0 && i === 0) ? "key" : "delta",
        timestamp: toMicros(sample.cts),
        duration: toMicros(sample.duration),
        data: sample.data,
      })
  );
  samples.length = 0;

  const keyIndices: number[] = [];
  chunks.forEach((chunk, index) => {
    if (chunk.type === "key") keyIndices.push(index);
  });
  if (!keyIndices.length) keyIndices.push(0);

  const trackW = track.video?.width ?? track.track_width ?? 0;
  const trackH = track.video?.height ?? track.track_height ?? 0;

  const queue: VideoFrame[] = [];
  let failed = false;
  let outputCount = 0;
  const decoder = new VideoDecoder({
    output: (frame) => {
      outputCount += 1;
      queue.push(frame);
    },
    error: (e) => {
      failed = true;
      console.warn("[export] VideoDecoder error:", (e as Error)?.message ?? e);
    },
  });
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
  let lastMicros = -1;
  // WebCodecs invariant: after configure()/reset()/flush(), the next decode() MUST be a keyframe. All the
  // seek paths (first call, backward jump, resetTo) already point `fed` at a keyframe, but the mid-stream
  // drain/EOS flushes below do not — feeding the next delta after a flush throws DataError and (via the
  // catch) poisons the whole provider → the clip goes black. This flag makes flush-then-continue legal.
  let needKey = false;

  const keyAtOrBefore = (chunkIndex: number) => {
    let k = keyIndices[0]!;
    for (const ki of keyIndices) {
      if (ki <= chunkIndex) k = ki;
      else break;
    }
    return k;
  };
  const chunkIndexForMicros = (micros: number) => {
    let index = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      if (chunks[i]!.timestamp <= micros) index = i;
      else break;
    }
    return index;
  };
  const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
    }
    fed = keyAtOrBefore(chunkIndex);
  }

  function consumeDecodedUpTo(micros: number): boolean {
    let consumed = false;
    while (queue.length && queue[0]!.timestamp <= micros) {
      if (current) current.close();
      current = queue.shift()!;
      consumed = true;
    }
    return consumed;
  }

  async function getFrame(sourceTimeSeconds: number): Promise<CanvasImageSource | null> {
    if (failed) return null;
    const micros = Math.max(0, Math.round(sourceTimeSeconds * 1_000_000));
    if (lastMicros < 0) {
      fed = keyAtOrBefore(chunkIndexForMicros(micros));
    } else if (micros + 1000 < lastMicros) {
      resetTo(chunkIndexForMicros(micros)); // backward jump
    }
    lastMicros = micros;

    // Feed window. ONCE the decoder is emitting, keep it TIGHT: each pinned VideoFrame is ~6MB GPU memory,
    // and 32+ frames alongside the scene compositor's RTTs exhausted the export Worker's GPU process → "lost
    // WebGL context" + black tail. But BEFORE the first output the decoder is filling its reorder buffer
    // (B-frames / sparse keyframes) and needs MORE than 8 chunks queued to emit frame 1 — capping at 8 during
    // warmup looks like a false stall and used to trip the corrupting drain-flush below (the DataError black
    // clip). So allow a generous window until the first frame appears, then clamp.
    const OUTPUT_MAX = 8;
    const WARMUP_MAX = 64;
    let keyRetryDone = false;
    let guard = 0;
    let stalledRounds = 0;
    let lastProgress = -1;
    while (!failed && guard++ < 50000) {
      consumeDecodedUpTo(micros);
      if (queue.length > 0 && queue[queue.length - 1]!.timestamp > micros) break; // decoded past target
      const MAX = outputCount === 0 ? WARMUP_MAX : OUTPUT_MAX;
      if (fed >= chunks.length) {
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
      let fedThisRound = false;
      while (fed < chunks.length && decoder.decodeQueueSize < MAX && queue.length < MAX) {
        // Post-flush/configure the decoder demands a keyframe first — rewind to the keyframe at/before the
        // target so we never feed a delta into a decoder that's waiting for an IDR (the DataError black-clip bug).
        if (needKey && chunks[fed]!.type !== "key") fed = keyAtOrBefore(fed);
        const chunk = chunks[fed]!;
        try {
          decoder.decode(chunk);
          if (chunk.type === "key") needKey = false;
          fed += 1;
          fedThisRound = true;
        } catch (e) {
          // "A key frame is required after configure()/flush()" — the decoder is waiting for an IDR but we fed
          // a delta (a stray flush left it needing a key). RECOVER instead of permanently failing: rewind to
          // the keyframe at/before here and retry once, so a single bad feed can't black out the whole clip.
          const keyRequired = /key frame is required/i.test((e as Error)?.message ?? "");
          if (keyRequired && !keyRetryDone) {
            keyRetryDone = true;
            needKey = true;
            fed = keyAtOrBefore(fed);
            if (webcodecsDebugEnabled()) {
              console.warn(`[export] decode() key-required → recovering: rewind fed=${fed} outputs=${outputCount}`);
            }
            break; // leave the feed loop; outer loop re-enters and decodes the keyframe first
          }
          failed = true;
          if (webcodecsDebugEnabled()) {
            console.warn(
              `[export] decoder.decode() threw → failed. state=${decoder.state} qsize=${decoder.decodeQueueSize} fed=${fed}/${chunks.length} outputs=${outputCount}`,
              e
            );
          }
          break;
        }
      }
      // Progress = any new output OR any new feed this round. A healthy decoder emits PROGRESSIVELY, so it
      // keeps making progress and never trips the drain below — the bug before was force-flushing during
      // warmup (saturated input, output not started yet), which corrupted/stalled a working decoder.
      const progress = outputCount + fed;
      if (progress !== lastProgress) {
        stalledRounds = 0;
        lastProgress = progress;
      } else {
        stalledRounds += 1;
      }
      // Warmup (no output yet): the decoder is filling its reorder buffer, NOT stuck. The window already grew
      // to WARMUP_MAX above; do NOT flush it (flushing a warming decoder then feeding a delta is exactly the
      // "key frame is required" DataError that black-outed clips). If it's saturated with zero output for a
      // long stretch, it genuinely can't decode here → bail to the <video> fallback rather than corrupt it.
      if (outputCount === 0) {
        if (!fedThisRound && stalledRounds >= 24) {
          if (webcodecsDebugEnabled()) {
            console.warn(`[export] warmup produced no output (qsize=${decoder.decodeQueueSize} fed=${fed}/${chunks.length}) → bail to <video>`);
          }
          break; // getFrame returns null → probe/caller falls back to the <video> decoder
        }
        await yieldTask();
        continue;
      }
      // Emitting but momentarily stuck: input saturated, zero NEW output, no progress for several rounds →
      // some B-frame streams only release the tail on flush. Force ONE drain (safe now that output started).
      if (!fedThisRound && queue.length === 0 && stalledRounds >= 8) {
        const before = outputCount;
        try {
          await Promise.race([decoder.flush(), rejectAfter(5000)]);
          needKey = true; // post-flush: the next fed chunk must be a keyframe (see feed loop above)
        } catch {
          /* non-fatal — fall through to the bail check */
        }
        stalledRounds = 0;
        if (outputCount === before) break; // flush yielded nothing → bail (probe → <video> fallback)
      }
      await yieldTask();
    }

    consumeDecodedUpTo(micros);
    if (!current && queue.length) current = queue.shift()!;
    if (!current && webcodecsDebugEnabled()) {
      console.warn(
        `[export] getFrame → null. failed=${failed} state=${decoder.state} qsize=${decoder.decodeQueueSize} queue=${queue.length} fed=${fed}/${chunks.length} outputs=${outputCount} micros=${micros} guard=${guard}`
      );
    }
    return current;
  }

  // Probe-decode the first frame BEFORE committing to this provider. configure() can succeed for a codec
  // the decoder then can't actually decode in this context (e.g. a Worker without HW accel), which used to
  // surface as a BLACK export (every getFrame returned null). If the probe yields no frame, bail to null so
  // createFrameProvider falls back to the native <video> decoder (via WEBCODECS_REQUIRED_NO_DOM in a Worker).
  const probe = await getFrame(0).catch(() => null);
  if (failed || !probe) {
    console.warn(
      `[export] WebCodecs probe-decode produced no frame → <video> fallback. outputs=${outputCount} state=${decoder.state} failed=${failed} qsize=${decoder.decodeQueueSize} firstChunkType=${chunks[0]?.type}`
    );
    for (const frame of queue) frame.close();
    queue.length = 0;
    (current as VideoFrame | null)?.close();
    current = null;
    try {
      decoder.close();
    } catch {
      /* already closed */
    }
    return null;
  }
  // Do NOT reset after the probe: `getFrame(0)` already decoded frame 0 and left the decoder positioned
  // exactly where the export begins (`current` = frame 0, `lastMicros` = 0, read-ahead frames queued), so the
  // first real getFrame reuses it and forward-decodes from there. A `decoder.reset()` here tears the decoder
  // down to "unconfigured" mid-flight and corrupts the FIRST GOP — invisible on multi-keyframe clips (they
  // recover at the next IDR) but fatal on a SINGLE-keyframe clip, which then renders black after a frame or two.

  return {
    get width() {
      return current?.displayWidth ?? trackW;
    },
    get height() {
      return current?.displayHeight ?? trackH;
    },
    getFrame,
    dispose() {
      for (const frame of queue) frame.close();
      queue.length = 0;
      if (current) {
        current.close();
        current = null;
      }
      try {
        decoder.close();
      } catch {
        /* already closed */
      }
    },
  };
}
