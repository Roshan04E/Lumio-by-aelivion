/**
 * Editable vector graphic helpers — shared by the editor, web preview, and Remotion export so a graphic
 * recolors identically everywhere. A graphic layer stores its SVG normalized to `currentColor`; the current
 * `fill` is baked into a data-URL `<img>` source on render (SVG images don't inherit CSS `color`, so the color
 * must live inside the markup). Vector, so it scales crisply and stays recolorable — no rasterized asset.
 */

import type { LayerGraphic } from "../types";

/** Default graphic fill (matches the bundled pack's original blue) used when a pick carries no explicit color. */
export const DEFAULT_GRAPHIC_FILL = "#5b8def";

/** Escape a user/color string to a safe CSS color token so it can't break out of the SVG attribute or inject
 *  markup. Accepts hex, rgb()/rgba(), hsl()/hsla(), and bare CSS color keywords; anything else → the default. */
export function sanitizeGraphicFill(fill: string | undefined): string {
  const value = (fill ?? "").trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/.test(value)) return value;
  if (/^[a-zA-Z]{3,20}$/.test(value)) return value; // css color keyword (red, tomato, transparent…)
  return DEFAULT_GRAPHIC_FILL;
}

/** Parse a viewBox / width+height to a natural pixel aspect for framing. Returns undefined dims when unknown. */
function readViewBox(svg: string): { naturalWidth?: number; naturalHeight?: number } {
  const viewBox = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(svg);
  if (viewBox) {
    const w = Number(viewBox[1]);
    const h = Number(viewBox[2]);
    if (w > 0 && h > 0) return { naturalWidth: w, naturalHeight: h };
  }
  const w = /\bwidth\s*=\s*["']?([\d.]+)/i.exec(svg);
  const h = /\bheight\s*=\s*["']?([\d.]+)/i.exec(svg);
  if (w && h && Number(w[1]) > 0 && Number(h[1]) > 0) {
    return { naturalWidth: Number(w[1]), naturalHeight: Number(h[1]) };
  }
  return {};
}

/**
 * Normalize a picked SVG into a recolorable graphic: every occurrence of `sourceColor` (the pack's baked fill)
 * becomes `currentColor`, so a single `color` on the root recolors the whole shape. Iconify mono icons already
 * use `currentColor`, so passing no `sourceColor` leaves them untouched (still recolorable). Multicolor icons
 * that use no `currentColor` and don't match `sourceColor` render as-authored (not recolorable — acceptable for
 * the solid-colors-first pass).
 */
export function normalizeGraphicSvg(svg: string, sourceColor?: string | undefined): LayerGraphic {
  let normalized = svg.trim();
  if (sourceColor) {
    // Replace the baked fill (in fill="…"/stroke="…" attrs and any inline usage), case-insensitively.
    normalized = normalized.replace(new RegExp(escapeRegExp(sourceColor), "gi"), "currentColor");
  }
  return { svg: normalized, fill: sanitizeGraphicFill(sourceColor), ...readViewBox(normalized) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Distinct paint colors used by an SVG's `fill`/`stroke` (attributes and inline `style`), in first-seen
 * order; `none`/`currentColor`/url() paints excluded. Drives import-time recolorability: exactly ONE
 * color → normalize it to `currentColor` (simple Fill control works, like the bundled pack); several →
 * a per-color palette (each entry an exact-literal substitution slot). Case-insensitive de-dupe,
 * original casing preserved (substitutions replace case-insensitively).
 */
export function extractSvgPalette(svg: string): string[] {
  const colors: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    const value = (raw ?? "").trim();
    if (!value) return;
    const lower = value.toLowerCase();
    if (lower === "none" || lower === "currentcolor" || lower === "transparent" || lower.startsWith("url(")) return;
    // Only real color tokens (hex / rgb / hsl / keyword) — same shapes sanitizeGraphicFill accepts.
    if (!/^#[0-9a-fA-F]{3,8}$/.test(value) && !/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/.test(value) && !/^[a-zA-Z]{3,20}$/.test(value)) return;
    if (seen.has(lower)) return;
    seen.add(lower);
    colors.push(value);
  };
  for (const match of svg.matchAll(/\b(?:fill|stroke)\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  for (const match of svg.matchAll(/\b(?:fill|stroke)\s*:\s*([^;"'}]+)/gi)) add(match[1]);
  return colors;
}

/** Longest-side pixel size baked into the SVG root so it rasterizes crisply as an `<img>`/texture (vector
 *  scales to any display size, but the decode/texture-upload happens at these intrinsic dims). */
const GRAPHIC_RASTER_SIZE = 1024;

/** Bake `fill` into the SVG root as a `color` presentation attribute (so `currentColor` resolves when the SVG
 *  is used as an `<img>`/texture source) AND explicit width/height (an SVG with only a viewBox decodes with an
 *  ambiguous/zero intrinsic size as an `<img>`, so the compositor would drop it). Returns a data URL —
 *  deterministic, identical in every renderer. */
export function graphicToDataUrl(graphic: LayerGraphic): string {
  const fill = sanitizeGraphicFill(graphic.fill);
  const aspect = (graphic.naturalWidth ?? 1) / (graphic.naturalHeight ?? 1);
  const width = aspect >= 1 ? GRAPHIC_RASTER_SIZE : Math.round(GRAPHIC_RASTER_SIZE * aspect);
  const height = aspect >= 1 ? Math.round(GRAPHIC_RASTER_SIZE / aspect) : GRAPHIC_RASTER_SIZE;
  // Multicolor palette: substitute each changed source color literal (the `currentColor` normalize
  // trick generalized — exact-literal, case-insensitive, sanitized so a stored value can't inject
  // markup). Same bake for every renderer, so recolors stay pixel-aligned preview↔export.
  let svg = graphic.svg;
  const slots = (graphic.palette ?? []).filter((slot) => slot.from && slot.to !== slot.from);
  if (slots.length) {
    // Single combined pass (a chained per-slot replace could re-substitute another slot's output),
    // with boundary guards so a keyword like `red` never matches inside `darkred`.
    const to = new Map(slots.map((slot) => [slot.from.toLowerCase(), sanitizeGraphicFill(slot.to)]));
    const combined = new RegExp(`(?<![\\w#-])(${slots.map((slot) => escapeRegExp(slot.from)).join("|")})(?![\\w-])`, "gi");
    svg = svg.replace(combined, (match) => to.get(match.toLowerCase()) ?? match);
  }
  // Strip any existing root color/width/height, then inject ours right after the opening `<svg`.
  const cleaned = svg
    .replace(/(<svg\b[^>]*?)\s+color\s*=\s*["'][^"']*["']/i, "$1")
    .replace(/(<svg\b[^>]*?)\s+width\s*=\s*["'][^"']*["']/i, "$1")
    .replace(/(<svg\b[^>]*?)\s+height\s*=\s*["'][^"']*["']/i, "$1")
    .replace(/<svg\b/i, `<svg color="${fill}" width="${width}" height="${height}"`);
  return `data:image/svg+xml,${encodeURIComponent(cleaned)}`;
}
