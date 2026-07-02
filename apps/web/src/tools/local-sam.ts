import type { MaskSequenceArtifactData, TrackingPathArtifactData } from "@lumio-by-aelivion/shared";
import type { BrowserToolCapabilities } from "./capabilities";
import type { SegmentVideoResult } from "./local-segmentation";
import { loadVideoElement, sampleFrameTimes, seekVideo } from "./local-segmentation";

/**
 * Promptable, ANY-OBJECT segmentation (SAM family) for the AI roto tool. Unlike
 * local-segmentation.ts (person-only: MediaPipe selfie / RVM matting), SAM lets
 * the user point at *anything* — a person AND the bike or notebook they hold — so
 * the matte can cover the whole subject group, not just a detected person.
 *
 * Runs entirely in the browser via Transformers.js (the same `@huggingface/transformers`
 * runtime + lazy-CDN-import pattern local-transcription.ts already uses), with the
 * WebGPU execution provider and an automatic WASM fallback. Model id is
 * `Xenova/slimsam-77-uniform` — a tiny, pruned SAM whose ONNX weights (vision_encoder
 * + prompt_encoder_mask_decoder) Transformers.js resolves from the HF Hub itself, so
 * there is no hand-assembled weight URL to drift (only the runtime CDN, already proven).
 *
 * The standard SAM web split makes the interactive UX fast: encode a frame ONCE
 * (heavy) and cache its embeddings; every click then runs only the tiny prompt
 * decoder (cheap) → instant mask preview. The heavy per-frame propagation is the
 * separate opt-in "bake" step (see segmentVideoPrompted, Slice 3).
 */

// SlimSAM: ~tiny pruned SAM. Transformers.js fetches onnx/{vision_encoder,prompt_encoder_mask_decoder}.onnx
// (+ fp16/quantized variants) from this Hub repo automatically — verified the repo + onnx files resolve.
const SAM_MODEL_ID = "Xenova/slimsam-77-uniform";

// Same runtime + CDN candidates as local-transcription.ts (proven to load in-browser).
const transformersUrls = [
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2",
  "https://esm.sh/@huggingface/transformers@3.7.2"
];

export type SamExecutionProvider = "webgpu" | "wasm";

export interface SamDeviceProfile {
  executionProvider: SamExecutionProvider;
  /** fp16 on WebGPU (fast + accurate); q8 on WASM (keeps the CPU fallback usable). */
  dtype: "fp16" | "q8";
  suggestCloudOffload: boolean;
}

/** A point prompt in NORMALIZED frame coords (0..1), so it's resolution-independent. */
export interface SamPoint {
  x: number;
  y: number;
}

export interface SamPrompt {
  /** Foreground clicks — "include this" (person, bike, notebook…). */
  positive: SamPoint[];
  /** Background clicks — "exclude this" (fix over-selection). */
  negative: SamPoint[];
}

/** A frame encoded once; pass back to `decode` for every click (cheap). */
export interface EncodedFrame {
  embeddings: Record<string, unknown>;
  originalSizes: unknown;
  reshapedInputSizes: unknown;
  /** Reshaped [height, width] used to scale normalized points into model space. */
  reshaped: [number, number];
  width: number;
  height: number;
}

export interface SamSession {
  /** Encode a video frame (heavy). Cache the result and reuse it for every click. */
  encodeFrame: (frame: ImageData) => Promise<EncodedFrame>;
  /**
   * Decode ONE object's mask from point prompts (cheap). Returns an RGBA luma matte
   * (255 = keep) at the frame's native size — the same shape local-segmentation.ts
   * produces, so it feeds the existing matte pipeline unchanged.
   */
  decode: (frame: EncodedFrame, prompt: SamPrompt) => Promise<Uint8ClampedArray>;
}

/** SAM needs real GPU/CPU ML; gate the tool on the same signals as the matting tier. */
export function isSamSupported(capabilities: BrowserToolCapabilities): boolean {
  // WASM path works without WebGPU (slower), but requires the basic browser runtime.
  return capabilities.webWorkers;
}

