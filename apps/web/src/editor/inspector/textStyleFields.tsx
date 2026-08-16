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
  Blend,
  Bold,
  CaseSensitive,
  Image as ImageIcon,
  Eye,
  Layers,
  Maximize2,
  MoveHorizontal,
  MoveVertical,
  PaintBucket,
  PenLine,
  Radius,
  RotateCw,
  Rows3,
  Sparkles,
  Square,
  Type,
  ZoomIn
} from "lucide-react";
import {
  fontAxisSupport,
  getCompositionFontRef,
  isPinnedFontRef,
  textStyleSchema,
  type FontAxisRange,
  type TextStyleSchemaKey,
  type TimelineLayer
} from "@orreris/shared";
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

/**
 * S5b — the image fill's domain values and writes. The adapter shapes them into a `reference` field;
 * the renderer picks the editor from `refType`. Same division as the font row since S4b.
 */
export interface TextStyleFillTextureReference {
  assetId: string | undefined;
  /** The media pool, for resolution — the same list the bin shows, never a copy that can go stale. */
  assets: Array<{ id: string; fileName: string; thumbnailUrl?: string | undefined }>;
  /** `undefined` clears the whole fill (image, fit and scale together). */
  onPick: (assetId: string | undefined) => void;
  /** Opens the pool in pick-one mode. Absent → the trigger is inert, exactly as the kind documents. */
  onBrowse?: (() => void) | undefined;
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
  /**
   * S5b — the image-fill reference: the media pool to resolve against, and how to write a pick.
   * Absent → no fill rows, the same "an absent slot means no row" rule the font follows.
   */
  fillTexture?: TextStyleFillTextureReference | undefined;
  /**
   * ADR-023 S9a — the axes the layer's pinned FILE actually exposes, read from its `fvar` table.
   *
   * Three-valued on purpose, and the host must preserve that: `undefined` means "not read yet" (the
   * bytes are still arriving, or the container is a `.woff2` this repo cannot parse), while an empty
   * array means "read it, this file is static". A row bounded by the CSS spec rather than by the FILE
   * is "no cut, no lie" in miniature — dragging past the face's real maximum does nothing and looks
   * like a broken control — so a known range wins, an unknown one falls back to the schema bounds,
   * and a file known to lack the axis gets NO row at all.
   */
  fontAxes?: FontAxisRange[] | undefined;
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
/**
 * ADR-023 S9a — the `wght`/`wdth` rows, or nothing.
 *
 * Static (no `keyframe` wiring) because S9a is the static half deliberately: animating an axis wants
 * a registered face per sampled value, and S9b's first job is to MEASURE that registration cost
 * rather than to assume it is free. Offering a diamond here would ship the expensive half by
 * accident.
 *
 * The displayed value when the field is absent is the FILE's own `fvar` default, which is what absent
 * actually renders as — not 400, which is merely the most common default. Reset writes `undefined`
 * rather than that number, so absent stays absent (D1a) and the layer does not acquire a coordinate
 * it never authored.
 */
function axisFields(ctx: TextStyleAdapterContext): PropertyField[] {
  const { layer, onChange } = ctx;
  // Read through the same shared normalizer the renderers use, so "is this pinned" cannot be
  // answered one way here and another way at emission.
  if (!isPinnedFontRef(getCompositionFontRef(layer))) return [];

  const rows: PropertyField[] = [];
  const specs = [
    { key: "fontWeightAxis", tag: "wght", icon: <Bold size={14} /> },
    { key: "fontWidthAxis", tag: "wdth", icon: <MoveHorizontal size={14} /> }
  ] as const;

  for (const spec of specs) {
    const support = fontAxisSupport(ctx.fontAxes, spec.tag);
    // "read it, this file has no such axis" is the ONLY state that removes the row. "not read yet"
    // keeps it, or the control would be missing for the first seconds of every session.
    if (support.state === "absent") continue;
    const bounds = boundsOf(spec.key, { min: 1, max: 1000, step: 1 });
    const range = support.state === "supported" ? support.range : undefined;
    const authored = layer[spec.key];
    rows.push({
      kind: "number",
      key: spec.key,
      label: labelOf(spec.key, spec.key),
      icon: spec.icon,
      value: typeof authored === "number" ? authored : range?.default ?? 400,
      min: range?.min ?? bounds.min,
      max: range?.max ?? bounds.max,
      step: bounds.step,
      onReset: () => onChange((item) => ({ ...item, [spec.key]: undefined })),
      onChange: (next: number) => onChange((item) => ({ ...item, [spec.key]: next }))
    });
  }
  return rows;
}

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
  /**
   * ADR-023 S9a — the variable axes, and the rules for when a row exists at all.
   *
   * Placed directly under the Bold toggle because that is the S2.7 boundary made visible: the toggle
   * picks between FILES, these pick WITHIN one, and someone reaching for "a bit bolder than regular"
   * should find both in the same place rather than discovering later that the product had two
   * unrelated answers.
   *
   * A row appears only when it would DO something: the ref must be pinned (a system family has no
   * bytes to re-register, so the axis is refused at emission and a slider would move nothing), and
   * the file must either expose the axis or not have been read yet. A file read and known to be
   * static gets no row — showing one would be exactly the faux-bold-over-a-single-style-family lie
   * S2.7 refused.
   */
  for (const axis of axisFields(ctx)) put(axis);
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

