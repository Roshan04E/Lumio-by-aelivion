import { z } from "zod";
import { createTimelineEffect, getTimelineEffectDefinition } from "../../effects";
import { resolveLookName } from "../../color/looks";
import type { TimelineEffect, TimelineEffectType } from "../../types";
import { actionResult, runMutation } from "../patches";
import { assertEffectParamsValid, assertEffectTypeKnown, assertLayerExists } from "../validation";
import type { TimelineActionDefinition } from "../types";
import { freshId, locateLayer } from "./shared";

const paramValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Canonicalize registry-declared `look`-type params at the ONE write seam (K3): validation
 * already guaranteed the value resolves (exact / case-insensitive / alias), so storing the
 * CANONICAL registry name here means the renderer's exact-match lookup and the Color tab's
 * option list always agree with what the AI/user said. Registry-driven — no effect types
 * hardcoded; any future effect with a `look` param gets the same behavior.
 */
function canonicalizeLookParams(
  effectType: string,
  params: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const definition = getTimelineEffectDefinition(effectType as TimelineEffect["type"]);
  if (!definition) {
    return params;
  }
  let result = params;
  for (const param of definition.params) {
    if (param.type !== "look") {
      continue;
    }
    const value = result[param.key];
    if (typeof value === "string") {
      const resolved = resolveLookName(value);
      if (resolved && resolved.look !== value) {
        result = { ...result, [param.key]: resolved.look };
      }
    }
  }
  return result;
}

const addEffectSchema = z.object({
  layerId: z.string(),
  effectType: z.string(),
  intensity: z.number().min(0).max(100).optional(),
  params: z.record(paramValueSchema).optional()
});

const addEffect: TimelineActionDefinition<z.infer<typeof addEffectSchema>> = {
  id: "addEffect",
  name: "Add effect",
  description: "Attach a registered effect to a clip.",
  category: "effect",
  inputSchema: addEffectSchema,
  validationRules: (params, ctx) => [
    ...assertLayerExists(ctx, params.layerId),
    ...assertEffectTypeKnown(params.effectType, "effectType"),
    ...assertEffectParamsValid(params.effectType, params.params)
  ],
  canUndo: true,
  execute: (params, ctx) => {
    // Update-not-duplicate at the ONE write seam: if the layer already carries this effect
    // type, "add" means TWEAK the existing instance (re-enable + merge intensity/params),
    // never stack a twin on top. Effect-agnostic — the same rule for blur, creativeLook,
    // and every future type; its keyframes survive because the instance does. (The tier-0
    // look reflex had this rule privately; every other producer — tier-1 compiler, semantic
    // tier, fast lane, LLM plans — went through raw addEffect and stacked duplicates.)
    const existing = ctx.composition.tracks
      .flatMap((track) => track.layers)
      .find((layer) => layer.id === params.layerId)
      ?.effects.find((effect) => effect.type === params.effectType);
    if (existing) {
      const mutation = runMutation(ctx.composition, (draft) => {
        const effect = locateLayer(draft, params.layerId)?.layer.effects.find((item) => item.id === existing.id);
        if (!effect) {
          return;
        }
        effect.enabled = true;
        if (params.intensity !== undefined) {
          effect.intensity = params.intensity;
        }
        if (params.params) {
          effect.params = { ...effect.params, ...canonicalizeLookParams(effect.type, params.params) };
        }
      });
      return actionResult(ctx.composition, mutation, `Update ${existing.name} effect (already on the clip)`);
    }
    const effect = createTimelineEffect(params.effectType as TimelineEffectType);
    effect.id = freshId(`effect_${params.effectType}`);
    if (params.intensity !== undefined) {
      effect.intensity = params.intensity;
    }
    if (params.params) {
      effect.params = { ...effect.params, ...canonicalizeLookParams(params.effectType, params.params) };
    }
    const mutation = runMutation(ctx.composition, (draft) => {
      locateLayer(draft, params.layerId)?.layer.effects.push(effect);
    });
    return actionResult(ctx.composition, mutation, `Add ${effect.name} effect`);
  }
};

const removeEffectSchema = z.object({
  layerId: z.string(),
  effectId: z.string()
});

