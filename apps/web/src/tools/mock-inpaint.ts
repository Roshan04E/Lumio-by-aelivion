/**
 * Mock video inpainting for the Remove Person tool.
 *
 * This is the deliberate "placeholder fill" path described in the tool's
 * limitations: it does NOT run a real LaMa/STTN model. Instead it reconstructs
 * the hole left by the removed subject by diffusing surrounding background color
 * inward (a downscaled iterative neighbour-fill), then feather-blends that fill
 * over the original frame. It produces a full-frame, person-removed RGB clip that
 * is schema-correct and good enough to drive the whole product flow (select ->
 * preview -> apply -> render). The real per-frame inpainting + SAM2 tracking is a
 * later cloud/browser stage that returns the same artifact shape.
 *
 * Mirrors the lazy-load / progress / cancel conventions of local-segmentation.ts.
 */

export interface InpaintMaskFrame {
  timeSeconds: number;
  /** Single-channel coverage, length = width*height. 255 = remove (subject), 0 = keep. */
  coverage: Uint8Array;
}

export interface InpaintMask {
  width: number;
  height: number;
  frames: InpaintMaskFrame[];
}

export interface MockInpaintOptions {
  videoUrl: string;
  durationSeconds: number;
  /** Source true dimensions (used for aspect ratio). */
  width: number;
  height: number;
  /** Output clip frame rate. */
  fps: number;
  mask: InpaintMask;
  /** Edge softness in pixels (in processing resolution). */
  feather?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
  isCancelled?: (() => boolean) | undefined;
}

export interface MockInpaintFrame {
  timeSeconds: number;
  /** RGBA8, length = width*height*4, fully opaque. */
  rgba: Uint8ClampedArray;
}

export interface MockInpaintResult {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  frames: MockInpaintFrame[];
}

// Processing/output is capped so the per-pixel diffusion + WebCodecs encode stay
// responsive on any device. The clip is scaled to fit the composition anyway, so
// a placeholder fill does not need full source resolution.
const MAX_OUTPUT_DIMENSION = 540;
// The API's createAsset schema floors width/height at 320 (packages/shared/src/schemas.ts).
// A clip narrower than this on its short side fails the real upload and silently
// degrades to the browser-local-only fallback - for standard 9:16 reels (aspect
// ~1.78), capping the long side at 540 alone pushes the short side to ~304,
// just under that floor. Enforced as a hard floor below, even if it means
// exceeding MAX_OUTPUT_DIMENSION on extreme aspect ratios.
const MIN_OUTPUT_DIMENSION = 320;

export async function runMockInpaint(options: MockInpaintOptions): Promise<MockInpaintResult> {
  assertNotCancelled(options.isCancelled);
  options.onProgress?.("Preparing background reconstruction...");

  const { procW, procH } = fitProcessingDimensions(options.width, options.height);
  const video = await loadVideoElement(options.videoUrl);
  const canvas = document.createElement("canvas");
  canvas.width = procW;
  canvas.height = procH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for inpainting.");
  }

  const feather = Math.max(0, Math.round(options.feather ?? 6));
  const frameTimes = sampleFrameTimes(options.durationSeconds, options.fps);
  const frames: MockInpaintFrame[] = [];

  for (const [index, timeSeconds] of frameTimes.entries()) {
    assertNotCancelled(options.isCancelled);
    await seekVideo(video, timeSeconds);
    ctx.drawImage(video, 0, 0, procW, procH);
    const image = ctx.getImageData(0, 0, procW, procH);

    const hole = buildHoleForTime(options.mask, timeSeconds, procW, procH);
    inpaintFrameInPlace(image.data, hole, procW, procH, feather);
    frames.push({ timeSeconds, rgba: image.data });

    options.onProgress?.(`Reconstructed frame ${index + 1} of ${frameTimes.length}.`);
  }

  if (!frames.length) {
    throw new Error("Inpainting produced no frames.");
  }

  return { width: procW, height: procH, fps: options.fps, durationSeconds: options.durationSeconds, frames };
}

