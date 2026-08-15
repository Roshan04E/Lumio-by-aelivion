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
  /** Palette grouping (Fusion-style toolbar sections) — the top-level CATEGORY, drives accent color. */
  group: "io" | "composite" | "color" | "filter" | "mask" | "generator" | "tracking" | "layout";
  /** Second-level grouping within the category, for the Add-Node browser's category → subcategory tree
   *  (Fusion "Add Tool" style). Attached in the registry build below, not per-def, so the taxonomy lives
   *  in ONE table. Future library nodes carry their own subcategory string. */
  subcategory: string;
  inputs: FlarexSocketDef[];
  outputs: FlarexSocketDef[];
  /** `.strict()` schema whose defaults define the node's initial params (output must stay
   *  a flat Record<string, string|number|boolean> — enforced by convention, ZodTypeAny for
   *  assignability of the concrete object schemas). */
  params: z.ZodTypeAny;
  /** Param keys the graph/keyframe editor may animate (scope "flarexNode"). */
  keyframeable: string[];
  /**
   * Param keys whose VALUE is a serialized animation track rather than a value — today only a mask
   * node's `shapeKeyframes`.
   *
   * Declared here, and read UNIFORMLY (never branched on `node.type`), because ADR-009 R1 says a
   * keyframed param contributes its EVALUATED VALUE and never its keyframe track. `computeFlarexContentHashes`
   * enforces R1 for numeric params by resolving them through the animation evaluator; a track that
   * arrives as a JSON string slips past that and hashes as a constant, so every consumer keyed on the
   * hash would treat an animating node as static. This list is how a node says "my hash has a time
   * term" without the hasher learning what a mask is (ADR-010 node-blindness).
   */
  trackParams?: readonly string[] | undefined;
  /**
   * Params naming a FONT FAMILY, for ADR-023 D11/T-8: the font's identity is an input to the content
   * hash of any node whose output is rasterized text.
   *
   * Without it, a family name that resolves to different BYTES — a user font replaced in the store, a
   * face installed after the first raster — produces new pixels under an unchanged key, and the
   * stale hit renders the old font forever. D11 says the font hash is part of the key; T-8 makes it
   * an obligation.
   *
   * **And it is deliberately NOT satisfied by the `document.fonts` listener alone.** That listener is
   * a LIVENESS signal, and this repo has a named class for correctness resting on one (DEBT-009,
   * whose fourth instance was a pinned font never reaching the glyphs because a debounced
   * notification lost a race). The listener may make the picture refresh SOONER; the key is what
   * makes it refresh AT ALL.
   *
   * Declared here and read uniformly, like `trackParams` above, so the hasher never learns what a
   * text node is (ADR-010 node-blindness).
   */
  fontParams?: readonly string[] | undefined;
  /** Phase gating: nodes past the current ship phase stay out of the palette. */
  phase: 1 | 1.5 | 2;
}

const image = (id: string, label: string, required = false): FlarexSocketDef => ({ id, type: "image", label, required });
const matte = (id: string, label: string): FlarexSocketDef => ({ id, type: "matte", label });
const OUT = [image("out", "Output")];
const MATTE_OUT: FlarexSocketDef[] = [{ id: "out", type: "matte", label: "Matte" }];

/** Channel Boolean sources — what an output channel may be sourced FROM. Order is the shader's own
 *  index order (`flarex.channels`), so the lowering maps name → index by position. */
export const flarexChannelSources = ["red", "green", "blue", "alpha", "luma", "black", "white"] as const;

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

/**
 * Shared params of the two OUTLINE mask nodes (polygon / bezier), alongside their own `points` default.
 *
 * `shapeKeyframes` is the outline's animation track: JSON `[{ t, p, e? }]` snapshots of the same point
 * form, resolved through the shared clip-mask evaluator (`mask-shape.ts` → `getMaskPathAtTime`). Empty
 * = not animated, which is every comp saved before this existed, and costs nothing.
 *
 * `expansion` grows (+) / shrinks (-) the outline, as a comp fraction on the SAME scale as `feather`
 * so the two read consistently in the inspector. The rasterizer has always honoured `Mask.expansion`;
 * these nodes simply never offered it, and choking a roto edge is a daily operation.
 */
const animatableOutlineParams = {
  shapeKeyframes: z.string().default(""),
  feather: num(0, 0, 1),
  expansion: num(0, -1, 1),
  invert: z.boolean().default(false),
};

