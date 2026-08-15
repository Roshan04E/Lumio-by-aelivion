/**
 * The style preset library (ADR-023 S6 / D12 layer 1).
 *
 * **A preset is a named envelope and nothing else.** `{schemaId, version, values}` — the identical
 * object the clipboard carries and a saved project style carries, wrapped with an id, a name and a
 * category so it can be listed. That is T-10 taken literally: presets, project data and clipboard are
 * one format with one migration set, so a preset saved today still loads after the schema changes,
 * because `migratePropertyValues` runs over it exactly as it runs over a pasted look.
 *
 * A format that merely *resembled* the clipboard would be two formats with one name, and the second
 * one would rot — it would be the copy-list defect (T-15) at the level of the serialization rather
 * than the field list.
 *
 * **This is layer 1, and layer 2 is not here** (D12). A lower-third is a stack of layers with
 * placement and timing; that is `TemplateDefinition` in `templates.ts`, a project-level object with a
 * module graph and a credit price. A preset has no duration, no modules and no price. The concept is
 * shared, the object is not, and merging them would drag a caption look through a dependency
 * resolver.
 *
 * ---
 *
 * **OQ8 — how does a preset name a font it may not be able to provide? CLOSED here, and the answer
 * generalises past fonts.** See {@link presetReferences}. The short form:
 *
 * - Saving is always allowed. A personal look that uses your own licensed font is a legitimate thing
 *   to keep, and it works perfectly for the person who saved it.
 * - **Sharing hard-fails, by family name, at SHARE time** — the shape OQ7 closed on one layer down.
 * - Applying a preset whose references you cannot resolve is ALLOWED and reports what did not
 *   resolve, by name. Refusing to apply would be worse than useless: the user could not substitute
 *   the font without first getting the look onto the layer.
 * - No URL is ever stored (T-20). A reference travels as an id and the app resolves it.
 */

import { getCompositionFontRef } from "./composition-style";
import { catalogueFontRef } from "./font-catalogue";
import { migratePropertyValues, type PropertyValuesEnvelope } from "./property-schema";
import {
  applyShapeStyle,
  captureShapeStyle,
  shapeStylePreset,
  shapeStyleSchema,
  type ShapeStylePreset
} from "./shape-style-schema";
import { textStylePreset, textStyleSchema, type TextStylePreset } from "./text-style-schema";
import { applyTextStyle, captureTextStyle } from "./text-styles";
import type { ShapeStyleFields, TextStyleFields, TimelineComposition, TimelineLayer } from "./types";

/** Browse categories. Metadata, not a taxonomy — the list decides the tabs, nothing branches on it. */
export type StylePresetCategory = "caption" | "title" | "shape";

/** Where a preset came from. Provenance for the UI; no behaviour hangs off it. */
export type StylePresetOrigin = "first-party" | "user";

export type StylePresetEnvelope = TextStylePreset | ShapeStylePreset;

/**
 * A listed, applicable look.
 *
 * The envelope is a MEMBER rather than the preset being spread into it, so `preset.envelope` is
 * byte-identical to what `captureTextStylePreset` produces for the clipboard. Flattening name and id
 * alongside `schemaId`/`values` would make the two shapes merely similar, and the first consumer to
 * `JSON.stringify` one into the other would find out which.
 */
export interface StylePreset {
  id: string;
  name: string;
  description?: string | undefined;
  category: StylePresetCategory;
  origin: StylePresetOrigin;
  envelope: StylePresetEnvelope;
}

/* ------------------------------------------------------------------------------------------------
 * References, portability, and OQ8
 * ---------------------------------------------------------------------------------------------- */

export type PresetReferenceKind = "font" | "asset";

/**
 * How widely a reference can resolve.
 *
 * - `universal` — the catalogue. Anyone who runs this build can resolve it, because the bytes are
 *   mirrored and served to everyone (D4).
 * - `account` — resolvable only for one account: a user-store font (licensed to its owner, D4) or a
 *   project/user asset. **These are the same problem**, which is the part OQ8 did not anticipate: it
 *   was written about fonts, and S5b added a second reference kind to the same envelope three days
 *   before this stage read it.
 */
export type PresetReferenceScope = "universal" | "account";

export interface PresetReference {
  kind: PresetReferenceKind;
  /** The schema key it came from — so a caller can say WHICH field is the problem. */
  field: string;
  /** What to show a human. A family name or an asset id — **never a URL** (T-20). */
  label: string;
  scope: PresetReferenceScope;
  /** Present only for `account`-scoped fonts: the store that may serve it (D4). */
  ownerId?: string | undefined;
}

