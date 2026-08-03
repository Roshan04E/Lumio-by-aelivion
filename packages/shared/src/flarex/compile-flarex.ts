/**
 * Flarex lowering compiler (FLAREX.md Part 4) — the MVP evaluator.
 *
 * `compileFlarexComp` deterministically lowers a node comp into the `SceneDraw` primitives all
 * three renderers already consume (preview, local export, Remotion) — parity by construction:
 * the compiler never touches GL, it only builds the same draw structures `build-scene-draws.ts`
 * emits for ordinary clips. MediaIn is the host clip's already-built draw; MediaOut's input is
 * the result that replaces the clip's draw at its z-slot.
 *
 * Lowering vocabulary:
 *   merge      → SceneGroupDraw { children: [bg, fg±blend/opacity] }
 *   transform  → wrap group, shell.transform
 *   color      → wrap group, shell/group pipeline (grade-the-nest, Block 4a machinery)
 *   blur/glow  → wrap group, shell.blurPx / shell.glow (masked blur = SceneRegionPass)
 *   keyer/filter/sharpen → SceneFragmentPass on the wrap shell (fragment-effect registry)
 *   shape masks → vector `Mask` lists, rasterized via the caller's SceneMaskMatteCache
 *
 * Wrap-collapsing: a wrap group's shell renders [pipeline → regionPasses → fragmentPasses →
 * transform → blur → glow → mask] in that fixed order, so consecutive ops fold into ONE group
 * as long as each lands at or after the previous op's stage — only order violations and Merges
 * open new nest levels (the NEST_MAX_DEPTH budget, FLAREX.md Part 4).
 *
 * Determinism rule: node `ui`/comp `view` are never read; same (comp, ctx) → structurally
 * identical draws.
 */

import { evaluateFlarexNodeParam } from "../animation";
import { createBoxMask, createMask } from "../clip-masks";
import type { ColorPipeline } from "../color/types";
import { getFragmentEffect, resolveFragmentEffectParams } from "../color/fragment-effects/registry";
import {
  FLAREX_CHANNELS_ID,
  FLAREX_CHROMA_KEY_ID,
  FLAREX_CROP_ID,
  FLAREX_GRAIN_ID,
  FLAREX_LUMA_KEY_ID,
  FLAREX_VIGNETTE_ID,
  builtinFragmentEffectId,
  registerBuiltinFragmentEffects,
} from "../color/fragment-effects/builtins";

// The keyer/filter nodes resolve defs from the fragment registry; guarantee the builtins are
// registered no matter which module loaded first (idempotent — same call effects.ts makes).
registerBuiltinFragmentEffects();
import { getCompositionColorPipeline } from "../composition-style";
import { sampleTrackingPathAt, type TrackingPathArtifactData } from "../masks";

/**
 * Parse a Tracker node's embedded track. Malformed or empty JSON yields null, so the node passes
 * through — a corrupt param must degrade the node, never throw inside a per-frame lowering that runs
 * on the playback hot path.
 */
function parseTrackingPathParam(raw: string): TrackingPathArtifactData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TrackingPathArtifactData;
    return Array.isArray(parsed?.points) ? parsed : null;
  } catch {
    return null;
  }
}
import type { SceneMaskMatteCache } from "../scene/scene-mask-matte";
import type { SceneDraw, SceneFragmentPass, SceneGroupDraw, SceneLayerDraw, SceneRegionPass } from "../color/scene-compositor";
import type { Mask, TimelineEffect, TimelineLayer } from "../types";
import { computeFlarexContentHashes } from "./content-hash";
import { isSubstitutionReason, type FlarexDegradationReason, type FlarexOnDegrade } from "./degradation";
import { frameProfiler } from "../color/frame-profiler";
import { flarexChannelSources, getFlarexNodeDefinition } from "./node-defs";
import type { FlarexComp, FlarexNode, FlarexNodeType } from "./types";

export interface FlarexLowerCtx {
  /** Logical comp size (the host composition's — a Flarex comp shares its clip's comp geometry). */
  compWidth: number;
  compHeight: number;
  /** Playback render-resolution scale — baked into nest sizes / blur radii exactly like build-scene-draws. */
  renderScale: number;
  /** Comp-local time (t − clip start), drives node-param keyframes. */
  timeSeconds: number;
  /** Global frame time, threaded into fragment passes (`uTime` parity with buildFragmentPasses). */
  frameTimeSeconds: number;
  /** The host clip's normal, fully-built draw (grade + transform + masks + passes) = MediaIn. */
  hostSourceDraw: SceneLayerDraw;
  /**
   * May an unresolved MediaIn show the HOST CLIP's pixels? (ADR-012 I-27/I-34, slice S4.5.)
   *
   * `false` deletes the substitution: `resolveSourceDraw → null` means no picture, never someone
   * else's. Defaults to `true`, which is the pre-S4.5 behaviour, so a caller that has not been taught
   * the policy keeps exactly what it had.
   *
   * **Passed as DATA, never read as a flag here.** I-15 forbids the lowering layer from owning policy,
   * and reading a feature flag in this file is precisely that — it would also make the compile depend
   * on browser state, which is what keeps it out of the export and the harness. The host decides; the
   * compiler is told. The I-15 ratchet in `kernel-conformance.ts` fails the build if this file ever
   * grows a flag read, a clock or module state.
   */
  allowHostSubstitution?: boolean | undefined;
  /**
   * Out-channel for node evaluation records (slice S6.4). Absent = no records, today's behaviour.
   *
   * A CALLBACK, not a session handle — and the conformance harness is why. My first version imported
   * the kernel's record store here and `[I-15] the lowering layer owns no clock, no kernel dependency
   * and no module state` failed immediately. It was right: a compiler that reaches into the kernel is
   * a compiler that cannot run headless, in a second host, or in the worker without dragging a session
   * with it. Same shape as `onDegrade` and `onLayerNotReady` above — the compiler reports, the host
   * decides what that means and where it goes.
   */
  onEvaluated?: ((nodeId: string, contextKey: string, value: unknown) => void) | undefined;
  /** The caller's comp-sized matte cache; null = shape-mask nodes soft-degrade to no matte. */
  matteCache?: SceneMaskMatteCache | null | undefined;
  /**
   * Asset-source MediaIn (FLAREX.md Phase 2, Fusion Loader model): resolve the graded draw for a
   * MediaIn that loads a media-pool ASSET (`sourceAssetId`), decoded independently of the timeline —
   * so the comp is self-contained (nothing borrowed from the timeline). The caller backs each such
   * MediaIn with a VIRTUAL media layer (keyed by comp+node) and returns its plain graded draw here;
   * a source that isn't decoded/ready yet returns null → MediaIn falls back to `hostSourceDraw`
   * (soft-degrade, never blank). `"ended"` is DISTINCT from null: the source ran past its own
   * duration (a short clip in a longer comp), so the MediaIn produces NOTHING (transparent) rather
   * than the host — downstream merges then drop it and only the background remains. `nodeId` lets the
   * caller find that node's virtual layer. Omitted → every MediaIn resolves to the host clip (Phase 1).
   *
   * `"pending"` (2026-07-29) is the third distinct answer: a loader OWNS this node but has no picture
   * yet. The node then produces NOTHING rather than the host, because under a retime the host draw is
   * a different moment of the shot, not a degraded version of the right one — see the `mediaIn` case.
   * A caller that cannot tell "no loader" from "loader not ready" may keep returning null and simply
   * gets the Phase-1 soft-degrade, which is correct wherever nothing is retimed.
   */
  resolveSourceDraw?:
    | ((nodeId: string, sourceAssetId: string) => SceneLayerDraw | "ended" | "pending" | null)
    | undefined;
  /**
   * DEBUG OVERRIDE for the materialization decision (Flarex evaluation engine — ADR-008 rule 3):
   * force these node ids to SEAL their image output into an isolated render-target boundary (an
   * optimization barrier the wrap-collapser won't fold across), stamped with the node's
   * `evaluationKey`. This is only ONE term of the evaluator-owned decision (`materialize =
   * requiresMaterialization ∨ fanout>1 ∨ budget ∨ debugOverride`) — the evaluator decides the rest
   * structurally (see `shouldMaterialize`). NEVER serialized: it lives on the per-frame lower ctx,
   * never on node params or persisted project data. Used by tests and node-preview/debug tooling.
   */
  materializeNodeIds?: ReadonlySet<string> | undefined;
  /**
   * RUNTIME re-root: compile the graph as if this node were the output, WITHOUT touching the comp's
   * persisted `previewNodeId` (which is the user's own view-dot selection and must survive a thumbnail
   * pass untouched). Takes precedence over `previewNodeId` when set.
   *
   * This is what makes per-node previews (Slice 4) possible: a thumbnail is just this compile at
   * thumbnail resolution. Runtime-only — never serialized, never read from persisted project data.
   * Falls back to MediaOut exactly like `previewNodeId` when the node yields no image (matte-only,
   * unwired), so a preview pass can never blank the real viewer.
   */
  previewRootNodeId?: string | undefined;
  /**
   * DEGRADATION OUT-CHANNEL (slice S0.2). Called whenever a node produces less than it was asked for —
   * a source that ended, a loader with no picture yet, an unbacked generator, an unimplemented node, a
   * cycle, or a **host-clip substitution**. See `degradation.ts` for the vocabulary and for why the
   * three substitution reasons are kept apart.
   *
   * PURELY OBSERVABILITY, exactly like `buildSceneDraws`' `onLayerNotReady`: attaching it or omitting
   * it produces byte-identical draws, and the pixel gate asserts that with the channel attached and
   * detached. Omit it (export, worker, fixtures) and lowering behaves as it always has.
   *
   * The compiler does not know what a degradation *means* — it does not import the diagnostics sink,
   * does not decide severity, and does not decide whether anyone cares. That is the caller's, which is
   * what keeps lowering free of policy (ADR-012 I-15).
   */
  onDegrade?: FlarexOnDegrade | undefined;
  /**
   * Tracker (2026-07-28): resolve a `trackingPathId` to the tracking artifact it names. Mirrors
   * `resolveSourceDraw` — the compiler stays free of artifact storage, the caller owns lookup, and a
   * missing track returns null so the node soft-degrades to pass-through rather than blanking a comp
   * whose track was deleted. Omitted → every Tracker passes through (the Phase-1 behaviour).
   */
  resolveTrackingPath?: ((trackingPathId: string) => TrackingPathArtifactData | null) | undefined;
}

type FlarexImageValue = SceneLayerDraw | SceneGroupDraw;
/** Matte values stay VECTOR (`Mask[]`) until applied to an image, so MatteControl combines
 *  losslessly through the same multi-mask compositing the mask rasterizer already does. */
type FlarexMatteValue = { masks: Mask[] };
type FlarexValue = { kind: "image"; draw: FlarexImageValue } | { kind: "matte"; matte: FlarexMatteValue };

/** Shell-order stages for wrap-collapsing (see header). */
const STAGE_PIPELINE = 1;
const STAGE_REGION = 2;
const STAGE_FRAGMENT = 3;
const STAGE_TRANSFORM = 4;
const STAGE_BLUR = 5;
const STAGE_GLOW = 6;
const STAGE_MASK = 7;

/**
 * Resolve a declared SEMANTIC dependency (ADR-010) to its OPAQUE version token for the current frame.
 * This is the ONLY site that knows what each dependency NAME means (e.g. "time" = the frame time);
 * the compositor folds the resulting token into the cache identity without ever interpreting the
 * name. A declared dependency with no resolver here cannot be given a pixel-determining token, so the
 * artifact is left uncacheable (see `materialize`) rather than risk a stale hit. New dynamic axes add
 * a resolver entry — the compositor's cache logic never changes.
 */
