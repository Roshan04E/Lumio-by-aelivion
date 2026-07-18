import { ChevronLeft, ChevronRight, Diamond, Trash2 } from "lucide-react";
import type { KeyframeInterpolation } from "@orreris/shared";

/**
 * Canonical keyframe control group — Previous / diamond-toggle / Next / (Clear all) — used by
 * every keyframeable row (Transform, effect params, Color/Lumetri, masks) so navigation and
 * alignment read identically everywhere a parameter can be keyframed.
 */
export interface KeyframeButtonsProps {
  active: boolean;
  hasAny: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  interpolation?: KeyframeInterpolation | undefined;
  label: string;
  onChangeInterpolation?: ((interpolation: KeyframeInterpolation) => void) | undefined;
  onClearAll: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onToggle: () => void;
}

export function KeyframeButtons({ active, hasAny, hasNext, hasPrevious, label, onClearAll, onNext, onPrevious, onToggle }: KeyframeButtonsProps) {
  return (
    <span className="keyframe-buttons" aria-label={`${label} keyframes`}>
      <button
        type="button"
        title="Previous keyframe"
        disabled={!hasPrevious}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPrevious();
        }}
      >
        <ChevronLeft size={11} />
      </button>
      <button
        className={active ? "is-active" : ""}
        type="button"
        title={active ? "Remove keyframe" : "Add keyframe"}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
      >
        <Diamond size={10} />
      </button>
      <button
        type="button"
        title="Next keyframe"
        disabled={!hasNext}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onNext();
        }}
      >
        <ChevronRight size={11} />
      </button>
      {hasAny ? (
        <button
          type="button"
          title="Clear all keyframes for this property"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClearAll();
          }}
        >
          <Trash2 size={11} />
        </button>
      ) : null}
    </span>
  );
}
