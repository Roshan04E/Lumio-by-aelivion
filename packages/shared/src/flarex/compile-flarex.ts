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
  FLAREX_CHROMA_KEY_ID,
  FLAREX_LUMA_KEY_ID,
  builtinFragmentEffectId,
  registerBuiltinFragmentEffects,
} from "../color/fragment-effects/builtins";

// The keyer/filter nodes resolve defs from the fragment registry; guarantee the builtins are
// registered no matter which module loaded first (idempotent — same call effects.ts makes).
registerBuiltinFragmentEffects();
import { getCompositionColorPipeline } from "../composition-style";
import type { SceneMaskMatteCache } from "../scene/scene-mask-matte";
import type { SceneFragmentPass, SceneGroupDraw, SceneLayerDraw, SceneRegionPass } from "../color/scene-compositor";
import type { Mask, TimelineEffect, TimelineLayer } from "../types";
import { getFlarexNodeDefinition } from "./node-defs";
import type { FlarexComp, FlarexNode } from "./types";

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
  /** The caller's comp-sized matte cache; null = shape-mask nodes soft-degrade to no matte. */
  matteCache?: SceneMaskMatteCache | null | undefined;
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

/** Compiler-created wrap groups carry their collapse stage; the marker survives shallow clones
 *  (per-consumer copies) and is invisible to the compositor. */
