/**
 * Style preset library assertions (ADR-023 S6). Repo convention: no test framework, exits non-zero.
 *
 *   pnpm --filter @orreris/shared presets:test
 *
 * WHAT THIS FILE IS FOR, given that S4's gates already cover capture/apply. Three things S6 adds that
 * nothing else can see:
 *
 * 1. **The library is data somebody wrote by hand**, and a preset with a typo'd key, an out-of-range
 *    number or an enum value the schema does not offer is a look that silently does less than it
 *    says. That is the copy-list defect (T-15) relocated into a data file, so the sweep below checks
 *    every first-party value against the schema field that describes it.
 * 2. **T-20 — no URL is ever project data.** Directly checkable over the whole library, and the trap
 *    a preset format walks into: a look that only renders on the machine that saved it.
 * 3. **OQ8** — first-party presets must be provably shareable, and the account-scoped ones must be
 *    detected by NAME rather than by a boolean somebody has to remember to set.
 *
 * And the assertion the stage is for, at the bottom: a look with a pinned catalogue font, a gradient
 * and an image fill, serialized, carried into a FRESH project, applied to a bare layer — and the
 * emitted style is identical, key for key.
 */

import {
  getCompositionShapeStyle,
  getCompositionTextStyle,
  type CompositionStyleOptions
} from "./composition-style";
import { catalogueFontRef } from "./font-catalogue";
import { propertySchemaField } from "./property-schema";
import { shapeStyleSchema, SHAPE_STYLE_FIELD_KEYS, shapeStylePreset } from "./shape-style-schema";
import {
  applyStylePreset,
  applyStylePresetToTrack,
  captionTrackIdFor,
  captureStylePreset,
  firstPartyStylePresets,
  presetPortability,
  presetReferences,
  readStylePreset,
  stylePresetsForCategory,
  unresolvedPresetReferences,
  type StylePreset
} from "./style-presets";
import { textStyleSchema, TEXT_STYLE_FIELD_KEYS, textStylePreset } from "./text-style-schema";
import type { TimelineComposition, TimelineLayer } from "./types";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function layer(over: Partial<TimelineLayer>): TimelineLayer {
  return {
    id: "l1",
    trackId: "tr1",
    type: "text",
    name: "Text",
    startSeconds: 0,
    durationSeconds: 3,
    text: "Hello world",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
    ...over
  } as TimelineLayer;
}

const emitted = (item: TimelineLayer, options: CompositionStyleOptions = {}) =>
  JSON.stringify(
    item.type === "shape" ? getCompositionShapeStyle(item, options) : getCompositionTextStyle(item, options),
    (_key, value) => (value === undefined ? "<undefined>" : value)
  );

