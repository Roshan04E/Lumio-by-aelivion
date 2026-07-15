import type { MaskSequenceArtifactData } from "@kimera-by-aelivion/shared";
import { createAsset } from "../lib/api";
import type { SegmentVideoResult } from "./local-segmentation";
import type { ToolArtifactStore } from "./artifact-store";

export interface MatteBakeResult {
  /** `matteVideoUri` here is a blob: URL - only valid in this tab, for this session. */
  maskSequence: MaskSequenceArtifactData;
  blob: Blob;
}

/**
 * Bakes the raw per-frame grayscale mattes produced by local-segmentation.ts into
 * the canonical portable artifact (a luma-matte WebM video) and persists it
 * through the existing OPFS-backed tool artifact store. Falls back to a PNG
 * sprite sheet when WebCodecs is unavailable (older Safari, some weak devices) -
 * either form is something both VideoPreview and the Remotion renderer can sample
 * per frame, they just trade file size for compatibility.
 *
 * Returns the raw `blob` alongside the artifact so the caller can additionally
 * upload it to get a persistent, server-fetchable URL (needed for Remotion
 * export and for surviving a page reload - a blob: URL does neither).
 */
export async function storeMatteArtifact(
  result: SegmentVideoResult,
  store: ToolArtifactStore,
  runId: string
): Promise<MatteBakeResult> {
  const { maskSequence, matteFrames } = result;
  const blob =
    typeof VideoEncoder !== "undefined"
      ? await encodeMatteFramesToWebm(matteFrames, maskSequence.width, maskSequence.height, maskSequence.fps)
      : encodeMatteFramesToSpriteSheet(matteFrames, maskSequence.width, maskSequence.height);

  await store.put({
    id: maskSequence.id,
    type: "maskSequence",
    metadata: {
      runId,
      source: maskSequence.source,
      edgeMode: maskSequence.edgeMode,
      fps: maskSequence.fps,
      editable: true,
      ...(maskSequence.sourceAssetId ? { sourceAssetId: maskSequence.sourceAssetId } : {})
    },
    blob
  });

  // store.put() persists to OPFS for reuse across reloads, but its returned
  // `uri` is an opfs:// reference that no <video>/fetch can load directly.
  const matteVideoUri = URL.createObjectURL(blob);
  return { maskSequence: { ...maskSequence, matteVideoUri }, blob };
}

export interface MatteUploadOutcome {
  maskSequence: MaskSequenceArtifactData;
  /** False when the upload failed and `matteVideoUri` is still a this-tab-only blob: URL. */
  uploaded: boolean;
  warning?: string | undefined;
}

/**
 * Uploads a freshly-baked matte so `matteVideoUri` becomes a persistent http(s)
 * URL — required for the Remotion worker to fetch it on cloud export and for
 * the matte to survive a page reload. Every tool flow that bakes a matte must
 * go through this one helper instead of a bespoke try/catch so failures are
 * consistent and VISIBLE (the old per-tool silent fallbacks left projects
 * carrying dead blob: URIs that made cloud export hang without explanation).
 *
 * Never throws: local-first editing must keep working offline. On failure the
 * blob: URI is kept for this session, the warning is surfaced through
 * `onProgress`, and the pre-export resolve step (export/matte-resolve.ts) gets
 * a second chance to upload the bytes from OPFS before a render job is created.
 */
export async function uploadMatteForExport(input: {
  maskSequence: MaskSequenceArtifactData;
  blob: Blob;
  folder: string;
  originalName?: string | undefined;
  onProgress?: ((message: string) => void) | undefined;
}): Promise<MatteUploadOutcome> {
  try {
    const matteAsset = await createAsset({
      file: new File([input.blob], `${input.maskSequence.id}.webm`, { type: input.blob.type || "video/webm" }),
      source: "timeline-generated",
      folder: input.folder,
      originalName: input.originalName ?? "Subject matte"
    });
    return { maskSequence: { ...input.maskSequence, matteVideoUri: matteAsset.fileUrl }, uploaded: true };
  } catch {
    const warning =
      "Matte saved on this device only (upload failed — offline?). Editing keeps working; cloud export will retry the upload automatically and tell you if it still can't.";
    input.onProgress?.(warning);
    return { maskSequence: input.maskSequence, uploaded: false, warning };
  }
}

