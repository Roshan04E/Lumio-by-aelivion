import type { MaskSequenceArtifactData, SubjectBounds, TrackingPathArtifactData } from "@orreris/shared";
import { smoothTrackingPoints } from "@orreris/shared";
import type { BrowserToolCapabilities } from "./capabilities";
import { clearCachedModels, getCachedModel, type ModelFetchProgress } from "./model-cache";

/** Model weights the segmentation engines download — cached in OPFS via model-cache.ts. */
export const SEGMENTATION_MODEL_URLS = {
  /** Fast tier: MediaPipe selfie segmenter (~250KB TFLite). */
  fast: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
  /** Quality tier: Robust Video Matting mobilenetv3 ONNX (~15MB). */
  quality: "https://huggingface.co/eafish/web-onnx/resolve/main/rvm_mobilenetv3_fp32.onnx"
} as const;

/** Human-readable download progress line ("Downloading high-quality model… 42%"). */
function modelProgressLine(label: string, p: ModelFetchProgress): string {
  if (p.total > 0) {
    return `Downloading ${label} model… ${Math.round((p.loaded / p.total) * 100)}%`;
  }
  return `Downloading ${label} model… ${(p.loaded / 1_000_000).toFixed(1)}MB`;
}

/**
 * Re-download every segmentation engine's weights, bypassing the cache (the "Redownload engine"
 * action). Clears the OPFS cache first, then re-fetches both tiers so the next run uses fresh bytes —
 * the fix when a partial/corrupt download (flaky network, OS network optimizations) wedged an engine.
 */
export async function redownloadSegmentationModels(onProgress?: (message: string) => void): Promise<void> {
  cachedFastSegmenter = undefined;
  cachedQualitySession = undefined;
  await clearCachedModels([SEGMENTATION_MODEL_URLS.fast, SEGMENTATION_MODEL_URLS.quality]);
  onProgress?.("Re-downloading the fast model…");
  await getCachedModel(SEGMENTATION_MODEL_URLS.fast, { force: true, onProgress: (p) => onProgress?.(modelProgressLine("fast", p)) });
  onProgress?.("Re-downloading the high-quality model…");
  await getCachedModel(SEGMENTATION_MODEL_URLS.quality, { force: true, onProgress: (p) => onProgress?.(modelProgressLine("high-quality", p)) });
  onProgress?.("Engines re-downloaded and cached.");
}

/**
 * Device-aware person segmentation. Mirrors the lazy-CDN-import + cached-pipeline
 * pattern in local-transcription.ts so this stays consistent with the rest of the
 * browser tool runtime.
 *
 * Two tiers:
 * - FAST: MediaPipe ImageSegmenter (TFLite/WebGL). Same family of model that
 *   powers Google Meet's background features - small, real-time, runs on any
 *   device. Used for the interactive preview/inspector.
 * - QUALITY: onnxruntime-web running a recurrent video matting model (RVM) with
 *   the WebGPU execution provider, falling back to WASM. Used for the bake that
 *   produces the final matte artifact. Slower, but the user explicitly accepted
 *   "not fast is okay" in exchange for temporally-stable, high quality edges.
 */

export type SegmentationTier = "fast" | "quality";

export interface SegmentationDeviceProfile {
  tier: SegmentationTier;
  executionProvider: "webgpu" | "wasm";
  threaded: boolean;
  sampleFps: number;
  suggestCloudOffload: boolean;
}

type ProgressCallback = (message: string) => void;

export interface SegmentVideoOptions {
  videoUrl: string;
  /** Source asset the video came from — stamped onto the produced artifacts so consumers can find them by asset later. */
  sourceAssetId?: string | undefined;
  /**
   * Source in-point (seconds) to begin sampling at. Defaults to 0 (from the source start). Set to a
   * clip's used in-point so a short cut of a long source only segments the used slice — the produced
   * matte is 0-based over `[startSeconds, startSeconds + durationSeconds]` and records `startSeconds`
   * so renderers re-align it to source time. `durationSeconds` is then the SLICE length, not the file's.
   */
  startSeconds?: number | undefined;
  durationSeconds: number;
  width: number;
  height: number;
  tier: SegmentationTier;
  /**
   * Target frame rate for the baked matte. Set to the composition fps so the
   * matte has one frame per output frame and stays frame-locked to the source
   * (no temporal ghosting on motion). The fast tier still caps this for speed;
   * the quality/export tier honors it (capped at 30) for professional output.
   */
  targetFps?: number | undefined;
  onProgress?: ProgressCallback | undefined;
  isCancelled?: (() => boolean) | undefined;
}

