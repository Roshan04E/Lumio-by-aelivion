import type { MatteRef } from "./types";

/**
 * Pure, DOM-free matte compositing math. Both the web preview (canvas) and the
 * Remotion renderer (canvas, per-frame) must call these functions so a masked
 * layer renders identically in the editor and in the exported video. Do not
 * duplicate this math in either renderer - that duplication is exactly what
 * caused the preview/export "grow-in zoom" parity bug (see AGENTS.md).
 */

export interface CompositeMatteOptions {
  feather: number;
  edgeMode: "fast" | "clean";
  invert?: boolean | undefined;
  opacity?: number | undefined;
}

/**
 * Multiplies the alpha channel of `rgba` by a luma sample read from `matteLuma`.
 * Both buffers must be the same width/height and use RGBA8 layout (4 bytes/px).
 * Mutates and returns `rgba` in place to avoid an extra allocation per frame.
 */
export function compositeMatteToImageData(
  rgba: Uint8ClampedArray,
  matteLuma: Uint8ClampedArray,
  width: number,
  height: number,
  options: CompositeMatteOptions
): Uint8ClampedArray {
  const opacity = clamp01(options.opacity ?? 1);
  const featherPx = Math.max(0, Math.round(options.feather));
  const pixelCount = width * height;

  const coverage = scratchCoverage(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    coverage[i] = cleanCoverage(matteLuma[i * 4] ?? 0);
  }

  const feathered = featherPx > 0 ? boxBlurCoverage(coverage, width, height, featherPx) : coverage;

  for (let i = 0; i < pixelCount; i += 1) {
    let value = feathered[i]!;
    if (options.invert) {
      value = 1 - value;
    }

    const alphaIndex = i * 4 + 3;
    const sourceAlpha = rgba[alphaIndex] ?? 255;
    rgba[alphaIndex] = clampByte(sourceAlpha * value * opacity);
  }

  return rgba;
}

// Lossy video encoding (VP9) of an otherwise-binary segmentation mask can leave
// flat background/foreground regions a few luma units off pure 0/255. Snap
// anything confidently outside the transition band to exact 0 or 1 so codec
// noise can't show up as a faint background haze - only genuine edge pixels
// keep an intermediate value for the blur pass below to soften.
const NOISE_FLOOR = 24;
const NOISE_CEILING = 232;

function cleanCoverage(luma: number): number {
  if (luma <= NOISE_FLOOR) {
    return 0;
  }
  if (luma >= NOISE_CEILING) {
    return 1;
  }
  return luma / 255;
}

let scratchCoverageBuffer: Float32Array | undefined;
let scratchHorizontalBuffer: Float32Array | undefined;
let scratchVerticalBuffer: Float32Array | undefined;

function scratchCoverage(pixelCount: number): Float32Array {
  if (!scratchCoverageBuffer || scratchCoverageBuffer.length !== pixelCount) {
    scratchCoverageBuffer = new Float32Array(pixelCount);
  }
  return scratchCoverageBuffer;
}

/**
 * Real spatial feathering: a separable box blur over the coverage map. Unlike
 * a per-pixel "blend toward 0.5", this only softens pixels near an actual
 * foreground/background transition - flat interior regions (all neighbors the
 * same value) come out of the blur unchanged, so a deep-background pixel stays
 * fully transparent and a deep-foreground pixel stays fully opaque.
 */
function boxBlurCoverage(coverage: Float32Array, width: number, height: number, radius: number): Float32Array {
  const pixelCount = width * height;
  if (!scratchHorizontalBuffer || scratchHorizontalBuffer.length !== pixelCount) {
    scratchHorizontalBuffer = new Float32Array(pixelCount);
  }
  if (!scratchVerticalBuffer || scratchVerticalBuffer.length !== pixelCount) {
    scratchVerticalBuffer = new Float32Array(pixelCount);
  }
  boxBlurPass(coverage, scratchHorizontalBuffer, width, height, radius, true);
  boxBlurPass(scratchHorizontalBuffer, scratchVerticalBuffer, width, height, radius, false);
  return scratchVerticalBuffer;
}

function boxBlurPass(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean
): void {
  const windowSize = radius * 2 + 1;
  if (horizontal) {
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * width;
      let sum = 0;
      for (let x = -radius; x <= radius; x += 1) {
        sum += src[rowStart + clampIndex(x, width)]!;
      }
      for (let x = 0; x < width; x += 1) {
        dst[rowStart + x] = sum / windowSize;
        const outIndex = clampIndex(x - radius, width);
        const inIndex = clampIndex(x + radius + 1, width);
        sum += src[rowStart + inIndex]! - src[rowStart + outIndex]!;
      }
    }
    return;
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += src[clampIndex(y, height) * width + x]!;
    }
    for (let y = 0; y < height; y += 1) {
      dst[y * width + x] = sum / windowSize;
      const outIndex = clampIndex(y - radius, height);
      const inIndex = clampIndex(y + radius + 1, height);
      sum += src[inIndex * width + x]! - src[outIndex * width + x]!;
    }
  }
}

function clampIndex(value: number, max: number): number {
  return Math.min(max - 1, Math.max(0, value));
}

/** Maps a composition time to the nearest matte frame index for a given matte fps. */
export function matteFrameIndexAtTime(timeSeconds: number, matte: Pick<MatteRef, "fps">): number {
  return Math.max(0, Math.round(timeSeconds * matte.fps));
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}
