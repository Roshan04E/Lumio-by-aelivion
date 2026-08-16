/**
 * Rich text editor for TEXT layers — authors the `TextRun[]` model the renderers already consume
 * (per-run bold / italic / color / highlight / font family / size multiplier render identically in
 * the DOM preview, the GPU scene raster, and Remotion via `getCompositionTextRunStyle`). This
 * component is web-UI-only: it never touches render code, so preview↔export parity is preserved by
 * construction.
 *
 * Mechanics: a contentEditable surface (the product is Chromium-only, so `document.execCommand`
 * is a safe, battle-tested way to get native caret/typing/undo behavior) + a compact toolbar.
 * The DOM is serialized back to `TextRun[]` on every input (rich-text-serialize.ts); when every
 * run ends up unstyled the layer keeps the simple `text`-only model (`textRuns` unset). The editor
 * is uncontrolled while typing and re-initializes only when the layer or an EXTERNAL edit (AI,
 * undo, source-text keyframe navigation) changes the runs — tracked via the last committed
 * serialization — so the caret is never clobbered mid-word. The last selection RANGE is saved on
 * every editor interaction and restored before a toolbar command runs, so portal dropdowns
 * (FontPicker, ThemedSelect) can steal focus without losing what the user selected.
 *
 * ADR-023 S10 — the font control opens the SAME catalogue picker the layer-level field uses, not a
 * bespoke five-stack dropdown. See `applyFontToSelection` for how a picked `FontRef` (which has no
 * native DOM representation) survives the round trip through contentEditable HTML.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Baseline, Bold, Highlighter, Italic, Pipette } from "lucide-react";
import { isPinnedFontRef, type TextRun } from "@orreris/shared";
import { FontPicker, type FontPickerValue } from "../editor/controls/FontPicker";
import { htmlToRuns, runsArePlain, runsToHtml, serializeRuns } from "./rich-text-serialize";

/** Bold/italic weight the toolbar's font picker asks for — the SAME cut S2.7 already pins when a
 *  layer's Bold toggle is active while a family is picked. */
const FACE_BOLD_WEIGHT = 700;
const FACE_REGULAR_WEIGHT = 400;

/** Size-multiplier step per A−/A+ press, clamped to a sane range. */
const SIZE_STEP = 0.25;
const SIZE_MIN = 0.25;
const SIZE_MAX = 4;

/** Marker-style highlight suggestions (translucent so the glyphs stay readable). */
const HIGHLIGHT_COLORS = ["#ffe14d", "#7CFC9B", "#7cc7ff"];

/** Never a real family name — the sentinel `applyFontToSelection` replaces, same idiom as
 *  `stepSize`'s `font[size="7"]`. */
const RUN_FONT_SENTINEL = "__orreris_run_font_sentinel__";