/**
 * Resolves the source video's TRUE decoded dimensions and returns an options
 * object that uses them. The caller-provided width/height come from asset
 * metadata which can be missing/wrong (falling back to a generic 720x1280),
 * and sampling the matte at the wrong aspect ratio stretches it relative to the
 * source at composite time. Sampling at the real decoded size keeps the matte
 * spatially locked to the source frame.
 */
function withTrueVideoDimensions(options: SegmentVideoOptions, video: HTMLVideoElement): SegmentVideoOptions {
  return {
    ...options,
    width: video.videoWidth || options.width,
    height: video.videoHeight || options.height
  };
}

export interface SegmentVideoResult {
  maskSequence: MaskSequenceArtifactData;
  trackingPath: TrackingPathArtifactData;
  subjectBounds: SubjectBounds[];
  /** Raw per-sampled-frame grayscale luma mattes (width*height bytes, 255=keep). Caller encodes/stores these. */
  matteFrames: Array<{ timeSeconds: number; luma: Uint8ClampedArray }>;
}

/**
 * Picks a tier + execution settings from device capability signals. Weak devices
 * still get a correct result (WASM, lower sample fps, cloud-offload suggestion
 * surfaced as a diagnostic) - they just take longer, which the product accepts.
 */
export function chooseSegmentationDeviceProfile(
  capabilities: BrowserToolCapabilities,
  clipDurationSeconds: number
): SegmentationDeviceProfile {
  const hasWebGpu = capabilities.webGpu;
  const threaded = capabilities.crossOriginIsolated && capabilities.sharedArrayBuffer;
  const longClip = clipDurationSeconds > 45;

  return {
    tier: "fast",
    executionProvider: hasWebGpu ? "webgpu" : "wasm",
    threaded,
    sampleFps: hasWebGpu ? 15 : threaded ? 10 : 6,
    suggestCloudOffload: !hasWebGpu && longClip
  };
}

const mediaPipeUrls = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21",
  "https://esm.sh/@mediapipe/tasks-vision@0.10.21"
];

const onnxRuntimeUrls = [
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs",
  "https://esm.sh/onnxruntime-web@1.20.1"
];
// onnxruntime-web resolves its own .wasm/.mjs proxy binaries from this dir. Setting it explicitly
// (ort.env.wasm.wasmPaths) is what lets the WEBGPU backend initialize reliably — without it the
// proxy fetch can fail under strict networks, ORT silently drops to the pure-WASM EP, and the RVM
// graph then hard-errors ("ceil() … not supported for AveragePool"). Pinned to the ORT version above.
const ortWasmBase = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";

// Selfie/landscape segmentation model (MediaPipe) and the RVM ONNX matting model. Both are fetched
// and cached through model-cache.ts (OPFS) and handed to the engines as BYTES, not URLs — so a flaky
// network can't wedge a download, weights persist across reloads, and "Redownload engine" can refresh
// them. See SEGMENTATION_MODEL_URLS above (the single source of truth for these URLs).
const mediaPipeSelfieModelUrl = SEGMENTATION_MODEL_URLS.fast;
const rvmModelUrl = SEGMENTATION_MODEL_URLS.quality;

interface MediaPipeImageSegmenterResult {
  categoryMask?: { getAsUint8Array: () => Uint8Array } | undefined;
  confidenceMasks?: Array<{ getAsFloat32Array: () => Float32Array }> | undefined;
}

interface MediaPipeImageSegmenter {
  segmentForVideo: (frame: CanvasImageSource, timestampMs: number) => MediaPipeImageSegmenterResult;
  close: () => void;
}

let cachedFastSegmenter: Promise<MediaPipeImageSegmenter> | undefined;
let cachedQualitySession: Promise<QualitySession> | undefined;
// segmentForVideo() requires strictly increasing timestamps across every call
// made to a given segmenter instance. Since the segmenter is cached and reused
// across separate Extract runs, per-run video time (which restarts near 0)
// can't be passed directly - track a monotonic counter instead.
let nextFastSegmentTimestampMs = 0;