const removeEffect: TimelineActionDefinition<z.infer<typeof removeEffectSchema>> = {
  id: "removeEffect",
  name: "Remove effect",
  description: "Detach an effect from a clip.",
  category: "effect",
  inputSchema: removeEffectSchema,
  validationRules: (params, ctx) => {
    const issues = assertLayerExists(ctx, params.layerId);
    if (issues.length) {
      return issues;
    }
    const layer = ctx.composition.tracks.flatMap((track) => track.layers).find((item) => item.id === params.layerId);
    return layer?.effects.some((effect) => effect.id === params.effectId)
      ? []
      : [{ code: "invalid_effect_reference", message: `No effect "${params.effectId}" on layer`, path: "effectId" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (layer) {
        layer.effects = layer.effects.filter((effect) => effect.id !== params.effectId);
        // Strip the removed effect's keyframes in the same write — orphans with a dead effectId
        // are invisible to the evaluator and the inspector (inert "broken" keyframes).
        if (layer.animations?.length) {
          layer.animations = layer.animations.filter((kf) => !(kf.target.scope === "effect" && kf.target.effectId === params.effectId));
        }
      }
    });
    return actionResult(ctx.composition, mutation, `Remove effect`);
  }
};

const updateEffectSchema = z
  .object({
    layerId: z.string(),
    effectId: z.string(),
    enabled: z.boolean().optional(),
    intensity: z.number().min(0).max(100).optional(),
    params: z.record(paramValueSchema).optional()
  })
  .refine((value) => value.enabled !== undefined || value.intensity !== undefined || value.params !== undefined, {
    message: "Provide enabled, intensity, or params"
  });

const updateEffect: TimelineActionDefinition<z.infer<typeof updateEffectSchema>> = {
  id: "updateEffect",
  name: "Update effect",
  description: "Tweak an effect's enabled state, intensity, or params.",
  category: "effect",
  inputSchema: updateEffectSchema,
  validationRules: (params, ctx) => {
    const issues = assertLayerExists(ctx, params.layerId);
    if (issues.length) {
      return issues;
    }
    const effect = ctx.composition.tracks
      .flatMap((track) => track.layers)
      .find((item) => item.id === params.layerId)
      ?.effects.find((item) => item.id === params.effectId);
    if (!effect) {
      return [{ code: "invalid_effect_reference", message: `No effect "${params.effectId}" on layer`, path: "effectId" }];
    }
    return assertEffectParamsValid(effect.type, params.params);
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const effect = locateLayer(draft, params.layerId)?.layer.effects.find((item) => item.id === params.effectId);
      if (!effect) {
        return;
      }
      if (params.enabled !== undefined) effect.enabled = params.enabled;
      if (params.intensity !== undefined) effect.intensity = params.intensity;
      if (params.params) effect.params = { ...effect.params, ...canonicalizeLookParams(effect.type, params.params) };
    });
    return actionResult(ctx.composition, mutation, `Update effect`);
  }
};

const reorderEffectSchema = z.object({
  layerId: z.string(),
  effectId: z.string(),
  toIndex: z.number().int().min(0)
});

const reorderEffect: TimelineActionDefinition<z.infer<typeof reorderEffectSchema>> = {
  id: "reorderEffect",
  name: "Reorder effect",
  description: "Move an effect to a different position in the clip's effect stack.",
  category: "effect",
  inputSchema: reorderEffectSchema,
  validationRules: (params, ctx) => {
    const issues = assertLayerExists(ctx, params.layerId);
    if (issues.length) return issues;
    const layer = ctx.composition.tracks.flatMap((track) => track.layers).find((item) => item.id === params.layerId);
    return layer?.effects.some((effect) => effect.id === params.effectId)
      ? []
      : [{ code: "invalid_effect_reference", message: `No effect "${params.effectId}" on layer`, path: "effectId" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (!layer) return;
      const fromIndex = layer.effects.findIndex((effect) => effect.id === params.effectId);
      if (fromIndex === -1) return;
      const removed = layer.effects.splice(fromIndex, 1);
      const dragged = removed[0];
      if (!dragged) return;
      const clampedTo = Math.max(0, Math.min(params.toIndex, layer.effects.length));
      layer.effects.splice(clampedTo, 0, dragged);
    });
    return actionResult(ctx.composition, mutation, `Reorder effect`);
  }
};

export const effectActions = [addEffect, removeEffect, updateEffect, reorderEffect];