export function RichTextEditor({
  layerId,
  runs,
  palette,
  onCommit
}: {
  /** Re-initializes the surface when the edited layer changes. */
  layerId: string;
  /** Current runs (plain text arrives as one flagless run). */
  runs: TextRun[];
  /** Suggested colors (same palette the color controls use). */
  palette: string[];
  /** Fires on every input with the parsed runs (undefined when plain) + concatenated plain text. */
  onCommit: (runs: TextRun[] | undefined, plainText: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastCommittedRef = useRef<string>("");
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const highlightInputRef = useRef<HTMLInputElement | null>(null);
  /** Last selection inside the editor — restored before toolbar commands (portal menus blur it). */
  const savedRangeRef = useRef<Range | null>(null);
  // Selection-reactive toolbar state (bold/italic active at the caret).
  const [selBold, setSelBold] = useState(false);
  const [selItalic, setSelItalic] = useState(false);

  const incomingSerialized = useMemo(() => serializeRuns(runs), [runs]);

  // (Re)initialize the surface from the model — on layer switch, or when an EXTERNAL edit changed
  // the runs (undo, AI, keyframe navigation). Our own commits update lastCommittedRef first, so
  // typing never re-inits.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (incomingSerialized === lastCommittedRef.current) return;
    editor.innerHTML = runsToHtml(runs);
    lastCommittedRef.current = incomingSerialized;
    savedRangeRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerId, incomingSerialized]);

  function commit() {
    const editor = editorRef.current;
    if (!editor) return;
    const parsed = htmlToRuns(editor);
    const plain = parsed.map((run) => run.text).join("");
    lastCommittedRef.current = serializeRuns(parsed);
    onCommit(runsArePlain(parsed) ? undefined : parsed, plain);
  }

  function saveSelection() {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) savedRangeRef.current = range.cloneRange();
    refreshSelectionState();
  }

  /** Ensure the editor holds the user's last selection (restores it after a portal menu blur). */
  function restoreSelection(): boolean {
    const editor = editorRef.current;
    if (!editor) return false;
    const selection = window.getSelection();
    if (selection && selection.anchorNode && editor.contains(selection.anchorNode)) return true;
    if (savedRangeRef.current) {
      editor.focus();
      selection?.removeAllRanges();
      selection?.addRange(savedRangeRef.current);
      return true;
    }
    editor.focus();
    return false;
  }

  /** Run an editing command against the current (or restored) selection. */
  function exec(command: string, value?: string) {
    if (!editorRef.current) return;
    restoreSelection();
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(command, false, value);
    commit();
    saveSelection();
  }

  function refreshSelectionState() {
    try {
      setSelBold(document.queryCommandState("bold"));
      setSelItalic(document.queryCommandState("italic"));
    } catch {
      /* selection outside an editable region */
    }
  }

  /** Step the size multiplier of the selection: fontSize sentinel → data-size-mult spans. */
  function stepSize(direction: -1 | 1) {
    const editor = editorRef.current;
    if (!editor) return;
    restoreSelection();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !editor.contains(selection.anchorNode)) return;
    // Read the CURRENT multiplier at the selection start (nearest data-size-mult ancestor).
    let mult = 1;
    let node: Node | null = selection.anchorNode;
    while (node && node !== editor) {
      if (node instanceof HTMLElement) {
        const value = Number(node.getAttribute("data-size-mult"));
        if (Number.isFinite(value) && value > 0) {
          mult = value;
          break;
        }
      }
      node = node.parentNode;
    }
    const next = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round((mult + direction * SIZE_STEP) * 100) / 100));
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("fontSize", false, "7"); // sentinel — replaced below, never persists
    for (const font of Array.from(editor.querySelectorAll('font[size="7"]'))) {
      const span = document.createElement("span");
      if (next !== 1) {
        span.setAttribute("data-size-mult", String(next));
        span.style.fontSize = `${next}em`;
      }
      while (font.firstChild) span.appendChild(font.firstChild);
      font.replaceWith(span);
    }
    commit();
    saveSelection();
  }

  /**
   * ADR-023 S10 — apply a picked font (pinned or system) to the selection.
   *
   * Same sentinel-then-replace shape as `stepSize` above, for the same reason: `execCommand` already
   * knows how to wrap (and correctly SPLIT, across existing formatting elements) exactly the selected
   * range — reimplementing that with the Range API is where rich-text editors go to die. The sentinel
   * (`RUN_FONT_SENTINEL`) is never a real family name, so the replace below cannot collide with a
   * user's own font-name pick landing mid-flight.
   *
   * A `FontRef` has no native DOM representation (no CSS property, no execCommand), so it travels as
   * a `data-font-ref` attribute — exactly how `data-size-mult` already carries the size multiplier
   * past the DOM round trip. `rich-text-serialize.ts` reads it back on the next `commit()`.
   */
  function applyFontToSelection(next: FontPickerValue) {
    const editor = editorRef.current;
    if (!editor) return;
    restoreSelection();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !editor.contains(selection.anchorNode)) return;
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("fontName", false, RUN_FONT_SENTINEL);
    // The WYSIWYG family while editing: the ref's own family for a pinned pick (no axis instancing at
    // the run level — `getCompositionTextRunStyle`'s doc), or the raw CSS stack for a system pick.
    // FontPicker never hands back a `{ source: "system" }` ref (that pick clears `fontRef` and sets
    // `fontFamily` instead), so this narrows defensively rather than asserting it.
    const displayFamily = next.fontRef && isPinnedFontRef(next.fontRef) ? next.fontRef.family : next.fontFamily;
    for (const font of Array.from(editor.querySelectorAll(`font[face="${RUN_FONT_SENTINEL}"]`))) {
      const span = document.createElement("span");
      span.style.fontFamily = displayFamily;
      if (next.fontRef) span.setAttribute("data-font-ref", encodeURIComponent(JSON.stringify(next.fontRef)));
      while (font.firstChild) span.appendChild(font.firstChild);
      font.replaceWith(span);
    }
    commit();
    saveSelection();
  }

  return (
    <div className="rich-text-control">
      <div className="rich-text-toolbar" onMouseDown={(event) => event.preventDefault() /* keep the text selection */}>
        <button type="button" className={selBold ? "is-active" : ""} title="Bold selection" onClick={() => exec("bold")}>
          <Bold size={12} />
        </button>
        <button type="button" className={selItalic ? "is-active" : ""} title="Italic selection" onClick={() => exec("italic")}>
          <Italic size={12} />
        </button>
        <button type="button" title="Smaller (selection)" onClick={() => stepSize(-1)}>
          <span className="rich-text-size-glyph">A−</span>
        </button>
        <button type="button" title="Larger (selection)" onClick={() => stepSize(1)}>
          <span className="rich-text-size-glyph">A+</span>
        </button>
        <span className="rich-text-toolbar-sep" />
        {palette.slice(0, 3).map((color) => (
          <button
            key={color}
            type="button"
            className="rich-text-swatch"
            style={{ background: color }}
            title={`Color selection ${color}`}
            onClick={() => exec("foreColor", color)}
          />
        ))}
        <button type="button" title="Pick a text color" onClick={() => colorInputRef.current?.click()}>
          <Pipette size={11} />
        </button>
        <input
          ref={colorInputRef}
          type="color"
          style={{ position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" }}
          onChange={(event) => exec("foreColor", event.target.value)}
        />
        <span className="rich-text-toolbar-sep" />
        {HIGHLIGHT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="rich-text-swatch is-highlight"
            style={{ background: color }}
            title={`Highlight selection ${color}`}
            onClick={() => exec("hiliteColor", color)}
          />
        ))}
        <button type="button" title="Pick a highlight color" onClick={() => highlightInputRef.current?.click()}>
          <Highlighter size={11} />
        </button>
        <button type="button" title="Remove highlight" onClick={() => exec("hiliteColor", "transparent")}>
          <span className="rich-text-size-glyph">⌀</span>
        </button>
        <input
          ref={highlightInputRef}
          type="color"
          style={{ position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" }}
          onChange={(event) => exec("hiliteColor", event.target.value)}
        />
        {/* ADR-023 S10 — the SAME catalogue picker the layer-level font field uses (FontPicker.tsx),
            not a bespoke five-stack dropdown. `value` is action-only (this control has no single
            "current selection's font" to show — a selection can span several), so `fontFamily: "Aa"`
            is cosmetic label text, matching the placeholder the old dropdown showed. `weight`/`italic`
            come from the SELECTION's live state, so picking a family while Bold is active pins that
            family's bold cut immediately, the same S2.7 rule the layer field already follows. */}
        <FontPicker
          value={{ fontFamily: "Aa", fontRef: undefined, weight: selBold ? FACE_BOLD_WEIGHT : FACE_REGULAR_WEIGHT, italic: selItalic }}
          resolved={{ label: "Aa", missing: false }}
          onPick={applyFontToSelection}
        />
        <span className="rich-text-toolbar-hint" title="Select text, then style it — per-word styles render in preview and export">
          <Baseline size={11} />
        </span>
      </div>
      <div
        ref={editorRef}
        className="rich-text-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Text content"
        spellCheck={false}
        onInput={commit}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        onFocus={refreshSelectionState}
        onBlur={saveSelection}
        onKeyDown={(event) => {
          // Keep global editor shortcuts (space = play, delete clip, etc.) out of typing.
          event.stopPropagation();
        }}
        onPaste={(event) => {
          // Paste as PLAIN text — external HTML would smuggle arbitrary styles/markup past the
          // run model (only our own tags round-trip through the parser).
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (text) document.execCommand("insertText", false, text);
        }}
      />
    </div>
  );
}
