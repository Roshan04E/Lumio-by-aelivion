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

/** One catalog family: the regular binary plus an optional bold cut (weight >= 600 picks bold). */
export interface WarpFontEntry {
  regular: string;
  bold?: string;
}

// Metric-compatible open fonts for every renderSafeFonts family (2026-07-03 — the catalog was
// EMPTY, so with warp active every family rendered as the Roboto fallback and "changing the font
// did nothing", user report). Bold cuts matter: the editor's default text weight is 900, so a
// regular-only outline makes warping look like a font SWAP (heavy Arial → thin Arimo). Anton is a
// single-style display face (no bold cut exists). Files are hosted in BOTH apps/web/public/fonts
// and apps/worker/public/fonts — keep them in sync when adding entries.
const warpFontCatalog: Record<string, WarpFontEntry> = {
  Arial: { regular: "fonts/Arimo-Regular.ttf", bold: "fonts/Arimo-Bold.ttf" }, // Arimo = metric-compatible Arial (OFL)
  Helvetica: { regular: "fonts/Arimo-Regular.ttf", bold: "fonts/Arimo-Bold.ttf" },
  "system-ui": { regular: "fonts/Arimo-Regular.ttf", bold: "fonts/Arimo-Bold.ttf" },
  Impact: { regular: "fonts/Anton-Regular.ttf" }, // Anton = classic Impact-style display (OFL)
  Haettenschweiler: { regular: "fonts/Anton-Regular.ttf" },
  Georgia: { regular: "fonts/Tinos-Regular.ttf", bold: "fonts/Tinos-Bold.ttf" }, // Tinos = metric-compatible Times (closest hosted serif)
  "Times New Roman": { regular: "fonts/Tinos-Regular.ttf", bold: "fonts/Tinos-Bold.ttf" },
  "Courier New": { regular: "fonts/Cousine-Regular.ttf", bold: "fonts/Cousine-Bold.ttf" }, // Cousine = metric-compatible Courier (OFL)
  Courier: { regular: "fonts/Cousine-Regular.ttf", bold: "fonts/Cousine-Bold.ttf" },
};

/** Registers/overrides catalog entries (for the future font-library integration). */
export function registerWarpFonts(entries: Record<string, WarpFontEntry>): void {
  Object.assign(warpFontCatalog, entries);
}

/** CSS-style cutoff: weights 600+ use the bold cut when the family has one. */
function wantsBold(weight: number | undefined): boolean {
  return typeof weight === "number" && Number.isFinite(weight) && weight >= 600;
}

