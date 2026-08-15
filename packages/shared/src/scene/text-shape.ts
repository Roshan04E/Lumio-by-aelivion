/**
 * Text & shape rasterization (Phase L2; promoted into @orreris/shared in Method 3 Phase 6.1).
 *
 * Draws `text` (incl. rich runs + warp) and `shape` layers onto a 2D compositor canvas,
 * reusing the shared style helpers so sizes/colors/positions match the editor preview.
 * Text uses canvas fillText with the document's loaded fonts — awaited by `ensureOverlayFonts`
 * below, on this path, because canvas silently substitutes a fallback for a face that has not landed
 * yet; warp text rasterizes the shared vector-outline SVG (font-independent). Shared so the
 * editor preview, local export, and the future Remotion SceneStage all rasterize identically.
 */

import type { CompositionStyleOptions } from "../composition-style";
import { makeCanvas2D } from "./canvas-2d";
import { drawWarpedRaster, textWarpField, warpOverhang, warpSupersampleScale } from "./text-warp-deform";
import {
  compositionTextDefaults,
  getCompositionShapeStyle,
  getCompositionTextRunStyle,
  getCompositionTextWarp,
  getCompositionTextStyle,
  getCompositionTransform,
  getVisibleTextRuns,
  parseFillTexture,
  parseTextLinePill,
} from "../composition-style";
import { hasTextWarp } from "../text-warp";
import type { MaskPoint, TextRun, TextWarp, TimelineLayer } from "../types";

// Works against both the main-thread 2D context and the Worker's OffscreenCanvas 2D context.
type Ctx = (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) & { letterSpacing?: string };

/**
 * App-supplied style resolution the rasterizer has to pass through (ADR-023 S5b).
 *
 * Deliberately a SUBSET of `CompositionStyleOptions` rather than the whole thing: `currentTimeSeconds`
 * is the draw's own argument and must not be overridable from here, or a caller could hand the layout
 * one moment and the paint another. Today it carries `resolveAssetUrl` — the asset id → render address
 * step, which `packages/shared` cannot do for itself and must therefore be given.
 */
export type OverlayStyleOptions = Pick<CompositionStyleOptions, "resolveAssetUrl">;

// ─── Font readiness (ADR-023 D3/T-2) ─────────────────────────────────────────────────────────────
/**
 * Await the faces this layer is about to be drawn with, BEFORE it is measured or painted.
 *
 * Canvas2D has no font-loading story at all: `ctx.font = "700 80px Anton"` for a face that has not
 * finished loading does not wait and does not fail — it silently resolves to the fallback, measures
 * with the fallback's metrics, and paints the fallback's glyphs. The raster is then cached and looks
 * exactly like a correct one. That is the silent substitution D3/T-2 exist to prevent, and it is the
 * defect S6's contact sheet surfaced: an identical graph rendered Anton with a media layer present
 * and a fallback without one.
 *
 * The rasterizer already had a `document.fonts` "loadingdone" listener bumping a cache-invalidating
 * version, and that is a LIVENESS SIGNAL — DEBT-009's named bug class, correctness resting on a
 * notification the consumer never asked for. It is debounced 150ms, so whether the right font reaches
 * the pixels depended on whether something ELSE in the frame (a media decode round-trip) happened to
 * outlast the debounce. A composition with no media had nothing to lose the race to.
 *
 * So readiness is established here, on the consumer's own path, by the consumer, for exactly the
 * faces it is about to use. The listener stays — it is a genuine optimization for a font that arrives
 * mid-session in the editor — but nothing correct depends on it any more.
 *
 * `check()` first so the steady state costs nothing: it is sync, and it returns true both for a
 * loaded face and for a family with no matching `FontFace` at all (a plain system stack), which is
 * precisely "there is nothing here to wait for".
 */
export function ensureOverlayFonts(layer: TimelineLayer, t: number, styleOptions: OverlayStyleOptions = {}): Promise<void> | void {
  if (layer.type !== "text") return;
  const fonts = typeof document !== "undefined" ? (document as Document).fonts : undefined;
  if (!fonts?.load) return;

  const style = getCompositionTextStyle(layer, { currentTimeSeconds: t, ...styleOptions }) as Record<string, unknown>;
  const baseSize = num(style.fontSize, 72);
  const specs = new Set<string>();
  // Every RUN's font, not just the layer's: a rich-text run can carry its own family/weight/size, and
  // a run-level face left unawaited is the same defect scoped to one word.
  for (const run of getVisibleTextRuns(layer, t)) {
    if (!run.text) continue;
    const runStyle = getCompositionTextRunStyle(run, {
      fontSize: baseSize,
      fontWeight: style.fontWeight,
      fontFamily: style.fontFamily,
      fontStyle: style.fontStyle
    } as never) as { fontSize?: number; fontWeight?: unknown; fontFamily?: unknown; fontStyle?: unknown };
    specs.add(
      fontString({
        fontStyle: runStyle.fontStyle,
        fontWeight: runStyle.fontWeight,
        fontSize: num(runStyle.fontSize, baseSize),
        fontFamily: runStyle.fontFamily
      })
    );
  }
  if (!specs.size) return;

  // A malformed shorthand makes check() THROW rather than return false; treat that as "cannot tell"
  // and fall through to load(), which reports the same problem by rejecting (and is caught below).
  const pending = [...specs].filter((spec) => {
    try {
      return !fonts.check(spec);
    } catch {
      return true;
    }
  });
  if (!pending.length) return;
  return Promise.all(pending.map((spec) => fonts.load(spec).catch(() => undefined))).then(() => undefined);
}

// ─── Texture fill (D2) ───────────────────────────────────────────────────────────────────────────
// Decoded-image cache for `layer.fillTexture`. The decode is ASYNC (fetch + createImageBitmap); the
// draw functions below stay sync by reading only ALREADY-decoded entries — callers that must not
// miss a frame (the raster cache, the export) `await ensureFillTexture(url)` first, exactly like
// fonts. `fetch` + `createImageBitmap` exist in all three environments (editor main thread, export
// Worker, worker Chromium); SVG sources additionally fall back to an <img> decode where `document`
// exists (Chrome can't `createImageBitmap` an SVG blob — the same limitation the warp path hit),
// so an SVG fill is unsupported ONLY in the DOM-less export Worker (raster formats work everywhere).
type DecodedFill = ImageBitmap | HTMLImageElement;
const fillTextureCache = new Map<string, { image: DecodedFill | null; promise: Promise<void> | null }>();
const FILL_TEXTURE_CACHE_MAX = 16;

/** Await the fill texture's decode (idempotent; failures cache as null → solid-color fallback). */
export function ensureFillTexture(url: string): Promise<void> {
  const existing = fillTextureCache.get(url);
  if (existing) return existing.promise ?? Promise.resolve();
  const entry: { image: DecodedFill | null; promise: Promise<void> | null } = { image: null, promise: null };
  // Simple FIFO bound — texture fills are few; this only guards a runaway asset list.
  if (fillTextureCache.size >= FILL_TEXTURE_CACHE_MAX) {
    const oldest = fillTextureCache.keys().next().value;
    if (oldest !== undefined) fillTextureCache.delete(oldest);
  }
  fillTextureCache.set(url, entry);
  entry.promise = (async () => {
    try {
      const blob = await (await fetch(url)).blob();
      try {
        entry.image = await createImageBitmap(blob);
        return;
      } catch {
        // SVG (or exotic) blob: <img> decode fallback where a DOM exists.
        if (typeof document === "undefined" || typeof Image === "undefined") return;
        const objectUrl = URL.createObjectURL(blob);
        try {
          const img = new Image();
          img.src = objectUrl;
          await img.decode();
          entry.image = img;
        } finally {
          // The Image keeps its decoded bitmap; the object URL itself can be released.
          URL.revokeObjectURL(objectUrl);
        }
      }
    } catch {
      entry.image = null; // unreachable/undecodable → callers fall back to the solid color
    } finally {
      entry.promise = null;
    }
  })();
  return entry.promise;
}

