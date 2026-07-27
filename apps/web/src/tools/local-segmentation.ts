import type { MaskSequenceArtifactData, SubjectBounds, TrackingPathArtifactData } from "@orreris/shared";
import { smoothTrackingPoints } from "@orreris/shared";
import type { BrowserToolCapabilities } from "./capabilities";
import { clearCachedModels, getCachedModel, type ModelFetchProgress } from "./model-cache";

/** Model weights the segmentation engines download — cached in OPFS via model-cache.ts. */
export const SEGMENTATION_MODEL_URLS = {
  /** Fast tier: MediaPipe selfie segmenter (~250KB TFLite). */
  fast: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
  /** Quality tier, fp32 RVM (~15MB) — CORRECT on the WASM EP (non-WebGPU devices). ORT's WebGPU EP
   *  miscomputes this fp32 graph (proven: matte collapses to max≈0.72), so WebGPU uses the fp16 build. */
  quality: "https://huggingface.co/eafish/web-onnx/resolve/main/rvm_mobilenetv3_fp32.onnx",
  /** Quality tier, fp16 RVM (~7.5MB) — WebGPU's native precision; correct + fast on the WebGPU EP. */
  qualityFp16: "https://huggingface.co/eafish/web-onnx/resolve/main/rvm_mobilenetv3_fp16.onnx"
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
  resetQualityWorker();
  await clearCachedModels([SEGMENTATION_MODEL_URLS.fast, SEGMENTATION_MODEL_URLS.quality, SEGMENTATION_MODEL_URLS.qualityFp16]);
  onProgress?.("Re-downloading the fast model…");
  await getCachedModel(SEGMENTATION_MODEL_URLS.fast, { force: true, onProgress: (p) => onProgress?.(modelProgressLine("fast", p)) });
  onProgress?.("Re-downloading the high-quality model…");
  await getCachedModel(SEGMENTATION_MODEL_URLS.qualityFp16, { force: true, onProgress: (p) => onProgress?.(modelProgressLine("high-quality", p)) });
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

// onnxruntime-web >= 1.22.0 is REQUIRED: the RVM graph has an AveragePool with ceil_mode=1, and the
// WebGPU kernel only implements ceil_mode as of microsoft/onnxruntime PR #24270 (merged 2025-04-02,
// shipped in the 1.22.x line). On the old 1.20.1 pin every session.run() threw
// "using ceil() in shape computation is not yet supported for AveragePool". 1.22–1.27 all contain the
// fix; keep the ESM import, the esm.sh fallback, and wasmPaths below on the SAME version (the wasm
// binaries are version-locked to the JS).
const ORT_VERSION = "1.27.0";
const onnxRuntimeUrls = [
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.min.mjs`,
  `https://esm.sh/onnxruntime-web@${ORT_VERSION}`
];
// onnxruntime-web resolves its own .wasm/.mjs proxy binaries from this dir. Setting it explicitly
// (ort.env.wasm.wasmPaths) is what lets the WEBGPU backend initialize reliably — without it the
// proxy fetch can fail under strict networks. MUST match ORT_VERSION above.
const ortWasmBase = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// Selfie/landscape segmentation model (MediaPipe) and the RVM ONNX matting model. Both are fetched
// and cached through model-cache.ts (OPFS) and handed to the engines as BYTES, not URLs — so a flaky
// network can't wedge a download, weights persist across reloads, and "Redownload engine" can refresh
// them. See SEGMENTATION_MODEL_URLS above (the single source of truth for these URLs).
const mediaPipeSelfieModelUrl = SEGMENTATION_MODEL_URLS.fast;

interface MediaPipeImageSegmenterResult {
  categoryMask?: { getAsUint8Array: () => Uint8Array } | undefined;
  confidenceMasks?: Array<{ getAsFloat32Array: () => Float32Array }> | undefined;
}

interface MediaPipeImageSegmenter {
  segmentForVideo: (frame: CanvasImageSource, timestampMs: number) => MediaPipeImageSegmenterResult;
  close: () => void;
}

let cachedFastSegmenter: Promise<MediaPipeImageSegmenter> | undefined;
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

  // The RVM session + every session.run() live in a worker (segmentation.worker.ts) so a long/large
  // bake can never freeze the page — the main thread here only decodes frames and streams them in.
  await warmQualityWorker(profile, options.onProgress);
  assertNotCancelled(options.isCancelled);

  // Serialize the whole bake: the worker holds ONE RVM recurrent state, so two concurrent bakes
  // (e.g. Extract Person still finishing when Remove Background starts on the same clip) must not
  // interleave frames through it. Queuing is correct — each clip's frames run contiguously against a
  // freshly reset state, and each waits its turn instead of crashing/corrupting.
  return runQualityBakeExclusive(async () => {
    assertNotCancelled(options.isCancelled);
    beginQualityClip();

    // Export-grade matte: sample at the composition fps (capped at 30) so there is
    // one matte frame per output frame and the alpha stays frame-locked to the
    // source RGB - this is what removes the motion ghosting in the final render.
    const sampleFps = Math.min(30, Math.max(profile.sampleFps, options.targetFps ?? profile.sampleFps));
    const startSeconds = Math.max(0, options.startSeconds ?? 0);
    const frameTimes = sampleFrameTimes(options.durationSeconds, sampleFps);
    const video = await loadVideoElement(options.videoUrl);
    // Cap the working resolution: RVM downsamples internally anyway and a soft luma matte upsamples
    // cleanly, so feeding a 4K/2K frame at native size just burns CPU/GPU/transfer for no matte gain
    // (and is what makes a big clip crawl). The matte is stored at these capped dims; renderers sample
    // it normalized, so it still locks to the full-res source.
    const dims = cappedWorkingDims(withTrueVideoDimensions(options, video));
    const canvas = document.createElement("canvas");
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Canvas 2D context unavailable for segmentation.");
    }

    const matteFrames: SegmentVideoResult["matteFrames"] = [];
    const bounds: SubjectBounds[] = [];

    const bakeStart = Date.now();
    console.log(`[seg-client] baking ${frameTimes.length} frames at ${dims.width}x${dims.height} (source ${withTrueVideoDimensions(options, video).width}x${withTrueVideoDimensions(options, video).height}), sampleFps=${sampleFps}`);
    for (const [index, timeSeconds] of frameTimes.entries()) {
      assertNotCancelled(options.isCancelled);
      await seekVideo(video, startSeconds + timeSeconds);
      ctx.drawImage(video, 0, 0, dims.width, dims.height);
      const frame = ctx.getImageData(0, 0, dims.width, dims.height);

      // Hand the frame bytes to the worker (transferred, zero-copy) and get the alpha-luma back.
      // Inference is off-thread, so the event loop stays free between frames — no "page not responding".
      const luma = await runQualityFrame(frame.data, dims.width, dims.height);
      matteFrames.push({ timeSeconds, luma });
      bounds.push(lumaToSubjectBounds(luma, dims.width, dims.height, timeSeconds));

      const done = index + 1;
      if (index === 0 || done % 20 === 0 || index === frameTimes.length - 1) {
        console.log(`[seg-client] baked frame ${done}/${frameTimes.length} (${Math.round((Date.now() - bakeStart) / done)}ms/frame avg)`);
      }
      // Frame-locked (one matte frame per output frame) for max quality; long clips can be many
      // frames, so give an ETA from the running average instead of a bare counter.
      const msPerFrame = (Date.now() - bakeStart) / done;
      const remaining = frameTimes.length - done;
      options.onProgress?.(
        remaining > 0
          ? `Baked ${done} of ${frameTimes.length} frames · ~${formatEta(remaining * msPerFrame)} left`
          : `Baked ${done} of ${frameTimes.length} frames.`
      );
    }
    console.log(`[seg-client] bake complete: ${matteFrames.length} frames in ${Date.now() - bakeStart}ms`);

    if (!matteFrames.length) {
      throw new Error("Quality matting produced no usable frames.");
    }

    return buildSegmentResult(dims, matteFrames, bounds, sampleFps, "clean", "browser");
  });
}

