/**
 * Shared tone-colored effect slider — label (with optional keyframe diamond) + range
 * + numeric field + reset. Used by the Controls-tab effect cards and the Color-tab
 * Lumetri panel so both render pixel-identical sliders with the same tonal track colors
 * (warmth/tint/saturation/shadow/highlight/light/neutral) defined in global.css.
 */

import { Diamond, RotateCcw } from "lucide-react";
import type { CSSProperties } from "react";
import type { KeyframeInterpolation } from "@lumio-by-aelivion/shared";
import { clamp } from "../editor/inspector/keyframeUtils";
import { formatEffectValue, type SliderTone } from "./effectSliderTone";

export type { SliderTone };

export function EffectSliderControl({
  keyframe,
  label,
  value,
  min,
  max,
  step,
  tone = "neutral",
  onReset,
  onChange
}: {
  keyframe?:
    | {
        active: boolean;
        interpolation?: KeyframeInterpolation | undefined;
        onChangeInterpolation: (interpolation: KeyframeInterpolation) => void;
        onToggle: () => void;
      }
    | undefined;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  tone?: SliderTone;
  onReset?: (() => void) | undefined;
  onChange: (value: number) => void;
}) {
  const percent = ((clamp(value, min, max) - min) / Math.max(1, max - min)) * 100;
  const safeValue = clamp(value, min, max);
  const commitValue = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) {
      return;
    }
    onChange(clamp(nextValue, min, max));
  };

  return (
    <label
      className={`effect-slider-control effect-slider-${tone}`}
      style={{ "--slider-percent": `${percent}%` } as CSSProperties}
      title={label}
    >
      <span className="effect-slider-label">
        <span className="effect-slider-label-text">{label}</span>
        {keyframe ? (
          <button
            className={`effect-keyframe-button ${keyframe.active ? "is-active" : ""}`}
            type="button"
            title={keyframe.active ? "Remove keyframe" : "Add keyframe"}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              keyframe.onToggle();
            }}
          >
            <Diamond size={9} />
          </button>
        ) : null}
      </span>
      <input min={min} max={max} step={step} type="range" value={safeValue} onChange={(event) => commitValue(Number(event.target.value))} />
      <input
        aria-label={`${label} value`}
        className="effect-slider-number"
        inputMode="decimal"
        max={max}
        min={min}
        step={step}
        type="number"
        value={formatEffectValue(value, step)}
        onChange={(event) => commitValue(Number(event.target.value))}
        onClick={(event) => event.stopPropagation()}
      />
      {onReset ? (
        <button
          className="effect-slider-reset"
          type="button"
          title="Reset"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onReset();
          }}
        >
          <RotateCcw size={12} />
        </button>
      ) : (
        <span />
      )}
    </label>
  );
}