  /**
   * S8 / ADR-023 D8 — text on a path, as one number. Reset clears it rather than writing 0: absent is
   * the straight-text state (D1a) and 0 is a value that happens to look like it today.
   */
  put(
    styleNumberField(ctx, {
      key: "textPathCurve",
      property: "style.textPathCurve",
      icon: <RotateCw size={14} />,
      base: layer.textPathCurve ?? 0,
      ...boundsOf("textPathCurve", { min: -100, max: 100, step: 1 }),
      onReset: () => onChange((item) => ({ ...item, textPathCurve: undefined })),
      onWrite: (value) => onChange((item) => ({ ...item, textPathCurve: value }))
    })
  );

  /**
   * S9 / ADR-023 OQ6 — per-character animation, three rows.
   *
   * `clusterRevealProgress` is the only one with keyframe wiring, and that asymmetry IS the feature:
   * the reveal is a keyframed ramp from 0 to 1, while rise and stagger shape it and hold still. It is
   * also why only those two are presetable — a preset carrying "40% revealed" would paste a frozen
   * mid-flight frame of an animation the recipient has not keyframed.
   *
   * Reset clears rather than writing a resting value, for the D1a reason the curve row above gives —
   * and here it is stronger than usual: absent emits NO animation key at all, while a progress of 1
   * emits a finished one. The two render the same picture and are not the same data, and only absent
   * keeps every pre-S9 layer's raster cache key where it was.
   *
   * The rows appear even when the layer's script refuses them. The refusal is stated where the reveal
   * is CONTROLLED (see the notice in EditorPage), not by hiding the control, because a control that
   * vanishes reads as a broken inspector rather than as a feature declining to lie.
   */
  put(
    styleNumberField(ctx, {
      key: "clusterRevealProgress",
      property: "style.clusterRevealProgress",
      icon: <Type size={14} />,
      base: layer.clusterRevealProgress ?? 1,
      ...boundsOf("clusterRevealProgress", { min: 0, max: 1, step: 0.01 }),
      onReset: () => onChange((item) => ({ ...item, clusterRevealProgress: undefined })),
      onWrite: (value) => onChange((item) => ({ ...item, clusterRevealProgress: value }))
    })
  );
  put(
    styleNumberField(ctx, {
      key: "clusterRiseEm",
      property: "style.clusterRiseEm",
      icon: <MoveVertical size={14} />,
      base: layer.clusterRiseEm ?? 0,
      ...boundsOf("clusterRiseEm", { min: -5, max: 5, step: 0.05 }),
      onReset: () => onChange((item) => ({ ...item, clusterRiseEm: undefined })),
      onWrite: (value) => onChange((item) => ({ ...item, clusterRiseEm: value }))
    })
  );
  put(
    styleNumberField(ctx, {
      key: "clusterStaggerFraction",
      property: "style.clusterStaggerFraction",
      icon: <MoveHorizontal size={14} />,
      base: layer.clusterStaggerFraction ?? 0,
      ...boundsOf("clusterStaggerFraction", { min: 0, max: 1, step: 0.05 }),
      onReset: () => onChange((item) => ({ ...item, clusterStaggerFraction: undefined })),
      onWrite: (value) => onChange((item) => ({ ...item, clusterStaggerFraction: value }))
    })
  );

