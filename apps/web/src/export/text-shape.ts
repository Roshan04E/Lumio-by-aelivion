/**
 * Local export — text & shape rasterization (Phase L2).
 *
 * Draws `text` (incl. rich runs + warp) and `shape` layers onto the 2D compositor canvas,
 * reusing the shared style helpers so sizes/colors/positions match the editor preview.
 * Text uses canvas fillText with the document's loaded fonts (the orchestrator preloads
 * them); warp text rasterizes the shared vector-outline SVG (font-independent).
 */

import {
  buildWarpedTextPathSvg,
  compositionTextDefaults,
  getCompositionShapeStyle,
  getCompositionTextRunStyle,
  getCompositionTextStyle,
  getCompositionTransform,
  getVisibleTextRuns,
  hasTextWarp,
  type TextRun,
  type TextWarp,
  type TimelineLayer,
} from "@reelforge/shared";

// Works against both the main-thread 2D context and the Worker's OffscreenCanvas 2D context.
type Ctx = (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) & { letterSpacing?: string };

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

interface Word {
  text: string;
  font: string;
  color: string;
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
      fontFamily?: unknown;
      fontStyle?: unknown;
    };
    const size = num(runStyle.fontSize, baseStyle.fontSize);
    const font = fontString({ fontStyle: runStyle.fontStyle, fontWeight: runStyle.fontWeight, fontSize: size, fontFamily: runStyle.fontFamily });
    const color = String(runStyle.color ?? baseStyle.color ?? "#fff");
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
          tokens.push({ text: part, font, color, fontSize: size, space: false });
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

function lineWidth(ctx: Ctx, line: Word[]): number {
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
export type OverlayTransformMode = "full" | "flat";

/** The drawn element's content-box size in comp px — used to size the 3D perspective quad. */
export interface OverlayBox {
  boxW: number;
  boxH: number;
}

export async function drawTextLayer(
  ctx: Ctx,
  layer: TimelineLayer,
  t: number,
  W: number,
  H: number,
  mode: OverlayTransformMode = "full"
): Promise<OverlayBox> {
  // #4: slice visible chars via textRevealProgress (typewriter animation), matching preview/cloud.
  const runs = getVisibleTextRuns(layer, t);
  if (!runs.some((r) => r.text)) return { boxW: 0, boxH: 0 };
  const style = getCompositionTextStyle(layer, { currentTimeSeconds: t }) as Record<string, unknown>;
  const transform = getCompositionTransform(layer, { currentTimeSeconds: t });

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

  if (letterSpacing) ctx.letterSpacing = letterSpacing;

  const baseStyle = { fontSize, fontWeight: style.fontWeight, color: style.color, fontFamily: style.fontFamily, fontStyle: style.fontStyle };
  const lines = layoutWords(ctx, runs, baseStyle, maxWidthContent > 0 ? maxWidthContent : 0);

  const fixedWidth = widthStr.endsWith("%") ? (num(widthStr) / 100) * W - 2 * padX : 0;
  const contentWidth = fixedWidth > 0 ? fixedWidth : Math.max(0, ...lines.map((l) => lineWidth(ctx, l)));
  const boxW = contentWidth + 2 * padX;
  const boxH = lines.length * lineHeightPx + 2 * padY;

  const centerX = (transform.x / 100) * W;
  const centerY = (transform.y / 100) * H;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity / 100));
  ctx.translate(centerX, centerY);
  if (mode === "full") {
    ctx.rotate((transform.rotation * Math.PI) / 180);
    ctx.scale(transform.scale, transform.scale);
  }

  // Background box.
  if (background && background !== "transparent" && background !== "none") {
    ctx.fillStyle = background;
    roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, radius);
    ctx.fill();
  }

  // Warp: rasterize the shared vector-outline SVG over the text box (font-independent).
  if (hasTextWarp(layer.textWarp as TextWarp | undefined)) {
    const warpImg = await rasterizeWarp(layer.textWarp as TextWarp, runs, style, boxW, boxH).catch(() => null);
    if (warpImg) {
      ctx.drawImage(warpImg as CanvasImageSource, -boxW / 2, -boxH / 2, boxW, boxH);
      ctx.restore();
      ctx.letterSpacing = "";
      return { boxW, boxH };
    }
  }

  // Text shadow.
  const shadow = style.textShadow ? String(style.textShadow) : "";

  // Stroke (WebkitTextStroke: "Wpx color").
  const strokeStr = style.WebkitTextStroke ? String(style.WebkitTextStroke) : "";
  const strokeWidth = strokeStr ? num(strokeStr) : 0;
  const strokeColor = strokeStr ? strokeStr.slice(String(num(strokeStr)).length + 3) : "";

  // #3b: alphabetic baseline matching the CSS line-box model. The browser centers the
  // glyph block (ascent+descent) vertically within each line-height box using half-leading.
  // We replicate this: baseline = lineBoxTop + (lineHeightPx - (ascent+descent))/2 + ascent.
  ctx.textBaseline = "alphabetic";
  const contentLeft = -boxW / 2 + padX;
  const contentRight = boxW / 2 - padX;

  lines.forEach((line, lineIndex) => {
    const lineBoxTop = -boxH / 2 + padY + lineIndex * lineHeightPx;

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

    const lw = lineWidth(ctx, line);
    let x = textAlign === "left" ? contentLeft : textAlign === "right" ? contentRight - lw : -lw / 2;
    ctx.textAlign = "left";
    line.forEach((word, wordIndex) => {
      ctx.font = word.font;
      if (wordIndex > 0) x += ctx.measureText(" ").width;

      // #3c: fill first (with shadow), then stroke on top — matches CSS -webkit-text-stroke
      // which paints the stroke centered on the glyph outline OVER the fill.
      if (shadow) applyShadow(ctx, shadow);
      ctx.fillStyle = word.color;
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

      x += ctx.measureText(word.text).width;
    });
  });

  ctx.restore();
  ctx.letterSpacing = "";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  return { boxW, boxH };
}

