import type { TextWarp } from "./types";

/**
 * Text-warp parameter helpers. The actual warp is rendered by the vector envelope-mesh
 * engine: `font-outlines.ts` lays text out with opentype.js and `text-warp-mesh.ts`
 * pushes every glyph outline point through a per-style envelope. (The previous
 * `feImage`/`feDisplacementMap` pixel-displacement approach was removed - it smeared
 * glyphs and Chrome only resolved feImage for SVG-painted content, not HTML/CSS
 * filters.)
 */

export const defaultTextWarp: TextWarp = {
  style: "none",
  bend: 50,
  distortH: 0,
  distortV: 0
};

export function normalizeTextWarp(warp: TextWarp | undefined): TextWarp {
  if (!warp) {
    return defaultTextWarp;
  }
  return {
    style: warp.style ?? defaultTextWarp.style,
    bend: clamp(numberOr(warp.bend, defaultTextWarp.bend), -100, 100),
    distortH: clamp(numberOr(warp.distortH, defaultTextWarp.distortH), -100, 100),
    distortV: clamp(numberOr(warp.distortV, defaultTextWarp.distortV), -100, 100)
  };
}

export function hasTextWarp(warp: TextWarp | undefined): boolean {
  if (!warp || warp.style === "none") {
    return false;
  }
  const normalized = normalizeTextWarp(warp);
  return normalized.bend !== 0 || normalized.distortH !== 0 || normalized.distortV !== 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function numberOr(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? (value as number) : fallback;
}