/**
 * The canvas pattern painting `layer.fillTexture` over an element box of `boxW×boxH` centered at the
 * CURRENT origin (both draw paths below place geometry about the origin, so the pattern anchors to
 * the box regardless of the outer position/rotation/anchor transforms). Null = not set / not decoded
 * yet / failed — caller keeps the solid color. `cover` scales the image to fill the box (× `scale`);
 * `tile` repeats it at natural size × `scale`, anchored at the box's top-left.
 */
function fillTexturePaint(ctx: Ctx, style: Record<string, unknown>, boxW: number, boxH: number): CanvasPattern | null {
  // ADR-023 S5b: read from the EMITTED STYLE, not the layer. The layer carries an asset id; a URL is
  // that id resolved, and resolution happens once in `resolveFillTexture` so the raster and any other
  // consumer cannot answer "which image" differently. Same discipline as `paintOrder` and `direction`.
  const ft = typeof style.fillTexture === "string" ? parseFillTexture(style.fillTexture) : undefined;
  if (!ft?.url || boxW <= 0 || boxH <= 0) return null;
  const image = fillTextureCache.get(ft.url)?.image;
  if (!image || image.width <= 0 || image.height <= 0) return null;
  const pattern = ctx.createPattern(image as CanvasImageSource, "repeat");
  if (!pattern) return null;
  const zoom = ft.scale > 0 ? ft.scale : 1;
  if (ft.fit === "tile") {
    pattern.setTransform?.({ a: zoom, b: 0, c: 0, d: zoom, e: -boxW / 2, f: -boxH / 2 });
  } else {
    const s = Math.max(boxW / image.width, boxH / image.height) * zoom;
    pattern.setTransform?.({
      a: s,
      b: 0,
      c: 0,
      d: s,
      e: -boxW / 2 + (boxW - image.width * s) / 2,
      f: -boxH / 2 + (boxH - image.height * s) / 2,
    });
  }
  return pattern;
}

// ─── Gradient glyph fill (ADR-023 D7, S5) ────────────────────────────────────────────────────────
/**
 * The canvas gradient painting `textFillGradient` over an element box of `boxW×boxH` centered at the
 * CURRENT origin — the raster's answer to CSS `background-clip: text`, and not an approximation of it:
 * both end up filling the glyph coverage with the same two-stop ramp over the same box.
 *
 * The gradient LINE follows CSS's own definition for `linear-gradient(<a>deg, …)`: `a` is measured
 * clockwise from "up", the line runs through the box centre, and its length is `|W·sin a| + |H·cos a|`
 * so that both stops land exactly on the box corners' projections. Getting that length wrong is the
 * classic way a canvas "equivalent" of a CSS gradient renders visibly shorter at 45°.
 *
 * Null when the layer has no gradient, or the string does not parse — caller keeps the solid colour.
 */
function fillGradientPaint(ctx: Ctx, style: Record<string, unknown>, boxW: number, boxH: number): CanvasGradient | null {
  const declaration = style.textFillGradient;
  if (typeof declaration !== "string" || !declaration || boxW <= 0 || boxH <= 0) return null;
  const match = declaration.match(/^linear-gradient\(\s*(-?[\d.]+)deg\s*,\s*(.+?)\s*,\s*(.+?)\s*\)$/);
  if (!match) return null;
  const radians = (num(match[1], 180) * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const length = Math.abs(boxW * sin) + Math.abs(boxH * cos);
  // Screen coords (y grows downward), so "up" is −y: the direction vector is (sin a, −cos a).
  const half = length / 2;
  const gradient = ctx.createLinearGradient(-half * sin, half * cos, half * sin, -half * cos);
  gradient.addColorStop(0, match[2]!);
  gradient.addColorStop(1, match[3]!);
  return gradient;
}

/**
 * Split a `text-shadow` LIST into its entries (ADR-023 D7, S5 — `shadowLayers`). Commas inside a colour
 * function (`rgba(0, 0, 0, .5)`) are not separators, which is why this is a depth-aware scan rather
 * than `split(",")` — the stock shadow colour is `rgba(0,0,0,0.62)`, so the naive version would break
 * on the DEFAULT look rather than on an exotic one.
 */
function splitShadowList(css: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(css.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = css.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong"
]);

/**
 * Normalize a CSS font-family VALUE for canvas `ctx.font`. fontFamily is often a stack like
 * "Arial, Helvetica, sans-serif"; the whole thing must stay a comma list. Each non-generic
 * member that contains spaces is quoted individually (e.g. "Times New Roman"); quoting the
 * entire stack — the previous bug — makes canvas treat it as one unknown family and fall back
 * to serif, so the export font never matched the preview.
 */
function cssFontFamily(stack: string): string {
  return stack
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((family) => {
      if (family.startsWith('"') || family.startsWith("'")) return family;
      if (GENERIC_FAMILIES.has(family.toLowerCase())) return family;
      return /\s/.test(family) ? `"${family}"` : family;
    })
    .join(", ");
}
function fontString(style: { fontStyle?: unknown; fontWeight?: unknown; fontSize: number; fontFamily?: unknown }): string {
  const fs = style.fontStyle === "italic" ? "italic " : "";
  const fw = num(style.fontWeight, 400);
  const family = cssFontFamily(String(style.fontFamily ?? "sans-serif"));
  return `${fs}${fw} ${style.fontSize}px ${family}`;
}

/**
 * Canvas2D never SYNTHESIZES italic: a family with no italic face (Impact, most display fonts)
 * silently falls back to the upright face, while the DOM/Remotion path oblique-slants it via CSS
 * `font-synthesis`. Detect that case (italic vs upright metrics identical ⇒ no real italic face)
 * and slant the glyph draw manually so the raster matches the DOM. ~ tan(14°), the CSS synthesis
 * angle. Fonts WITH a real italic face measure differently and are left to their true italics.
 */
/**
 * Bound on a warped layer's SOURCE raster, mirroring `MAX_RASTER_DIM` on the destination: the
 * supersample factor multiplies an already-scaled box, and a strong fisheye on large text would
 * otherwise ask for a canvas no GPU will take.
 */
const MAX_WARP_SOURCE_DIM = 4096;

const ITALIC_SKEW = 0.25;
const italicSynthesisCache = new Map<string, boolean>();
function needsItalicSynthesis(ctx: Ctx, italicFont: string): boolean {
  if (!italicFont.startsWith("italic ")) return false;
  const cached = italicSynthesisCache.get(italicFont);
  if (cached !== undefined) return cached;
  const prev = ctx.font;
  // Advance widths alone can't tell a real italic MONOSPACE face from fallback (identical
  // advances) — compare glyph ink bounds too: a true italic face slants the ink of "f".
  const probe = (font: string) => {
    ctx.font = font;
    const m = ctx.measureText("Hf?xy");
    return `${m.width.toFixed(3)}|${(m.actualBoundingBoxLeft ?? 0).toFixed(3)}|${(m.actualBoundingBoxRight ?? 0).toFixed(3)}`;
  };
  const needed = probe(italicFont) === probe(italicFont.slice("italic ".length));
  ctx.font = prev;
  italicSynthesisCache.set(italicFont, needed);
  return needed;
}

export interface Word {
  text: string;
  font: string;
  color: string;
  /** Per-run highlight (marker) painted behind the word — parity with the DOM span background. */
  background: string | undefined;
  fontSize: number;
  space: boolean; // trailing space after this word
}

function layoutWords(
  ctx: Ctx,
  runs: TextRun[],
  baseStyle: { fontSize: number; fontWeight?: unknown; color?: unknown; fontFamily?: unknown; fontStyle?: unknown },
  maxWidth: number
): Word[][] {
  // Tokenize runs → words carrying per-run style, preserving explicit newlines.
  const tokens: Array<Word | "break"> = [];
  for (const run of runs) {
    const runStyle = getCompositionTextRunStyle(run, baseStyle as never) as {
      fontSize?: number;
      fontWeight?: unknown;
      color?: string;
      backgroundColor?: string;
      fontFamily?: unknown;
      fontStyle?: unknown;
    };
    const size = num(runStyle.fontSize, baseStyle.fontSize);
    const font = fontString({ fontStyle: runStyle.fontStyle, fontWeight: runStyle.fontWeight, fontSize: size, fontFamily: runStyle.fontFamily });
    const color = String(runStyle.color ?? baseStyle.color ?? "#fff");
    const background = runStyle.backgroundColor ? String(runStyle.backgroundColor) : undefined;
    const segments = String(run.text ?? "").split("\n");
    segments.forEach((segment, segIndex) => {
      if (segIndex > 0) tokens.push("break");
      const parts = segment.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          const last = tokens[tokens.length - 1];
          if (last && last !== "break") last.space = true;
        } else {
          tokens.push({ text: part, font, color, background, fontSize: size, space: false });
        }
      }
    });
  }

  // Greedy word-wrap within maxWidth.
  const lines: Word[][] = [];
  let line: Word[] = [];
  let lineWidth = 0;
  const spaceWidth = (font: string) => {
    ctx.font = font;
    return ctx.measureText(" ").width;
  };
  const flush = () => {
    lines.push(line);
    line = [];
    lineWidth = 0;
  };
  for (const token of tokens) {
    if (token === "break") {
      flush();
      continue;
    }
    ctx.font = token.font;
    const w = ctx.measureText(token.text).width;
    const extra = line.length ? spaceWidth(token.font) : 0;
    if (maxWidth > 0 && line.length && lineWidth + extra + w > maxWidth) flush();
    line.push(token);
    lineWidth += (line.length > 1 ? extra : 0) + w;
  }
  if (line.length) flush();
  return lines.length ? lines : [[]];
}

