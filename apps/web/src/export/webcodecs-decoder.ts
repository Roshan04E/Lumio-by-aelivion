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

export async function createWebCodecsVideoSource(url: string): Promise<FrameProvider | null> {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return null;

  let buffer: ArrayBuffer;
  try {
    // Abort a stalled fetch so a never-settling network/blob read falls back to the <video> provider
    // (or fails cleanly) instead of hanging the export at "Loading media…".
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      buffer = await (await fetch(url, { signal: controller.signal, cache: "no-store" })).arrayBuffer();
    } finally {
      clearTimeout(timer);
    }
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
  console.log(`[export] webcodecs: ${samples.length} chunks, ${syncCount} sync, codec="${track.codec}", desc=${description ? `${description.length}B` : "none"}`);
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

  async function getFrame(sourceTimeSeconds: number): Promise<CanvasImageSource | null> {
    if (failed) return null;
    const micros = Math.max(0, Math.round(sourceTimeSeconds * 1_000_000));
    if (lastMicros < 0) {
      fed = keyAtOrBefore(chunkIndexForMicros(micros));
    } else if (micros + 1000 < lastMicros) {
      resetTo(chunkIndexForMicros(micros)); // backward jump
    }
    lastMicros = micros;

    // Look-ahead / pinned-frame budget. Export reads forward one frame at a time, so a small window is
    // plenty — and each pinned VideoFrame is GPU memory (~6MB at 1080p). 32 frames (~190MB) alongside the
    // scene compositor's RTTs was exhausting the export Worker's GPU process → "lost WebGL context" + black
    // tail. 8 keeps decode fed without the pressure.
    const MAX = 8;
    let guard = 0;
    let stalledRounds = 0;
    let lastProgress = -1;
    while (!failed && guard++ < 50000) {
      if (queue.length > 0 && queue[queue.length - 1]!.timestamp > micros) break; // decoded past target
      if (fed >= chunks.length) {
        try {
          // End of stream — flush to emit anything still buffered. Bounded so a stuck flush can't hang the
          // whole export at one frame near a clip's tail.
          await Promise.race([decoder.flush(), rejectAfter(5000)]);
        } catch {
          failed = true;
        }
        break;
      }
      let fedThisRound = false;
      while (fed < chunks.length && decoder.decodeQueueSize < MAX && queue.length < MAX) {
        try {
          decoder.decode(chunks[fed++]!);
          fedThisRound = true;
        } catch {
          failed = true;
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
      // Genuinely stuck: input saturated, zero output, no progress for several rounds → the decoder is
      // buffering and only emits on flush (some B-frame streams). Force ONE drain. Non-fatal: if it still
      // produces nothing, give up to the <video> fallback rather than killing a decoder that just warmed
      // up slowly.
      if (!fedThisRound && queue.length === 0 && stalledRounds >= 8) {
        const before = outputCount;
        try {
          await Promise.race([decoder.flush(), rejectAfter(5000)]);
        } catch {
          /* non-fatal — fall through to the bail check */
        }
        stalledRounds = 0;
        if (outputCount === before) break; // flush yielded nothing → bail (probe → <video> fallback)
      }
      await yieldTask();
    }

    while (queue.length && queue[0]!.timestamp <= micros) {
      if (current) current.close();
      current = queue.shift()!;
    }
    if (!current && queue.length) current = queue.shift()!;
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