/**
 * Every store reference a preset carries.
 *
 * A `{source: "system"}` font ref is deliberately NOT listed. It names no store: it is a CSS stack,
 * which is a request the platform answers or does not (D1a, T-1), and it has always been that way.
 * Listing it here would report every legacy look as unportable while changing nothing about what it
 * renders — a warning nobody can act on, which is the kind that trains people to ignore warnings.
 */
export function presetReferences(preset: StylePreset): PresetReference[] {
  const values = preset.envelope.values as Record<string, unknown>;
  const out: PresetReference[] = [];

  const fontRef = values.fontRef as { source?: string; family?: string; ownerId?: string } | undefined;
  if (fontRef && typeof fontRef === "object") {
    if (fontRef.source === "catalogue") {
      out.push({ kind: "font", field: "fontRef", label: String(fontRef.family ?? ""), scope: "universal" });
    } else if (fontRef.source === "user") {
      out.push({
        kind: "font",
        field: "fontRef",
        label: String(fontRef.family ?? ""),
        scope: "account",
        ownerId: typeof fontRef.ownerId === "string" ? fontRef.ownerId : undefined
      });
    }
  }

  const assetId = values.fillTextureAssetId;
  if (typeof assetId === "string" && assetId) {
    out.push({ kind: "asset", field: "fillTextureAssetId", label: assetId, scope: "account" });
  }

  return out;
}

export interface PresetPortability {
  /** True when every reference is `universal` — the preset renders the same for anyone. */
  shareable: boolean;
  /** The references that stop it, if any. Empty when `shareable`. */
  personal: PresetReference[];
}

/**
 * **OQ8's decision, as a function.** A preset is shareable when nothing it names is account-scoped.
 *
 * Callers must surface `personal` AT SHARE TIME, by name, and refuse the share — not substitute, and
 * not wait for the render to fail. That is OQ7's closed answer applied one layer up, and the
 * consistency is the point: a collaborator who cannot lawfully receive a font's bytes is in exactly
 * the same position whether the font arrived in a project or in a preset. Two different answers to
 * one question would be two things to remember and one of them would eventually be wrong.
 *
 * The remedy the UI should offer is substitution BEFORE sharing: swap the user font for a catalogue
 * face, and the preset becomes shareable — a deliberate act by the person who knows what they meant,
 * which is the whole of D3's posture.
 */
export function presetPortability(preset: StylePreset): PresetPortability {
  const personal = presetReferences(preset).filter((ref) => ref.scope === "account");
  return { shareable: personal.length === 0, personal };
}

/** What the app can currently resolve, for {@link unresolvedPresetReferences}. */
export interface PresetResolutionContext {
  /** The signed-in account. A user font resolves only for its owner (D4/T-3). */
  viewerId?: string | undefined;
  /** Does this asset exist for the viewer? Absent means "cannot tell" — treated as resolvable. */
  hasAsset?: ((assetId: string) => boolean) | undefined;
}

/**
 * What THIS viewer cannot resolve, by name — the humane half of the hard fail (OQ7's closing note).
 *
 * Reported when a preset is applied, so the substitution happens in the editor while the person is
 * looking at it. The render boundary keeps its own behaviour and this does not soften it: an
 * unresolvable pinned font still aborts the export (T-2), and an unresolvable fill still renders
 * byte-identically to no fill (S5b). This exists so nobody meets either one for the first time in an
 * unattended render.
 *
 * `hasAsset` absent means "cannot tell", and cannot-tell reports nothing. A warning list that fires
 * on every apply because the caller never wired the lookup is a warning list people turn off.
 */
export function unresolvedPresetReferences(
  preset: StylePreset,
  context: PresetResolutionContext = {}
): PresetReference[] {
  return presetReferences(preset).filter((ref) => {
    if (ref.scope === "universal") return false;
    if (ref.kind === "font") return !ref.ownerId || ref.ownerId !== context.viewerId;
    if (ref.kind === "asset") return context.hasAsset ? !context.hasAsset(ref.label) : false;
    return false;
  });
}

/* ------------------------------------------------------------------------------------------------
 * Reading and applying
 * ---------------------------------------------------------------------------------------------- */