/**
 * ADR-023 T-13a (S0c) — a line whose tokens all share one style is ONE drawable string.
 *
 * The word loop places each token at an x computed by the caller, so cross-word bidi reordering can
 * never happen regardless of `ctx.direction`. Handing the whole line to a single `fillText` is the
 * only way the engine gets to reorder it. A line with two styles cannot be collapsed — canvas 2D
 * exposes no per-character visual positions — and stays a token list, which is the case
 * `isTextVisualOrderUnavailable` warns about.
 *
 * Measurement and drawing MUST agree on this, or a collapsed line is centred against a width that
 * was summed differently; both go through here.
 */
export function collapseLine(line: Word[]): Word[] {
  const first = line[0];
  if (!first || line.length < 2) return line;
  const uniform = line.every(
    (word) => word.font === first.font && word.color === first.color && word.background === first.background
  );
  if (!uniform) return line;
  return [{ ...first, text: line.map((word) => word.text).join(" "), space: false }];
}

function lineWidth(ctx: Ctx, rawLine: Word[]): number {
  const line = collapseLine(rawLine);
  let width = 0;
  line.forEach((word, index) => {
    ctx.font = word.font;
    if (index > 0) {
      ctx.font = word.font;
      width += ctx.measureText(" ").width;
    }
    width += ctx.measureText(word.text).width;
  });
  return width;
}

/**
 * "full" bakes the layer's rotation+scale into the raster (2D path). "flat" applies only
 * position + opacity, leaving rotation/scale/3D to the WebGL perspective quad (3D-tilt path).
 */
// "full": bake position + rotation/scale + opacity (the 2D draw-straight-to-frame path).
// "flat": bake position + opacity, NO rotation/scale (the 3D quad owns those).
// "content": bake NOTHING — draw the element at the COMP CENTER, no rotation/scale/opacity — so the
//   raster depends only on content+style+size and a transform animation reuses it (the scene path lets
//   the composite quad apply position/scale/rotation/opacity). See scene-text-raster.ts.
// "box": like "content" but draws into a TIGHT element-box canvas, centered, pre-scaled by `rasterScale`
//   (so the raster is near the DISPLAYED resolution → crisp when the composite quad magnifies it). The
//   caller sizes ctx.canvas to (box+margin)*rasterScale; this just centers + scales into it. Scene-only
//   (resolution-aware raster); the composite quad's `box` half-extents = canvas/(2*rasterScale).
export type OverlayTransformMode = "full" | "flat" | "content" | "box";

/** The drawn element's content-box size in comp px — used to size the 3D perspective quad / element box. */
export interface OverlayBox {
  boxW: number;
  boxH: number;
}

/** Resolved text layout (word-wrap + box) — shared by the draw pass and the `measureOverlayBox` pass so
 *  the box used to SIZE a "box"-mode canvas can never disagree with the box the draw fills. */
interface TextLayout {
  runs: TextRun[];
  style: Record<string, unknown>;
  fontSize: number;
  lineHeightPx: number;
  letterSpacing: string;
  padX: number;
  padY: number;
  radius: number;
  background: string;
  textAlign: CanvasTextAlign;
  lines: Word[][];
  /** Per-line line-box height (px): CSS grows a line box to its LARGEST span, so a line with a
   *  bigger fontSizeMultiplier run is taller — `lineHeight × max(base, largest word font size)`. */
  lineHeights: number[];
  boxW: number;
  boxH: number;
}

/** Run word-wrap + box math for a text layer (no drawing). `null` = no visible text. Needs the comp
 *  width `W` because the wrap width is `maxWidthFraction*W − 2*padX`. */
