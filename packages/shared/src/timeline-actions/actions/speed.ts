import { z } from "zod";
import { changeLayerConstantSpeed, MAX_LAYER_SPEED, MIN_LAYER_SPEED } from "../../timeline";
import { actionResult, runMutation, runReplace } from "../patches";
import { assertLayerExists } from "../validation";
import type { TimelineActionDefinition } from "../types";

/**
 * setClipSpeed — rate stretch through the registry (the AI seam for "make clip 2 twice as
 * fast" / "play clip 3 in reverse"). The MATH is `changeLayerConstantSpeed` in timeline.ts,
 * the exact implementation the editor's Clip Speed dialog uses (extracted 2026-07-18, per
 * the reuse-don't-fork rule): duration re-derives from the source span, tail growth clamps
 * at the next clip, linked video+audio move together, and a negative speed reverses with
 * the S2 in/out swap.
 */

const setClipSpeedSchema = z.object({
  layerId: z.string(),
  /** Playback rate: 1 = normal, 2 = double, 0.5 = half; NEGATIVE plays in reverse. */
  speed: z
    .number()
    .refine((value) => Number.isFinite(value) && value !== 0 && Math.abs(value) >= MIN_LAYER_SPEED && Math.abs(value) <= MAX_LAYER_SPEED, {
      message: `speed magnitude must be between ${MIN_LAYER_SPEED} and ${MAX_LAYER_SPEED} (negative = reverse)`
    })
});

const setClipSpeed: TimelineActionDefinition<z.infer<typeof setClipSpeedSchema>> = {
  id: "setClipSpeed",
  name: "Set clip speed",
  description: "Change a clip's constant playback speed (rate stretch). Negative speed plays it in reverse; linked audio follows.",
  category: "clip",
  inputSchema: setClipSpeedSchema,
  validationRules: (params, ctx) => assertLayerExists(ctx, params.layerId),
  canUndo: true,
  execute: (params, ctx) => {
    const changed = changeLayerConstantSpeed(ctx.composition, params.layerId, params.speed);
    if (!changed) {
      // Already at that speed — an honest no-op, not a failure (idempotent like addEffect).
      const mutation = runMutation(ctx.composition, () => undefined);
      return actionResult(ctx.composition, mutation, `Speed already ${Math.round(Math.abs(params.speed) * 100)}%`);
    }
    const mutation = runReplace(ctx.composition, () => changed.composition);
    const percent = Math.round(Math.abs(changed.appliedSpeed) * 100);
    return actionResult(ctx.composition, mutation, changed.appliedSpeed < 0 ? `Reverse at ${percent}%` : `Set speed to ${percent}%`);
  }
};

export const speedActions = [setClipSpeed];
