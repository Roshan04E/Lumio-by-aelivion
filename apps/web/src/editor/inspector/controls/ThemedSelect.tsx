import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface ThemedSelectOption<T extends string> {
  value: T;
  label: string;
}

export interface ThemedSelectGroup<T extends string> {
  label: string;
  options: ThemedSelectOption<T>[];
}

/**
 * Dark-theme dropdown that replaces a native <select>+<optgroup>. Native select popups
 * are OS-drawn (the unthemable white "banding" on optgroup headers); this renders a fully
 * styled menu with grouped sections, a current-value trigger, and a check on the active row.
 *
 * The menu is rendered through a portal with fixed positioning anchored to the trigger, so it is
 * never clipped by an ancestor's `overflow` or covered by a later panel's stacking context (the
 * "dropdown hidden behind the next panel" bug). Pass either `groups` (sectioned) or `options` (flat).
 */
export function ThemedSelect<T extends string>({
  value,
  groups,
  options,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
  className
}: {
  value: T;
  groups?: ThemedSelectGroup<T>[];
  options?: ThemedSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const resolvedGroups: ThemedSelectGroup<T>[] = groups ?? [{ label: "", options: options ?? [] }];
  const current = resolvedGroups.flatMap((group) => group.options).find((option) => option.value === value);

  function reposition() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setMenuRect({ top: rect.bottom + 5, left: rect.left, width: rect.width });
  }

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    // Reposition while scrolling any ancestor (capture catches inner scrollers) and on resize.
    function handleReflow() {
      reposition();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleReflow, true);
    window.addEventListener("resize", handleReflow);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleReflow, true);
      window.removeEventListener("resize", handleReflow);
    };
  }, [open]);

  const renderOption = (option: ThemedSelectOption<T>) => (
    <button
      key={option.value}
      type="button"
      role="option"
      aria-selected={value === option.value}
      className={value === option.value ? "is-active" : ""}
      onClick={() => {
        onChange(option.value);
        setOpen(false);
      }}
    >
      <span>{option.label}</span>
      {value === option.value ? <Check size={13} /> : null}
    </button>
  );

  return (
    <div className={`themed-select${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="themed-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={current ? "" : "themed-select-placeholder"}>{current?.label ?? placeholder ?? ""}</span>
        <ChevronDown size={13} />
      </button>
      {open && menuRect
        ? createPortal(
            <div
              ref={menuRef}
              className="themed-select-menu"
              role="listbox"
              style={{ top: menuRect.top, left: menuRect.left, minWidth: menuRect.width }}
            >
              {resolvedGroups.map((group, groupIndex) =>
                group.label && !(group.options.length === 1 && group.label === group.options[0]!.label) ? (
                  <div className="themed-select-group" key={group.label || groupIndex}>
                    <span className="themed-select-group-label">{group.label}</span>
                    {group.options.map(renderOption)}
                  </div>
                ) : (
                  <div className="themed-select-group" key={group.label || groupIndex}>
                    {group.options.map(renderOption)}
                  </div>
                )
              )}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
