/**
 * Text & shape rasterization (Phase L2; promoted into @kimera-by-aelivion/shared in Method 3 Phase 6.1).
 *
 * Draws `text` (incl. rich runs + warp) and `shape` layers onto a 2D compositor canvas,
 * reusing the shared style helpers so sizes/colors/positions match the editor preview.
 * Text uses canvas fillText with the document's loaded fonts (the orchestrator preloads
 * them); warp text rasterizes the shared vector-outline SVG (font-independent). Shared so the
 * editor preview, local export, and the future Remotion SceneStage all rasterize identically.
 */

import { buildWarpedTextPaths } from "../font-outlines";
import {
  compositionTextDefaults,
  getCompositionShapeStyle,
  getCompositionTextRunStyle,
  getCompositionTextStyle,
  getCompositionTransform,
  getVisibleTextRuns,
} from "../composition-style";
import { hasTextWarp } from "../text-warp";
import type { MaskPoint, TextRun, TextWarp, TimelineLayer } from "../types";

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

/**
 * Canvas2D never SYNTHESIZES italic: a family with no italic face (Impact, most display fonts)
 * silently falls back to the upright face, while the DOM/Remotion path oblique-slants it via CSS
 * `font-synthesis`. Detect that case (italic vs upright metrics identical ⇒ no real italic face)
 * and slant the glyph draw manually so the raster matches the DOM. ~ tan(14°), the CSS synthesis
 * angle. Fonts WITH a real italic face measure differently and are left to their true italics.
 */
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

interface Word {
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
function measureTextLayout(ctx: Ctx, layer: TimelineLayer, t: number, W: number): TextLayout | null {
  // #4: slice visible chars via textRevealProgress (typewriter animation), matching preview/cloud.
  const runs = getVisibleTextRuns(layer, t);
  if (!runs.some((r) => r.text)) return null;
  const style = getCompositionTextStyle(layer, { currentTimeSeconds: t }) as Record<string, unknown>;

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
export function measureOverlayBox(ctx: Ctx, layer: TimelineLayer, t: number, W: number, H: number): OverlayBox {
  if (layer.type === "text") {
    const layout = measureTextLayout(ctx, layer, t, W);
    return layout ? { boxW: layout.boxW, boxH: layout.boxH } : { boxW: 0, boxH: 0 };
  }
  const style = getCompositionShapeStyle(layer, { currentTimeSeconds: t }) as Record<string, unknown>;
  return { boxW: Math.max(0, (num(style.width) / 100) * W), boxH: Math.max(0, (num(style.height) / 100) * H) };
}

/** Extra comp-px padding a "box"-mode raster needs so text-shadow / stroke / shape border+shadow don't
 *  clip against the tight element box (the comp-sized raster never clipped; a tight box would). Parsed
 *  from the same resolved style the draw uses, so it tracks the actual overhang. */
export function overlayOverhangMargin(layer: TimelineLayer, t: number): number {
  let m = 2; // base anti-aliasing pad
  const shadowExtent = (css: string): number => {
    const sm = css.match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px/);
    return sm ? Math.abs(num(sm[1])) + Math.abs(num(sm[2])) + num(sm[3]) * 1.5 + 2 : 0;
  };
  if (layer.type === "text") {
    const style = getCompositionTextStyle(layer, { currentTimeSeconds: t }) as Record<string, unknown>;
    if (style.textShadow) m = Math.max(m, shadowExtent(String(style.textShadow)));
    if (style.WebkitTextStroke) m = Math.max(m, num(String(style.WebkitTextStroke)) + 2);
  } else if (layer.type === "shape") {
    const style = getCompositionShapeStyle(layer, { currentTimeSeconds: t }) as Record<string, unknown>;
    if (style.boxShadow) m = Math.max(m, shadowExtent(String(style.boxShadow)));
    if (style.border) m = Math.max(m, num(String(style.border)) / 2 + 2); // border straddles the edge
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
  rasterScale = 1
): Promise<OverlayBox> {
  const layout = measureTextLayout(ctx, layer, t, W);
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

  // Warp: draw the shared vector glyph outlines via Path2D (font-independent). Path2D works on both
  // the main thread AND the export Worker's OffscreenCanvas — unlike createImageBitmap(svgBlob), which
  // Chrome can't decode (it threw, so warp silently fell back to plain text in scene + local export).
  if (hasTextWarp(layer.textWarp as TextWarp | undefined)) {
    const warp = await buildWarpedTextPaths(layer.textWarp as TextWarp, runs, style).catch(() => undefined);
    if (warp && warp.paths.length) {
      ctx.save();
      // Map the warp's local box (width×height) onto the text box (boxW×boxH), centred at the origin —
      // the same stretch the old SVG raster did (viewBox→box, preserveAspectRatio="none").
      ctx.translate(-boxW / 2, -boxH / 2);
      ctx.scale(boxW / warp.width, boxH / warp.height);
      for (const p of warp.paths) {
        const path2d = new Path2D(p.d);
        if (p.stroke && p.stroke.width > 0) {
          // paint-order: stroke is painted UNDER the fill (matches the SVG `paint-order="stroke"`).
          ctx.lineWidth = p.stroke.width;
          ctx.strokeStyle = p.stroke.color;
          ctx.lineJoin = "round";
          ctx.stroke(path2d);
        }
        ctx.fillStyle = p.fill;
        ctx.fill(path2d);
      }
      ctx.restore();
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

    const lw = lineWidth(ctx, line);
    let x = textAlign === "left" ? contentLeft : textAlign === "right" ? contentRight - lw : -lw / 2;
    ctx.textAlign = "left";
    line.forEach((word, wordIndex) => {
      ctx.font = word.font;
      if (wordIndex > 0) x += ctx.measureText(" ").width;

      // Per-run HIGHLIGHT: paint the marker box behind the word (ascent..descent — the DOM span's
      // background box). A trailing space is bridged when the NEXT word shares the same highlight,
      // so a multi-word marker reads as one continuous band. Painted unskewed — CSS font-synthesis
      // slants glyphs, never the span box.
      if (word.background) {
        const wordWidth = ctx.measureText(word.text).width;
        const nextWord = line[wordIndex + 1];
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

      if (synthesizeItalic) ctx.restore();
      x += ctx.measureText(word.text).width;
    });
  });

  ctx.restore();
  ctx.letterSpacing = "";
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
  rasterScale = 1
): OverlayBox {
  const style = getCompositionShapeStyle(layer, { currentTimeSeconds: t }) as Record<string, unknown>;
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

  ctx.fillStyle = background;
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

function customShapePath(ctx: Ctx, points: MaskPoint[] | undefined, x: number, y: number, w: number, h: number): void {
  const pts = points && points.length >= 2 ? points : defaultPenShapePath();
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

function defaultPenShapePath(): MaskPoint[] {
  return [
    { id: "pen_top", x: 50, y: 4, inTangent: { x: -30.36, y: 0 }, outTangent: { x: 30.36, y: 0 }, lockedTangents: true },
    { id: "pen_right", x: 96, y: 50, inTangent: { x: 0, y: -30.36 }, outTangent: { x: 0, y: 30.36 }, lockedTangents: true },
    { id: "pen_bottom", x: 50, y: 96, inTangent: { x: 30.36, y: 0 }, outTangent: { x: -30.36, y: 0 }, lockedTangents: true },
    { id: "pen_left", x: 4, y: 50, inTangent: { x: 0, y: 30.36 }, outTangent: { x: 0, y: -30.36 }, lockedTangents: true }
  ];
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
