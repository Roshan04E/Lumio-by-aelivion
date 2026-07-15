/**
 * Text Styles (§2) — a reusable-asset panel in the Text tab: a list of saved text looks with
 * Save / Apply / Update / Rename / Delete. One-shot: Apply BAKES the style's fields onto the
 * selected text layer(s) (EditorPage routes the mutation, mirroring Align's multi-select rules —
 * 1 text layer → apply; N → all in one undo; mixed → text only).
 *
 * The layout is deliberately shaped as a reusable asset browser so future additions (search,
 * favourites, categories, brand imports, linked styles) drop in without a redesign — see
 * GRAPHICS_TAB.md §2. Only local VIEW state here (which row is highlighted, the rename buffer);
 * the styles themselves live in ProjectGraph.
 */

import { useEffect, useState } from "react";
import { Check, Pencil, Plus, RefreshCw, Trash2, Type } from "lucide-react";
import type { TextStyle } from "@kimera-by-aelivion/shared";
import { InspectorSection } from "./InspectorSection";

export function TextStylesSection({
  styles,
  onSave,
  onApply,
  onUpdate,
  onRename,
  onDelete
}: {
  styles: TextStyle[];
  onSave: () => void;
  onApply: (style: TextStyle) => void;
  onUpdate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Keep the highlighted row valid as the list changes (delete/undo); default to the newest.
  useEffect(() => {
    if (selectedId && !styles.some((style) => style.id === selectedId)) setSelectedId(null);
  }, [styles, selectedId]);

  const selected = styles.find((style) => style.id === selectedId) ?? null;

  return (
    <InspectorSection title="Text Styles" icon={<Type size={13} />} count={styles.length} defaultOpen={false}>
      <div className="text-styles">
        <button type="button" className="text-styles-save" onClick={onSave}>
          <Plus size={13} /> Save Style
        </button>

        {styles.length ? (
          <div className="text-styles-list" role="listbox" aria-label="Saved text styles">
            {styles.map((style) => {
              const active = style.id === selectedId;
              return (
                <div
                  key={style.id}
                  role="option"
                  aria-selected={active}
                  className={`text-styles-row${active ? " is-selected" : ""}`}
                  onClick={() => setSelectedId(style.id)}
                  onDoubleClick={() => setRenamingId(style.id)}
                >
                  {renamingId === style.id ? (
                    <input
                      autoFocus
                      className="text-styles-rename"
                      defaultValue={style.name}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) => {
                        const name = event.target.value.trim();
                        if (name && name !== style.name) onRename(style.id, name);
                        setRenamingId(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <span className="text-styles-name" title={style.name}>{style.name}</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-styles-empty">No saved styles yet. Save the current text's look to reuse it.</p>
        )}

        <div className="text-styles-actions">
          <button type="button" disabled={!selected} title="Apply to selected text" onClick={() => selected && onApply(selected)}>
            <Check size={13} /> Apply
          </button>
          <button type="button" disabled={!selected} title="Update this style from the current text" onClick={() => selected && onUpdate(selected.id)}>
            <RefreshCw size={13} /> Update
          </button>
          <button type="button" disabled={!selected} title="Rename this style" onClick={() => selected && setRenamingId(selected.id)}>
            <Pencil size={13} /> Rename
          </button>
          <button type="button" className="text-styles-danger" disabled={!selected} title="Delete this style" onClick={() => selected && onDelete(selected.id)}>
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    </InspectorSection>
  );
}
