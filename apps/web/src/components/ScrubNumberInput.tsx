import { useRef, useState, type ChangeEvent, type FocusEvent, type InputHTMLAttributes, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Drag-scrub number input (After Effects / DaVinci style) — the editor-wide replacement for
 * bare `<input type="number">` (user feedback: typing numbers is "very tedious and slow").
 *
 * - Press + drag horizontally on the value to scrub it: 1px = 1 step (hold Shift for 0.1× fine).
 * - A plain click (no drag) focuses the input and selects the text, so typing still works.
 * - While focused, keystrokes only edit a local draft string — the caller's `onChange` (which
 *   typically clamps/commits into app state and re-renders this component with the new, possibly
 *   clamped, controlled `value`) only fires on blur/Enter. Without this, every keystroke round-trips
 *   through the caller's clamp and stomps the in-progress digits (e.g. typing "104" against a
 *   max of 100 would clamp to "100" mid-keystroke, corrupting what the user is typing).
 *
 * Scrubbing still fires `onScrubChange` continuously (unaffected by the draft — scrubbing never
 * focuses the input).
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

export function ScrubNumberInput({ onScrubChange, className, value, onChange, onFocus, onBlur, onKeyDown, ...rest }: ScrubNumberInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number; scrubbed: boolean } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

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
      startValue: toNumber(event.currentTarget.value, toNumber(value, 0)),
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
    if (value === undefined && inputRef.current) {
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

  const handleFocus = (event: FocusEvent<HTMLInputElement>) => {
    setDraft(event.currentTarget.value);
    onFocus?.(event);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    // Typing: only update the local draft. Forwarding to the caller here would let its clamp/commit
    // re-render this input with a different controlled value mid-keystroke.
    setDraft(event.target.value);
  };

  const commitDraft = () => {
    if (draft !== null && inputRef.current) {
      const synthetic = { ...({} as ChangeEvent<HTMLInputElement>), target: inputRef.current, currentTarget: inputRef.current };
      onChange?.(synthetic as ChangeEvent<HTMLInputElement>);
    }
    setDraft(null);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    commitDraft();
    onBlur?.(event);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      commitDraft();
      inputRef.current?.blur();
    } else if (event.key === "Escape") {
      setDraft(null);
      event.currentTarget.value = String(value ?? "");
      inputRef.current?.blur();
    }
    onKeyDown?.(event);
  };

  return (
    <input
      {...rest}
      ref={inputRef}
      type="number"
      className={`scrub-number${className ? ` ${className}` : ""}`}
      value={draft ?? value}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onFocus={handleFocus}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}
