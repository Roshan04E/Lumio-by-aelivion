import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";

/**
 * Inspector card section — the right-panel equivalent of the Color tab's
 * `.lumetri-section`. Same dark card, blue active border, compact header,
 * optional reset, optional count badge, and collapsible body. Built so every
 * Inspector group (Transform, 3D Tilt, Graph Editor, …) reads as one product
 * with the Color tab without re-implementing per-panel chrome.
 */
export interface InspectorSectionProps {
  title: string;
  icon?: ReactNode;
  /** Small count badge shown on the right of the header (e.g. keyframe count). */
  count?: number;
  /** Marks the section as "active" (blue accent border + dot), e.g. has edits. */
  active?: boolean;
  /** Reset handler — renders a reset affordance in the header when provided. */
  onReset?: (() => void) | undefined;
  /** Whether the section can collapse. Default true. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function InspectorSection({
  title,
  icon,
  count,
  active = false,
  onReset,
  collapsible = true,
  defaultOpen = true,
  children
}: InspectorSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = collapsible ? open : true;

  return (
    <div className={`editor-section${active ? " editor-section--active" : ""}`}>
      <button
        className="editor-section-header"
        type="button"
        onClick={() => collapsible && setOpen((value) => !value)}
        aria-expanded={isOpen}
      >
        {collapsible ? (
          isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />
        ) : (
          <span className="editor-section-chevron-spacer" aria-hidden="true" />
        )}
        {/* The icon slot is ALWAYS rendered, empty or not. The header is a fixed grid
            (`14px auto minmax(0,1fr) repeat(3,auto)`), so omitting the element shifted every later
            child one column left — the label took the `auto` column and the "has edits" dot landed in
            the flexible one, hugging the label instead of sitting top-right with the reset control.
            Sections that pass an icon were unaffected, which is why it only showed on icon-less ones. */}
        <span className={`editor-section-icon${icon ? "" : " editor-section-icon--empty"}`}>{icon}</span>
        <span className="editor-section-label">{title}</span>
        {active ? <span className="editor-section-dot" title="Has edits" /> : null}
        {typeof count === "number" ? <span className="editor-section-count">{count}</span> : null}
        {onReset ? (
          <button
            className="editor-section-reset"
            type="button"
            title="Reset to defaults"
            onClick={(event) => {
              event.stopPropagation();
              onReset();
            }}
          >
            <RotateCcw size={11} />
          </button>
        ) : null}
      </button>
      {isOpen ? <div className="editor-section-body">{children}</div> : null}
    </div>
  );
}
