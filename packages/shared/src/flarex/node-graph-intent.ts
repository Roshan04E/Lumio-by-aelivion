/**
 * NodeGraphIntent — the Flarex AI DSL (FLAREX.md Part 7), cloned structurally from
 * `color/grade-intent.ts`: the LLM emits a COMPACT, Zod-`.strict()`-validated intent; this
 * deterministic compiler expands it into real, individually-editable Flarex nodes wired between
 * MediaIn and MediaOut. The model never chooses low-level values it wasn't asked for, output is
 * the same graph the user could build by hand, and identical intent → identical graph (ids are
 * derived from the op index, not randomness), so repeat runs are cache/verify-friendly.
 *
 * Ops append IN ORDER into the main image chain. `blurRegion` shows the mask pattern: a shape
 * mask node + a masked blur (the compiler lowers that to a SceneRegionPass). `composite`
 * re-blends the chain-so-far over the clean MediaIn (the "keyed fg over original bg" idiom).
 */

import { z } from "zod";
import { createFlarexNode } from "./node-defs";
import { createFlarexComp } from "./registry";
import type { FlarexComp, FlarexEdge, FlarexNode, FlarexNodeType } from "./types";

const blendModes = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "add",
] as const;

export const nodeGraphIntentSchema = z
  .object({
    ops: z
      .array(
        z.discriminatedUnion("op", [
          z
            .object({
              op: z.literal("key"),
              kind: z.enum(["chroma", "luma"]).default("chroma"),
              /** #rrggbb screen color; omitted = green-screen default. */
              color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
              tolerance: z.number().min(0).max(1).optional(),
              softness: z.number().min(0).max(1).optional(),
              spill: z.number().min(0).max(1).optional(),
            })
            .strict(),
          z
            .object({
              op: z.literal("composite"),
              blend: z.enum(blendModes).default("normal"),
              opacity: z.number().min(0).max(1).optional(),
            })
            .strict(),
          z
            .object({
              op: z.literal("grade"),
              exposure: z.number().min(-100).max(100).optional(),
              contrast: z.number().min(-100).max(100).optional(),
              saturation: z.number().min(0).max(220).optional(),
              temperature: z.number().min(-100).max(100).optional(),
              tint: z.number().min(-100).max(100).optional(),
            })
            .strict(),
          z
            .object({
              op: z.literal("blur"),
              sigma: z.number().min(0).max(200).default(8),
            })
            .strict(),
          z
            .object({
              op: z.literal("blurRegion"),
              shape: z.enum(["rect", "ellipse"]).default("ellipse"),
              /** Comp fractions 0..1 (center + size), the shape-mask node's native units. */
              centerX: z.number().min(0).max(1).default(0.5),
              centerY: z.number().min(0).max(1).default(0.5),
              width: z.number().min(0).max(2).default(0.4),
              height: z.number().min(0).max(2).default(0.4),
              sigma: z.number().min(0).max(200).default(16),
              feather: z.number().min(0).max(1).optional(),
            })
            .strict(),
          z
            .object({
              op: z.literal("glow"),
              radius: z.number().min(0).max(200).default(24),
              intensity: z.number().min(0).max(2).optional(),
              threshold: z.number().min(0).max(1).optional(),
            })
            .strict(),
          z
            .object({
              op: z.literal("sharpen"),
              amount: z.number().min(0).max(2).default(0.5),
            })
            .strict(),
          z
            .object({
              op: z.literal("transform"),
              x: z.number().min(-100).max(100).optional(),
              y: z.number().min(-100).max(100).optional(),
              scale: z.number().min(0).max(4).optional(),
              rotation: z.number().min(-180).max(180).optional(),
            })
            .strict(),
          z
            .object({
              op: z.literal("filter"),
              /** A fragment builtin id (radialBlur, pixelate, chromaticAberration, ...). */
              effectId: z.string().min(1),
              intensity: z.number().min(0).max(1).optional(),
            })
            .strict(),
        ])
      )
      .min(1)
      .max(12),
  })
  .strict();

export type NodeGraphIntent = z.infer<typeof nodeGraphIntentSchema>;

/** One compiled op, for transcripts/approval UI (mirrors CompiledGrade's `summary`). */
export interface CompiledNodeGraphOp {
  nodeIds: string[];
  summary: string;
}

export interface CompiledNodeGraph {
  comp: FlarexComp;
  ops: CompiledNodeGraphOp[];
}

const setParams = (node: FlarexNode, params: Record<string, string | number | boolean | undefined>): FlarexNode => {
  const next = { ...node, params: { ...node.params } };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) next.params[key] = value;
  }
  return next;
};

/**
 * Expand a validated intent into a Flarex comp. `base` (default: a fresh MediaIn→MediaOut comp)
 * must contain a mediaIn and mediaOut; intent nodes are appended after any existing chain (the
 * "add glow" prompt on an already-authored comp extends it, never rebuilds it).
 */