// --- the library is well-formed data ------------------------------------------------------------
{
  const ids = firstPartyStylePresets.map((preset) => preset.id);
  check("library: ids are unique", new Set(ids).size === ids.length);
  check("library: at least 10 caption looks", stylePresetsForCategory("caption").length >= 10);
  check("library: titles and shapes are present too", stylePresetsForCategory("title").length > 0 && stylePresetsForCategory("shape").length > 0);
  check("library: every preset is first-party", firstPartyStylePresets.every((preset) => preset.origin === "first-party"));

  for (const preset of firstPartyStylePresets) {
    const isShape = preset.envelope.schemaId === "shape-style";
    const schema = isShape ? shapeStyleSchema : textStyleSchema;
    const presetable: readonly string[] = isShape ? SHAPE_STYLE_FIELD_KEYS : TEXT_STYLE_FIELD_KEYS;
    const values = preset.envelope.values as Record<string, unknown>;

    check(`${preset.id}: envelope is at the schema's current version`, preset.envelope.version === schema.version);

    // The sweep that makes a hand-written library safe: every key must be a key this schema CARRIES.
    // A key that is merely described (`shapeKind`, `textWidthPercent`) is as wrong here as a typo —
    // it would be dropped by capture and so could never round-trip.
    const strayKeys = Object.keys(values).filter((key) => !presetable.includes(key));
    check(`${preset.id}: every key is a presetable field`, strayKeys.length === 0, strayKeys.join(", "));

    for (const [key, value] of Object.entries(values)) {
      const field = propertySchemaField(schema, key as never);
      if (!field) continue;
      if (field.kind === "enum") {
        const allowed = (field.options ?? []).map((option) => option.value);
        check(`${preset.id}.${key}: enum value is one the schema offers`, allowed.includes(String(value)), String(value));
      }
      if (field.kind === "number" && typeof value === "number") {
        const inRange = (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
        check(`${preset.id}.${key}: number is inside the field's envelope`, inRange, String(value));
      }
      if (field.kind === "color") {
        check(`${preset.id}.${key}: colour is a string`, typeof value === "string");
      }
    }
  }
}

// --- T-20: a URL is never project data ----------------------------------------------------------
{
  // Written as a sweep of the whole serialized library rather than a per-field check, because the
  // failure this guards against is a FUTURE field carrying a resolved URL — exactly what S5b removed
  // from `fillTexture`. A check that only knows today's fields would go quiet the moment one is added.
  const serialized = JSON.stringify(firstPartyStylePresets);
  const urlish = /(https?:)|(data:)|(blob:)|(file:\/\/)/i;
  check("T-20: no first-party preset carries a URL", !urlish.test(serialized));

  const withUrl: StylePreset = {
    id: "leak",
    name: "Leak",
    category: "caption",
    origin: "user",
    envelope: textStylePreset({ fillTextureAssetId: "https://cdn.example/x.png" } as never)
  };
  check("T-20: the URL sweep can actually fail", urlish.test(JSON.stringify([withUrl])));
}

// --- OQ8: what a preset names, and who can resolve it -------------------------------------------
{
  for (const preset of firstPartyStylePresets) {
    const portability = presetPortability(preset);
    check(`${preset.id}: shareable (no account-scoped reference)`, portability.shareable, portability.personal.map((r) => r.label).join(", "));
  }

  // Every text preset must PIN a catalogue face. A first-party look with no `fontRef` renders in
  // whatever the CSS stack resolves to on the render box — the pre-S2 ceiling, reintroduced as a
  // default and invisible until an export lands on a machine without the family.
  for (const preset of firstPartyStylePresets.filter((p) => p.envelope.schemaId === "text-style")) {
    const refs = presetReferences(preset);
    check(`${preset.id}: pins a catalogue font`, refs.some((ref) => ref.kind === "font" && ref.scope === "universal"));
  }

  const userFontPreset: StylePreset = {
    id: "personal",
    name: "My Licensed Look",
    category: "caption",
    origin: "user",
    envelope: textStylePreset({
      fontFamily: "Founders Grotesk, sans-serif",
      fontRef: { source: "user", family: "Founders Grotesk", weight: 700, style: "normal", fileHash: "abc", ownerId: "user_a" }
    } as never)
  };
  const portability = presetPortability(userFontPreset);
  check("OQ8: a user-store font makes a preset unshareable", !portability.shareable);
  check("OQ8: and it is reported BY FAMILY NAME, not as a boolean", portability.personal[0]?.label === "Founders Grotesk");

  check("OQ8: its owner can resolve it", unresolvedPresetReferences(userFontPreset, { viewerId: "user_a" }).length === 0);
  check("OQ8: another account cannot, and is told which family", unresolvedPresetReferences(userFontPreset, { viewerId: "user_b" })[0]?.label === "Founders Grotesk");

  // The half OQ8 did not anticipate: S5b put a SECOND reference kind in the same envelope, and a
  // project asset is account-scoped for the same reason a user font is. One answer covers both.
  const assetPreset: StylePreset = {
    id: "textured",
    name: "Textured",
    category: "caption",
    origin: "user",
    envelope: textStylePreset({ fillTextureAssetId: "asset_marble" })
  };
  check("OQ8: an image fill is an account-scoped reference too", !presetPortability(assetPreset).shareable);
  check(
    "OQ8: unresolvable for a viewer without the asset",
    unresolvedPresetReferences(assetPreset, { hasAsset: () => false })[0]?.label === "asset_marble"
  );
  check("OQ8: resolvable for one who has it", unresolvedPresetReferences(assetPreset, { hasAsset: () => true }).length === 0);
  // "Cannot tell" must report nothing — a warning that fires on every apply because the caller never
  // wired the lookup is a warning people learn to click through.
  check("OQ8: no lookup wired = no warning", unresolvedPresetReferences(assetPreset, {}).length === 0);

  // A legacy CSS stack names no store, so it is not a reference. Reporting it would flag every
  // pre-S2 look as unportable while changing nothing about what it renders.
  const legacyPreset: StylePreset = {
    id: "legacy",
    name: "Legacy",
    category: "caption",
    origin: "user",
    envelope: textStylePreset({ fontFamily: "Impact, sans-serif" })
  };
  check("OQ8: a CSS stack is not a reference", presetReferences(legacyPreset).length === 0 && presetPortability(legacyPreset).shareable);
}

// --- T-15: every preset MOVES THE PICTURE -------------------------------------------------------
{
  // The S4 lesson at library scale. Asserting the values were copied would only prove the object
  // literal works; the far end is the function both renderers take their pixels from.
  const bareText = layer({});
  const bareShape = layer({ type: "shape", text: undefined });
  const bareTextCss = emitted(bareText);
  const bareShapeCss = emitted(bareShape);

  for (const preset of firstPartyStylePresets) {
    const target = preset.envelope.schemaId === "shape-style" ? bareShape : bareText;
    const before = preset.envelope.schemaId === "shape-style" ? bareShapeCss : bareTextCss;
    const result = applyStylePreset(target, preset);
    check(`${preset.id}: applies`, result.ok, result.ok ? "" : result.reason);
    if (result.ok) check(`${preset.id}: changes the emitted style`, emitted(result.layer) !== before);
  }

  // The negative arm, and it is not ceremony: it is what proves the check above is discriminating
  // rather than reporting "different" because apply rewrites the object.
  const empty: StylePreset = { id: "noop", name: "No-op", category: "caption", origin: "user", envelope: textStylePreset({}) };
  const noop = applyStylePreset(bareText, empty);
  check("falsifier: an empty preset changes nothing", noop.ok && emitted(noop.layer) === bareTextCss);
}

// --- absence survives apply (D1a) ---------------------------------------------------------------
{
  const target = layer({ direction: "rtl", strokePaintOrder: "under" });
  const preset: StylePreset = {
    id: "partial",
    name: "Partial",
    category: "caption",
    origin: "user",
    envelope: textStylePreset({ color: "#FF0000" })
  };
  const result = applyStylePreset(target, preset);
  check("D1a: a key the preset does not carry is not written", result.ok && result.layer.direction === "rtl" && result.layer.strokePaintOrder === "under");

  const bare = layer({});
  const applied = applyStylePreset(bare, preset);
  check("D1a: and an absent key stays absent on the target", applied.ok && !("direction" in applied.layer));
}

// --- the two schemas do not paste into each other -----------------------------------------------
{
  const textish = firstPartyStylePresets.find((p) => p.envelope.schemaId === "text-style")!;
  const shapish = firstPartyStylePresets.find((p) => p.envelope.schemaId === "shape-style")!;
  check("a text look refuses a shape layer", !applyStylePreset(layer({ type: "shape" }), textish).ok);
  check("a shape look refuses a text layer", !applyStylePreset(layer({}), shapish).ok);

  const alien: StylePreset = {
    id: "alien",
    name: "Alien",
    category: "caption",
    origin: "user",
    envelope: { schemaId: "grade-intent", version: 1, values: {} } as never
  };
  check("an unknown schema is refused with a reason", !readStylePreset(alien).ok);

  const future: StylePreset = {
    id: "future",
    name: "From the future",
    category: "caption",
    origin: "user",
    envelope: { ...textStylePreset({ color: "#fff" }), version: textStyleSchema.version + 1 }
  };
  const read = readStylePreset(future);
  check("a newer schema version is refused, not half-applied", !read.ok && /newer than this build/.test(read.ok ? "" : read.reason));
}

// --- captions: one call over the whole track ----------------------------------------------------
{
  const composition: TimelineComposition = {
    id: "comp1",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 6,
    tracks: [
      {
        id: "comp1_track_captions",
        type: "video",
        name: "Captions",
        layers: [
          layer({ id: "c1", trackId: "comp1_track_captions", text: "one", startSeconds: 0 }),
          layer({ id: "c2", trackId: "comp1_track_captions", text: "two", startSeconds: 1.5 }),
          layer({ id: "c3", trackId: "comp1_track_captions", type: "shape", text: undefined })
        ]
      }
    ]
  } as TimelineComposition;

  const preset = firstPartyStylePresets.find((p) => p.id === "fp-caption-pill")!;
  const result = applyStylePresetToTrack(composition, captionTrackIdFor(composition), preset);
  check("captions: the track id matches what applyCaptionTrackToComposition builds", captionTrackIdFor(composition) === "comp1_track_captions");
  check("captions: applied to both text layers, skipping the shape", result.ok && result.applied === 2);
  if (result.ok) {
    const layers = result.composition.tracks[0]!.layers;
    check("captions: every caption took the look", layers[0]!.backgroundPerLine === true && layers[1]!.backgroundPerLine === true);
    check("captions: text and timing are untouched", layers[0]!.text === "one" && layers[1]!.startSeconds === 1.5);
    check("captions: the shape layer was left alone", layers[2]!.backgroundPerLine === undefined);
  }
  check("captions: a missing track is a reason, not a throw", !applyStylePresetToTrack(composition, "nope", preset).ok);
}

// --- THE STAGE ASSERTION ------------------------------------------------------------------------
// Save a look with a pinned catalogue font, a gradient fill and an image fill; carry it to a FRESH
// project as JSON; apply it to a bare layer; get the same render.
{
  const ASSET = "asset_marble";
  const options: CompositionStyleOptions = { resolveAssetUrl: (id) => (id === ASSET ? "blob:project-b/marble" : undefined) };
  // Project A resolves the same asset to a DIFFERENT url — which is the point of T-20. If the preset
  // carried a url instead of an id, the two projects would render differently here and this
  // assertion would be the thing that noticed.
  const optionsA: CompositionStyleOptions = { resolveAssetUrl: (id) => (id === ASSET ? "blob:project-a/marble" : undefined) };

  const authored = layer({
    fontFamily: "Anton, Impact, sans-serif",
    fontRef: catalogueFontRef("Anton", 400),
    fontSize: 88,
    color: "#F5C542",
    fillGradientFrom: "#FFF1B8",
    fillGradientTo: "#A9700B",
    fillGradientAngle: 200,
    fillTextureAssetId: ASSET,
    fillTextureFit: "tile",
    fillTextureScale: 2.5,
    strokeColor: "#2B1B00",
    strokeWidth: 6,
    strokePaintOrder: "under",
    backgroundColor: "#111114",
    backgroundPerLine: true,
    shadowColor: "#000000",
    shadowBlur: 0,
    shadowOffsetX: 3,
    shadowOffsetY: 3,
    shadowLayers: 6
  });

  const saved = captureStylePreset(authored, "Marble Gold");
  // Through JSON, because that is how a preset actually travels — a structural clone would prove
  // nothing about what survives serialization.
  const travelled = JSON.parse(JSON.stringify(saved)) as StylePreset;

  const fresh = layer({ id: "fresh", trackId: "other", text: "Hello world" });
  const applied = applyStylePreset(fresh, travelled);
  check("stage: the saved look applies in a fresh project", applied.ok, applied.ok ? "" : applied.reason);
  if (applied.ok) {
    check(
      "STAGE ASSERTION: same render — emitted style is identical, key for key",
      emitted(applied.layer, options) === emitted(authored, options)
    );
    check("stage: the pinned catalogue font travelled", applied.layer.fontRef?.source === "catalogue");
    check("stage: the gradient travelled", applied.layer.fillGradientFrom === "#FFF1B8" && applied.layer.fillGradientAngle === 200);
    check("stage: the image fill travelled as an ID", applied.layer.fillTextureAssetId === ASSET);
    check("stage: and it resolves per project, not per preset", emitted(applied.layer, optionsA) !== emitted(applied.layer, options));

    // The degradation, stated rather than assumed: in a project that does NOT have the asset, the
    // fill drops out (S5b's byte-identical unresolvable arm) and the viewer is told which id, by
    // name, at apply time rather than at the render boundary.
    const withoutAsset = emitted(applied.layer, { resolveAssetUrl: () => undefined });
    const noFill = emitted({ ...applied.layer, fillTextureAssetId: undefined }, options);
    check("stage: without the asset, the fill degrades to no fill", withoutAsset === noFill);
    check(
      "stage: and the missing asset is named at apply time",
      unresolvedPresetReferences(travelled, { hasAsset: (id) => id !== ASSET })[0]?.label === ASSET
    );
  }
}

// --- shape looks round-trip the same way --------------------------------------------------------
{
  const authored = layer({ type: "shape", text: undefined, color: "#22D3EE", borderRadius: 40, strokeColor: "#0B1020", strokeWidth: 8, shadowBlur: 30, shadowOffsetY: 10 });
  const saved = captureStylePreset(authored, "Cyan Card");
  check("shape: capture picks the shape schema off the layer type", saved.envelope.schemaId === "shape-style");
  const travelled = JSON.parse(JSON.stringify(saved)) as StylePreset;
  const applied = applyStylePreset(layer({ id: "s2", type: "shape", text: undefined }), travelled);
  check("shape: applies in a fresh project", applied.ok);
  if (applied.ok) check("shape: same render", emitted(applied.layer) === emitted(authored));

  // Identity is not a look: a preset must not turn somebody's ellipse into a rounded rectangle.
  const ellipse = layer({ id: "s3", type: "shape", text: undefined, shapeKind: "ellipse" });
  const onEllipse = applyStylePreset(ellipse, travelled);
  check("shape: shapeKind is NOT carried", onEllipse.ok && onEllipse.layer.shapeKind === "ellipse");
  check("shape: nor is size", !("widthPercent" in (shapeStylePreset({}).values as object)));
}

console.log(failures ? `\n${failures} failing assertion(s)` : "\nall style preset assertions passed");
process.exit(failures ? 1 : 0);
