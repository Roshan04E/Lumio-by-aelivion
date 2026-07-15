/**
 * Shared layer-selection modifier→mode mapping. Single source of truth so every
 * selection surface (timeline strip, Graphics-tab layer stack) resolves click
 * modifiers IDENTICALLY — they must never drift into "subtly different rules".
 *
 * Mirrors Premiere/Finder-style behavior:
 *   Shift + Ctrl/Cmd → extend the range AND keep the current selection (add-range)
 *   Shift            → select the contiguous range from the anchor
 *   Ctrl/Cmd         → toggle this one in/out of the selection
 *   (none)           → replace the selection with this one
 */
export type LayerSelectMode = "replace" | "toggle" | "range" | "add-range";

export function resolveSelectMode(
  event: Pick<PointerEvent | MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">
): LayerSelectMode {
  if (event.shiftKey && (event.metaKey || event.ctrlKey)) {
    return "add-range";
  }
  if (event.shiftKey) {
    return "range";
  }
  if (event.metaKey || event.ctrlKey) {
    return "toggle";
  }
  return "replace";
}