export function chooseSamDeviceProfile(
  _capabilities: BrowserToolCapabilities,
  clipDurationSeconds: number
): SamDeviceProfile {
  // We self-host the QUANTIZED (q8) SlimSAM weights (~14MB) and run them on the WASM
  // execution provider: universally supported, and SlimSAM is tiny so a single-frame
  // encode is fast enough for interactive use (encode once per frame, decode per click
  // is cheap). WebGPU + fp16 is a future speed upgrade — it needs the fp16 weights
  // hosted too; q8-on-WebGPU has spotty int8 op support, so we don't risk it yet.
  return {
    executionProvider: "wasm",
    dtype: "q8",
    suggestCloudOffload: clipDurationSeconds > 45
  };
}

// --- Transformers.js minimal typings (dynamic import; mirrors local-transcription.ts's loose typing) ---

interface SamTensor {
  data: ArrayLike<number> | BigInt64Array;
  dims: number[];
}

interface SamProcessorOutput {
  original_sizes: unknown;
  reshaped_input_sizes: number[][];
}

interface SamProcessor {
  (image: unknown): Promise<SamProcessorOutput>;
  post_process_masks: (predMasks: unknown, originalSizes: unknown, reshapedInputSizes: unknown) => Promise<SamTensor[]>;
}

interface SamModelInstance {
  get_image_embeddings: (visionInputs: SamProcessorOutput) => Promise<Record<string, unknown>>;
  (inputs: Record<string, unknown>): Promise<{ pred_masks: unknown; iou_scores: SamTensor }>;
}

interface TransformersEnv {
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  localModelPath: string;
  backends?: { onnx?: { wasm?: { proxy?: boolean; numThreads?: number } } };
}

interface TransformersSamModule {
  env: TransformersEnv;
  SamModel: { from_pretrained: (id: string, options?: Record<string, unknown>) => Promise<SamModelInstance> };
  AutoProcessor: { from_pretrained: (id: string, options?: Record<string, unknown>) => Promise<SamProcessor> };
  RawImage: new (data: Uint8ClampedArray, width: number, height: number, channels: number) => { rgb: () => unknown };
  Tensor: new (type: string, data: ArrayLike<number> | BigInt64Array, dims: number[]) => unknown;
}

interface LoadedSam {
  model: SamModelInstance;
  processor: SamProcessor;
  mod: TransformersSamModule;
}

let cachedSam: Promise<LoadedSam> | undefined;

export async function getSamSession(profile: SamDeviceProfile): Promise<SamSession> {
  const loaded = await getLoadedSam(profile);
  const { model, processor, mod } = loaded;

  return {
    async encodeFrame(frame: ImageData): Promise<EncodedFrame> {
      const image = new mod.RawImage(new Uint8ClampedArray(frame.data), frame.width, frame.height, 4).rgb();
      const visionInputs = await processor(image);
      const embeddings = await model.get_image_embeddings(visionInputs);
      const reshapedPair = visionInputs.reshaped_input_sizes[0] ?? [frame.height, frame.width];
      return {
        embeddings,
        originalSizes: visionInputs.original_sizes,
        reshapedInputSizes: visionInputs.reshaped_input_sizes,
        reshaped: [reshapedPair[0] ?? frame.height, reshapedPair[1] ?? frame.width],
        width: frame.width,
        height: frame.height
      };
    },

    async decode(frame: EncodedFrame, prompt: SamPrompt): Promise<Uint8ClampedArray> {
      const points = [...prompt.positive.map((p) => ({ p, label: 1 })), ...prompt.negative.map((p) => ({ p, label: 0 }))];
      if (!points.length) {
        return new Uint8ClampedArray(frame.width * frame.height * 4);
      }
      const [reshapedH, reshapedW] = frame.reshaped;
      // Model space = reshaped input. Normalized point → reshaped pixel coords (x*W, y*H).
      const coords = points.flatMap(({ p }) => [p.x * reshapedW, p.y * reshapedH]);
      const labels = points.map(({ label }) => BigInt(label));
      const inputPoints = new mod.Tensor("float32", Float32Array.from(coords), [1, 1, points.length, 2]);
      const inputLabels = new mod.Tensor("int64", BigInt64Array.from(labels), [1, 1, points.length]);

      const outputs = await model({ ...frame.embeddings, input_points: inputPoints, input_labels: inputLabels });
      const masks = await processor.post_process_masks(outputs.pred_masks, frame.originalSizes, frame.reshapedInputSizes);
      const mask = masks[0];
      if (!mask) {
        return new Uint8ClampedArray(frame.width * frame.height * 4);
      }
      return bestMaskToLuma(mask, outputs.iou_scores, frame.width, frame.height);
    }
  };
}

