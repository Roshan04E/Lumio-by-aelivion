import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { KeyframeInterpolation } from "@kimera-by-aelivion/shared";
import { ScrubNumberInput } from "../../../components/ScrubNumberInput";
import { PropertyRow } from "./PropertyRow";

/**
 * Shared inspector number control — a DaVinci/Premiere-style full-width row that
 * renders through the PropertyRow shell (`.effect-slider-*` visual language) so
 * every inspector number reads the same: label | slider (or drag-scrub pad) | blue
 * scrub value | reset. Sliders only appear where a bounded range is natural
 * (0..100, -100..100, -180..180 — or an explicit `slider` prop); everything
 * else scrubs in realtime on the pad or the value itself, Premiere hot-text style.
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
  /** Force the slider on/off; defaults to auto (natural bounded ranges only). */
  slider?: boolean | undefined;
  onReset?: (() => void) | undefined;
  onChange: (value: number) => void;
}

/** Ranges where a slider reads naturally; anything else gets scrub-only (no fake slider). */
function isNaturalSliderRange(min: number, max: number) {
  return (min === 0 && max === 100) || (min === -100 && max === 100) || (min === -180 && max === 180);
}

/** Decimal places implied by the step, so displayed/scrubbed values stay clean. */
function stepDecimals(step: number): number {
  if (Number.isInteger(step)) return 0;
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : Math.min(6, text.length - dot - 1);
}

const SCRUB_FINE_FACTOR = 0.1;

export function NumberControl({ icon, keyframe, label, value, min, max, step, slider, onReset, onChange }: NumberControlProps) {
  const showSlider = slider ?? isNaturalSliderRange(min, max);
  const decimals = stepDecimals(step);
  const clamped = Math.min(max, Math.max(min, value));
  const percent = ((clamped - min) / Math.max(0.0001, max - min)) * 100;

  const padDragRef = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);

  const commitValue = (next: number) => {
    if (!Number.isFinite(next)) return;
    onChange(Math.min(max, Math.max(min, next)));
  };

  const handlePadPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    padDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value };
    setIsScrubbing(true);
  };

  const handlePadPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = padDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const raw = drag.startValue + dx * step * (event.shiftKey ? SCRUB_FINE_FACTOR : 1);
    const stepped = Math.round(raw / step) * step;
    commitValue(Number(stepped.toFixed(decimals)));
  };

  const handlePadPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = padDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    padDragRef.current = null;
    setIsScrubbing(false);
  };

  return (
    <PropertyRow
      className="number-row"
      icon={icon}
      keyframe={keyframe}
      label={label}
      sliderPercent={percent}
      onReset={onReset}
      control={
        showSlider ? (
          <input
            min={min}
            max={max}
            step={step}
            type="range"
            value={clamped}
            onChange={(event) => commitValue(Number(event.target.value))}
          />
        ) : (
          <div
            className={`number-row-scrubpad${isScrubbing ? " is-scrubbing" : ""}`}
            title={`Drag to adjust ${label}`}
            onPointerDown={handlePadPointerDown}
            onPointerMove={handlePadPointerMove}
            onPointerUp={handlePadPointerUp}
            onPointerCancel={handlePadPointerUp}
          />
        )
      }
      value={
        <ScrubNumberInput
          aria-label={`${label} value`}
          className="effect-slider-number"
          inputMode="decimal"
          max={max}
          min={min}
          step={step}
          value={clamped.toFixed(decimals)}
          onScrubChange={commitValue}
          onChange={(event) => commitValue(Number(event.target.value))}
          onClick={(event) => event.stopPropagation()}
        />
      }
    />
  );
}
