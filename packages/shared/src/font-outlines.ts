import { catalogueFace, catalogueFamily, LEGACY_WARP_FAMILY_ALIASES } from "./font-catalogue";
import type { PathCommand } from "./text-warp-mesh";

/**
 * Font-outline service for the vector text-warp engine.
 *
 * opentype.js needs the actual font *binary* (the browser cannot read outlines from
 * installed system fonts), so each app injects a resolver that maps a font family to a
 * fetchable binary URL. This is the seam for a future large (Canva-scale) font library:
 * only the specific font a warped layer uses is ever fetched, parsed once, and cached.
 *
 * opentype.js itself is lazy-imported the first time a warp is built, so projects with
 * no warped text never pay for it.
 */

/** Minimal shape of the opentype.js objects we use (avoids a hard type dependency). */
interface OpentypeFont {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  getPath(text: string, x: number, y: number, fontSize: number): { commands: PathCommand[] };
  getAdvanceWidth(text: string, fontSize: number): number;
}
interface OpentypeModule {
  parse(buffer: ArrayBuffer): OpentypeFont;
}

/**
 * Fallback binary when a family has no catalogue face — warp still works while the library grows.
 *
 * Use `.ttf/.otf/.woff` (opentype.js cannot Brotli-decode `.woff2`).
 */
export const DEFAULT_WARP_FONT_FILE = "fonts/Roboto-Regular.ttf";

/**
 * ADR-023 S2.5 — resolve a font family (+ weight) to its served binary, THROUGH THE CATALOGUE.
 *
 * This used to be `warpFontCatalog`, a hand-maintained `Record<family, {regular, bold}>` sitting
 * beside `registerWarpFonts`, whose own comment called itself "the data seam for a future large font
 * library". That future is the catalogue, so the table is gone and this function is now a consumer
 * of the same rows the picker browses — one place where a face's bytes are named, not two that drift.
 *
 * The drift was not hypothetical. That table shipped EMPTY once (2026-07-03): every warped family
 * fell through to the Roboto fallback, so "changing the font did nothing" reached a user, and the
 * only symptom was text that looked slightly wrong. `font:catalogue-gate` now re-hashes every row
 * against the file on disk, which is a check the old shape could not have had.
 *
 * Behaviour is deliberately UNCHANGED — same families, same binaries, same 600+ bold cutoff, same
 * fallback — because the warp path is a render path and this is a refactor, not a feature. Bold cuts
 * matter: the editor's default text weight is 900, so a regular-only outline makes warping look like
 * a font SWAP (heavy Arial → thin Arimo).
 */
/** CSS-style cutoff: weights 600+ ask for the bold cut. Also keys `loadWarpFont`'s parse cache. */
function wantsBold(weight: number | undefined): boolean {
  return typeof weight === "number" && Number.isFinite(weight) && weight >= 600;
}

export function warpFontFile(family: string, weight?: number): string {
  const primary = primaryFontFamily(family);
  // A layer may name a catalogue family directly (a pinned pick) or a legacy CSS family that has a
  // metric-compatible stand-in. Direct first: a user who picked Anton means Anton.
  const catalogueName = catalogueFamily(primary) ? primary : LEGACY_WARP_FAMILY_ALIASES[primary];
  if (!catalogueName) return DEFAULT_WARP_FONT_FILE;
  // CSS-style cutoff: 600+ asks for the bold cut, and `catalogueFace` gives the nearest weight the
  // family actually has — so a single-cut display face like Anton stays itself instead of vanishing.
  const face = catalogueFace(catalogueName, wantsBold(weight) ? 700 : 400);
  return face?.file ?? DEFAULT_WARP_FONT_FILE;
}

/** Resolves a primary font family (e.g. "Courier New") + weight to a font-binary URL. */
export type FontBinaryResolver = (family: string, weight?: number) => string | undefined;

let fontResolver: FontBinaryResolver | undefined;

/** Each app registers how warp font families resolve to served binaries. */
export function configureFontResolver(resolver: FontBinaryResolver): void {
  fontResolver = resolver;
}

/** Extract the first concrete family from a CSS font stack. */
export function primaryFontFamily(stack: string | undefined): string {
  if (!stack) return "";
  const first = stack.split(",")[0] ?? "";
  return first.trim().replace(/^['"]|['"]$/g, "");
}

let opentypePromise: Promise<OpentypeModule> | undefined;
async function getOpentype(): Promise<OpentypeModule> {
  if (!opentypePromise) {
    opentypePromise = import("opentype.js").then((mod) => (mod as unknown as { default?: OpentypeModule }).default ?? (mod as unknown as OpentypeModule));
  }
  return opentypePromise;
}

const fontCache = new Map<string, Promise<OpentypeFont | undefined>>();

/** Loads + parses the font binary for a family (+ weight), cached so each font is fetched once. */
export function loadWarpFont(family: string, weight?: number): Promise<OpentypeFont | undefined> {
  const primary = primaryFontFamily(family) || "__default__";
  const key = `${primary}|${wantsBold(weight) ? "bold" : "regular"}`;
  const existing = fontCache.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const url = fontResolver?.(primary, weight);
    if (!url) return undefined;
    try {
      const response = await fetch(url);
      if (!response.ok) return undefined;
      const buffer = await response.arrayBuffer();
      const opentype = await getOpentype();
      return opentype.parse(buffer);
    } catch {
      return undefined;
    }
  })();
  fontCache.set(key, promise);
  return promise;
}

/**
 * ADR-023 D9a (2026-08-15) — the WARP consumer of this module is gone.
 *
 * `buildWarpedTextPaths` and `buildWarpedTextPathSvg` lived below. They laid text out with
 * `opentype.js` `getPath()` and pushed the resulting bezier control points through the envelope.
 * `getPath()` is glyph LOOKUP, not shaping: no cursive joining, no contextual forms, no reordering,
 * no mark positioning. Every Arabic, Devanagari, Thai or Khmer warp it produced was wrong, silently,
 * from the day warp shipped — which is why S0 had to detect those scripts and refuse warp outright
 * (T-12), and why that gate is now deleted rather than disabled: warp rasterizes with the browser's
 * shaper first and deforms the raster (`scene/text-warp-deform.ts`), so the gap is closed
 * structurally rather than guarded.
 *
 * **`opentype.js` itself stays, and this module with it** — `loadWarpFont` and the parse cache serve
 * D2's name-table ingest, which reads a font's own idea of its family and style out of the binary.
 * That is a legitimate use of a font PARSER. Deforming outlines was not, because a parser is not a
 * shaper and the difference is invisible in Latin.
 */
