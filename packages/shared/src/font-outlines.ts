import { hasTextWarp, normalizeTextWarp } from "./text-warp";
import { warpPathCommands, type PathCommand, type WarpBounds } from "./text-warp-mesh";
import type { TextRun, TextWarp } from "./types";

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
 * Warp font catalog: primary family -> served binary path (relative to each app's
 * font root). This is the data seam for a future large (Canva-scale) font library -
 * adding fonts is just entries here + hosted files, no engine changes. Families not in
 * the catalog fall back to the default so warp still works while the library grows.
 *
 * Use `.ttf/.otf/.woff` (opentype.js cannot Brotli-decode `.woff2`).
 */
export const DEFAULT_WARP_FONT_FILE = "fonts/Roboto-Regular.ttf";

const warpFontCatalog: Record<string, string> = {
  // e.g. "Impact": "fonts/Anton-Regular.ttf", "Georgia": "fonts/LiberationSerif-Regular.ttf"
};

/** Registers/overrides catalog entries (for the future font-library integration). */
export function registerWarpFonts(entries: Record<string, string>): void {
  Object.assign(warpFontCatalog, entries);
}

/** Resolves a font family to its served binary path (relative to the app font root). */
export function warpFontFile(family: string): string {
  return warpFontCatalog[primaryFontFamily(family)] ?? DEFAULT_WARP_FONT_FILE;
}

/** Resolves a primary font family (e.g. "Courier New") to a font-binary URL. */
export type FontBinaryResolver = (family: string) => string | undefined;

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

/** Loads + parses the font binary for a family, cached so each font is fetched once. */
export function loadWarpFont(family: string): Promise<OpentypeFont | undefined> {
  const key = primaryFontFamily(family) || "__default__";
  const existing = fontCache.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const url = fontResolver?.(key);
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

/** Resolved style fields the warp builder needs (subset of getCompositionTextStyle). */
export interface WarpTextStyleInput {
  fontSize?: number | string | undefined;
  fontFamily?: string | undefined;
  color?: string | undefined;
  textAlign?: string | undefined;
  padding?: string | number | undefined;
  WebkitTextStroke?: string | number | undefined;
}

const markupCache = new Map<string, string>();
const MARKUP_CACHE_CAP = 200;

function num(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === "string" ? parseFloat(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseTextStroke(value: string | number | undefined): { width: number; color: string } | undefined {
  if (!value || typeof value !== "string") return undefined;
  const match = value.trim().match(/^([\d.]+)px\s+(.+)$/);
  if (!match) return undefined;
  const width = parseFloat(match[1] ?? "0");
  if (!Number.isFinite(width) || width <= 0) return undefined;
  return { width: width * 2, color: (match[2] ?? "#000000").trim() };
}

/**
 * Builds the warped-text SVG overlay markup (absolutely-positioned `<svg>` with one
 * `<path>` per run). Returns `undefined` when warp is inactive or the font binary
 * isn't available - the caller then renders plain (unwarped) text, so warp degrades
 * gracefully for fonts that aren't hosted yet.
 *
 * Async because the font binary may need to be fetched/parsed; the result is memoized
 * by content+style so it isn't recomputed per frame.
 */
export async function buildWarpedTextPathSvg(
  warp: TextWarp | undefined,
  runs: TextRun[],
  style: WarpTextStyleInput
): Promise<string | undefined> {
  if (!hasTextWarp(warp)) return undefined;
  const text = runs.map((run) => run.text).join("");
  if (!text.trim()) return undefined;

  const family = primaryFontFamily(style.fontFamily);
  const fontSize = num(style.fontSize, 48);
  const normalized = normalizeTextWarp(warp);
  const align = (style.textAlign ?? "center").toLowerCase();
  const stroke = parseTextStroke(style.WebkitTextStroke);
  const baseColor = style.color ?? "#ffffff";

  const cacheKey = JSON.stringify([
    family,
    Math.round(fontSize),
    normalized,
    align,
    baseColor,
    stroke,
    runs.map((run) => [run.text, run.color ?? "", run.fontSizeMultiplier ?? 1])
  ]);
  const cached = markupCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const font = await loadWarpFont(family);
  if (!font) return undefined;

  const scale = fontSize / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const descent = -font.descender * scale;
  const height = ascent + descent;

  // Pass 1: total advance width (so the envelope box is known before warping).
  let totalWidth = 0;
  for (const run of runs) {
    const runSize = run.fontSizeMultiplier ? fontSize * run.fontSizeMultiplier : fontSize;
    totalWidth += font.getAdvanceWidth(run.text, runSize);
  }

  const bounds: WarpBounds = { x0: 0, width: totalWidth, top: 0, height, baseline: ascent };

  // Pass 2: lay out + warp each run, emit one <path> per run colour.
  let cursor = 0;
  const paths: string[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const runSize = run.fontSizeMultiplier ? fontSize * run.fontSizeMultiplier : fontSize;
    const path = font.getPath(run.text, cursor, ascent, runSize);
    cursor += font.getAdvanceWidth(run.text, runSize);
    const d = warpPathCommands(path.commands, bounds, normalized, fontSize);
    if (!d) continue;
    const fill = run.color ?? baseColor;
    const strokeAttrs = stroke ? ` stroke="${escapeAttr(stroke.color)}" stroke-width="${stroke.width}" paint-order="stroke"` : "";
    paths.push(`<path d="${d}" fill="${escapeAttr(fill)}"${strokeAttrs}/>`);
  }
  if (!paths.length) return undefined;

  const anchor = align === "left" || align === "start" ? "left" : align === "right" || align === "end" ? "right" : "center";
  const horizontal = anchor === "left" ? "left:0;" : anchor === "right" ? "right:0;" : "left:50%;transform:translateX(-50%);";
  // The nominal box is width x height in local coords; warp overflow is allowed to
  // paint outside via overflow:visible. Vertically centred on the text content box.
  const overlayStyle =
    `position:absolute;top:50%;${horizontal}` +
    `${anchor === "center" ? "transform:translate(-50%,-50%);" : "transform:translateY(-50%);"}` +
    `width:${totalWidth}px;height:${height}px;overflow:visible;pointer-events:none;`;

  const markup =
    `<svg class="warp-text-path" aria-hidden="true" focusable="false" viewBox="0 0 ${totalWidth} ${height}" ` +
    `preserveAspectRatio="none" style="${overlayStyle}">${paths.join("")}</svg>`;

  if (markupCache.size > MARKUP_CACHE_CAP) {
    const firstKey = markupCache.keys().next().value;
    if (firstKey !== undefined) markupCache.delete(firstKey);
  }
  markupCache.set(cacheKey, markup);
  return markup;
}
