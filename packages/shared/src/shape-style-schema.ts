/**
 * The `shape-style` PropertySchema (ADR-023 S6 / D12) — the second adopter of ADR-004.
 *
 * D12 says a shape preset, a caption preset and a text preset are each `{schemaId, version, values}`;
 * it does NOT say they are the same schema. A shape has no typography and text has no `borderRadius`,
 * so one merged schema would be a union whose every field is inapplicable half the time — and a preset
 * saved from a shape would then be *applicable* to text, which is precisely the mispaste
 * `migratePropertyValues` refuses on schema id. Two schemas, one envelope, one migration runner.
 *
 * **Shapes need a schema and presets, not an engine** (the plan's own words). `drawShapeLayer`
 * (`scene/text-shape.ts:894`) already renders every field below and is already shared by the scene
 * raster path, so nothing here is a renderer change: this stage describes what already paints.
 *
 * WHAT IS NOT DESCRIBED, and why it is not an oversight: `shapeKind`, `shapePath`, `widthPercent`,
 * `heightPercent`. Those are what the shape IS and where it sits. They are described as
 * non-presetable rather than omitted where the inspector edits them — see `shapeKind` below — and
 * `shapePath` is not described at all, for the reason `text`/`textRuns` are not described in
 * `text-style-schema.ts`: it is content, not appearance.
 */

import { compositionShapeDefaults } from "./composition-style";
import { propertySchemaPresetKeys, type PropertySchema, type PropertySchemaField } from "./property-schema";
import type { PropertyValuesEnvelope } from "./property-schema";
import type { ShapeStyleFields, TimelineLayer } from "./types";

/** Every key this schema describes. Constrained to real layer keys, so a typo cannot compile. */
export type ShapeStyleSchemaKey = keyof TimelineLayer & (keyof ShapeStyleFields | "shapeKind");

/** A key a shape preset / clipboard envelope carries — the `presetable` subset, exactly `ShapeStyleFields`. */
export type ShapeStyleFieldKey = keyof ShapeStyleFields & keyof TimelineLayer;

export const shapeStyleGroups = [
  { id: "fill", label: "Fill & stroke" },
  { id: "geometry", label: "Geometry" },
  { id: "shadow", label: "Shadow" }
] as const;

