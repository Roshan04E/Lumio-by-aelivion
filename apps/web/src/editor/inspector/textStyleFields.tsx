/**
 * The text-style inspector ADAPTER (ADR-005) — `text-style` schema + a layer + write handlers →
 * `PropertyField[]`. ADR-023 S4.
 *
 * The boundary this file sits on: **adapter = domain → schema; renderer = schema → widgets.** Nothing
 * here renders anything. `PropertyFieldList` (ADR-002) turns the output into the same 24px rows the
 * Transform and effect inspectors use, so the text panel inherits keyframe affordance, reset semantics
 * and styling instead of re-deriving them — which is what the panel used to do, as a fourth copy of
 * the "param → control" dispatch ADR-002 exists to delete.
 *
 * BESPOKE EDITORS COME IN AS SLOTS. Four fields have a canonical editor the shared renderer does not
 * ship: the two face toggles, the alignment strip and the direction select. Each is emitted as a
 * `custom` field carrying a host-supplied node — the escape hatch ADR-002 sanctions for exactly this,
 * and the reason S4 added NO new field kind. Those widgets keep their own behaviour (S2.7's async
 * face resolution in particular), and the adapter still owns which schema field becomes which row, in
 * which group, with which label.
 *
 * **The font was the fifth, and stopped being a slot in S4b.** It is a `reference`/font — which the
 * schema always said it was — and the renderer can now build that kind, so what crosses this boundary
 * is the VALUE and the writes, not a widget. The gap between a kind being frozen into the taxonomy
 * and a kind being buildable is what turns a schema field into a slot; closing it turns it back.
 *
 * WRITE HANDLERS ARE COPIED VERBATIM from the panel this replaces. A refactor of the inspector must
 * not change what any control WRITES: every write is a future pixel, and S4's acceptance bar is that
 * the picture does not move.
 */

import type { ReactNode } from "react";
import {
  AlignLeft,
  ArrowLeftRight,
  CaseSensitive,
  Eye,
  Maximize2,
  MoveHorizontal,
  MoveVertical,
  PaintBucket,
  PenLine,
  Radius,
  Sparkles,
  Square
} from "lucide-react";
import { textStyleSchema, type TextStyleSchemaKey, type TimelineLayer } from "@orreris/shared";
import { buildBackgroundColor, parseBackgroundColor } from "../../lib/colorBackground";
import { fontReferenceId, fontReferenceResolver, type FontPickerValue } from "../controls/FontPicker";
import type { PropertyField } from "./PropertyFieldList";

/** The keyframe wiring for `style.*` numeric tracks (EditorPage's `makeStyleKeyframeTools`). */
export interface StyleKeyframeTools {
  value: (property: string, base: number, scale?: number) => number;
  change: (property: string, value: number, scale?: number) => void;
  keyframe: (
    property: string,
    currentValue: number,
    scale?: number
  ) => NonNullable<Extract<PropertyField, { kind: "number" }>["keyframe"]>;
}

/**
 * The values a RESET writes. Deliberately distinct from the schema's `defaultValue`, which is what an
 * ABSENT field renders as: resetting font size returns it to the authoring default (72), while an
 * absent font size renders at the resolver's fallback (64). Conflating the two would silently
 * re-style every layer somebody hit reset on.
 */
export interface TextStyleAuthoringDefaults {
  fontFamily: string;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  textWidthPercent: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  backgroundColor: string;
  backgroundPaddingEm: number;
  backgroundRadiusEm: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
}

/** Schema fields whose canonical editor the shared renderer does not ship — supplied by the host. */
export type TextStyleSlotKey = "fontWeight" | "italic" | "textAlign" | "direction" | "strokePaintOrder";

/**
 * The font row's domain values and writes (S4b). The host supplies the VALUE and the handlers; the
 * adapter shapes them into a `reference` field; the renderer picks the editor from `refType`. The
 * widget itself no longer travels through here, which is the difference between a schema field and a
 * slot — and the reason S6's preset picker is a field rather than a third bespoke widget.
 */
export interface TextStyleFontReference {
  value: FontPickerValue;
  onPick: (next: FontPickerValue) => void;
  onReset: () => void;
}

export interface TextStyleAdapterContext {
  layer: TimelineLayer;
  palette: string[];
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  styleKf?: StyleKeyframeTools | undefined;
  defaults: TextStyleAuthoringDefaults;
  /** Writes the layer's `shadow` effect on/off alongside a blur write (EditorPage's helper). */
  setShadowEnabled: (layer: TimelineLayer, enabled: boolean) => TimelineLayer;
  /** Absent → no font row, exactly as an absent slot means no row. */
  font?: TextStyleFontReference | undefined;
  slots: Partial<Record<TextStyleSlotKey, ReactNode>>;
}