function measureTextLayout(ctx: Ctx, layer: TimelineLayer, t: number, W: number, styleOptions: OverlayStyleOptions = {}): TextLayout | null {
  // #4: slice visible chars via textRevealProgress (typewriter animation), matching preview/cloud.
  const runs = getVisibleTextRuns(layer, t);
  if (!runs.some((r) => r.text)) return null;
  const style = getCompositionTextStyle(layer, { currentTimeSeconds: t, ...styleOptions }) as Record<string, unknown>;

  const fontSize = num(style.fontSize, 72);
  const lineHeight = num(style.lineHeight, 1.2);
  const lineHeightPx = lineHeight * fontSize;
  const letterSpacing = style.letterSpacing ? String(style.letterSpacing) : "";
  const padEm = String(style.padding ?? "0em 0em").split(" ");
  const padY = num(padEm[0]) * fontSize;
  const padX = num(padEm[1] ?? padEm[0]) * fontSize;
  const radius = num(style.borderRadius) * fontSize;
  const background = String(style.background ?? "transparent");
  const textAlign = (style.textAlign as CanvasTextAlign) || "center";

  const widthStr = String(style.width ?? "max-content");
  // #3a: match CSS max-width: 86% (compositionTextDefaults.maxWidthPercent) with box-sizing:border-box.
  // The outer box includes padding, so subtract 2*padX from the allowed content width, matching the browser.
  const maxWidthFraction = widthStr.endsWith("%") ? num(widthStr) / 100 : compositionTextDefaults.maxWidthPercent / 100;
  const maxWidthContent = maxWidthFraction * W - 2 * padX;

  // measureText is letter-spacing sensitive — set it for the layout, then reset so a reused scratch ctx
  // doesn't carry stale spacing into the next measure.
  ctx.letterSpacing = letterSpacing;
  const baseStyle = { fontSize, fontWeight: style.fontWeight, color: style.color, fontFamily: style.fontFamily, fontStyle: style.fontStyle };
  const lines = layoutWords(ctx, runs, baseStyle, maxWidthContent > 0 ? maxWidthContent : 0);

  const fixedWidth = widthStr.endsWith("%") ? (num(widthStr) / 100) * W - 2 * padX : 0;
  const contentWidth = fixedWidth > 0 ? fixedWidth : Math.max(0, ...lines.map((l) => lineWidth(ctx, l)));
  const boxW = contentWidth + 2 * padX;
  // Per-line heights: a mixed-size line (fontSizeMultiplier runs) is as tall as its LARGEST span
  // (CSS unitless line-height multiplies each span's own size; the strut keeps the base minimum).
  // A single base-sized height clipped big runs against the tight box raster (2026-07-12 report).
  const lineHeights = lines.map((line) => lineHeight * Math.max(fontSize, ...line.map((word) => word.fontSize)));
  const boxH = lineHeights.reduce((sum, h) => sum + h, 0) + 2 * padY;
  ctx.letterSpacing = "";

  return { runs, style, fontSize, lineHeightPx, letterSpacing, padX, padY, radius, background, textAlign, lines, lineHeights, boxW, boxH };
}

/** Content-box size (comp px) of a text/shape layer, with no drawing — used to size a "box"-mode raster
 *  canvas before the draw pass. Returns {0,0} for an empty layer (no visible text / zero-size shape). */
export function measureOverlayBox(ctx: Ctx, layer: TimelineLayer, t: number, W: number, H: number, styleOptions: OverlayStyleOptions = {}): OverlayBox {
  if (layer.type === "text") {
    const layout = measureTextLayout(ctx, layer, t, W, styleOptions);
    return layout ? { boxW: layout.boxW, boxH: layout.boxH } : { boxW: 0, boxH: 0 };
  }
  const style = getCompositionShapeStyle(layer, { currentTimeSeconds: t, ...styleOptions }) as Record<string, unknown>;
  return { boxW: Math.max(0, (num(style.width) / 100) * W), boxH: Math.max(0, (num(style.height) / 100) * H) };
}

/** Extra comp-px padding a "box"-mode raster needs so text-shadow / stroke / shape border+shadow —
 *  and a pen path's curve bulges — don't clip against the tight element box (the comp-sized raster
 *  never clipped; a tight box would). Parsed from the same resolved style the draw uses, so it
 *  tracks the actual overhang. `W`/`H` (comp px) size percent-of-box overhangs (pen paths). */
export function overlayOverhangMargin(layer: TimelineLayer, t: number, W: number, H: number, styleOptions: OverlayStyleOptions = {}): number {
  const ink = overlayInkMargin(layer, t, styleOptions, W, H);
  /**
   * ADR-023 D9a: warp displaces ink OUT of the box it is defined over, so a tight-box raster that
   * budgeted only for shadow and stroke would clip the bend itself. Measured from the field rather
   * than derived per style — `arc` scales its amplitude by a parabola, `arch` by a sine, `bulge` not
   * by translation at all but by a vertical scale, and a formula per style is exactly the
   * hand-maintained list T-15 is about.
   */
  if (layer.type === "text" && hasTextWarp(getCompositionTextWarp(layer))) {
    const style = getCompositionTextStyle(layer, { currentTimeSeconds: t, ...styleOptions }) as Record<string, unknown>;
    const layout = measureOverlayBox(makeCanvas2D(1, 1).getContext("2d") as Ctx, layer, t, W, H, styleOptions);
    if (layout.boxW > 0 && layout.boxH > 0) {
      const field = textWarpField(getCompositionTextWarp(layer), layout.boxW, layout.boxH, num(style.fontSize, 72));
      return ink + warpOverhang(field);
    }
  }
  return ink;
}

/**
 * The margin the UNDEFORMED picture needs: shadow, stroke, per-line pill, pen-path bulge. Split out
 * from {@link overlayOverhangMargin} for D9a's warp path, which sizes its source raster from this and
 * leaves the warp's own overhang to the destination.
 */
function overlayInkMargin(layer: TimelineLayer, t: number, styleOptions: OverlayStyleOptions = {}, W = 0, H = 0): number {
  let m = 2; // base anti-aliasing pad
  /**
   * ADR-023 S5: `text-shadow` is a LIST once `shadowLayers` stacks copies, and the FARTHEST copy is the
   * one that decides the margin. The regex used to take whichever entry matched first — which is the
   * nearest, by emission order — so a stacked extrude would have been clipped by the tight box raster
   * while the comp-sized path drew it fine. Max over every entry.
   */
  const shadowExtent = (css: string): number =>
    Math.max(
      0,
      ...splitShadowList(css).map((entry) => {
        const sm = entry.match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px/);
        return sm ? Math.abs(num(sm[1])) + Math.abs(num(sm[2])) + num(sm[3]) * 1.5 + 2 : 0;
      })
    );
  if (layer.type === "text") {
    const style = getCompositionTextStyle(layer, { currentTimeSeconds: t, ...styleOptions }) as Record<string, unknown>;
    if (style.textShadow) m = Math.max(m, shadowExtent(String(style.textShadow)));
    if (style.WebkitTextStroke) m = Math.max(m, num(String(style.WebkitTextStroke)) + 2);
    // ADR-023 S5: a per-line pill is drawn around each line's INK box (ascent+descent+2·padY), and the
    // default `lineHeight` here is 0.95 — under 1, so the ink box is TALLER than the line box and the
    // first line's pill reaches above the element box. The comp-sized raster never clipped; the tight
    // box one would. `1.5×` bounds ascent+descent for the faces this ships with, and the term is
    // clamped at zero so a generous line-height adds nothing.
    if (style.textLinePill) {
      const fontSize = num(style.fontSize, 72);
      const padEm = String(style.padding ?? "0em 0em").split(" ");
      const padY = num(padEm[0]) * fontSize;
      m = Math.max(m, Math.max(0, (1.5 * fontSize - num(style.lineHeight, 1.2) * fontSize) / 2) + padY + 2);
    }
  } else if (layer.type === "shape") {
    const style = getCompositionShapeStyle(layer, { currentTimeSeconds: t, ...styleOptions }) as Record<string, unknown>;
    if (style.boxShadow) m = Math.max(m, shadowExtent(String(style.boxShadow)));
    if (style.border) m = Math.max(m, num(String(style.border)) / 2 + 2); // border straddles the edge
    // Pen paths: anchors are normalized to the box at commit, but bezier TANGENT control points —
    // and point edits dragged past the box edge — push the curve outside 0..100. The control-point
    // hull bounds the curve (bezier convex-hull property), so its overhang past the box is a safe
    // pad; without it the tight raster clips the bulge (while the comp-canvas export path doesn't).
    const shapeKind = String(style.shapeKind ?? layer.shapeKind ?? "");
    const pts = Array.isArray(style.shapePath) ? (style.shapePath as MaskPoint[]) : layer.shapePath;
    if (shapeKind === "pen" && pts && pts.length >= 2) {
      let ox = 0;
      let oy = 0;
      const consider = (x: number, y: number) => {
        ox = Math.max(ox, -x, x - 100);
        oy = Math.max(oy, -y, y - 100);
      };
      for (const pt of pts) {
        consider(pt.x, pt.y);
        if (pt.inTangent) consider(pt.x + pt.inTangent.x, pt.y + pt.inTangent.y);
        if (pt.outTangent) consider(pt.x + pt.outTangent.x, pt.y + pt.outTangent.y);
      }
      const boxW = (num(style.width) / 100) * W;
      const boxH = (num(style.height) / 100) * H;
      m = Math.max(m, (ox / 100) * boxW + 2, (oy / 100) * boxH + 2);
    }
  }
  return m;
}