export type ReadStylePresetResult =
  | { ok: true; schemaId: "text-style"; values: TextStyleFields; migrated: boolean }
  | { ok: true; schemaId: "shape-style"; values: ShapeStyleFields; migrated: boolean }
  | { ok: false; reason: string };

/**
 * Read a preset's envelope through its own schema's migrations — the same call the clipboard makes,
 * dispatched on `schemaId` rather than on which list the preset was found in.
 *
 * Dispatching on the DATA is what makes a text preset dropped onto a shape a refusal with a reason
 * instead of a partial paste: `migratePropertyValues` already refuses a mismatched schema id, and
 * this keeps that check reachable rather than assuming the caller sorted the lists correctly.
 */
export function readStylePreset(preset: StylePreset): ReadStylePresetResult {
  const envelope = preset.envelope;
  if (envelope.schemaId === textStyleSchema.id) {
    const result = migratePropertyValues<TextStyleFields>(textStyleSchema, envelope as PropertyValuesEnvelope<TextStyleFields>);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, schemaId: "text-style", values: result.values, migrated: result.migrated };
  }
  if (envelope.schemaId === shapeStyleSchema.id) {
    const result = migratePropertyValues<ShapeStyleFields>(shapeStyleSchema, envelope as PropertyValuesEnvelope<ShapeStyleFields>);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, schemaId: "shape-style", values: result.values, migrated: result.migrated };
  }
  return { ok: false, reason: `unknown preset schema "${envelope.schemaId}"` };
}

/** Which layer type a preset can be baked onto. `text-style` also covers caption layers — they ARE text layers. */
export function presetLayerType(preset: StylePreset): TimelineLayer["type"] {
  return preset.envelope.schemaId === shapeStyleSchema.id ? "shape" : "text";
}

export type ApplyStylePresetResult =
  | { ok: true; layer: TimelineLayer }
  | { ok: false; reason: string };

/**
 * Bake a preset onto one layer. Absent keys are not written, so a look that carries no `direction`
 * cannot stamp `ltr` onto the target (D1a) — `applyTextStyle`/`applyShapeStyle` own that rule and
 * this does not re-implement it.
 */
export function applyStylePreset(layer: TimelineLayer, preset: StylePreset): ApplyStylePresetResult {
  const read = readStylePreset(preset);
  if (!read.ok) return read;
  if (layer.type !== presetLayerType(preset)) {
    return { ok: false, reason: `"${preset.name}" is a ${presetLayerType(preset)} look and this is a ${layer.type} layer` };
  }
  return {
    ok: true,
    layer: read.schemaId === "text-style" ? applyTextStyle(layer, read.values) : applyShapeStyle(layer, read.values)
  };
}

/** The id `applyCaptionTrackToComposition` gives the caption track it builds. */
export function captionTrackIdFor(composition: TimelineComposition): string {
  return `${composition.id}_track_captions`;
}

export type ApplyStylePresetToTrackResult =
  | { ok: true; composition: TimelineComposition; applied: number }
  | { ok: false; reason: string };

/**
 * **The caption feature, in one call.** Bake a look onto every applicable layer of one track.
 *
 * `AUTO_CAPTIONS` already produces a caption track of text layers, so a preset applied across that
 * track IS short-form captioning — no layer-2 template work, which is why D12 puts the highest
 * product value entirely in layer 1.
 *
 * Layers of the wrong type are SKIPPED rather than failing the call: a caption track someone dropped
 * a shape into should still take a caption look. `applied` reports what actually happened, so a
 * caller can say "12 captions" or notice it said 0.
 */
export function applyStylePresetToTrack(
  composition: TimelineComposition,
  trackId: string,
  preset: StylePreset
): ApplyStylePresetToTrackResult {
  const read = readStylePreset(preset);
  if (!read.ok) return read;
  const track = composition.tracks.find((item) => item.id === trackId);
  if (!track) return { ok: false, reason: `no track "${trackId}"` };

  const wanted = presetLayerType(preset);
  let applied = 0;
  const layers = track.layers.map((layer) => {
    if (layer.type !== wanted) return layer;
    applied += 1;
    return read.schemaId === "text-style" ? applyTextStyle(layer, read.values) : applyShapeStyle(layer, read.values);
  });

  return {
    ok: true,
    applied,
    composition: {
      ...composition,
      tracks: composition.tracks.map((item) => (item.id === trackId ? { ...item, layers } : item))
    }
  };
}

