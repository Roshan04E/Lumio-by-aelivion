import type { TextWarp } from "./types";

/**
 * Text-warp parameter helpers. The warp itself is RASTERIZE-THEN-DEFORM (ADR-023 D9a): the text is
 * drawn by the browser, with the browser's own shaping, and the finished raster is pushed through
 * the envelope field in `text-warp-mesh.ts` by `scene/text-warp-deform.ts`.
 *
 * Two earlier engines are recorded here so neither is reached for again. `feImage` /
 * `feDisplacementMap` pixel displacement smeared glyphs, and Chrome only resolved `feImage` for
 * SVG-painted content, not HTML/CSS filters. The `opentype.js` outline engine that replaced it
 * deformed glyph OUTLINES, which meant it did glyph lookup rather than shaping and rendered every
 * cursive, reordering or mark-positioning script wrong — the gap T-12 guarded and D9a closed.
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

// ADR-023 T-12 RETIRED 2026-08-15 (D9a). `isTextWarpSuppressed` lived here and is DELETED rather
// than left returning false: warp now rasterizes through the browser's shaper before it deforms, so
// there is no shaping-dependent script it renders wrong and nothing to suppress. A predicate that
// always answers "no" is a trap for the next reader, who has to prove it is vacuous before touching
// anything near it. The detector it called (`detectTextScript`) stays — it has two live consumers,
// base direction (D6a/T-13) and S9's per-character animation, which cannot animate a cluster whose
// shaping it would break (T-14).

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function numberOr(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? (value as number) : fallback;
}
