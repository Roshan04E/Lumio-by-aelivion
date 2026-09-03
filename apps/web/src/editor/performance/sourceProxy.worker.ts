/**
 * Source-proxy transcode Worker.
 *
 * Runs the decode → downscale → encode body of an ingest-proxy build entirely off the main thread
 * (2026-07-06: the main-thread transcode starving live playback on a cold origin was the root of
 * the build-only "plays ~4s then freezes"). The main-thread engine (sourceProxyEngine.ts) still
 * owns the queue, the <video> metadata probe, the audio PCM pre-decode, and OPFS persistence — this
 * worker receives a fetchable source URL + optional transferred PCM and returns the encoded bytes.
 *
 * WebCodecs-only in here: `createFrameProvider`'s <video> fallback needs the DOM, so it throws
 * WEBCODECS_REQUIRED_NO_DOM — the engine catches that and re-runs the build on the main thread
 * (same contract as the export worker).
 */

import { createFrameProvider } from "../../export/source-decoder";
import { MediaEncoder } from "../../export/video-encoder";
import {
  decodeSegment,
  descriptionFromBase64,
  descriptionToBase64,
  encodeSegment,
  segmentToChunks,
  type SegmentChunkMeta,
  type SegmentHeader,
} from "./sourceProxySegments";
import type { SourceProxyWorkerPayload, SourceProxyWorkerRequest, SourceProxyWorkerResponse } from "./sourceProxyWorkerProtocol";

interface WorkerScope {
  postMessage(message: SourceProxyWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SourceProxyWorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let aborted = false;
let suspended = false;

class ProxyBuildAborted extends Error {
  constructor() {
    super("source-proxy build aborted");
    this.name = "ProxyBuildAborted";
  }
}

/**
 * Park between frames while the engine has playback suspended. The awaited sleep returns control to
 * the worker's event loop, so suspend/abort messages keep landing while we wait.
 */
async function waitWhileSuspended(): Promise<void> {
  while (suspended && !aborted) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (aborted) throw new ProxyBuildAborted();
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "abort") {
    aborted = true;
    return;
  }
  if (message.type === "suspend") {
    suspended = message.suspended;
    return;
  }
  if (message.type !== "start") return;
  suspended = message.payload.suspended;
  void (async () => {
    try {
      const result = await build(message.payload);
      scope.postMessage(
        {
          type: "done",
          buffer: result.buffer,
          mime: result.mime,
          encodedFrames: result.encodedFrames,
          fps: result.fps,
          decodableEndSeconds: result.decodableEndSeconds
        },
        [result.buffer]
      );
    } catch (error) {
      scope.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        aborted: aborted || error instanceof ProxyBuildAborted,
        // A wedged-then-RESET encoder is recoverable by construction, and this worker cannot resume in
        // place — see the note at the `addVideoFrame` call. Flag it so the engine re-queues the asset
        // (bounded) instead of settling it as a permanent failure and stranding the clip on its
        // original, which is what happened to 2 of 11 assets in the 2026-08-17 11x4K measurement.
        retryable: error instanceof Error && error.name === "EncoderStallRecoveredError"
      });
    }
  })();
};

