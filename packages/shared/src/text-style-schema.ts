/**
 * The `text-style` PropertySchema (ADR-023 S4 / D12) — the first adopter of ADR-004.
 *
 * A text style stops being a bag of loose CSS-ish fields and becomes a **versioned, described object**:
 * one declaration that the inspector adapter (ADR-005), the style resolver in `composition-style.ts`,
 * saved project styles, the clipboard and (S6) presets all read. That is what makes "a preset saved
 * today still loads after the schema changes" true rather than aspirational — migrations run on all
 * four, because all four are the same envelope (ADR-023 T-10).
 *
 * WHAT IS IN AND WHAT IS NOT. This schema describes the *look* of text: typography, fill and stroke,
 * background box, shadow. It does not describe what the text SAYS (`text`/`textRuns`/
 * `sourceTextKeyframes`), where it SITS (`transform`), or the warp envelope (`textWarp` — its own
 * model and its own panel). `textWidthPercent` is described because the inspector edits it, and
 * carries `presetable: false` because a box width is placement, not a look: pasting a look must not
 * reflow the target's line breaks.
 *
 * ONLY FROZEN KINDS (ADR-003). `fontFamily` is a `reference`/`font`, not a new "font" kind. S4 had to
 * bridge it to the `FontPicker` through an escape hatch because the renderer shipped no `reference`
 * branch; **S4b built the branch**, so the declaration below is now rendered as what it says it is.
 * Nothing here changed for that: the schema was already right, and the renderer caught up to it.
 *
 * `defaultValue` MEANS "WHAT ABSENT RENDERS AS" — {@link compositionTextDefaults}, the resolver's
 * fallback. It is deliberately NOT the authoring default the New Text button stamps
 * (`EditorPage.defaultTextStyle`, e.g. 72 px and `#4D9FFF`), which is a different question with a
 * different answer. Fields whose absence is permanent legacy state (D1a) carry
 * `absenceIsMeaningful` and no default at all: nothing may fill them in.
 */

import { compositionTextDefaults } from "./composition-style";
import {
  propertySchemaPresetKeys,
  type PropertySchema,
  type PropertySchemaField
} from "./property-schema";
import type { TextStyleFields, TimelineLayer } from "./types";
import type { PropertyValuesEnvelope } from "./property-schema";

/** Every key this schema describes. Constrained to real layer keys, so a typo cannot compile. */
export type TextStyleSchemaKey = keyof TimelineLayer & (keyof TextStyleFields | "textWidthPercent");

/** A key a preset/clipboard envelope carries — the `presetable` subset, and exactly `TextStyleFields`. */
export type TextStyleFieldKey = keyof TextStyleFields & keyof TimelineLayer;

export const textStyleGroups = [
  { id: "typography", label: "Typography" },
  { id: "fill", label: "Fill & stroke" },
  { id: "background", label: "Background" },
  { id: "shadow", label: "Shadow" }
] as const;

/**
 * Declared `as const` so the KEY and `presetable` literals survive into the type system — that is what
 * makes the two constraints at the bottom of this file real rather than decorative.
 */