/** "~2 min" / "~45 sec" from a millisecond estimate, for the bake progress line. */
function formatEta(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return `${seconds} sec`;
  }
  return `${Math.round(seconds / 60)} min`;
}

/** Long-side cap for the quality bake's working resolution (see segmentVideoQuality). */
const QUALITY_MAX_LONG_SIDE = 1280;

/** Caps the sampled frame to QUALITY_MAX_LONG_SIDE on its long side (even dims), preserving aspect. */
function cappedWorkingDims(options: SegmentVideoOptions): SegmentVideoOptions {
  const longSide = Math.max(options.width, options.height);
  if (longSide <= QUALITY_MAX_LONG_SIDE) {
    return options;
  }
  const scale = QUALITY_MAX_LONG_SIDE / longSide;
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { ...options, width: even(options.width), height: even(options.height) };
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

// ── High-quality matting worker client ───────────────────────────────────────────────────────────
// The RVM session and every session.run() live in segmentation.worker.ts. This client owns the
// worker lifecycle (a single cached instance shared by all mask tools), warms it, resets the
// recurrent state per clip, and round-trips one frame at a time. Because inference is off-thread the
// main-thread bake loop never blocks — no "page not responding" — and the worker serializes its own
// runs, so overlapping tool flows can't enter the non-reentrant session concurrently.
import type { SegBeginRequest, SegFrameRequest, SegWarmRequest, SegWorkerResponse } from "./segmentation.worker";

let segWorker: Worker | undefined;
let segReady: Promise<void> | undefined;
let segFrameId = 0;
let segOnProgress: ((message: string) => void) | undefined;
const segPending = new Map<number, { resolve: (luma: Uint8ClampedArray) => void; reject: (error: Error) => void }>();

/** Tears the worker down (on load failure or "Redownload engine") so the next bake starts clean. */
function resetQualityWorker(): void {
  segWorker?.terminate();
  segWorker = undefined;
  segReady = undefined;
  for (const pending of segPending.values()) {
    pending.reject(new Error("Segmentation worker reset."));
  }
  segPending.clear();
}

/** Hard cap on model load + WebGPU session init before we stop waiting and surface where it stalled. */
const WARM_TIMEOUT_MS = 90_000;

/** Boots + warms the matting worker once (cached). Rejects with a real reason if the model can't load. */
function warmQualityWorker(profile: SegmentationDeviceProfile, onProgress?: (message: string) => void): Promise<void> {
  segOnProgress = onProgress;
  if (segReady) {
    return segReady;
  }
  console.log(`[seg-client] warmQualityWorker() — ORT ${ORT_VERSION} — profile:`, profile);
  segReady = new Promise<void>((resolve, reject) => {
    // Track the last phase so a timeout can say WHERE it stalled (download vs. WebGPU session init).
    let lastPhase = "starting the matting engine";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        console.error(`[seg-client] warm TIMEOUT after ${WARM_TIMEOUT_MS}ms — stalled at: "${lastPhase}"`);
        reject(
          new Error(
            `The high-quality matting engine stalled while "${lastPhase}". This is usually the WebGPU ` +
              `runtime failing to fetch its binaries under a restrictive network. Try "Redownload engine", ` +
              `or switch this bake to Fast.`
          )
        );
      }
    }, WARM_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };
    try {
      console.log("[seg-client] creating worker…");
      const worker = new Worker(new URL("./segmentation.worker.ts", import.meta.url), { type: "module" });
      segWorker = worker;
      worker.onmessage = (event: MessageEvent<SegWorkerResponse>) => {
        const message = event.data;
        switch (message.type) {
          case "progress":
            lastPhase = "downloading the model";
            segOnProgress?.(modelProgressLine("high-quality", { loaded: message.loaded, total: message.total }));
            break;
          case "status":
            lastPhase = message.message;
            console.log("[seg-client] worker status:", message.message);
            segOnProgress?.(message.message);
            break;
          case "ready":
            console.log("[seg-client] worker READY");
            finish(resolve);
            break;
          case "load-error":
            console.error("[seg-client] worker load-error:", message.message);
            finish(() => reject(new Error(message.message)));
            break;
          case "frame": {
            const pending = segPending.get(message.id);
            if (!pending) {
              break;
            }
            segPending.delete(message.id);
            if (message.ok) {
              pending.resolve(new Uint8ClampedArray(message.luma));
            } else {
              pending.reject(new Error(message.message));
            }
            break;
          }
        }
      };
      worker.onerror = (event) => {
        console.error("[seg-client] worker onerror:", event.message, event);
        finish(() => reject(new Error(event.message || "segmentation worker crashed")));
      };
      // ORT's WebGPU EP miscomputes the fp32 RVM graph (proven: matte collapses to max≈0.72 on both
      // ["webgpu","wasm"] and ["webgpu"]), while pure WASM fp32 is correct (max=1.0) but slow. So:
      //   WebGPU device → fp16 model on WebGPU (fp16 is WebGPU's native precision → correct + fast).
      //   No WebGPU     → fp32 model on WASM (correct).
      const useWebgpu = profile.executionProvider === "webgpu";
      const executionProviders = useWebgpu ? ["webgpu", "wasm"] : ["wasm"];
      worker.postMessage({
        type: "warm",
        modelUrl: useWebgpu ? SEGMENTATION_MODEL_URLS.qualityFp16 : SEGMENTATION_MODEL_URLS.quality,
        ortUrls: onnxRuntimeUrls,
        ortWasmBase,
        executionProviders,
        precision: useWebgpu ? "fp16" : "fp32"
      } satisfies SegWarmRequest);
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
  // A failed warm must not wedge every future attempt — drop the cached promise so a retry re-boots.
  segReady.catch(() => resetQualityWorker());
  return segReady;
}

/** Resets the worker's RVM recurrent state for a fresh clip. */
function beginQualityClip(): void {
  segWorker?.postMessage({ type: "begin" } satisfies SegBeginRequest);
}

// One RVM recurrent state lives in the worker, so whole bakes must run one at a time — never
// interleave two clips' frames. Queue each bake; the next starts (with a fresh state) when the
// previous finishes or fails.
let qualityBakeChain: Promise<unknown> = Promise.resolve();
function runQualityBakeExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = qualityBakeChain.then(task, task);
  qualityBakeChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Streams one (downscaled) RGBA frame to the worker and resolves with its alpha-luma matte frame. */
function runQualityFrame(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8ClampedArray> {
  const worker = segWorker;
  if (!worker) {
    return Promise.reject(new Error("Segmentation worker not ready."));
  }
  segFrameId += 1;
  const id = segFrameId;
  return new Promise<Uint8ClampedArray>((resolve, reject) => {
    segPending.set(id, { resolve, reject });
    // getImageData hands back a fresh buffer each call, so transfer it directly (zero-copy).
    const buffer = rgba.buffer as ArrayBuffer;
    worker.postMessage({ type: "frame", id, width, height, rgba: buffer } satisfies SegFrameRequest, [buffer]);
  });
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
