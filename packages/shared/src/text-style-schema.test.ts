/**
 * `text-style` schema + envelope assertions (ADR-023 S4). Repo convention: no test framework, exits
 * non-zero on failure.
 *
 *   pnpm --filter @orreris/shared textstyle:schema
 *
 * The load-bearing half of this file is the T-15 section. ADR-023 T-15 says every text field ships
 * with a falsifier — flip it and prove the RENDER changes — because a field that never reaches the
 * data is invisible to a parity gate: both renderers agree perfectly about the answer neither was
 * given. S4 moves fields through a new path (capture → envelope → apply), so each one needs proving
 * again at the far end, and the far end is `getCompositionTextStyle` — the function every renderer in
 * the repo takes its text pixels from. Asserting `values.fontRef` was copied would only prove the
 * object literal works; asserting the target's emitted `fontFamily` CHANGED proves the picture moves.
 *
 * `fontRef` and `direction` are the two that matter most here: both were absent from the pre-S4
 * hand-written copy list, so before this stage a saved look silently dropped its pinned font and its
 * base direction.
 */

import {
  compositionTextDefaults,
  getCompositionTextLinePillStyle,
  getCompositionShapeStyle,
  getCompositionTextRunStyle,
  getCompositionTextStyle
} from "./composition-style";
import {
  isInterpolablePropertyKind,
  migratePropertyValues,
  propertySchemaDefaults,
  propertySchemaPresetKeys
} from "./property-schema";
import {
  TEXT_STYLE_FIELD_KEYS,
  TEXT_STYLE_SCHEMA_VERSION,
  textStyleSchema,
  textStylePreset
} from "./text-style-schema";
import {
  applyTextStyle,
  captureTextStyle,
  captureTextStylePreset,
  normalizeTextStylePreset,
  readTextStylePreset
} from "./text-styles";
import type { FontRef } from "./fonts";
import type { TimelineLayer } from "./types";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

