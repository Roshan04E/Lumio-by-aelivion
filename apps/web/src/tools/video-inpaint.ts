import {
  assertNotCancelled,
  buildHoleForTime,
  fitProcessingDimensions,
  inpaintFrameInPlace,
  loadVideoElement,
  sampleFrameTimes,
  seekVideo,
  type InpaintMask,
  type MockInpaintFrame,
  type MockInpaintResult
} from "./mock-inpaint";
import { getLamaSession, LAMA_MODEL_SIZE } from "./local-inpainting";
import type { BrowserToolCapabilities } from "./capabilities";

/**
 * Real video inpainting orchestrator for Remove Person. Per frame:
 *  1. Center-crops the frame to a square (the LaMa model only accepts 512x512)
 *     and runs the real model on that crop - this covers the common reels
 *     framing where the subject sits centered in frame.
 *  2. Anything still masked outside that square (the letterboxed strips on a
 *     non-square source) falls back to the cheaper diffusion fill from
 *     mock-inpaint.ts, so there is never a leftover un-filled hole - just a
 *     lower-quality patch at the frame edges in the non-square case.
 * If the model fails to load at all (no WebGPU/WASM, network blocked, etc.),
 * the whole clip falls back to the pure diffusion path so the tool still
 * produces a usable (lower quality) result instead of failing outright.
 */

export interface VideoInpaintOptions {
  videoUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  mask: InpaintMask;
  feather?: number | undefined;
  capabilities: BrowserToolCapabilities;
  onProgress?: ((message: string) => void) | undefined;
  isCancelled?: (() => boolean) | undefined;
}

export interface VideoInpaintResult extends MockInpaintResult {
  /** False when the real model couldn't load and the whole clip used the diffusion fallback. */
  usedRealModel: boolean;
}

export async function runVideoInpaint(options: VideoInpaintOptions): Promise<VideoInpaintResult> {
  assertNotCancelled(options.isCancelled);

  let session: Awaited<ReturnType<typeof getLamaSession>> | undefined;
  try {
    options.onProgress?.("Loading the AI inpainting model (first run downloads ~200MB, then it's cached)...");
    session = await getLamaSession(options.capabilities);
  } catch (error) {
    options.onProgress?.(
      `Real inpainting model unavailable (${error instanceof Error ? error.message : "unknown error"}) - using the faster background-fill fallback instead.`
    );
  }
  assertNotCancelled(options.isCancelled);

  const { procW, procH } = fitProcessingDimensions(options.width, options.height);
  const video = await loadVideoElement(options.videoUrl);
  const canvas = document.createElement("canvas");
  canvas.width = procW;
  canvas.height = procH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for inpainting.");
  }

  const side = Math.min(procW, procH);
  const cropX = Math.floor((procW - side) / 2);
  const cropY = Math.floor((procH - side) / 2);

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = LAMA_MODEL_SIZE;
  cropCanvas.height = LAMA_MODEL_SIZE;
  const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
  const resultCanvas = document.createElement("canvas");
  resultCanvas.width = LAMA_MODEL_SIZE;
  resultCanvas.height = LAMA_MODEL_SIZE;
  const resultCtx = resultCanvas.getContext("2d");
  if (!cropCtx || !resultCtx) {
    throw new Error("Canvas 2D context unavailable for inpainting.");
  }

  const feather = Math.max(0, Math.round(options.feather ?? 6));
  const frameTimes = sampleFrameTimes(options.durationSeconds, options.fps);
  const frames: MockInpaintFrame[] = [];
  let usedRealModel = false;

  for (const [index, timeSeconds] of frameTimes.entries()) {
    assertNotCancelled(options.isCancelled);
    await seekVideo(video, timeSeconds);
    ctx.drawImage(video, 0, 0, procW, procH);

    const hole = buildHoleForTime(options.mask, timeSeconds, procW, procH);
    const hasAnyHole = hole.some((value) => value > 0);

    if (session && hasAnyHole) {
      try {
        await inpaintCropWithLama(session, ctx, cropCtx, resultCtx, hole, procW, procH, cropX, cropY, side);
        usedRealModel = true;
      } catch (error) {
        options.onProgress?.(`Real inpainting failed on a frame (${error instanceof Error ? error.message : "unknown error"}) - falling back for this frame.`);
        session = undefined;
      }
    }

    // Whatever the real model didn't reach (periphery outside the square crop,
    // or every pixel if the model is unavailable/failed) gets the diffusion fill.
    const image = ctx.getImageData(0, 0, procW, procH);
    const remainingHole = session ? peripheryHole(hole, procW, procH, cropX, cropY, side) : hole;
    if (remainingHole.some((value) => value > 0)) {
      inpaintFrameInPlace(image.data, remainingHole, procW, procH, feather);
      ctx.putImageData(image, 0, 0);
    }

    frames.push({ timeSeconds, rgba: ctx.getImageData(0, 0, procW, procH).data });
    options.onProgress?.(`Reconstructed frame ${index + 1} of ${frameTimes.length}.`);
  }

  if (!frames.length) {
    throw new Error("Inpainting produced no frames.");
  }

  return { width: procW, height: procH, fps: options.fps, durationSeconds: options.durationSeconds, frames, usedRealModel };
}