/** Resolves a font family (+ weight) to its served binary path (relative to the app font root). */
export function warpFontFile(family: string, weight?: number): string {
  const entry = warpFontCatalog[primaryFontFamily(family)];
  if (!entry) return DEFAULT_WARP_FONT_FILE;
  return (wantsBold(weight) ? entry.bold : undefined) ?? entry.regular;
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

/** Resolved style fields the warp builder needs (subset of getCompositionTextStyle). */
export interface WarpTextStyleInput {
  fontSize?: number | string | undefined;
  fontFamily?: string | undefined;
  fontWeight?: number | string | undefined;
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

/** One warped run's outline: an SVG path `d` in local box space (x∈[0,width], y∈[0,height]). */
export interface WarpedTextPath {
  d: string;
  /** CSS fill colour. */
  fill: string;
  /** Optional stroke (width already resolved by `parseTextStroke`). Painted UNDER the fill. */
  stroke?: { color: string; width: number };
}

/** Structured warp outlines + the local box they live in (the SVG viewBox / Path2D source space). */
export interface WarpedTextPaths {
  width: number;
  height: number;
  paths: WarpedTextPath[];
}

const pathsCache = new Map<string, WarpedTextPaths>();

/**
 * Builds the warped-text glyph outlines as structured, `Path2D`-ready data (one entry per run colour)
 * in a local box of `width`×`height`. Returns `undefined` when warp is inactive or the font binary
 * isn't available — the caller then renders plain (unwarped) text, so warp degrades gracefully.
 *
 * This is the engine BOTH warp consumers share:
 *  - the DOM preview wraps it in an `<svg>` overlay (`buildWarpedTextPathSvg`);
 *  - the scene compositor + local export draw the paths via `Path2D` (`drawTextLayer` in text-shape.ts),
 *    which works on the main thread AND inside the export Worker — unlike `createImageBitmap(svgBlob)`,
 *    which Chrome can't decode (it throws `InvalidStateError`), so the old raster silently fell back to
 *    plain text in both the scene canvas and local export.
 *
 * Async because the font binary may need to be fetched/parsed; memoized by content+style.
 */
export async function buildWarpedTextPaths(
  warp: TextWarp | undefined,
  runs: TextRun[],
  style: WarpTextStyleInput
): Promise<WarpedTextPaths | undefined> {
  if (!hasTextWarp(warp)) return undefined;
  const text = runs.map((run) => run.text).join("");
  if (!text.trim()) return undefined;

  const family = primaryFontFamily(style.fontFamily);
  const fontSize = num(style.fontSize, 48);
  const fontWeight = num(style.fontWeight, 400);
  const normalized = normalizeTextWarp(warp);
  const stroke = parseTextStroke(style.WebkitTextStroke);
  const baseColor = style.color ?? "#ffffff";

  const cacheKey = JSON.stringify([
    family,
    fontWeight,
    Math.round(fontSize),
    normalized,
    baseColor,
    stroke,
    runs.map((run) => [run.text, run.color ?? "", run.fontSizeMultiplier ?? 1])
  ]);
  const cached = pathsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const font = await loadWarpFont(family, fontWeight);
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

  // Pass 2: lay out + warp each run, emit one path per run colour.
  let cursor = 0;
  const paths: WarpedTextPath[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const runSize = run.fontSizeMultiplier ? fontSize * run.fontSizeMultiplier : fontSize;
    const path = font.getPath(run.text, cursor, ascent, runSize);
    cursor += font.getAdvanceWidth(run.text, runSize);
    const d = warpPathCommands(path.commands, bounds, normalized, fontSize);
    if (!d) continue;
    paths.push({ d, fill: run.color ?? baseColor, ...(stroke ? { stroke } : {}) });
  }
  if (!paths.length) return undefined;

  const result: WarpedTextPaths = { width: totalWidth, height, paths };
  if (pathsCache.size > MARKUP_CACHE_CAP) {
    const firstKey = pathsCache.keys().next().value;
    if (firstKey !== undefined) pathsCache.delete(firstKey);
  }
  pathsCache.set(cacheKey, result);
  return result;
}

/**
 * Builds the warped-text SVG overlay markup (absolutely-positioned `<svg>` with one `<path>` per run)
 * for the DOM preview. Thin wrapper over {@link buildWarpedTextPaths}.
 */
export async function buildWarpedTextPathSvg(
  warp: TextWarp | undefined,
  runs: TextRun[],
  style: WarpTextStyleInput
): Promise<string | undefined> {
  const data = await buildWarpedTextPaths(warp, runs, style);
  if (!data) return undefined;

  const cacheKey = `svg:${data.width}:${data.height}:${(style.textAlign ?? "center").toLowerCase()}:${data.paths.map((p) => p.d.length).join(",")}:${data.paths.map((p) => p.fill).join(",")}`;
  const memo = markupCache.get(cacheKey);
  if (memo !== undefined) return memo;

  const align = (style.textAlign ?? "center").toLowerCase();
  const anchor = align === "left" || align === "start" ? "left" : align === "right" || align === "end" ? "right" : "center";
  const horizontal = anchor === "left" ? "left:0;" : anchor === "right" ? "right:0;" : "left:50%;transform:translateX(-50%);";
  // The nominal box is width x height in local coords; warp overflow is allowed to paint outside via
  // overflow:visible. Vertically centred on the text content box.
  const overlayStyle =
    `position:absolute;top:50%;${horizontal}` +
    `${anchor === "center" ? "transform:translate(-50%,-50%);" : "transform:translateY(-50%);"}` +
    `width:${data.width}px;height:${data.height}px;overflow:visible;pointer-events:none;`;

  const pathTags = data.paths
    .map((p) => {
      const strokeAttrs = p.stroke ? ` stroke="${escapeAttr(p.stroke.color)}" stroke-width="${p.stroke.width}" paint-order="stroke"` : "";
      return `<path d="${p.d}" fill="${escapeAttr(p.fill)}"${strokeAttrs}/>`;
    })
    .join("");

  // `xmlns` lets the markup also rasterize as a standalone document (an `<img src=blob>`); inline DOM
  // use infers the namespace, but the standalone path silently fails without it.
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" class="warp-text-path" aria-hidden="true" focusable="false" ` +
    `viewBox="0 0 ${data.width} ${data.height}" preserveAspectRatio="none" style="${overlayStyle}">${pathTags}</svg>`;

  if (markupCache.size > MARKUP_CACHE_CAP) {
    const firstKey = markupCache.keys().next().value;
    if (firstKey !== undefined) markupCache.delete(firstKey);
  }
  markupCache.set(cacheKey, markup);
  return markup;
}
