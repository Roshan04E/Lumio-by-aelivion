import { z } from "zod";
import { splitLayerAtTime } from "../../timeline-ops";
import { actionResult, runMutation, runReplace } from "../patches";
import { assertLayerExists, findLayer } from "../validation";
import type { TimelineActionDefinition } from "../types";
import { ABSOLUTE_MIN_CLIP_SECONDS, locateLayer, minClipDurationSeconds } from "./shared";

const trimClipSchema = z
  .object({
    layerId: z.string(),
    startSeconds: z.number().min(0).optional(),
    durationSeconds: z.number().min(ABSOLUTE_MIN_CLIP_SECONDS).optional(),
    sourceInSeconds: z.number().min(0).optional()
  })
  .refine(
    (value) => value.startSeconds !== undefined || value.durationSeconds !== undefined || value.sourceInSeconds !== undefined,
    { message: "Provide startSeconds, durationSeconds, or sourceInSeconds" }
  );

const trimClip: TimelineActionDefinition<z.infer<typeof trimClipSchema>> = {
  id: "trimClip",
  name: "Trim clip",
  description: "Adjust a clip's start, duration, or source in-point.",
  category: "clip",
  inputSchema: trimClipSchema,
  validationRules: (params, ctx) => assertLayerExists(ctx, params.layerId),
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (!layer) {
        return;
      }
      if (params.startSeconds !== undefined) layer.startSeconds = params.startSeconds;
      if (params.durationSeconds !== undefined) layer.durationSeconds = Math.max(minClipDurationSeconds(draft), params.durationSeconds);
      if (params.sourceInSeconds !== undefined) layer.sourceInSeconds = params.sourceInSeconds;
    });
    return actionResult(ctx.composition, mutation, `Trim clip`);
  }
};

const splitClipSchema = z.object({
  layerId: z.string(),
  atSeconds: z.number().min(0).optional()
});

const splitClip: TimelineActionDefinition<z.infer<typeof splitClipSchema>> = {
  id: "splitClip",
  name: "Split clip",
  description: "Cut a clip into two at a time.",
  category: "clip",
  inputSchema: splitClipSchema,
  validationRules: (params, ctx) => {
    const located = findLayer(ctx.composition, params.layerId);
    if (!located) {
      return assertLayerExists(ctx, params.layerId);
    }
    const at = params.atSeconds ?? ctx.nowSeconds;
    const local = at - located.layer.startSeconds;
    return local > 0 && local < located.layer.durationSeconds
      ? []
      : [{ code: "split_out_of_bounds", message: `Split time must fall inside the clip`, path: "atSeconds" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const at = params.atSeconds ?? ctx.nowSeconds;
    const mutation = runReplace(ctx.composition, (before) => splitLayerAtTime(before, params.layerId, at));
    return actionResult(ctx.composition, mutation, `Split clip`);
  }
};

export const clipActions = [trimClip, splitClip];