/**
 * Runs the FAST tier (MediaPipe) over a sampled set of frames from `videoUrl`.
 * Used for the interactive inspector preview and as the always-available
 * fallback when the QUALITY tier can't run on this device.
 */
export async function segmentVideoFast(options: SegmentVideoOptions): Promise<SegmentVideoResult> {
  assertNotCancelled(options.isCancelled);
  options.onProgress?.("Loading the fast preview segmentation model.");
  const segmenter = await getFastSegmenter(options.onProgress);
  assertNotCancelled(options.isCancelled);

  // Fast preview stays low-fps for interactivity; the dimensional fix below is
  // what keeps it spatially aligned. The quality tier handles temporal locking.
  const sampleFps = 8;
  // Frame times are 0-based over the requested SLICE; sampling seeks to `startSeconds + t` in the
  // source, but the matte stays 0-based (its startSeconds records the offset for the renderers).
  const startSeconds = Math.max(0, options.startSeconds ?? 0);
  const frameTimes = sampleFrameTimes(options.durationSeconds, sampleFps);
  const video = await loadVideoElement(options.videoUrl);
  const dims = withTrueVideoDimensions(options, video);

  const canvas = document.createElement("canvas");
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for segmentation.");
  }

  const matteFrames: SegmentVideoResult["matteFrames"] = [];
  const bounds: SubjectBounds[] = [];

  for (const [index, timeSeconds] of frameTimes.entries()) {
    assertNotCancelled(options.isCancelled);
    await seekVideo(video, startSeconds + timeSeconds);
    ctx.drawImage(video, 0, 0, dims.width, dims.height);

    nextFastSegmentTimestampMs = Math.max(nextFastSegmentTimestampMs + 1, Math.round(timeSeconds * 1000));
    const result = segmenter.segmentForVideo(canvas, nextFastSegmentTimestampMs);
    const categoryMask = result.categoryMask?.getAsUint8Array();
    if (!categoryMask) {
      continue;
    }

    const luma = categoryMaskToLuma(categoryMask);
    matteFrames.push({ timeSeconds, luma });
    bounds.push(lumaToSubjectBounds(luma, dims.width, dims.height, timeSeconds));

    options.onProgress?.(`Segmented frame ${index + 1} of ${frameTimes.length}.`);
  }

  if (!matteFrames.length) {
    throw new Error("Fast segmentation produced no usable frames.");
  }

  return buildSegmentResult(dims, matteFrames, bounds, sampleFps, "fast", "browser");
}

/**
 * Runs the QUALITY tier (RVM via onnxruntime-web) over the full frame rate of
 * the clip for a temporally-stable bake. Falls back from WebGPU to WASM
 * automatically when WebGPU init fails - this is the path weak devices take;
 * it is simply slower, not lower quality.
 */
export async function segmentVideoQuality(
  options: SegmentVideoOptions,
  profile: SegmentationDeviceProfile
): Promise<SegmentVideoResult> {
  assertNotCancelled(options.isCancelled);
  options.onProgress?.(
    profile.executionProvider === "webgpu"
      ? "Loading the high-quality matting model (WebGPU)."
      : "Loading the high-quality matting model (CPU fallback - this will take longer)."
  );

  const session = await getQualitySession(profile, options.onProgress);
  assertNotCancelled(options.isCancelled);

  // Export-grade matte: sample at the composition fps (capped at 30) so there is
  // one matte frame per output frame and the alpha stays frame-locked to the
  // source RGB - this is what removes the motion ghosting in the final render.
  const sampleFps = Math.min(30, Math.max(profile.sampleFps, options.targetFps ?? profile.sampleFps));
  const startSeconds = Math.max(0, options.startSeconds ?? 0);
  const frameTimes = sampleFrameTimes(options.durationSeconds, sampleFps);
  const video = await loadVideoElement(options.videoUrl);
  const dims = withTrueVideoDimensions(options, video);
  const canvas = document.createElement("canvas");
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for segmentation.");
  }

  const matteFrames: SegmentVideoResult["matteFrames"] = [];
  const bounds: SubjectBounds[] = [];
  // RVM carries recurrent state (r1-r4) across calls for temporal stability;
  // reset at the start of each clip.
  let recurrentState = session.createInitialState();

  for (const [index, timeSeconds] of frameTimes.entries()) {
    assertNotCancelled(options.isCancelled);
    await seekVideo(video, startSeconds + timeSeconds);
    ctx.drawImage(video, 0, 0, dims.width, dims.height);
    const frame = ctx.getImageData(0, 0, dims.width, dims.height);

    const { luma, nextState } = await session.runFrame(frame, recurrentState);
    recurrentState = nextState;
    matteFrames.push({ timeSeconds, luma });
    bounds.push(lumaToSubjectBounds(luma, dims.width, dims.height, timeSeconds));

    options.onProgress?.(`Baked frame ${index + 1} of ${frameTimes.length}.`);
  }

  if (!matteFrames.length) {
    throw new Error("Quality matting produced no usable frames.");
  }

  return buildSegmentResult(dims, matteFrames, bounds, sampleFps, "clean", "browser");
}