export async function drawTextLayer(
  ctx: Ctx,
  layer: TimelineLayer,
  t: number,
  W: number,
  H: number,
  mode: OverlayTransformMode = "full",
  rasterScale = 1,
  styleOptions: OverlayStyleOptions = {}
): Promise<OverlayBox> {
  const layout = measureTextLayout(ctx, layer, t, W, styleOptions);
  if (!layout) return { boxW: 0, boxH: 0 };
  const { runs, style, fontSize, letterSpacing, padX, padY, radius, background, textAlign, lines, lineHeights, boxW, boxH } = layout;
  const transform = getCompositionTransform(layer, { currentTimeSeconds: t });

  if (letterSpacing) ctx.letterSpacing = letterSpacing;

  // "content"/"box" draw with no transform/opacity (the composite quad applies them); other modes bake
  // the layer position (and "full" also rotation/scale/opacity). "box" centers in a tight pre-scaled
  // canvas (resolution-aware raster); "content" centers in the comp.
  const content = mode === "content";
  const box = mode === "box";

  ctx.save();
  ctx.globalAlpha = content || box ? 1 : Math.max(0, Math.min(1, transform.opacity / 100));
  if (box) {
    // Caller sized ctx.canvas to (box+margin)*rasterScale; center the content in it and pre-scale so the
    // raster is at ~display resolution. The composite quad derives the box from canvas/(2*rasterScale).
    ctx.translate(ctx.canvas.width / 2, ctx.canvas.height / 2);
    ctx.scale(rasterScale, rasterScale);
  } else {
    const centerX = content ? W / 2 : (transform.x / 100) * W;
    const centerY = content ? H / 2 : (transform.y / 100) * H;
    ctx.translate(centerX, centerY);
    if (mode === "full") {
      ctx.rotate((transform.rotation * Math.PI) / 180);
      ctx.scale(transform.scale, transform.scale);
    }
    // Anchor (D3): geometry below is centered about the origin; shift it so the ANCHOR point of the
    // element box sits at the origin instead — position places the anchor, rotate/scale pivot there
    // (the translate is inside the rotate/scale in "full" mode, matching writeQuad's p−anchor model).
    // Default 50/50 → no-op.
    ctx.translate((-((transform.anchorX ?? 50) - 50) / 100) * boxW, (-((transform.anchorY ?? 50) - 50) / 100) * boxH);
  }

  // Background box.
  if (background && background !== "transparent" && background !== "none") {
    ctx.fillStyle = background;
    roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, radius);
    ctx.fill();
  }

  /**
   * Warp (ADR-023 D9a): rasterize with the browser's own shaping, THEN deform.
   *
   * The text is drawn unwarped into an offscreen raster through this very function — same layout,
   * same `fillText`, same shadow/stroke/fill/pill passes — and the finished raster is pushed through
   * the envelope field. Two consequences worth being explicit about, because the old outline path
   * had neither:
   *
   *  - Complex scripts warp CORRECTLY. Shaping happens in Chromium before the field is applied, so
   *    Arabic joins, Devanagari reorders and marks are positioned. This is what retires T-12.
   *  - Warped text carries every style plain text does. What is deformed is the finished picture,
   *    not a set of outlines with a fill colour, so shadow stacks, gradient and image glyph fills,
   *    per-line pills and paint order all survive the warp for the first time.
   *
   * The recursion is one level deep and cannot go further: `textWarp` is stripped from the layer the
   * offscreen pass draws, so the inner call takes the ordinary path.
   */
  const activeWarp = getCompositionTextWarp(layer);
  if (hasTextWarp(activeWarp)) {
    const field = textWarpField(activeWarp, boxW, boxH, fontSize);
    // Supersample from the field's OWN maximum local magnification, never a fixed multiplier: a
    // gentle arc magnifies nothing and would pay for pixels it cannot use, while a strong bulge
    // stretches its centre past 2× and would resample away detail the raster had before it was
    // deformed.
    const superSample = warpSupersampleScale(field);
    // The source raster needs the ink margin (shadow, stroke, pill) but NOT the warp margin — it is
    // the undeformed picture. The DESTINATION carries the warp margin, added by
    // `overlayOverhangMargin`, which is what keeps a bend from being clipped by the box it bends out
    // of when the caller sized a tight raster.
    const inkMargin = overlayInkMargin(layer, t, styleOptions);
    const srcW = boxW + 2 * inkMargin;
    const srcH = boxH + 2 * inkMargin;
    const srcScale = Math.min(rasterScale * superSample, Math.max(1, MAX_WARP_SOURCE_DIM / Math.max(srcW, srcH)));
    const canvasW = Math.max(1, Math.ceil(srcW * srcScale));
    const canvasH = Math.max(1, Math.ceil(srcH * srcScale));
    const off = makeCanvas2D(canvasW, canvasH);
    const offCtx = off.getContext("2d") as Ctx | null;
    if (offCtx) {
      // "box" mode centres the content in the canvas it is handed and pre-scales by `rasterScale`,
      // which is exactly the offscreen contract needed here — so the inner draw is the ordinary one,
      // not a warp-specific variant of it.
      // Stripped from BOTH homes. `getCompositionTextWarp` reads the top-level field and the style
      // bag, because those are the two shapes a layer arrives in (editor vs manifest) — so clearing
      // only the one this layer happens to use makes the recursion terminate for the editor and run
      // forever for the export, which is exactly what it did for one render.
      const plain = {
        ...layer,
        textWarp: undefined,
        ...("style" in layer && layer.style ? { style: { ...(layer.style as Record<string, unknown>), textWarp: undefined } } : {})
      } as TimelineLayer;
      await drawTextLayer(offCtx, plain, t, W, H, "box", srcScale, styleOptions);
      drawWarpedRaster(ctx, {
        ...field,
        source: off as unknown as HTMLCanvasElement,
        srcScale,
        srcOriginX: -srcW / 2,
        srcOriginY: -srcH / 2,
        srcWidth: srcW,
        srcHeight: srcH
      });
      ctx.restore();
      ctx.letterSpacing = "";
      return { boxW, boxH };
    }
  }

  // Text shadow. ADR-023 S5: `shadowLayers` makes this a LIST. Entry 0 is the nearest copy and keeps
  // the exact single-shadow path below untouched (a legacy layer emits a one-entry list, so `shadow`
  // is the same string it always was); the extra copies are drawn as their own silhouette passes.
  const shadowList = style.textShadow ? splitShadowList(String(style.textShadow)) : [];
  const shadow = shadowList[0] ?? "";
  // Texture fill (D2): resolved once per raster against the text box (null → solid run colors).
  // Warp text keeps its own vector fills for now (the warp path returned above).
  //
  // ADR-023 D7 (S5): a gradient fill is the same kind of whole-layer glyph paint, and `fillTexture`
  // wins when both are set — it is the more specific paint and it shipped first (see
  // TimelineLayer.fillGradientFrom). Resolved once per raster, against the same box.
  const glyphPaint = fillTexturePaint(ctx, style, boxW, boxH) ?? fillGradientPaint(ctx, style, boxW, boxH);
  // ADR-023 D7 (S5): the per-line pill, read from the SAME emitted string the DOM path consumes so the
  // two cannot disagree about the look — the discipline `paintOrder` and `direction` already follow.
  // The block background above has already been emitted as `transparent` whenever this is present, so
  // the two are never both drawn.
  const linePill = typeof style.textLinePill === "string" ? parseTextLinePill(style.textLinePill) : undefined;
  const pillPadY = linePill ? linePill.padYEm * fontSize : 0;
  const pillPadX = linePill ? linePill.padXEm * fontSize : 0;
  const pillRadius = linePill ? linePill.radiusEm * fontSize : 0;

  // Stroke (WebkitTextStroke: "Wpx color").
  const strokeStr = style.WebkitTextStroke ? String(style.WebkitTextStroke) : "";
  const strokeWidth = strokeStr ? num(strokeStr) : 0;
  const strokeColor = strokeStr ? strokeStr.slice(String(num(strokeStr)).length + 3) : "";
  // ADR-023 D7 (S1). The CSS the DOM path gets is `paint-order: stroke fill`; canvas has no such
  // property, so the equivalent here is literally the order of the two passes. Read from the SAME
  // emitted style object rather than from the layer, so the DOM and the raster cannot diverge on
  // which look a layer has. Absent → false → the existing fill-then-stroke order, untouched.
  const strokeUnderFill = style.paintOrder === "stroke fill";
  /**
   * S0b (ADR-023 D6a), S0c. The base paragraph direction, read from the SAME emitted style object the
   * DOM path consumes and never inferred here (T-13). Canvas 2D takes it as `ctx.direction`, which is
   * what makes `fillText` reorder a line and place neutrals — a `؟` closing an Arabic sentence, a
   * bracket, a digit run — at the correct end.
   *
   * `"auto"` no longer reaches this point: `resolveTextDirection` collapses it to a concrete `"ltr"`
   * or `"rtl"` at style-resolution time, once, for both renderers (T-13 as corrected). Canvas has no
   * `unicode-bidi: plaintext` and resolving it HERE — inside the paint path, per frame, in one
   * renderer — is what the rule forbids.
   */
  const baseDirection = style.direction === "rtl" ? "rtl" : style.direction === "ltr" ? "ltr" : undefined;
  // Only touch the context when the layer actually declares a direction, so a legacy layer's draw
  // sequence is byte-identical to what it was before this field existed.
  if (baseDirection) ctx.direction = baseDirection;

  // #3b: alphabetic baseline matching the CSS line-box model. The browser centers the
  // glyph block (ascent+descent) vertically within each line-height box using half-leading.
  // We replicate this: baseline = lineBoxTop + (lineHeightPx - (ascent+descent))/2 + ascent.
  ctx.textBaseline = "alphabetic";
  const contentLeft = -boxW / 2 + padX;
  const contentRight = boxW / 2 - padX;

  /** Where a line's pieces START, given its measured width — the one place the alignment rule lives. */
  const lineStartX = (lw: number): number => {
    // S0b: resolve the LOGICAL keywords against the layer's DECLARED direction. This is not the
    // paint-time inference T-13 forbids — that is deriving direction from content; this is what CSS
    // itself does with a direction it was given. `left`/`right` stay physical and untouched.
    const physical =
      textAlign === "start" ? (baseDirection === "rtl" ? "right" : "left")
      : textAlign === "end" ? (baseDirection === "rtl" ? "left" : "right")
      : textAlign;
    return physical === "left" ? contentLeft : physical === "right" ? contentRight - lw : -lw / 2;
  };

  /**
   * ADR-023 D7 (S5) — the per-line pills, ALL of them, before ANY glyph.
   *
   * A separate pass and not a step inside the draw loop, because CSS puts every inline box's background
   * in the background layer, beneath all of the element's text. Drawn per line inside the loop, line
   * two's pill lands on top of line one's descenders and eats them — which is what the first run of
   * this feature rendered, visibly, on the two-line fixture.
   *
   * Each rect is sized from its line's INK box (`ascent..descent`) plus the padding, not from the
   * line-height box, because the background of an inline box is its content area, which the engine
   * derives from the font's ascent and descent — the same two numbers the baseline is computed from
   * below. Sizing it from `lineHeightPx` would look right at line-height 1.0 and drift from the DOM at
   * every other value, and the default here is 0.95.
   */
  if (linePill) {
    ctx.save();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.fillStyle = linePill.color;
    let pillOffsetY = 0;
    for (const [lineIndex, line] of lines.entries()) {
      const lineBoxHeight = lineHeights[lineIndex] ?? fontSize * 1.2;
      const lineBoxTop = -boxH / 2 + padY + pillOffsetY;
      pillOffsetY += lineBoxHeight;
      let ascent = 0;
      let descent = 0;
      for (const word of line) {
        ctx.font = word.font;
        const metrics = ctx.measureText(word.text);
        ascent = Math.max(ascent, metrics.fontBoundingBoxAscent ?? word.fontSize * 0.8);
        descent = Math.max(descent, metrics.fontBoundingBoxDescent ?? word.fontSize * 0.2);
      }
      // An EMPTY line has no ink and so no inline box to paint — CSS draws nothing there either, and a
      // blank line in a caption showing a bare padded stub is the tell that this was missed.
      if (!line.length) continue;
      const lw = lineWidth(ctx, line);
      if (lw <= 0) continue;
      const baseline = lineBoxTop + (lineBoxHeight - (ascent + descent)) / 2 + ascent;
      roundRect(
        ctx,
        lineStartX(lw) - pillPadX,
        baseline - ascent - pillPadY,
        lw + 2 * pillPadX,
        ascent + descent + 2 * pillPadY,
        pillRadius
      );
      ctx.fill();
    }
    ctx.restore();
  }

  let lineOffsetY = 0;
  lines.forEach((line, lineIndex) => {
    const lineHeightPx = lineHeights[lineIndex] ?? fontSize * 1.2;
    const lineBoxTop = -boxH / 2 + padY + lineOffsetY;
    lineOffsetY += lineHeightPx;

    // One baseline per line, from the max ascent/descent across the line's fonts, so all words
    // share a single baseline (CSS `vertical-align: baseline`) even when runs mix font/size.
    let lineAscent = 0;
    let lineDescent = 0;
    for (const word of line) {
      ctx.font = word.font;
      const m = ctx.measureText(word.text);
      lineAscent = Math.max(lineAscent, m.fontBoundingBoxAscent ?? word.fontSize * 0.8);
      lineDescent = Math.max(lineDescent, m.fontBoundingBoxDescent ?? word.fontSize * 0.2);
    }
    if (!line.length) {
      lineAscent = fontSize * 0.8;
      lineDescent = fontSize * 0.2;
    }
    const y = lineBoxTop + (lineHeightPx - (lineAscent + lineDescent)) / 2 + lineAscent;

    /**
     * ADR-023 T-13a (S0c) — draw LINES, not words, wherever the line permits it.
     *
     * The loop below places each token at an x the CALLER computed, which means bidi reordering can
     * never happen no matter what `ctx.direction` says: `"مرحبا Brand بالعالم"` came out in logical
     * word order even at an explicit `"rtl"`. Setting the base direction fixes the start edge and
     * reordering WITHIN a drawn string; it cannot fix placement already decided outside the engine.
     * Collapsing a single-style line to one token hands the whole line to `fillText`, which is the
     * only thing that can reorder it — and is also fewer measure passes than the loop it replaces.
     *
     * A line with two styles cannot be collapsed: canvas 2D exposes no per-character visual
     * positions, so its runs must be placed individually and therefore logically. That case degrades
     * VISIBLY (`isTextVisualOrderUnavailable` → the editor marker), per T-12, rather than quietly
     * emitting the wrong order.
     */
    const pieces = collapseLine(line);
    const lw = lineWidth(ctx, line);
    // S0b's logical-alignment resolution, now via `lineStartX` — the pill pass has to place a line the
    // same way the glyphs are placed, and two copies of that rule is how a right-aligned pill ends up
    // under left-aligned text.
    let x = lineStartX(lw);
    ctx.textAlign = "left";

    /**
     * ADR-023 D7 (S5) — the stacked shadow copies, farthest first so the nearest ends up on top, which
     * is the order CSS paints a `text-shadow` list in.
     *
     * Canvas carries ONE shadow at a time, so N shadows are N silhouette draws. The silhouette is
     * whichever pass is outermost — the stroke under `paint-order: stroke fill`, the fill otherwise —
     * matching the single-shadow rule the main draw already follows. Entry 0 is deliberately NOT drawn
     * here: it rides the real pass below, exactly as it did before this field existed, which is what
     * keeps a one-entry list byte-identical.
     */
    if (shadowList.length > 1) {
      // The same arithmetic the draw loop below walks, computed up front because the shadow passes
      // need every position N times and the loop consumes `x` as it goes.
      const positions: number[] = [];
      let px = x;
      pieces.forEach((word, index) => {
        ctx.font = word.font;
        if (index > 0) px += ctx.measureText(" ").width;
        positions.push(px);
        px += ctx.measureText(word.text).width;
      });
      const outerStroke = strokeUnderFill && strokeWidth > 0;
      for (let k = shadowList.length - 1; k >= 1; k -= 1) {
        applyShadow(ctx, shadowList[k]!);
        pieces.forEach((word, index) => {
          ctx.font = word.font;
          if (outerStroke) {
            ctx.lineWidth = strokeWidth;
            ctx.strokeStyle = strokeColor || "#000";
            ctx.lineJoin = "round";
            ctx.strokeText(word.text, positions[index]!, y);
          } else {
            ctx.fillStyle = glyphPaint ?? word.color;
            ctx.fillText(word.text, positions[index]!, y);
          }
        });
      }
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }

    pieces.forEach((word, wordIndex) => {
      ctx.font = word.font;
      if (wordIndex > 0) x += ctx.measureText(" ").width;

      // Per-run HIGHLIGHT: paint the marker box behind the word (ascent..descent — the DOM span's
      // background box). A trailing space is bridged when the NEXT word shares the same highlight,
      // so a multi-word marker reads as one continuous band. Painted unskewed — CSS font-synthesis
      // slants glyphs, never the span box.
      if (word.background) {
        const wordWidth = ctx.measureText(word.text).width;
        const nextWord = pieces[wordIndex + 1];
        const bridge = word.space && nextWord && nextWord.background === word.background ? ctx.measureText(" ").width : 0;
        ctx.save();
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.fillStyle = word.background;
        ctx.fillRect(x, y - lineAscent, wordWidth + bridge, lineAscent + lineDescent);
        ctx.restore();
      }

      // Synthetic oblique for italic-less faces (see needsItalicSynthesis) — skew about the
      // word's baseline origin so the slant matches CSS font-synthesis and advances are unchanged.
      const synthesizeItalic = needsItalicSynthesis(ctx, word.font);
      if (synthesizeItalic) {
        ctx.save();
        ctx.translate(x, y);
        ctx.transform(1, 0, -ITALIC_SKEW, 1, 0, 0);
        ctx.translate(-x, -y);
      }

      // #3c: fill first (with shadow), then stroke on top — matches CSS -webkit-text-stroke
      // which paints the stroke centered on the glyph outline OVER the fill.
      // Texture fill (D2): the pattern overrides every run's solid color (whole-layer paint, v1).
      //
      // S1 (ADR-023 D7): `paint-order: stroke fill` swaps the two passes so the stroke goes down
      // first and the fill covers its inner half. The shadow always rides the FIRST pass, so it is
      // cast by whichever silhouette is outermost — for stroke-under that is the stroke, which is
      // what CSS does too; a shadow on the second pass would draw on top of the first.
      if (strokeUnderFill && strokeWidth > 0) {
        if (shadow) applyShadow(ctx, shadow);
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = strokeColor || "#000";
        ctx.lineJoin = "round";
        ctx.strokeText(word.text, x, y);

        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.fillStyle = glyphPaint ?? word.color;
        ctx.fillText(word.text, x, y);
      } else {
        if (shadow) applyShadow(ctx, shadow);
        ctx.fillStyle = glyphPaint ?? word.color;
        ctx.fillText(word.text, x, y);

        if (strokeWidth > 0) {
          // Clear shadow for the stroke pass so the stroke doesn't add a second shadow.
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          ctx.lineWidth = strokeWidth;
          ctx.strokeStyle = strokeColor || "#000";
          ctx.lineJoin = "round";
          ctx.strokeText(word.text, x, y);
        }
      }

      if (synthesizeItalic) ctx.restore();
      x += ctx.measureText(word.text).width;
    });
  });

  ctx.restore();
  ctx.letterSpacing = "";
  // Belt-and-braces, alongside the letterSpacing reset above and for the same reason: these
  // rasterizers share a scratch context, and a leaked `rtl` would silently re-lay-out the NEXT layer
  // drawn into it. The `ctx.restore()` on the line above should already cover it — `direction` is
  // part of the canvas drawing state — but so is `letterSpacing`, and that one is still reset by hand
  // here because the guarantee is recent and not uniformly old across the engines this ships to.
  if (baseDirection) ctx.direction = "inherit";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  return { boxW, boxH };
}


