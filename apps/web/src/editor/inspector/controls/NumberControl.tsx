import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Diamond, Trash2 } from "lucide-react";
import type { KeyframeInterpolation } from "@reelforge/shared";
import { ResetButton } from "../../../components/ResetButton";

/**
 * Shared inspector number control (relocated from EditorPage in Phase 4 of the
 * editor refactor). Presentational: a labelled numeric input with optional reset
 * and keyframe scrubbing buttons. Reused by every inspector panel, so it lives
 * outside the monolith as a reusable primitive.
 */
export interface NumberControlKeyframeProps {
  active: boolean;
  hasAny: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  interpolation?: KeyframeInterpolation | undefined;
  onChangeInterpolation: (interpolation: KeyframeInterpolation) => void;
  onClearAll: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onToggle: () => void;
}

export interface NumberControlProps {
  icon?: ReactNode;
  keyframe?: NumberControlKeyframeProps | undefined;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onReset?: (() => void) | undefined;
  onChange: (value: number) => void;
}

export function NumberControl({ icon, keyframe, label, value, min, max, step, onReset, onChange }: NumberControlProps) {
  return (
    <label className={`number-control ${keyframe ? "is-keyframable" : ""}`} title={label}>
      <span>
        <span className="number-control-label">
          <span className="control-icon">{icon ?? label}</span>
          <small>{label}</small>
        </span>
        {onReset ? <ResetButton onReset={onReset} /> : null}
        {keyframe ? (
          <span className="keyframe-buttons" aria-label={`${label} keyframes`}>
            <button
              type="button"
              title="Previous keyframe"
              disabled={!keyframe.hasPrevious}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                keyframe.onPrevious();
              }}
            >
              <ChevronLeft size={11} />
            </button>
            <button
              className={keyframe.active ? "is-active" : ""}
              type="button"
              title={keyframe.active ? "Remove keyframe" : "Add keyframe"}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                keyframe.onToggle();
              }}
            >
              <Diamond size={10} />
            </button>
            <button
              type="button"
              title="Next keyframe"
              disabled={!keyframe.hasNext}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                keyframe.onNext();
              }}
            >
              <ChevronRight size={11} />
            </button>
            {keyframe.hasAny ? (
              <button
                type="button"
                title="Clear all keyframes for this property"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  keyframe.onClearAll();
                }}
              >
                <Trash2 size={11} />
              </button>
            ) : null}
          </span>
        ) : null}
      </span>
      <input min={min} max={max} step={step} type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
