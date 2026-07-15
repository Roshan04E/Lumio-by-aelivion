import type { ReactNode } from "react";
import { PropertyRow } from "./PropertyRow";

/**
 * Shared inspector boolean control — a switch on the PropertyRow shell, so a toggle sits on the same
 * 24px baseline and column grid as every number/select row (PropertyRow is the ONE row shell; new
 * controls render through it rather than re-implementing the markup).
 *
 * Introduced for the Frames chrome (`aspectLock`), but deliberately generic: the effect param schema
 * has a `boolean` variant that had no inspector control until now.
 */
export function BooleanControl({
  icon,
  label,
  value,
  onReset,
  onChange
}: {
  icon?: ReactNode;
  label: string;
  value: boolean;
  onReset?: (() => void) | undefined;
  onChange: (value: boolean) => void;
}) {
  return (
    <PropertyRow
      className="boolean-row"
      icon={icon}
      label={label}
      onReset={onReset}
      control={
        <button
          aria-checked={value}
          aria-label={label}
          className={`boolean-row-switch${value ? " is-on" : ""}`}
          role="switch"
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onChange(!value);
          }}
        >
          <span className="boolean-row-knob" />
        </button>
      }
      value={<span className="boolean-row-state">{value ? "On" : "Off"}</span>}
    />
  );
}
