import assert from "node:assert/strict";
import { buildRenderManifest } from "@orreris/render-templates";
import {
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

// "auto" delegates to the browser's own first-strong rule. We do not implement UBA P2/P3 (T-5).
const autoStyle = getCompositionTextStyle({ ...manifestTextLayer, direction: "auto" });
assert.equal(autoStyle.unicodeBidi, "plaintext", "'auto' must delegate via unicode-bidi: plaintext.");
assert.equal(autoStyle.direction, undefined, "'auto' must NOT pin a direction — plaintext resolves it.");

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