const FLAREX_DEPENDENCY_RESOLVERS: Record<string, (ctx: FlarexLowerCtx, at: number) => string> = {
  /**
   * The FRAME time, deliberately — a token must describe what the shader actually reads.
   *
   * S6.2 first changed this to the evaluation time, on the reasoning that T4 makes evaluation time
   * authoritative. The flarex contract test rejected it, and the test was right: fragment passes take
   * `timeSeconds: ctx.frameTimeSeconds`, so `uTime` IS the playhead even inside a retimed subtree.
   * Keying on the evaluation time would have left the identity no longer determining the pixels — a
   * stale hit whenever the two diverge, which is a worse failure than the collision being fixed.
   *
   * The retime axis is handled separately and conditionally, at the fold site below. Whether a retimed
   * subtree's effects SHOULD animate on retimed time is a real question, and a different slice: it
   * would change pixels, which this one may not.
   */
  time: (ctx) => `t:${ctx.frameTimeSeconds}`,
};

/** Compiler-created wrap groups carry their collapse stage; the marker survives shallow clones
 *  (per-consumer copies) and is invisible to the compositor. */
interface FlarexWrapGroup extends SceneGroupDraw {
  __flarexStage?: number;
  /** Materialization boundary (Flarex evaluation engine, Slice 1): a sealed wrap is a TRUE
   *  optimization barrier — the wrap-collapser (`wrapFor`) never folds an op into it, so it always
   *  composites as its own render target. Set only by `materialize`, driven runtime-only by
   *  `ctx.materializeNodeIds`; survives the shallow clone via the object spread in `cloneImage`. */
  __flarexSealed?: boolean;
  /** The color effects already folded into this wrap's single `pipeline` slot, in application order
   *  (P1 — pipeline coalescing, see `lowerColorNode`). Present only on wraps a color node opened.
   *  Replaced, never mutated in place: `cloneImage` shares the array reference across per-consumer
   *  clones, so an in-place push would leak one branch's grade into another's. */
  __flarexColorEffects?: TimelineEffect[];
}

function isGroup(draw: FlarexImageValue): draw is SceneGroupDraw {
  return (draw as SceneGroupDraw).kind === "group";
}

/** Default comp-fraction shapes, mirrored from node-defs' param defaults — the soft-fail target
 *  when a node's `points` JSON is missing/malformed (never throw; a fresh/bad node still shows
 *  something rather than vanishing the matte). */
const DEFAULT_MASK_POINTS: Record<"polygonMask" | "bezierMask", Array<[number, number]>> = {
  polygonMask: [[0.3, 0.2], [0.7, 0.2], [0.5, 0.85]],
  bezierMask: [[0.25, 0.2], [0.75, 0.25], [0.7, 0.8], [0.3, 0.75]],
};

/** Parse a `points` param (JSON array of `[x, y]` comp-fraction pairs) — soft-fails to the node
 *  type's default shape on malformed/empty JSON so a bad payload never throws mid-lowering. */
function parseFractionPoints(raw: string, nodeType: "polygonMask" | "bezierMask"): Array<[number, number]> {
  const fallback = DEFAULT_MASK_POINTS[nodeType];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length < 3) return fallback;
    const points = parsed
      .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n)))
      .map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] as [number, number]);
    return points.length >= 3 ? points : fallback;
  } catch {
    return fallback;
  }
}

function parseHexColor(input: string): [number, number, number] {
  const hex = (input || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
  }
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [parseInt(hex[0]! + hex[0]!, 16) / 255, parseInt(hex[1]! + hex[1]!, 16) / 255, parseInt(hex[2]! + hex[2]!, 16) / 255];
  }
  return [0, 0.69, 0.25];
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** A JSON-payload color node's effect params, or null when the payload is empty (= not configured
 *  yet, so the node passes its input through untouched — the rule the curve nodes always had). */
const jsonPayload = (value: string, effectParamKey: string): Record<string, string> | null =>
  value ? { [effectParamKey]: value } : null;

interface FlarexParamReader {
  num: (key: string, fallback: number) => number;
  str: (key: string, fallback: string) => string;
  bool: (key: string) => boolean;
}

/** A Channel Boolean source NAME → the shader's index vocabulary, by position in the shared list.
 *  One source of truth for the order: the node def's enum and the GLSL switch are the same list. */
const channelSourceIndex = (source: string): number => {
  const index = flarexChannelSources.indexOf(source as (typeof flarexChannelSources)[number]);
  return index < 0 ? 0 : index;
};

interface FlarexColorNodeSpec {
  /** The timeline color effect this node IS, compiled by the same engine every renderer grades with. */
  effect: TimelineEffect["type"];
  /** Effect params from the node's params, or null = unconfigured (pass through). */
  build: (read: FlarexParamReader) => Record<string, number | string> | null;
}

/**
 * Color nodes → ONE timeline color effect each.
 *
 * Every entry lowers through the same body (`lowerColorNode`), so a new color node is a table row
 * rather than another `case` — and the pipeline coalescer can treat them uniformly without learning
 * node types. Only effects in `COLOR_EFFECT_TYPES` (the 3D-LUT pipeline stages) belong here;
 * vignette/grain live in the media shader, not the pipeline, so they lower as fragment passes.
 *
 * Note the node-param key vs. effect-param key mismatches: `colorCurves` effects read `params.curve`
 * while the node stores `curves`, and `hueSatCurves` effects read `params.curves` while the node
 * stores `hueCurves`. Both are singular/plural inversions of each other — keep them straight.
 */
const FLAREX_COLOR_NODES: Partial<Record<FlarexNodeType, FlarexColorNodeSpec>> = {
  colorCorrect: {
    effect: "brightnessContrast",
    // Node params are already declared in this effect's own scale (see node-defs) — passed through.
    build: (p) => ({
      exposure: p.num("exposure", 0),
      contrast: p.num("contrast", 0),
      highlights: p.num("highlights", 0),
      shadows: p.num("shadows", 0),
      whites: p.num("whites", 0),
      blacks: p.num("blacks", 0),
      saturation: p.num("saturation", 100),
      vibrance: p.num("vibrance", 0),
      temperature: p.num("temperature", 0),
      tint: p.num("tint", 0),
    }),
  },
  colorCurves: { effect: "colorCurves", build: (p) => jsonPayload(p.str("curves", ""), "curve") },
  hueSat: { effect: "hueSatCurves", build: (p) => jsonPayload(p.str("hueCurves", ""), "curves") },
  colorWheels: { effect: "colorWheels", build: (p) => jsonPayload(p.str("wheels", ""), "wheels") },
  hslQualifier: { effect: "hslSecondary", build: (p) => jsonPayload(p.str("secondary", ""), "secondary") },
  lut: {
    effect: "importedLut",
    build: (p) => {
      const lut = p.str("lut", "");
      return lut ? { lut, intensity: clamp01(p.num("intensity", 1)) * 100 } : null;
    },
  },
  look: {
    effect: "creativeLook",
    build: (p) => {
      const look = p.str("look", "");
      return look ? { look, intensity: clamp01(p.num("intensity", 1)) * 100 } : null;
    },
  },
};

/**
 * The unified `color` node's pipeline stages, in the order they enter the grade.
 *
 * ORDER IS THE CONTRACT — `compileColorPipeline` preserves effect order, so this list decides what the
 * node does. Correction first, creative last (primary → wheels → curves → hue/sat → qualifier → LUT →
 * look), which is the order a colorist would build the equivalent chain in and the order the clip
 * inspector's Color tab already presents. The parity test pins it against exactly that chain.
 *
 * A stage is OMITTED when it is still neutral, which is what makes a freshly-added Color node a true
 * pass-through rather than an identity grade: the payload stages use the same "unconfigured payload →
 * nothing" rule as the atomic nodes, and the primary correction is compared against its own defaults.
 */
function buildUnifiedColorEffects(
  nodeId: string,
  p: FlarexParamReader,
  make: (nodeId: string, type: TimelineEffect["type"], params: Record<string, number | string>) => TimelineEffect
): TimelineEffect[] {
  const effects: TimelineEffect[] = [];
  const primary = {
    exposure: p.num("exposure", 0),
    contrast: p.num("contrast", 0),
    highlights: p.num("highlights", 0),
    shadows: p.num("shadows", 0),
    whites: p.num("whites", 0),
    blacks: p.num("blacks", 0),
    saturation: p.num("saturation", 100),
    vibrance: p.num("vibrance", 0),
    temperature: p.num("temperature", 0),
    tint: p.num("tint", 0),
  };
  // Saturation is the one non-zero neutral (100 = unchanged) — the same scale trap that shipped a
  // desaturating Color Correct node before it was fixed.
  const primaryTouched = Object.entries(primary).some(([key, value]) => (key === "saturation" ? value !== 100 : value !== 0));
  // Distinct effect ids per stage: they share one node, but the pipeline treats them as separate
  // effects and an id collision would let one stage's cache entry answer for another.
  if (primaryTouched) effects.push(make(`${nodeId}:primary`, "brightnessContrast", primary));

  const wheels = p.str("wheels", "");
  if (wheels) effects.push(make(`${nodeId}:wheels`, "colorWheels", { wheels }));
  const curves = p.str("curves", "");
  if (curves) effects.push(make(`${nodeId}:curves`, "colorCurves", { curve: curves }));
  const hueCurves = p.str("hueCurves", "");
  if (hueCurves) effects.push(make(`${nodeId}:hueSat`, "hueSatCurves", { curves: hueCurves }));
  const secondary = p.str("secondary", "");
  if (secondary) effects.push(make(`${nodeId}:qualifier`, "hslSecondary", { secondary }));
  const lut = p.str("lut", "");
  if (lut) effects.push(make(`${nodeId}:lut`, "importedLut", { lut, intensity: clamp01(p.num("lutIntensity", 1)) * 100 }));
  const look = p.str("look", "");
  if (look) effects.push(make(`${nodeId}:look`, "creativeLook", { look, intensity: clamp01(p.num("lookIntensity", 1)) * 100 }));
  return effects;
}

interface FlarexFilterNodeSpec {
  /** Registry id of the fragment effect this node wraps. */
  effect: string;
  /** Effect params from the node's params, in the EFFECT's own units. */
  build: (read: FlarexParamReader) => Record<string, number | number[] | boolean>;
}

/**
 * Filter nodes → ONE fragment-effect builtin each.
 *
 * These are the same shaders the clip effect list has always used, given first-class node identities
 * so the palette reads like a tool set instead of one "Filter" escape hatch. Cheap by construction:
 * fragment passes STACK on a single wrap shell (`STAGE_FRAGMENT` accepts many), so four filters in a
 * row are four passes on one render target — not four nests.
 *
 * Node params are normalized 0..1 like the rest of the palette and scaled here to each builtin's own
 * range; `pixelate.blockSize` is the exception, a real pixel size passed through so a value reads the
 * same on a clip and on a node.
 */
