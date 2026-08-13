import assert from "node:assert/strict";
import { buildRenderManifest } from "@orreris/render-templates";
import {
  collapseLine,
  isTextVisualOrderUnavailable,
  type Word as SceneWord,
  getCompositionMediaStyle,
  getCompositionShapeStyle,
  getCompositionTextStyle,
  type ProjectGraph,
  type SourceAsset,
  type TimelineLayer
} from "@orreris/shared";

const visualLayer: TimelineLayer = {
  id: "video_1",
  trackId: "video_track",
  type: "video",
  name: "Video",
  startSeconds: 0,
  durationSeconds: 4,
  assetId: "asset_1",
  fit: "contain",
  transform: {
    position: { x: 50, y: 52 },
    scale: 1.12,
    rotation: 3,
    opacity: 86
  },
  effects: [],
  keyframes: []
};

const textLayer: TimelineLayer = {
  id: "text_1",
  trackId: "overlay_track",
  type: "text",
  name: "Title",
  startSeconds: 0.5,
  durationSeconds: 2,
  text: "Trust the render",
  color: "#C9FF4A",
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: 88,
  textAlign: "center",
  textWidthPercent: 42,
  strokeColor: "#050608",
  strokeWidth: 2,
  transform: {
    position: { x: 50, y: 28 },
    scale: 1.18,
    rotation: -2,
    opacity: 94
  },
  effects: [{ id: "shadow_1", type: "shadow", name: "Shadow", enabled: true, intensity: 0.8 }],
  keyframes: []
};

const shapeLayer: TimelineLayer = {
  id: "shape_1",
  trackId: "overlay_track",
  type: "shape",
  name: "Badge",
  startSeconds: 1,
  durationSeconds: 1.5,
  color: "#FFDD66",
  transform: {
    position: { x: 50, y: 70 },
    scale: 0.72,
    rotation: 0,
    opacity: 72
  },
  effects: [],
  keyframes: []
};

const asset: SourceAsset = {
  id: "asset_1",
  userId: "user_1",
  fileName: "source.mp4",
  fileType: "video/mp4",
  fileUrl: "/uploads/source.mp4",
  durationSeconds: 4,
  width: 1080,
  height: 1920,
  status: "ready",
  createdAt: new Date(0).toISOString()
};

const graph: ProjectGraph = {
  projectId: "project_render_parity",
  effects: [],
  editableFields: {},
  version: 1,
  composition: {
    id: "composition_render_parity",
    name: "Render parity fixture",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 4,
    backgroundColor: "#000000",
    tracks: [
      {
        id: "overlay_track",
        type: "overlay",
        name: "Overlay",
        layers: [textLayer, shapeLayer]
      },
      {
        id: "video_track",
        type: "video",
        name: "Video",
        layers: [visualLayer]
      }
    ]
  }
};

const manifest = buildRenderManifest({
  projectId: graph.projectId,
  graph,
  assets: [asset],
  quality: "final",
  createdAt: new Date(0).toISOString()
});

const manifestTextLayer = manifest.layers.find((layer) => layer.id === textLayer.id);
const manifestShapeLayer = manifest.layers.find((layer) => layer.id === shapeLayer.id);
const manifestVideoLayer = manifest.layers.find((layer) => layer.id === visualLayer.id);

assert.ok(manifestTextLayer);
assert.ok(manifestShapeLayer);
assert.ok(manifestVideoLayer);

const previewTextStyle = getCompositionTextStyle(textLayer);
const renderTextStyle = getCompositionTextStyle(manifestTextLayer);
assert.equal(previewTextStyle.fontSize, renderTextStyle.fontSize);
assert.equal(renderTextStyle.fontSize, 88);
assert.equal(previewTextStyle.fontFamily, renderTextStyle.fontFamily);
assert.equal(previewTextStyle.maxWidth, renderTextStyle.maxWidth);
assert.equal(previewTextStyle.transform, renderTextStyle.transform);
assert.equal(renderTextStyle.textAlign, "center");
assert.equal(renderTextStyle.width, "42%");
assert.equal(renderTextStyle.WebkitTextStroke, "2px #050608");
assert.equal(renderTextStyle.textShadow, "0px 7px 19px rgba(0,0,0,0.62)");

/**
 * S1 (ADR-023 D7) — assert the EMITTED CSS, not just that the two renderers agree.
 *
 * A `render:compare:pixels` run answers "do the renderers agree?", and both of them would agree
 * perfectly on ignoring `paint-order` entirely: same code, same Chromium, 0.000%, green. That is
 * DEBT-017's blind spot, and a feature whose only evidence is a parity gate has not been shown to
 * do anything. These three assertions pin the actual contract instead.
 *
 * The legacy case is the one that matters most: an absent `strokePaintOrder` must emit NO
 * declaration at all — not `paint-order: fill stroke`, which would be equivalent to today's render
 * and still change every existing project's emitted CSS.
 */