/** The schema's label for a key — so a rename happens in one place and reaches every consumer. */
function labelOf(key: TextStyleSchemaKey, fallback: string): string {
  return textStyleSchema.fields.find((field) => field.key === key)?.label ?? fallback;
}

/** Bounds declared by the schema, with the panel's historical values as the fallback. */
function boundsOf(key: TextStyleSchemaKey, fallback: { min: number; max: number; step: number }) {
  const field = textStyleSchema.fields.find((entry) => entry.key === key);
  return {
    min: field?.min ?? fallback.min,
    max: field?.max ?? fallback.max,
    step: field?.step ?? fallback.step
  };
}

/**
 * A `style.*`-keyframed number row. `scale` maps the display unit to the stored unit — the background
 * padding and radius rows show em ×100, exactly as they did before.
 */
function styleNumberField(
  ctx: TextStyleAdapterContext,
  args: {
    key: TextStyleSchemaKey;
    property: string;
    icon: ReactNode;
    base: number;
    min: number;
    max: number;
    step: number;
    scale?: number;
    label?: string;
    onReset: () => void;
    onWrite: (value: number) => void;
  }
): PropertyField {
  const { styleKf } = ctx;
  const scale = args.scale ?? 1;
  const value = styleKf?.value(args.property, args.base, scale) ?? args.base;
  return {
    kind: "number",
    key: args.key,
    label: args.label ?? labelOf(args.key, args.key),
    icon: args.icon,
    value,
    min: args.min,
    max: args.max,
    step: args.step,
    ...(styleKf ? { keyframe: styleKf.keyframe(args.property, value, scale) } : {}),
    onReset: args.onReset,
    onChange: (next: number) => (styleKf ? styleKf.change(args.property, next, scale) : args.onWrite(next))
  };
}

/**
 * A host-supplied widget for a schema field the shared renderer has no branch for. Absent slot → no
 * row, never an empty shell.
 *
 * `custom` rather than `control` on purpose. `control` wraps the widget in the shared `PropertyRow`,
 * which supplies the label column — and every one of these five widgets already carries its own label
 * chrome (the face toggles and the alignment strip are self-labelling icon groups; the direction
 * select is a `number-row-select` label). Wrapping them would render the label twice and change a
 * panel this stage is not redesigning. `control` is the right hatch for a bespoke control cell inside
 * the standard row; `custom` is the right one for a widget that IS its own row, which is what these
 * are. Both are ADR-002 escape hatches and neither adds a kind.
 */
function slotField(ctx: TextStyleAdapterContext, key: TextStyleSlotKey): PropertyField | null {
  const node = ctx.slots[key];
  if (!node) return null;
  return { kind: "custom", key, node };
}

/**
 * The whole text look as inspector rows, keyed by schema field.
 *
 * Returned as a map rather than a list because grouping is metadata and LAYOUT IS THE INSPECTOR'S
 * CHOICE (ADR-004): the panel composes rows into its existing sections and compact rows, and a future
 * surface (a command palette, an AI edit sheet, a preset editor) can take the same rows in whatever
 * arrangement suits it.
 */
