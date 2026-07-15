import { z } from "zod";
import {
  rippleTrimLayer,
  rollEditAtCut,
  rollEditLimits,
  slideLayer,
  slideLayerLimits,
  splitLayerAtTime
} from "../../timeline-ops";
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

// --- Trim suite as engine actions -----------------------------------------------------------------
//
// These wrap the SAME pure ops the editor's drag handlers already call (rollEditAtCut / slideLayer /
// rippleTrimLayer in timeline-ops) — so AI / scripting / undo-replay perform roll, slide, ripple-trim,
// and slip through the one sanctioned, reversible path, exactly as a hand gesture does. The ops
// self-clamp against their own limit functions; `maxDurationsSeconds` (per-asset caps) is an optional
// param the UI can thread through, and defaults to the composition length when omitted (AI calls).

/** Optional per-edit trim limits shared by roll/slide (mirrors `TrimLimitOptions`). */
const trimLimitFields = {
  minDurationSeconds: z.number().min(ABSOLUTE_MIN_CLIP_SECONDS).optional(),
  maxDurationsSeconds: z.record(z.string(), z.number()).optional()
};

const rollEditSchema = z.object({
  leftLayerId: z.string(),
  rightLayerId: z.string(),
  deltaSeconds: z.number(),
  ...trimLimitFields
});

const rollEdit: TimelineActionDefinition<z.infer<typeof rollEditSchema>> = {
  id: "rollEdit",
  name: "Roll cut",
  description: "Move the cut between two touching clips — left tail and right head shift together, total length unchanged.",
  category: "clip",
  inputSchema: rollEditSchema,
  validationRules: (params, ctx) => {
    const issues = [...assertLayerExists(ctx, params.leftLayerId), ...assertLayerExists(ctx, params.rightLayerId)];
    if (issues.length) return issues;
    const limits = rollEditLimits(ctx.composition, params.leftLayerId, params.rightLayerId, {
      minDurationSeconds: params.minDurationSeconds,
      maxDurationsSeconds: params.maxDurationsSeconds
    });
    return limits ? [] : [{ code: "not_a_touching_cut", message: "Roll needs two touching clips on the same track" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runReplace(ctx.composition, (before) =>
      rollEditAtCut(before, params.leftLayerId, params.rightLayerId, params.deltaSeconds, {
        minDurationSeconds: params.minDurationSeconds,
        maxDurationsSeconds: params.maxDurationsSeconds
      })
    );
    return actionResult(ctx.composition, mutation, `Roll cut`);
  }
};

const slideClipSchema = z.object({
  layerId: z.string(),
  deltaSeconds: z.number(),
  ...trimLimitFields
});

const slideClip: TimelineActionDefinition<z.infer<typeof slideClipSchema>> = {
  id: "slideClip",
  name: "Slide clip",
  description: "Slide a clip between its two touching neighbours — the clip keeps its content; the neighbours' cuts move.",
  category: "clip",
  inputSchema: slideClipSchema,
  validationRules: (params, ctx) => {
    const issues = assertLayerExists(ctx, params.layerId);
    if (issues.length) return issues;
    const limits = slideLayerLimits(ctx.composition, params.layerId, {
      minDurationSeconds: params.minDurationSeconds,
      maxDurationsSeconds: params.maxDurationsSeconds
    });
    return limits ? [] : [{ code: "no_touching_neighbours", message: "Slide needs touching clips on both sides" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runReplace(ctx.composition, (before) =>
      slideLayer(before, params.layerId, params.deltaSeconds, {
        minDurationSeconds: params.minDurationSeconds,
        maxDurationsSeconds: params.maxDurationsSeconds
      })
    );
    return actionResult(ctx.composition, mutation, `Slide clip`);
  }
};

const rippleTrimClipSchema = z.object({
  layerId: z.string(),
  /** Absolute timeline time to trim the clip TO (must fall inside the clip body). */
  atSeconds: z.number().min(0),
  side: z.enum(["head", "tail"])
});

const rippleTrimClip: TimelineActionDefinition<z.infer<typeof rippleTrimClipSchema>> = {
  id: "rippleTrimClip",
  name: "Ripple trim clip",
  description: "Trim a clip's head or tail to a time and close the gap — downstream clips on the track slide over.",
  category: "clip",
  inputSchema: rippleTrimClipSchema,
  validationRules: (params, ctx) => {
    const located = findLayer(ctx.composition, params.layerId);
    if (!located) return assertLayerExists(ctx, params.layerId);
    const local = params.atSeconds - located.layer.startSeconds;
    return local > 0 && local < located.layer.durationSeconds
      ? []
      : [{ code: "trim_out_of_bounds", message: "Ripple-trim time must fall inside the clip", path: "atSeconds" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runReplace(ctx.composition, (before) => rippleTrimLayer(before, params.layerId, params.atSeconds, params.side));
    return actionResult(ctx.composition, mutation, `Ripple trim clip ${params.side}`);
  }
};

const slipClipSchema = z.object({
  layerId: z.string(),
  /** Shift the source in-point by this many SOURCE seconds (positive reveals later material). */
  deltaSeconds: z.number()
});

// Slip shifts what part of the source the clip shows without moving the clip. `trimClip` can set an
// ABSOLUTE sourceIn; this is the natural RELATIVE form a slip gesture produces. Upper bound (source
// length) is enforced by the caller; the op floors at 0.
const slipClip: TimelineActionDefinition<z.infer<typeof slipClipSchema>> = {
  id: "slipClip",
  name: "Slip clip",
  description: "Shift the clip's source in-point without moving the clip on the timeline.",
  category: "clip",
  inputSchema: slipClipSchema,
  validationRules: (params, ctx) => assertLayerExists(ctx, params.layerId),
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (!layer) return;
      layer.sourceInSeconds = Math.max(0, (layer.sourceInSeconds ?? 0) + params.deltaSeconds);
    });
    return actionResult(ctx.composition, mutation, `Slip clip`);
  }
};

export const clipActions = [trimClip, splitClip, splitClipAtTimes, rollEdit, slideClip, rippleTrimClip, slipClip];