export function fitProcessingDimensions(width: number, height: number): { procW: number; procH: number } {
  const w = width || 720;
  const h = height || 1280;
  const longSide = Math.max(w, h);
  const shortSide = Math.min(w, h);
  let scale = longSide > MAX_OUTPUT_DIMENSION ? MAX_OUTPUT_DIMENSION / longSide : 1;
  scale = Math.max(scale, MIN_OUTPUT_DIMENSION / shortSide);
  // VP9 encoders want even dimensions.
  const procW = Math.max(2, Math.round((w * scale) / 2) * 2);
  const procH = Math.max(2, Math.round((h * scale) / 2) * 2);
  return { procW, procH };
}

/** Nearest-in-time mask frame, nearest-neighbour resampled into the processing grid. */
export function buildHoleForTime(mask: InpaintMask, timeSeconds: number, procW: number, procH: number): Uint8Array {
  const frame = nearestMaskFrame(mask.frames, timeSeconds);
  const hole = new Uint8Array(procW * procH);
  if (!frame) {
    return hole;
  }
  const { width: mw, height: mh } = mask;
  for (let y = 0; y < procH; y += 1) {
    const my = Math.min(mh - 1, Math.floor((y / procH) * mh));
    for (let x = 0; x < procW; x += 1) {
      const mx = Math.min(mw - 1, Math.floor((x / procW) * mw));
      hole[y * procW + x] = (frame.coverage[my * mw + mx] ?? 0) > 128 ? 1 : 0;
    }
  }
  return hole;
}

function nearestMaskFrame(frames: InpaintMaskFrame[], timeSeconds: number): InpaintMaskFrame | undefined {
  if (!frames.length) {
    return undefined;
  }
  let best = frames[0]!;
  let bestDelta = Math.abs(best.timeSeconds - timeSeconds);
  for (const frame of frames) {
    const delta = Math.abs(frame.timeSeconds - timeSeconds);
    if (delta < bestDelta) {
      best = frame;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Fills the masked hole by diffusing surrounding background color inward on a
 * downscaled grid (cheap and stable), then bilinearly samples that grid back per
 * hole pixel and feather-blends it over the original. The grid step avoids the
 * person's own color contaminating the fill and keeps the iteration count small.
 */
export function inpaintFrameInPlace(rgba: Uint8ClampedArray, hole: Uint8Array, width: number, height: number, feather: number): void {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 96));
  const gw = Math.ceil(width / step);
  const gh = Math.ceil(height / step);
  const cells = gw * gh;

  const sumR = new Float32Array(cells);
  const sumG = new Float32Array(cells);
  const sumB = new Float32Array(cells);
  const known = new Float32Array(cells);

  for (let y = 0; y < height; y += 1) {
    const gy = Math.floor(y / step);
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (hole[p]) {
        continue;
      }
      const cell = gy * gw + Math.floor(x / step);
      sumR[cell]! += rgba[p * 4]!;
      sumG[cell]! += rgba[p * 4 + 1]!;
      sumB[cell]! += rgba[p * 4 + 2]!;
      known[cell]! += 1;
    }
  }

  const r = new Float32Array(cells);
  const g = new Float32Array(cells);
  const b = new Float32Array(cells);
  const filled = new Uint8Array(cells);
  for (let c = 0; c < cells; c += 1) {
    if (known[c]! > 0) {
      r[c] = sumR[c]! / known[c]!;
      g[c] = sumG[c]! / known[c]!;
      b[c] = sumB[c]! / known[c]!;
      filled[c] = 1;
    }
  }

  // Iteratively grow known cells into unknown ones (4-neighbour average).
  const maxPasses = gw + gh;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = 0;
    for (let cy = 0; cy < gh; cy += 1) {
      for (let cx = 0; cx < gw; cx += 1) {
        const c = cy * gw + cx;
        if (filled[c]) {
          continue;
        }
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        if (cx > 0 && filled[c - 1]) { sr += r[c - 1]!; sg += g[c - 1]!; sb += b[c - 1]!; n += 1; }
        if (cx < gw - 1 && filled[c + 1]) { sr += r[c + 1]!; sg += g[c + 1]!; sb += b[c + 1]!; n += 1; }
        if (cy > 0 && filled[c - gw]) { sr += r[c - gw]!; sg += g[c - gw]!; sb += b[c - gw]!; n += 1; }
        if (cy < gh - 1 && filled[c + gw]) { sr += r[c + gw]!; sg += g[c + gw]!; sb += b[c + gw]!; n += 1; }
        if (n > 0) {
          r[c] = sr / n;
          g[c] = sg / n;
          b[c] = sb / n;
          filled[c] = 1;
          changed += 1;
        }
      }
    }
    if (!changed) {
      break;
    }
  }

  const coverage = featherCoverage(hole, width, height, feather);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const cov = coverage[p]!;
      if (cov <= 0) {
        continue;
      }
      const cell = Math.floor(y / step) * gw + Math.floor(x / step);
      const fr = r[cell]!;
      const fg = g[cell]!;
      const fb = b[cell]!;
      rgba[p * 4] = Math.round(rgba[p * 4]! * (1 - cov) + fr * cov);
      rgba[p * 4 + 1] = Math.round(rgba[p * 4 + 1]! * (1 - cov) + fg * cov);
      rgba[p * 4 + 2] = Math.round(rgba[p * 4 + 2]! * (1 - cov) + fb * cov);
      rgba[p * 4 + 3] = 255;
    }
  }
}

