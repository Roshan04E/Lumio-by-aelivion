/**
 * Flarex node definition registry (FLAREX.md Part 3).
 *
 * Declarative catalog of every node type: typed sockets, Zod param schema (with defaults —
 * `parseFlarexNodeParams` is the single normalization gate, same rigor as the timeline-action
 * registry), and which params the keyframe editor may target. The `lower()` implementations
 * (graph → SceneDraw) land with the Phase 1 compiler in `compile-flarex.ts`; this module
 * stays renderer-free so the editor UI and AI layers can import it cheaply.
 */

import { z } from "zod";
import type { FlarexNode, FlarexNodeType, FlarexSocketType } from "./types";

export interface FlarexSocketDef {
  id: string;
  type: FlarexSocketType;
  label: string;
  required?: boolean | undefined;
}

export interface FlarexNodeDefinition {
  type: FlarexNodeType;
  label: string;
  /** Palette grouping (Fusion-style toolbar sections). */
  group: "io" | "composite" | "color" | "filter" | "mask" | "generator" | "tracking" | "layout";
  inputs: FlarexSocketDef[];
  outputs: FlarexSocketDef[];
  /** `.strict()` schema whose defaults define the node's initial params (output must stay
   *  a flat Record<string, string|number|boolean> — enforced by convention, ZodTypeAny for
   *  assignability of the concrete object schemas). */
  params: z.ZodTypeAny;
  /** Param keys the graph/keyframe editor may animate (scope "flarexNode"). */
  keyframeable: string[];
  /** Phase gating: nodes past the current ship phase stay out of the palette. */
  phase: 1 | 1.5 | 2;
}

const image = (id: string, label: string, required = false): FlarexSocketDef => ({ id, type: "image", label, required });
const matte = (id: string, label: string): FlarexSocketDef => ({ id, type: "matte", label });
const OUT = [image("out", "Output")];
const MATTE_OUT: FlarexSocketDef[] = [{ id: "out", type: "matte", label: "Matte" }];

export const flarexBlendModes = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "add",
] as const;

const num = (def: number, min?: number, max?: number) => {
  let s = z.number();
  if (min !== undefined) s = s.min(min);
  if (max !== undefined) s = s.max(max);
  return s.default(def);
};

/** Shared shape-mask params (comp-relative 0..1 coordinates, like the vector Mask model). */
const shapeMaskParams = {
  centerX: num(0.5, 0, 1),
  centerY: num(0.5, 0, 1),
  width: num(0.5, 0, 2),
  height: num(0.5, 0, 2),
  feather: num(0, 0, 1),
  invert: z.boolean().default(false),
};