const fields = [
  // --- Typography ----------------------------------------------------------------------------
  {
    key: "fontFamily",
    kind: "reference",
    refType: "font",
    group: "typography",
    label: "Font",
    defaultValue: compositionTextDefaults.fontFamily,
    presetable: true,
    documentation: {
      description: "The typeface. Travels with `fontRef`, which is the render identity (D1/T-1).",
      aiSynonyms: ["typeface", "font family"]
    }
  },
  {
    key: "fontRef",
    kind: "reference",
    refType: "font",
    group: "typography",
    label: "Font file",
    // ADR-023 D1a. Absent is not "the default font" — it is "authored before FontRef existed, render
    // the legacy CSS stack", permanently. `getCompositionFontRef` normalizes on read; nothing writes
    // this in on load, and no migration may.
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      description:
        "The pinned font file (`fileHash` + store) a render resolves. Absent means the legacy CSS stack.",
      aiSynonyms: ["pinned font", "font file"]
    }
  },
  {
    key: "fontSize",
    kind: "number",
    unit: "px",
    min: 1,
    max: 1000,
    step: 1,
    group: "typography",
    label: "Font size",
    defaultValue: compositionTextDefaults.fontSize,
    animatableAs: "style.fontSize",
    presetable: true,
    documentation: { aiSynonyms: ["size", "text size", "point size"] }
  },
  {
    key: "fontWeight",
    kind: "number",
    min: 100,
    max: 900,
    step: 100,
    group: "typography",
    label: "Weight",
    defaultValue: compositionTextDefaults.fontWeight,
    presetable: true,
    documentation: {
      description:
        "CSS weight for a legacy stack. Over a pinned `fontRef` the FILE decides weight (S2.7), so the inspector exposes this as the Bold toggle rather than a number.",
      aiSynonyms: ["bold", "boldness"]
    }
  },
  {
    key: "italic",
    kind: "boolean",
    group: "typography",
    label: "Italic",
    defaultValue: false,
    presetable: true,
    documentation: { aiSynonyms: ["oblique", "slanted"] }
  },
  {
    key: "letterSpacing",
    kind: "number",
    unit: "px",
    min: -50,
    max: 200,
    step: 0.5,
    group: "typography",
    label: "Letter spacing",
    defaultValue: 0,
    animatableAs: "style.letterSpacing",
    presetable: true,
    documentation: { aiSynonyms: ["tracking", "kerning"] }
  },
  {
    key: "lineHeight",
    kind: "number",
    unit: "ratio",
    min: 0,
    max: 5,
    step: 0.05,
    group: "typography",
    label: "Line height",
    defaultValue: compositionTextDefaults.lineHeight,
    animatableAs: "style.lineHeight",
    presetable: true,
    documentation: { aiSynonyms: ["leading", "line spacing"] }
  },
  {
    key: "textAlign",
    kind: "enum",
    group: "typography",
    label: "Alignment",
    options: [
      { value: "left", label: "Left" },
      { value: "center", label: "Center" },
      { value: "right", label: "Right" },
      { value: "start", label: "Start" },
      { value: "end", label: "End" }
    ],
    defaultValue: "center",
    presetable: true,
    documentation: {
      description: "`start`/`end` are LOGICAL and resolve against `direction`; `left`/`right` stay physical (D6a)."
    }
  },
  {
    key: "direction",
    kind: "enum",
    group: "typography",
    label: "Direction",
    options: [
      { value: "auto", label: "Auto" },
      { value: "ltr", label: "Left to right" },
      { value: "rtl", label: "Right to left" }
    ],
    // ADR-023 D6a / T-13. Absent emits NO direction declaration at all, permanently — not `ltr`. A
    // migration that wrote `ltr` in would change every legacy layer's emitted CSS, which is precisely
    // the byte-identity claim D1a's shape exists to keep.
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      description: "Base paragraph direction. `auto` is resolved once, in shared, for both renderers (T-13 corrected).",
      aiSynonyms: ["rtl", "bidi", "right to left"]
    }
  },
  {
    key: "textWidthPercent",
    kind: "number",
    unit: "percent",
    min: 0,
    max: 100,
    step: 1,
    group: "typography",
    label: "Text box width",
    defaultValue: 0,
    animatableAs: "style.textWidthPercent",
    // NOT presetable: a box width is placement, and pasting a look must not reflow the target's lines.
    presetable: false,
    documentation: { description: "0 = shrink-wrap (`max-content`); above 0 the box wraps at this width." }
  },

  // --- Fill & stroke -------------------------------------------------------------------------
  {
    key: "color",
    kind: "color",
    group: "fill",
    label: "Fill color",
    defaultValue: compositionTextDefaults.color,
    presetable: true,
    documentation: { aiSynonyms: ["text color", "fill"] }
  },
  {
    key: "strokeColor",
    kind: "color",
    group: "fill",
    label: "Stroke color",
    defaultValue: "#000000",
    presetable: true,
    documentation: { aiSynonyms: ["outline color", "border color"] }
  },
  {
    key: "strokeWidth",
    kind: "number",
    unit: "px",
    min: 0,
    max: 200,
    step: 1,
    group: "fill",
    label: "Stroke width",
    defaultValue: 0,
    animatableAs: "style.strokeWidth",
    presetable: true,
    documentation: { aiSynonyms: ["outline", "border width"] }
  },
  {
    key: "strokePaintOrder",
    kind: "enum",
    group: "fill",
    label: "Stroke behind fill",
    options: [
      { value: "over", label: "Stroke over fill" },
      { value: "under", label: "Stroke behind fill" }
    ],
    // ADR-023 D7 (S1). Absent renders as "over" but is NOT defaulted to it: emitting `paint-order`
    // for a legacy layer would change its CSS. Only an explicit "under" emits a declaration.
    absenceIsMeaningful: true,
    presetable: true,
    documentation: { description: "`paint-order: stroke fill` — a heavy stroke stops eating the letterform." }
  },
  /**
   * ADR-023 D8 (S8) — the concentric OUTER ring, as TWO fields, for the reason the gradient is three:
   * a list of independently-coloured strokes is the `list` kind, frozen into ADR-003's taxonomy and
   * not yet buildable by `PropertyFieldList`. A third ring is not approximated.
   *
   * Both `absenceIsMeaningful`: absent is "no ring", permanently, and a colour defaulted in on load
   * would put a ring on every stroked title in every existing project (D1a).
   */
  {
    key: "strokeOuterColor",
    kind: "color",
    group: "fill",
    label: "Outer stroke color",
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      aiSynonyms: ["second outline color", "double outline"],
      description: "The outer ring of a two-colour concentric outline. Needs an inner stroke to ring."
    }
  },
  {
    key: "textPathCurve",
    kind: "number",
    min: -100,
    max: 100,
    step: 1,
    group: "typography",
    label: "Curve",
    animatableAs: "style.textPathCurve",
    // Absent is straight text, permanently (D1a). A default of 0 written onto load would be the same
    // picture today and one refactor away from not being.
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      aiSynonyms: ["arc text", "text on a path", "curved text", "circle text"],
      description: "Bends the run onto a circular arc. Positive arcs up, negative down; ±100 wraps a half circle."
    }
  },
  {
    key: "strokeOuterWidth",
    kind: "number",
    unit: "px",
    min: 0,
    max: 200,
    step: 1,
    group: "fill",
    label: "Outer stroke width",
    animatableAs: "style.strokeOuterWidth",
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      aiSynonyms: ["second outline width"],
      description: "Total width of the outer ring. Nothing is drawn unless it exceeds the inner stroke width, which covers it."
    }
  },
  /**
   * ADR-023 D7 (S5) — tier-1 gradient fill, as THREE fields rather than one.
   *
   * The composite `gradient` kind is in the frozen fifteen and is not one the renderer can build yet;
   * ADR-003's promotion-out-of-the-remainder clause wants genuine two-system demand and S5 is one
   * system. Two `color`s and a `number` describe a two-stop linear gradient exactly, in kinds that
   * already render, and none of them is a private encoding a future `gradient` field would have to
   * decode. When the kind is built these three collapse into it through a normal migration; until
   * then this is what "metadata evolves before taxonomy" looks like in practice, not a workaround.
   *
   * `absenceIsMeaningful` on all three: absent is "no gradient", permanently, and a default colour
   * filled in on load would turn every legacy title into a gradient (D1a).
   */
  {
    key: "fillGradientFrom",
    kind: "color",
    group: "fill",
    label: "Gradient from",
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      description: "First stop of the glyph gradient. Nothing is emitted unless BOTH stops are set.",
      aiSynonyms: ["gradient start", "gradient top"]
    }
  },
  {
    key: "fillGradientTo",
    kind: "color",
    group: "fill",
    label: "Gradient to",
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      description: "Second stop of the glyph gradient.",
      aiSynonyms: ["gradient end", "gradient bottom"]
    }
  },
  {
    key: "fillGradientAngle",
    kind: "number",
    unit: "deg",
    min: 0,
    max: 360,
    step: 1,
    group: "fill",
    label: "Gradient angle",
    // Absent renders as CSS `linear-gradient`'s own default (180deg, top → bottom) — but only when a
    // gradient exists at all, which is why this carries no `defaultValue` either.
    absenceIsMeaningful: true,
    presetable: true,
    documentation: { description: "CSS degrees: 0 = up, 90 = right. Absent = 180 (top to bottom)." }
  },
  /**
   * ADR-023 S5b — image fill on the glyphs, DECOMPOSED into three existing kinds.
   *
   * The stored value used to be a composite `{ assetId?, url, fit, scale }`, which the frozen ADR-003
   * taxonomy cannot describe without a new kind or the `custom` hatch. ADR-003's own precedent settles
   * it: *lut* is deliberately not a kind, it is `reference` + `number` (line 38). So the image is a
   * `reference`/asset, the fit is an `enum`, the scale is a `number`.
   *
   * **This is why the field had no editor for four months and now has one for free.** S4b made
   * `reference` a kind `PropertyFieldList` builds; before that, an asset picker meant a bespoke widget
   * behind an escape hatch, which is exactly what the taxonomy exists to prevent accumulating.
   *
   * The `url` is not here and must not be: a reference serializes as an id, and a URL is that id
   * resolved for one machine. `resolveFillTexture` does the resolving, once, in shared.
   */
  {
    key: "fillTextureAssetId",
    kind: "reference",
    refType: "asset",
    group: "fill",
    label: "Image fill",
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      description: "A project image painted into the glyphs instead of the solid fill. Wins over a gradient.",
      aiSynonyms: ["texture", "image fill", "pattern", "photo fill"]
    }
  },
  {
    key: "fillTextureFit",
    kind: "enum",
    group: "fill",
    label: "Image fit",
    options: [
      { value: "cover", label: "Cover" },
      { value: "tile", label: "Tile" }
    ],
    // Absent renders as `cover`, and carries no default for the D1a reason the S5 fields carry none:
    // nothing may write it in, because the whole texture is absent-means-legacy.
    absenceIsMeaningful: true,
    presetable: true,
    documentation: { description: "`cover` fills the element box; `tile` repeats at natural size." }
  },
  {
    key: "fillTextureScale",
    kind: "number",
    min: 0.05,
    max: 20,
    step: 0.05,
    group: "fill",
    label: "Image scale",
    absenceIsMeaningful: true,
    presetable: true,
    documentation: { description: "Zoom on top of the fit. Absent = 1." }
  },

  // --- Background ----------------------------------------------------------------------------
  {
    key: "backgroundColor",
    kind: "color",
    group: "background",
    label: "Background",
    defaultValue: compositionTextDefaults.backgroundColor,
    presetable: true,
    documentation: { description: "Transparent by default — new text is a clean overlay, not a grey box." }
  },
  {
    key: "backgroundPaddingEm",
    kind: "number",
    unit: "em",
    min: 0,
    max: 4,
    step: 0.01,
    group: "background",
    label: "Padding",
    defaultValue: compositionTextDefaults.paddingEmY,
    animatableAs: "style.backgroundPaddingEm",
    presetable: true,
    documentation: { description: "Vertical padding in em; horizontal is twice this." }
  },
  {
    key: "backgroundRadiusEm",
    kind: "number",
    unit: "em",
    min: 0,
    max: 4,
    step: 0.01,
    group: "background",
    label: "Corner radius",
    defaultValue: compositionTextDefaults.borderRadiusEm,
    animatableAs: "style.backgroundRadiusEm",
    presetable: true
  },
  {
    key: "backgroundPerLine",
    kind: "boolean",
    group: "background",
    label: "Pill per line",
    // ADR-023 D1a again: absent is the single block box, permanently. A `defaultValue: false` would
    // read the same today and would be a lie the first time the authoring default changes.
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      description: "One pill per wrapped line instead of one box around the block — the caption look.",
      aiSynonyms: ["per-line background", "line pills", "caption box"]
    }
  },

  // --- Shadow --------------------------------------------------------------------------------
  {
    key: "shadowColor",
    kind: "color",
    group: "shadow",
    label: "Shadow color",
    defaultValue: compositionTextDefaults.shadowColor,
    presetable: true
  },
  {
    key: "shadowBlur",
    kind: "number",
    unit: "px",
    min: 0,
    max: 200,
    step: 1,
    group: "shadow",
    label: "Shadow blur",
    // No `defaultValue`, and that is the honest answer: what absence resolves to depends on the LAYER
    // — 19 when a `shadow` effect is present, 0 when it is not (`getTextShadowCss`). A single number
    // here would be wrong half the time, so the resolver states it and the schema does not pretend.
    animatableAs: "style.shadowBlur",
    presetable: true,
    documentation: { description: "0 emits no shadow. Absent means 19 when the layer carries a `shadow` effect, else 0." }
  },
  {
    key: "shadowOffsetX",
    kind: "number",
    unit: "px",
    min: -500,
    max: 500,
    step: 1,
    group: "shadow",
    label: "Shadow X",
    defaultValue: compositionTextDefaults.shadowOffsetX,
    animatableAs: "style.shadowOffsetX",
    presetable: true
  },
  {
    key: "shadowOffsetY",
    kind: "number",
    unit: "px",
    min: -500,
    max: 500,
    step: 1,
    group: "shadow",
    label: "Shadow Y",
    defaultValue: compositionTextDefaults.shadowOffsetY,
    animatableAs: "style.shadowOffsetY",
    presetable: true
  },
  {
    key: "shadowLayers",
    kind: "number",
    min: 1,
    max: 24,
    step: 1,
    group: "shadow",
    label: "Shadow stack",
    // Absent means one shadow — which is also what `1` means, so this could carry `defaultValue: 1`
    // honestly. It does not, for the D1a reason: the emitted declaration must stay byte-identical for
    // a legacy layer, and a default is a value something is entitled to write in.
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      description: "Copies of the shadow at 1×…N× the offset — a faked 3D extrude. Authored at blur 0.",
      aiSynonyms: ["extrude", "3d text", "stacked shadow", "long shadow"]
    }
  }
] as const satisfies ReadonlyArray<PropertySchemaField<TextStyleSchemaKey>>;

