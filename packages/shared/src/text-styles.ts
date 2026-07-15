/**
 * Text Styles (§2) — pure capture/apply for reusable text looks. A style is a one-shot bundle: applying
 * it BAKES its field values onto a text layer (no live link, no renderer change — every renderer already
 * reads these flat `TimelineLayer` fields). See GRAPHICS_TAB.md §2.
 */

import type { TextStyle, TextStyleFields, TimelineLayer } from "./types";

/** The exact `TimelineLayer` keys a Text Style covers — the single source of truth for capture/apply. */
export const TEXT_STYLE_FIELD_KEYS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "italic",
  "letterSpacing",
  "lineHeight",
  "color",
  "strokeColor",
  "strokeWidth",
  "backgroundColor",
  "backgroundPaddingEm",
  "backgroundRadiusEm",
  "shadowColor",
  "shadowBlur",
  "shadowOffsetX",
  "shadowOffsetY",
  "textAlign"
] as const satisfies ReadonlyArray<keyof TextStyleFields & keyof TimelineLayer>;

/** Snapshot a layer's current text-appearance fields (dropping `undefined`, so a style only carries
 *  what was actually set). Non-text layers simply yield whatever of these fields they happen to have. */
export function captureTextStyle(layer: TimelineLayer): TextStyleFields {
  const out: Record<string, unknown> = {};
  for (const key of TEXT_STYLE_FIELD_KEYS) {
    const value = layer[key];
    if (value !== undefined) out[key] = value;
  }
  return out as TextStyleFields;
}

/** Bake a captured look onto a layer — spreads only the fields the style carries; everything else
 *  (text content, transform, width, warp, effects, keyframes) is untouched. */
export function applyTextStyle(layer: TimelineLayer, style: TextStyleFields): TimelineLayer {
  return { ...layer, ...style };
}

/** Fresh style id (crypto when available, else time+random). */
export function freshTextStyleId(): string {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `style_${suffix}`;
}

/** Build a new saved style from a layer's current look. */
export function createTextStyleFromLayer(layer: TimelineLayer, name: string): TextStyle {
  return { id: freshTextStyleId(), name, style: captureTextStyle(layer) };
}
