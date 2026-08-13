/**
 * ADR-023 S2.5 — the font picker. The half of S2 a user can point at.
 *
 * Replaces the five-item `renderSafeFonts` dropdown. That list was five because five was what the
 * export box was known to have installed; S2 removed the reason for the ceiling by pinning bytes, and
 * this is where the ceiling actually comes down.
 *
 * TWO GROUPS, and the split is D1a made visible rather than a categorisation:
 *
 *  - **Pinned** — catalogue faces. Picking one writes a `catalogue` `FontRef` carrying a `fileHash`,
 *    which is the single write the entire S2 contract hangs off: the manifest pins bytes, the mirror
 *    serves them, the worker installs them or aborts by name. A picker that wrote `fontFamily:
 *    "Anton"` would look identical in the editor and leave every S2 obligation unreachable.
 *  - **System** — the legacy CSS stacks, unchanged and still selectable. Choosing one clears the ref
 *    back to `{ source: "system" }`. Nothing is migrated, nothing is remapped, and a project that
 *    never opens this control never moves (D1a).
 *
 * Each row is set in its OWN face, loaded from the catalogue (`font-catalogue-preview`). A row whose
 * preview has not loaded says so instead of falling back to the UI font and implying that is what you
 * would get — the empty-`warpFontCatalog` incident is the precedent, and T-17 is the rule.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, Type } from "lucide-react";
import { catalogueFontRef, fontCatalogue, renderSafeFonts, type FontRef } from "@orreris/shared";
import {
  cataloguePreviewVersion,
  isPreviewLoaded,
  loadCataloguePreviews,
  previewFamily,
  subscribeCataloguePreviews
} from "../../lib/font-catalogue-preview";

export interface FontPickerValue {
  /** The layer's CSS stack — what a system pick sets and what a legacy layer already has. */
  fontFamily: string;
  /** The layer's pinned ref, if it has one. */
  fontRef: FontRef | undefined;
}

/** The sample every row is set in. Short enough to fit, long enough to show a typeface's character. */
const SAMPLE = "Ag";

export function FontPicker({
  value,
  onPick,
  onReset
}: {
  value: FontPickerValue;
  /** Called with the COMPLETE font identity — both fields, always, so neither can be left stale. */
  onPick: (next: FontPickerValue) => void;
  onReset?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    loadCataloguePreviews();
  }, []);
  useSyncExternalStore(subscribeCataloguePreviews, cataloguePreviewVersion, cataloguePreviewVersion);

  // Close on outside click / Escape. A popup that traps the user is worse than a select.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pinned = value.fontRef && value.fontRef.source !== "system" ? value.fontRef : undefined;
  const currentLabel = pinned
    ? `${pinned.family}${pinned.weight >= 600 ? " Bold" : ""}`
    : (renderSafeFonts.find((font) => font.family === value.fontFamily)?.label ?? value.fontFamily);

  return (
    <div className="font-picker" ref={rootRef}>
      <button
        type="button"
        className="font-picker-trigger"
        data-testid="font-picker-trigger"
        title="Font"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="control-icon">
          <Type size={14} />
        </span>
        <span className="font-picker-current">{currentLabel}</span>
        {pinned ? <span className="font-picker-pin" title="Pinned to a specific font file">pinned</span> : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {onReset ? (
        <button type="button" className="font-picker-reset" title="Reset font" onClick={onReset}>
          ⟲
        </button>
      ) : null}

      {open ? (
        <div className="font-picker-menu" role="listbox" data-testid="font-picker-menu">
          <div className="font-picker-group">Pinned — renders identically everywhere</div>
          {fontCatalogue.map((entry) =>
            entry.faces.map((face) => {
              const ready = isPreviewLoaded(entry.family, face);
              const selected = pinned?.fileHash === face.fileHash;
              return (
                <button
                  key={face.fileHash}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`font-picker-option ${selected ? "is-selected" : ""}`}
                  data-testid={`font-option-${entry.family}-${face.weight}`}
                  data-font-family={entry.family}
                  onClick={() => {
                    const ref = catalogueFontRef(entry.family, face.weight, face.style);
                    if (!ref) return;
                    // Both fields, together. `fontFamily` is not what renders for a pinned ref
                    // (`fontRefCss` ignores it) but leaving it stale would make the layer describe
                    // itself two different ways, and the next reader would have to know which wins.
                    onPick({ fontFamily: entry.family, fontRef: ref });
                    setOpen(false);
                  }}
                >
                  <span
                    className="font-picker-sample"
                    // The row set in its own face. `ready` gates it: an unloaded face must NOT be
                    // drawn in the UI font as though it were the real thing (T-17).
                    style={ready ? { fontFamily: `'${previewFamily(entry.family)}'`, fontWeight: face.weight } : undefined}
                    data-preview-ready={ready ? "true" : "false"}
                  >
                    {ready ? SAMPLE : "…"}
                  </span>
                  <span className="font-picker-name">
                    {entry.family}
                    {face.weight >= 600 ? " Bold" : ""}
                  </span>
                  <span className="font-picker-meta">{ready ? entry.category : "unavailable"}</span>
                  {selected ? <Check size={13} aria-hidden="true" /> : null}
                </button>
              );
            })
          )}

          <div className="font-picker-group">System — resolves on the render machine</div>
          {renderSafeFonts.map((font) => {
            const selected = !pinned && value.fontFamily === font.family;
            return (
              <button
                key={font.family}
                type="button"
                role="option"
                aria-selected={selected}
                className={`font-picker-option ${selected ? "is-selected" : ""}`}
                data-testid={`font-option-system-${font.label}`}
                onClick={() => {
                  // Back to legacy, explicitly. `undefined` rather than a `{source:"system"}` object
                  // so the layer returns to having no ref at all — the state D1a calls "authored
                  // before this existed", which is the one a legacy project must be able to reach.
                  onPick({ fontFamily: font.family, fontRef: undefined });
                  setOpen(false);
                }}
              >
                <span className="font-picker-sample" style={{ fontFamily: font.family }}>
                  {SAMPLE}
                </span>
                <span className="font-picker-name">{font.label}</span>
                <span className="font-picker-meta">system</span>
                {selected ? <Check size={13} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