async function inpaintCropWithLama(
  session: Awaited<ReturnType<typeof getLamaSession>>,
  frameCtx: CanvasRenderingContext2D,
  cropCtx: CanvasRenderingContext2D,
  resultCtx: CanvasRenderingContext2D,
  hole: Uint8Array,
  procW: number,
  procH: number,
  cropX: number,
  cropY: number,
  side: number
): Promise<void> {
  // Draw the centered square crop of the current frame, scaled up/down to the model's fixed 512x512 input.
  cropCtx.drawImage(frameCtx.canvas, cropX, cropY, side, side, 0, 0, LAMA_MODEL_SIZE, LAMA_MODEL_SIZE);
  const cropImage = cropCtx.getImageData(0, 0, LAMA_MODEL_SIZE, LAMA_MODEL_SIZE);

  const imageTensor = imageDataToNchwNormalized(cropImage);
  const maskTensor = cropHoleToMaskTensor(hole, procW, cropX, cropY, side);

  const output = await session.run(imageTensor, maskTensor);
  const resultImage = nchwOutputToImageData(output);
  resultCtx.putImageData(resultImage, 0, 0);

  // Scale the model's already-composited 512x512 result back down onto the
  // frame at the crop position - this overwrites the whole square (including
  // kept pixels, which the model reproduces from the original) in one draw.
  frameCtx.drawImage(resultCtx.canvas, 0, 0, LAMA_MODEL_SIZE, LAMA_MODEL_SIZE, cropX, cropY, side, side);
}

function imageDataToNchwNormalized(image: ImageData): Float32Array {
  const { width, height, data } = image;
  const channelSize = width * height;
  const planar = new Float32Array(channelSize * 3);
  for (let i = 0; i < channelSize; i += 1) {
    planar[i] = (data[i * 4] ?? 0) / 255;
    planar[channelSize + i] = (data[i * 4 + 1] ?? 0) / 255;
    planar[channelSize * 2 + i] = (data[i * 4 + 2] ?? 0) / 255;
  }
  return planar;
}

/** Nearest-neighbour resamples the processing-resolution hole into the model's 512x512 mask tensor (1 = hole). */
function cropHoleToMaskTensor(hole: Uint8Array, procW: number, cropX: number, cropY: number, side: number): Float32Array {
  const mask = new Float32Array(LAMA_MODEL_SIZE * LAMA_MODEL_SIZE);
  for (let ty = 0; ty < LAMA_MODEL_SIZE; ty += 1) {
    const sy = cropY + Math.min(side - 1, Math.floor((ty / LAMA_MODEL_SIZE) * side));
    for (let tx = 0; tx < LAMA_MODEL_SIZE; tx += 1) {
      const sx = cropX + Math.min(side - 1, Math.floor((tx / LAMA_MODEL_SIZE) * side));
      mask[ty * LAMA_MODEL_SIZE + tx] = hole[sy * procW + sx] ? 1 : 0;
    }
  }
  return mask;
}

/** Output is NCHW float32 RGB already in 0-255 range (see local-inpainting.ts). */
function nchwOutputToImageData(output: Float32Array): ImageData {
  const plane = LAMA_MODEL_SIZE * LAMA_MODEL_SIZE;
  const data = new Uint8ClampedArray(plane * 4);
  for (let i = 0; i < plane; i += 1) {
    data[i * 4] = output[i] ?? 0;
    data[i * 4 + 1] = output[plane + i] ?? 0;
    data[i * 4 + 2] = output[plane * 2 + i] ?? 0;
    data[i * 4 + 3] = 255;
  }
  return new ImageData(data, LAMA_MODEL_SIZE, LAMA_MODEL_SIZE);
}

/** Hole pixels outside the centered square the real model already handled. */
function peripheryHole(hole: Uint8Array, procW: number, procH: number, cropX: number, cropY: number, side: number): Uint8Array {
  const remaining = new Uint8Array(hole.length);
  for (let y = 0; y < procH; y += 1) {
    const insideY = y >= cropY && y < cropY + side;
    for (let x = 0; x < procW; x += 1) {
      const p = y * procW + x;
      if (!hole[p]) {
        continue;
      }
      const insideX = x >= cropX && x < cropX + side;
      remaining[p] = insideX && insideY ? 0 : 1;
    }
  }
  return remaining;
}