async function getLoadedSam(profile: SamDeviceProfile): Promise<LoadedSam> {
  cachedSam ??= loadSam(profile);
  return cachedSam;
}

async function loadSam(profile: SamDeviceProfile): Promise<LoadedSam> {
  const mod = await loadTransformers();
  configureModelHost(mod);
  const tryLoad = async (provider: SamExecutionProvider, dtype: SamDeviceProfile["dtype"]): Promise<LoadedSam> => {
    const model = await mod.SamModel.from_pretrained(SAM_MODEL_ID, { device: provider, dtype });
    const processor = await mod.AutoProcessor.from_pretrained(SAM_MODEL_ID);
    return { model, processor, mod };
  };

  try {
    return await tryLoad(profile.executionProvider, profile.dtype);
  } catch (error) {
    if (profile.executionProvider === "webgpu") {
      // WebGPU init can fail on some drivers — fall back to CPU (slower, still correct).
      return tryLoad("wasm", "q8");
    }
    throw new Error(`Unable to load the AI roto model. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

/**
 * Lazy model fetch on first tool use (NOT bundled), browser-cached after. Prefer a
 * SAME-ORIGIN self-hosted copy under `/models/<id>/…` (apps/web/public/models/…) so
 * loading never depends on HuggingFace's Xet CDN — that host is TLS-blocked on some
 * networks and the HF mirror is CORS-blocked. Remote (HF Hub) stays enabled as a
 * fallback for networks that can reach it (and where the local copy isn't present).
 * Only the weights move local; the Transformers.js runtime still loads from its CDN.
 */
function configureModelHost(mod: TransformersSamModule): void {
  mod.env.allowLocalModels = true;
  mod.env.localModelPath = "/models/";
  mod.env.allowRemoteModels = true;
  // CRITICAL: run onnxruntime-web in a Web Worker so the heavy SlimSAM encoder never blocks the
  // main thread (otherwise the tab goes white/unresponsive during encode, and React can't even paint
  // a loading indicator). numThreads stays at the default (1 unless cross-origin-isolated), so this
  // needs no SharedArrayBuffer/COOP+COEP.
  const wasm = mod.env.backends?.onnx?.wasm;
  if (wasm) {
    wasm.proxy = true;
  }
}

async function loadTransformers(): Promise<TransformersSamModule> {
  let lastError: unknown;
  for (const url of transformersUrls) {
    try {
      const mod = (await import(/* @vite-ignore */ url)) as Partial<TransformersSamModule>;
      if (mod.SamModel && mod.AutoProcessor && mod.RawImage && mod.Tensor) {
        return mod as TransformersSamModule;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to load the local AI segmentation runtime. ${lastError instanceof Error ? lastError.message : ""}`.trim());
}

/**
 * SAM returns 3 candidate masks per prompt (whole/part/sub-part) with IoU scores;
 * pick the highest-scoring one and rasterize it to an RGBA luma matte (255 = keep)
 * at the frame's native size — matching local-segmentation.ts's matte byte layout.
 */
function bestMaskToLuma(mask: SamTensor, iouScores: SamTensor, width: number, height: number): Uint8ClampedArray {
  const luma = new Uint8ClampedArray(width * height * 4);
  if (!mask || !mask.dims || mask.dims.length < 2) {
    return luma;
  }
  // mask.dims = [1, numMasks, H, W]; iou_scores.data = [score0, score1, score2].
  const numMasks = mask.dims[mask.dims.length - 3] ?? 1;
  const h = mask.dims[mask.dims.length - 2] ?? height;
  const w = mask.dims[mask.dims.length - 1] ?? width;
  const scores = iouScores?.data as ArrayLike<number> | undefined;
  let best = 0;
  if (scores && numMasks > 1) {
    for (let i = 1; i < numMasks; i += 1) {
      if (Number(scores[i] ?? 0) > Number(scores[best] ?? 0)) best = i;
    }
  }
  const planeOffset = best * h * w;
  const data = mask.data as ArrayLike<number>;
  // post_process_masks already resizes to original size, so h/w should equal height/width;
  // guard with a nearest-sample in case a runtime returns the model-space mask instead.
  for (let y = 0; y < height; y += 1) {
    const sy = h === height ? y : Math.min(h - 1, Math.floor((y / height) * h));
    for (let x = 0; x < width; x += 1) {
      const sx = w === width ? x : Math.min(w - 1, Math.floor((x / width) * w));
      const on = Number(data[planeOffset + sy * w + sx] ?? 0) > 0 ? 255 : 0;
      const o = (y * width + x) * 4;
      luma[o] = on;
      luma[o + 1] = on;
      luma[o + 2] = on;
      luma[o + 3] = 255;
    }
  }
  return luma;
}

// --- Propagation + bake (the heavy, opt-in step) ------------------------------------------------

export interface PromptedSegmentOptions {
  videoUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  /** Target matte fps; frame-lock to the composition fps for clean output (capped). */
  targetFps: number;
  /** The point prompt the user authored on the reference frame (normalized coords). */
  prompt: SamPrompt;
  profile: SamDeviceProfile;
  onProgress?: ((message: string) => void) | undefined;
  isCancelled?: (() => boolean) | undefined;
}

/**
 * Bakes a per-frame matte by applying the user's point prompt across the clip. Returns a
 * {@link SegmentVideoResult} so the existing matte pipeline (storeMatteArtifact → MatteRef →
 * all three renderers) consumes it unchanged.
 *
 * Propagation v1 holds the user's prompt points constant across frames (re-encode + re-decode
 * each frame). Exact for static/slow subjects; for fast motion the points can drift off the
 * subject — true SAM2 memory-attention video tracking (or prior-mask-centroid re-seeding) is
 * the documented follow-up. Isolated here so only this function changes when we upgrade it.
 */
export async function segmentVideoPrompted(options: PromptedSegmentOptions): Promise<SegmentVideoResult> {
  const session = await getSamSession(options.profile);
  const fps = Math.min(24, Math.max(1, Math.round(options.targetFps)));
  const frameTimes = sampleFrameTimes(options.durationSeconds, fps);
  const video = await loadVideoElement(options.videoUrl);
  const width = video.videoWidth || options.width;
  const height = video.videoHeight || options.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for AI roto.");
  }

  const matteFrames: SegmentVideoResult["matteFrames"] = [];
  for (const [index, timeSeconds] of frameTimes.entries()) {
    if (options.isCancelled?.()) {
      throw new Error("AI roto cancelled.");
    }
    await seekVideo(video, timeSeconds);
    ctx.drawImage(video, 0, 0, width, height);
    const frame = ctx.getImageData(0, 0, width, height);
    const encoded = await session.encodeFrame(frame);
    const luma = await session.decode(encoded, options.prompt);
    matteFrames.push({ timeSeconds, luma });
    options.onProgress?.(`Tracked frame ${index + 1} of ${frameTimes.length}.`);
  }

  if (!matteFrames.length) {
    throw new Error("AI roto produced no frames.");
  }

  const maskSequence: MaskSequenceArtifactData = {
    id: `mask_browser_sam_${Date.now()}`,
    width,
    height,
    fps,
    durationSeconds: options.durationSeconds,
    feather: 3,
    edgeMode: "clean",
    source: "browser",
    frames: matteFrames.map((frame) => ({ timeSeconds: frame.timeSeconds, width, height, previewPath: "", confidence: 0.85 }))
  };
  const trackingPath: TrackingPathArtifactData = {
    id: `track_browser_sam_${Date.now()}`,
    durationSeconds: options.durationSeconds,
    smoothing: 0.4,
    source: "browser",
    points: []
  };
  return { maskSequence, trackingPath, subjectBounds: [], matteFrames };
}

/**
 * Pixel-wise UNION of two RGBA luma mattes (max of the luma channel). Used to combine
 * the auto-seeded person mask with each clicked object (bike, notebook) into one matte,
 * since SAM decodes one object per prompt group. Returns a new buffer.
 */
export function unionLuma(a: Uint8ClampedArray, b: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) {
    const v = Math.max(a[i] ?? 0, b[i] ?? 0);
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}