/* ------------------------------------------------------------------------------------------------
 * Saving a preset off a layer
 * ---------------------------------------------------------------------------------------------- */

export function freshStylePresetId(): string {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `preset_${suffix}`;
}

/**
 * Capture a layer's look as a listed preset. Text and shape layers each go through their own schema's
 * capture, so the envelope's `schemaId` is decided by what the layer IS rather than by a parameter a
 * caller can get wrong.
 */
export function captureStylePreset(
  layer: TimelineLayer,
  name: string,
  options: { category?: StylePresetCategory | undefined; description?: string | undefined; id?: string | undefined } = {}
): StylePreset {
  const isShape = layer.type === "shape";
  return {
    id: options.id ?? freshStylePresetId(),
    name,
    description: options.description,
    category: options.category ?? (isShape ? "shape" : "caption"),
    origin: "user",
    envelope: isShape ? shapeStylePreset(captureShapeStyle(layer)) : textStylePreset(captureTextStyle(layer))
  };
}

/**
 * The font a preset will render in, as a `FontRef` — read through the same normalizer the renderers
 * use, so "what will this look like" is answered by one function rather than by re-deriving D1a's
 * absent-means-legacy rule at the preset layer.
 */
export function presetFontRef(preset: StylePreset) {
  return getCompositionFontRef(preset.envelope.values as Parameters<typeof getCompositionFontRef>[0]);
}

/* ------------------------------------------------------------------------------------------------
 * The first-party set
 * ---------------------------------------------------------------------------------------------- */

/**
 * Built from S1 + S5 capability ONLY: stroke and paint order, gradient fill, per-line pills, stacked
 * shadows. Nothing here reaches for an edge treatment — roughen, choke, spread, feather — because
 * those are matte operations and belong to S7 (T-6). A CSS approximation of them in a shipped preset
 * would be the worst place to put one: it becomes a look people build on.
 *
 * **Every font is a catalogue face, and `presets:test` proves the whole set is `shareable`.** A
 * first-party preset that pinned a user font would be unshippable by its own OQ8 rule, and a
 * first-party preset with NO `fontRef` would render in whatever the CSS stack resolves to — the
 * pre-S2 ceiling, reintroduced as a default. The catalogue is five families; that bound is real and
 * is what these twelve looks are built inside.
 *
 * No image fills here either, and that is the same rule rather than an omission: an asset id is
 * account-scoped, so a first-party preset carrying one would be unresolvable for everyone but its
 * author.
 */
function textPreset(
  id: string,
  name: string,
  category: StylePresetCategory,
  description: string,
  values: TextStyleFields
): StylePreset {
  return { id, name, category, description, origin: "first-party", envelope: textStylePreset(values) };
}

function shapePreset(id: string, name: string, description: string, values: ShapeStyleFields): StylePreset {
  return { id, name, category: "shape", description, origin: "first-party", envelope: shapeStylePreset(values) };
}

/** Catalogue faces used below. `catalogueFontRef` is the one function that emits a pinned ref (S2.5). */
const anton = catalogueFontRef("Anton", 400);
const arimoBold = catalogueFontRef("Arimo", 700);
const arimo = catalogueFontRef("Arimo", 400);
const tinosBold = catalogueFontRef("Tinos", 700);
const cousineBold = catalogueFontRef("Cousine", 700);

