import type { InpaintedClipArtifactData } from "@lumio-by-aelivion/shared";
import type { MockInpaintResult } from "./mock-inpaint";
import type { ToolArtifactStore } from "./artifact-store";

export interface InpaintBakeResult {
  /** `uri` here is a blob: URL - only valid in this tab, for this session. */
  clip: InpaintedClipArtifactData;
  blob: Blob;
}

/**
 * Encodes the per-frame inpainted RGB frames into a portable WebM clip and
 * persists it through the OPFS-backed tool artifact store, mirroring
 * matte-store.ts. Unlike the matte (a binary data channel) this is perceptual
 * color video, so it uses a normal quality-mode bitrate and a relaxed keyframe
 * interval. Falls back to a WebM-less error only when WebCodecs is unavailable;
 * callers should surface that as "this device can't produce the removal clip yet".
 *
 * Returns the raw `blob` alongside the artifact so the caller can upload it to
 * get a persistent, server-fetchable URL (needed for Remotion export and reload
 * survival - a blob: URL does neither).
 */
export async function storeInpaintArtifact(
  result: MockInpaintResult,
  store: ToolArtifactStore,
  runId: string,
  source: InpaintedClipArtifactData["source"],
  sourceAssetId?: string
): Promise<InpaintBakeResult> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("This browser can't encode the removal clip (WebCodecs unavailable). Try the cloud adapter.");
  }

  const blob = await encodeRgbaFramesToWebm(result);
  const id = `inpaint_${source}_${Date.now()}`;
  await store.put({
    id,
    type: "inpaintedClip",
    metadata: { runId, source, fps: result.fps, editable: true },
    blob
  });

  const clip: InpaintedClipArtifactData = {
    id,
    sourceAssetId,
    uri: URL.createObjectURL(blob),
    width: result.width,
    height: result.height,
    fps: result.fps,
    durationSeconds: result.durationSeconds,
    source
  };
  return { clip, blob };
}

const webmMuxerUrls = [
  "https://cdn.jsdelivr.net/npm/webm-muxer@5.0.3/build/webm-muxer.mjs",
  "https://esm.sh/webm-muxer@5.0.3"
];

interface WebmMuxerModule {
  Muxer: new (options: { target: { buffer: ArrayBuffer | null }; video: Record<string, unknown> }) => {
    addVideoChunk: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
    finalize: () => void;
  };
  ArrayBufferTarget: new () => { buffer: ArrayBuffer | null };
}

async function encodeRgbaFramesToWebm(result: MockInpaintResult): Promise<Blob> {
  const { width, height, fps, frames } = result;
  const muxerModule = await loadWebmMuxer();
  const target = new muxerModule.ArrayBufferTarget();
  const muxer = new muxerModule.Muxer({
    target,
    video: { codec: "V_VP9", width, height, frameRate: fps }
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      throw error;
    }
  });
  // Perceptual color video: a moderate bitrate in quality mode and a keyframe
  // roughly every two seconds is plenty for a placeholder removal clip.
  const bitrate = Math.round(width * height * fps * 0.12);
  const keyFrameIntervalFrames = Math.max(1, Math.round(fps * 2));
  encoder.configure({
    codec: "vp09.00.10.08",
    width,
    height,
    framerate: fps,
    bitrate,
    latencyMode: "quality"
  });

  let frameIndex = 0;
  for (const frame of frames) {
    while (encoder.encodeQueueSize > 2) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const imageData = new ImageData(new Uint8ClampedArray(frame.rgba), width, height);
    const bitmap = await createImageBitmap(imageData);
    const videoFrame = new VideoFrame(bitmap, {
      timestamp: Math.round((frameIndex / fps) * 1_000_000),
      duration: Math.round(1_000_000 / fps)
    });
    encoder.encode(videoFrame, { keyFrame: frameIndex % keyFrameIntervalFrames === 0 });
    videoFrame.close();
    bitmap.close();
    frameIndex += 1;
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  if (!target.buffer) {
    throw new Error("Inpaint video encoder produced no output buffer.");
  }
  return new Blob([target.buffer], { type: "video/webm" });
}

let cachedMuxer: Promise<WebmMuxerModule> | undefined;

async function loadWebmMuxer(): Promise<WebmMuxerModule> {
  cachedMuxer ??= (async () => {
    let lastError: unknown;
    for (const url of webmMuxerUrls) {
      try {
        return (await import(/* @vite-ignore */ url)) as WebmMuxerModule;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Unable to load the video encoder. ${lastError instanceof Error ? lastError.message : ""}`.trim());
  })();
  return cachedMuxer;
}
