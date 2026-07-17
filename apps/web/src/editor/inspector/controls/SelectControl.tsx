import type { ReactNode } from "react";
import { PropertyRow } from "./PropertyRow";
import { ThemedSelect } from "./ThemedSelect";

/**
 * Shared inspector select control — a ThemedSelect on the PropertyRow shell, so an enum param sits on
 * the same 24px baseline and column grid as every number/boolean/color row (PropertyRow is the ONE row
 * shell; new controls render through it rather than re-implementing the markup).
 *
 * Introduced for the Frames torn-paper `edges` param, but deliberately generic: the effect param schema
 * has a `select` variant that had no shared inspector control until now.
 */
export function SelectControl({
  icon,
  label,
  value,
  options,
  onReset,
  onChange
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  onReset?: (() => void) | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <PropertyRow
      className="select-row"
      icon={icon}
      label={label}
      onReset={onReset}
      control={<ThemedSelect ariaLabel={label} value={value} options={options} onChange={onChange} />}
    />
  );
}
