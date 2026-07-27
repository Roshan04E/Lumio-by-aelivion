import { useRef, useState, type ReactNode } from "react";
import { Pipette } from "lucide-react";
import { pickColorFromScreen, toInputColor } from "../lib/colorPalette";
import { ResetButton } from "./ResetButton";

/**
 * The application's ONE canonical color picker (preview + hex + screen eyedropper + palette swatches +
 * reset). Consumed directly by tool panels / graphics, and through `PropertyField.color` by every
 * schema-driven inspector (clip effects, Flarex nodes, Frames chrome). `icon` and `palette` are optional
 * so a bare inspector row (no suggested colors) uses the same widget as a rich tool-panel picker.
 */
export function ColorControl({
  icon,
  label,
  palette = [],
  value,
  onReset,
  onChange
}: {
  icon?: ReactNode | undefined;
  label: string;
  palette?: string[] | undefined;
  value: string;
  onReset?: (() => void) | undefined;
  onChange: (value: string) => void;
}) {
  const [isPicking, setIsPicking] = useState(false);
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const normalizedValue = toInputColor(value);

  async function pickFromScreen() {
    if (isPicking) {
      return;
    }

    setIsPicking(true);
    try {
      const picked = await pickColorFromScreen();
      if (picked) {
        onChange(picked);
      } else {
        // No screen picker available (e.g. insecure context) — open the basic picker.
        colorInputRef.current?.click();
      }
    } finally {
      setIsPicking(false);
    }
  }

  return (
    <div className="color-control" title={label}>
      <span aria-hidden="true">
        <span className="control-icon">{icon}</span>
        {onReset ? <ResetButton onReset={onReset} /> : null}
      </span>
      <div className="color-picker-row">
        <label className="color-picker-shell" title={`${label}: open color picker`}>
          <span className="color-picker-preview" style={{ background: normalizedValue }} />
          <span className="color-picker-value">{normalizedValue.toUpperCase()}</span>
          <input ref={colorInputRef} aria-label={label} type="color" value={normalizedValue} onChange={(event) => onChange(event.target.value)} />
        </label>
        <button
          aria-label={`${label} eyedropper`}
          className="color-eyedropper-button"
          disabled={isPicking}
          title="Pick color from screen"
          type="button"
          onClick={pickFromScreen}
        >
          <Pipette size={14} />
        </button>
      </div>
      <span className="color-swatches" aria-label={`${label} suggested colors`}>
        {palette.slice(0, 5).map((color) => (
          <button
            aria-label={`${label} ${color}`}
            key={color}
            style={{ background: color }}
            title={color}
            type="button"
            onClick={(event) => {
              event.preventDefault();
              onChange(color);
            }}
          />
        ))}
      </span>
    </div>
  );
}
