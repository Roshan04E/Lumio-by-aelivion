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
  const { sourceUrl, width, height, durationSeconds, maxFps, keyFrameIntervalSeconds, bitsPerPixelFrame, audio } = payload;
  // Software decode: never steal a hardware session from live playback (proxy playback keeps running
  // on the main thread while we build here). Throws WEBCODECS_REQUIRED_NO_DOM for sources the
  // WebCodecs path can't open — the engine falls back to the main thread for those.
  const provider = await createFrameProvider(sourceUrl, "video", { preferSoftware: true });
  // Sample at the SOURCE's own cadence (capped): forcing 24fps content onto a hardcoded 30fps grid
  // duplicated every 4th frame — a visible judder the user caught by eye (2026-07-04). Unknown
  // cadence assumes 30, NOT the cap — a 60 grid would duplicate every frame of 30fps footage.
  const fps = Math.min(maxFps, provider.nominalFps ?? 30);
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
    audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels } : undefined
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
    let encodedFrames = 0;
    for (let i = 0; i < frameCount; i += 1) {
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
