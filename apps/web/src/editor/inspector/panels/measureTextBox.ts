/**
 * One-shot measurement of a text layer's REAL rendered content box, returned as
 * comp fractions (0..1 of comp width/height, BEFORE the layer transform scale —
 * paintedBoxAt applies scale). Text boxes hug their glyphs (point text) or wrap
 * inside an explicit frame (paragraph text); neither is derivable from props, so
 * align/distribute measure the live box at click time.
 *
 * Renderer-faithful: it lays out a hidden element with the SAME CSS the preview
 * uses (getCompositionTextStyle), at comp scale (1 CSS px == 1 comp px), minus the
 * transform. Forced layout on click only — never per frame. No persisted mutation,
 * so point text keeps auto-growing on later edits (true Premiere point-text behavior).
 */

import { getCompositionTextStyle, type TimelineLayer } from "@kimera-by-aelivion/shared";

let host: HTMLDivElement | null = null;

function measuringHost(): HTMLDivElement {
  if (host && host.isConnected) return host;
  host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "absolute",
    left: "-99999px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    contain: "layout size style"
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(host);
  return host;
}

function layerText(layer: TimelineLayer): string {
  if (layer.text) return layer.text;
  if (layer.textRuns?.length) return layer.textRuns.map((run) => run.text).join("");
  return "";
}

/** Percent value like "86%" → px against `basisPx`; anything else → undefined. */
function percentToPx(value: unknown, basisPx: number): number | undefined {
  if (typeof value === "string" && value.endsWith("%")) {
    const pct = Number.parseFloat(value);
    if (Number.isFinite(pct)) return (pct / 100) * basisPx;
  }
  return undefined;
}

/**
 * Measured content box for a text layer as { w, h } fractions of the comp. Falls back
 * to a small default if the DOM isn't available (SSR/tests) so callers never crash.
 */
export function measureTextContentFraction(
  layer: TimelineLayer,
  comp: { width: number; height: number },
  currentTime: number
): { w: number; h: number } {
  if (typeof document === "undefined" || !comp.width || !comp.height) {
    return { w: 0.2, h: 0.1 };
  }

  const style = getCompositionTextStyle(layer, { currentTimeSeconds: currentTime });
  const el = document.createElement("div");
  const explicitWidthPx = percentToPx(style.width, comp.width);
  const maxWidthPx = percentToPx(style.maxWidth, comp.width);

  Object.assign(el.style, {
    display: "inline-block",
    boxSizing: "border-box",
    // Comp-scale layout: fontSize/padding are comp px; 1 CSS px == 1 comp px here.
    fontFamily: String(style.fontFamily ?? ""),
    fontSize: typeof style.fontSize === "number" ? `${style.fontSize}px` : String(style.fontSize ?? ""),
    fontWeight: String(style.fontWeight ?? ""),
    fontStyle: String(style.fontStyle ?? ""),
    letterSpacing: style.letterSpacing ? String(style.letterSpacing) : "normal",
    lineHeight: style.lineHeight != null ? String(style.lineHeight) : "normal",
    padding: String(style.padding ?? "0"),
    textAlign: String(style.textAlign ?? "left"),
    whiteSpace: "pre-wrap",
    // Explicit frame → fixed width (paragraph text); else hug glyphs capped by maxWidth (point text).
    width: explicitWidthPx != null ? `${explicitWidthPx}px` : "max-content",
    maxWidth: maxWidthPx != null ? `${maxWidthPx}px` : "none"
  } satisfies Partial<CSSStyleDeclaration>);
  el.textContent = layerText(layer) || " ";

  const parent = measuringHost();
  parent.appendChild(el);
  const rect = el.getBoundingClientRect();
  parent.removeChild(el);

  const w = rect.width / comp.width;
  const h = rect.height / comp.height;
  return {
    w: Number.isFinite(w) && w > 0 ? w : 0.2,
    h: Number.isFinite(h) && h > 0 ? h : 0.1
  };
}
