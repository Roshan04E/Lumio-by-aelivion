import { useRef, type InputHTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Drag-scrub number input (After Effects / DaVinci style) — the editor-wide replacement for
 * bare `<input type="number">` (user feedback: typing numbers is "very tedious and slow").
 *
 * - Press + drag horizontally on the value to scrub it: 1px = 1 step (hold Shift for 0.1× fine).
 * - A plain click (no drag) focuses the input and selects the text, so typing still works.
 * - While focused it behaves as a normal number input (caret/selection untouched).
 *
 * Typing flows through the native `onChange`/`onBlur` the caller already wires; only scrubbing
 * fires `onScrubChange` with the stepped + clamped numeric value.
 */
export interface ScrubNumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  onScrubChange: (value: number) => void;
}

const SCRUB_THRESHOLD_PX = 3;
const FINE_FACTOR = 0.1;

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? parseFloat(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Decimal places implied by the step, so scrubbed values don't accumulate float junk. */
function stepDecimals(step: number): number {
  if (Number.isInteger(step)) return 0;
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : Math.min(6, text.length - dot - 1);
}

export function ScrubNumberInput({ onScrubChange, className, ...rest }: ScrubNumberInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number; scrubbed: boolean } | null>(null);

  const min = toNumber(rest.min, -Infinity);
  const max = toNumber(rest.max, Infinity);
  const step = Math.abs(toNumber(rest.step, 1)) || 1;

  const handlePointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (event.button !== 0 || event.currentTarget === document.activeElement) {
      return; // focused = text editing; native caret/selection behavior stays untouched
    }
    // Block the native focus-on-mousedown so a drag scrubs instead of selecting text; a plain
    // click re-focuses explicitly on pointer-up below.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: toNumber(event.currentTarget.value, toNumber(rest.value, 0)),
      scrubbed: false
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLInputElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.scrubbed && Math.abs(dx) < SCRUB_THRESHOLD_PX) return;
    drag.scrubbed = true;
    const raw = drag.startValue + dx * step * (event.shiftKey ? FINE_FACTOR : 1);
    const stepped = Math.round(raw / step) * step;
    const clamped = Math.min(max, Math.max(min, Number(stepped.toFixed(stepDecimals(step)))));
    // Uncontrolled usage (defaultValue): React won't render the new value, so show it directly.
    if (rest.value === undefined && inputRef.current) {
      inputRef.current.value = String(clamped);
    }
    onScrubChange(clamped);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLInputElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.scrubbed) {
      // Plain click: enter typing mode (focus was suppressed on pointer-down).
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  return (
    <input
      {...rest}
      ref={inputRef}
      type="number"
      className={`scrub-number${className ? ` ${className}` : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}