  /**
   * S8 / ADR-023 D8 — the concentric OUTER ring. Two rows, one per schema field.
   *
   * The same Reset discipline the gradient established, for the same D1a reason: absence is the "no
   * ring" state, so Reset writes nothing rather than a default colour, and both fields clear
   * together — a colour with no width (or a width under the inner stroke) does not render, so
   * leaving one behind would park an invisible half-value in saved data.
   */
  {
    const clearOuterStroke = () =>
      onChange((item) => ({ ...item, strokeOuterColor: undefined, strokeOuterWidth: undefined }));
    fields.strokeOuterColor = {
      kind: "color",
      key: "strokeOuterColor",
      label: labelOf("strokeOuterColor", "Outer stroke color"),
      icon: <PenLine size={14} />,
      value: layer.strokeOuterColor ?? layer.strokeColor ?? "#161618",
      palette,
      onReset: clearOuterStroke,
      onChange: (value) => onChange((item) => ({ ...item, strokeOuterColor: value }))
    };
    put(
      styleNumberField(ctx, {
        key: "strokeOuterWidth",
        property: "style.strokeOuterWidth",
        icon: <PenLine size={14} />,
        base: layer.strokeOuterWidth ?? 0,
        ...boundsOf("strokeOuterWidth", { min: 0, max: 200, step: 1 }),
        onReset: clearOuterStroke,
        onWrite: (value) => onChange((item) => ({ ...item, strokeOuterWidth: value }))
      })
    );
  }

  /**
   * S5 / ADR-023 D7 — the two-stop glyph gradient. Three rows, one per schema field.
   *
   * RESET CLEARS THE GRADIENT rather than writing a default colour, and that is the D1a rule reaching
   * the UI: absence is the "no gradient" state, so the only honest way back to it is to write nothing.
   * Both stops are cleared together — a gradient with one stop does not render (`resolveFillGradient`
   * requires both), so leaving one behind would be an invisible half-value sitting in saved data.
   */
  {
    const clearGradient = () =>
      onChange((item) => ({ ...item, fillGradientFrom: undefined, fillGradientTo: undefined, fillGradientAngle: undefined }));
    fields.fillGradientFrom = {
      kind: "color",
      key: "fillGradientFrom",
      label: labelOf("fillGradientFrom", "Gradient from"),
      icon: <Blend size={14} />,
      value: layer.fillGradientFrom ?? layer.color ?? defaults.color,
      palette,
      onReset: clearGradient,
      onChange: (value) => onChange((item) => ({ ...item, fillGradientFrom: value }))
    };
    fields.fillGradientTo = {
      kind: "color",
      key: "fillGradientTo",
      label: labelOf("fillGradientTo", "Gradient to"),
      icon: <Blend size={14} />,
      value: layer.fillGradientTo ?? layer.color ?? defaults.color,
      palette,
      onReset: clearGradient,
      onChange: (value) => onChange((item) => ({ ...item, fillGradientTo: value }))
    };
    fields.fillGradientAngle = {
      kind: "number",
      key: "fillGradientAngle",
      label: labelOf("fillGradientAngle", "Gradient angle"),
      icon: <RotateCw size={14} />,
      value: layer.fillGradientAngle ?? 180,
      ...boundsOf("fillGradientAngle", { min: 0, max: 360, step: 1 }),
      onReset: () => onChange((item) => ({ ...item, fillGradientAngle: undefined })),
      onChange: (value) => onChange((item) => ({ ...item, fillGradientAngle: value }))
    };
  }

