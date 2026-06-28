import assert from "node:assert/strict";
import { buildRenderManifest } from "@reelforge/render-templates";
import {
  getCompositionMediaStyle,
  getCompositionShapeStyle,
  getCompositionTextStyle,
  type ProjectGraph,
  type SourceAsset,
  type TimelineLayer
} from "@reelforge/shared";

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