export function drawShapeLayer(
  ctx: Ctx,
  layer: TimelineLayer,
  t: number,
  W: number,
  H: number,
  mode: OverlayTransformMode = "full",
  rasterScale = 1,
  styleOptions: OverlayStyleOptions = {}
): OverlayBox {
  const style = getCompositionShapeStyle(layer, { currentTimeSeconds: t, ...styleOptions }) as Record<string, unknown>;
  const transform = getCompositionTransform(layer, { currentTimeSeconds: t });
  const w = (num(style.width) / 100) * W;
  const h = (num(style.height) / 100) * H;
  if (w <= 0 || h <= 0) return { boxW: 0, boxH: 0 };
  const radius = num(style.borderRadius);
  const shapeKind = String(style.shapeKind ?? layer.shapeKind ?? "rounded-rectangle");
  const shapePath = Array.isArray(style.shapePath) ? (style.shapePath as MaskPoint[]) : layer.shapePath;
  const background = String(style.background ?? "#fff");
  const borderStr = style.border ? String(style.border) : "";
  const borderWidth = borderStr ? num(borderStr) : 0;
  const borderColor = borderStr ? borderStr.slice(String(num(borderStr)).length).replace(/^px\s+solid\s+/, "").trim() : "";

  const content = mode === "content";
  const box = mode === "box";

  ctx.save();
  ctx.globalAlpha = content || box ? 1 : Math.max(0, Math.min(1, transform.opacity / 100));
  if (box) {
    ctx.translate(ctx.canvas.width / 2, ctx.canvas.height / 2);
    ctx.scale(rasterScale, rasterScale);
  } else {
    const centerX = content ? W / 2 : (transform.x / 100) * W;
    const centerY = content ? H / 2 : (transform.y / 100) * H;
    ctx.translate(centerX, centerY);
    if (mode === "full") {
      ctx.rotate((transform.rotation * Math.PI) / 180);
      ctx.scale(transform.scale, transform.scale);
    }
    // Anchor (D3): same pivot shift as drawTextLayer — position places the anchor point of the
    // shape box, rotate/scale pivot there. Default 50/50 → no-op.
    ctx.translate((-((transform.anchorX ?? 50) - 50) / 100) * w, (-((transform.anchorY ?? 50) - 50) / 100) * h);
  }

  const boxShadow = style.boxShadow ? String(style.boxShadow) : "";
  if (boxShadow) applyShadow(ctx, boxShadow);

  // Texture fill (D2): the pattern paints the shape body instead of the solid color when decoded.
  ctx.fillStyle = fillTexturePaint(ctx, style, w, h) ?? background;
  buildShapePath(ctx, shapeKind, -w / 2, -h / 2, w, h, radius, shapePath);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  if (borderWidth > 0) {
    ctx.lineWidth = borderWidth;
    ctx.strokeStyle = borderColor || "#fff";
    buildShapePath(ctx, shapeKind, -w / 2, -h / 2, w, h, radius, shapePath);
    ctx.stroke();
  }
  ctx.restore();
  return { boxW: w, boxH: h };
}