function buildSegmentResult(
  options: SegmentVideoOptions,
  matteFrames: SegmentVideoResult["matteFrames"],
  bounds: SubjectBounds[],
  fps: number,
  edgeMode: "fast" | "clean",
  source: MaskSequenceArtifactData["source"]
): SegmentVideoResult {
  const maskSequence: MaskSequenceArtifactData = {
    id: `mask_${source}_${Date.now()}`,
    sourceAssetId: options.sourceAssetId,
    width: options.width,
    height: options.height,
    fps,
    durationSeconds: options.durationSeconds,
    // Record the source in-point so the baked (0-based) matte is re-aligned to source time by the
    // renderers. Omitted for a full-source bake, keeping those artifacts byte-identical.
    ...(options.startSeconds ? { startSeconds: options.startSeconds } : {}),
    feather: edgeMode === "clean" ? 4 : 8,
    edgeMode,
    source,
    frames: matteFrames.map((frame) => ({
      timeSeconds: frame.timeSeconds,
      width: options.width,
      height: options.height,
      previewPath: "",
      confidence: 0.8
    }))
  };

  const trackingPath: TrackingPathArtifactData = {
    durationSeconds: options.durationSeconds,
    smoothing: 0.4,
    source,
    sourceAssetId: options.sourceAssetId,
    id: `track_${source}_${Date.now()}`,
    points: bounds.map((item) => ({
      timeSeconds: item.timeSeconds,
      position: { x: item.x + item.width / 2, y: item.y + item.height * 0.42 },
      bounds: item,
      confidence: item.confidence
    }))
  };

  return {
    maskSequence,
    trackingPath: { ...trackingPath, points: smoothTrackingPoints(trackingPath.points, trackingPath.smoothing) },
    subjectBounds: bounds,
    matteFrames
  };
}

/**
 * Auto-suggests a track target box by running one fast-segmentation pass at a
 * single timestamp. Used to seed the Smart 3D Follow Text tracker's initial
 * box before the user optionally drags their own box on the preview.
 */
export async function detectInitialSubjectBox(input: { videoUrl: string; width: number; height: number; timeSeconds?: number }): Promise<SubjectBounds> {
  const segmenter = await getFastSegmenter();
  const video = await loadVideoElement(input.videoUrl);
  const width = video.videoWidth || input.width;
  const height = video.videoHeight || input.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for segmentation.");
  }

  const timeSeconds = input.timeSeconds ?? 0;
  await seekVideo(video, timeSeconds);
  ctx.drawImage(video, 0, 0, width, height);
  nextFastSegmentTimestampMs = Math.max(nextFastSegmentTimestampMs + 1, Math.round(timeSeconds * 1000));
  const result = segmenter.segmentForVideo(canvas, nextFastSegmentTimestampMs);
  const categoryMask = result.categoryMask?.getAsUint8Array();
  if (!categoryMask) {
    throw new Error("No subject detected for auto track box.");
  }

  const luma = categoryMaskToLuma(categoryMask);
  return lumaToSubjectBounds(luma, width, height, timeSeconds);
}

async function getFastSegmenter(onProgress?: (message: string) => void): Promise<MediaPipeImageSegmenter> {
  cachedFastSegmenter ??= loadFastSegmenter(onProgress);
  return cachedFastSegmenter;
}

