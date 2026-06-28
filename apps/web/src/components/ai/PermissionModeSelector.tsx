import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { PERMISSION_MODES } from "../../ai/permission";
import type { PermissionMode } from "../../ai/types";

/**
 * Permission mode switch (P4). Quick / Professional / Agent / Talk — controls how
 * much the AI applies before asking (Talk never edits; it just converses). Rendered
 * as a compact dropdown so it doesn't crowd the composer. Selection is remembered (P6).
 */
export function PermissionModeSelector({
  mode,
  onChange,
  disabled
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = PERMISSION_MODES.find((info) => info.id === mode) ?? PERMISSION_MODES[0]!;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="ai-mode-dropdown" ref={rootRef}>
      <button
        type="button"
        className="ai-mode-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title={active.description}
      >
        <span>{active.label}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <ul className="ai-mode-menu" role="listbox" aria-label="AI permission mode">
          {PERMISSION_MODES.map((info) => (
            <li key={info.id}>
              <button
                type="button"
                role="option"
                aria-selected={mode === info.id}
                className={`ai-mode-option${mode === info.id ? " is-active" : ""}`}
                onClick={() => {
                  onChange(info.id);
                  setOpen(false);
                }}
              >
                <span className="ai-mode-option-label">{info.label}</span>
                <span className="ai-mode-option-desc">{info.description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