/**
 * Track attachment — the params a node needs to FOLLOW an existing track. Shared verbatim by the
 * Tracker and by all four mask nodes so one picker drives every one of them and a track reads the
 * same wherever it is attached.
 *
 * `trackingPathData` is the embedded payload; see the Tracker's own note for why the points travel in
 * node params rather than by reference (`editableFields` never reaches a renderer, so a by-id design
 * tracks in the preview and sits still in the export). `smoothing` deliberately keeps the Tracker's
 * name and meaning: a mask and a Tracker attached to the SAME track must move together, and two
 * differently-named smoothing controls is how they would quietly stop.
 */
const trackAttachParams = {
  trackingPathId: z.string().default(""),
  trackingPathData: z.string().default(""),
  /** 0 = raw track, 1 = maximum smoothing. Overrides the artifact's own value when set. */
  smoothing: num(0, 0, 1),
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

const defs: Record<FlarexNodeType, Omit<FlarexNodeDefinition, "type" | "subcategory">> = {
  mediaIn: {
    label: "MediaIn",
    group: "io",
    inputs: [],
    outputs: OUT,
    // Self-contained comp (FLAREX.md Phase 2, Fusion Loader model): `sourceAssetId` "" = the HOST clip
    // (the clip this comp is attached to). A non-empty asset id loads that media pool asset directly —
    // decoded independently of the timeline, so nothing is borrowed from / removed from the timeline.
    //   sourceInSeconds — Trim In: where in the source to start (comp-local sync from there).
    //   freeze          — Hold: show a single held frame (source-in frame) instead of playing.
    params: z.object({
      sourceAssetId: z.string().default(""),
      sourceInSeconds: num(0, 0),
      freeze: z.boolean().default(false),
    }).strict(),
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
  crop: {
    label: "Crop",
    group: "composite",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // Edge insets as frame fractions; outside the box is TRANSPARENT (not black), so a crop composites
    // over whatever is behind it.
    params: z.object({
      left: num(0, 0, 1),
      right: num(0, 0, 1),
      top: num(0, 0, 1),
      bottom: num(0, 0, 1),
      softness: num(0, 0, 1),
    }).strict(),
    keyframeable: ["left", "right", "top", "bottom", "softness"],
    phase: 1,
  },
  channelBoolean: {
    label: "Channel Boolean",
    group: "composite",
    // No matte input: this rewrites channels wholesale, so a partial application is meaningless.
    inputs: [image("in", "Input", true)],
    outputs: OUT,
    // Resolve's Splitter/Combiner in one node — each output channel is sourced from any input channel,
    // luma, or a constant. "luma → alpha" is the one people reach for most (a matte from a plate).
    params: z.object({
      red: z.enum(flarexChannelSources).default("red"),
      green: z.enum(flarexChannelSources).default("green"),
      blue: z.enum(flarexChannelSources).default("blue"),
      alpha: z.enum(flarexChannelSources).default("alpha"),
      invertRgb: z.boolean().default(false),
    }).strict(),
    keyframeable: [],
    phase: 1,
  },
  color: {
    label: "Color",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    /**
     * THE grade node — the Resolve color-page model, where one node carries the whole toolset and you
     * chain nodes when you need a different MASK, not a different tool. The seven atomic color nodes
     * remain for precise Fusion-style graphs; this is the default.
     *
     * It is not a convenience wrapper: it is strictly cheaper than the equivalent chain. The grade
     * engine bakes an effect LIST into ONE pipeline (one 3D LUT, one pass), so every stage here costs
     * what a single stage costs — and unlike a chain of atoms it cannot hit the coalescing refusals
     * (`lowerColorNode`), which open a nested render target whenever a stage type REPEATS. Wheels →
     * Curves → Wheels is two nests as three nodes and one pipeline as one node.
     *
     * Param conventions are deliberately IDENTICAL to the atomic nodes (same names, same scales, same
     * JSON payload shapes) so both families feed one lowering path and one set of inspector editors —
     * there is no second color implementation to keep in sync. The parity gate asserts it: this node
     * and the equivalent chain must render byte-identical.
     *
     * `vignette`/`grain` are the exception and ride as FRAGMENT PASSES, not pipeline stages: a group
     * pipeline is compiled with `mediaEffects: null` (scene-compositor), so they can never be baked
     * into the LUT — the same constraint that made them fragment builtins in the first place.
     */
    params: z.object({
      // Primary correction — the `brightnessContrast` effect's own scale (saturation 100 = neutral).
      exposure: num(0, -100, 100),
      contrast: num(0, -100, 100),
      highlights: num(0, -100, 100),
      shadows: num(0, -100, 100),
      whites: num(0, -100, 100),
      blacks: num(0, -100, 100),
      saturation: num(100, 0, 220),
      vibrance: num(0, -100, 100),
      temperature: num(0, -100, 100),
      tint: num(0, -100, 100),
      // JSON payloads, same conventions as the atomic nodes (curve/wheel/qualifier editors reuse).
      wheels: z.string().default(""),
      curves: z.string().default(""),
      hueCurves: z.string().default(""),
      secondary: z.string().default(""),
      // LUT + creative look, each with its own intensity ("" = unconfigured, a no-op).
      lut: z.string().default(""),
      lutIntensity: num(1, 0, 1),
      look: z.string().default(""),
      lookIntensity: num(1, 0, 1),
      // Film — fragment passes, not pipeline stages (see above). Amount 0 = the pass is not emitted.
      vignetteAmount: num(0, 0, 1),
      vignetteSize: num(0.58, 0, 1),
      vignetteFeather: num(1, 0, 1),
      vignetteRoundness: num(0, 0, 1),
      vignetteHighlights: num(0, 0, 1),
      grainAmount: num(0, 0, 1),
      grainSize: num(1, 0.25, 4),
    }).strict(),
    keyframeable: [
      "exposure", "contrast", "highlights", "shadows", "whites", "blacks", "saturation", "vibrance", "temperature", "tint",
      "lutIntensity", "lookIntensity",
      "vignetteAmount", "vignetteSize", "vignetteFeather", "vignetteRoundness", "vignetteHighlights",
      "grainAmount", "grainSize",
    ],
    phase: 1,
  },
  colorCorrect: {
    label: "Color Correct",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // Params are declared in the `brightnessContrast` effect's OWN scale — ±100 sliders, saturation
    // 0..220 where 100 is NEUTRAL — because the lowering passes them through to that effect verbatim
    // and the inspector/graph editor already clamp to it (`FLAREX_PARAM_RANGES`). They previously
    // declared a different scale (±4 / 0..3), so a fresh node's `saturation: 1` reached the grade as
    // 1% saturation and quietly desaturated the image.
    params: z.object({
      exposure: num(0, -100, 100),
      contrast: num(0, -100, 100),
      highlights: num(0, -100, 100),
      shadows: num(0, -100, 100),
      whites: num(0, -100, 100),
      blacks: num(0, -100, 100),
      saturation: num(100, 0, 220),
      vibrance: num(0, -100, 100),
      temperature: num(0, -100, 100),
      tint: num(0, -100, 100),
    }).strict(),
    keyframeable: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "saturation", "vibrance", "temperature", "tint"],
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
  colorWheels: {
    label: "Color Wheels",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // JSON payload in the `colorWheels` effect-param convention (lift/gamma/gain/offset) — the same
    // shape the clip inspector's wheels control already reads and writes.
    params: z.object({ wheels: z.string().default("") }).strict(),
    keyframeable: [],
    phase: 1.5,
  },
  hslQualifier: {
    label: "HSL Qualifier",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // JSON payload in the `hslSecondary` effect-param convention (hue/sat/lum range + softness).
    params: z.object({ secondary: z.string().default("") }).strict(),
    keyframeable: [],
    phase: 1.5,
  },
  lut: {
    label: "LUT",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // `lut` = a base64 .cube payload (the `importedLut` effect's own param convention — the LUT
    // bytes travel WITH the project, so an export never has to resolve a file path).
    params: z.object({ lut: z.string().default(""), intensity: num(1, 0, 1) }).strict(),
    keyframeable: ["intensity"],
    phase: 1.5,
  },
  look: {
    label: "Look",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // `look` = a creative-look preset NAME from the shared registry; "" = not chosen yet (no-op,
    // same "unconfigured payload passes through" rule the curve nodes use).
    params: z.object({ look: z.string().default(""), intensity: num(1, 0, 1) }).strict(),
    keyframeable: ["intensity"],
    phase: 1.5,
  },
  vignette: {
    label: "Vignette",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // Mirrors the `flarex.vignette` builtin 1:1 (normalized 0..1, the MediaEffects contract), so a
    // vignette node and the clip vignette effect look identical.
    params: z.object({
      amount: num(0.35, 0, 1),
      size: num(0.58, 0, 1),
      feather: num(1, 0, 1),
      roundness: num(0, 0, 1),
      highlights: num(0, 0, 1),
    }).strict(),
    keyframeable: ["amount", "size", "feather", "roundness", "highlights"],
    phase: 1,
  },
  grain: {
    label: "Film Grain",
    group: "color",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // `size` is a multiplier on the 1280×720 virtual grain grid (1 = the media path's own grid).
    params: z.object({ amount: num(0.18, 0, 1), size: num(1, 0.25, 4) }).strict(),
    keyframeable: ["amount", "size"],
    phase: 1,
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
  directionalBlur: {
    label: "Directional Blur",
    group: "filter",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // Normalized 0..1 strength like the rest of the palette; the lowering scales it to the
    // builtin's own 0..100 range.
    params: z.object({ amount: num(0.4, 0, 1), angle: num(0, -180, 180) }).strict(),
    keyframeable: ["amount", "angle"],
    phase: 1,
  },
  radialBlur: {
    label: "Radial Blur",
    group: "filter",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // centerX/centerY are comp fractions (0..1), consistent with every other node's coordinates.
    params: z.object({ amount: num(0.4, 0, 1), centerX: num(0.5, 0, 1), centerY: num(0.5, 0, 1) }).strict(),
    keyframeable: ["amount", "centerX", "centerY"],
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
  pixelate: {
    label: "Pixelate",
    group: "filter",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // Block size in comp pixels, passed through verbatim (same convention the clip effect uses, so a
    // value reads the same on a clip and on a node).
    params: z.object({ blockSize: num(16, 1, 200) }).strict(),
    keyframeable: ["blockSize"],
    phase: 1,
  },
  prism: {
    label: "Prism",
    group: "filter",
    inputs: [image("in", "Input", true), matte("mask", "Mask")],
    outputs: OUT,
    // Chromatic aberration — the lens artefact, under Fusion's name for it.
    params: z.object({ amount: num(0.3, 0, 1), angle: num(0, -180, 180) }).strict(),
    keyframeable: ["amount", "angle"],
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
    params: z.object({ ...shapeMaskParams, ...trackAttachParams, cornerRadius: num(0, 0, 1) }).strict(),
    keyframeable: ["centerX", "centerY", "width", "height", "feather"],
    trackParams: ["trackingPathData"],
    phase: 1,
  },
  ellipseMask: {
    label: "Ellipse",
    group: "mask",
    inputs: [],
    outputs: MATTE_OUT,
    params: z.object({ ...shapeMaskParams, ...trackAttachParams }).strict(),
    keyframeable: ["centerX", "centerY", "width", "height", "feather"],
    trackParams: ["trackingPathData"],
    phase: 1,
  },
  polygonMask: {
    label: "Polygon",
    group: "mask",
    inputs: [],
    outputs: MATTE_OUT,
    // points = JSON array in COMP FRACTIONS (0..1): [x,y] for a corner, or [x,y,inX,inY,outX,outY] to
    // carry its bezier handles as deltas (see mask-shape.ts). A fresh node needs a visible default
    // shape — a centered triangle.
    params: z.object({
      points: z.string().default("[[0.3,0.2],[0.7,0.2],[0.5,0.85]]"),
      ...animatableOutlineParams,
      ...trackAttachParams,
    }).strict(),
    keyframeable: ["feather", "expansion"],
    trackParams: ["shapeKeyframes", "trackingPathData"],
    phase: 1.5,
  },
  bezierMask: {
    label: "Bezier",
    group: "mask",
    inputs: [],
    outputs: MATTE_OUT,
    // Same points payload as polygonMask; lowers with shape "bezier", so a point carrying handles
    // rasterizes as a cubic segment.
    params: z.object({
      points: z.string().default("[[0.25,0.2],[0.75,0.25],[0.7,0.8],[0.3,0.75]]"),
      ...animatableOutlineParams,
      ...trackAttachParams,
    }).strict(),
    keyframeable: ["feather", "expansion"],
    trackParams: ["shapeKeyframes", "trackingPathData"],
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
  /**
   * CHROMA KEYER — a keyer's PARAMETERS plus a keyer's INPUTS.
   *
   * In Fusion, Resolve and Nuke a keyer is never one-image-in / one-matte-out. It takes two auxiliary
   * mattes, and without them every real key devolves into a stack of masks downstream:
   *
   *   `garbage`  — forces alpha to ZERO where the matte is on. The rig, the light stand, the edge of
   *                the cyc where the screen runs out. ALWAYS WINS (see the compiler's ordering note).
   *   `holdOut`  — the core/solid matte: forces alpha to ONE where the matte is on. Protects detail the
   *                key eats — the classic case being a subject wearing a colour near the key.
   *
   * Both are ordinary `matte` sockets, so every matte source already in the graph (rect/ellipse/
   * polygon/bezier outlines, a MatteControl combination, a tracked shape) drives them with no new
   * vocabulary. `garbageInvert` / `holdOutInvert` flip each one's sense in place, so "everything except
   * this region" does not need a MatteControl inserted just to invert.
   */
  chromaKey: {
    label: "Chroma Keyer",
    group: "mask",
    inputs: [image("in", "Input", true), matte("garbage", "Garbage Matte"), matte("holdOut", "Hold-Out Matte")],
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
      // Both auxiliary mattes are invertible. Default false ⇒ a comp saved before the sockets existed
      // parses to exactly the behaviour it had.
      garbageInvert: z.boolean().default(false),
      holdOutInvert: z.boolean().default(false),
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
    /**
     * ADR-023 D9 (S7 half A): Text+ emits a MATTE as well as an image, which is what makes "video
     * inside text" an ordinary graph rather than a feature. The matte is the glyph coverage, so
     * `matteControl`, the keyer's garbage/hold-out sockets and every masked node consume it with no
     * new vocabulary at all — the point D9 makes about widening the VALUE rather than adding nodes.
     */
    outputs: [...OUT, { id: "matte", type: "matte", label: "Matte" }],
    params: z.object({
      content: z.string().default("Text"),
      fontFamily: z.string().default("Inter"),
      fontSize: num(96, 1, 800),
      fontWeight: num(700, 100, 900),
      color: z.string().default("#ffffff"),
      align: z.enum(["left", "center", "right"]).default("center"),
      x: num(0.5, 0, 1),
      y: num(0.5, 0, 1),
      // Stroke + drop shadow — routed to the SAME rasterizer the caption pipeline already uses
      // (`getCompositionTextStyle` → WebkitTextStroke/textShadow, drawn by `drawTextLayer`). Defaults
      // are all off (strokeWidth 0, shadowBlur 0), so an existing project's Text+ node rasterizes
      // byte-identically until a user turns one on.
      strokeWidth: num(0, 0, 100),
      strokeColor: z.string().default("#000000"),
      shadowBlur: num(0, 0, 150),
      shadowColor: z.string().default("#000000"),
      shadowOffsetX: num(0, -200, 200),
      shadowOffsetY: num(0, -200, 200),
    }).strict(),
    // Only PLACEMENT animates. x/y are applied by the compiler onto the composite quad, so they
    // animate for free; `fontSize` cannot — it changes the rasterized glyphs, and the raster is built
    // once per content change (not per frame) by the shared text rasterizer. Stroke/shadow are the same
    // shape of param as fontSize (they change the raster, not the quad), so they stay unkeyframeable too.
    keyframeable: ["x", "y"],
    // D11/T-8 — the family this node rasterizes with is part of its identity.
    fontParams: ["fontFamily"],
    phase: 1,
  },
  background: {
    label: "Background",
    group: "generator",
    inputs: [],
    outputs: OUT,
    // A comp-filling solid, backed by a virtual `shape` layer — so it rasterizes ONCE and is reused by
    // version (a static background never re-uploads). SOLID only: the shared shape rasterizer fills
    // with a plain colour and has no gradient path.
    params: z.object({ color: z.string().default("#000000"), opacity: num(1, 0, 1) }).strict(),
    keyframeable: ["opacity"],
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
  group: {
    label: "Group",
    group: "layout",
    // No sockets — like Backdrop, it is pure canvas organization and the compiler can never reach it
    // (nothing can wire FROM a node with no outputs). Collapsing a Group therefore cannot change a
    // single pixel: the graph stays flat and the lowering is identical either way.
    inputs: [],
    outputs: [],
    params: z.object({
      title: z.string().default("Group"),
      // JSON array of member node ids. The group's RECT is derived from where those members are, so
      // there is no stored size to drift out of sync with them.
      members: z.string().default("[]"),
      collapsed: z.boolean().default(false),
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
  timeSpeed: {
    label: "Time Speed",
    group: "layout",
    inputs: [image("in", "Input", true)],
    outputs: OUT,
    /**
     * RETIME (ADR-011). `speed` 0.5 plays the upstream at half rate, 2 at double; `offset` shifts it in
     * seconds. Applies to EVERYTHING above this node — animated params, generators, nested graphs — not
     * just video, which is why it needed a new evaluator question rather than a compile-time rewrite of
     * source sampling. See ADR-011 and plans/flarex-timespeed-tracker.md.
     *
     * Speed is not clamped to positive: a negative value runs the subtree backwards, which is a
     * legitimate retime and costs nothing extra here (the upstream is a pure function of time).
     *
     * NOT KEYFRAMEABLE, deliberately. The two halves of a retime resolve at different moments: the
     * parameters retime in the compiler, per frame; the PICTURE retimes on the MediaIn's loader, whose
     * rate is resolved once before any frame is drawn (`time-transform.ts`). A constant holds those
     * two in exact agreement. An animated one would not — grade and picture would slide apart, silently.
     * A ramped retime belongs on the same `speedKeyframes` substrate the inspector's speed ramp already
     * uses, so both halves integrate one curve; that is a later slice, not a checkbox here.
     */
    params: z.object({
      speed: num(1),
      offset: num(0),
    }).strict(),
    keyframeable: [],
    phase: 1.5,
  },
  tracker: {
    label: "Tracker",
    group: "tracking",
    inputs: [image("in", "Input", true)],
    outputs: OUT,
    // MATCH-MOVE v1 (2026-07-28): follows an EXISTING track (`trackingPathId` names a
    // TrackingPathArtifactData the person-extraction path already produces). It does not ANALYSE —
    // computing a track is a separate project. Empty id, or an id whose artifact is gone, passes
    // through untouched.
    /**
     * `trackAttachParams` carries the trio. EMBEDDED, not referenced, and that is a parity decision
     * rather than a storage one: `editableFields` lives on `ProjectGraph`, which the renderer never
     * receives, so a by-id-only Tracker would follow the track in the preview and sit still in the
     * export — exactly the class of divergence ADR-007 removes by construction. Carrying the points
     * in node params puts them in the manifest, which both renderers read. `trackingPathId` is
     * retained as provenance (which saved track this came from, for re-link and for a future store
     * that does reach the renderer); it is not what renders.
     *
     * `mode` (slice 2, 2026-08-11) chooses whether the track is applied to the element or inverted
     * onto the frame. The sign lives in `applyTrackAtTime`, never here and never in a renderer.
     */
    params: z.object({
      ...trackAttachParams,
      mode: z.enum(["matchMove", "stabilize"]).default("matchMove"),
    }).strict(),
    keyframeable: [],
    /**
     * `trackingPathData` is a TRACK: the node's output varies with time through a param that has no
     * numeric form, so ADR-009 R1 could not resolve it and the content hash was identical at every
     * frame while the transform moved. Same shape of defect slice 1 found on `shapeKeyframes`, and it
     * predates this slice — the Tracker has been hashing time-invariantly since it shipped
     * (2026-07-28). Declaring it here folds the time term; see `content-hash.ts`.
     */
    trackParams: ["trackingPathData"],
    phase: 1.5,
  },
};

/** Second-level (subcategory) taxonomy — ONE table so category → subcategory grouping stays in sync
 *  across the toolbar palette and the Add-Node browser. Category = `def.group` (drives accent color). */
const SUBCATEGORIES: Record<FlarexNodeType, string> = {
  mediaIn: "Source",
  mediaOut: "Source",
  merge: "Combine",
  transform: "Transform",
  crop: "Transform",
  channelBoolean: "Channel",
  color: "Grade",
  colorCorrect: "Adjust",
  colorWheels: "Adjust",
  colorCurves: "Curves",
  hueSat: "Curves",
  hslQualifier: "Secondary",
  lut: "LUT & Looks",
  look: "LUT & Looks",
  vignette: "Film",
  grain: "Film",
  blur: "Blur",
  directionalBlur: "Blur",
  radialBlur: "Blur",
  glow: "Light",
  sharpen: "Sharpen",
  pixelate: "Stylize",
  prism: "Lens",
  filter: "Stylize",
  rectMask: "Shape",
  ellipseMask: "Shape",
  polygonMask: "Shape",
  bezierMask: "Shape",
  matteControl: "Matte",
  chromaKey: "Keyer",
  lumaKey: "Keyer",
  text: "Text",
  background: "Solid",
  aiMatte: "AI",
  tracker: "Track",
  timeSpeed: "Time",
  backdrop: "Layout",
  group: "Layout",
  reroute: "Layout",
};

export const flarexNodeDefs: Record<FlarexNodeType, FlarexNodeDefinition> = Object.fromEntries(
  Object.entries(defs).map(([type, def]) => [type, { type: type as FlarexNodeType, subcategory: SUBCATEGORIES[type as FlarexNodeType], ...def }])
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