async function loadFastSegmenter(onProgress?: (message: string) => void): Promise<MediaPipeImageSegmenter> {
  // Weights fetched (and cached) by us, then handed to MediaPipe as a buffer — no internal URL fetch.
  const modelBuffer = new Uint8Array(
    await getCachedModel(mediaPipeSelfieModelUrl, { onProgress: (p) => onProgress?.(modelProgressLine("fast", p)) })
  );
  let lastError: unknown;
  for (const url of mediaPipeUrls) {
    try {
      const mod = (await import(/* @vite-ignore */ url)) as {
        FilesetResolver?: { forVisionTasks: (wasmBase: string) => Promise<unknown> };
        ImageSegmenter?: {
          createFromOptions: (
            vision: unknown,
            options: {
              baseOptions: { modelAssetBuffer: Uint8Array; delegate: "GPU" | "CPU" };
              runningMode: "VIDEO";
              outputCategoryMask: boolean;
            }
          ) => Promise<MediaPipeImageSegmenter>;
        };
      };
      if (!mod.FilesetResolver || !mod.ImageSegmenter) {
        continue;
      }
      const vision = await mod.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm"
      );
      // segmentForVideo() requires the task to be created in VIDEO mode - the
      // default is IMAGE mode, which throws "Task is not initialized with
      // video mode" the first time segmentForVideo() is called.
      return await mod.ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: modelBuffer, delegate: "GPU" },
        runningMode: "VIDEO",
        outputCategoryMask: true
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to load the fast segmentation model. ${lastError instanceof Error ? lastError.message : ""}`.trim());
}

interface QualitySession {
  createInitialState: () => unknown;
  runFrame: (frame: ImageData, state: unknown) => Promise<{ luma: Uint8ClampedArray; nextState: unknown }>;
}

async function getQualitySession(
  profile: SegmentationDeviceProfile,
  onProgress?: (message: string) => void
): Promise<QualitySession> {
  cachedQualitySession ??= loadQualitySession(profile, onProgress);
  return cachedQualitySession;
}

async function loadQualitySession(
  profile: SegmentationDeviceProfile,
  onProgress?: (message: string) => void
): Promise<QualitySession> {
  // Fetch the ~15MB RVM weights ONCE through the OPFS cache and pass the bytes to ORT (no internal
  // URL fetch — the path that was failing under the user's network and silently dropping to WASM).
  const modelBytes = new Uint8Array(
    await getCachedModel(rvmModelUrl, { onProgress: (p) => onProgress?.(modelProgressLine("high-quality", p)) })
  );
  // When WebGPU is available, list it FIRST with WASM as the per-node fallback. WebGPU runs the RVM
  // graph (incl. the AveragePool the pure-WASM EP rejects); listing both lets ORT place any node the
  // GPU can't take on WASM instead of failing the whole session.
  const executionProviders = profile.executionProvider === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];

  let lastError: unknown;
  for (const url of onnxRuntimeUrls) {
    try {
      const ort = (await import(/* @vite-ignore */ url)) as {
        env: { wasm: { wasmPaths?: string; numThreads?: number } };
        InferenceSession: { create: (model: Uint8Array, options?: Record<string, unknown>) => Promise<unknown> };
        Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
      };
      // Point ORT at its proxy binaries so the WebGPU backend can initialize (see ortWasmBase).
      if (ort.env?.wasm) {
        ort.env.wasm.wasmPaths = ortWasmBase;
      }
      const session = await ort.InferenceSession.create(modelBytes, { executionProviders });
      return wrapRvmSession(session, ort);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to load the quality matting model. ${lastError instanceof Error ? lastError.message : ""}`.trim());
}

function wrapRvmSession(
  session: unknown,
  ort: { Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown }
): QualitySession {
  // Verified against the official RVM ONNX inference docs
  // (github.com/PeterL1n/RobustVideoMatting/blob/master/documentation/inference.md):
  // inputs are src, r1i, r2i, r3i, r4i, downsample_ratio; outputs are
  // fgr, pha, r1o, r2o, r3o, r4o. An earlier version guessed plain r1-r4 and
  // omitted downsample_ratio entirely, which onnxruntime rejected outright
  // ("input 'r1i' is missing in 'feeds'") - don't re-guess these names.
  return {
    createInitialState: () => ({
      r1i: zeroTensor(ort, 1),
      r2i: zeroTensor(ort, 1),
      r3i: zeroTensor(ort, 1),
      r4i: zeroTensor(ort, 1)
    }),
    runFrame: async (frame, state) => {
      const inferenceSession = session as { run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>> };
      const input = imageDataToNchwTensor(ort, frame);
      const downsampleRatio = new ort.Tensor("float32", new Float32Array([downsampleRatioFor(frame.width, frame.height)]), [1]);
      const outputs = await inferenceSession.run({
        src: input,
        downsample_ratio: downsampleRatio,
        ...(state as Record<string, unknown>)
      });
      const alpha = outputs.pha?.data;
      if (!alpha) {
        throw new Error("Matting model output missing alpha tensor.");
      }
      return {
        luma: alphaTensorToLuma(alpha, frame.width, frame.height),
        nextState: { r1i: outputs.r1o, r2i: outputs.r2o, r3i: outputs.r3o, r4i: outputs.r4o }
      };
    }
  };
}