const FLAREX_FILTER_NODES: Partial<Record<FlarexNodeType, FlarexFilterNodeSpec>> = {
  directionalBlur: {
    effect: builtinFragmentEffectId("directionalBlur"),
    build: (p) => ({ amount: clamp01(p.num("amount", 0.4)) * 100, angle: p.num("angle", 0) }),
  },
  radialBlur: {
    effect: builtinFragmentEffectId("radialBlur"),
    build: (p) => ({
      amount: clamp01(p.num("amount", 0.4)) * 100,
      centerX: clamp01(p.num("centerX", 0.5)) * 100,
      centerY: clamp01(p.num("centerY", 0.5)) * 100,
    }),
  },
  pixelate: {
    effect: builtinFragmentEffectId("pixelate"),
    build: (p) => ({ blockSize: Math.max(1, p.num("blockSize", 16)) }),
  },
  prism: {
    effect: builtinFragmentEffectId("chromaticAberration"),
    build: (p) => ({ amount: clamp01(p.num("amount", 0.3)) * 100, angle: p.num("angle", 0) }),
  },
  crop: {
    effect: FLAREX_CROP_ID,
    build: (p) => ({
      left: clamp01(p.num("left", 0)),
      right: clamp01(p.num("right", 0)),
      top: clamp01(p.num("top", 0)),
      bottom: clamp01(p.num("bottom", 0)),
      softness: clamp01(p.num("softness", 0)),
    }),
  },
  channelBoolean: {
    effect: FLAREX_CHANNELS_ID,
    // Named sources → the shader's index vocabulary, by position in `flarexChannelSources`.
    build: (p) => ({
      rFrom: channelSourceIndex(p.str("red", "red")),
      gFrom: channelSourceIndex(p.str("green", "green")),
      bFrom: channelSourceIndex(p.str("blue", "blue")),
      aFrom: channelSourceIndex(p.str("alpha", "alpha")),
      invertRgb: p.bool("invertRgb"),
    }),
  },
  vignette: {
    effect: FLAREX_VIGNETTE_ID,
    build: (p) => ({
      amount: clamp01(p.num("amount", 0.35)),
      size: clamp01(p.num("size", 0.58)),
      feather: clamp01(p.num("feather", 1)),
      roundness: clamp01(p.num("roundness", 0)),
      highlights: clamp01(p.num("highlights", 0)),
    }),
  },
  grain: {
    effect: FLAREX_GRAIN_ID,
    build: (p) => ({
      amount: clamp01(p.num("amount", 0.18)),
      size: Math.max(0.25, Math.min(4, p.num("size", 1))),
    }),
  },
};

/** Shared empty animations array for the synthetic grade layer — see `stableColorEffects`: the grade
 *  pipeline cache compares this by IDENTITY, so a fresh `[]` per frame would defeat it. Node params
 *  are already keyframe-resolved before they reach the effect, so there is nothing to animate here. */
const FLAREX_NO_ANIMATIONS: never[] = [];

/**
 * P2 — make the shared grade-pipeline cache actually hit for Flarex.
 *
 * `getCompositionColorPipeline` caches on the effects ARRAY IDENTITY, so the fresh array Flarex built
 * every frame missed on every frame and re-baked the 3D LUT 60×/s (composition-style.ts calls out this
 * exact hazard by name). Hand back the SAME array instance whenever the fully-resolved effect list is
 * unchanged, so a static grade compiles once. The key is the resolved content, so an animated param
 * still recompiles exactly when its value changes — a stale grade is impossible, only a wasted compile
 * is avoided. Bounded, and cleared wholesale on overflow (a cheap cache, not an LRU).
 */
const FLAREX_EFFECT_LIST_CACHE_MAX = 256;
const flarexEffectListCache = new Map<string, TimelineEffect[]>();

function stableColorEffects(effects: TimelineEffect[]): TimelineEffect[] {
  const key = JSON.stringify(effects);
  const cached = flarexEffectListCache.get(key);
  if (cached) return cached;
  if (flarexEffectListCache.size >= FLAREX_EFFECT_LIST_CACHE_MAX) flarexEffectListCache.clear();
  flarexEffectListCache.set(key, effects);
  return effects;
}