assert.equal(renderTextStyle.paintOrder, undefined, "absent strokePaintOrder must emit no paint-order at all.");
assert.equal(
  getCompositionTextStyle({ ...manifestTextLayer, strokePaintOrder: "under" }).paintOrder,
  "stroke fill",
  "strokePaintOrder 'under' must emit paint-order: stroke fill."
);
assert.equal(
  getCompositionTextStyle({ ...manifestTextLayer, strokePaintOrder: "over" }).paintOrder,
  undefined,
  "an explicit 'over' is the legacy look and must also emit nothing."
);
// A paint order with no stroke to order is not a look, and emitting it would put a live declaration
// on layers that have no outline — the widest possible blast radius for the smallest possible gain.
assert.equal(
  getCompositionTextStyle({ ...manifestTextLayer, strokePaintOrder: "under", strokeWidth: 0 }).paintOrder,
  undefined,
  "no stroke means no paint-order declaration."
);

/**
 * S0b (ADR-023 D6a/T-13) — base direction, asserted as emitted CSS.
 *
 * The plan is explicit that this is the half that matters: both renderers are Chromium and will
 * agree on a wrong answer as readily as a right one, and a pure-Arabic run still resolves to correct
 * VISUAL order under `ltr`, so a pixel fixture is clean while the render is wrong to anyone who
 * reads the script. Only the emitted declarations can distinguish the states.
 */
// Legacy: absent emits NEITHER property. Not `direction: ltr` — that renders the same and changes
// every existing project's CSS, which is precisely the migration D6a refuses to perform.
assert.equal(renderTextStyle.direction, undefined, "absent direction must emit no `direction`.");
assert.equal(renderTextStyle.unicodeBidi, undefined, "absent direction must emit no `unicode-bidi`.");

/**
 * S0c (ADR-023 T-13 CORRECTED) — `"auto"` is RESOLVED, once, in shared, and both paths are handed
 * the same concrete answer. S0b delegated it to `unicode-bidi: plaintext`, which a CSS box honours
 * and a canvas cannot express at all, so the raster — the path BOTH renderers take for pixels — drew
 * every `"auto"` layer `ltr`. These two assertions are the ones that failed before this stage.
 */
const autoLatin = getCompositionTextStyle({ ...manifestTextLayer, direction: "auto" });
assert.equal(autoLatin.direction, "ltr", "'auto' over Latin must RESOLVE to ltr, not defer to plaintext.");
assert.equal(autoLatin.unicodeBidi, "isolate");
const autoArabic = getCompositionTextStyle({ ...manifestTextLayer, direction: "auto", text: "مرحبا بالعالم" });
assert.equal(autoArabic.direction, "rtl", "'auto' over Arabic must resolve to rtl — this is the stage's whole point.");
assert.equal(autoArabic.unicodeBidi, "isolate");
// Neutrals are not strong: a layer that opens with a digit or a bracket takes its direction from the
// first strong character, exactly as UBA P2/P3 does — we consume S0's detector, we do not re-derive.
assert.equal(getCompositionTextStyle({ ...manifestTextLayer, direction: "auto", text: "\"123 — مرحبا" }).direction, "rtl");
// Resolution reads the FULL text, never the typewriter-visible slice: direction must not flip
// mid-reveal because the first strong character has not been typed yet.
assert.equal(
  getCompositionTextStyle({ ...manifestTextLayer, direction: "auto", text: "مرحبا بالعالم", textRevealProgress: 0.1 } as never).direction,
  "rtl",
  "'auto' must resolve against the whole text, not the revealed prefix."
);

// Explicit directions are stated and ISOLATED, so a layer neither leaks its level into the
// surrounding editor DOM nor inherits one from it.
const rtlStyle = getCompositionTextStyle({ ...manifestTextLayer, direction: "rtl" });
assert.equal(rtlStyle.direction, "rtl");
assert.equal(rtlStyle.unicodeBidi, "isolate");
const ltrStyle = getCompositionTextStyle({ ...manifestTextLayer, direction: "ltr" });
assert.equal(ltrStyle.direction, "ltr");
assert.equal(ltrStyle.unicodeBidi, "isolate");

// Unreadable input takes the legacy answer, not a guess — "I could not read it" and "it said
// something else" must resolve the same way (the colour pipeline's rule).
const bogusStyle = getCompositionTextStyle({ ...manifestTextLayer, direction: "sideways" as never });
assert.equal(bogusStyle.direction, undefined);
assert.equal(bogusStyle.unicodeBidi, undefined);

// Logical alignment passes through to CSS, which resolves it against `direction`. Physical values
// stay physical, forever.
assert.equal(getCompositionTextStyle({ ...manifestTextLayer, textAlign: "start" }).textAlign, "start");
assert.equal(getCompositionTextStyle({ ...manifestTextLayer, textAlign: "end" }).textAlign, "end");
assert.equal(getCompositionTextStyle({ ...manifestTextLayer, textAlign: "left" }).textAlign, "left");

/**
 * T-15's structural half, asserted rather than assumed: the manifest's style bag must actually
 * CARRY the new field. S1's near-miss was exactly this — the field existed, both renderers read the
 * bag, and the bag never had it. The bag is now derived from a key set with a compile-time
 * exhaustiveness constraint, so this assertion is a second lock on the same door rather than the
 * only one.
 */
