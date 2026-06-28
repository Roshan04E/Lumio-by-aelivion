import { z } from "zod";
import { actionResult, runMutation } from "../patches";
import { assertLayerExists, findLayer } from "../validation";
import type { TimelineActionDefinition } from "../types";
import { ABSOLUTE_MIN_CLIP_SECONDS, createShapeLayer, createTextLayer, locateLayer, pickTrackForLayer } from "./shared";

const colorSchema = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Expected a hex color like #ff0000");

const addTextSchema = z.object({
  text: z.string().min(1).max(500),
  color: colorSchema.optional(),
  size: z.number().min(4).max(800).optional(),
  fontFamily: z.string().max(120).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  trackId: z.string().optional(),
  startSeconds: z.number().min(0).optional(),
  durationSeconds: z.number().min(ABSOLUTE_MIN_CLIP_SECONDS).optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional()
});

const addText: TimelineActionDefinition<z.infer<typeof addTextSchema>> = {
  id: "addText",
  name: "Add text",
  description: "Insert a new text layer.",
  category: "text",
  inputSchema: addTextSchema,
  validationRules: (params, ctx) =>
    params.trackId && !ctx.composition.tracks.some((track) => track.id === params.trackId)
      ? [{ code: "invalid_track_reference", message: `No track "${params.trackId}"`, path: "trackId" }]
      : [],
  canUndo: true,
  execute: (params, ctx) => {
    const track = pickTrackForLayer(ctx.composition, "text", params.trackId);
    if (!track) {
      throw new Error("No track available for text");
    }
    const layer = createTextLayer(track, ctx.composition, ctx.nowSeconds, params);
    const mutation = runMutation(ctx.composition, (draft) => {
      const target = draft.tracks.find((item) => item.id === track.id);
      target?.layers.push(layer);
    });
    return actionResult(ctx.composition, mutation, `Add text "${params.text.slice(0, 32)}"`);
  }
};

const updateTextSchema = z.object({
  layerId: z.string(),
  text: z.string().max(500).optional(),
  color: colorSchema.optional(),
  size: z.number().min(4).max(800).optional(),
  fontFamily: z.string().max(120).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  // Spatial reposition of an existing text layer (0–100 % of frame). Lets the
  // planner answer "put the selected text in the center" without a new layer.
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional()
});

const updateText: TimelineActionDefinition<z.infer<typeof updateTextSchema>> = {
  id: "updateText",
  name: "Update text",
  description: "Edit the content or style of an existing text layer.",
  category: "text",
  inputSchema: updateTextSchema,
  validationRules: (params, ctx) => {
    const located = findLayer(ctx.composition, params.layerId);
    if (!located) {
      return assertLayerExists(ctx, params.layerId);
    }
    return located.layer.type === "text"
      ? []
      : [{ code: "wrong_layer_type", message: `Layer "${params.layerId}" is not text`, path: "layerId" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const located = locateLayer(draft, params.layerId);
      if (!located) {
        return;
      }
      const { layer } = located;
      if (params.text !== undefined) layer.text = params.text;
      if (params.color !== undefined) layer.color = params.color;
      if (params.size !== undefined) layer.fontSize = params.size;
      if (params.fontFamily !== undefined) layer.fontFamily = params.fontFamily;
      if (params.bold !== undefined) layer.fontWeight = params.bold ? 900 : 400;
      if (params.italic !== undefined) layer.italic = params.italic;
      if (params.align !== undefined) layer.textAlign = params.align;
      if (params.x !== undefined) layer.transform.position.x = params.x;
      if (params.y !== undefined) layer.transform.position.y = params.y;
    });
    return actionResult(ctx.composition, mutation, `Update text layer`);
  }
};

const addShapeSchema = z.object({
  color: colorSchema.optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  widthPercent: z.number().min(1).max(100).optional(),
  heightPercent: z.number().min(1).max(100).optional(),
  // High cap so a large circle/pill can request a radius ≥ half its pixel size (CSS
  // clamps to a full round). px units, like the renderer reads it.
  borderRadius: z.number().min(0).max(10000).optional(),
  trackId: z.string().optional(),
  startSeconds: z.number().min(0).optional(),
  durationSeconds: z.number().min(ABSOLUTE_MIN_CLIP_SECONDS).optional()
});

const addShape: TimelineActionDefinition<z.infer<typeof addShapeSchema>> = {
  id: "addShape",
  name: "Add shape",
  description: "Insert a new shape layer.",
  category: "text",
  inputSchema: addShapeSchema,
  validationRules: (params, ctx) =>
    params.trackId && !ctx.composition.tracks.some((track) => track.id === params.trackId)
      ? [{ code: "invalid_track_reference", message: `No track "${params.trackId}"`, path: "trackId" }]
      : [],
  canUndo: true,
  execute: (params, ctx) => {
    const track = pickTrackForLayer(ctx.composition, "shape", params.trackId);
    if (!track) {
      throw new Error("No track available for shape");
    }
    const layer = createShapeLayer(track, ctx.composition, ctx.nowSeconds, params);
    const mutation = runMutation(ctx.composition, (draft) => {
      draft.tracks.find((item) => item.id === track.id)?.layers.push(layer);
    });
    return actionResult(ctx.composition, mutation, `Add shape`);
  }
};

export const textActions = [addText, updateText, addShape];
