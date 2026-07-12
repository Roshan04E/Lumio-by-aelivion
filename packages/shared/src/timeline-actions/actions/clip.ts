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

const splitClipAtTimesSchema = z.object({
  layerId: z.string(),
  /** Timeline times in seconds — e.g. detected beats. Out-of-bounds times are skipped, not errors. */
  times: z.array(z.number().min(0)).min(1).max(500)
});

/**
 * Batch cut — one observable action for "cut this clip at every beat" (D3 of the agent plan),
 * instead of N loop iterations. Cuts apply in DESCENDING time order because `splitLayerAtTime`
 * keeps the ORIGINAL layer id on the LEFT half: every earlier cut point still falls inside the
 * original-id layer, so the whole batch resolves against one stable id.
 */
const splitClipAtTimes: TimelineActionDefinition<z.infer<typeof splitClipAtTimesSchema>> = {
  id: "splitClipAtTimes",
  name: "Split clip at times",
  description: "Cut a clip at each of the given times (seconds) in one action — e.g. every detected beat.",
  category: "clip",
  inputSchema: splitClipAtTimesSchema,
  validationRules: (params, ctx) => assertLayerExists(ctx, params.layerId),
  canUndo: true,
  execute: (params, ctx) => {
    const located = findLayer(ctx.composition, params.layerId);
    const layer = located?.layer;
    const inBounds = layer
      ? [...new Set(params.times)]
          .filter((time) => time > layer.startSeconds && time < layer.startSeconds + layer.durationSeconds)
          .sort((a, b) => b - a)
      : [];
    const mutation = runReplace(ctx.composition, (before) =>
      inBounds.reduce((composition, time) => splitLayerAtTime(composition, params.layerId, time), before)
    );
    const segments = inBounds.length + 1;
    return actionResult(
      ctx.composition,
      mutation,
      inBounds.length
        ? `Split clip into ${segments} segments at ${inBounds.length} time${inBounds.length === 1 ? "" : "s"}`
        : "No cut times fell inside the clip"
    );
  }
};

export const clipActions = [trimClip, splitClip, splitClipAtTimes];