const defs: Record<FlarexNodeType, Omit<FlarexNodeDefinition, "type">> = {
  mediaIn: {
    label: "MediaIn",
    group: "io",
    inputs: [],
    outputs: OUT,
    // sourceClipId "" = the host clip; a sibling clip id is the v2 comp-clip form.
    params: z.object({ sourceClipId: z.string().default("") }).strict(),
    keyframeable: [],
    phase: 1,
  },
  mediaOut: {
    label: "MediaOut",
    group: "io",
    inputs: [image("in", "Input", true)],
    outputs: [],
    params: z.object({}).strict(),
    keyframeable: [],
    phase: 1,
  },
  merge: {
    label: "Merge",
    group: "composite",
    inputs: [image("bg", "Background", true), image("fg", "Foreground", true), matte("mask", "Mask")],
    outputs: OUT,
    params: z.object({
      blend: z.enum(flarexBlendModes).default("normal"),
      opacity: num(1, 0, 1),
    }).strict(),
    keyframeable: ["opacity"],
    phase: 1,
  },
  transform: {
    label: "Transform",
    group: "composite",
    inputs: [image("in", "Input", true)],
    outputs: OUT,
    params: z.object({
      x: num(0),
      y: num(0),
      scale: num(1, 0),
      rotation: num(0),
      anchorX: num(0.5, 0, 1),
      anchorY: num(0.5, 0, 1),
    }).strict(),
    keyframeable: ["x", "y", "scale", "rotation"],
    phase: 1,
  },
  colorCorrect: {
    label: "Color Correct",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    params: z.object({
      exposure: num(0, -4, 4),
      contrast: num(0, -1, 1),
      saturation: num(1, 0, 3),
      temperature: num(0, -1, 1),
      tint: num(0, -1, 1),
    }).strict(),
    keyframeable: ["exposure", "contrast", "saturation", "temperature", "tint"],
    phase: 1,
  },
  colorCurves: {
    label: "Curves",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // JSON payload in the colorCurves effect-param convention (curve editor reuse).
    params: z.object({ curves: z.string().default("") }).strict(),
    keyframeable: [],
    phase: 1.5,
  },
  hueSat: {
    label: "Hue/Sat",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    params: z.object({ hueCurves: z.string().default("") }).strict(),
    keyframeable: [],
    phase: 1.5,
  },
  blur: {
    label: "Blur",
    group: "filter",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    params: z.object({ sigma: num(8, 0, 200) }).strict(),
    keyframeable: ["sigma"],
    phase: 1,
  },
  glow: {
    label: "Glow",
    group: "filter",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    params: z.object({
      radius: num(24, 0, 200),
      intensity: num(0.6, 0, 2),
      threshold: num(0.7, 0, 1),
    }).strict(),
    keyframeable: ["radius", "intensity", "threshold"],
    phase: 1,
  },
  sharpen: {
    label: "Sharpen",
    group: "filter",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    params: z.object({ amount: num(0.5, 0, 2) }).strict(),
    keyframeable: ["amount"],
    phase: 1,
  },
  filter: {
    label: "Filter",
    group: "filter",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // effectId = a fragment-effect registry builtin (radialBlur, pixelate, ...); params JSON
    // in that effect's own param convention.
    params: z.object({
      effectId: z.string().default(""),
      intensity: num(1, 0, 1),
      effectParams: z.string().default(""),
    }).strict(),
    keyframeable: ["intensity"],
    phase: 1,
  },
  rectMask: {
    label: "Rectangle",
    group: "mask",
    inputs: [],
    outputs: MATTE_OUT,
    params: z.object({ ...shapeMaskParams, cornerRadius: num(0, 0, 1) }).strict(),
    keyframeable: ["centerX", "centerY", "width", "height", "feather"],
    phase: 1,
  },
  ellipseMask: {
    label: "Ellipse",
    group: "mask",
    inputs: [],
    outputs: MATTE_OUT,
    params: z.object(shapeMaskParams).strict(),
    keyframeable: ["centerX", "centerY", "width", "height", "feather"],
    phase: 1,
  },
  polygonMask: {
    label: "Polygon",
    group: "mask",
    inputs: [],
    outputs: MATTE_OUT,
    // points = JSON array of [x,y] pairs in COMP FRACTIONS (0..1), e.g. "[[0.3,0.2],[0.7,0.2],[0.5,0.85]]".
    // A fresh node needs a visible default shape — a centered triangle.
    params: z.object({
      points: z.string().default("[[0.3,0.2],[0.7,0.2],[0.5,0.85]]"),
      feather: num(0, 0, 1),
      invert: z.boolean().default(false),
    }).strict(),
    keyframeable: ["feather"],
    phase: 1.5,
  },
  bezierMask: {
    label: "Bezier",
    group: "mask",
    inputs: [],
    outputs: MATTE_OUT,
    // Same points payload as polygonMask; lowers with shape "bezier" (straight segments — no
    // control-handle authoring in this pass, see FLAREX.md Phase 1.5 scope note).
    params: z.object({
      points: z.string().default("[[0.25,0.2],[0.75,0.25],[0.7,0.8],[0.3,0.75]]"),
      feather: num(0, 0, 1),
      invert: z.boolean().default(false),
    }).strict(),
    keyframeable: ["feather"],
    phase: 1.5,
  },
  matteControl: {
    label: "Matte Control",
    group: "mask",
    inputs: [matte("a", "Matte A"), matte("b", "Matte B")],
    outputs: MATTE_OUT,
    params: z.object({
      operation: z.enum(["add", "subtract", "intersect", "exclude"]).default("add"),
      invert: z.boolean().default(false),
      feather: num(0, 0, 1),
    }).strict(),
    keyframeable: ["feather"],
    phase: 1,
  },
  chromaKey: {
    label: "Chroma Keyer",
    group: "mask",
    inputs: [image("in", "Input", true)],
    outputs: OUT,
    params: z.object({
      color: z.string().default("#00b140"),
      tolerance: num(0.35, 0, 1),
      softness: num(0.1, 0, 1),
      // Keyer v2 (pro 3-pass graph): screen levels + matte-space edge refinement + edge cleanup.
      clipBlack: num(0, 0, 1),
      clipWhite: num(1, 0, 1),
      spillSuppression: num(0.5, 0, 1),
      edgeSoftness: num(2, 0, 20),
      choke: num(0.05, -1, 1),
      decontaminate: num(0.5, 0, 1),
      matteOnly: z.boolean().default(false),
    }).strict(),
    keyframeable: ["tolerance", "softness", "clipBlack", "clipWhite", "spillSuppression", "edgeSoftness", "choke", "decontaminate"],
    phase: 1,
  },
  lumaKey: {
    label: "Luma Keyer",
    group: "mask",
    inputs: [image("in", "Input", true)],
    outputs: OUT,
    params: z.object({
      low: num(0, 0, 1),
      high: num(1, 0, 1),
      softness: num(0.1, 0, 1),
      invert: z.boolean().default(false),
      matteOnly: z.boolean().default(false),
    }).strict(),
    keyframeable: ["low", "high", "softness"],
    phase: 1.5,
  },
  text: {
    label: "Text+",
    group: "generator",
    inputs: [],
    outputs: OUT,
    params: z.object({
      content: z.string().default("Text"),
      fontFamily: z.string().default("Inter"),
      fontSize: num(96, 1, 800),
      color: z.string().default("#ffffff"),
      x: num(0.5, 0, 1),
      y: num(0.5, 0, 1),
    }).strict(),
    keyframeable: ["fontSize", "x", "y"],
    phase: 1,
  },
  aiMatte: {
    label: "AI Matte",
    group: "mask",
    inputs: [],
    outputs: MATTE_OUT,
    // artifactId of a maskSequence tool artifact; resolved like MatteRef (durable URI pre-export).
    params: z.object({
      artifactId: z.string().default(""),
      feather: num(0, 0, 1),
      invert: z.boolean().default(false),
    }).strict(),
    keyframeable: ["feather"],
    phase: 1.5,
  },
  backdrop: {
    label: "Backdrop",
    group: "layout",
    // No sockets — pure canvas organization, never enters the lowering DFS (the compiler cannot
    // reach it: nothing can wire FROM a node with no outputs).
    inputs: [],
    outputs: [],
    params: z.object({
      title: z.string().default("Backdrop"),
      color: z.string().default("#3a3f4a"),
      w: num(320, 80, 4000),
      h: num(200, 60, 4000),
    }).strict(),
    keyframeable: [],
    phase: 1.5,
  },
  reroute: {
    label: "Reroute",
    group: "layout",
    // Fusion-style wire dot: pure pass-through (organization only — same image type in and out).
    inputs: [image("in", "In", true)],
    outputs: OUT,
    params: z.object({}).strict(),
    keyframeable: [],
    phase: 1.5,
  },
  tracker: {
    label: "Tracker",
    group: "tracking",
    inputs: [image("in", "Input", true)],
    outputs: OUT,
    // trackingPathId references a trackingPath artifact / editableFields entry (v2).
    params: z.object({ trackingPathId: z.string().default("") }).strict(),
    keyframeable: [],
    phase: 2,
  },
};