/** Turns the binary hole into a 0..1 coverage map, softened by a box blur for feathered edges. */
function featherCoverage(hole: Uint8Array, width: number, height: number, feather: number): Float32Array {
  const coverage = new Float32Array(hole.length);
  for (let i = 0; i < hole.length; i += 1) {
    coverage[i] = hole[i] ? 1 : 0;
  }
  if (feather <= 0) {
    return coverage;
  }
  return boxBlur(boxBlur(coverage, width, height, feather, true), width, height, feather, false);
}

function boxBlur(src: Float32Array, width: number, height: number, radius: number, horizontal: boolean): Float32Array {
  const dst = new Float32Array(src.length);
  const windowSize = radius * 2 + 1;
  if (horizontal) {
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      for (let x = -radius; x <= radius; x += 1) {
        sum += src[row + clampIndex(x, width)]!;
      }
      for (let x = 0; x < width; x += 1) {
        dst[row + x] = sum / windowSize;
        sum += src[row + clampIndex(x + radius + 1, width)]! - src[row + clampIndex(x - radius, width)]!;
      }
    }
    return dst;
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += src[clampIndex(y, height) * width + x]!;
    }
    for (let y = 0; y < height; y += 1) {
      dst[y * width + x] = sum / windowSize;
      sum += src[clampIndex(y + radius + 1, height) * width + x]! - src[clampIndex(y - radius, height) * width + x]!;
    }
  }
  return dst;
}

function clampIndex(value: number, max: number): number {
  return Math.min(max - 1, Math.max(0, value));
}

export function sampleFrameTimes(durationSeconds: number, fps: number): number[] {
  const count = Math.max(1, Math.round(Math.max(0.1, durationSeconds) * fps));
  return Array.from({ length: count }, (_, index) => Math.min(durationSeconds, index / fps));
}

export async function loadVideoElement(videoUrl: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Unable to load video for inpainting."));
  });
  return video;
}

export function seekVideo(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  return new Promise((resolve) => {
    video.onseeked = () => resolve();
    video.currentTime = timeSeconds;
  });
}

export function assertNotCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) {
    throw new Error("Inpainting cancelled.");
  }
}