function zeroTensor(ort: { Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown }, size: number) {
  return new ort.Tensor("float32", new Float32Array(size), [1, 1, 1, 1]);
}

/**
 * RVM's own guidance: pick downsample_ratio so the downsampled short side
 * lands between 256-512px (384 is the midpoint) - too low loses matte detail,
 * too high wastes compute without quality gain. Never upsamples past the
 * frame's native resolution.
 */
function downsampleRatioFor(width: number, height: number): number {
  const shortSide = Math.min(width, height);
  return Math.min(1, 384 / shortSide);
}

function imageDataToNchwTensor(
  ort: { Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown },
  frame: ImageData
) {
  const { width, height, data } = frame;
  const channelSize = width * height;
  const planar = new Float32Array(channelSize * 3);
  for (let i = 0; i < channelSize; i += 1) {
    planar[i] = (data[i * 4] ?? 0) / 255;
    planar[channelSize + i] = (data[i * 4 + 1] ?? 0) / 255;
    planar[channelSize * 2 + i] = (data[i * 4 + 2] ?? 0) / 255;
  }
  return new ort.Tensor("float32", planar, [1, 3, height, width]);
}

function alphaTensorToLuma(alpha: Float32Array, width: number, height: number): Uint8ClampedArray {
  const luma = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const value = Math.round(Math.min(1, Math.max(0, alpha[i] ?? 0)) * 255);
    luma[i * 4] = value;
    luma[i * 4 + 1] = value;
    luma[i * 4 + 2] = value;
    luma[i * 4 + 3] = 255;
  }
  return luma;
}

function categoryMaskToLuma(categoryMask: Uint8Array): Uint8ClampedArray {
  // MediaPipe's selfie segmenter category 0 = person in the default model config.
  const luma = new Uint8ClampedArray(categoryMask.length * 4);
  for (let i = 0; i < categoryMask.length; i += 1) {
    const value = categoryMask[i] === 0 ? 255 : 0;
    luma[i * 4] = value;
    luma[i * 4 + 1] = value;
    luma[i * 4 + 2] = value;
    luma[i * 4 + 3] = 255;
  }
  return luma;
}

function lumaToSubjectBounds(luma: Uint8ClampedArray, width: number, height: number, timeSeconds: number): SubjectBounds {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let covered = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = luma[(y * width + x) * 4] ?? 0;
      if (value > 128) {
        covered += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (covered === 0) {
    return { timeSeconds, x: width * 0.35, y: height * 0.2, width: width * 0.3, height: height * 0.6, confidence: 0 };
  }

  const coverage = covered / (width * height);
  return {
    timeSeconds,
    x: (minX / width) * 100,
    y: (minY / height) * 100,
    width: ((maxX - minX) / width) * 100,
    height: ((maxY - minY) / height) * 100,
    confidence: Number(Math.min(0.98, 0.6 + coverage).toFixed(3))
  };
}

export function sampleFrameTimes(durationSeconds: number, fps: number): number[] {
  const count = Math.max(1, Math.round(durationSeconds * fps));
  return Array.from({ length: count }, (_, index) => Math.min(durationSeconds, (index / fps)));
}

export async function loadVideoElement(videoUrl: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  // Must be set before src so frames drawn to canvas (for MediaPipe/onnxruntime
  // to read) don't taint it - the source video is served cross-origin from the
  // API, and the server's CORS headers alone aren't enough without this.
  video.crossOrigin = "anonymous";
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Unable to load video for segmentation."));
  });
  return video;
}

export function seekVideo(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  return new Promise((resolve) => {
    video.onseeked = () => resolve();
    video.currentTime = timeSeconds;
  });
}

function assertNotCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) {
    throw new Error("Segmentation cancelled.");
  }
}
