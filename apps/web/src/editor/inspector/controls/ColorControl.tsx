import type { ReactNode } from "react";
import { PropertyRow } from "./PropertyRow";

/**
 * Shared inspector color control — a swatch on the PropertyRow shell, so a color picker sits on the same
 * 24px baseline and column grid as every number/select/boolean row (PropertyRow is the ONE row shell; new
 * controls render through it rather than re-implementing the markup).
 *
 * Introduced for the Frames border chrome (`borderColor`), but deliberately generic: the effect param
 * schema has a `color` variant that had no shared inspector control until now.
 */
export function ColorControl({
  icon,
  label,
  value,
  onReset,
  onChange
}: {
  icon?: ReactNode;
  label: string;
  /** Hex color (#rrggbb) — the native color input's value space. */
  value: string;
  onReset?: (() => void) | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <PropertyRow
      className="color-row"
      icon={icon}
      label={label}
      onReset={onReset}
      control={
        <input
          aria-label={label}
          className="color-row-input"
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      }
      value={<code className="color-row-hex">{value}</code>}
    />
  );
}
