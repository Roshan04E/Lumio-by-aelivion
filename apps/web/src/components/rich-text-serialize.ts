/**
 * TextRun[] ↔ contentEditable DOM serialization for the rich text editor. Pure (no React) so the
 * round-trip is testable in a bare browser context. The DOM side accepts BOTH our own emitted
 * spans and the tags Chromium's execCommand produces (B/I/FONT/style spans, DIV line breaks).
 */

import type { TextRun } from "@orreris/shared";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function runToHtml(run: TextRun): string {
  const styles: string[] = [];
  if (run.bold) styles.push("font-weight:700");
  if (run.italic) styles.push("font-style:italic");
  if (run.color) styles.push(`color:${run.color}`);
  if (run.backgroundColor) styles.push(`background-color:${run.backgroundColor}`);
  if (run.fontFamily) styles.push(`font-family:${run.fontFamily}`);
  if (run.fontSizeMultiplier && run.fontSizeMultiplier !== 1) styles.push(`font-size:${run.fontSizeMultiplier}em`);
  const sizeAttr = run.fontSizeMultiplier && run.fontSizeMultiplier !== 1 ? ` data-size-mult="${run.fontSizeMultiplier}"` : "";
  const text = escapeHtml(run.text).replace(/\n/g, "<br>");
  return `<span style="${styles.join(";")}"${sizeAttr}>${text}</span>`;
}

export function runsToHtml(runs: TextRun[]): string {
  return runs.map(runToHtml).join("") || "<br>";
}

interface RunStyleCtx {
  bold: boolean;
  italic: boolean;
  color: string | undefined;
  backgroundColor: string | undefined;
  fontFamily: string | undefined;
  sizeMult: number;
}

function sameStyle(a: TextRun, ctx: RunStyleCtx): boolean {
  return (
    Boolean(a.bold) === ctx.bold &&
    Boolean(a.italic) === ctx.italic &&
    (a.color ?? undefined) === ctx.color &&
    (a.backgroundColor ?? undefined) === ctx.backgroundColor &&
    (a.fontFamily ?? undefined) === ctx.fontFamily &&
    (a.fontSizeMultiplier ?? 1) === ctx.sizeMult
  );
}

function appendText(runs: TextRun[], text: string, ctx: RunStyleCtx): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && sameStyle(last, ctx)) {
    last.text += text;
    return;
  }
  runs.push({
    text,
    ...(ctx.bold ? { bold: true } : {}),
    ...(ctx.italic ? { italic: true } : {}),
    ...(ctx.color ? { color: ctx.color } : {}),
    ...(ctx.backgroundColor ? { backgroundColor: ctx.backgroundColor } : {}),
    ...(ctx.fontFamily ? { fontFamily: ctx.fontFamily } : {}),
    ...(ctx.sizeMult !== 1 ? { fontSizeMultiplier: ctx.sizeMult } : {})
  });
}

/** Normalize a CSS/legacy color (empty/inherit → undefined; value kept as-authored). */
function normColor(value: string | null | undefined): string | undefined {
  const v = (value ?? "").trim();
  if (!v || v === "inherit" || v === "initial" || v === "transparent" || v === "rgba(0, 0, 0, 0)") return undefined;
  return v;
}

/** Chromium rewrites font-family single quotes to double quotes — normalize back so a round-trip
 *  never changes run identity (the model and `renderSafeFonts` use single quotes). */
function normFontFamily(value: string | null | undefined): string | undefined {
  const v = (value ?? "").trim();
  return v ? v.replace(/"/g, "'") : undefined;
}

function walk(node: Node, ctx: RunStyleCtx, runs: TextRun[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    // NBSPs come from execCommand spacing; the run model stores plain spaces.
    appendText(runs, (node.textContent ?? "").replace(/ /g, " "), ctx);
    return;
  }
  if (!(node instanceof HTMLElement)) return;

  const tag = node.tagName;
  if (tag === "BR") {
    appendText(runs, "\n", ctx);
    return;
  }

  const next: RunStyleCtx = { ...ctx };
  if (tag === "B" || tag === "STRONG") next.bold = true;
  if (tag === "I" || tag === "EM") next.italic = true;
  if (tag === "FONT") {
    const color = normColor(node.getAttribute("color"));
    if (color) next.color = color;
    const face = normFontFamily(node.getAttribute("face"));
    if (face) next.fontFamily = face;
  }
  const style = node.style;
  if (style) {
    const weight = style.fontWeight;
    if (weight === "bold" || Number(weight) >= 600) next.bold = true;
    else if (weight === "normal" || (weight && Number(weight) > 0 && Number(weight) < 600)) next.bold = false;
    if (style.fontStyle === "italic") next.italic = true;
    else if (style.fontStyle === "normal") next.italic = false;
    const color = normColor(style.color);
    if (color) next.color = color;
    const backgroundColor = normColor(style.backgroundColor);
    if (backgroundColor) next.backgroundColor = backgroundColor;
    else if (style.backgroundColor) next.backgroundColor = undefined; // explicit transparent clears the highlight
    const family = normFontFamily(style.fontFamily);
    if (family) next.fontFamily = family;
  }
  const sizeMult = Number(node.getAttribute("data-size-mult"));
  if (Number.isFinite(sizeMult) && sizeMult > 0) next.sizeMult = sizeMult;

  // Block elements (Chrome's Enter inserts DIVs) act as a line break BEFORE their content —
  // except the very first block, which starts the text.
  const isBlock = tag === "DIV" || tag === "P";
  if (isBlock && runs.some((run) => run.text.length > 0)) appendText(runs, "\n", ctx);

  for (const child of Array.from(node.childNodes)) walk(child, next, runs);
}

export function htmlToRuns(root: HTMLElement): TextRun[] {
  const runs: TextRun[] = [];
  for (const child of Array.from(root.childNodes)) {
    walk(child, { bold: false, italic: false, color: undefined, backgroundColor: undefined, fontFamily: undefined, sizeMult: 1 }, runs);
  }
  return runs.length ? runs : [{ text: "" }];
}

/** True when no run carries any styling — the layer keeps the simple `text`-only model. */
export function runsArePlain(runs: TextRun[]): boolean {
  return runs.every(
    (run) => !run.bold && !run.italic && !run.color && !run.backgroundColor && !run.fontFamily && (run.fontSizeMultiplier ?? 1) === 1
  );
}

export function serializeRuns(runs: TextRun[]): string {
  return JSON.stringify(runs);
}