export function buildTextStyleFields(ctx: TextStyleAdapterContext): Partial<Record<string, PropertyField>> {
  const { layer, palette, onChange, defaults, styleKf } = ctx;
  const fields: Partial<Record<string, PropertyField>> = {};
  const put = (field: PropertyField | null) => {
    if (field) fields[field.key] = field;
  };

  // --- Typography ---------------------------------------------------------------------------
  // The font is a `reference`/font (ADR-003), and since S4b that is a kind the renderer can BUILD —
  // so it is a field here rather than a host-supplied widget. The id it serializes as is the file for
  // a pinned ref and the CSS stack for a legacy one; `fontReferenceResolver` is what turns either
  // back into the name on the row.
  if (ctx.font) {
    const { value, onPick, onReset } = ctx.font;
    fields.fontFamily = {
      kind: "reference",
      refType: "font",
      key: "fontFamily",
      label: labelOf("fontFamily", "Font"),
      refId: fontReferenceId(value),
      resolve: fontReferenceResolver(value),
      emptyLabel: "None",
      value,
      onPick,
      onReset
    };
  }
  put(
    styleNumberField(ctx, {
      key: "fontSize",
      property: "style.fontSize",
      icon: <CaseSensitive size={14} />,
      base: layer.fontSize ?? defaults.fontSize,
      ...boundsOf("fontSize", { min: 1, max: 1000, step: 1 }),
      onReset: () => onChange((item) => ({ ...item, fontSize: defaults.fontSize })),
      onWrite: (value) => onChange((item) => ({ ...item, fontSize: value }))
    })
  );
  put(slotField(ctx, "fontWeight"));
  put(slotField(ctx, "italic"));
  put(slotField(ctx, "textAlign"));
  put(slotField(ctx, "direction"));
  put(
    styleNumberField(ctx, {
      key: "letterSpacing",
      property: "style.letterSpacing",
      icon: <MoveHorizontal size={14} />,
      base: layer.letterSpacing ?? 0,
      ...boundsOf("letterSpacing", { min: -50, max: 200, step: 0.5 }),
      onReset: () => onChange((item) => ({ ...item, letterSpacing: defaults.letterSpacing })),
      onWrite: (value) => onChange((item) => ({ ...item, letterSpacing: value }))
    })
  );
  put(
    styleNumberField(ctx, {
      key: "lineHeight",
      property: "style.lineHeight",
      icon: <MoveVertical size={14} />,
      base: layer.lineHeight ?? defaults.lineHeight,
      ...boundsOf("lineHeight", { min: 0, max: 5, step: 0.05 }),
      onReset: () => onChange((item) => ({ ...item, lineHeight: defaults.lineHeight })),
      onWrite: (value) => onChange((item) => ({ ...item, lineHeight: value }))
    })
  );
  put(
    styleNumberField(ctx, {
      key: "textWidthPercent",
      property: "style.textWidthPercent",
      icon: <MoveHorizontal size={14} />,
      base: layer.textWidthPercent ?? 0,
      ...boundsOf("textWidthPercent", { min: 0, max: 100, step: 1 }),
      onReset: () => onChange((item) => ({ ...item, textWidthPercent: defaults.textWidthPercent })),
      onWrite: (value) => onChange((item) => ({ ...item, textWidthPercent: value }))
    })
  );

  // --- Fill & stroke ------------------------------------------------------------------------
  fields.color = {
    kind: "color",
    key: "color",
    label: labelOf("color", "Fill color"),
    icon: <PaintBucket size={14} />,
    value: layer.color ?? "#ffffff",
    palette,
    onReset: () => onChange((item) => ({ ...item, color: defaults.color })),
    onChange: (value) => onChange((item) => ({ ...item, color: value }))
  };
  fields.strokeColor = {
    kind: "color",
    key: "strokeColor",
    label: labelOf("strokeColor", "Stroke color"),
    icon: <PenLine size={14} />,
    value: layer.strokeColor ?? "#161618",
    palette,
    onReset: () => onChange((item) => ({ ...item, strokeColor: defaults.strokeColor })),
    onChange: (value) => onChange((item) => ({ ...item, strokeColor: value }))
  };
  put(
    styleNumberField(ctx, {
      key: "strokeWidth",
      property: "style.strokeWidth",
      icon: <PenLine size={14} />,
      base: layer.strokeWidth ?? 0,
      ...boundsOf("strokeWidth", { min: 0, max: 200, step: 1 }),
      onReset: () => onChange((item) => ({ ...item, strokeWidth: defaults.strokeWidth })),
      onWrite: (value) => onChange((item) => ({ ...item, strokeWidth: value }))
    })
  );
  put(slotField(ctx, "strokePaintOrder"));

  // --- Background ---------------------------------------------------------------------------
  // Two rows over ONE schema field: the stored value is a single CSS colour, and the panel has always
  // split it into a swatch and an opacity. That decomposition is an adapter's business — the schema
  // describes the property, not the number of editors somebody points at it.
  const background = parseBackgroundColor(layer.backgroundColor, "#08090d");
  fields.backgroundColor = {
    kind: "color",
    key: "backgroundColor",
    label: labelOf("backgroundColor", "Background"),
    icon: <Square size={14} />,
    value: background.hex,
    palette,
    onReset: () => onChange((item) => ({ ...item, backgroundColor: defaults.backgroundColor })),
    onChange: (value) => onChange((item) => ({ ...item, backgroundColor: buildBackgroundColor(value, background.alphaPercent) }))
  };
  fields["backgroundColor.alpha"] = {
    kind: "number",
    key: "backgroundColor.alpha",
    label: "Opacity",
    icon: <Eye size={14} />,
    value: background.alphaPercent,
    min: 0,
    max: 100,
    step: 1,
    onReset: () => onChange((item) => ({ ...item, backgroundColor: defaults.backgroundColor })),
    onChange: (value) => onChange((item) => ({ ...item, backgroundColor: buildBackgroundColor(background.hex, value) }))
  };
  // Padding/radius rows display the em value ×100 — the keyframe track stores the raw em.
  put(
    styleNumberField(ctx, {
      key: "backgroundPaddingEm",
      property: "style.backgroundPaddingEm",
      icon: <Maximize2 size={14} />,
      base: Math.round((layer.backgroundPaddingEm ?? defaults.backgroundPaddingEm) * 100),
      min: 0,
      max: 100,
      step: 1,
      scale: 100,
      label: "Padding",
      onReset: () => onChange((item) => ({ ...item, backgroundPaddingEm: defaults.backgroundPaddingEm })),
      onWrite: (value) => onChange((item) => ({ ...item, backgroundPaddingEm: value / 100 }))
    })
  );
  put(
    styleNumberField(ctx, {
      key: "backgroundRadiusEm",
      property: "style.backgroundRadiusEm",
      icon: <Radius size={14} />,
      base: Math.round((layer.backgroundRadiusEm ?? defaults.backgroundRadiusEm) * 100),
      min: 0,
      max: 200,
      step: 1,
      scale: 100,
      label: "Corner radius",
      onReset: () => onChange((item) => ({ ...item, backgroundRadiusEm: defaults.backgroundRadiusEm })),
      onWrite: (value) => onChange((item) => ({ ...item, backgroundRadiusEm: value / 100 }))
    })
  );

  // --- Shadow --------------------------------------------------------------------------------
  fields.shadowColor = {
    kind: "color",
    key: "shadowColor",
    label: labelOf("shadowColor", "Shadow color"),
    icon: <Sparkles size={14} />,
    value: layer.shadowColor ?? "#000000",
    palette,
    onReset: () => onChange((item) => ({ ...item, shadowColor: defaults.shadowColor })),
    onChange: (value) => onChange((item) => ({ ...item, shadowColor: value }))
  };
  {
    // Blur is the one row whose write is not just a field write: a positive blur also enables the
    // layer's `shadow` effect, because that effect is what supplies the resolver's non-zero default.
    const base = layer.shadowBlur ?? 0;
    const value = styleKf?.value("style.shadowBlur", base) ?? base;
    fields.shadowBlur = {
      kind: "number",
      key: "shadowBlur",
      label: labelOf("shadowBlur", "Shadow blur"),
      icon: <Sparkles size={14} />,
      value,
      min: 0,
      max: 500,
      step: 1,
      ...(styleKf ? { keyframe: styleKf.keyframe("style.shadowBlur", value) } : {}),
      onReset: () =>
        ctx.onChange((item) => ctx.setShadowEnabled({ ...item, shadowBlur: defaults.shadowBlur }, defaults.shadowBlur > 0)),
      onChange: (next: number) => {
        if (styleKf) {
          styleKf.change("style.shadowBlur", next);
          if (next > 0) onChange((item) => ctx.setShadowEnabled(item, true));
        } else {
          onChange((item) => ctx.setShadowEnabled({ ...item, shadowBlur: next }, next > 0));
        }
      }
    };
  }
  put(
    styleNumberField(ctx, {
      key: "shadowOffsetX",
      property: "style.shadowOffsetX",
      icon: <MoveHorizontal size={14} />,
      base: layer.shadowOffsetX ?? 0,
      min: -500,
      max: 500,
      step: 1,
      label: "Shadow X",
      onReset: () => onChange((item) => ({ ...item, shadowOffsetX: defaults.shadowOffsetX })),
      onWrite: (value) => onChange((item) => ({ ...item, shadowOffsetX: value }))
    })
  );
  put(
    styleNumberField(ctx, {
      key: "shadowOffsetY",
      property: "style.shadowOffsetY",
      icon: <MoveVertical size={14} />,
      base: layer.shadowOffsetY ?? 0,
      min: -500,
      max: 500,
      step: 1,
      label: "Shadow Y",
      onReset: () => onChange((item) => ({ ...item, shadowOffsetY: defaults.shadowOffsetY })),
      onWrite: (value) => onChange((item) => ({ ...item, shadowOffsetY: value }))
    })
  );

  return fields;
}

/** Pick rows, in the order asked for, skipping any the adapter did not produce. */
export function pickTextStyleFields(
  fields: Partial<Record<string, PropertyField>>,
  keys: string[]
): PropertyField[] {
  return keys.map((key) => fields[key]).filter((field): field is PropertyField => Boolean(field));
}

/** Icons the host reuses when it supplies a slot widget, so labels and glyphs stay in one place. */
export const textStyleSlotIcons = {
  textAlign: <AlignLeft size={14} />,
  direction: <ArrowLeftRight size={14} />,
  strokePaintOrder: <PenLine size={15} />
};
