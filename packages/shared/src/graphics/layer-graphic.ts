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
  // Strip any existing root color/width/height, then inject ours right after the opening `<svg`.
  const cleaned = graphic.svg
    .replace(/(<svg\b[^>]*?)\s+color\s*=\s*["'][^"']*["']/i, "$1")
    .replace(/(<svg\b[^>]*?)\s+width\s*=\s*["'][^"']*["']/i, "$1")
    .replace(/(<svg\b[^>]*?)\s+height\s*=\s*["'][^"']*["']/i, "$1")
    .replace(/<svg\b/i, `<svg color="${fill}" width="${width}" height="${height}"`);
  return `data:image/svg+xml,${encodeURIComponent(cleaned)}`;
}
