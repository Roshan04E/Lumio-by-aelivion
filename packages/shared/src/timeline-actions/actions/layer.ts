import { z } from "zod";
import { rippleDeleteLayer } from "../../timeline-ops";
import { actionResult, runMutation, runReplace } from "../patches";
import { assertLayerExists, assertTrackExists, findLayer } from "../validation";
import type { TimelineActionDefinition } from "../types";
import { ABSOLUTE_MIN_CLIP_SECONDS, clamp, freshId, locateLayer, minClipDurationSeconds } from "./shared";

const deleteLayerSchema = z.object({
  layerId: z.string(),
  ripple: z.boolean().optional()
});

const deleteLayer: TimelineActionDefinition<z.infer<typeof deleteLayerSchema>> = {
  id: "deleteLayer",
  name: "Delete layer",
  description: "Remove a layer (optionally closing the gap it leaves).",
  category: "layer",
  inputSchema: deleteLayerSchema,
  validationRules: (params, ctx) => assertLayerExists(ctx, params.layerId),
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = params.ripple
      ? runReplace(ctx.composition, (before) => rippleDeleteLayer(before, params.layerId))
      : runMutation(ctx.composition, (draft) => {
          for (const track of draft.tracks) {
            track.layers = track.layers.filter((layer) => layer.id !== params.layerId);
          }
        });
    return actionResult(ctx.composition, mutation, `Delete layer`);
  }
};

const moveLayerSchema = z
  .object({
    layerId: z.string(),
    startSeconds: z.number().min(0).optional(),
    deltaSeconds: z.number().optional(),
    trackId: z.string().optional()
  })
  .refine((value) => value.startSeconds !== undefined || value.deltaSeconds !== undefined || value.trackId !== undefined, {
    message: "Provide startSeconds, deltaSeconds, or trackId"
  });

const moveLayer: TimelineActionDefinition<z.infer<typeof moveLayerSchema>> = {
  id: "moveLayer",
  name: "Move layer",
  description: "Re-time a layer or move it to another track.",
  category: "layer",
  inputSchema: moveLayerSchema,
  validationRules: (params, ctx) => [
    ...assertLayerExists(ctx, params.layerId),
    ...(params.trackId ? assertTrackExists(ctx, params.trackId) : [])
  ],
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const located = locateLayer(draft, params.layerId);
      if (!located) {
        return;
      }
      const { track, layer, layerIndex } = located;
      if (params.startSeconds !== undefined) {
        layer.startSeconds = clamp(params.startSeconds, 0, Math.max(0, draft.durationSeconds - minClipDurationSeconds(draft)));
      } else if (params.deltaSeconds !== undefined) {
        layer.startSeconds = Math.max(0, layer.startSeconds + params.deltaSeconds);
      }
      if (params.trackId && params.trackId !== track.id) {
        const destination = draft.tracks.find((item) => item.id === params.trackId);
        if (destination) {
          track.layers.splice(layerIndex, 1);
          layer.trackId = destination.id;
          destination.layers.push(layer);
        }
      }
    });
    return actionResult(ctx.composition, mutation, `Move layer`);
  }
};

const replaceAssetSchema = z.object({
  layerId: z.string(),
  assetId: z.string(),
  name: z.string().max(200).optional(),
  durationSeconds: z.number().min(ABSOLUTE_MIN_CLIP_SECONDS).optional()
});

const replaceAsset: TimelineActionDefinition<z.infer<typeof replaceAssetSchema>> = {
  id: "replaceAsset",
  name: "Replace asset",
  description: "Swap the media behind a layer, keeping its placement.",
  category: "layer",
  inputSchema: replaceAssetSchema,
  validationRules: (params, ctx) => {
    const located = findLayer(ctx.composition, params.layerId);
    if (!located) {
      return assertLayerExists(ctx, params.layerId);
    }
    return located.layer.type === "video" || located.layer.type === "image"
      ? []
      : [{ code: "wrong_layer_type", message: `Layer "${params.layerId}" is not media`, path: "layerId" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (!layer) {
        return;
      }
      layer.assetId = params.assetId;
      if (params.name !== undefined) layer.name = params.name;
      if (params.durationSeconds !== undefined) layer.durationSeconds = params.durationSeconds;
    });
    return actionResult(ctx.composition, mutation, `Replace asset`);
  }
};

const groupLayersSchema = z.object({
  layerIds: z.array(z.string()).min(2),
  groupId: z.string().optional()
});

const groupLayers: TimelineActionDefinition<z.infer<typeof groupLayersSchema>> = {
  id: "groupLayers",
  name: "Group layers",
  description: "Link layers together under a shared group id.",
  category: "group",
  inputSchema: groupLayersSchema,
  validationRules: (params, ctx) => params.layerIds.flatMap((id) => assertLayerExists(ctx, id, "layerIds")),
  canUndo: true,
  execute: (params, ctx) => {
    const groupId = params.groupId ?? freshId("group");
    const ids = new Set(params.layerIds);
    const mutation = runMutation(ctx.composition, (draft) => {
      for (const track of draft.tracks) {
        for (const layer of track.layers) {
          if (ids.has(layer.id)) {
            layer.linkedGroupId = groupId;
          }
        }
      }
    });
    return actionResult(ctx.composition, mutation, `Group ${params.layerIds.length} layers`);
  }
};

const ungroupLayersSchema = z
  .object({
    groupId: z.string().optional(),
    layerIds: z.array(z.string()).min(1).optional()
  })
  .refine((value) => value.groupId !== undefined || value.layerIds !== undefined, {
    message: "Provide groupId or layerIds"
  });

const ungroupLayers: TimelineActionDefinition<z.infer<typeof ungroupLayersSchema>> = {
  id: "ungroupLayers",
  name: "Ungroup layers",
  description: "Clear the group link from layers.",
  category: "group",
  inputSchema: ungroupLayersSchema,
  validationRules: (params, ctx) => (params.layerIds ?? []).flatMap((id) => assertLayerExists(ctx, id, "layerIds")),
  canUndo: true,
  execute: (params, ctx) => {
    const ids = params.layerIds ? new Set(params.layerIds) : null;
    const mutation = runMutation(ctx.composition, (draft) => {
      for (const track of draft.tracks) {
        for (const layer of track.layers) {
          const matchesGroup = params.groupId !== undefined && layer.linkedGroupId === params.groupId;
          const matchesId = ids?.has(layer.id) ?? false;
          if (matchesGroup || matchesId) {
            layer.linkedGroupId = undefined;
          }
        }
      }
    });
    return actionResult(ctx.composition, mutation, `Ungroup layers`);
  }
};

export const layerActions = [deleteLayer, moveLayer, replaceAsset, groupLayers, ungroupLayers];
