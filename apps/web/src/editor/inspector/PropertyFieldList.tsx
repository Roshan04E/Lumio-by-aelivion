/**
 * The application's ONE schema-driven property renderer — source-agnostic.
 *
 * A `PropertyField` is a resolved property descriptor: its data `kind` (number / vec2 / boolean / enum /
 * color / text / …) ALONE decides the editor, never the object it came from. `PropertyFieldList` maps a
 * list of them onto the shared inspector controls (`NumberControl`, `PropertyRowGroup`, `BooleanControl`,
 * `SelectControl`, `ColorControl`, `PropertyRow`) — the same 24px `.effect-slider-control` grid the Edit
 * inspector's Transform/effect rows use. There is NO markup here beyond delegating to those controls.
 *
 * Any inspector becomes a consumer by writing an ADAPTER that translates its own model into
 * `PropertyField[]` (see `flarex/flarex-inspector-fields.tsx` for the node-graph adapter). Deleting that
 * adapter removes only the translation — every widget still lives in the shared controls this file drives.
 * The taxonomy is a superset of the clip-effect param schema (number/boolean/color/enum/text) plus vec2,
 * a generic control row, and a custom escape hatch for specialized data editors (curves, point lists).
 */

import type { ReactNode } from "react";
import { ScrubNumberInput } from "../../components/ScrubNumberInput";
import { EffectSliderControl, type SliderTone } from "../../components/EffectSliderControl";
import { PropertyRow, PropertyRowGroup } from "./controls/PropertyRow";
import { NumberControl, type NumberControlKeyframeProps } from "./controls/NumberControl";
import { BooleanControl } from "./controls/BooleanControl";
import { SelectControl } from "./controls/SelectControl";
import { ColorControl } from "../../components/ColorControl";
import { ThemedSelect } from "./controls/ThemedSelect";
import type { KeyframeButtonsProps } from "./controls/KeyframeButtons";

export interface SelectOption {
  value: string;
  label: string;
}

/** One axis of a vec2 row (Position X / Y). Plain keyframe diamond only — matching the grouped Transform
 *  rows, whose per-axis interpolation lives in the graph editor, not on the row. */
export interface PropertyFieldAxis {
  tag: string;
  value: number;
  defaultValue?: number | undefined;
  keyframe?: Omit<KeyframeButtonsProps, "label"> | undefined;
  onChange: (value: number) => void;
}

/** A fully-resolved property row (schema + current value + write/keyframe handlers). The adapter binds
 *  values; this file only chooses the control by `kind`. */
export type PropertyField =
  | {
      kind: "number";
      key: string;
      label: string;
      icon?: ReactNode | undefined;
      min: number;
      max: number;
      step: number;
      /** Force the slider on/off; omitted → NumberControl's natural-range heuristic. */
      slider?: boolean | undefined;
      /** Present → render the tonal always-slider `EffectSliderControl` (effect params / Lumetri look)
       *  instead of NumberControl. A generic rendering choice for numbers, not tied to any data source. */
      tone?: SliderTone | undefined;
      value: number;
      defaultValue?: number | undefined;
      /** Explicit reset handler; when omitted, reset falls back to writing `defaultValue`. */
      onReset?: (() => void) | undefined;
      keyframe?: NumberControlKeyframeProps | undefined;
      onChange: (value: number) => void;
    }
  | {
      kind: "vec2";
      key: string;
      label: string;
      icon?: ReactNode | undefined;
      axes: [PropertyFieldAxis, PropertyFieldAxis];
    }
  | {
      kind: "boolean";
      key: string;
      label: string;
      icon?: ReactNode | undefined;
      value: boolean;
      onChange: (value: boolean) => void;
    }
  | {
      kind: "enum";
      key: string;
      label: string;
      icon?: ReactNode | undefined;
      value: string;
      /** Flat option list (→ SelectControl) … */
      options?: SelectOption[] | undefined;
      /** … or grouped options (→ ThemedSelect groups on a PropertyRow). */
      groups?: Array<{ label: string; options: SelectOption[] }> | undefined;
      placeholder?: string | undefined;
      onChange: (value: string) => void;
    }
  | {
      kind: "color";
      key: string;
      label: string;
      icon?: ReactNode | undefined;
      value: string;
      /** Suggested-color swatches (optional). */
      palette?: string[] | undefined;
      onReset?: (() => void) | undefined;
      onChange: (value: string) => void;
    }
  | {
      kind: "text";
      key: string;
      label: string;
      icon?: ReactNode | undefined;
      value: string;
      placeholder?: string | undefined;
      onChange: (value: string) => void;
    }
  /** A shared PropertyRow whose control is supplied by the adapter (asset picker, grouped select, …) —
   *  still the ONE row shell, just a bespoke control cell. */
  | {
      kind: "control";
      key: string;
      label: string;
      icon?: ReactNode | undefined;
      className?: string | undefined;
      control: ReactNode;
    }
  /** A fully custom block for specialized data editors (CurveEditor, point lists) — the same escape hatch
   *  the clip-effect schema uses for its `curve`/`wheels`/`secondary` param types. */
  | { kind: "custom"; key: string; node: ReactNode };