export const firstPartyStylePresets: readonly StylePreset[] = [
  // --- Captions ------------------------------------------------------------------------------
  textPreset("fp-caption-clean", "Clean White", "caption", "White sans with a soft drop — the safe default.", {
    fontFamily: "Arimo, Arial, sans-serif",
    fontRef: arimoBold,
    fontSize: 54,
    color: "#FFFFFF",
    lineHeight: 1.15,
    textAlign: "center",
    shadowColor: "rgba(0,0,0,0.55)",
    shadowBlur: 12,
    shadowOffsetX: 0,
    shadowOffsetY: 3
  }),
  textPreset("fp-caption-sticker", "Sticker", "caption", "Heavy black outline behind the fill — the creator staple.", {
    fontFamily: "Anton, Impact, sans-serif",
    fontRef: anton,
    fontSize: 76,
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 10,
    // S1's whole point: `under` puts the stroke BEHIND the fill, so 10px does not eat the letterform.
    strokePaintOrder: "under",
    lineHeight: 1.05,
    textAlign: "center"
  }),
  textPreset("fp-caption-pill", "Pill", "caption", "One rounded pill per line, hugging each line's width.", {
    fontFamily: "Arimo, Arial, sans-serif",
    fontRef: arimoBold,
    fontSize: 50,
    color: "#FFFFFF",
    backgroundColor: "#111114",
    backgroundPaddingEm: 0.22,
    backgroundRadiusEm: 0.45,
    backgroundPerLine: true,
    lineHeight: 1.35,
    textAlign: "center"
  }),
  textPreset("fp-caption-highlight", "Highlighter", "caption", "Black text on a yellow marker pill, per line.", {
    fontFamily: "Anton, Impact, sans-serif",
    fontRef: anton,
    fontSize: 62,
    color: "#111114",
    backgroundColor: "#FFD23F",
    backgroundPaddingEm: 0.18,
    backgroundRadiusEm: 0.12,
    backgroundPerLine: true,
    lineHeight: 1.3,
    textAlign: "center"
  }),
  textPreset("fp-caption-gold", "Gold", "caption", "Warm metal gradient with a dark outline.", {
    fontFamily: "Anton, Impact, sans-serif",
    fontRef: anton,
    fontSize: 78,
    color: "#F5C542",
    fillGradientFrom: "#FFF1B8",
    fillGradientTo: "#A9700B",
    fillGradientAngle: 180,
    strokeColor: "#2B1B00",
    strokeWidth: 6,
    strokePaintOrder: "under",
    lineHeight: 1.05,
    textAlign: "center"
  }),
  textPreset("fp-caption-chrome", "Chrome", "caption", "Cool metal gradient, angled.", {
    fontFamily: "Anton, Impact, sans-serif",
    fontRef: anton,
    fontSize: 78,
    color: "#D8DEE9",
    fillGradientFrom: "#FFFFFF",
    fillGradientTo: "#7C8B9E",
    fillGradientAngle: 160,
    strokeColor: "#0E141B",
    strokeWidth: 5,
    strokePaintOrder: "under",
    lineHeight: 1.05,
    textAlign: "center"
  }),
  textPreset("fp-caption-extrude", "Extrude", "caption", "A hard 3D slab — the shadow stacked at zero blur.", {
    fontFamily: "Anton, Impact, sans-serif",
    fontRef: anton,
    fontSize: 80,
    color: "#FFFFFF",
    // S5's `shadowLayers` is only an extrude at blur 0: a blurred stack is a smear, not a slab. This
    // preset is what found that blur 0 emitted nothing at all until S6 (see `textShadowCss`).
    shadowColor: "#E5304B",
    shadowBlur: 0,
    shadowOffsetX: 4,
    shadowOffsetY: 4,
    shadowLayers: 7,
    // Looser leading than its neighbours, and that is the look's own requirement rather than taste: a
    // 7×4px stack reaches 28px past the baseline, so at this stage's usual 1.05 the extrude of line
    // one lands on line two. Seen on the contact sheet; a tighter value ships a look that breaks the
    // moment a caption wraps.
    lineHeight: 1.35,
    textAlign: "center"
  }),
  textPreset("fp-caption-neon", "Neon", "caption", "Cyan glow on a dark outline.", {
    fontFamily: "Arimo, Arial, sans-serif",
    fontRef: arimoBold,
    fontSize: 66,
    color: "#B8FFF9",
    strokeColor: "#0A2C33",
    strokeWidth: 4,
    strokePaintOrder: "under",
    shadowColor: "#22D3EE",
    shadowBlur: 26,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowLayers: 3,
    lineHeight: 1.15,
    textAlign: "center"
  }),
  textPreset("fp-caption-newsroom", "Newsroom", "caption", "Serif on a red banner, one per line.", {
    fontFamily: "Tinos, 'Times New Roman', serif",
    fontRef: tinosBold,
    fontSize: 46,
    color: "#FFFFFF",
    backgroundColor: "#9F1622",
    backgroundPaddingEm: 0.2,
    backgroundRadiusEm: 0.05,
    backgroundPerLine: true,
    letterSpacing: 0.5,
    lineHeight: 1.35,
    textAlign: "left"
  }),
  textPreset("fp-caption-terminal", "Terminal", "caption", "Mono green on black, letter-spaced.", {
    fontFamily: "Cousine, 'Courier New', monospace",
    fontRef: cousineBold,
    fontSize: 42,
    color: "#5CF08A",
    backgroundColor: "#05070A",
    backgroundPaddingEm: 0.25,
    backgroundRadiusEm: 0.08,
    backgroundPerLine: true,
    letterSpacing: 1.5,
    lineHeight: 1.4,
    textAlign: "left"
  }),
  textPreset("fp-caption-duotone", "Duotone", "caption", "Magenta-to-cyan sweep across the glyphs.", {
    fontFamily: "Anton, Impact, sans-serif",
    fontRef: anton,
    fontSize: 74,
    color: "#F472B6",
    fillGradientFrom: "#F472B6",
    fillGradientTo: "#22D3EE",
    fillGradientAngle: 90,
    strokeColor: "#0B1020",
    strokeWidth: 5,
    strokePaintOrder: "under",
    lineHeight: 1.05,
    textAlign: "center"
  }),
  textPreset("fp-caption-subtitle", "Subtitle", "caption", "Quiet broadcast subtitle — no stroke, no box.", {
    fontFamily: "Arimo, Arial, sans-serif",
    fontRef: arimo,
    fontSize: 40,
    color: "#F4F4F5",
    shadowColor: "rgba(0,0,0,0.7)",
    shadowBlur: 8,
    shadowOffsetX: 0,
    shadowOffsetY: 2,
    lineHeight: 1.25,
    textAlign: "center"
  }),

  // --- Titles --------------------------------------------------------------------------------
  textPreset("fp-title-serif", "Serif Title", "title", "Spaced serif for an opening card.", {
    fontFamily: "Tinos, 'Times New Roman', serif",
    fontRef: tinosBold,
    fontSize: 108,
    color: "#F8F5EF",
    letterSpacing: 4,
    lineHeight: 1.1,
    textAlign: "center",
    shadowColor: "rgba(0,0,0,0.4)",
    shadowBlur: 18,
    shadowOffsetX: 0,
    shadowOffsetY: 6
  }),
  textPreset("fp-title-impact", "Impact Title", "title", "Condensed display with an outline.", {
    fontFamily: "Anton, Impact, sans-serif",
    fontRef: anton,
    fontSize: 132,
    color: "#FFFFFF",
    strokeColor: "#101014",
    strokeWidth: 7,
    strokePaintOrder: "under",
    letterSpacing: 1,
    lineHeight: 0.98,
    textAlign: "center"
  }),

  // --- Shapes --------------------------------------------------------------------------------
  // Every shape look is expressible in what `getCompositionShapeStyle` already emits — no new field
  // was added for these, which is the plan's "a schema and presets, not an engine" being true rather
  // than asserted.
  shapePreset("fp-shape-card", "Card", "A soft white panel to sit text on.", {
    color: "#FFFFFF",
    borderRadius: 28,
    strokeWidth: 0,
    shadowColor: "rgba(0,0,0,0.35)",
    shadowBlur: 34,
    shadowOffsetX: 0,
    shadowOffsetY: 14
  }),
  shapePreset("fp-shape-badge", "Badge", "A flat accent pill.", {
    color: "#4D9FFF",
    // Not the CSS `999` idiom — the schema's envelope is 0..500 and `presets:test` rejected 999 on its
    // first run. It is not a clamp worth widening either: `roundRect` limits the radius to half the
    // short side, so 500 is already a full pill for any shape box a comp can hold.
    borderRadius: 500,
    strokeWidth: 0,
    shadowBlur: 0
  }),
  shapePreset("fp-shape-outline", "Outline", "Hollow frame — stroke only.", {
    color: "rgba(0,0,0,0)",
    borderRadius: 12,
    strokeColor: "#FFFFFF",
    strokeWidth: 6,
    shadowBlur: 0
  }),
  shapePreset("fp-shape-glow", "Glow Panel", "Dark panel with a coloured bloom.", {
    color: "#101018",
    borderRadius: 20,
    strokeColor: "#5B7CFA",
    strokeWidth: 2,
    // A shape shadow is gated on BLUR, not on colour (`getShapeShadowCss`), so a hard-offset shape
    // shadow is not expressible today and is not faked here with a 1px blur.
    shadowColor: "rgba(91,124,250,0.55)",
    shadowBlur: 60,
    shadowOffsetX: 0,
    shadowOffsetY: 0
  })
];

/** First-party + user presets for one category, first-party first. */
export function stylePresetsForCategory(
  category: StylePresetCategory,
  userPresets: readonly StylePreset[] = []
): StylePreset[] {
  return [...firstPartyStylePresets, ...userPresets].filter((preset) => preset.category === category);
}
