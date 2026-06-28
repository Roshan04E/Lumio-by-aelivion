/**
 * Professional Color System (Phase 3) — 3D LUT backbone (13C.3+ high-end engine).
 *
 * The high-end path bakes the WHOLE color pipeline (basic correction, curves, wheels,
 * and later HSL secondaries + imported `.cube` LUTs) into a single float **3D LUT**:
 * a `size³` grid mapping input RGB → output RGB. A GPU fragment shader then samples it
 * per pixel with trilinear interpolation at float precision — smooth (no 8-bit banding),
 * cheap (one lookup), and a perfect fit for real `.cube` LUTs. `applyPipelineToRgb`
 * (the existing CPU reference) is the baker, so the LUT and the CPU fallback agree.
 *
 * This module is pure data (no GL/DOM): the baker + a CPU trilinear sampler that mirrors
 * the shader, used by tests and the no-GL fallback. The GLSL + context live in `shader.ts`.
 */

import { applyPipelineToRgb, type Rgb } from "./cpu";
import { secondaryKey, type HslSecondary } from "./hsl";
import type { ColorPipeline } from "./types";

/** Default LUT edge size. 33 matches the common `.cube` resolution; 0.5 MB as RGBA float. */
export const LUT3D_SIZE = 33;

export interface Lut3d {
  size: number;
  /** Row-major r-fastest… actually b-slowest: index = ((b*size + g)*size + r) * 3. RGB triples. */
  data: Float32Array;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Bake a pipeline into a `size³` LUT by evaluating the CPU pipeline at every grid node.
 * Layout: `index(r,g,b) = ((b*size + g)*size + r) * 3` — r varies fastest, matching the
 * shader's texture packing.
 */
export function bakePipelineToLut3d(pipeline: ColorPipeline, size = LUT3D_SIZE): Lut3d {
  const data = new Float32Array(size * size * size * 3);
  const denom = size - 1;
  let i = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const out = applyPipelineToRgb(pipeline, [r / denom, g / denom, b / denom]);
        data[i] = out[0];
        data[i + 1] = out[1];
        data[i + 2] = out[2];
        i += 3;
      }
    }
  }
  return { size, data };
}

/**
 * Bake an HSL-secondary **key matte** into a `size³` LUT: each node maps input RGB → the
 * grayscale key value (r=g=b=key). Sampled exactly like the color LUT, so the editor's
 * "show mask" preview is the real keyer's matte, trilinearly smoothed the same way the
 * grade is. Editor-only (the matte is a UI aid, never part of an export).
 */
export function bakeMatteLut3d(secondary: HslSecondary, size = LUT3D_SIZE): Lut3d {
  const data = new Float32Array(size * size * size * 3);
  const denom = size - 1;
  let i = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const k = secondaryKey(secondary, [r / denom, g / denom, b / denom]);
        data[i] = k;
        data[i + 1] = k;
        data[i + 2] = k;
        i += 3;
      }
    }
  }
  return { size, data };
}

/** Identity LUT (input maps to itself) — used when the pipeline is a no-op. */
export function identityLut3d(size = LUT3D_SIZE): Lut3d {
  const data = new Float32Array(size * size * size * 3);
  const denom = size - 1;
  let i = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        data[i] = r / denom;
        data[i + 1] = g / denom;
        data[i + 2] = b / denom;
        i += 3;
      }
    }
  }
  return { size, data };
}

function nodeAt(lut: Lut3d, r: number, g: number, b: number): Rgb {
  const s = lut.size;
  const idx = ((b * s + g) * s + r) * 3;
  return [lut.data[idx]!, lut.data[idx + 1]!, lut.data[idx + 2]!];
}

/**
 * Trilinear sample of the LUT at `rgb` (0..1) — the exact CPU mirror of the shader's
 * `texture(lut, …)` trilinear fetch, so GPU output and the CPU fallback match.
 */
export function sampleLut3d(lut: Lut3d, rgb: Rgb): Rgb {
  const s = lut.size;
  const max = s - 1;
  const fr = clamp01(rgb[0]) * max;
  const fg = clamp01(rgb[1]) * max;
  const fb = clamp01(rgb[2]) * max;
  const r0 = Math.floor(fr);
  const g0 = Math.floor(fg);
  const b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, max);
  const g1 = Math.min(g0 + 1, max);
  const b1 = Math.min(b0 + 1, max);
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;

  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const c000 = nodeAt(lut, r0, g0, b0)[c]!;
    const c100 = nodeAt(lut, r1, g0, b0)[c]!;
    const c010 = nodeAt(lut, r0, g1, b0)[c]!;
    const c110 = nodeAt(lut, r1, g1, b0)[c]!;
    const c001 = nodeAt(lut, r0, g0, b1)[c]!;
    const c101 = nodeAt(lut, r1, g0, b1)[c]!;
    const c011 = nodeAt(lut, r0, g1, b1)[c]!;
    const c111 = nodeAt(lut, r1, g1, b1)[c]!;
    const c00 = c000 + (c100 - c000) * dr;
    const c10 = c010 + (c110 - c010) * dr;
    const c01 = c001 + (c101 - c001) * dr;
    const c11 = c011 + (c111 - c011) * dr;
    const c0 = c00 + (c10 - c00) * dg;
    const c1 = c01 + (c11 - c01) * dg;
    out[c] = c0 + (c1 - c0) * db;
  }
  return out;
}
