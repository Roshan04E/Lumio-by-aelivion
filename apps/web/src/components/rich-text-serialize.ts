/**
 * TextRun[] ↔ contentEditable DOM serialization for the rich text editor. Pure (no React) so the
 * round-trip is testable in a bare browser context. The DOM side accepts BOTH our own emitted
 * spans and the tags Chromium's execCommand produces (B/I/FONT/style spans, DIV line breaks).
 */

import { isPinnedFontRef, type FontRef, type TextRun } from "@orreris/shared";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * ADR-023 S10 — a run's `FontRef` has no native DOM representation (no CSS property, no execCommand),
 * so it travels through contentEditable the same way `data-size-mult` already carries the size
 * multiplier: a `data-*` attribute alongside a `style.fontFamily` for WYSIWYG. `encodeURIComponent`
 * rather than a raw JSON attribute — a family name is free-form text and HTML-attribute-escaping JSON
 * by hand is exactly the kind of thing that is subtly wrong once (a `"` inside a family name), not
 * always.
 */
function runToHtml(run: TextRun): string {
  const styles: string[] = [];
  if (run.bold) styles.push("font-weight:700");
  if (run.italic) styles.push("font-style:italic");
  if (run.color) styles.push(`color:${run.color}`);
  if (run.backgroundColor) styles.push(`background-color:${run.backgroundColor}`);
  // A run's OWN font: the ref wins when both are present (S10's precedence — see
  // `getCompositionRunFontRef`), and its FAMILY is the WYSIWYG family — no axis instancing at the run
  // level, so this is byte-for-byte the family `installPinnedFont` registers with no axis given.
  // A run never authors a `{ source: "system" }` ref (that case is `fontFamily` alone, no `fontRef` —
  // the two-constants rule); `isPinnedFontRef` narrows defensively rather than asserting it.
  const displayFamily = run.fontRef && isPinnedFontRef(run.fontRef) ? run.fontRef.family : run.fontFamily;
  if (displayFamily) styles.push(`font-family:${displayFamily}`);
  if (run.fontSizeMultiplier && run.fontSizeMultiplier !== 1) styles.push(`font-size:${run.fontSizeMultiplier}em`);
  const sizeAttr = run.fontSizeMultiplier && run.fontSizeMultiplier !== 1 ? ` data-size-mult="${run.fontSizeMultiplier}"` : "";
  const refAttr = run.fontRef ? ` data-font-ref="${encodeURIComponent(JSON.stringify(run.fontRef))}"` : "";
  const text = escapeHtml(run.text).replace(/\n/g, "<br>");
  return `<span style="${styles.join(";")}"${sizeAttr}${refAttr}>${text}</span>`;
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
  /** ADR-023 S10. Absent means "no run-level pin here" — distinct from `fontFamily` alone, which is
   *  the legacy/system case (see `TextRun.fontRef`'s own doc for the two-constants rule). */
  fontRef: FontRef | undefined;
  sizeMult: number;
}

/** Structural equality for two `FontRef`s (or their absence) — used only to decide run merging. */
function sameFontRef(a: FontRef | undefined, b: FontRef | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameStyle(a: TextRun, ctx: RunStyleCtx): boolean {
  return (
    Boolean(a.bold) === ctx.bold &&
    Boolean(a.italic) === ctx.italic &&
    (a.color ?? undefined) === ctx.color &&
    (a.backgroundColor ?? undefined) === ctx.backgroundColor &&
    (a.fontFamily ?? undefined) === ctx.fontFamily &&
    sameFontRef(a.fontRef, ctx.fontRef) &&
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
    ...(ctx.fontRef ? { fontRef: ctx.fontRef } : {}),
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

/**
 * ADR-023 S10 — read `data-font-ref` back. Malformed (hand-edited DOM, a future format change) reads
 * as ABSENT rather than throwing: "I could not read it" and "there was never one" get the same safe
 * answer, same as `normalizeFontRef`'s own rule one layer down for the ref's OWN shape. Not validated
 * beyond "is an object" here — `normalizeFontRef` (via `getCompositionRunFontRef`) is what actually
 * decides whether the shape survives, at READ time, same as every other `FontRef` in this codebase.
 */
function readFontRefAttr(value: string | null): FontRef | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return parsed && typeof parsed === "object" ? (parsed as FontRef) : undefined;
  } catch {
    return undefined;
  }
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
  // ADR-023 S10 — must run AFTER the style read above: a run's OWN pinned font's family (its
  // WYSIWYG `style.font-family`) and its ref travel on the SAME span, and the ref is what actually
  // decides resolution (`getCompositionRunFontRef`'s precedence) once both are present.
  const fontRef = readFontRefAttr(node.getAttribute("data-font-ref"));
  if (fontRef) next.fontRef = fontRef;
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
    walk(child, { bold: false, italic: false, color: undefined, backgroundColor: undefined, fontFamily: undefined, fontRef: undefined, sizeMult: 1 }, runs);
  }
  return runs.length ? runs : [{ text: "" }];
}

/** True when no run carries any styling — the layer keeps the simple `text`-only model. */
export function runsArePlain(runs: TextRun[]): boolean {
  return runs.every(
    (run) =>
      !run.bold && !run.italic && !run.color && !run.backgroundColor && !run.fontFamily && !run.fontRef && (run.fontSizeMultiplier ?? 1) === 1
  );
}

export function serializeRuns(runs: TextRun[]): string {
  return JSON.stringify(runs);
}
