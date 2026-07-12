import { z } from "zod";
import type { MatteRef } from "../../types";
import { actionResult, runMutation } from "../patches";
import { assertLayerExists, findLayer } from "../validation";
import type { TimelineActionDefinition } from "../types";
import { locateLayer } from "./shared";

/**
 * Mask actions operate on `layer.matte` (a `MatteRef`) — the real, renderer-read
 * compositing signal produced by the Extract Person tool. `createMask` builds a
 * matte from a mask-sequence artifact with sensible defaults; `attachMask`
 * attaches an explicit matte (e.g. reusing one mask across layers); `detachMask`
 * clears it. None of these bake pixels — compositing stays editable.
 */

const matteFieldsSchema = {
  kind: z.enum(["luma", "alpha"]).optional(),
  fps: z.number().min(1).max(120).optional(),
  feather: z.number().min(0).max(64).optional(),
  edgeMode: z.enum(["fast", "clean"]).optional(),
  invert: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  uri: z.string().optional()
};

interface MatteInput {
  artifactId: string;
  kind?: "luma" | "alpha" | undefined;
  fps?: number | undefined;
  feather?: number | undefined;
  edgeMode?: "fast" | "clean" | undefined;
  invert?: boolean | undefined;
  opacity?: number | undefined;
  uri?: string | undefined;
}

function buildMatte(params: MatteInput, fallbackFps: number): MatteRef {
  return {
    artifactId: params.artifactId,
    kind: params.kind ?? "luma",
    fps: params.fps ?? fallbackFps,
    feather: params.feather ?? 2,
    edgeMode: params.edgeMode ?? "fast",
    ...(params.uri !== undefined ? { uri: params.uri } : {}),
    ...(params.invert !== undefined ? { invert: params.invert } : {}),
    ...(params.opacity !== undefined ? { opacity: params.opacity } : {})
  };
}

const createMaskSchema = z.object({ layerId: z.string(), artifactId: z.string(), ...matteFieldsSchema });

const createMask: TimelineActionDefinition<z.infer<typeof createMaskSchema>> = {
  id: "createMask",
  name: "Create mask",
  description: "Build a matte from a mask-sequence artifact and attach it to a clip.",
  category: "mask",
  inputSchema: createMaskSchema,
  validationRules: (params, ctx) => assertLayerExists(ctx, params.layerId),
  canUndo: true,
  execute: (params, ctx) => {
    const matte = buildMatte(params, ctx.composition.fps);
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (layer) {
        layer.matte = matte;
      }
    });
    return actionResult(ctx.composition, mutation, `Create mask`);
  }
};

const attachMaskSchema = z.object({ layerId: z.string(), artifactId: z.string(), ...matteFieldsSchema });

const attachMask: TimelineActionDefinition<z.infer<typeof attachMaskSchema>> = {
  id: "attachMask",
  name: "Attach mask",
  description: "Attach an existing matte to a clip (reuse a mask across clips).",
  category: "mask",
  inputSchema: attachMaskSchema,
  validationRules: (params, ctx) => assertLayerExists(ctx, params.layerId),
  canUndo: true,
  execute: (params, ctx) => {
    const matte = buildMatte(params, ctx.composition.fps);
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (layer) {
        layer.matte = matte;
      }
    });
    return actionResult(ctx.composition, mutation, `Attach mask`);
  }
};

const detachMaskSchema = z.object({ layerId: z.string() });

const detachMask: TimelineActionDefinition<z.infer<typeof detachMaskSchema>> = {
  id: "detachMask",
  name: "Detach mask",
  description: "Remove a clip's matte.",
  category: "mask",
  inputSchema: detachMaskSchema,
  validationRules: (params, ctx) => {
    const located = findLayer(ctx.composition, params.layerId);
    if (!located) {
      return assertLayerExists(ctx, params.layerId);
    }
    return located.layer.matte
      ? []
      : [{ code: "no_mask_attached", message: `Layer "${params.layerId}" has no mask`, path: "layerId" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (layer) {
        layer.matte = undefined;
      }
    });
    return actionResult(ctx.composition, mutation, `Detach mask`);
  }
};

export const maskActions = [createMask, attachMask, detachMask];