export const flarexNodeDefs: Record<FlarexNodeType, FlarexNodeDefinition> = Object.fromEntries(
  Object.entries(defs).map(([type, def]) => [type, { type: type as FlarexNodeType, ...def }])
) as Record<FlarexNodeType, FlarexNodeDefinition>;

export function getFlarexNodeDefinition(type: FlarexNodeType): FlarexNodeDefinition {
  return flarexNodeDefs[type];
}

/** Normalize/validate a node's params through its schema (fills defaults, rejects unknown keys). */
export function parseFlarexNodeParams(
  type: FlarexNodeType,
  params: Record<string, string | number | boolean> | undefined
): Record<string, string | number | boolean> {
  return flarexNodeDefs[type].params.parse(params ?? {}) as Record<string, string | number | boolean>;
}

/** Create a node with schema-default params. Position is canvas coordinates. */
export function createFlarexNode(type: FlarexNodeType, id: string, x = 0, y = 0): FlarexNode {
  return { id, type, enabled: true, params: parseFlarexNodeParams(type, {}), ui: { x, y } };
}

/** Socket lookup helpers used by edge validation (UI + actions). */
export function findFlarexInputSocket(type: FlarexNodeType, socketId: string): FlarexSocketDef | undefined {
  return flarexNodeDefs[type].inputs.find((s) => s.id === socketId);
}
export function findFlarexOutputSocket(type: FlarexNodeType, socketId: string): FlarexSocketDef | undefined {
  return flarexNodeDefs[type].outputs.find((s) => s.id === socketId);
}
