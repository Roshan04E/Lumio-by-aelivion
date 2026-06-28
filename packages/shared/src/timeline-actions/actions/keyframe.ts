import { z } from "zod";
import { actionResult, runMutation } from "../patches";
import { assertLayerExists, assertKeyframeTarget, findLayer } from "../validation";
import type { TimelineActionDefinition } from "../types";
import { createLayerKeyframe, locateLayer } from "./shared";

const interpolationSchema = z
  .enum(["hold", "linear", "ease", "easeIn", "easeOut", "easeInOut", "bezier", "autoBezier"])
  .optional();

const addKeyframeSchema = z.object({
  layerId: z.string(),
  property: z.enum(["position.x", "position.y", "scale", "rotation", "opacity"]),
  value: z.number(),
  timeSeconds: z.number().min(0).optional(),
  interpolation: interpolationSchema
});

const addKeyframe: TimelineActionDefinition<z.infer<typeof addKeyframeSchema>> = {
  id: "addKeyframe",
  name: "Add keyframe",
  description: "Add an animation keyframe to a layer property (local layer time).",
  category: "keyframe",
  inputSchema: addKeyframeSchema,
  validationRules: (params, ctx) => [...assertLayerExists(ctx, params.layerId), ...assertKeyframeTarget(params.property)],
  canUndo: true,
  execute: (params, ctx) => {
    const located = findLayer(ctx.composition, params.layerId)!;
    const localTime = params.timeSeconds ?? Math.max(0, ctx.nowSeconds - located.layer.startSeconds);
    const keyframe = createLayerKeyframe(
      params.property,
      localTime,
      params.value,
      params.interpolation ?? "linear",
      `${params.layerId}_kf`
    );
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (!layer) {
        return;
      }
      layer.animations = [...(layer.animations ?? []), keyframe];
    });
    return actionResult(ctx.composition, mutation, `Add ${params.property} keyframe`);
  }
};

const updateKeyframeSchema = z
  .object({
    layerId: z.string(),
    keyframeId: z.string(),
    value: z.number().optional(),
    timeSeconds: z.number().min(0).optional(),
    interpolation: interpolationSchema
  })
  .refine((value) => value.value !== undefined || value.timeSeconds !== undefined || value.interpolation !== undefined, {
    message: "Provide value, timeSeconds, or interpolation"
  });

function findAnimation(ctx: { composition: { tracks: { layers: { id: string; animations?: { id: string }[] | undefined }[] }[] } }, layerId: string, keyframeId: string) {
  return ctx.composition.tracks
    .flatMap((track) => track.layers)
    .find((layer) => layer.id === layerId)
    ?.animations?.some((animation) => animation.id === keyframeId);
}

const updateKeyframe: TimelineActionDefinition<z.infer<typeof updateKeyframeSchema>> = {
  id: "updateKeyframe",
  name: "Update keyframe",
  description: "Change an existing keyframe's value, time, or easing.",
  category: "keyframe",
  inputSchema: updateKeyframeSchema,
  validationRules: (params, ctx) => {
    const issues = assertLayerExists(ctx, params.layerId);
    if (issues.length) {
      return issues;
    }
    return findAnimation(ctx, params.layerId, params.keyframeId)
      ? []
      : [{ code: "invalid_keyframe_reference", message: `No keyframe "${params.keyframeId}"`, path: "keyframeId" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const keyframe = locateLayer(draft, params.layerId)?.layer.animations?.find((item) => item.id === params.keyframeId);
      if (!keyframe) {
        return;
      }
      if (params.value !== undefined) keyframe.value = params.value;
      if (params.timeSeconds !== undefined) keyframe.timeSeconds = params.timeSeconds;
      if (params.interpolation !== undefined) keyframe.interpolation = params.interpolation;
    });
    return actionResult(ctx.composition, mutation, `Update keyframe`);
  }
};

const deleteKeyframeSchema = z.object({
  layerId: z.string(),
  keyframeId: z.string()
});

const deleteKeyframe: TimelineActionDefinition<z.infer<typeof deleteKeyframeSchema>> = {
  id: "deleteKeyframe",
  name: "Delete keyframe",
  description: "Remove a keyframe from a layer.",
  category: "keyframe",
  inputSchema: deleteKeyframeSchema,
  validationRules: (params, ctx) => {
    const issues = assertLayerExists(ctx, params.layerId);
    if (issues.length) {
      return issues;
    }
    return findAnimation(ctx, params.layerId, params.keyframeId)
      ? []
      : [{ code: "invalid_keyframe_reference", message: `No keyframe "${params.keyframeId}"`, path: "keyframeId" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (layer?.animations) {
        layer.animations = layer.animations.filter((item) => item.id !== params.keyframeId);
      }
    });
    return actionResult(ctx.composition, mutation, `Delete keyframe`);
  }
};

export const keyframeActions = [addKeyframe, updateKeyframe, deleteKeyframe];