interface FlarexWrapGroup extends SceneGroupDraw {
  __flarexStage?: number;
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

export function compileFlarexComp(comp: FlarexComp, ctx: FlarexLowerCtx): FlarexImageValue | null {
  const nodes = comp.nodes;
  const mediaOut = Object.values(nodes).find((node) => node.type === "mediaOut");
  if (!mediaOut) return null;

  // to-socket → edge (a socket accepts at most one wire; the healer enforces endpoint validity).
  const edgeInto = new Map<string, string>();
  for (const edge of comp.edges) {
    edgeInto.set(`${edge.to.nodeId}:${edge.to.socket}`, edge.from.nodeId);
  }

  /** Keyframe-aware numeric param (comp-local time). */
  const num = (node: FlarexNode, key: string, fallback: number): number => {
    const base = typeof node.params[key] === "number" ? (node.params[key] as number) : fallback;
    return evaluateFlarexNodeParam({ animations: comp.animations, baseValue: base, nodeId: node.id, paramKey: key, timeSeconds: ctx.timeSeconds });
  };
  const str = (node: FlarexNode, key: string, fallback: string): string =>
    typeof node.params[key] === "string" ? (node.params[key] as string) : fallback;
  const bool = (node: FlarexNode, key: string): boolean => node.params[key] === true;

  const nestW = Math.max(1, Math.round(ctx.compWidth * ctx.renderScale));
  const nestH = Math.max(1, Math.round(ctx.compHeight * ctx.renderScale));

  /** Per-consumer shallow copy so shared subtrees are never mutated through one consumer's wraps. */
  const cloneImage = (draw: FlarexImageValue): FlarexImageValue =>
    isGroup(draw)
      ? ({ ...draw, shell: { ...draw.shell, transform: { ...draw.shell.transform } } } as FlarexWrapGroup)
      : { ...draw, transform: { ...draw.transform } };

  const identityShell = (): SceneGroupDraw["shell"] => ({
    fit: "fill",
    blendMode: "normal",
    transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
  });

  const newWrap = (inner: FlarexImageValue): FlarexWrapGroup => ({
    kind: "group",
    debugGroupId: `flarex_${comp.id}`,
    children: [inner],
    nestWidth: nestW,
    nestHeight: nestH,
    shell: identityShell(),
    __flarexStage: 0,
  });

  /** A wrap whose shell can still accept an op at `stage` (fixed shell order — re-wrap on violation). */
  const wrapFor = (draw: FlarexImageValue, stage: number): FlarexWrapGroup => {
    if (isGroup(draw)) {
      const wrap = draw as FlarexWrapGroup;
      if (wrap.__flarexStage !== undefined && wrap.__flarexStage <= stage) {
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

  const pushFragmentPass = (draw: FlarexImageValue, pass: SceneFragmentPass): FlarexImageValue => {
    const wrap = wrapFor(draw, STAGE_FRAGMENT);
    wrap.shell.fragmentPasses = [...(wrap.shell.fragmentPasses ?? []), pass];
    return wrap;
  };

  const pushRegionPass = (draw: FlarexImageValue, pass: SceneRegionPass): FlarexImageValue => {
    const wrap = wrapFor(draw, STAGE_REGION);
    wrap.shell.regionPasses = [...(wrap.shell.regionPasses ?? []), pass];
    return wrap;
  };

  /** Rasterize a matte value through the caller's comp-sized cache. Null = soft degrade (no matte). */
  const rasterizeMatte = (matte: FlarexMatteValue, key: string): { tex: TexImageSource; version: number | undefined } | null => {
    const mc = ctx.matteCache;
    if (!mc || matte.masks.length === 0) return null;
    const layerLike = { id: key, masks: matte.masks, animations: [] } as unknown as TimelineLayer;
    const tex = mc.get(layerLike, ctx.timeSeconds);
    if (!tex) return null;
    return { tex, version: mc.versionOf(key) };
  };

  const applyMatteToImage = (draw: FlarexImageValue, matte: FlarexMatteValue, key: string): FlarexImageValue => {
    const raster = rasterizeMatte(matte, key);
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

  /** Color pipeline for one synthetic effect via the SAME compiler every renderer grades with. */
  const pipelineFor = (nodeId: string, type: TimelineEffect["type"], params: Record<string, number | string>): ColorPipeline | null => {
    const layerLike = {
      id: `flarex_${comp.id}_${nodeId}`,
      type: "video",
      startSeconds: 0,
      effects: [{ id: nodeId, type, name: type, enabled: true, intensity: 100, params }],
      animations: [],
    } as unknown as TimelineLayer;
    const pipeline = getCompositionColorPipeline(layerLike, { currentTimeSeconds: ctx.timeSeconds });
    return pipeline && !pipeline.identity ? pipeline : null;
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

  // ── Node evaluation (memoized backwards DFS; cycles degrade to null) ────────────────────────
  const memo = new Map<string, FlarexValue | null>();
  const visiting = new Set<string>();

  const inputValue = (node: FlarexNode, socket: string): FlarexValue | null => {
    const from = edgeInto.get(`${node.id}:${socket}`);
    if (!from) return null;
    const value = evalNode(from);
    if (!value) return null;
    // Per-consumer clone: wraps applied downstream must never mutate the shared memoized subtree.
    return value.kind === "image" ? { kind: "image", draw: cloneImage(value.draw) } : { kind: "matte", matte: { masks: value.matte.masks } };
  };

  const imageInput = (node: FlarexNode, socket: string): FlarexImageValue | null => {
    const v = inputValue(node, socket);
    return v?.kind === "image" ? v.draw : null;
  };

  const matteInput = (node: FlarexNode, socket: string): FlarexMatteValue | null => {
    const v = inputValue(node, socket);
    return v?.kind === "matte" ? v.matte : null;
  };

  /** Pass-through target for a disabled node: its first wired image input. */
  const passthrough = (node: FlarexNode): FlarexValue | null => {
    for (const input of getFlarexNodeDefinition(node.type).inputs) {
      if (input.type !== "image") continue;
      const v = inputValue(node, input.id);
      if (v) return v;
    }
    return null;
  };

  function evalNode(nodeId: string): FlarexValue | null {
    if (memo.has(nodeId)) return memo.get(nodeId) ?? null;
    if (visiting.has(nodeId)) return null; // cycle — degrade, never hang
    const node = nodes[nodeId];
    if (!node) return null;
    visiting.add(nodeId);
    const value = node.enabled ? lowerNode(node) : passthrough(node);
    visiting.delete(nodeId);
    memo.set(nodeId, value);
    return value;
  }

  function lowerNode(node: FlarexNode): FlarexValue | null {
    switch (node.type) {
      case "mediaIn":
        // Host clip only in Phase 1; `sourceClipId` (comp clips) is Phase 2 (FLAREX.md).
        return { kind: "image", draw: cloneImage(ctx.hostSourceDraw) };

      case "mediaOut":
        return inputValue(node, "in");

      // Reroute (F2, round 3): pure pass-through — a wire-organization dot, never alters output.
      case "reroute":
        return inputValue(node, "in");

      case "merge": {
        const bg = imageInput(node, "bg");
        let fg = imageInput(node, "fg");
        if (!bg || !fg) return bg ? { kind: "image", draw: bg } : fg ? { kind: "image", draw: fg } : null;
        const mask = matteInput(node, "mask");
        if (mask) fg = applyMatteToImage(fg, mask, `flarex_${comp.id}_${node.id}_mask`);
        const blend = str(node, "blend", "normal") as SceneLayerDraw["blendMode"];
        const opacity = Math.max(0, Math.min(1, num(node, "opacity", 1)));
        if (isGroup(fg)) {
          fg.shell.blendMode = blend;
          fg.shell.transform.opacity *= opacity;
        } else {
          fg.blendMode = blend;
          fg.transform.opacity *= opacity;
        }
        const merged: FlarexWrapGroup = {
          kind: "group",
          debugGroupId: `flarex_${comp.id}_${node.id}`,
          children: [bg, fg],
          nestWidth: nestW,
          nestHeight: nestH,
          shell: identityShell(),
          __flarexStage: 0,
        };
        return { kind: "image", draw: merged };
      }

      case "transform": {
        const input = imageInput(node, "in");
        if (!input) return null;
        const wrap = wrapFor(input, STAGE_TRANSFORM);
        // x/y are PERCENT offsets from center (timeline-transform units: anchor comp position 0..100).
        wrap.shell.transform = {
          x: 50 + num(node, "x", 0),
          y: 50 + num(node, "y", 0),
          scale: Math.max(0, num(node, "scale", 1)),
          rotation: num(node, "rotation", 0),
          opacity: wrap.shell.transform.opacity,
          anchorX: num(node, "anchorX", 0.5) * 100,
          anchorY: num(node, "anchorY", 0.5) * 100,
        };
        return { kind: "image", draw: wrap };
      }

      case "colorCorrect": {
        const input = imageInput(node, "in");
        if (!input) return null;
        const pipeline = pipelineFor(node.id, "brightnessContrast", {
          exposure: num(node, "exposure", 0),
          contrast: num(node, "contrast", 0),
          saturation: num(node, "saturation", 100),
          temperature: num(node, "temperature", 0),
          tint: num(node, "tint", 0),
        });
        if (!pipeline) return { kind: "image", draw: input };
        const mask = matteInput(node, "mask");
        if (mask) {
          const raster = rasterizeMatte(mask, `flarex_${comp.id}_${node.id}_mask`);
          if (raster) {
            return {
              kind: "image",
              draw: pushRegionPass(input, { effectKey: `flarex_${comp.id}_${node.id}`, mask: raster.tex, maskVersion: raster.version, pipeline }),
            };
          }
        }
        const wrap = wrapFor(input, STAGE_PIPELINE);
        wrap.pipeline = pipeline;
        wrap.groupKey = `flarex_${comp.id}_${node.id}`;
        return { kind: "image", draw: wrap };
      }

      case "colorCurves":
      case "hueSat": {
        const input = imageInput(node, "in");
        if (!input) return null;
        // Node storage key vs. the effect-registry's own param key differ (composition-style.ts
        // reads `colorCurves` effects via `params.curve` and `hueSatCurves` via `params.curves`,
        // both singular/plural mismatches from the node's own param name — keep both straight).
        const nodeParamKey = node.type === "colorCurves" ? "curves" : "hueCurves";
        const effectParamKey = node.type === "colorCurves" ? "curve" : "curves";
        const payload = str(node, nodeParamKey, "");
        if (!payload) return { kind: "image", draw: input };
        const effectType = node.type === "colorCurves" ? "colorCurves" : "hueSatCurves";
        const pipeline = pipelineFor(node.id, effectType, { [effectParamKey]: payload });
        if (!pipeline) return { kind: "image", draw: input };
        const mask = matteInput(node, "mask");
        if (mask) {
          const raster = rasterizeMatte(mask, `flarex_${comp.id}_${node.id}_mask`);
          if (raster) {
            return {
              kind: "image",
              draw: pushRegionPass(input, { effectKey: `flarex_${comp.id}_${node.id}`, mask: raster.tex, maskVersion: raster.version, pipeline }),
            };
          }
        }
        const wrap = wrapFor(input, STAGE_PIPELINE);
        wrap.pipeline = pipeline;
        wrap.groupKey = `flarex_${comp.id}_${node.id}`;
        return { kind: "image", draw: wrap };
      }

      case "blur": {
        const input = imageInput(node, "in");
        if (!input) return null;
        const sigma = Math.max(0, num(node, "sigma", 8));
        if (sigma <= 0) return { kind: "image", draw: input };
        const mask = matteInput(node, "mask");
        if (mask) {
          const raster = rasterizeMatte(mask, `flarex_${comp.id}_${node.id}_mask`);
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
        const input = imageInput(node, "in");
        if (!input) return null;
        const radius = Math.max(0, num(node, "radius", 24));
        if (radius <= 0) return { kind: "image", draw: input };
        const wrap = wrapFor(input, STAGE_GLOW);
        wrap.shell.glow = {
          radiusPx: radius * ctx.renderScale,
          color: [1, 1, 1],
          mode: "highlights",
          threshold: Math.max(0, Math.min(1, num(node, "threshold", 0.7))),
          strength: Math.max(0, num(node, "intensity", 0.6)),
        };
        return { kind: "image", draw: wrap };
      }

      case "sharpen": {
        const input = imageInput(node, "in");
        if (!input) return null;
        // Node amount 0..2 → builtin sharpen's 0..100 scale.
        const pass = fragmentPass(node, builtinFragmentEffectId("sharpen"), { amount: Math.max(0, Math.min(100, num(node, "amount", 0.5) * 50)) });
        return { kind: "image", draw: pass ? pushFragmentPass(input, pass) : input };
      }

      case "filter": {
        const input = imageInput(node, "in");
        if (!input) return null;
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
        const pass = fragmentPass(node, defId, overrides, Math.max(0, Math.min(1, num(node, "intensity", 1))));
        return { kind: "image", draw: pass ? pushFragmentPass(input, pass) : input };
      }

      case "chromaKey": {
        const input = imageInput(node, "in");
        if (!input) return null;
        const pass = fragmentPass(node, FLAREX_CHROMA_KEY_ID, {
          keyColor: parseHexColor(str(node, "color", "#00b140")),
          tolerance: num(node, "tolerance", 0.35),
          softness: num(node, "softness", 0.1),
          clipBlack: num(node, "clipBlack", 0),
          clipWhite: num(node, "clipWhite", 1),
          spillSuppression: num(node, "spillSuppression", 0.5),
          edgeSoftness: num(node, "edgeSoftness", 2),
          choke: num(node, "choke", 0.05),
          decontaminate: num(node, "decontaminate", 0.5),
          matteOnly: bool(node, "matteOnly"),
        });
        return { kind: "image", draw: pass ? pushFragmentPass(input, pass) : input };
      }

      case "lumaKey": {
        const input = imageInput(node, "in");
        if (!input) return null;
        const pass = fragmentPass(node, FLAREX_LUMA_KEY_ID, {
          low: num(node, "low", 0),
          high: num(node, "high", 1),
          softness: num(node, "softness", 0.1),
          invertKey: bool(node, "invert"),
          matteOnly: bool(node, "matteOnly"),
        });
        return { kind: "image", draw: pass ? pushFragmentPass(input, pass) : input };
      }

      case "rectMask":
      case "ellipseMask": {
        const w = ctx.compWidth;
        const h = ctx.compHeight;
        const cx = num(node, "centerX", 0.5) * w;
        const cy = num(node, "centerY", 0.5) * h;
        const halfW = (Math.max(0, num(node, "width", 0.5)) * w) / 2;
        const halfH = (Math.max(0, num(node, "height", 0.5)) * h) / 2;
        const mask = createBoxMask(node.type === "rectMask" ? "rectangle" : "ellipse", cx - halfW, cy - halfH, cx + halfW, cy + halfH, 1);
        mask.id = `flarex_${comp.id}_${node.id}`;
        // Node feather is a comp fraction (resolution-independent); Mask.feather is px.
        mask.feather = Math.max(0, Math.min(1, num(node, "feather", 0))) * Math.min(w, h) * 0.5;
        mask.inverted = bool(node, "invert");
        if (node.type === "rectMask") mask.cornerRadius = Math.max(0, Math.min(1, num(node, "cornerRadius", 0))) * Math.min(halfW, halfH);
        return { kind: "matte", matte: { masks: [mask] } };
      }

      case "matteControl": {
        const a = matteInput(node, "a");
        const b = matteInput(node, "b");
        if (!a && !b) return null;
        const operation = str(node, "operation", "add") as Mask["mode"];
        const feather = Math.max(0, Math.min(1, num(node, "feather", 0))) * Math.min(ctx.compWidth, ctx.compHeight) * 0.5;
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
        mask.feather = Math.max(0, Math.min(1, num(node, "feather", 0))) * Math.min(w, h) * 0.5;
        mask.inverted = bool(node, "invert");
        return { kind: "matte", matte: { masks: [mask] } };
      }

      // Phase 1.5+ nodes (FLAREX.md): declared in node-defs for the palette/AI surface, but not
      // yet lowered — they pass through so a saved graph containing them still renders.
      case "aiMatte":
        return null;
      case "text":
      case "tracker":
        return passthrough(node);

      default:
        return passthrough(node);
    }
  }

  // View-any-node (Fusion view dot): root at the previewed node when set; a preview that yields
  // no image (matte-only node, unwired) falls back to MediaOut so the frame never goes blank.
  const previewNode = comp.previewNodeId ? nodes[comp.previewNodeId] : undefined;
  if (previewNode && previewNode.type !== "mediaOut") {
    const previewed = evalNode(previewNode.id);
    if (previewed?.kind === "image") return previewed.draw;
  }
  const result = evalNode(mediaOut.id);
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