// Cache rasterized warp bitmaps by markup+box so a held warp clip isn't re-rasterized every
// frame (P4 micro-opt). buildWarpedTextPathSvg is itself content-memoized, so identical frames
// produce an identical markup key and hit this cache.
const warpRasterCache = new Map<string, ImageBitmap>();
const WARP_RASTER_CACHE_CAP = 64;

async function rasterizeWarp(
  warp: TextWarp,
  runs: TextRun[],
  style: Record<string, unknown>,
  boxW: number,
  boxH: number
): Promise<ImageBitmap | null> {
  let markup = await buildWarpedTextPathSvg(warp, runs as never, style as never);
  if (!markup) return null;
  const w = Math.max(1, Math.round(boxW));
  const h = Math.max(1, Math.round(boxH));
  // Ensure the rasterized SVG has explicit pixel dimensions so it renders at box size.
  if (/^<svg/i.test(markup) && !/\bwidth=/.test(markup.slice(0, 200))) {
    markup = markup.replace(/^<svg/i, `<svg width="${w}" height="${h}"`);
  }
  const cacheKey = `${w}x${h}:${markup}`;
  const cached = warpRasterCache.get(cacheKey);
  if (cached) return cached;

  // createImageBitmap rasterizes the SVG blob on both the main thread and inside a Worker.
  const bitmap = await createImageBitmap(new Blob([markup], { type: "image/svg+xml" })).catch(() => null);
  if (!bitmap) return null;

  if (warpRasterCache.size >= WARP_RASTER_CACHE_CAP) {
    const firstKey = warpRasterCache.keys().next().value;
    if (firstKey !== undefined) {
      warpRasterCache.get(firstKey)?.close();
      warpRasterCache.delete(firstKey);
    }
  }
  warpRasterCache.set(cacheKey, bitmap);
  return bitmap;
}

export function drawShapeLayer(
  ctx: Ctx,
  layer: TimelineLayer,
  t: number,
  W: number,
  H: number,
  mode: OverlayTransformMode = "full"
): OverlayBox {
  const style = getCompositionShapeStyle(layer, { currentTimeSeconds: t }) as Record<string, unknown>;
  const transform = getCompositionTransform(layer, { currentTimeSeconds: t });
  const w = (num(style.width) / 100) * W;
  const h = (num(style.height) / 100) * H;
  if (w <= 0 || h <= 0) return { boxW: 0, boxH: 0 };
  const radius = num(style.borderRadius);
  const background = String(style.background ?? "#fff");
  const borderStr = style.border ? String(style.border) : "";
  const borderWidth = borderStr ? num(borderStr) : 0;
  const borderColor = borderStr ? borderStr.slice(String(num(borderStr)).length).replace(/^px\s+solid\s+/, "").trim() : "";

  const centerX = (transform.x / 100) * W;
  const centerY = (transform.y / 100) * H;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity / 100));
  ctx.translate(centerX, centerY);
  if (mode === "full") {
    ctx.rotate((transform.rotation * Math.PI) / 180);
    ctx.scale(transform.scale, transform.scale);
  }

  const boxShadow = style.boxShadow ? String(style.boxShadow) : "";
  if (boxShadow) applyShadow(ctx, boxShadow);

  ctx.fillStyle = background;
  roundRect(ctx, -w / 2, -h / 2, w, h, radius);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  if (borderWidth > 0) {
    ctx.lineWidth = borderWidth;
    ctx.strokeStyle = borderColor || "#fff";
    roundRect(ctx, -w / 2, -h / 2, w, h, radius);
    ctx.stroke();
  }
  ctx.restore();
  return { boxW: w, boxH: h };
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