const fields = [
  // --- Fill & stroke -------------------------------------------------------------------------
  {
    key: "color",
    kind: "color",
    group: "fill",
    label: "Fill",
    defaultValue: compositionShapeDefaults.color,
    presetable: true,
    documentation: { aiSynonyms: ["shape color", "fill color"] }
  },
  {
    key: "strokeColor",
    kind: "color",
    group: "fill",
    label: "Stroke color",
    defaultValue: "#ffffff",
    presetable: true
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
    documentation: { description: "0 emits no border at all — `getStrokeCss` returns undefined." }
  },
  // S5b's decomposition, unchanged, over the second draw path that already consumed it.
  {
    key: "fillTextureAssetId",
    kind: "reference",
    refType: "asset",
    group: "fill",
    label: "Image fill",
    absenceIsMeaningful: true,
    presetable: true,
    documentation: {
      description: "A project image painted inside the shape instead of the flat fill.",
      aiSynonyms: ["texture", "image fill", "pattern"]
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
    absenceIsMeaningful: true,
    presetable: true
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

  // --- Geometry ------------------------------------------------------------------------------
  {
    key: "borderRadius",
    kind: "number",
    unit: "px",
    min: 0,
    max: 500,
    step: 1,
    group: "geometry",
    label: "Corner radius",
    defaultValue: compositionShapeDefaults.borderRadiusPx,
    animatableAs: "style.borderRadius",
    // Presetable, unlike `shapeKind` below, and the line between them is worth stating: a radius is a
    // treatment applied to whatever the shape is (a rounded rectangle stays a rectangle), while the
    // kind is the shape's identity. "Softer corners" is a look; "become an ellipse" is not.
    presetable: true
  },
  {
    key: "shapeKind",
    kind: "enum",
    group: "geometry",
    label: "Shape",
    options: [
      { value: "rectangle", label: "Rectangle" },
      { value: "rounded-rectangle", label: "Rounded rectangle" },
      { value: "ellipse", label: "Ellipse" },
      { value: "line", label: "Line" },
      { value: "triangle", label: "Triangle" },
      { value: "diamond", label: "Diamond" },
      { value: "pentagon", label: "Pentagon" },
      { value: "pen", label: "Custom path" }
    ],
    defaultValue: compositionShapeDefaults.shapeKind,
    // NOT presetable — the `textWidthPercent` rule, one layer over. Applying a look must not turn the
    // user's ellipse into a triangle, and a `pen` shape whose kind was overwritten would keep a
    // `shapePath` nothing reads: silent data loss dressed as a style.
    presetable: false,
    documentation: { description: "Which primitive `drawShapeLayer` builds. Identity, not appearance — never carried by a preset." }
  },

  // --- Shadow --------------------------------------------------------------------------------
  {
    key: "shadowColor",
    kind: "color",
    group: "shadow",
    label: "Shadow color",
    defaultValue: "rgba(0,0,0,0.5)",
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
    defaultValue: 0,
    animatableAs: "style.shadowBlur",
    presetable: true,
    documentation: { description: "0 emits no `boxShadow` — the shape shadow is gated on blur, not on colour." }
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
    defaultValue: 0,
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
    defaultValue: 8,
    animatableAs: "style.shadowOffsetY",
    presetable: true
  }
] as const satisfies ReadonlyArray<PropertySchemaField<ShapeStyleSchemaKey>>;

export const SHAPE_STYLE_SCHEMA_VERSION = 1;

export const shapeStyleSchema: PropertySchema<ShapeStyleSchemaKey> = {
  id: "shape-style",
  version: SHAPE_STYLE_SCHEMA_VERSION,
  metadata: {
    name: "Shape style",
    description: "How a shape looks: fill, stroke, corner radius and shadow."
  },
  groups: [...shapeStyleGroups],
  fields,
  migrations: [],
  documentation: {
    description: "The look of a shape layer, independent of which primitive it is and where it sits."
  }
};

export const SHAPE_STYLE_FIELD_KEYS: ReadonlyArray<ShapeStyleFieldKey> = propertySchemaPresetKeys(
  shapeStyleSchema
) as ShapeStyleFieldKey[];

type DeclaredShapeStyleKey = (typeof fields)[number]["key"];
type PresetableShapeStyleKey = Extract<(typeof fields)[number], { presetable: true }>["key"];

/**
 * The same two constraints `text-style-schema.ts` carries, and they are copied deliberately rather
 * than abstracted: each one is proved against ITS OWN literal, and a generic helper would have to be
 * handed both the literal and the interface to prove anything at all.
 *
 * S5b is why this pair is here on day one for shapes rather than added later. `fillTexture` rendered
 * correctly for four months while being absent from `TextStyleFields`, so the constraint that proved
 * "presetable === the look interface" was true and vacuous over that field. A constraint only covers
 * the set it is written over (T-15 addendum 2).
 */
type UndescribedShapeStyleKeys = Exclude<keyof ShapeStyleFields, DeclaredShapeStyleKey>;
const _everyShapeLookFieldIsDescribed: UndescribedShapeStyleKeys extends never
  ? true
  : ["shape-style schema is missing these ShapeStyleFields keys", UndescribedShapeStyleKeys] = true;

type UncarriedShapeStyleKeys = Exclude<keyof ShapeStyleFields, PresetableShapeStyleKey>;
type OvercarriedShapeStyleKeys = Exclude<PresetableShapeStyleKey, keyof ShapeStyleFields>;
const _shapePresetKeysAreExactlyTheLook: [UncarriedShapeStyleKeys, OvercarriedShapeStyleKeys] extends [never, never]
  ? true
  : [
      "presetable fields must be exactly ShapeStyleFields — these are dropped / these are extra",
      UncarriedShapeStyleKeys,
      OvercarriedShapeStyleKeys
    ] = true;
void _everyShapeLookFieldIsDescribed;
void _shapePresetKeysAreExactlyTheLook;

/** A saved shape look — the ADR-004 envelope, same shape as the text one (T-10). */
export type ShapeStylePreset = PropertyValuesEnvelope<ShapeStyleFields>;

export function shapeStylePreset(values: ShapeStyleFields): ShapeStylePreset {
  return { schemaId: shapeStyleSchema.id, version: SHAPE_STYLE_SCHEMA_VERSION, values };
}

/** Snapshot a layer's shape-appearance fields, dropping `undefined` so absence survives capture. */
export function captureShapeStyle(layer: TimelineLayer): ShapeStyleFields {
  const out: Record<string, unknown> = {};
  for (const key of SHAPE_STYLE_FIELD_KEYS) {
    const value = layer[key];
    if (value !== undefined) out[key] = value;
  }
  return out as ShapeStyleFields;
}

/** Bake a shape look onto a layer. A key the style does not carry is not written (D1a). */
export function applyShapeStyle(layer: TimelineLayer, style: ShapeStyleFields): TimelineLayer {
  return { ...layer, ...style };
}
