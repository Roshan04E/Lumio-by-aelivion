/**
 * Shared tone-colored effect slider — label (with optional keyframe diamond) + range
 * + numeric field + reset, rendered through the PropertyRow shell so it stays
 * pixel-identical with the Transform/Text/Shape number rows. Used by the
 * Controls-tab effect cards and the Color-tab Lumetri panel with the same tonal
 * track colors (warmth/tint/saturation/shadow/highlight/light/neutral) defined
 * in global.css.
 */

import { clamp } from "../editor/inspector/keyframeUtils";
import type { KeyframeButtonsProps } from "../editor/inspector/controls/KeyframeButtons";
import { PropertyRow } from "../editor/inspector/controls/PropertyRow";
import { formatEffectValue, type SliderTone } from "./effectSliderTone";
import { ScrubNumberInput } from "./ScrubNumberInput";

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
  keyframe?: Omit<KeyframeButtonsProps, "label"> | undefined;
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
    <PropertyRow
      keyframe={keyframe}
      label={label}
      sliderPercent={percent}
      tone={tone}
      onReset={onReset}
      control={
        <input min={min} max={max} step={step} type="range" value={safeValue} onChange={(event) => commitValue(Number(event.target.value))} />
      }
      value={
        <ScrubNumberInput
          aria-label={`${label} value`}
          className="effect-slider-number"
          inputMode="decimal"
          max={max}
          min={min}
          step={step}
          value={formatEffectValue(value, step)}
          onScrubChange={commitValue}
          onChange={(event) => commitValue(Number(event.target.value))}
          onClick={(event) => event.stopPropagation()}
        />
      }
    />
  );
}