export function PropertyFieldView({ field }: { field: PropertyField }) {
  switch (field.kind) {
    case "number": {
      const onReset = field.onReset ?? (field.defaultValue !== undefined ? () => field.onChange(field.defaultValue!) : undefined);
      // Tonal always-slider (effect params) vs the auto slider/scrub NumberControl (Transform-style rows)
      // — both shared controls; the field's `tone` picks which, never the data source.
      if (field.tone !== undefined) {
        return (
          <EffectSliderControl
            label={field.label}
            icon={field.icon}
            value={field.value}
            min={field.min}
            max={field.max}
            step={field.step}
            tone={field.tone}
            keyframe={field.keyframe}
            onReset={onReset}
            onChange={field.onChange}
          />
        );
      }
      return (
        <NumberControl
          label={field.label}
          icon={field.icon}
          value={field.value}
          min={field.min}
          max={field.max}
          step={field.step}
          slider={field.slider}
          keyframe={field.keyframe}
          onChange={field.onChange}
          onReset={onReset}
        />
      );
    }
    case "vec2":
      return (
        <PropertyRowGroup
          label={field.label}
          icon={field.icon}
          fields={field.axes.map((axis) => ({
            tag: axis.tag,
            keyframe: axis.keyframe,
            onReset: axis.defaultValue !== undefined ? () => axis.onChange(axis.defaultValue!) : undefined,
            value: (
              <ScrubNumberInput
                aria-label={`${field.label} ${axis.tag}`}
                className="effect-slider-number"
                inputMode="decimal"
                value={Number.isFinite(axis.value) ? String(Number(axis.value.toFixed(4))) : "0"}
                onScrubChange={axis.onChange}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (Number.isFinite(parsed)) axis.onChange(parsed);
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ),
          }))}
        />
      );
    case "boolean":
      return <BooleanControl label={field.label} icon={field.icon} value={field.value} onChange={field.onChange} />;
    case "enum":
      return field.groups ? (
        <PropertyRow
          label={field.label}
          icon={field.icon}
          className="select-row"
          control={
            <ThemedSelect
              ariaLabel={field.label}
              value={field.value}
              {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
              groups={field.groups}
              onChange={field.onChange}
            />
          }
        />
      ) : (
        <SelectControl
          label={field.label}
          icon={field.icon}
          value={field.value}
          options={field.options ?? []}
          onChange={field.onChange}
        />
      );
    case "color":
      return (
        <ColorControl
          label={field.label}
          icon={field.icon}
          value={field.value}
          palette={field.palette}
          onReset={field.onReset}
          onChange={field.onChange}
        />
      );
    case "text":
      return (
        <PropertyRow
          label={field.label}
          icon={field.icon}
          className="text-row"
          control={
            <input
              className="text-row-input"
              type="text"
              value={field.value}
              placeholder={field.placeholder}
              onChange={(event) => field.onChange(event.target.value)}
            />
          }
        />
      );
    case "control":
      return <PropertyRow label={field.label} icon={field.icon} className={field.className} control={field.control} />;
    case "custom":
      return <>{field.node}</>;
  }
}

/** Render a resolved schema as inspector rows — the whole public surface. */
export function PropertyFieldList({ fields }: { fields: PropertyField[] }) {
  return (
    <>
      {fields.map((field) => (
        <PropertyFieldView key={field.key} field={field} />
      ))}
    </>
  );
}
