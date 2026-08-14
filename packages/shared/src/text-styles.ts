/**
 * Text Styles — capture/apply for reusable text looks, now expressed through the `text-style`
 * PropertySchema (ADR-023 S4, ADR-004).
 *
 * A style is still a one-shot bundle: applying it BAKES its field values onto a text layer (no live
 * link, no renderer change — every renderer already reads these flat `TimelineLayer` fields). What
 * changed in S4 is where the field list comes from. It used to be a hand-written array here; it is now
 * DERIVED from the schema's `presetable` fields (`TEXT_STYLE_FIELD_KEYS` in `text-style-schema.ts`),
 * with a compile-time proof that the set is exactly `TextStyleFields`.
 *
 * That is not tidying. The hand-written list had silently fallen two fields behind the layer —
 * `fontRef` (S2) and `direction` (S0b) — so a saved look dropped its pinned font and its base
 * direction, and applying it rendered in a different typeface than the layer it was captured from. It
 * is the exact defect shape ADR-023 T-15 was written about, in the preset path rather than the
 * manifest path, and a renderer-parity gate cannot see either one.
 *
 * `captureTextStyle`/`applyTextStyle` keep their signatures and their semantics — `text-look.ts`, the
 * `applyTextLook` action and the editor's Text Styles panel are unchanged callers.
 */

import { migratePropertyValues } from "./property-schema";
import {
  TEXT_STYLE_FIELD_KEYS,
  textStylePreset,
  textStyleSchema,
  TEXT_STYLE_SCHEMA_VERSION,
  type TextStylePreset
} from "./text-style-schema";
import type { TextStyle, TextStyleFields, TimelineLayer } from "./types";

export { TEXT_STYLE_FIELD_KEYS };

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
 *  (text content, transform, width, warp, effects, keyframes) is untouched.
 *
 *  A key the style does not carry is not written, so absence stays absence: pasting a look captured
 *  from a layer with no `direction` must not stamp `ltr` onto the target (ADR-023 D6a/D1a). */
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

/**
 * Capture a layer's look as the shared envelope (ADR-023 T-10) — the clipboard payload, and the shape
 * S6's presets will be saved in. Same values `captureTextStyle` produces; the envelope adds the
 * schema identity and version that let it be read back safely later.
 */
export function captureTextStylePreset(layer: TimelineLayer): TextStylePreset {
  return textStylePreset(captureTextStyle(layer));
}

export type ReadTextStylePresetResult =
  | { ok: true; values: TextStyleFields; migrated: boolean }
  | { ok: false; reason: string };

/**
 * Read an envelope back — migrating it if it was written by an older schema version, and REFUSING it
 * if it was written by a newer one or belongs to a different schema.
 *
 * Refusal rather than best-effort coercion is the ADR-023 D3 posture applied to data: a look that
 * pastes "most of itself" is worse than one that says it cannot, because the user cannot see what was
 * dropped. Callers surface `reason`.
 */
export function readTextStylePreset(preset: TextStylePreset): ReadTextStylePresetResult {
  const result = migratePropertyValues<TextStyleFields>(textStyleSchema, preset);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, values: result.values, migrated: result.migrated };
}

/**
 * Adopt a pre-S4 saved style (bare `TextStyleFields`, no envelope) as a current-version envelope.
 *
 * This is a NORMALIZATION, not a migration, and the distinction is the whole point: not one value is
 * read, written, defaulted or remapped. A pre-S4 style is already exactly the v1 value shape — S4 gave
 * that shape a name and a version, it did not change it — so wrapping is lossless by construction and
 * a legacy style applies to a layer today byte-for-byte as it did before S4.
 *
 * The same reasoning is why the schema ships with an empty `migrations` list and why S2 needed no
 * manifest migration either (ADR-023 D1a): absent fields stay absent, permanently, and nothing walks
 * saved data to fill them in.
 */
export function normalizeTextStylePreset(style: TextStyleFields | TextStylePreset): TextStylePreset {
  if (
    style &&
    typeof style === "object" &&
    "schemaId" in style &&
    "values" in style &&
    typeof (style as TextStylePreset).schemaId === "string"
  ) {
    return style as TextStylePreset;
  }
  return { schemaId: textStyleSchema.id, version: TEXT_STYLE_SCHEMA_VERSION, values: style as TextStyleFields };
}