function buildShapePath(ctx: Ctx, kind: string, x: number, y: number, w: number, h: number, radius: number, shapePath?: MaskPoint[] | undefined): void {
  switch (kind) {
    case "pen":
      customShapePath(ctx, shapePath, x, y, w, h);
      return;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
      return;
    case "line":
      roundRect(ctx, x, y + h * 0.375, w, h * 0.25, Math.min(radius, h / 8));
      return;
    case "triangle":
      regularPolygon(ctx, x, y, w, h, 3, -Math.PI / 2);
      return;
    case "diamond":
      regularPolygon(ctx, x, y, w, h, 4, -Math.PI / 2);
      return;
    case "pentagon":
      regularPolygon(ctx, x, y, w, h, 5, -Math.PI / 2);
      return;
    case "rectangle":
      roundRect(ctx, x, y, w, h, 0);
      return;
    case "rounded-rectangle":
    default:
      roundRect(ctx, x, y, w, h, radius);
      return;
  }
}

/** One axis of a cubic bezier's interior extrema: B(t) at the real roots of B'(t) in (0,1). */
function cubicAxisExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = 3 * (-p0 + 3 * p1 - 3 * p2 + p3);
  const b = 6 * (p0 - 2 * p1 + p2);
  const c = 3 * (p1 - p0);
  const roots: number[] = [];
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  const out: number[] = [];
  for (const t of roots) {
    if (t <= 0 || t >= 1) continue;
    const mt = 1 - t;
    out.push(mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3);
  }
  return out;
}

