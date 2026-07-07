import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface ThemedSelectOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode | undefined;
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
  className,
  triggerIcon,
  iconOnly = false,
  menuMinWidth = 160,
  menuPlacement = "auto"
}: {
  value: T;
  groups?: ThemedSelectGroup<T>[];
  options?: ThemedSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerIcon?: ReactNode | undefined;
  iconOnly?: boolean;
  menuMinWidth?: number;
  menuPlacement?: "auto" | "bottom" | "top";
}) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const resolvedGroups: ThemedSelectGroup<T>[] = groups ?? [{ label: "", options: options ?? [] }];
  const current = resolvedGroups.flatMap((group) => group.options).find((option) => option.value === value);

  function reposition() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const preferredWidth = Math.max(rect.width, menuMinWidth);
    const width = Math.min(preferredWidth, Math.max(120, window.innerWidth - viewportPadding * 2));
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openAbove = menuPlacement === "top" || (menuPlacement === "auto" && spaceBelow < 180 && spaceAbove > spaceBelow);
    const maxHeight = Math.max(140, Math.min(320, (openAbove ? spaceAbove : spaceBelow) - 5));
    const optionCount = resolvedGroups.reduce((count, group) => count + group.options.length, 0);
    const visibleGroupLabels = resolvedGroups.filter((group) => group.label && !(group.options.length === 1 && group.label === group.options[0]?.label)).length;
    const estimatedHeight = Math.min(maxHeight, 14 + optionCount * 30 + visibleGroupLabels * 20 + Math.max(0, resolvedGroups.length - 1) * 8);
    const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding));
    const top = openAbove ? Math.max(viewportPadding, rect.top - estimatedHeight - 5) : Math.min(window.innerHeight - viewportPadding, rect.bottom + 5);
    setMenuRect({ top, left, width, maxHeight });
  }

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, menuMinWidth, menuPlacement]);

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
  }, [open, menuMinWidth, menuPlacement]);

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
      <span className="themed-select-option-label">
        {option.icon ? <span className="themed-select-option-icon">{option.icon}</span> : null}
        <span>{option.label}</span>
      </span>
      {value === option.value ? <Check size={13} /> : null}
    </button>
  );

  return (
    <div className={`themed-select${iconOnly ? " is-icon-only" : ""}${className ? ` ${className}` : ""}`} ref={rootRef}>
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
        {triggerIcon ? <span className="themed-select-trigger-icon">{triggerIcon}</span> : null}
        <span className={current ? "" : "themed-select-placeholder"}>{current?.label ?? placeholder ?? ""}</span>
        <ChevronDown size={13} />
      </button>
      {open && menuRect
        ? createPortal(
            <div
              ref={menuRef}
              className="themed-select-menu"
              role="listbox"
              style={{ top: menuRect.top, left: menuRect.left, minWidth: menuRect.width, maxHeight: menuRect.maxHeight }}
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
