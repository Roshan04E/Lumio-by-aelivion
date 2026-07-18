import { z } from "zod";
import { actionResult, runMutation } from "../patches";
import { assertLayerExists, findLayer } from "../validation";
import type { TimelineActionDefinition } from "../types";
import { ABSOLUTE_MIN_CLIP_SECONDS, createShapeLayer, createTextLayer, locateLayer, pickTrackForLayer } from "./shared";
import { applyTextStyle } from "../../text-styles";
import { getTextLook, resolveTextLookName, TEXT_LOOK_NAMES } from "../../text-look";

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
  description: "Insert a new text clip.",
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
  description: "Edit the content or style of an existing text clip.",
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
    return actionResult(ctx.composition, mutation, `Update text`);
  }
};

const applyTextLookSchema = z.object({
  layerId: z.string(),
  /** Text-look name — canonical or alias; canonicalized at the write seam. */
  look: z.string().min(1)
});

/**
 * K3 text dialect's execution primitive: bake a named text look (text-look.ts) onto a text
 * layer via `applyTextStyle` — one undoable step, results are ordinary editable layer fields
 * (both renderers already draw them). Same closure discipline as creativeLook params:
 * unknown names fail validation with the library in the message; aliases repair here.
 */
const applyTextLookAction: TimelineActionDefinition<z.infer<typeof applyTextLookSchema>> = {
  id: "applyTextLook",
  name: "Apply text look",
  description: "Style a text clip with a named look preset (Headline, Caption Pill, Lower Third, Neon…).",
  category: "text",
  inputSchema: applyTextLookSchema,
  validationRules: (params, ctx) => {
    const located = findLayer(ctx.composition, params.layerId);
    if (!located) {
      return assertLayerExists(ctx, params.layerId);
    }
    if (located.layer.type !== "text") {
      return [{ code: "wrong_layer_type", message: `Layer "${params.layerId}" is not text`, path: "layerId" }];
    }
    return resolveTextLookName(params.look)
      ? []
      : [
          {
            code: "invalid_text_look",
            message: `"${params.look}" isn't a text look — available: ${TEXT_LOOK_NAMES.join(", ")}`,
            path: "look"
          }
        ];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const resolved = resolveTextLookName(params.look)!;
    const look = getTextLook(resolved.look)!;
    const mutation = runMutation(ctx.composition, (draft) => {
      const located = locateLayer(draft, params.layerId);
      if (!located) {
        return;
      }
      const styled = applyTextStyle(located.layer, look.style);
      located.track.layers[located.layerIndex] = styled;
    });
    return actionResult(
      ctx.composition,
      mutation,
      `Apply "${resolved.look}" text look${resolved.repair ? ` — ${resolved.repair}` : ""}`
    );
  }
};

const addShapeSchema = z.object({
  color: colorSchema.optional(),
  shapeKind: z.enum(["rectangle", "rounded-rectangle", "ellipse", "line", "triangle", "diamond", "pentagon", "pen"]).optional(),
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
  description: "Insert a new shape clip.",
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

export const textActions = [addText, updateText, applyTextLookAction, addShape];