function textLayer(over: Partial<TimelineLayer>): TimelineLayer {
  return {
    id: "t1",
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

/** S5b: the project image a glyph fill references, and the app-side resolution the renderer is given. */
const FIXTURE_ASSET_ID = "asset_checker";
const FIXTURE_ASSET_URL = "data:image/png;base64,AAAA";
const resolveFixtureAsset = (assetId: string) => (assetId === FIXTURE_ASSET_ID ? FIXTURE_ASSET_URL : undefined);

const pinnedInter: FontRef = {
  source: "catalogue",
  family: "Inter",
  fileHash: "hash-inter-700",
  weight: 700,
  italic: false,
  fontFamily: "Inter"
};
const pinnedLora: FontRef = {
  source: "catalogue",
  family: "Lora",
  fileHash: "hash-lora-400",
  weight: 400,
  italic: false,
  fontFamily: "Lora"
};

// --- the schema describes what it claims to describe -------------------------------------------
{
  check("schema: id and version", textStyleSchema.id === "text-style" && textStyleSchema.version === TEXT_STYLE_SCHEMA_VERSION);
  check("schema: every field names a declared group", textStyleSchema.fields.every((field) => textStyleSchema.groups.some((group) => group.id === field.group)));
  check("schema: no duplicate field keys", new Set(textStyleSchema.fields.map((f) => f.key)).size === textStyleSchema.fields.length);
  check(
    "schema: only frozen ADR-003 kinds",
    textStyleSchema.fields.every((field) =>
      ["number", "boolean", "text", "enum", "color", "vector", "transform", "gradient", "list", "reference", "file", "curve", "colorCurves", "colorWheels", "spline", "control", "custom"].includes(field.kind)
    )
  );
  check("schema: font is a reference/font, not a new kind", textStyleSchema.fields.find((f) => f.key === "fontRef")?.refType === "font");
  check("schema: preset keys are the derived list", propertySchemaPresetKeys(textStyleSchema).length === TEXT_STYLE_FIELD_KEYS.length);
  check("schema: textWidthPercent is described but not presetable", textStyleSchema.fields.some((f) => f.key === "textWidthPercent" && !f.presetable));

  // D1a: nothing may hand out a default for a field whose absence is permanent state.
  const defaults = propertySchemaDefaults(textStyleSchema);
  check("schema: no default for fontRef (absence is legacy, permanently)", !("fontRef" in defaults));
  check("schema: no default for direction", !("direction" in defaults));
  check("schema: no default for strokePaintOrder", !("strokePaintOrder" in defaults));
  // S5: all five new fields are absent-means-legacy, so none of them may hand out a default either.
  check(
    "schema: no defaults for the S5 fields",
    !("fillGradientFrom" in defaults) &&
      !("fillGradientTo" in defaults) &&
      !("fillGradientAngle" in defaults) &&
      !("backgroundPerLine" in defaults) &&
      !("shadowLayers" in defaults)
  );
  // S5 is where a `gradient` kind would have been reached for. It was not, and the taxonomy assertion
  // above only proves the kinds are legal — this one proves the escape hatches stayed shut.
  check(
    "schema: S5 added no escape-hatch field (no `control`/`custom` in the schema at all)",
    textStyleSchema.fields.every((field) => field.kind !== "control" && field.kind !== "custom")
  );
  check("schema: fontSize default is the RENDER fallback, not the authoring default", defaults.fontSize === 64);
}

// --- capture / apply keep their old contract ----------------------------------------------------
{
  const source = textLayer({ fontFamily: "Futura", fontSize: 80, color: "#ff0000", strokeWidth: 4, textAlign: "center" });
  const style = captureTextStyle(source);
  check("capture: keeps set look fields", style.fontFamily === "Futura" && style.fontSize === 80 && style.color === "#ff0000");
  check("capture: drops unset fields (no undefined keys)", !("lineHeight" in style) && !("shadowBlur" in style));
  check("capture: never carries text CONTENT or transform", !("text" in style) && !("transform" in style));
  check("capture: never carries the box width (placement, not look)", !("textWidthPercent" in style));

  const target = textLayer({ id: "t2", text: "Different words", textWidthPercent: 40, fontFamily: "Arial", fontSize: 32 });
  const out = applyTextStyle(target, style);
  check("apply: look fields overwritten", out.fontFamily === "Futura" && out.fontSize === 80);
  check("apply: text content untouched", out.text === "Different words");
  check("apply: box width untouched", out.textWidthPercent === 40);
}

// --- T-15 FALSIFIERS: flip the field, prove the RENDER answer changes ----------------------------
{
  // fontRef. Pre-S4 this silently did nothing: the copy list did not carry it, so the target kept
  // rendering in its own typeface while the user believed they had pasted a look.
  const source = textLayer({ fontFamily: "Inter", fontRef: pinnedInter, fontWeight: 400 });
  const target = textLayer({ id: "t2", fontFamily: "Lora", fontRef: pinnedLora });
  const before = getCompositionTextStyle(target);
  const after = getCompositionTextStyle(applyTextStyle(target, captureTextStyle(source)));
  check("T-15 fontRef: the emitted family CHANGES when a look is applied", before.fontFamily !== after.fontFamily);
  check("T-15 fontRef: and it changes TO the source's pinned face", after.fontFamily === getCompositionTextStyle(source).fontFamily);
  check("T-15 fontRef: the pinned FILE decides weight, not the copied CSS weight", after.fontWeight === 700);

  // The same falsifier run backwards: a look with no pinned ref must not leave the target's old pin
  // in place, or the paste would be a lie in the other direction.
  const unpinnedSource = textLayer({ fontFamily: "Georgia, serif" });
  const overPinned = applyTextStyle(target, captureTextStyle(unpinnedSource));
  check(
    "T-15 fontRef: pasting an unpinned look clears nothing it did not capture (target keeps its ref)",
    overPinned.fontRef === pinnedLora
  );
}

{
  // direction. Same story: absent from the pre-S4 list, so an RTL look pasted as LTR.
  const source = textLayer({ direction: "rtl", text: "مرحبا بالعالم" });
  const target = textLayer({ id: "t2", text: "مرحبا بالعالم" });
  const before = getCompositionTextStyle(target);
  const after = getCompositionTextStyle(applyTextStyle(target, captureTextStyle(source)));
  check("T-15 direction: absent on the target emits NO direction", before.direction === undefined);
  check("T-15 direction: the emitted direction CHANGES to rtl", after.direction === "rtl" && after.unicodeBidi === "isolate");

  // D1a/D6a: a look captured from a layer that never declared direction must not stamp one on.
  const noDirection = captureTextStyle(textLayer({ fontSize: 40 }));
  const stillAbsent = getCompositionTextStyle(applyTextStyle(textLayer({ id: "t3" }), noDirection));
  check("T-15 direction: an undeclared look leaves absence alone", stillAbsent.direction === undefined);
}

{
  // strokePaintOrder — S1's field, the one that taught the repo this lesson.
  const source = textLayer({ strokeWidth: 10, strokePaintOrder: "under" });
  const target = textLayer({ id: "t2", strokeWidth: 10 });
  const before = getCompositionTextStyle(target);
  const after = getCompositionTextStyle(applyTextStyle(target, captureTextStyle(source)));
  check("T-15 strokePaintOrder: absent emits no paint-order", before.paintOrder === undefined);
  check("T-15 strokePaintOrder: the emitted paint-order CHANGES", after.paintOrder === "stroke fill");
}

// --- S5 (ADR-023 D7): the three looks, each with its absent-is-legacy half asserted ---------------
{
  // Gradient fill. Absent, half-authored, and complete are three DIFFERENT states, and the middle one
  // is the one worth pinning: a stop with no other stop must render as the solid fill, not as a
  // one-colour gradient, and it must emit NOTHING so a legacy layer's CSS is byte-identical.
  const bare = getCompositionTextStyle(textLayer({}));
  check("S5 gradient: absent emits no gradient", bare.textFillGradient === undefined);
  check(
    "S5 gradient: ONE stop still emits nothing (half-authored is not a gradient)",
    getCompositionTextStyle(textLayer({ fillGradientFrom: "#ff0000" })).textFillGradient === undefined &&
      getCompositionTextStyle(textLayer({ fillGradientTo: "#ff0000" })).textFillGradient === undefined
  );
  const full = getCompositionTextStyle(textLayer({ fillGradientFrom: "#ff0000", fillGradientTo: "#0000ff" }));
  check("S5 gradient: both stops emit a linear-gradient", full.textFillGradient === "linear-gradient(180deg, #ff0000, #0000ff)");
  check(
    "S5 gradient: the angle reaches the declaration",
    getCompositionTextStyle(textLayer({ fillGradientFrom: "#ff0000", fillGradientTo: "#0000ff", fillGradientAngle: 45 }))
      .textFillGradient === "linear-gradient(45deg, #ff0000, #0000ff)"
  );
  // The run style is where the DOM path actually paints it — a gradient that never reaches a run span
  // is a gradient nothing renders, which is exactly the T-15 shape.
  const runStyle = getCompositionTextRunStyle({ text: "hi" }, full);
  check("S5 gradient: the run span clips its background to the text", runStyle.WebkitBackgroundClip === "text" && runStyle.backgroundImage === full.textFillGradient);
  check("S5 gradient: and gives up its solid fill colour, or the gradient would be hidden", runStyle.WebkitTextFillColor === "transparent");
  check(
    "S5 gradient: a layer WITHOUT one emits the pre-S5 run style, key for key",
    JSON.stringify(Object.keys(getCompositionTextRunStyle({ text: "hi" }, bare))) ===
      JSON.stringify(["fontWeight", "fontStyle", "color", "backgroundColor", "fontFamily", "fontSize"])
  );
}

{
  // Per-line pill. The claim that needs an assertion is the NO-OP one: asking for per-line pills over
  // a transparent background must leave the block's `background` exactly where it was, or "absent
  // renders as today" quietly stops being true for every layer that has no pill to begin with.
  const noPill = getCompositionTextStyle(textLayer({ backgroundPerLine: true }));
  const legacy = getCompositionTextStyle(textLayer({}));
  check("S5 pill: per-line over a TRANSPARENT background emits no pill", noPill.textLinePill === undefined);
  // Byte-identity, not "the background is still transparent" — that comparison passes even when the
  // block HAS given its background up, because the value it gave up was `"transparent"` either way.
  check("S5 pill: and the whole emitted style is byte-identical to the legacy layer's", JSON.stringify(noPill) === JSON.stringify(legacy));

  const pilled = getCompositionTextStyle(textLayer({ backgroundPerLine: true, backgroundColor: "#101010" }));
  const blocked = getCompositionTextStyle(textLayer({ backgroundColor: "#101010" }));
  check("S5 pill: a real background moves onto the lines", pilled.textLinePill === "0.08em 0.16em 0.1em #101010");
  check("S5 pill: and off the block", pilled.background === "transparent" && blocked.background === "#101010");
  check("S5 pill: the padding the block keeps is the padding the pill uses", pilled.padding === blocked.padding);

  // The colour must survive into the emitted object even though the block gave it up. `scene-text-raster`
  // keys its cache on this object: if the pill colour lived only on the layer, two pills differing only
  // in colour would share a cache key and the second would render as the first, forever.
  const other = getCompositionTextStyle(textLayer({ backgroundPerLine: true, backgroundColor: "#eeeeee" }));
  check("S5 pill: two pill colours produce two DIFFERENT emitted styles (the raster cache key)", JSON.stringify(pilled) !== JSON.stringify(other));

  // Measured in Chrome (`apps/worker/tmp/s5-dom-probe.mjs`): CSS paints LINE BOXES in order, so
  // without this the second line's pill covers the first line's descenders — the same defect the
  // raster's first draft had, arriving in the other renderer for the same structural reason.
  check("S5 pill: the runs paint ABOVE the pill fragments", getCompositionTextRunStyle({ text: "hi" }, pilled).position === "relative");
  check("S5 pill: and a pill-less layer gets no such key", !("position" in getCompositionTextRunStyle({ text: "hi" }, legacy)));

  const pillCss = getCompositionTextLinePillStyle(pilled);
  check("S5 pill: the DOM wrapper clones its box per line fragment", pillCss?.boxDecorationBreak === "clone" && pillCss?.backgroundColor === "#101010");
  check("S5 pill: no pill, no wrapper", getCompositionTextLinePillStyle(legacy) === undefined);
}

{
  // Stacked shadows. One copy must be byte-identical to the declaration emitted before the field
  // existed — not merely equivalent, because that string is part of the raster's cache key.
  const one = getCompositionTextStyle(textLayer({ shadowBlur: 10, shadowOffsetX: 2, shadowOffsetY: 4 }));
  const explicitOne = getCompositionTextStyle(textLayer({ shadowBlur: 10, shadowOffsetX: 2, shadowOffsetY: 4, shadowLayers: 1 }));
  check("S5 stack: absent and 1 emit the same single shadow", one.textShadow === explicitOne.textShadow);
  check("S5 stack: and it is the pre-S5 declaration", one.textShadow === `2px 4px 10px ${compositionTextDefaults.shadowColor}`);

  const three = getCompositionTextStyle(textLayer({ shadowBlur: 10, shadowOffsetX: 2, shadowOffsetY: 4, shadowLayers: 3 }));
  const parts = String(three.textShadow).split(/,(?![^(]*\))/).map((p) => p.trim());
  check("S5 stack: three copies", parts.length === 3);
  check("S5 stack: at 1x, 2x, 3x the offset, NEAREST first (CSS paints entry 0 on top)", parts[0]!.startsWith("2px 4px ") && parts[1]!.startsWith("4px 8px ") && parts[2]!.startsWith("6px 12px "));
  /**
   * CORRECTED 2026-08-15 (S6). This assertion used to read "zero blur still emits nothing, stack or
   * no stack" — it codified the defect. `shadowLayers` documents itself as "a faked 3D extrude,
   * authored at blur 0", and at blur 0 the emitter returned `undefined` and threw the stack away. The
   * gate agreed with the code because it was written from the code.
   *
   * The three arms below are the corrected contract, and the middle one is the feature.
   */
  check(
    "S5 stack: zero blur + one copy still emits nothing (D1a — every legacy layer resolves here)",
    getCompositionTextStyle(textLayer({ shadowBlur: 0 })).textShadow === undefined
  );
  {
    const extrude = getCompositionTextStyle(textLayer({ shadowBlur: 0, shadowOffsetX: 3, shadowOffsetY: 3, shadowLayers: 8 }));
    const copies = String(extrude.textShadow).split(/,(?![^(]*\))/);
    check("S5 stack: zero blur + a stack + an offset IS the extrude, and emits every copy", copies.length === 8);
    check("S5 stack: at zero blur, so it reads as a slab rather than a smear", copies.every((part) => / 0px /.test(part)));
  }
  check(
    "S5 stack: a stack with NO offset stays silent — N copies exactly behind the glyph paint nothing",
    getCompositionTextStyle(textLayer({ shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, shadowLayers: 8 })).textShadow === undefined
  );
  check("S5 stack: a fractional or negative count is one shadow", getCompositionTextStyle(textLayer({ shadowBlur: 10, shadowLayers: -3 })).textShadow === getCompositionTextStyle(textLayer({ shadowBlur: 10 })).textShadow);
}

{
  // Every presetable field, mechanically: capture a layer where each is set to something non-default
  // and prove the emitted style differs from the bare layer's. A field that changes nothing is a
  // field nobody is listening to (T-15), and this catches the next one without anyone remembering.
  const distinct: Record<string, unknown> = {
    fontFamily: "Georgia, serif",
    fontRef: pinnedInter,
    fontSize: 123,
    fontWeight: 200,
    italic: true,
    letterSpacing: 7,
    lineHeight: 2.5,
    color: "#abcdef",
    strokeColor: "#fedcba",
    strokeWidth: 11,
    strokePaintOrder: "under",
    backgroundColor: "#222222",
    backgroundPaddingEm: 0.9,
    backgroundRadiusEm: 1.1,
    shadowColor: "#00ff00",
    shadowBlur: 33,
    shadowOffsetX: 13,
    shadowOffsetY: 17,
    textAlign: "left",
    direction: "rtl",
    // S5 (ADR-023 D7). The gradient needs BOTH stops before anything is emitted, which is why the
    // co-requisite table below pairs each stop with the other one — a stop swept alone would report
    // "changes nothing", and that report would be true and useless (the S4 note on `strokeColor`).
    fillGradientFrom: "#ff8800",
    fillGradientTo: "#0088ff",
    fillGradientAngle: 45,
    backgroundPerLine: true,
    shadowLayers: 6,
    // S5b (ADR-023). The fill only emits when a resolver can answer for the id — see `styleOptions`
    // below, which is that co-requisite rather than a second kind of one.
    fillTextureAssetId: FIXTURE_ASSET_ID,
    fillTextureFit: "tile",
    fillTextureScale: 4,
    // S8 (ADR-023 D8). The ring's width must exceed the co-requisite inner stroke below, or
    // `resolveOuterStroke` refuses it — which is the feature, not an obstacle to route around.
    strokeOuterColor: "#f5d90a",
    strokeOuterWidth: 40,
    // S8: above MIN_TEXT_PATH_CURVE, or it resolves to 0 and the field would report "changes
    // nothing" — a report about the threshold rather than about the field.
    textPathCurve: 60
  };
  /**
   * Some fields are CONDITIONALLY emitted and provably cannot move anything alone: `WebkitTextStroke`
   * appears only above zero stroke width, and `textShadow` only above zero blur. So the stroke colour
   * and the three shadow parameters are swept with the co-requisite that switches their declaration
   * on — which is a property of the emitted CSS, established by reading it, not a knob turned until
   * the assertion passed. Without the co-requisite these four report "changes nothing", and that
   * report would be true and useless.
   */
  const corequisite: Partial<Record<string, Partial<TimelineLayer>>> = {
    strokeColor: { strokeWidth: 10 },
    strokePaintOrder: { strokeWidth: 10 },
    shadowColor: { shadowBlur: 8 },
    shadowOffsetX: { shadowBlur: 8 },
    shadowOffsetY: { shadowBlur: 8 },
    // S5. `fillGradientAngle` needs a gradient to be an angle OF; each stop needs the other stop; the
    // per-line pill needs a background to move off the block; the shadow stack needs a shadow to
    // stack. Every one of these is a property of the emitted CSS, read out of it, not a knob turned
    // until an assertion went green.
    fillGradientFrom: { fillGradientTo: "#000000" },
    fillGradientTo: { fillGradientFrom: "#000000" },
    fillGradientAngle: { fillGradientFrom: "#000000", fillGradientTo: "#ffffff" },
    backgroundPerLine: { backgroundColor: "#101010" },
    shadowLayers: { shadowBlur: 8, shadowOffsetY: 6 },
    // S5b: fit and scale describe an image, so they need one to describe.
    fillTextureFit: { fillTextureAssetId: FIXTURE_ASSET_ID },
    fillTextureScale: { fillTextureAssetId: FIXTURE_ASSET_ID },
    /**
     * S8: a ring needs something to be a ring AROUND — an inner stroke — and each of its two fields
     * needs the other, exactly as each gradient stop needs its partner. Both co-requisites are read
     * out of `resolveOuterStroke`'s refusals rather than found by turning knobs: no inner stroke
     * means there is no ring to draw, and a width at or under the inner stroke's is a band the inner
     * stroke covers completely.
     */
    strokeOuterColor: { strokeWidth: 10, strokeOuterWidth: 40 },
    strokeOuterWidth: { strokeWidth: 10, strokeOuterColor: "#f5d90a" }
  };
  /**
   * S5b — fields whose emission needs a style OPTION, not another layer field.
   *
   * `fillTexture*` resolves an asset id to a render address through `resolveAssetUrl`, which the app
   * supplies. Without it the emitted style says "no texture" for a layer that names one, and the sweep
   * would report these three as changing nothing — a report that would be true, and would be about the
   * gate rather than about the field.
   */
  const styleOptions: Partial<Record<string, { resolveAssetUrl: (id: string) => string | undefined }>> = {
    fillTextureAssetId: { resolveAssetUrl: resolveFixtureAsset },
    fillTextureFit: { resolveAssetUrl: resolveFixtureAsset },
    fillTextureScale: { resolveAssetUrl: resolveFixtureAsset }
  };

  for (const key of TEXT_STYLE_FIELD_KEYS) {
    const value = distinct[key];
    if (value === undefined) {
      failures += 1;
      console.error(`FAIL  T-15 sweep: no falsifying value declared for "${key}"`);
      continue;
    }
    const extra = corequisite[key] ?? {};
    const opts = styleOptions[key] ?? {};
    const bare = JSON.stringify(getCompositionTextStyle(textLayer({ ...extra }), opts));
    const source = textLayer({ ...extra, [key]: value } as Partial<TimelineLayer>);
    const applied = applyTextStyle(textLayer({ id: "t2", ...extra }), captureTextStyle(source));
    check(`T-15 sweep: "${key}" changes the emitted style`, JSON.stringify(getCompositionTextStyle(applied, opts)) !== bare);
  }
}

// --- S5b: THE assertion the stage exists for -----------------------------------------------------
//
// Save Style, apply to a fresh layer, and the image fill round-trips. This is what was broken:
// `fillTexture` rendered correctly and was absent from `TextStyleFields`, so capture dropped it and a
// saved look re-applied without its fill — with no error, no marker, and no gate able to see it,
// because a field that never reaches the data is a field both renderers agree about perfectly.
{
  const opts = { resolveAssetUrl: resolveFixtureAsset };
  const source = textLayer({ fillTextureAssetId: FIXTURE_ASSET_ID, fillTextureFit: "tile", fillTextureScale: 4 });
  const saved = captureTextStyle(source);
  check(
    "S5b round-trip: Save Style CAPTURES all three fill fields",
    saved.fillTextureAssetId === FIXTURE_ASSET_ID && saved.fillTextureFit === "tile" && saved.fillTextureScale === 4
  );

  const fresh = textLayer({ id: "t2", text: "Different words" });
  const applied = applyTextStyle(fresh, saved);
  check("S5b round-trip: applying it puts the fill on the fresh layer", applied.fillTextureAssetId === FIXTURE_ASSET_ID);
  // The values landing is necessary and not sufficient — the picture is what matters, and the picture
  // is the emitted style every renderer reads.
  check(
    "S5b round-trip: and the fresh layer EMITS the same fill the source does",
    getCompositionTextStyle(applied, opts).fillTexture === getCompositionTextStyle(source, opts).fillTexture
  );
  check(
    "S5b round-trip: which is the resolved image, fit and scale",
    getCompositionTextStyle(applied, opts).fillTexture === `tile 4 ${FIXTURE_ASSET_URL}`
  );
  // The same envelope the clipboard and S6's presets use — the round-trip has to survive JSON, or
  // "Copy Look" is a different feature from "Save Style" (T-10 says it must not be).
  const envelope = JSON.parse(JSON.stringify(captureTextStylePreset(source)));
  const read = readTextStylePreset(envelope);
  check(
    "S5b round-trip: survives the envelope and JSON",
    read.ok && getCompositionTextStyle(applyTextStyle(fresh, read.values), opts).fillTexture === `tile 4 ${FIXTURE_ASSET_URL}`
  );
}

{
  // The DECOMPOSITION's own claims, each of which would otherwise be prose.
  const opts = { resolveAssetUrl: resolveFixtureAsset };
  check("S5b: absent emits no fill", getCompositionTextStyle(textLayer({}), opts).fillTexture === undefined);
  check(
    "S5b: an id with NO resolver emits no fill — shared cannot invent a URL",
    getCompositionTextStyle(textLayer({ fillTextureAssetId: FIXTURE_ASSET_ID })).fillTexture === undefined
  );
  check(
    "S5b: an UNRESOLVABLE id emits no fill (paints the solid colour, does not guess)",
    getCompositionTextStyle(textLayer({ fillTextureAssetId: "gone" }), opts).fillTexture === undefined
  );
  check(
    "S5b: fit and scale default to cover/1 without being written in",
    getCompositionTextStyle(textLayer({ fillTextureAssetId: FIXTURE_ASSET_ID }), opts).fillTexture === `cover 1 ${FIXTURE_ASSET_URL}`
  );
  // The three fields are one look, so the schema has to describe them in the three kinds ADR-003
  // already has — no composite kind, no escape hatch. Asserted, because it is the stage's whole
  // premise and a future edit could quietly reach for `custom` and still pass everything else.
  const fieldOf = (key: string) => textStyleSchema.fields.find((field) => field.key === key);
  check("S5b: the image is a reference/asset", fieldOf("fillTextureAssetId")?.kind === "reference" && fieldOf("fillTextureAssetId")?.refType === "asset");
  check("S5b: the fit is an enum", fieldOf("fillTextureFit")?.kind === "enum");
  check("S5b: the scale is a number", fieldOf("fillTextureScale")?.kind === "number");
  check(
    "S5b: all three are absent-means-legacy",
    ["fillTextureAssetId", "fillTextureFit", "fillTextureScale"].every((key) => fieldOf(key)?.absenceIsMeaningful === true)
  );
  // Shapes paint the same texture through the same resolver — one rule, two draw paths.
  check(
    "S5b: a SHAPE resolves the same fill",
    (getCompositionShapeStyle(textLayer({ type: "shape", fillTextureAssetId: FIXTURE_ASSET_ID }), opts) as Record<string, unknown>).fillTexture ===
      `cover 1 ${FIXTURE_ASSET_URL}`
  );
}

// --- the envelope (T-10) -------------------------------------------------------------------------
{
  const preset = captureTextStylePreset(textLayer({ fontSize: 90, direction: "rtl", fontRef: pinnedInter }));
  check("envelope: carries schema id and version", preset.schemaId === "text-style" && preset.version === TEXT_STYLE_SCHEMA_VERSION);
  check("envelope: survives JSON (clipboard is a string)", JSON.parse(JSON.stringify(preset)).values.fontSize === 90);

  const read = readTextStylePreset(preset);
  check("envelope: reads back at the current version", read.ok && read.values.fontSize === 90 && read.migrated === false);

  const foreign = readTextStylePreset({ ...preset, schemaId: "shape-style" });
  check("envelope: REFUSES another schema's values", !foreign.ok);

  const future = readTextStylePreset({ ...preset, version: TEXT_STYLE_SCHEMA_VERSION + 1 });
  check("envelope: REFUSES values from a newer build", !future.ok);
  check("envelope: refusal explains itself", !future.ok && future.reason.includes("newer"));
}

// --- legacy saved styles adopt losslessly (this is why there is no migration) ---------------------
{
  const legacy = { fontFamily: "Futura", fontSize: 80, color: "#ff0000" };
  const adopted = normalizeTextStylePreset(legacy);
  check("legacy: adopted at the current version", adopted.version === TEXT_STYLE_SCHEMA_VERSION);
  check("legacy: not one value touched", JSON.stringify(adopted.values) === JSON.stringify(legacy));
  check("legacy: no defaults filled in", !("direction" in adopted.values) && !("fontRef" in adopted.values));
  check("legacy: an envelope passes through unchanged", normalizeTextStylePreset(adopted) === adopted);

  // And the render answer is identical to applying the legacy style directly — the S4 refactor is
  // invisible to a project saved before it.
  const target = textLayer({ id: "t2" });
  const direct = getCompositionTextStyle(applyTextStyle(target, legacy));
  const viaEnvelope = getCompositionTextStyle(applyTextStyle(target, readTextStylePreset(adopted).ok ? adopted.values : {}));
  check("legacy: renders identically through the envelope", JSON.stringify(direct) === JSON.stringify(viaEnvelope));
}

// --- the migration runner does what T-10 needs it to ---------------------------------------------
{
  const schema = {
    ...textStyleSchema,
    version: 3,
    migrations: [
      { op: "renameField", from: 1, to: "color", field: "fillColor" },
      { op: "deprecateField", from: 2, field: "legacyGlow" }
    ]
  } as typeof textStyleSchema;

  const old = migratePropertyValues(schema, { schemaId: "text-style", version: 1, values: { fillColor: "#ff0000", legacyGlow: 4 } });
  check("migration: renames forward", old.ok && (old.values as Record<string, unknown>).color === "#ff0000");
  check("migration: drops a deprecated field", old.ok && !("legacyGlow" in (old.values as object)));
  check("migration: reports that it ran", old.ok && old.migrated);

  const newer = migratePropertyValues(schema, { schemaId: "text-style", version: 3, values: { color: "#00ff00" } });
  check("migration: a current-version envelope is left alone", newer.ok && !newer.migrated);

  const collision = migratePropertyValues(schema, { schemaId: "text-style", version: 1, values: { fillColor: "#ff0000", color: "#0000ff" } });
  check("migration: a rename never clobbers the newer name", collision.ok && (collision.values as Record<string, unknown>).color === "#0000ff");
}

// --- S4b: keyframe semantics are the KIND's, not the field's -------------------------------------
//
// ADR-003's consequence is that interpolability is declared once per kind. The way that decision goes
// wrong is not a wrong entry in the table — it is a schema field quietly claiming an animatable track
// for a kind whose values cannot be interpolated, which the renderer would then have to refuse
// per-field. Assert the two can never disagree.
{
  const animatable = textStyleSchema.fields.filter((field) => field.animatableAs);
  check("kinds: there are animatable fields to check", animatable.length > 0);
  const offenders = animatable.filter((field) => !isInterpolablePropertyKind(field.kind));
  check(
    `kinds: no field animates a non-interpolable kind${offenders.length ? ` (${offenders.map((f) => `${f.key}:${f.kind}`).join(", ")})` : ""}`,
    offenders.length === 0
  );
  check("kinds: a reference is not interpolable (half of one font is not a font)", !isInterpolablePropertyKind("reference"));
  check("kinds: a number is", isInterpolablePropertyKind("number"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll text-style schema checks passed (${TEXT_STYLE_FIELD_KEYS.length} preset fields swept).`);
