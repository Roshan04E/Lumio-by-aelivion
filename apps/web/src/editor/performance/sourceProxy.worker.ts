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
        aborted: aborted || error instanceof ProxyBuildAborted
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
  // SEGMENT CACHE (2026-08-11, Slice 1). One encoder for the whole build, exactly as before — the
  // chunks are TAPPED on their way to the muxer and grouped into fixed frame-count segments, so an
  // uninterrupted build's bitstream is byte-for-byte what it was before this existed. See
  // sourceProxySegments.ts for why the cache holds chunks rather than N finalized MP4s.
  let segmentChunkMeta: SegmentChunkMeta[] = [];
  let segmentPayloads: Uint8Array[] = [];
  let chunksSeen = 0;
  let firstDescriptionBase64: string | undefined;
  let firstCodec: string | undefined;
  // Monotonic segment index. Seeded at the resume point so a resumed build continues the numbering
  // instead of overwriting the prefix it just replayed.
  let nextSegmentIndex = 0;

  /**
   * Seal the buffered chunks as one segment and hand it to the engine to persist.
   *
   * Segmentation is driven by the CHUNK STREAM, not the frame-submission loop. `addVideoFrame` only
   * enqueues — the encoder's output lags submission by up to its queue depth (8) — so counting
   * submitted frames drifts off the segment grid, which silently (a) collided segment indices and
   * (b) put boundaries on non-keyframes. There is exactly one chunk per frame and chunks arrive in
   * order, so chunk N IS frame N: counting chunks makes every boundary land on an exact multiple of
   * `segmentFrames`, and therefore — since that is a multiple of the GOP — always on a keyframe.
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
      ...(segmentIndex === 0 ? { descriptionBase64: firstDescriptionBase64, codec: firstCodec } : {}),
      chunks: segmentChunkMeta,
    };
    const blob = encodeSegment(header, segmentPayloads);
    segmentChunkMeta = [];
    segmentPayloads = [];
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
          onEncodedVideoChunk: (chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined): void => {
            if (chunksSeen === 0 && meta?.decoderConfig) {
              firstDescriptionBase64 = descriptionToBase64(meta.decoderConfig.description);
              firstCodec = meta.decoderConfig.codec;
            }
            chunksSeen += 1;
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            segmentChunkMeta.push({
              type: chunk.type,
              timestamp: chunk.timestamp,
              duration: chunk.duration ?? null,
              byteLength: bytes.length,
            });
            segmentPayloads.push(bytes);
            if (segmentChunkMeta.length >= segmentFrames) {
              const startFrame = nextSegmentIndex * segmentFrames;
              flushSegment(nextSegmentIndex, startFrame, startFrame + segmentFrames);
              nextSegmentIndex += 1;
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
    let nullRun = 0;
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

    // RESUME: replay the persisted prefix straight into the muxer — no decode, no re-encode. The
    // engine has already validated each segment's guards (asset/bytes/recipe) and their contiguity;
    // anything it could not vouch for it simply does not send, and we rebuild those frames instead.
    let resumeFromFrame = 0;
    if (segmentsUsable && payload.resumePrefix.length > 0 && payload.resumeFromFrame > 0) {
      let replayed = 0;
      for (const buffer of payload.resumePrefix) {
        const parsed = await decodeSegment(new Blob([buffer]));
        if (!parsed) break; // truncated/unreadable → stop replaying and encode the rest live
        const chunks = segmentToChunks(parsed.header, parsed.payloads);
        for (let c = 0; c < chunks.length; c += 1) {
          const isVeryFirst = replayed === 0 && c === 0;
          const description = isVeryFirst ? descriptionFromBase64(parsed.header.descriptionBase64) : undefined;
          encoder.muxPreEncodedVideoChunk(
            chunks[c]!,
            // Only the FIRST chunk of the whole file carries a decoderConfig — that is what the
            // muxer writes into avcC. The live encoder's own first chunk will also carry one, but
            // mp4-muxer keeps the first it saw, and both describe the same pinned config.
            isVeryFirst && description && parsed.header.codec
              ? { decoderConfig: { codec: parsed.header.codec, description, codedWidth: width, codedHeight: height } }
              : undefined
          );
        }
        replayed += 1;
        resumeFromFrame = parsed.header.endFrame;
        decodedAny = true; // the prefix IS decoded content — it just was not decoded this session
      }
      if (replayed > 0) {
        console.info(`[proxy] resumed from segment ${replayed} — replayed ${resumeFromFrame} frames, encoding from there`);
      }
    }

    let encodedFrames = resumeFromFrame;
    nextSegmentIndex = segmentsUsable ? Math.floor(resumeFromFrame / segmentFrames) : 0;
    for (let i = resumeFromFrame; i < frameCount; i += 1) {
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
        if (decodedAny && i / fps > effectiveDuration - 0.25) {
          break; // tail overshoot — finish with what we have
        }
        if (nullRun > maxNullRun) {
          throw new Error(`decoder stopped producing frames at ~${(i / fps).toFixed(1)}s — aborted (frozen-tail guard)`);
        }
      }
      await encoder.addVideoFrame(canvas, i);
      encodedFrames += 1;
      // Live feedback (2026-07-18, user report: silent builds read as a hang): a throttled progress
      // ping the engine forwards to the editor's notice line. Every 30 frames ≈ once a second.
      if (encodedFrames % 30 === 0) {
        scope.postMessage({ type: "progress", encodedFrames, totalFrames: frameCount });
      }
    }
    if (!decodedAny) {
      throw new Error("decoder produced no frames — aborted");
    }
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