/**
 * Version 1. There is no version 0 to migrate FROM: pre-schema saved styles are bare
 * `TextStyleFields` with no envelope, and {@link normalizeTextStylePreset} adopts them as v1 without
 * touching a value — see its comment for why that is a normalization and not a migration.
 */
export const TEXT_STYLE_SCHEMA_VERSION = 1;

export const textStyleSchema: PropertySchema<TextStyleSchemaKey> = {
  id: "text-style",
  version: TEXT_STYLE_SCHEMA_VERSION,
  metadata: {
    name: "Text style",
    description: "How text looks: typography, fill and stroke, background box, and shadow."
  },
  groups: [...textStyleGroups],
  fields,
  migrations: [],
  documentation: {
    description:
      "The look of a text layer, independent of what it says and where it sits. Shared by the inspector, saved project styles, the clipboard and presets."
  }
};

/**
 * The keys a preset / clipboard envelope carries — derived from the schema, never hand-written.
 *
 * WHY DERIVED (ADR-023 T-15). The hand-written list this replaces was the same defect shape T-15 was
 * written about: `fontRef` and `direction` were added to the layer by S2 and S0b and never added to
 * the copy list, so "Save Style" silently dropped the font pin and the base direction — a saved look
 * that quietly rendered in a different typeface when applied. Parity gates cannot see that, because a
 * field that never reaches the data is a field both renderers agree about perfectly. The exhaustiveness
 * constraint below is what makes the next omission a compile error instead of a user's discovery.
 */