async function build(
  payload: SourceProxyWorkerPayload
): Promise<{ buffer: ArrayBuffer; mime: string; encodedFrames: number; fps: number; decodableEndSeconds: number | undefined }> {
  const { sourceUrl, width, height, durationSeconds, maxFps, keyFrameEveryNFrames, bitsPerPixelFrame, audio } = payload;
  const segmentFrames = Math.max(1, Math.floor(payload.segmentFrames || 0));
  // Asserted, not trusted: a segment boundary that is not a keyframe means a resume splices the
  // live encoder in mid-GOP, producing a proxy that plays then breaks up. Fall back to one segment
  // (i.e. today's all-or-nothing behaviour) rather than emit a cache that could corrupt a rebuild.
  const segmentsUsable = segmentFrames > 0 && segmentFrames % keyFrameEveryNFrames === 0;
  // Software decode: never steal a hardware session from live playback (proxy playback keeps running
  // on the main thread while we build here). Throws WEBCODECS_REQUIRED_NO_DOM for sources the
  // WebCodecs path can't open — the engine falls back to the main thread for those.
  const provider = await createFrameProvider(sourceUrl, "video", { preferSoftware: true });
  // Sample at the SOURCE's own cadence (capped): forcing 24fps content onto a hardcoded 30fps grid
  // duplicated every 4th frame — a visible judder the user caught by eye (2026-07-04). Unknown
  // cadence assumes 30, NOT the cap — a 60 grid would duplicate every frame of 30fps footage.
  const fps = Math.min(maxFps, provider.nominalFps ?? 30);
  // FRAME-BASED GOP (2026-07-25): keyframe every N FRAMES, converted to the encoder's seconds interval
  // using the FINAL fps. A fixed-seconds GOP (old 1s) put the keyframe fps×1 frames back, so catch-up
  // decode in the WebCodecs preview pool scaled with fps and froze 60/120fps proxy playback (the
  // decoder can't grind 60 inter-frames/s in realtime). Frames-based keeps the nearest keyframe ≤ N
  // frames away at ANY fps → catch-up cost is flat → high-fps proxies play (frame-dropped) without
  // freezing, while the file keeps every frame for export/slow-mo.
  const keyFrameIntervalSeconds = keyFrameEveryNFrames / fps;
  // DIAGNOSTIC (2026-07-24): a stock proxy came back ~8fps stop-motion off a real 30fps source. This
  // one line exposes the detected source cadence vs the encode cadence so a "Rebuild proxy" from the
  // Source Viewer shows whether nominalFps under-read (detection bug) or the encode is the culprit.
  console.info(
    `[proxy] nominalFps=${provider.nominalFps ?? "undef"} → encode @ ${fps} fps · ${width}×${height} · GOP=${keyFrameEveryNFrames}f/${keyFrameIntervalSeconds.toFixed(3)}s · dur=${durationSeconds.toFixed(2)}s · decodableEnd=${provider.decodableEndSeconds?.toFixed(2) ?? "undef"}s`
  );
  // SEGMENT CACHE (2026-08-11, Slice 1) + PLAYHEAD-FIRST ORDER (Slice 2). One encoder for the whole
  // build — the chunks are TAPPED on their way out and grouped into fixed frame-count segments. See
  // sourceProxySegments.ts for why the cache holds chunks rather than N finalized MP4s.
  //
  // Slice 2 defers muxing: segments may now be produced in ANY source order (playhead first, gaps
  // filled from cache), so the muxer is fed once at the end, in logical segment order. This is not
  // an extra copy of the bitstream — the bytes live in `segments` instead of the muxer's buffer, and
  // are released segment by segment as they are muxed, so the two always sum to one bitstream.
  interface SegmentContent {
    header: SegmentHeader;
    payloads: Uint8Array[];
  }
  const segments = new Map<number, SegmentContent>();
  let segmentChunkMeta: SegmentChunkMeta[] = [];
  let segmentPayloads: Uint8Array[] = [];
  let firstDescriptionBase64: string | undefined;
  let firstCodec: string | undefined;
  let firstColorSpace: VideoColorSpaceInit | undefined;
  // Chunk bookkeeping is per RUN (a contiguous forward walk of segments). Reset at each run start,
  // which is safe because the encoder is flushed at every run boundary.
  let runFirstSegment = 0;
  let runChunkCount = 0;

  /**
   * Seal the buffered chunks as one segment: keep it for the final mux AND hand it to the engine to
   * persist for a future resume.
   *
   * Segmentation is driven by the CHUNK STREAM, not the frame-submission loop. `addVideoFrame` only
   * enqueues — the encoder's output lags submission by up to its queue depth (8) — so counting
   * submitted frames drifts off the segment grid, which silently (a) collided segment indices and
   * (b) put boundaries on non-keyframes. There is exactly one chunk per frame and chunks arrive in
   * order within a run, so the Nth chunk of a run IS the Nth frame of that run: counting chunks
   * makes every boundary land on an exact multiple of `segmentFrames`, and therefore — since that is
   * a multiple of the GOP — always on a keyframe.
   *
   * `encodeSegment` copies the payloads into the blob, so the arrays retained here survive the
   * transfer of that blob to the engine.
   */
  const flushSegment = (segmentIndex: number, startFrame: number, endFrame: number): void => {
    if (!segmentsUsable || segmentChunkMeta.length === 0) return;
    const header: SegmentHeader = {
      assetId: payload.assetId,
      sourceByteSize: payload.sourceByteSize,
      version: payload.recipeVersion,
      segmentIndex,
      startFrame,
      endFrame,
      fps,
      width,
      height,
      descriptionBase64: firstDescriptionBase64,
      codec: firstCodec,
      colorSpace: firstColorSpace,
      chunks: segmentChunkMeta,
    };
    const content: SegmentContent = { header, payloads: segmentPayloads };
    segments.set(segmentIndex, content);
    segmentChunkMeta = [];
    segmentPayloads = [];
    const blob = encodeSegment(header, content.payloads);
    void blob.arrayBuffer().then((buffer) => {
      scope.postMessage({ type: "segment", segmentIndex, buffer } as SourceProxyWorkerResponse, [buffer]);
    });
  };

  const encoder = new MediaEncoder({
    width,
    height,
    fps,
    format: "mp4",
    // Sublinear fps scaling (recipe v7): consecutive frames at high fps are more similar, so
    // temporal compression needs fewer bits/frame — √(30/fps) keeps 60fps proxies at ~√2× the
    // 30fps size instead of 2× with no visible quality change. ≤30fps sources are unaffected.
    videoBitrate: Math.round(width * height * fps * bitsPerPixelFrame * Math.min(1, Math.sqrt(30 / fps))),
    keyFrameIntervalSeconds,
    audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels } : undefined,
    ...(segmentsUsable
      ? {
          // Deferred mux: chunks are only tapped here. `muxAllSegments` feeds the muxer at the end,
          // in logical order, so the build order above it is free to be anything.
          deferVideoMux: true,
          onEncodedVideoChunk: (chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined): void => {
            if (!firstDescriptionBase64 && meta?.decoderConfig) {
              firstDescriptionBase64 = descriptionToBase64(meta.decoderConfig.description);
              firstCodec = meta.decoderConfig.codec;
              firstColorSpace = meta.decoderConfig.colorSpace;
            }
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            segmentChunkMeta.push({
              type: chunk.type,
              timestamp: chunk.timestamp,
              duration: chunk.duration ?? null,
              byteLength: bytes.length,
            });
            segmentPayloads.push(bytes);
            runChunkCount += 1;
            if (segmentChunkMeta.length >= segmentFrames) {
              const segmentIndex = runFirstSegment + Math.floor((runChunkCount - 1) / segmentFrames);
              const startFrame = segmentIndex * segmentFrames;
              flushSegment(segmentIndex, startFrame, startFrame + segmentFrames);
            }
          },
        }
      : {}),
  });
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context for proxy scale");

    // FROZEN-TAIL GUARD (ported verbatim from the main-thread build — do not weaken): once the
    // decoder fails mid-file, getFrame returns null FOREVER — encoding the stale canvas past that
    // point bakes a plays-then-freezes-like-a-photo corruption INTO THE PROXY (Venice soak
    // 2026-07-04). A brief null gap (≤ ~0.5s) is tolerated as a held frame; a longer run within the
    // body of the clip ABORTS the build — no proxy beats a corrupt proxy. Nulls in the last
    // quarter-second (duration metadata often overshoots the sample table) end the encode cleanly.
    const maxNullRun = Math.max(2, Math.ceil(fps * 0.5));
    let decodedAny = false;
    // DECODABLE-END CLAMP (2026-07-13, keep in sync with sourceProxyEngine.ts): asset duration
    // metadata can OVERSHOOT the sample table (historically up to ~1s via the ceil-to-Int asset
    // column). Past the last sample getFrame CLAMPS to the final frame — never null — so the
    // null-based frozen-tail guard below can't see it and the repeats bake into the proxy.
    // Clamp the frame loop to the demuxed truth instead of trusting the metadata.
    const decodableEnd = provider.decodableEndSeconds;
    const effectiveDuration =
      decodableEnd !== undefined && decodableEnd > 0.2 && decodableEnd < durationSeconds ? decodableEnd : durationSeconds;
    const frameCount = Math.max(1, Math.ceil(effectiveDuration * fps));

    // The grid the BUILD LOOP walks. With segmentation disabled (a `segmentFrames` that is not a
    // multiple of the GOP — see `segmentsUsable`) there is no grid: the whole file is one run, which
    // is the pre-segment code path verbatim. Using `segmentFrames` here regardless would silently
    // truncate that fallback's output to one segment's worth of frames.
    const runGridFrames = segmentsUsable ? segmentFrames : frameCount;
    const totalSegments = segmentsUsable ? Math.max(1, Math.ceil(frameCount / segmentFrames)) : 1;

    // RESUME: adopt every cached segment the engine vouched for — no decode, no re-encode. Slice 2
    // made the cache SPARSE (playhead-first order leaves gaps), so this is a set, not a prefix.
    // Anything unreadable here is simply not adopted and gets rebuilt below.
    if (segmentsUsable) {
      for (const entry of payload.resumeSegments) {
        const parsed = await decodeSegment(new Blob([entry.buffer]));
        if (!parsed) continue;
        if (parsed.header.segmentIndex !== entry.index || parsed.header.startFrame !== entry.index * segmentFrames) continue;
        if (parsed.header.endFrame > frameCount) continue; // built against a longer clamp — rebuild it
        segments.set(entry.index, { header: parsed.header, payloads: parsed.payloads });
        // The cached frames ARE decoded content; they just were not decoded this session. Without
        // this a resume that only needs the tail would trip the "produced no frames" check.
        decodedAny = true;
      }
    }
    const resumedFrames = [...segments.values()].reduce((sum, s) => sum + s.payloads.length, 0);

    // BUILD ORDER (Slice 2). Missing segments, playhead's segment first, forward to the end, then
    // wrapping to the head. See the protocol's `playheadSeconds` for why forward-wrap rather than
    // strictly alternating outward.
    const missing: number[] = [];
    for (let s = 0; s < totalSegments; s += 1) if (!segments.has(s)) missing.push(s);
    const playheadFrame =
      payload.playheadSeconds === null || !Number.isFinite(payload.playheadSeconds)
        ? 0
        : Math.max(0, Math.min(frameCount - 1, Math.round(payload.playheadSeconds * fps)));
    const startSegment = Math.min(totalSegments - 1, Math.floor(playheadFrame / segmentFrames));
    const ordered = [...missing.filter((s) => s >= startSegment), ...missing.filter((s) => s < startSegment)];
    // Group into contiguous runs: within a run the walk is forward and the encoder needs no restart,
    // so the common case (playhead at 0, nothing cached) is ONE run — byte-for-byte the old loop.
    const runs: Array<{ start: number; end: number }> = [];
    for (const s of ordered) {
      const last = runs[runs.length - 1];
      if (last && s === last.end + 1) last.end = s;
      else runs.push({ start: s, end: s });
    }
    if (startSegment > 0 || segments.size > 0) {
      console.info(
        `[proxy] build order: ${runs.length} run(s) from segment ${startSegment} of ${totalSegments}` +
          `${segments.size > 0 ? ` — ${segments.size} cached (${resumedFrames} frames) reused` : ""}`
      );
    }

    let encodedFrames = resumedFrames;
    // Frames past this point do not exist in the source (tail overshoot). Only ever moves down, and
    // only ever from within the last segment.
    let tailEndFrame = frameCount;
    for (let r = 0; r < runs.length; r += 1) {
      const run = runs[r]!;
      // Non-contiguous continuation: the next timestamp jumps backwards, which WebCodecs does not
      // take. Flush + reset + reconfigure resets the baseline and forces an IDR.
      if (r > 0) await encoder.restartVideoEncoder();
      runFirstSegment = run.start;
      runChunkCount = 0;
      segmentChunkMeta = [];
      segmentPayloads = [];
      // FROZEN-TAIL GUARD, RESTATED PER RUN (Slice 2). "The decoder stopped producing frames" only
      // means anything across a CONTIGUOUS forward walk — a null at the start of a new run follows a
      // seek, not the previous run's last frame, so carrying the counter across would let a normal
      // post-seek gap accumulate into a false truncation. The guard's strength is unchanged inside a
      // run, which is where a real mid-file decoder failure shows up.
      let nullRun = 0;
      const from = run.start * runGridFrames;
      const to = Math.min(frameCount, (run.end + 1) * runGridFrames);
      let stoppedAt = to;
      for (let i = from; i < to; i += 1) {
        // Parks an in-flight build the moment playback starts (engine forwards suspend messages);
        // resumes exactly here on pause. Also the abort exit.
        await waitWhileSuspended();
        const frame = await provider.getFrame(i / fps);
        if (aborted) throw new ProxyBuildAborted();
        if (frame) {
          nullRun = 0;
          decodedAny = true;
          ctx.drawImage(frame as CanvasImageSource, 0, 0, width, height);
        } else {
          nullRun += 1;
          // Tail overshoot — the metadata duration runs past the sample table. Ends THIS RUN only
          // (out-of-order building means later runs still have real frames to encode), and the
          // condition is absolute source time, so it can only ever fire inside the last segment.
          //
          // The old form also required `decodedAny`, i.e. "we have seen a real frame THIS SESSION".
          // Under playhead-first order the tail can be the FIRST thing built, so that clause turned a
          // legitimate end into a frozen-tail abort purely because of build order. The degenerate
          // case it was guarding — a source that decodes nothing at all — is caught unchanged by the
          // `!decodedAny` check after every run, which does not depend on order.
          if (i / fps > effectiveDuration - 0.25) {
            stoppedAt = i;
            break;
          }
          if (nullRun > maxNullRun) {
            throw new Error(`decoder stopped producing frames at ~${(i / fps).toFixed(1)}s — aborted (frozen-tail guard)`);
          }
        }
        // WEDGE RESUME DOES NOT TRANSFER TO THIS PATH, and pretending it does would be a defect.
        // `EncoderStallRecoveredError.resumeFrameIndex` is the encoder's MUXED CHUNK COUNT. On the
        // in-order paths (export-core, the main-thread transcode) that count equals the next frame
        // index, so rewinding the loop to it is exact. Here runs are built OUT OF ORDER
        // (playhead-first), so a muxed-chunk count does not identify a source frame at all and
        // rewinding `i` to it could land outside the current run entirely. So this path does not
        // resume: the error propagates, the engine re-queues the asset (bounded), and the rebuild is
        // cheap because completed segments persist in the segment cache.
        await encoder.addVideoFrame(canvas, i);
        encodedFrames += 1;
        // Live feedback (2026-07-18, user report: silent builds read as a hang): a throttled progress
        // ping the engine forwards to the editor's notice line. Every 30 frames ≈ once a second.
        if (encodedFrames % 30 === 0) {
          scope.postMessage({ type: "progress", encodedFrames, totalFrames: frameCount });
        }
      }
      // Drain before reading `runChunkCount` — the tap lags submission by up to the queue depth, so
      // the leftover below is only complete once every frame of this run has come out.
      await encoder.flushVideo();
      if (segmentChunkMeta.length > 0) {
        // A short final segment. Only legitimate at the very end of the file: a mid-file run spans
        // whole segments by construction, so leftovers there would mean the run was cut short.
        const segmentIndex = runFirstSegment + Math.floor(runChunkCount / segmentFrames);
        const startFrame = segmentIndex * segmentFrames;
        flushSegment(segmentIndex, startFrame, startFrame + segmentChunkMeta.length);
      }
      if (stoppedAt < to) tailEndFrame = Math.min(tailEndFrame, stoppedAt);
    }
    if (!decodedAny) {
      throw new Error("decoder produced no frames — aborted");
    }

    // MUX, once, in logical segment order — the step that makes any build order legal. Payloads are
    // released as they go, so `segments` and the muxer never both hold a full copy.
    // When segments are unusable there is no tap and no deferral: the muxer took the chunks live,
    // exactly as it did before any of this existed, and there is nothing to replay.
    let muxedFrames = 0;
    for (let s = 0; segmentsUsable && s < totalSegments; s += 1) {
      const content = segments.get(s);
      if (!content) {
        // Legitimate only past the true tail; anywhere else it is a gap, and a proxy with a hole in
        // it is exactly the corruption the frozen-tail guard exists to keep off disk.
        if (s * segmentFrames >= tailEndFrame) break;
        throw new Error(`source-proxy segment ${s} of ${totalSegments} missing after build — aborted`);
      }
      const chunks = segmentToChunks(content.header, content.payloads);
      for (let c = 0; c < chunks.length; c += 1) {
        const description = muxedFrames === 0 ? descriptionFromBase64(content.header.descriptionBase64) : undefined;
        encoder.muxPreEncodedVideoChunk(
          chunks[c]!,
          // Only the FIRST chunk of the file carries a decoderConfig — that is what the muxer writes
          // into avcC (and, via its colorSpace, into `colr`). Every run's encoder is configured
          // identically, so any segment's copy describes them all.
          description && content.header.codec
            ? {
                decoderConfig: {
                  codec: content.header.codec,
                  description,
                  codedWidth: width,
                  codedHeight: height,
                  ...(content.header.colorSpace ? { colorSpace: content.header.colorSpace } : {}),
                },
              }
            : undefined
        );
        muxedFrames += 1;
      }
      content.payloads.length = 0;
      segments.delete(s);
    }
    if (muxedFrames > 0) encodedFrames = muxedFrames;
    // The tail (audio encode + finalize) parks too: the 2026-07-06 harness run showed a build whose
    // frame loop finished pre-play completing its audio/mux DURING playback — harmless off-thread,
    // but the suspension contract is "no background work while the transport runs".
    await waitWhileSuspended();
    if (audio) {
      feedAudio(encoder, audio);
    }
    await waitWhileSuspended();
    const blob = await encoder.finalize();
    const buffer = await blob.arrayBuffer();
    return { buffer, mime: blob.type, encodedFrames, fps, decodableEndSeconds: decodableEnd };
  } catch (error) {
    encoder.dispose();
    throw error;
  } finally {
    provider.dispose();
  }
}

/** Push the transferred PCM through the AAC encoder in planar chunks (no yielding needed off-thread). */
function feedAudio(encoder: MediaEncoder, audio: NonNullable<SourceProxyWorkerPayload["audio"]>): void {
  const CHUNK = 4096;
  const planes = audio.planes.map((buffer) => new Float32Array(buffer));
  for (let offset = 0; offset < audio.frames; offset += CHUNK) {
    const frames = Math.min(CHUNK, audio.frames - offset);
    const data = new Float32Array(frames * audio.channels);
    for (let c = 0; c < audio.channels; c += 1) {
      const plane = planes[c];
      if (plane) data.set(plane.subarray(offset, offset + frames), c * frames);
    }
    encoder.encodeAudio(
      new AudioData({
        format: "f32-planar",
        sampleRate: audio.sampleRate,
        numberOfFrames: frames,
        numberOfChannels: audio.channels,
        timestamp: Math.round((offset / audio.sampleRate) * 1_000_000),
        data
      })
    );
  }
}
