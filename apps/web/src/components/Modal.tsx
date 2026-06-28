import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./Button";

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

  // Portal to <body> so the fixed, centred backdrop is relative to the viewport — not trapped/offset by a
  // transformed or container-query ancestor (which was pinning the asset viewer to the side panel).
  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className={className ? `modal ${className}` : "modal"}>
        <div className="modal-header">
          <h2>{title}</h2>
          <Button variant="ghost" icon={<X size={18} />} onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
