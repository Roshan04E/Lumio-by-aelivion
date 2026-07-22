import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * The active editor theme, read off `.editor-page`. The modal portals to <body> (outside
 * `.editor-page`), so without this it never inherits the theme's `--nle-accent` and every dialog
 * renders in the default blue instead of the user's chosen accent. Stamping the same attribute on
 * the backdrop lets the generalized `[data-orreris-theme]` token blocks re-colour the dialog to
 * match the editor. Returns null when no theme is set (default palette).
 */
function activeEditorTheme(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  return document.querySelector(".editor-page")?.getAttribute("data-orreris-theme") ?? null;
}

export function Modal({
  title,
  open,
  children,
  className,
  onClose
}: {
  title: string;
  open: boolean;
  children: ReactNode;
  /** Extra class on the modal box itself, e.g. for a wider workspace-style dialog. */
  className?: string | undefined;
  onClose: () => void;
}) {
  if (!open || typeof document === "undefined") {
    return null;
  }

  const theme = activeEditorTheme();

  // Portal to <body> so the fixed, centred backdrop is relative to the viewport — not trapped/offset by a
  // transformed or container-query ancestor (which was pinning the asset viewer to the side panel).
  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-modal="true" {...(theme ? { "data-orreris-theme": theme } : {})}>
      <div className={className ? `modal ${className}` : "modal"}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close ui-btn ui-btn-icon" type="button" onClick={onClose} aria-label="Close" title="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