/** EXACT bounds of a closed pen path — true curve extrema per cubic segment, not the (looser)
 *  control-point hull. Unit-agnostic: anchors and their RELATIVE in/out tangent deltas just have to
 *  share units (box px in the editor overlay, percent-of-box in `shapePath`). Null for <2 points.
 *  This is what the editor uses to renormalize a pen shape's box to its visual bounds on commit. */
export function penPathBounds(points: MaskPoint[] | undefined): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!points || points.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const pt of points) take(pt.x, pt.y);
  const hasTangents = points.some((pt) => pt.inTangent || pt.outTangent);
  if (hasTangents) {
    for (let i = 0; i < points.length; i += 1) {
      const cur = points[i]!;
      const next = points[(i + 1) % points.length]!;
      const xs = cubicAxisExtrema(cur.x, cur.x + (cur.outTangent?.x ?? 0), next.x + (next.inTangent?.x ?? 0), next.x);
      const ys = cubicAxisExtrema(cur.y, cur.y + (cur.outTangent?.y ?? 0), next.y + (next.inTangent?.y ?? 0), next.y);
      for (const x of xs) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      for (const y of ys) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function customShapePath(ctx: Ctx, points: MaskPoint[] | undefined, x: number, y: number, w: number, h: number): void {
  // A pen shape with no drawn geometry renders NOTHING (draw-first flow, 2026-07-17): the editor
  // creates the layer empty and arms the viewer pen tool; the old ellipse-ish fallback here made
  // "add pen shape" look like it inserted a circle.
  if (!points || points.length < 2) {
    ctx.beginPath();
    return;
  }
  const pts = points;
  const toX = (value: number) => x + (value / 100) * w;
  const toY = (value: number) => y + (value / 100) * h;
  const toDx = (value: number) => (value / 100) * w;
  const toDy = (value: number) => (value / 100) * h;
  ctx.beginPath();
  ctx.moveTo(toX(pts[0]!.x), toY(pts[0]!.y));
  const hasTangents = pts.some((point) => point.inTangent || point.outTangent);
  for (let i = 0; i < pts.length; i += 1) {
    const cur = pts[i]!;
    const next = pts[(i + 1) % pts.length]!;
    if (hasTangents) {
      ctx.bezierCurveTo(
        toX(cur.x) + toDx(cur.outTangent?.x ?? 0),
        toY(cur.y) + toDy(cur.outTangent?.y ?? 0),
        toX(next.x) + toDx(next.inTangent?.x ?? 0),
        toY(next.y) + toDy(next.inTangent?.y ?? 0),
        toX(next.x),
        toY(next.y)
      );
    } else {
      ctx.lineTo(toX(next.x), toY(next.y));
    }
  }
  ctx.closePath();
}

function regularPolygon(ctx: Ctx, x: number, y: number, w: number, h: number, sides: number, startAngle: number): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = Math.max(0, w / 2);
  const ry = Math.max(0, h / 2);
  ctx.beginPath();
  for (let i = 0; i < sides; i += 1) {
    const angle = startAngle + (i / sides) * Math.PI * 2;
    const px = cx + Math.cos(angle) * rx;
    const py = cy + Math.sin(angle) * ry;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}

function applyShadow(ctx: Ctx, css: string): void {
  // "<ox>px <oy>px <blur>px <color>"
  const match = css.match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(.+)/);
  if (!match) return;
  ctx.shadowOffsetX = num(match[1]);
  ctx.shadowOffsetY = num(match[2]);
  ctx.shadowBlur = num(match[3]);
  ctx.shadowColor = match[4]!.trim();
}