const directionLayer = { ...textLayer, direction: "rtl" as const, textAlign: "end" as const };
const directionGraph = {
  ...graph,
  composition: {
    ...graph.composition!,
    tracks: graph.composition!.tracks.map((track) => ({
      ...track,
      layers: track.layers.map((l) => (l.id === textLayer.id ? directionLayer : l))
    }))
  }
};
const directionManifest = buildRenderManifest({
  projectId: graph.projectId,
  graph: directionGraph,
  assets: [asset],
  quality: "final",
  createdAt: new Date(0).toISOString()
});
const directionManifestLayer = directionManifest.layers.find((l) => l.id === textLayer.id);
assert.ok(directionManifestLayer);
assert.equal(
  (directionManifestLayer.style as Record<string, unknown>).direction,
  "rtl",
  "the manifest's style bag must carry `direction` — a field the renderers never receive is a field they cannot honour."
);
assert.equal((directionManifestLayer.style as Record<string, unknown>).textAlign, "end");
assert.equal(getCompositionTextStyle(directionManifestLayer).direction, "rtl", "and it must survive the round trip.");

/**
 * S0c (ADR-023 T-13a) — the case the raster CANNOT draw in visual order, and therefore must
 * announce. Uniform lines collapse to one `fillText` and reorder; a two-style line has to be placed
 * run by run, logically. The predicate is what drives the editor marker, so it is asserted here
 * rather than left to the browser gate.
 */
// Latin: two styles, but nothing to reorder — no marker, or every bold word in the product earns one.
assert.equal(
  isTextVisualOrderUnavailable({ textRuns: [{ text: "Hello " }, { text: "world", bold: true }] }),
  false
);
// Arabic split into two runs that share a style is still one drawable line.
assert.equal(isTextVisualOrderUnavailable({ textRuns: [{ text: "مرحبا " }, { text: "بالعالم" }] }), false);
// Arabic with a genuinely different style on the second run: cannot be reordered, must be announced.
assert.equal(
  isTextVisualOrderUnavailable({ textRuns: [{ text: "مرحبا " }, { text: "بالعالم", color: "#ff0000" }] }),
  true
);
assert.equal(isTextVisualOrderUnavailable({ text: "مرحبا بالعالم" }), false, "one run is never the multi-run case.");

/**
 * S0c (ADR-023 T-13a) — the raster's line collapse, asserted directly.
 *
 * This is the property the whole stage rests on: a line drawn as one `fillText` is the only line the
 * engine can reorder. It gets a pure-function assertion rather than a pixel arm because there is no
 * pixel-invisible way to force the run-by-run path (see the note in `text-direction-falsifier.ts`) —
 * and because a millisecond assertion that names the defect beats a two-minute render that cannot.
 */
const w = (text: string, over: Partial<SceneWord> = {}): SceneWord =>
  ({ text, font: "700 90px Inter", color: "#fff", background: undefined, fontSize: 90, space: false, ...over });

// The common case — captions and titles. Three tokens in, one drawable string out.
assert.deepEqual(
  collapseLine([w("مرحبا"), w("Brand"), w("بالعالم؟")]).map((piece) => piece.text),
  ["مرحبا Brand بالعالم؟"],
  "a single-style line must collapse to ONE token, or the engine never gets to reorder it."
);
// A genuinely different-looking run cannot be collapsed — canvas 2D has no per-character visual
// positions to place the second run at. It stays a token list, and the editor marks the layer.
assert.equal(collapseLine([w("مرحبا"), w("Brand", { color: "#f00" })]).length, 2);
assert.equal(collapseLine([w("a"), w("b", { font: "400 40px Inter" })]).length, 2);
assert.equal(collapseLine([w("a"), w("b", { background: "#ff0" })]).length, 2);
// Degenerate inputs are returned untouched rather than reshaped.
assert.equal(collapseLine([]).length, 0);
assert.equal(collapseLine([w("solo")])[0]!.text, "solo");

const previewShapeStyle = getCompositionShapeStyle(shapeLayer);
const renderShapeStyle = getCompositionShapeStyle(manifestShapeLayer);
assert.equal(previewShapeStyle.width, renderShapeStyle.width);
assert.equal(renderShapeStyle.width, "44%");
assert.equal(renderShapeStyle.height, "18%");
assert.equal(renderShapeStyle.borderRadius, 22);
assert.equal(previewShapeStyle.transform, renderShapeStyle.transform);

const previewMediaStyle = getCompositionMediaStyle(visualLayer);
const renderMediaStyle = getCompositionMediaStyle(manifestVideoLayer);
assert.equal(previewMediaStyle.objectFit, renderMediaStyle.objectFit);
assert.equal(renderMediaStyle.objectFit, "contain");
assert.equal(previewMediaStyle.left, renderMediaStyle.left);
assert.equal(previewMediaStyle.top, renderMediaStyle.top);
assert.equal(previewMediaStyle.transform, renderMediaStyle.transform);

console.log("Render comparison contract passed.");