  /**
   * S5b / ADR-023 — image fill on the glyphs, as `reference`/asset + `enum` + `number`.
   *
   * **The picker is not written here, and that is the whole point of the stage's cost.** S4b made
   * `reference` a kind `PropertyFieldList` builds, so the adapter says what the id points at and the
   * renderer supplies the editor. Before S4b this row was a bespoke widget behind an escape hatch,
   * which is the reason `fillTexture` shipped in July with a renderer and no way to author it.
   *
   * The resolver reads the SAME media pool the bin shows, so a fill and the bin can never disagree
   * about which image an id names, and an id the pool no longer holds resolves to the kind's shared
   * `missing` state rather than to silence.
   */
  if (ctx.fillTexture) {
    const { assetId, assets, onPick, onBrowse } = ctx.fillTexture;
    fields.fillTextureAssetId = {
      kind: "reference",
      refType: "asset",
      key: "fillTextureAssetId",
      label: labelOf("fillTextureAssetId", "Image fill"),
      icon: <ImageIcon size={14} />,
      refId: assetId ?? "",
      emptyLabel: "None",
      resolve: (refId) => {
        const asset = assets.find((entry) => entry.id === refId);
        if (!asset) return null;
        return { label: asset.fileName, missing: false, ...(asset.thumbnailUrl ? { thumbnailUrl: asset.thumbnailUrl } : {}) };
      },
      ...(onBrowse ? { onBrowse } : {}),
      // Clearing drops the whole fill, fit and scale included: a fit with no image is an invisible
      // half-value in saved data, and the same rule the gradient's Reset follows.
      onClear: () => onPick(undefined)
    };
    fields.fillTextureFit = {
      kind: "enum",
      key: "fillTextureFit",
      label: labelOf("fillTextureFit", "Image fit"),
      icon: <Maximize2 size={14} />,
      value: layer.fillTextureFit ?? "cover",
      options: [
        { value: "cover", label: "Cover" },
        { value: "tile", label: "Tile" }
      ],
      onChange: (value) => onChange((item) => ({ ...item, fillTextureFit: value === "tile" ? "tile" : undefined }))
    };
    fields.fillTextureScale = {
      kind: "number",
      key: "fillTextureScale",
      label: labelOf("fillTextureScale", "Image scale"),
      icon: <ZoomIn size={14} />,
      value: layer.fillTextureScale ?? 1,
      ...boundsOf("fillTextureScale", { min: 0.05, max: 20, step: 0.05 }),
      onReset: () => onChange((item) => ({ ...item, fillTextureScale: undefined })),
      onChange: (value) => onChange((item) => ({ ...item, fillTextureScale: value === 1 ? undefined : value }))
    };
  }

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
  // S5 / ADR-023 D7. Switching it OFF writes `undefined`, not `false`: absent is the legacy state and
  // the two are indistinguishable to every renderer, so the one that stays out of saved data wins.
  fields.backgroundPerLine = {
    kind: "boolean",
    key: "backgroundPerLine",
    label: labelOf("backgroundPerLine", "Pill per line"),
    icon: <Rows3 size={14} />,
    value: layer.backgroundPerLine === true,
    onChange: (value) => onChange((item) => ({ ...item, backgroundPerLine: value ? true : undefined }))
  };

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
  // S5 / ADR-023 D7 — stacked shadows. `1` writes `undefined` for the same reason the per-line toggle
  // does: one copy IS the legacy look, and the state that stays out of saved data is the one to write.
  fields.shadowLayers = {
    kind: "number",
    key: "shadowLayers",
    label: labelOf("shadowLayers", "Shadow stack"),
    icon: <Layers size={14} />,
    value: layer.shadowLayers ?? 1,
    ...boundsOf("shadowLayers", { min: 1, max: 24, step: 1 }),
    onReset: () => onChange((item) => ({ ...item, shadowLayers: undefined })),
    onChange: (value) => onChange((item) => ({ ...item, shadowLayers: value > 1 ? value : undefined }))
  };

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