export function compileFlarexComp(comp: FlarexComp, ctx: FlarexLowerCtx): FlarexImageValue | null {
  // Profiler-only: count invocations this frame. `evaluator.compile` (a measure) SUMS across every call,
  // so browser-vs-Node compile time only compares like-for-like once divided by this (multiple clips /
  // transition sides / nested / capture all re-enter here). No-op unless profiling.
  frameProfiler.bump("compile.calls");
  const nodes = comp.nodes;
  const mediaOut = Object.values(nodes).find((node) => node.type === "mediaOut");
  if (!mediaOut) return null;

  // to-socket → edge (a socket accepts at most one wire; the healer enforces endpoint validity).
  const edgeInto = new Map<string, string>();
  // from-node → number of consumer sockets reading its output (fan-out). The structural half of the
  // evaluator-owned materialize decision (ADR-008): a node feeding 2+ consumers seals ONCE so the
  // content cache (Slice 2, commit 3) can dedupe it, instead of the current clone-per-consumer.
  const fanout = new Map<string, number>();
  frameProfiler.bump("compile.maps", 2); // edgeInto + fanout (profiler-only temp-collection count)
  for (const edge of comp.edges) {
    edgeInto.set(`${edge.to.nodeId}:${edge.to.socket}`, edge.from.nodeId);
    fanout.set(edge.from.nodeId, (fanout.get(edge.from.nodeId) ?? 0) + 1);
  }

  /**
   * Keyframe-aware numeric param, evaluated AT AN EXPLICITLY PASSED TIME (ADR-012 T4, slice S6.1).
   *
   * `at` is first and required. It used to read a mutable `activeTimeSeconds` cursor that the retime
   * scope saved and restored around `lowerNode`, and the argument for that was real: threading a
   * parameter through every helper is wide, and a missed site is silent — it evaluates a param at the
   * wrong time with no error.
   *
   * T4 inverts that argument rather than dismissing it. Once the ambient cursor does not EXIST, a
   * missed site cannot be silent, because there is nothing left for it to read: it stops compiling.
   * The wide change is paid once, in exchange for the whole class becoming unrepresentable — which is
   * the difference between fixing the three sites that read the un-retimed clock and making a fourth
   * one impossible to write.
   */
  const num = (at: number, node: FlarexNode, key: string, fallback: number): number => {
    frameProfiler.bump("compile.paramEvals");
    const base = typeof node.params[key] === "number" ? (node.params[key] as number) : fallback;
    return evaluateFlarexNodeParam({ animations: comp.animations, baseValue: base, nodeId: node.id, paramKey: key, timeSeconds: at });
  };
  const str = (node: FlarexNode, key: string, fallback: string): string =>
    typeof node.params[key] === "string" ? (node.params[key] as string) : fallback;
  const bool = (node: FlarexNode, key: string): boolean => node.params[key] === true;

  const nestW = Math.max(1, Math.round(ctx.compWidth * ctx.renderScale));
  const nestH = Math.max(1, Math.round(ctx.compHeight * ctx.renderScale));

  // Content-addressed evaluation cache metadata (Slice 2, commit 3a — plumbing only). Per-node
  // NodeContentHash (ADR-009 R1+R3, pure node content — resolution/time NOT folded in), stamped onto
  // sealed groups so the compositor can later key its artifact cache on content, not identity. Unread
  // until commit 3b → output is byte-identical today.
  const contentHashes = frameProfiler.measure("evaluator.hash", () => computeFlarexContentHashes(comp, ctx.timeSeconds));

  /** Collect the SEMANTIC dependency declarations a built draw subtree reads (ADR-010) — the union of
   *  its fragment passes' declared `def.dependencies`, read as FACTS (never from GLSL; the registry
   *  already derived them). Drives the sealed artifact's cache identity (dynamic deps fold into the
   *  key) and later its retention (3c). Fragment passes live only on group shells (`pushFragmentPass`
   *  wraps), so a bare layer contributes nothing. */
  const collectDrawDependencies = (d: SceneDraw, acc: Set<string> = new Set<string>()): Set<string> => {
    if ((d as SceneGroupDraw).kind === "group") {
      const group = d as SceneGroupDraw;
      for (const pass of group.shell.fragmentPasses ?? []) for (const dep of pass.def.dependencies ?? []) acc.add(dep);
      for (const child of group.children) collectDrawDependencies(child, acc);
    }
    return acc;
  };

  /**
   * Collect the SOURCE-CONTENT axis of a materialized artifact's identity: the fold of every raster's
   * declared `sourceVersion` / `maskVersion`. That is the compositor's own long-standing texture-cache
   * contract, read here as a declared FACT exactly like a fragment pass's `def.dependencies` — the
   * evaluator still never inspects node types (ADR-010).
   *
   * WHY (Slice 2, commit 3c-A): without this axis the identity did not describe the PIXELS. Dependencies
   * were harvested from fragment passes ONLY, so a subtree whose sole dynamic input is a live media
   * source — which declares no fragment-pass dependency — produced the SAME key on every frame. The
   * compositor's hit path composites the cached artifact and skips the children render outright, so a
   * fanned-out `MediaIn` (materialized by `fanout > 1`) served its first decoded frame forever: a
   * permanently frozen clip. The single-frame `render:compare:pixels` fixtures cannot see a cross-frame
   * staleness bug, which is why it shipped (commit 3c-C adds the sequence gate that can).
   *
   * `dynamic` = at least one raster is UNVERSIONED (`sourceVersion: undefined`, the documented "always
   * re-upload, content may change every frame" declaration). Its pixels are then not described by any key
   * we can build, so the artifact must stay uncacheable — the same fail-safe an unresolvable semantic
   * dependency already takes. Versioned rasters (media grade stamps, text/shape/still rasters) fold their
   * version in and REMAIN cacheable, which is where the cross-frame reuse win actually lives.
   */
  interface SourceIdentityScan {
    tokens: string[];
    dynamic: boolean;
  }
  const addRasterVersion = (acc: SourceIdentityScan, raster: unknown, version: number | undefined): void => {
    if (raster === null || raster === undefined) return; // no raster bound → nothing to describe
    if (version === undefined) {
      acc.dynamic = true; // unversioned ⇒ undescribable ⇒ uncacheable
      return;
    }
    acc.tokens.push(`v${version}`);
  };
  const scanSourceIdentity = (d: SceneDraw, acc: SourceIdentityScan): SourceIdentityScan => {
    if (acc.dynamic) return acc; // already uncacheable — the rest of the walk cannot change that
    const kind = (d as SceneGroupDraw).kind;
    if (kind === "group") {
      const group = d as SceneGroupDraw;
      addRasterVersion(acc, group.shell.mask, group.shell.maskVersion);
      for (const child of group.children) scanSourceIdentity(child, acc);
      return acc;
    }
    if (kind === "transition") {
      // A transition mixes on a continuous `progress` that no declared version describes. Flarex emits
      // none today; treat it as undescribable rather than risk serving a stale mix.
      acc.dynamic = true;
      return acc;
    }
    const layer = d as SceneLayerDraw;
    addRasterVersion(acc, layer.source, layer.sourceVersion);
    addRasterVersion(acc, layer.mask, layer.maskVersion);
    return acc;
  };

  /** Per-consumer shallow copy so shared subtrees are never mutated through one consumer's wraps. */
  const cloneImage = (draw: FlarexImageValue): FlarexImageValue => {
    // Profiler-only compile breakdown: per-consumer clone = temp objects (group→draw+shell+transform;
    // layer→draw+transform). No-op unless profiling.
    frameProfiler.bump("compile.clones");
    frameProfiler.bump("compile.drawCommands");
    if (isGroup(draw)) {
      frameProfiler.bump("compile.objects", 3);
      return { ...draw, shell: { ...draw.shell, transform: { ...draw.shell.transform } } } as FlarexWrapGroup;
    }
    frameProfiler.bump("compile.objects", 2);
    return { ...draw, transform: { ...draw.transform } };
  };

  const identityShell = (): SceneGroupDraw["shell"] => ({
    fit: "fill",
    blendMode: "normal",
    transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
  });

  const newWrap = (inner: FlarexImageValue): FlarexWrapGroup => {
    // Profiler-only: a fresh nest wrap = group + shell + transform objects + a children array.
    frameProfiler.bump("compile.wraps");
    frameProfiler.bump("compile.drawCommands");
    frameProfiler.bump("compile.objects", 3);
    frameProfiler.bump("compile.arrays");
    return {
      kind: "group",
      debugGroupId: `flarex_${comp.id}`,
      children: [inner],
      nestWidth: nestW,
      nestHeight: nestH,
      shell: identityShell(),
      __flarexStage: 0,
    };
  };

  /** A wrap whose shell can still accept an op at `stage` (fixed shell order — re-wrap on violation). */
  const wrapFor = (draw: FlarexImageValue, stage: number): FlarexWrapGroup => {
    if (isGroup(draw)) {
      const wrap = draw as FlarexWrapGroup;
      // A sealed (materialized) wrap is a hard optimization barrier: never fold an op into it — fall
      // through to a fresh wrap so the sealed group stays its own render target.
      if (!wrap.__flarexSealed && wrap.__flarexStage !== undefined && wrap.__flarexStage <= stage) {
        // Same-stage single-use slots (pipeline/transform/blur/glow/mask) must not double-fill.
        const slotFree =
          stage === STAGE_REGION ||
          stage === STAGE_FRAGMENT ||
          (stage === STAGE_PIPELINE && !wrap.pipeline) ||
          (stage === STAGE_TRANSFORM && wrap.__flarexStage < STAGE_TRANSFORM) ||
          (stage === STAGE_BLUR && !wrap.shell.blurPx) ||
          (stage === STAGE_GLOW && !wrap.shell.glow) ||
          (stage === STAGE_MASK && !wrap.shell.mask);
        if (slotFree) {
          wrap.__flarexStage = Math.max(wrap.__flarexStage, stage);
          return wrap;
        }
      }
    }
    const wrap = newWrap(draw);
    wrap.__flarexStage = stage;
    return wrap;
  };

  /** Seal a node's image output into its OWN wrap group (its own RTT at composite time) that the
   *  collapser will never fold across — a true two-sided optimization barrier — stamped with the
   *  node's runtime `evaluationKey`. Runtime-only: reached solely via `ctx.materializeNodeIds`,
   *  never via persisted params. The input `draw` (whatever upstream folded) becomes the sealed
   *  group's child, so the boundary rasterizes everything up to and including this node's op. */
  /**
   * Is this wrap a pure container — an RTT that copies its child and applies nothing?
   *
   * The discriminator for tagging in place, and it is narrower than "is a group" on purpose. Sealing a
   * wrap that carries a real op would move that op OUT of the artifact: today the op is applied while
   * compositing into the sealed group's target, so the cached pixels include it; tagged in place, the
   * artifact holds the pre-op children and the op runs on the way out. The pixels still land the same,
   * but the artifact no longer means the same thing, and `materialization inserts only identity nests`
   * — the reason pixel parity holds BY CONSTRUCTION rather than by measurement — stops being true.
   *
   * An identity nest inside an identity nest is pure waste, and that IS the two-RTT case ADR-008 rule 2
   * names. Trading a structural guarantee for a slightly wider optimisation would be a poor bargain.
   */
  const isIdentityNest = (g: FlarexWrapGroup): boolean => {
    const sh = g.shell;
    return (
      !g.pipeline && !sh.mask && !sh.blurPx && !sh.glow && !sh.fragmentPasses && !sh.regionPasses &&
      sh.fit === "fill" && sh.blendMode === "normal" &&
      sh.transform.x === 50 && sh.transform.y === 50 && sh.transform.scale === 1 &&
      sh.transform.rotation === 0 && sh.transform.opacity === 100
    );
  };

  const materialize = (draw: FlarexImageValue, nodeId: string, at: number): FlarexWrapGroup => {
    /**
     * TAG THE GROUP THAT IS ALREADY THERE (ADR-008 rule 2, slice S6.3).
     *
     * Materialization means "this output gets its own render target". When the value is ALREADY a
     * compiler-owned wrap, it already has one — so wrapping it in a second group bought a second RTT
     * and an extra composite to produce identical pixels. Sealing in place is the same boundary at
     * half the cost.
     *
     * Narrow on purpose. Tagging is only safe for a group THIS compiler made (`__flarexStage` is the
     * marker) and has not already sealed for another node: sealing a group we do not own would change
     * the semantics of somebody else's subtree, and re-sealing an existing boundary would move it.
     * Everything else — a bare layer draw, a foreign group — still gets a wrap, because for those
     * there genuinely is no target yet.
     *
     * Safe to mutate: `materialize` runs on the value `evalNode` just produced, and every shared
     * subtree reaches a consumer through `cloneImage`'s per-consumer copy, so this object is not one
     * another consumer is holding.
     */
    const candidate = draw as FlarexWrapGroup;
    const inPlace =
      isGroup(draw) &&
      candidate.__flarexStage !== undefined &&
      !candidate.__flarexSealed &&
      isIdentityNest(candidate);
    const wrap = inPlace ? (draw as FlarexWrapGroup) : newWrap(draw);
    if (inPlace) frameProfiler.bump("compile.materializeTagged");
    wrap.__flarexSealed = true;
    frameProfiler.noteMaterialize();
    wrap.evaluationKey = `flarex_${comp.id}_${nodeId}`;
    // Slice 2: stamp the content-addressed cache identity. `contentHash` = the pure NodeContentHash
    // (validity); `dependencyVersions` = an OPAQUE fold of this artifact's resolved dynamic-dependency
    // tokens (ADR-010) so the identity FULLY determines the produced pixels — a time-varying node keys
    // per frame, a static one keys once. `evaluationKey` stays the stable slot identity (identity ≠
    // validity). If a declared dependency has NO resolver we cannot complete a pixel-determining key,
    // so we leave `contentHash` unset → the artifact stays uncacheable rather than risk a stale hit.
    //
    // The identity has TWO axes and needs both, or it does not describe the pixels (3c-A):
    //   1. semantic dependencies  — ambient inputs the shaders read (`time`), resolved to tokens;
    //   2. source content         — the declared version of every raster in the subtree.
    // An undescribable input on EITHER axis leaves the artifact uncacheable.
    const deps = [...collectDrawDependencies(draw)].sort();
    const resolvers = deps.map((dep) => FLAREX_DEPENDENCY_RESOLVERS[dep]);
    const sources = scanSourceIdentity(draw, { tokens: [], dynamic: false });
    if (!resolvers.some((resolve) => resolve === undefined) && !sources.dynamic) {
      wrap.contentHash = contentHashes.get(nodeId);
      const tokens = deps.map((_dep, index) => resolvers[index]!(ctx, at));
      // RETIMED NODES FOLD THEIR EVALUATION TIME (S6.2). `contentHashes` is computed once per compile
      // at `ctx.timeSeconds`, so for a node evaluated at another moment the hash describes the wrong
      // params — two retimes of one animated node hash identically while producing different pixels.
      //
      // Conditional on purpose. Folding `at` unconditionally would put a per-frame value into every
      // key, including static nodes that currently have no time term at all — their keys are stable
      // across frames, which is the entire reason they hit. Making every key change every frame would
      // "fix" a collision by destroying the cache for the nodes it serves best.
      if (at !== ctx.timeSeconds) tokens.push(`e:${at.toFixed(6)}`);
      if (deps.length) wrap.dependencies = deps;
      // Source versions are an OPAQUE identity term, not a semantic dependency name — they fold into
      // `dependencyVersions` (which the compositor never interprets) but never into `dependencies`
      // (the declared FACTS the retention policy reads in 3c-B).
      tokens.push(...sources.tokens);
      if (tokens.length) wrap.dependencyVersions = tokens.join("|");
    }
    return wrap;
  };

  const pushFragmentPass = (draw: FlarexImageValue, pass: SceneFragmentPass): FlarexImageValue => {
    const wrap = wrapFor(draw, STAGE_FRAGMENT);
    frameProfiler.bump("compile.operations");
    frameProfiler.bump("compile.arrays");
    wrap.shell.fragmentPasses = [...(wrap.shell.fragmentPasses ?? []), pass];
    return wrap;
  };

  const pushRegionPass = (draw: FlarexImageValue, pass: SceneRegionPass): FlarexImageValue => {
    const wrap = wrapFor(draw, STAGE_REGION);
    frameProfiler.bump("compile.operations");
    frameProfiler.bump("compile.arrays");
    wrap.shell.regionPasses = [...(wrap.shell.regionPasses ?? []), pass];
    return wrap;
  };

  /**
   * Rasterize a matte value through the caller's comp-sized cache. Null = soft degrade (no matte).
   *
   * Rasterized at the EVALUATION time (T4, slice S6.1), not the frame time. This was one of the three
   * sites reading the un-retimed clock: a matte inside a TimeSpeed subtree animates on the playhead
   * while the image it masks animates on the retimed clock, so the mask and its content drift apart —
   * visibly, and only under a retime, which is why it survived. Identical for every non-retimed graph,
   * where `at` IS `ctx.timeSeconds`.
   */
  const rasterizeMatte = (matte: FlarexMatteValue, key: string, at: number): { tex: TexImageSource; version: number | undefined } | null => {
    const mc = ctx.matteCache;
    if (!mc || matte.masks.length === 0) return null;
    const layerLike = { id: key, masks: matte.masks, animations: [] } as unknown as TimelineLayer;
    const tex = mc.get(layerLike, at);
    if (!tex) return null;
    return { tex, version: mc.versionOf(key) };
  };

  const applyMatteToImage = (draw: FlarexImageValue, matte: FlarexMatteValue, key: string, at: number): FlarexImageValue => {
    const raster = rasterizeMatte(matte, key, at);
    if (!raster) return draw;
    if (isGroup(draw)) {
      const wrap = wrapFor(draw, STAGE_MASK);
      wrap.shell.mask = raster.tex;
      wrap.shell.maskVersion = raster.version;
      return wrap;
    }
    if (draw.mask) {
      const wrap = wrapFor(draw, STAGE_MASK);
      wrap.shell.mask = raster.tex;
      wrap.shell.maskVersion = raster.version;
      return wrap;
    }
    return { ...draw, mask: raster.tex, maskVersion: raster.version };
  };

  /** One synthetic color effect standing in for a color node. */
  const colorEffectFor = (nodeId: string, type: TimelineEffect["type"], params: Record<string, number | string>): TimelineEffect =>
    ({ id: nodeId, type, name: type, enabled: true, intensity: 100, params }) as TimelineEffect;

  /** Color pipeline for a LIST of synthetic effects, via the SAME compiler every renderer grades
   *  with. A list (not a single effect) is the whole point of P1: the engine bakes any number of
   *  pipeline-stage effects into ONE pipeline, so a coalesced chain costs one grade pass. */
  const pipelineForEffects = (effects: TimelineEffect[]): ColorPipeline | null => {
    frameProfiler.bump("compile.effectExpansions");
    return frameProfiler.measure("compile.effectExpansion", () => {
      const layerLike = {
        id: `flarex_${comp.id}`,
        type: "video",
        startSeconds: 0,
        effects: stableColorEffects(effects),
        animations: FLAREX_NO_ANIMATIONS,
      } as unknown as TimelineLayer;
      const pipeline = getCompositionColorPipeline(layerLike, { currentTimeSeconds: ctx.timeSeconds });
      return pipeline && !pipeline.identity ? pipeline : null;
    });
  };

  /**
   * Lower ANY color node (the `FLAREX_COLOR_NODES` table) — one body for the whole family.
   *
   * Masked → a `SceneRegionPass`, the shipped region-grade path, confined to the rasterized matte.
   * Unmasked → the wrap shell's single `pipeline` slot, COALESCING with the color nodes already
   * folded into that wrap (P1). Because the grade engine compiles a whole effect LIST into one
   * pipeline (one 3D LUT, one grade pass), a Wheels → Curves → LUT → Look chain costs what a single
   * node costs, instead of opening a nest — and an RTT — per node. That is the difference between a
   * grade chain being usable and being unusable on an integrated GPU.
   *
   * Coalescing is only sound while ORDER is the only thing that distinguishes the folded list, which
   * holds here: every effect in the table is a pipeline stage applied in list order, and appending
   * preserves that. It is refused when
   *   - the wrap is SEALED (a materialization boundary is a hard barrier, both directions), or
   *   - a later-stage op already landed on the wrap (`__flarexStage` past the pipeline slot), since
   *     the pipeline runs FIRST in shell order and would jump ahead of that op, or
   *   - the same effect type is already folded in — two of one stage collapse, so it opens a fresh
   *     wrap and nests, exactly as it did before coalescing existed.
   */
  const lowerColorNode = (node: FlarexNode, at: number): FlarexValue | null => {
    const input = imageInput(node, "in", at);
    if (!input) {
      degrade(at, node.id, "input-missing");
      return null;
    }
    const read: FlarexParamReader = {
      num: (key, fallback) => num(at, node, key, fallback),
      str: (key, fallback) => str(node, key, fallback),
      bool: (key) => bool(node, key),
    };
    // One node contributes a LIST of pipeline stages: exactly one for an atomic color node, up to
    // seven for the unified `color` node. Everything below is written against the list, so both
    // families share one lowering — there is no second color path to keep in sync.
    let effects: TimelineEffect[];
    if (node.type === "color") {
      effects = buildUnifiedColorEffects(node.id, read, colorEffectFor);
    } else {
      const spec = FLAREX_COLOR_NODES[node.type];
      if (!spec) return { kind: "image", draw: input };
      const params = spec.build(read);
      if (!params) return { kind: "image", draw: input }; // unconfigured payload → pass through
      effects = [colorEffectFor(node.id, spec.effect, params)];
    }

    // A Color node whose every stage is still neutral must be a true no-op, not an identity grade
    // pass: it is the state a freshly-added node is in, and dropping an RTT on the graph for it would
    // make "add a node, then decide what to do with it" cost a render target.
    const film = node.type === "color" ? buildUnifiedColorPasses(node, read) : [];
    if (effects.length === 0 && film.length === 0) return { kind: "image", draw: input };

    const mask = matteInput(node, "mask", at);
    if (mask) {
      const raster = rasterizeMatte(mask, `flarex_${comp.id}_${node.id}_mask`, at);
      if (raster) {
        const pipeline = effects.length ? pipelineForEffects(effects) : null;
        let draw = input;
        if (pipeline) {
          draw = pushRegionPass(input, { effectKey: `flarex_${comp.id}_${node.id}`, mask: raster.tex, maskVersion: raster.version, pipeline });
        }
        // Film passes are fragment passes, so they take the pass model's OWN mask — same region, one
        // pass, no second nest.
        for (const pass of film) {
          pass.mask = raster.tex;
          pass.maskVersion = raster.version;
          draw = pushFragmentPass(draw, pass);
        }
        return { kind: "image", draw };
      }
    }

    let out = input;
    if (effects.length) {
      const upstream = isGroup(input) ? (input as FlarexWrapGroup) : null;
      const folded = upstream?.__flarexColorEffects;
      const coalescable =
        upstream &&
        folded &&
        !upstream.__flarexSealed &&
        upstream.__flarexStage !== undefined &&
        upstream.__flarexStage <= STAGE_PIPELINE &&
        // No stage type may appear twice in one pipeline — two of a kind collapse. A unified node
        // contributes several types at once, so every one of them has to be free.
        !effects.some((next) => folded.some((existing) => existing.type === next.type));
      let placed = false;
      if (coalescable) {
        const merged = [...folded!, ...effects];
        const pipeline = pipelineForEffects(merged);
        if (pipeline) {
          // Keep the wrap's original `groupKey`: it is the grade renderer / LUT cache slot, and it must
          // stay stable across frames as the chain grows.
          upstream!.__flarexColorEffects = merged;
          upstream!.pipeline = pipeline;
          frameProfiler.bump("compile.colorCoalesced");
          out = upstream!;
          placed = true;
        }
      }
      if (!placed) {
        const pipeline = pipelineForEffects(effects);
        if (pipeline) {
          const wrap = wrapFor(input, STAGE_PIPELINE);
          wrap.pipeline = pipeline;
          wrap.groupKey = `flarex_${comp.id}_${node.id}`;
          wrap.__flarexColorEffects = effects;
          out = wrap;
        }
      }
    }
    for (const pass of film) out = pushFragmentPass(out, pass);
    return { kind: "image", draw: out };
  };

  /**
   * Lower ANY filter node (the `FLAREX_FILTER_NODES` table) to a fragment pass on the wrap shell.
   * A wired matte confines the pass to that region — the pass model's own `mask`, so a masked filter
   * still costs one pass rather than opening a region nest.
   */
  const lowerFilterNode = (node: FlarexNode, at: number): FlarexValue | null => {
    const input = imageInput(node, "in", at);
    if (!input) {
      degrade(at, node.id, "input-missing");
      return null;
    }
    const spec = FLAREX_FILTER_NODES[node.type];
    if (!spec) return { kind: "image", draw: input };
    const params = spec.build({
      num: (key, fallback) => num(at, node, key, fallback),
      str: (key, fallback) => str(node, key, fallback),
      bool: (key) => bool(node, key),
    });
    const pass = fragmentPass(node, spec.effect, params);
    if (!pass) return { kind: "image", draw: input };
    const mask = matteInput(node, "mask", at);
    if (mask) {
      const raster = rasterizeMatte(mask, `flarex_${comp.id}_${node.id}_mask`, at);
      if (raster) {
        pass.mask = raster.tex;
        pass.maskVersion = raster.version;
      }
    }
    return { kind: "image", draw: pushFragmentPass(input, pass) };
  };

  const fragmentPass = (
    node: FlarexNode,
    defId: string,
    params: Record<string, number | number[] | boolean>,
    intensity = 1
  ): SceneFragmentPass | null => {
    const def = getFragmentEffect(defId);
    if (!def) return null;
    return {
      effectKey: `flarex_${comp.id}_${node.id}`,
      def,
      params: resolveFragmentEffectParams(def, params),
      intensity,
      timeSeconds: ctx.frameTimeSeconds,
    };
  };

  /**
   * The unified Color node's FILM stages (vignette, grain). These cannot join the pipeline bake: a
   * group's grade is compiled with `mediaEffects: null` (scene-compositor), which is the same
   * constraint that made them fragment builtins rather than pipeline stages in the first place. So
   * they ride as fragment passes on the same shell — still one shell, no extra nest.
   *
   * Emitted only at a non-zero amount, so the film section costs nothing until it is used. Each pass
   * gets its own `effectKey` suffix: they come from one node, and a shared key would let one pass's
   * cached state answer for the other.
   */
  const buildUnifiedColorPasses = (node: FlarexNode, p: FlarexParamReader): SceneFragmentPass[] => {
    const passes: SceneFragmentPass[] = [];
    const vignetteAmount = clamp01(p.num("vignetteAmount", 0));
    if (vignetteAmount > 0) {
      const pass = fragmentPass(node, FLAREX_VIGNETTE_ID, {
        amount: vignetteAmount,
        size: clamp01(p.num("vignetteSize", 0.58)),
        feather: clamp01(p.num("vignetteFeather", 1)),
        roundness: clamp01(p.num("vignetteRoundness", 0)),
        highlights: clamp01(p.num("vignetteHighlights", 0)),
      });
      if (pass) passes.push({ ...pass, effectKey: `${pass.effectKey}_vignette` });
    }
    const grainAmount = clamp01(p.num("grainAmount", 0));
    if (grainAmount > 0) {
      const pass = fragmentPass(node, FLAREX_GRAIN_ID, { amount: grainAmount, size: p.num("grainSize", 1) });
      if (pass) passes.push({ ...pass, effectKey: `${pass.effectKey}_grain` });
    }
    return passes;
  };

  // ── Node evaluation (memoized backwards DFS; cycles degrade to null) ────────────────────────
  const memo = new Map<string, FlarexValue | null>();
  const visiting = new Set<string>();

  /**
   * EVALUATION CONTEXT TIME (ADR-011). The time the node currently being lowered is evaluated AT.
   * Equal to `ctx.timeSeconds` everywhere except inside a subtree under a TimeSpeed, which hands its
   * inputs a transformed time.
   *
   * A mutable cursor rather than a parameter on every helper: `num`/`str`/`lowerNode` and the colour
   * table all read the current time, and threading an argument through each would be a wide change
   * with many chances to miss one — and a MISSED one is silent, evaluating a param at the wrong time
   * with no error. Set immediately around `lowerNode`, restored in `finally`.
   */

  /**
   * Memo identity MUST include the evaluation time (ADR-011 §2): the same node under two different
   * transforms is different content, and sharing one entry between them would serve a frame computed
   * at the wrong `t` — the stale-cache failure ADR-009 §6 calls unforgivable. Rounded to microseconds
   * so float noise cannot manufacture a miss on an untransformed graph, where every key must collapse
   * to the same string or the memo stops working at all.
   */
  const evalKey = (nodeId: string, timeSeconds: number): string => `${nodeId}@${timeSeconds.toFixed(6)}`;
  frameProfiler.bump("compile.maps", 2); // memo + visiting (profiler-only temp-collection count)

  /**
   * Report a degradation (slice S0.2). Observability only — it never changes what lowering returns,
   * and every call site is a plain statement beside an unchanged `return`.
   *
   * Reads `activeTimeSeconds` rather than taking it, so a caller cannot report the frame time for a
   * node that was evaluated under a retime — the distinction between `host-substituted:pending` and
   * `source-pending-retimed` is exactly that difference, and passing it in would let a site get it
   * wrong silently.
   *
   * The `onDegrade` guard is load-bearing: with no channel attached this costs one property read and
   * allocates nothing, which is what keeps an export or worker compile byte-identical in cost as well
   * as in output.
   */
  const degrade = (at: number, nodeId: string, reason: FlarexDegradationReason): void => {
    if (!ctx.onDegrade) return;
    ctx.onDegrade({
      nodeId,
      nodeType: comp.nodes[nodeId]?.type,
      reason,
      substituted: isSubstitutionReason(reason),
      atTimeSeconds: at,
      frameTimeSeconds: ctx.timeSeconds,
    });
  };

  /**
   * Cost estimate for a built subtree, denominated in FULL-FRAME GPU PASSES — the unit materialization
   * is paid for in. Structural only: it counts the passes the compositor will actually run (fragment
   * passes, region passes, and each nested group's own composite), never node types, so it stays
   * node-blind (ADR-010) and needs no per-node declaration to be useful.
   */
  const estimateDrawCost = (d: SceneDraw, depth = 0): number => {
    if (depth > 8 || (d as SceneGroupDraw).kind !== "group") return 0;
    const group = d as SceneGroupDraw;
    let cost = 1; // the group's own composite
    cost += group.shell.fragmentPasses?.length ?? 0;
    cost += group.shell.regionPasses?.length ?? 0;
    for (const child of group.children) cost += estimateDrawCost(child, depth + 1);
    return cost;
  };

  /**
   * Materializing is only a WIN when the work it dedupes exceeds the work it adds. A sealed node costs a
   * render-target allocation plus an extra full-frame blit/composite, so a subtree cheaper than this
   * threshold is faster left folded into the shader chain — even though it is shared.
   *
   * MEASURED (`flarex:perf`, 2026-07-26), which is why this exists: with `fanout > 1` as the only term, a
   * light branch-and-merge comp ran **37.5% slower with the cache on and spent 7.9MB** doing it — the
   * trivial shared leaves (a bare MediaIn feeding several branches) were each sealed into an identity RTT
   * that bought nothing. The dense 100-node comp, where the deduped subtrees are genuinely expensive,
   * gained 42% on p95 for 2.0MB. So the discriminator is subtree COST, exactly as ADR-010 §3 specified.
   *
   * RE-DERIVED and KEPT AT 2 (S6.3, 2026-08-03) — same number, different reason, which is the point.
   *
   * DEBT-006 was right that the 2026-07-26 derivation was void: it was measured against a `materialize()`
   * that WRAPPED a second group, so it priced an extra full-frame composite that tagging-in-place no
   * longer charges. Re-deriving it first needed a scenario the suite did not have — thresholds 1 and 2
   * differ on exactly ONE input, a shared subtree costing exactly 1 pass, and every existing scenario sat
   * above it (`shared-expensive`) or below it (`fanout-8` shares a bare MediaIn, a non-group, cost 0).
   * Measured against those alone the constant was unfalsifiable: 1 and 2 produced byte-identical
   * behaviour on all seven scenarios.
   *
   * With `shared-cheap-1x8` (one colour node — a nest, no fragment or region pass — fanning out to 8
   * consumers at 4K) threshold 1 looks like a clear win, and taken alone it would have been adopted:
   *
   *   shared-cheap-1x8          threshold 2 (folded)  p50 0.70ms  p95 1.70ms      0MB   0 evict
   *                             threshold 1 (sealed)  p50 0.30ms  p95 0.90ms   31.6MB   0 evict
   *
   * It is the OTHER shape that decides it. `shouldMaterialize` gates on `fanout > 1`, which counts graph
   * EDGES, not distinct evaluation contexts. Put a retime on each branch and the shared node is evaluated
   * once per branch at its own time — correctly, per ADR-011 §2, since collapsing them would be the stale
   * hit ADR-009 calls unforgivable — so it is sealed once PER BRANCH and dedupes NOTHING:
   *
   *   shared-cheap-retimed-1x8  threshold 2 (folded)  p50 1.20ms  p95  2.70ms      0MB     0 evict
   *                             threshold 1 (sealed)  p50 1.30ms  p95 12.30ms   253.1MB   389 evict
   *
   * So threshold 1 buys ~0.5ms of p50 on genuine sharing and pays 9.6ms of p95 TAIL, 253MB and 389
   * evictions in 60 frames where fanout lies. Playback drops frames on the tail, not the median. 2 holds.
   *
   * The cost-1 class is exactly where a retime makes fanout lie, so the threshold is doing a second job
   * the original derivation never named: it is the backstop for context-blind fanout counting. Lower it
   * only together with a fanout that counts evaluation CONTEXTS (tracked as DEBT-007, candidate S6.5).
   *
   * NOT COVERED: this desktop GPU, not the Iris Xe low-end target.
   */
  const MATERIALIZE_MIN_PASSES = 2;

  /**
   * Evaluator-owned materialization decision (ADR-008 rule 3 / ADR-010 §3): the node contributes an
   * intrinsic constraint + a cost hint; the EVALUATOR decides — no node-type branch.
   *   materialize = requiresMaterialization ∨ (fanout>1 ∧ budget(estimate)) ∨ debugOverride
   * Live terms: `fanout>1` (structural), `budget(estimate)` (the structural cost estimate above), and
   * the debug override. `requiresMaterialization` (intrinsic — distortion/iterative/feedback nodes that
   * CANNOT fold) still has no declared input and lands with node capabilities; until then such a node
   * must be forced via `ctx.materializeNodeIds`.
   *
   * Note the cost term gates only the FANOUT case. The debug/explicit override deliberately bypasses it,
   * because node previews (Slice 4) need to materialize a node regardless of how cheap it is.
   */
  const shouldMaterialize = (nodeId: string, draw: FlarexImageValue): boolean => {
    if (ctx.materializeNodeIds?.has(nodeId)) return true;
    if ((fanout.get(nodeId) ?? 0) <= 1) return false;
    return estimateDrawCost(draw) >= MATERIALIZE_MIN_PASSES;
  };

  const inputValue = (node: FlarexNode, socket: string, timeSeconds: number): FlarexValue | null => {
    const from = edgeInto.get(`${node.id}:${socket}`);
    if (!from) return null;
    const value = evalNode(from, timeSeconds);
    if (!value) return null;
    // Per-consumer clone: wraps applied downstream must never mutate the shared memoized subtree.
    return value.kind === "image" ? { kind: "image", draw: cloneImage(value.draw) } : { kind: "matte", matte: { masks: value.matte.masks } };
  };

  const imageInput = (node: FlarexNode, socket: string, at: number): FlarexImageValue | null => {
    const v = inputValue(node, socket, at);
    return v?.kind === "image" ? v.draw : null;
  };

  const matteInput = (node: FlarexNode, socket: string, at: number): FlarexMatteValue | null => {
    const v = inputValue(node, socket, at);
    return v?.kind === "matte" ? v.matte : null;
  };

  /** Pass-through target for a disabled node: its first wired image input. */
  const passthrough = (node: FlarexNode, at: number): FlarexValue | null => {
    for (const input of getFlarexNodeDefinition(node.type).inputs) {
      if (input.type !== "image") continue;
      const v = inputValue(node, input.id, at);
      if (v) return v;
    }
    return null;
  };

  function evalNode(nodeId: string, timeSeconds = ctx.timeSeconds): FlarexValue | null {
    const key = evalKey(nodeId, timeSeconds);
    // Profiler-only: track recursion depth (peak/avg) so the retained-cache "no recursive descent" win is
    // measurable. No-op unless profiling is recording.
    frameProfiler.enterEval();
    try {
      if (memo.has(key)) {
        // Served from the per-frame memo (shared fan-out) — not re-lowered. Attribute it as skipped.
        const cachedNode = nodes[nodeId];
        if (cachedNode) frameProfiler.noteEval(nodeId, cachedNode.type, "skipped");
        return memo.get(key) ?? null;
      }
      if (visiting.has(key)) {
        degrade(timeSeconds, nodeId, "graph-cycle");
        return null; // cycle — degrade, never hang
      }
      const node = nodes[nodeId];
      if (!node) {
        degrade(timeSeconds, nodeId, "node-missing");
        return null;
      }
      frameProfiler.noteEval(nodeId, node.type, "evaluated");
      visiting.add(key);
      // The retimed time is PASSED DOWN rather than parked in a cursor, so a sibling branch cannot be
      // affected by a transform applied on this one — not because we remembered to restore it, but
      // because it was never shared. The save/restore pair (and every way to forget one) is gone.
      let value: FlarexValue | null = node.enabled ? lowerNode(node, timeSeconds) : passthrough(node, timeSeconds);
      visiting.delete(key);
      // Materialization boundary: seal an image-producing node's output into its own RTT when the
      // evaluator-owned decision says so (fan-out / debug override today). Mattes stay vector (never
      // rasterized here). Pixel-neutral by construction — sealing inserts only identity nests.
      if (value?.kind === "image" && shouldMaterialize(nodeId, value.draw)) {
        value = { kind: "image", draw: materialize(value.draw, nodeId, timeSeconds) };
      }
      memo.set(key, value);
      /**
       * NODE EVALUATION RECORD (ADR-012 §5.4, slice S6.4).
       *
       * Written, never read back — the store is the precondition for dirty propagation (S6.5) and
       * incremental planning (S6.6), and reuse belongs to those slices. Handing back a persisted draw
       * today would return textures whose pool entries may since have been disposed; the moment to do
       * that safely is once S6.5 can say what is still valid.
       *
       * The context key is `evalKey`'s, which already folds the evaluation TIME — so the two sides of
       * a retime keep separate records instead of collapsing into one, the same distinction S6.2 had
       * to make in the artifact cache one layer up.
       *
       * Gated: with records off this is one property read and no allocation (R1), and the evaluator
       * behaves exactly as before.
       */
      ctx.onEvaluated?.(nodeId, key, value);
      return value;
    } finally {
      frameProfiler.exitEval();
    }
  }

  function lowerNode(node: FlarexNode, at: number): FlarexValue | null {
    // Profiler-only, node-blind: count a lowering visit per node type (the report aggregates merge /
    // transform / effect visits from these). No `switch` on type for profiling — just the label.
    frameProfiler.bump(`visit.${node.type}`);
    switch (node.type) {
      case "mediaIn": {
        // Asset-source MediaIn (FLAREX.md Phase 2, Fusion Loader model): a non-empty `sourceAssetId`
        // loads a media-pool asset (decoded off-timeline by the caller); empty id / unresolved source
        // / no resolver falls back to the host clip (soft-degrade, never blank).
        //
        // A HOST MediaIn (empty id) also asks the resolver first, because a TimeSpeed above it makes
        // the host's own playhead-locked draw the wrong picture: `virtual-layers.ts` promotes it to an
        // independently decoded loader at the retimed rate (ADR-011). No promotion — every comp
        // without a TimeSpeed — resolves to null and falls through to the host exactly as before.
        const sourceAssetId = str(node, "sourceAssetId", "");
        // Is reaching the host draw a SUBSTITUTION (this node has its own loader and the pixels have
        // not arrived) or this node's own source reached by the declining-promotion path? Only the
        // first is what I-27 forbids, and only the first is what S4.5 deletes. Default false: a node
        // with no resolver at all cannot be substituting anything.
        let substituting = false;
        if (ctx.resolveSourceDraw) {
          // Profiler-only: `resolveSourceDraw` is the browser's asset-source ADAPTER — it builds a full
          // per-clip draw (grade pipeline, transforms, masks) via buildLayerPreFlarexDraw. This is real
          // work counted inside `compile.lower` but ABSENT from the Node micro-bench's stub, so it's the
          // prime suspect for the browser-vs-Node gap. Isolate it.
          frameProfiler.bump("compile.resolveSourceCalls");
          const resolved = frameProfiler.measure("compile.resolveSource", () => ctx.resolveSourceDraw!(node.id, sourceAssetId));
          // Source ran past its own end (short clip in a longer comp): produce nothing — the node's
          // output is empty, so a merge downstream keeps only the background. NOT a host fall-back.
          if (resolved === "ended") {
            degrade(at, node.id, "source-ended");
            return null;
          }
          /**
           * `"pending"` — THIS NODE HAS A LOADER AND IT HAS NO PICTURE YET (2026-07-29).
           *
           * Distinct from null, and the distinction is the bug it fixes. `ctx.hostSourceDraw` is the
           * host clip at `ctx.timeSeconds`, the PLAYHEAD. A retimed MediaIn is evaluated at another
           * moment of the same shot, so substituting the host draw there does not degrade the
           * picture — it shows a different one. Reported as "at same playhead, different host":
           * whenever the loader's graded canvas had not landed (`buildLayerDraw` returns null on
           * exactly that, one of its two null sites), the MediaIn flashed the un-retimed playhead
           * frame, so the clip alternated between two moments. That reads as judder no decoder work
           * could ever reach, because the decoder was never what was wrong.
           *
           * Producing NOTHING is the honest answer, and the one `"ended"` and an unbacked generator
           * already give: a merge downstream keeps its background. A transparent beat while a loader
           * warms is a gap; a frame from elsewhere in the shot is a lie.
           *
           * SCOPED TO A TRANSFORMED CONTEXT, and the pixel gate is why. Dropping the fall-back for
           * every unready loader took `flarex-generators` from 0.000% to 86.895%: the two renderers
           * do not become ready on the same frame, and the host fall-back was holding them together.
           * Without a retime the host draw is the SAME MOMENT, so it is a genuine soft-degrade and
           * removing it just exposes a readiness race as a parity failure. WITH a retime it is a
           * different moment, and no amount of agreement makes a wrong frame right.
           *
           * `activeTimeSeconds !== ctx.timeSeconds` is exactly the question "is `hostSourceDraw` from
           * the context I am evaluating in?" — no new plumbing, and true only under a transform.
           *
           * null still means "no loader owns this node" and still soft-degrades to the host — the
           * Phase-1 contract, and the right answer when promotion legitimately declined.
           */
          if (resolved === "pending" && at !== ctx.timeSeconds) {
            degrade(at, node.id, "source-pending-retimed");
            return null;
          }
          // An un-retimed `"pending"` falls THROUGH to the host below — same moment, real degrade.
          if (resolved && resolved !== "pending") return { kind: "image", draw: cloneImage(resolved) };
          // Reached the host fall-back. The two causes are reported apart because they have different
          // fixes — `pending` is a readiness race (S4.4's barrier), `no-loader` is a source that was
          // never admitted (S4.3's admission) — and, as S4.5 discovered, because only ONE of them is
          // a substitution at all. See the S4.5 note below.
          degrade(at, node.id, resolved === "pending" ? "host-substituted:pending" : "host-substituted:no-loader");
          substituting = resolved === "pending";
        } else {
          degrade(at, node.id, "host-substituted:no-resolver");
        }
        // S4.5 — DECLARED ABSENCE. The degradation above is still reported either way; what changes is
        // whether the frame then shows another source's pixels. `null` here means the node produces
        // nothing and a downstream merge keeps its background: a transparent beat while a loader warms
        // is a gap, a frame from elsewhere in the shot is a lie (I-27/I-34).
        //
        // This is the single most damaging construct in the runtime precisely because it is invisible:
        // the picture is always plausible, so the readiness race underneath it has never had to be
        // fixed. S4.4's barrier is what makes deleting it survivable — the frame resolves to a moment
        // every participant CAN show instead of the moment one of them cannot.
        //
        // SCOPED TO `pending`, and the pixel gate is why — measured, not reasoned. The first version of
        // this slice returned null for all three causes and failed ELEVEN flarex fixtures at up to
        // 76.9%, on frames the present ledger reported fully settled (`notReady: 0`). The degradation
        // channel named the cause on every one of them: `host-substituted:no-loader`, and not a single
        // `:pending`. So the slice deleted the exact case it was not aimed at.
        //
        // The distinction the first version missed is that these three reasons are not three flavours
        // of one thing. I-27 forbids resolving scarcity by showing ANOTHER source's content, and only
        // `pending` does that: the node HAS a loader, that loader owns the pixels, and they have not
        // arrived — so the host draw is a stand-in for something else. `no-loader` and `no-resolver`
        // are the opposite statement. No loader was ever promoted for this node, which means the host
        // clip IS its source; drawing it is not substitution, it is the Phase-1 contract three comment
        // lines above ("still soft-degrades to the host — the right answer when promotion legitimately
        // declined"). Deleting that leaves a node whose source is present and readable drawing nothing.
        //
        // Put plainly: the invariant is about WHOSE pixels these are, not about which code path reached
        // them. Same line, opposite meanings.
        if (ctx.allowHostSubstitution === false && substituting) return null;
        return { kind: "image", draw: cloneImage(ctx.hostSourceDraw) };
      }

      // Generators (Text+ / Background) — backed by a virtual TEXT/SHAPE layer that the renderers
      // rasterize, pulled through the SAME `resolveSourceDraw` seam as an asset-source MediaIn (see
      // `virtual-layers.ts`). No resolver / no backing layer ⇒ the node produces NOTHING (transparent),
      // so a downstream merge simply keeps its background rather than showing a stand-in.
      //
      // The virtual layer is built NEUTRAL (centred, opaque) and placement is applied HERE, because
      // this is the only place with a time to sample: `num()` is keyframe-aware, so Text x/y and
      // Background opacity animate. Writing straight onto the resolved layer draw's own transform
      // costs no extra nest — the generator is always a bare `SceneLayerDraw`.
      case "text":
      case "background": {
        if (!ctx.resolveSourceDraw) {
          degrade(at, node.id, "generator-unbacked");
          return null;
        }
        frameProfiler.bump("compile.resolveSourceCalls");
        const resolved = frameProfiler.measure("compile.resolveSource", () => ctx.resolveSourceDraw!(node.id, ""));
        // A generator already produces NOTHING when its backing layer is absent or spent, so
        // `"pending"` (raster not landed) joins the same branch — it was always the honest answer here.
        if (!resolved || resolved === "ended" || resolved === "pending") {
          // One reason, unlike MediaIn: a generator NEVER substitutes, so the three causes share a fix
          // (rasterize the backing layer) and splitting them would add noise without adding a decision.
          degrade(at, node.id, "generator-unbacked");
          return null;
        }
        const draw = cloneImage(resolved);
        if (!isGroup(draw)) {
          const opacity = node.type === "background" ? clamp01(num(at, node, "opacity", 1)) * 100 : draw.transform.opacity;
          draw.transform = {
            ...draw.transform,
            // Node x/y are comp FRACTIONS; the composite transform takes percent-of-comp.
            ...(node.type === "text" ? { x: clamp01(num(at, node, "x", 0.5)) * 100, y: clamp01(num(at, node, "y", 0.5)) * 100 } : {}),
            opacity,
          };
        }
        return { kind: "image", draw };
      }

      case "mediaOut":
        return inputValue(node, "in", at);

      // Reroute (F2, round 3): pure pass-through — a wire-organization dot, never alters output.
      case "reroute":
        return inputValue(node, "in", at);

      case "merge": {
        const bg = imageInput(node, "bg", at);
        let fg = imageInput(node, "fg", at);
        if (!bg || !fg) return bg ? { kind: "image", draw: bg } : fg ? { kind: "image", draw: fg } : null;
        const mask = matteInput(node, "mask", at);
        if (mask) fg = applyMatteToImage(fg, mask, `flarex_${comp.id}_${node.id}_mask`, at);
        const blend = str(node, "blend", "normal") as SceneLayerDraw["blendMode"];
        const opacity = Math.max(0, Math.min(1, num(at, node, "opacity", 1)));
        if (isGroup(fg)) {
          fg.shell.blendMode = blend;
          fg.shell.transform.opacity *= opacity;
        } else {
          fg.blendMode = blend;
          fg.transform.opacity *= opacity;
        }
        frameProfiler.bump("compile.operations"); // the merge combine op (fg over bg)
        frameProfiler.bump("compile.drawCommands");
        frameProfiler.bump("compile.objects", 3); // group + shell + transform (identityShell)
        frameProfiler.bump("compile.arrays"); // children [bg, fg]
        const merged: FlarexWrapGroup = {
          kind: "group",
          debugGroupId: `flarex_${comp.id}_${node.id}`,
          children: [bg, fg],
          nestWidth: nestW,
          nestHeight: nestH,
          shell: identityShell(),
          // The blend set on `fg` above IS this node's operation, so it must survive into the group's
          // RTT. Without this the compositor applies the precompose rule (everything NORMAL inside a
          // nest) and every merge mode silently degrades to `normal` — `screen` over a black smoke
          // plate drew an opaque black rectangle. Correct for a compound clip, wrong for a merge.
          preserveChildBlend: true,
          __flarexStage: 0,
        };
        return { kind: "image", draw: merged };
      }

      case "transform": {
        const input = imageInput(node, "in", at);
        if (!input) {
          degrade(at, node.id, "input-missing");
          return null;
        }
        const wrap = wrapFor(input, STAGE_TRANSFORM);
        frameProfiler.bump("compile.operations"); // transform op on the shell
        frameProfiler.bump("compile.objects"); // new transform object
        // x/y are PERCENT offsets from center (timeline-transform units: anchor comp position 0..100).
        wrap.shell.transform = {
          x: 50 + num(at, node, "x", 0),
          y: 50 + num(at, node, "y", 0),
          scale: Math.max(0, num(at, node, "scale", 1)),
          rotation: num(at, node, "rotation", 0),
          opacity: wrap.shell.transform.opacity,
          anchorX: num(at, node, "anchorX", 0.5) * 100,
          anchorY: num(at, node, "anchorY", 0.5) * 100,
        };
        return { kind: "image", draw: wrap };
      }

      // Every color node lowers through ONE body (see `lowerColorNode` / `FLAREX_COLOR_NODES`), so
      // adding a color node is a table row, not a case.
      // `color` is the unified grade node (all stages in one); the rest are the atomic ones. Same body.
      case "color":
      case "colorCorrect":
      case "colorCurves":
      case "hueSat":
      case "colorWheels":
      case "hslQualifier":
      case "lut":
      case "look":
        return lowerColorNode(node, at);

      // Likewise every builtin-wrapping filter node (see `FLAREX_FILTER_NODES`).
      case "directionalBlur":
      case "radialBlur":
      case "pixelate":
      case "prism":
      case "crop":
      case "channelBoolean":
      case "vignette":
      case "grain":
        return lowerFilterNode(node, at);

      case "blur": {
        const input = imageInput(node, "in", at);
        if (!input) {
          degrade(at, node.id, "input-missing");
          return null;
        }
        const sigma = Math.max(0, num(at, node, "sigma", 8));
        if (sigma <= 0) return { kind: "image", draw: input };
        const mask = matteInput(node, "mask", at);
        if (mask) {
          const raster = rasterizeMatte(mask, `flarex_${comp.id}_${node.id}_mask`, at);
          if (raster) {
            return {
              kind: "image",
              draw: pushRegionPass(input, {
                effectKey: `flarex_${comp.id}_${node.id}`,
                mask: raster.tex,
                maskVersion: raster.version,
                blurPx: sigma * ctx.renderScale,
              }),
            };
          }
        }
        const wrap = wrapFor(input, STAGE_BLUR);
        wrap.shell.blurPx = sigma * ctx.renderScale;
        return { kind: "image", draw: wrap };
      }

      case "glow": {
        const input = imageInput(node, "in", at);
        if (!input) {
          degrade(at, node.id, "input-missing");
          return null;
        }
        const radius = Math.max(0, num(at, node, "radius", 24));
        if (radius <= 0) return { kind: "image", draw: input };
        const wrap = wrapFor(input, STAGE_GLOW);
        wrap.shell.glow = {
          radiusPx: radius * ctx.renderScale,
          color: [1, 1, 1],
          mode: "highlights",
          threshold: Math.max(0, Math.min(1, num(at, node, "threshold", 0.7))),
          strength: Math.max(0, num(at, node, "intensity", 0.6)),
        };
        return { kind: "image", draw: wrap };
      }

      case "sharpen": {
        const input = imageInput(node, "in", at);
        if (!input) {
          degrade(at, node.id, "input-missing");
          return null;
        }
        // Node amount 0..2 → builtin sharpen's 0..100 scale.
        const pass = fragmentPass(node, builtinFragmentEffectId("sharpen"), { amount: Math.max(0, Math.min(100, num(at, node, "amount", 0.5) * 50)) });
        return { kind: "image", draw: pass ? pushFragmentPass(input, pass) : input };
      }

      case "filter": {
        const input = imageInput(node, "in", at);
        if (!input) {
          degrade(at, node.id, "input-missing");
          return null;
        }
        const effectId = str(node, "effectId", "");
        if (!effectId) return { kind: "image", draw: input };
        const defId = effectId.includes(".") ? effectId : builtinFragmentEffectId(effectId);
        let overrides: Record<string, number | number[] | boolean> = {};
        const raw = str(node, "effectParams", "");
        if (raw) {
          try {
            overrides = JSON.parse(raw) as Record<string, number | number[] | boolean>;
          } catch {
            overrides = {};
          }
        }
        const pass = fragmentPass(node, defId, overrides, Math.max(0, Math.min(1, num(at, node, "intensity", 1))));
        return { kind: "image", draw: pass ? pushFragmentPass(input, pass) : input };
      }

      case "chromaKey": {
        const input = imageInput(node, "in", at);
        if (!input) {
          degrade(at, node.id, "input-missing");
          return null;
        }
        const pass = fragmentPass(node, FLAREX_CHROMA_KEY_ID, {
          keyColor: parseHexColor(str(node, "color", "#00b140")),
          tolerance: num(at, node, "tolerance", 0.35),
          softness: num(at, node, "softness", 0.1),
          clipBlack: num(at, node, "clipBlack", 0),
          clipWhite: num(at, node, "clipWhite", 1),
          spillSuppression: num(at, node, "spillSuppression", 0.5),
          edgeSoftness: num(at, node, "edgeSoftness", 2),
          choke: num(at, node, "choke", 0.05),
          decontaminate: num(at, node, "decontaminate", 0.5),
          matteOnly: bool(node, "matteOnly"),
        });
        return { kind: "image", draw: pass ? pushFragmentPass(input, pass) : input };
      }

      case "lumaKey": {
        const input = imageInput(node, "in", at);
        if (!input) {
          degrade(at, node.id, "input-missing");
          return null;
        }
        const pass = fragmentPass(node, FLAREX_LUMA_KEY_ID, {
          low: num(at, node, "low", 0),
          high: num(at, node, "high", 1),
          softness: num(at, node, "softness", 0.1),
          invertKey: bool(node, "invert"),
          matteOnly: bool(node, "matteOnly"),
        });
        return { kind: "image", draw: pass ? pushFragmentPass(input, pass) : input };
      }

      case "rectMask":
      case "ellipseMask": {
        const w = ctx.compWidth;
        const h = ctx.compHeight;
        const cx = num(at, node, "centerX", 0.5) * w;
        const cy = num(at, node, "centerY", 0.5) * h;
        const halfW = (Math.max(0, num(at, node, "width", 0.5)) * w) / 2;
        const halfH = (Math.max(0, num(at, node, "height", 0.5)) * h) / 2;
        const mask = createBoxMask(node.type === "rectMask" ? "rectangle" : "ellipse", cx - halfW, cy - halfH, cx + halfW, cy + halfH, 1);
        mask.id = `flarex_${comp.id}_${node.id}`;
        // Node feather is a comp fraction (resolution-independent); Mask.feather is px.
        mask.feather = Math.max(0, Math.min(1, num(at, node, "feather", 0))) * Math.min(w, h) * 0.5;
        mask.inverted = bool(node, "invert");
        if (node.type === "rectMask") mask.cornerRadius = Math.max(0, Math.min(1, num(at, node, "cornerRadius", 0))) * Math.min(halfW, halfH);
        return { kind: "matte", matte: { masks: [mask] } };
      }

      case "matteControl": {
        const a = matteInput(node, "a", at);
        const b = matteInput(node, "b", at);
        if (!a && !b) {
          degrade(at, node.id, "input-missing");
          return null;
        }
        const operation = str(node, "operation", "add") as Mask["mode"];
        const feather = Math.max(0, Math.min(1, num(at, node, "feather", 0))) * Math.min(ctx.compWidth, ctx.compHeight) * 0.5;
        const masks: Mask[] = [
          ...(a?.masks ?? []),
          ...(b?.masks ?? []).map((mask) => ({ ...mask, mode: operation })),
        ].map((mask) => (feather > 0 ? { ...mask, feather: mask.feather + feather } : mask));
        if (bool(node, "invert")) {
          // Exact for add-combined mattes: full-frame ∖ union. (FLAREX.md documents the approximation
          // for mixed-mode chains; the rasterizer composites in list order.)
          const full = createMask("rectangle", [
            { id: "fx_i0", x: 0, y: 0 },
            { id: "fx_i1", x: ctx.compWidth, y: 0 },
            { id: "fx_i2", x: ctx.compWidth, y: ctx.compHeight },
            { id: "fx_i3", x: 0, y: ctx.compHeight },
          ], "invert-base");
          full.id = `flarex_${comp.id}_${node.id}_invert`;
          return { kind: "matte", matte: { masks: [full, ...masks.map((mask) => ({ ...mask, mode: "subtract" as const }))] } };
        }
        return { kind: "matte", matte: { masks } };
      }

      case "polygonMask":
      case "bezierMask": {
        const w = ctx.compWidth;
        const h = ctx.compHeight;
        const points = parseFractionPoints(str(node, "points", ""), node.type);
        const mask = createMask(
          node.type === "polygonMask" ? "polygon" : "bezier",
          points.map(([px, py], index) => ({ id: `flarex_${comp.id}_${node.id}_p${index}`, x: px * w, y: py * h })),
          node.type === "polygonMask" ? "Polygon" : "Bezier",
        );
        mask.id = `flarex_${comp.id}_${node.id}`;
        mask.feather = Math.max(0, Math.min(1, num(at, node, "feather", 0))) * Math.min(w, h) * 0.5;
        mask.inverted = bool(node, "invert");
        return { kind: "matte", matte: { masks: [mask] } };
      }

      // Phase 1.5+ nodes (FLAREX.md): declared in node-defs for the palette/AI surface, but not
      // yet lowered — they pass through so a saved graph containing them still renders.
      /**
       * TIMESPEED (ADR-011) — the first, and so far only, node that transforms the evaluation context
       * handed to its inputs.
       *
       * `t_input = t_output * speed + offset`. Its OWN params are read at its own time, not the
       * transformed one — reading them at the transformed time would be self-referential (the time
       * depends on the speed, which would depend on the time).
       *
       * Everything upstream retimes, not just video: animated params, generators, nested graphs. That
       * generality is the whole reason this needed a new evaluator question instead of a compile-time
       * rewrite of source sampling (see ADR-011 "Alternatives considered").
       *
       * VIDEO is the exception to "everything the compiler evaluates", because the compiler does not
       * evaluate it — a MediaIn's picture arrives already decoded through `resolveSourceDraw`, at the
       * playhead. That half is resolved statically by `time-transform.ts` and applied to the node's
       * virtual loader as a rate, which is why `speed`/`offset` are constants (see node-defs).
       */
      case "timeSpeed": {
        const speed = num(at, node, "speed", 1);
        const offset = num(at, node, "offset", 0);
        const inner = inputValue(node, "in", at * speed + offset);
        return inner?.kind === "image" ? { kind: "image", draw: inner.draw } : inner;
      }

      case "aiMatte":
        degrade(at, node.id, "node-unimplemented");
        return null;

      /**
       * TRACKER v1 (2026-07-28) — match-move: follow an EXISTING track, do not compute one.
       *
       * ADR-010 compliance is by declaration only; the evaluator learns nothing. The node reads
       * `params` and `time`, resolves a `source` (the tracking artifact) through the caller-supplied
       * adapter, and lowers to the same shell transform the Transform node uses. No new evaluator
       * question, no new ArtifactKind — `TrackingData` was already in the registry and ADR-010 already
       * named `tracker` among the types the evaluator must not know about.
       *
       * Parity is structural: this is the only production compile site (`build-scene-draws.ts`), which
       * both the web preview and Remotion go through, so a tracked move cannot differ between them.
       *
       * Soft-degrade to pass-through when the artifact is missing or the adapter is absent — the same
       * contract MediaIn uses for an unready source. A comp containing a Tracker whose track was
       * deleted must still render, un-tracked, rather than blank.
       */
      case "tracker": {
        const input = imageInput(node, "in", at);
        if (!input) {
          degrade(at, node.id, "input-missing");
          return null;
        }
        // EMBEDDED data first — it is what travels in the manifest and therefore what both renderers
        // agree on. The id-based adapter is a convenience for callers that have a store; if it ever
        // became the primary path it would have to reach Remotion too, or the preview would track and
        // the export would not.
        const path = parseTrackingPathParam(str(node, "trackingPathData", ""))
          ?? (ctx.resolveTrackingPath?.(str(node, "trackingPathId", "")) ?? null);
        if (!path || path.points.length === 0) return passthrough(node, at);
        // T4: the track is sampled at the EVALUATION time. Reading `ctx.timeSeconds` here meant a
        // retimed subtree followed the playhead's track position while its pixels came from another
        // moment — the second of the three un-retimed reads, and the same failure shape as the matte.
        const sample = sampleTrackingPathAt(path, at, num(at, node, "smoothing", 0) || undefined);
        const wrap = wrapFor(input, STAGE_TRANSFORM);
        frameProfiler.bump("compile.operations");
        frameProfiler.bump("compile.objects");
        const base = wrap.shell.transform;
        // COMPOSES with whatever transform the shell already carries rather than replacing it: a
        // Tracker downstream of a Transform must follow the track ON TOP of the user's framing. The
        // Transform node overwrites here because it IS the framing; this one is a delta.
        wrap.shell.transform = {
          ...base,
          x: base.x + sample.dx,
          y: base.y + sample.dy,
          scale: Math.max(0, base.scale * sample.scale),
          rotation: base.rotation + sample.rotateZ,
        };
        return { kind: "image", draw: wrap };
      }

      default:
        return passthrough(node, at);
    }
  }

  // View-any-node (Fusion view dot): root at the previewed node when the RUNTIME asks for it; a
  // preview that yields no image (matte-only node, unwired) falls back to MediaOut so the frame never
  // goes blank.
  //
  // THE PERSISTED `comp.previewNodeId` IS DELIBERATELY NOT READ HERE (ADR-012 §0.5, slice S1.2).
  // ADR-007 originally re-rooted preview AND export from it "by design"; that is reversed by product
  // decision. The view dot is an editing affordance for inspecting an intermediate node — it must
  // never change delivered pixels, which is I-26. Export always begins at the graph's output.
  //
  // Preview routing is RUNTIME state, supplied per frame by whoever is viewing; render routing is a
  // property of the graph. Because this read is in shared code, dropping the fallback corrects the web
  // preview, the local export and the Remotion worker in one move. `previewNodeId` stays persisted and
  // the healer still validates it — editor state that survives a reload is still editor state.
  const previewRootId = ctx.previewRootNodeId;
  const previewNode = previewRootId ? nodes[previewRootId] : undefined;
  if (previewNode && previewNode.type !== "mediaOut") {
    const previewed = evalNode(previewNode.id);
    if (previewed?.kind === "image") return previewed.draw;
  }
  // Profiler-only: time the whole recursive lowering (traversal + emission) as the "lower" phase —
  // compile total ≈ setup + hashing + lower. No-op unless profiling.
  const result = frameProfiler.measure("compile.lower", () => evalNode(mediaOut.id));
  if (result?.kind === "image") return result.draw;
  // An UNWIRED MediaOut is an intentional "no output" (the Fusion contract: nothing reaches the
  // viewer) — render transparent, don't leak the source. Every OTHER failure (cycle, dangling
  // upstream, matte-only chain) still returns null → the caller's soft-degrade to the plain clip
  // draw, so a broken graph never blacks out an export.
  if (!edgeInto.has(`${mediaOut.id}:in`)) {
    const empty = cloneImage(ctx.hostSourceDraw);
    if (!isGroup(empty)) empty.transform.opacity = 0;
    else empty.shell.transform.opacity = 0;
    return empty;
  }
  return null;
}