export function compileNodeGraphIntent(intent: NodeGraphIntent, base?: FlarexComp): CompiledNodeGraph {
  const comp: FlarexComp = base
    ? { ...base, nodes: { ...base.nodes }, edges: [...base.edges] }
    : createFlarexComp(`flarex_ai_${Date.now().toString(36)}`, "AI Comp");
  const mediaIn = Object.values(comp.nodes).find((node) => node.type === "mediaIn");
  const mediaOut = Object.values(comp.nodes).find((node) => node.type === "mediaOut");
  if (!mediaIn || !mediaOut) return { comp, ops: [] };

  // The current chain tail = whatever feeds MediaOut (or MediaIn on a fresh comp).
  const intoOut = comp.edges.find((edge) => edge.to.nodeId === mediaOut.id);
  let tailId = intoOut ? intoOut.from.nodeId : mediaIn.id;
  // Intent nodes splice in before MediaOut.
  comp.edges = comp.edges.filter((edge) => edge.to.nodeId !== mediaOut.id);

  // Deterministic ids/geometry: derived from the op index + current node count, no randomness.
  const seq = Object.keys(comp.nodes).length;
  let placeX = Math.max(0, ...Object.values(comp.nodes).filter((n) => n.type !== "mediaOut").map((n) => n.ui.x)) + 180;
  const nodeId = (index: number, suffix = ""): string => `${comp.id}_ai${seq}_${index}${suffix}`;
  const addNode = (node: FlarexNode): FlarexNode => {
    comp.nodes[node.id] = node;
    return node;
  };
  const addEdge = (fromId: string, fromSocket: string, toId: string, toSocket: string, index: number, suffix = "") => {
    const edge: FlarexEdge = {
      id: `${comp.id}_aie${seq}_${index}${suffix}`,
      from: { nodeId: fromId, socket: fromSocket },
      to: { nodeId: toId, socket: toSocket },
    };
    comp.edges.push(edge);
  };
  const chain = (type: FlarexNodeType, index: number, params: Record<string, string | number | boolean | undefined>): FlarexNode => {
    const node = addNode(setParams(createFlarexNode(type, nodeId(index), placeX, 0), params));
    placeX += 180;
    addEdge(tailId, "out", node.id, "in", index);
    tailId = node.id;
    return node;
  };

  const compiled: CompiledNodeGraphOp[] = [];
  intent.ops.forEach((op, index) => {
    switch (op.op) {
      case "key": {
        if (op.kind === "luma") {
          const node = chain("lumaKey", index, { softness: op.softness });
          compiled.push({ nodeIds: [node.id], summary: "Luma key" });
        } else {
          const node = chain("chromaKey", index, {
            color: op.color,
            tolerance: op.tolerance,
            softness: op.softness,
            spillSuppression: op.spill,
          });
          compiled.push({ nodeIds: [node.id], summary: `Chroma key${op.color ? ` (${op.color})` : ""}` });
        }
        break;
      }
      case "composite": {
        // Merge the chain-so-far (fg) back over the clean MediaIn (bg).
        const node = addNode(setParams(createFlarexNode("merge", nodeId(index), placeX, 0), { blend: op.blend, opacity: op.opacity }));
        placeX += 180;
        addEdge(mediaIn.id, "out", node.id, "bg", index, "b");
        addEdge(tailId, "out", node.id, "fg", index, "f");
        tailId = node.id;
        compiled.push({ nodeIds: [node.id], summary: `Composite over source (${op.blend})` });
        break;
      }
      case "grade": {
        const node = chain("colorCorrect", index, {
          exposure: op.exposure,
          contrast: op.contrast,
          saturation: op.saturation,
          temperature: op.temperature,
          tint: op.tint,
        });
        compiled.push({ nodeIds: [node.id], summary: "Color correct" });
        break;
      }
      case "blur": {
        const node = chain("blur", index, { sigma: op.sigma });
        compiled.push({ nodeIds: [node.id], summary: `Blur ${op.sigma}px` });
        break;
      }
      case "blurRegion": {
        const mask = addNode(
          setParams(createFlarexNode(op.shape === "rect" ? "rectMask" : "ellipseMask", nodeId(index, "m"), placeX, 120), {
            centerX: op.centerX,
            centerY: op.centerY,
            width: op.width,
            height: op.height,
            feather: op.feather ?? 0.15,
          })
        );
        const node = chain("blur", index, { sigma: op.sigma });
        addEdge(mask.id, "out", node.id, "mask", index, "m");
        compiled.push({ nodeIds: [mask.id, node.id], summary: `Region blur (${op.shape})` });
        break;
      }
      case "glow": {
        const node = chain("glow", index, { radius: op.radius, intensity: op.intensity, threshold: op.threshold });
        compiled.push({ nodeIds: [node.id], summary: `Glow ${op.radius}px` });
        break;
      }
      case "sharpen": {
        const node = chain("sharpen", index, { amount: op.amount });
        compiled.push({ nodeIds: [node.id], summary: "Sharpen" });
        break;
      }
      case "transform": {
        const node = chain("transform", index, { x: op.x, y: op.y, scale: op.scale, rotation: op.rotation });
        compiled.push({ nodeIds: [node.id], summary: "Transform" });
        break;
      }
      case "filter": {
        const node = chain("filter", index, { effectId: op.effectId, intensity: op.intensity });
        compiled.push({ nodeIds: [node.id], summary: `Filter: ${op.effectId}` });
        break;
      }
    }
  });

  addEdge(tailId, "out", mediaOut.id, "in", intent.ops.length, "o");
  return { comp, ops: compiled };
}
