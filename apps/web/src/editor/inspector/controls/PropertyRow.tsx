import { RotateCcw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { KeyframeButtons, type KeyframeButtonsProps } from "./KeyframeButtons";

/**
 * The ONE inspector row shell — label (+ keyframe buttons) | control | value | reset —
 * on the shared `.effect-slider-control` grid so every property row in the product
 * (Transform numbers, effect params, Lumetri sliders, selects, toggles) sits on the
 * same 24px baseline with identical column alignment. NumberControl and
 * EffectSliderControl both render through this; new controls should too instead of
 * re-implementing the row markup.
 */
export interface PropertyRowProps {
  label: string;
  /** Tooltip; defaults to the label. */
  title?: string | undefined;
  icon?: ReactNode;
  /** Tonal track color suffix (`effect-slider-${tone}`): neutral/light/warmth/tint/… */
  tone?: string;
  /** Extra class on the row root (e.g. "number-row"). */
  className?: string | undefined;
  /** 0..100 — drives the slider track fill via `--slider-percent`. */
  sliderPercent?: number | undefined;
  keyframe?: Omit<KeyframeButtonsProps, "label"> | undefined;
  /** Middle cell: range input / scrub pad / select / any control. */
  control: ReactNode;
  /** Value cell: usually a ScrubNumberInput. Omitted → empty spacer keeps columns aligned. */
  value?: ReactNode;
  onReset?: (() => void) | undefined;
}

export function PropertyRow({
  label,
  title,
  icon,
  tone = "neutral",
  className,
  sliderPercent,
  keyframe,
  control,
  value,
  onReset
}: PropertyRowProps) {
  return (
    <label
      className={`effect-slider-control effect-slider-${tone}${className ? ` ${className}` : ""}`}
      style={sliderPercent !== undefined ? ({ "--slider-percent": `${sliderPercent}%` } as CSSProperties) : undefined}
      title={title ?? label}
    >
      <span className="effect-slider-label">
        {icon ? <span className="control-icon">{icon}</span> : null}
        <span className="effect-slider-label-text">{label}</span>
        {keyframe ? <KeyframeButtons {...keyframe} label={label} /> : null}
      </span>
      {control}
      {value ?? <span />}
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

/**
 * Multi-value row — one label, several tagged scrub fields sharing the line
 * (Premiere-style "Position  X 50  Y 50"). Each field keeps its own keyframe
 * diamond and its own reset so per-axis control stays first-class. Only the
 * diamond renders (prev/next/clear are CSS-suppressed in groups) so hover never
 * shifts the layout — navigation lives in the graph editor / timeline lane.
 */
export interface PropertyRowGroupField {
  /** Short axis tag rendered before the field, e.g. "X". */
  tag: string;
  /** The field itself — usually a ScrubNumberInput. */
  value: ReactNode;
  keyframe?: Omit<KeyframeButtonsProps, "label"> | undefined;
  /** Per-axis reset, rendered right after the field. */
  onReset?: (() => void) | undefined;
}

export function PropertyRowGroup({
  label,
  title,
  icon,
  fields,
  onReset
}: {
  label: string;
  title?: string | undefined;
  icon?: ReactNode;
  fields: PropertyRowGroupField[];
  /** Resets every field in the group (rendered as one reset button at the row end). */
  onReset?: (() => void) | undefined;
}) {
  return (
    <div className="effect-slider-control effect-slider-neutral property-row-group" title={title ?? label}>
      <span className="effect-slider-label">
        {icon ? <span className="control-icon">{icon}</span> : null}
        <span className="effect-slider-label-text">{label}</span>
      </span>
      <div className="property-row-fields">
        {fields.map((field) => (
          <span className="property-row-field" key={field.tag}>
            <span className="property-row-field-tag">{field.tag}</span>
            {field.value}
            {field.keyframe ? <KeyframeButtons {...field.keyframe} label={`${label} ${field.tag}`} /> : null}
            {field.onReset ? (
              <button
                className="property-row-field-reset"
                type="button"
                title={`Reset ${label} ${field.tag}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  field.onReset?.();
                }}
              >
                <RotateCcw size={10} />
              </button>
            ) : null}
          </span>
        ))}
        {onReset ? (
          <button
            className="effect-slider-reset"
            type="button"
            title={`Reset ${label}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onReset();
            }}
          >
            <RotateCcw size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