export const TEXT_STYLE_FIELD_KEYS: ReadonlyArray<TextStyleFieldKey> = propertySchemaPresetKeys(
  textStyleSchema
) as TextStyleFieldKey[];

/** The keys actually declared above, read back out of the literal. */
type DeclaredTextStyleKey = (typeof fields)[number]["key"];
/** The keys declared above with `presetable: true` — what an envelope will really carry. */
type PresetableTextStyleKey = Extract<(typeof fields)[number], { presetable: true }>["key"];

/**
 * The two constraints that make the derivation above load-bearing, both proved against the literal
 * rather than restated:
 *
 * 1. **Described.** Every `TextStyleFields` key has a schema field. Add a look field to the interface
 *    and forget the schema entry → the offender is named in the error text.
 * 2. **Carried.** The presetable set is EXACTLY `TextStyleFields` — no missing key (the S1/S2 defect:
 *    a field the copy path silently drops) and no extra key (a placement field like
 *    `textWidthPercent` sneaking into a look and reflowing the target).
 */
type UndescribedTextStyleKeys = Exclude<keyof TextStyleFields, DeclaredTextStyleKey>;
const _everyLookFieldIsDescribed: UndescribedTextStyleKeys extends never
  ? true
  : ["text-style schema is missing these TextStyleFields keys", UndescribedTextStyleKeys] = true;

type UncarriedTextStyleKeys = Exclude<keyof TextStyleFields, PresetableTextStyleKey>;
type OvercarriedTextStyleKeys = Exclude<PresetableTextStyleKey, keyof TextStyleFields>;
const _presetKeysAreExactlyTheLook: [UncarriedTextStyleKeys, OvercarriedTextStyleKeys] extends [never, never]
  ? true
  : [
      "presetable fields must be exactly TextStyleFields — these are dropped / these are extra",
      UncarriedTextStyleKeys,
      OvercarriedTextStyleKeys
    ] = true;
void _everyLookFieldIsDescribed;
void _presetKeysAreExactlyTheLook;

/** A saved look / clipboard payload — the ADR-004 envelope, shared with presets (T-10). */
export type TextStylePreset = PropertyValuesEnvelope<TextStyleFields>;

/** Wrap captured values in the current envelope. */
export function textStylePreset(values: TextStyleFields): TextStylePreset {
  return { schemaId: textStyleSchema.id, version: TEXT_STYLE_SCHEMA_VERSION, values };
}