const webmMuxerUrls = [
  "https://cdn.jsdelivr.net/npm/webm-muxer@5.0.3/build/webm-muxer.mjs",
  "https://esm.sh/webm-muxer@5.0.3"
];

interface WebmMuxerModule {
  // webm-muxer publishes named exports only (no default export) - Muxer takes
  // a target instance + track config, ArrayBufferTarget is the in-memory target.
  Muxer: new (options: { target: { buffer: ArrayBuffer | null }; video: Record<string, unknown> }) => {
    addVideoChunk: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
    finalize: () => void;
  };
  ArrayBufferTarget: new () => { buffer: ArrayBuffer | null };
}

async function encodeMatteFramesToWebm(
  matteFrames: SegmentVideoResult["matteFrames"],
  width: number,
  height: number,
  fps: number
): Promise<Blob> {
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
  // This encodes a data channel (an alpha-proxy mask), not a perceptual video -
  // default/unset bitrate lets the encoder compress hard B&W edges aggressively,
  // and a single keyframe at frame 0 means every later frame is motion-compensated
  // off the last one. On fast/erratic subject motion (the exact case a person
  // extraction needs to nail) that combination smears the matte into a visible
  // ghost trail that doesn't track the real edges - worse the more movement there
  // is, which is the reported symptom. A generous constant bitrate plus a keyframe
  // roughly once a second bounds how far any single frame's error can drift.
  const bitsPerPixelPerFrame = 0.45;
  const bitrate = Math.round(width * height * fps * bitsPerPixelPerFrame);
  const keyFrameIntervalFrames = Math.max(1, Math.round(fps));
  encoder.configure({
    codec: "vp09.00.10.08",
    width,
    height,
    framerate: fps,
    bitrate,
    bitrateMode: "constant",
    latencyMode: "quality"
  });

  let frameIndex = 0;
  for (const frame of matteFrames) {
    // encode() hands off to hardware-accelerated work and returns immediately -
    // without backpressure this loop outpaces the encoder and piles up enough
    // queued GPU frame allocations that createImageBitmap starts failing with
    // "The ImageBitmap could not be allocated" on longer clips.
    while (encoder.encodeQueueSize > 2) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const imageData = new ImageData(toImageDataArray(frame.luma), width, height);
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
    throw new Error("Matte video encoder produced no output buffer.");
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
    throw new Error(`Unable to load the matte video encoder. ${lastError instanceof Error ? lastError.message : ""}`.trim());
  })();
  return cachedMuxer;
}

/** Fallback when WebCodecs is unavailable: a single tall PNG strip, one matte frame per row-band. */
function encodeMatteFramesToSpriteSheet(
  matteFrames: SegmentVideoResult["matteFrames"],
  width: number,
  height: number
): Blob {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height * matteFrames.length;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for matte sprite sheet fallback.");
  }
  matteFrames.forEach((frame, index) => {
    ctx.putImageData(new ImageData(toImageDataArray(frame.luma), width, height), 0, index * height);
  });
  return canvasToPngBlobSync(canvas);
}

/** Normalizes a Uint8ClampedArray to one backed by a plain ArrayBuffer (ImageData requires this, not SharedArrayBuffer). */
function toImageDataArray(luma: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  return new Uint8ClampedArray(luma);
}

function canvasToPngBlobSync(canvas: HTMLCanvasElement): Blob {
  const dataUrl = canvas.toDataURL("image/png");
  const [, base64] = dataUrl.split(",");
  const binary = atob(base64 ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: "image/png" });
}
