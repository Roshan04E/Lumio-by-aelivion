import { detectTextScript } from "./text-script";
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

/**
 * S0 / ADR-023 T-12 — INTERIM. Delete this predicate when D9a lands (S7 half B).
 *
 * The warp engine lays text out with opentype.js `getPath()`, which is glyph LOOKUP, not shaping:
 * it maps code points to glyphs one at a time, at advance-width spacing. For a script whose correct
 * rendering depends on shaping — cursive joining, contextual forms, reordering, mark positioning,
 * conjuncts — that produces the wrong glyphs in the wrong places, silently, and has done since warp
 * shipped. The same shape of failure as the empty `warpFontCatalog` incident
 * (`font-outlines.ts:45-50`): a broken feature that looks like a working one.
 *
 * Until warp rasterizes-then-deforms (ADR-023 D9a — shaping happens in the browser BEFORE any
 * deformation, so this gap closes structurally), warp refuses to apply itself and the editor says
 * so. A visible refusal beats a wrong render.
 *
 * The detection itself is NOT here. It lives in `text-script.ts` because a second consumer (D6a /
 * plan S0b, base text direction) asks the same question of the same string, and two detectors
 * answering one question drift apart — ADR-023 T-12 makes the single detector an obligation. Warp
 * reads exactly one field of its reading, `shapingDependent`, and has no opinion on the rest.
 */
export function isTextWarpSuppressed(warp: TextWarp | undefined, text: string | undefined): boolean {
  return hasTextWarp(warp) && detectTextScript(text).shapingDependent;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function numberOr(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? (value as number) : fallback;
}
