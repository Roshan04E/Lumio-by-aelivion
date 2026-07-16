/**
 * Frames (see FRAMES.md) — parametric, data-driven media placeholders. A Frame is NOT hardcoded: it is
 * a trusted shape GENERATOR + parameter values, chosen from a `FrameDefinition` (built-in or from a
 * marketplace pack). Media on the layer clips to the generated outline; the frame's params surface in
 * the inspector's Effects subpanel via the SAME param-schema shape effects use.
 *
 * This module is pure data + pure geometry (a generator emits an SVG path `d` normalised to the unit box
 * [0,1]×[0,1]). The renderers scale that into the layer box and feed it to the EXISTING clip-mask matte —
 * so Frames add no new clipping code. No third-party code executes: packs only supply a `generatorId`
 * (one of the trusted set below) + param values + an optional STATIC `svg-path` outline. That is what
 * makes the format safe to sell/import.
 */

import type { TimelineEffectParamDefinition } from "./effects";
import type { Mask, MaskPoint, ShapeKind, TimelineLayer } from "./types";

/** Object-fit modes, matching the compositor's `ObjectFit` (kept local so this pure module has no deps). */
export type FrameObjectFit = "cover" | "contain" | "fill";

/** Trusted shape generators. Packs may reference these by id; they never ship executable code. */
export type FrameGeneratorId = "rounded-rect" | "ellipse" | "polygon" | "blob" | "torn-paper" | "svg-path";

/** A frame param value. `boolean` covers chrome toggles (aspectLock); `color` params are hex strings. */
export type FrameParamValue = number | string | boolean;

/** A frame instance stored on a layer: which generator + its current param values (+ static art for svg-path). */
export interface LayerFrame {
  /** The FrameDefinition.id this came from — lets us re-pick / show the source in the panel. */
  definitionId: string;
  generatorId: FrameGeneratorId;
  /**
   * Current param values, keyed by param `key` — BOTH tiers (see FRAMES.md D1): the generator's own
   * params (roundness, sides, roughness…) and the universal chrome (width/height/aspectLock). Edited
   * from the Effects subpanel; persists here.
   */
  params: Record<string, FrameParamValue>;
  /** Unit-box ([0,1]) SVG path `d`. Present only when `generatorId === "svg-path"` (creator's static art). */
  staticPath?: string | undefined;
}

/**
 * A pickable frame in the Graphics panel — built-in OR from a marketplace pack, IDENTICAL format (dogfood).
 * Pure data: a generator id + a param SCHEMA (reuses the effect param-def shape → Effects-subpanel controls).
 */
export interface FrameDefinition {
  /** Stable id, namespaced by author: "kimera.rounded-rect", "acme.torn-note". */
  id: string;
  name: string;
  generatorId: FrameGeneratorId;
  /** Editable params, rendered by the existing schema-driven effect controls. Empty = no knobs. */
  params: TimelineEffectParamDefinition[];
  /** Unit-box SVG path for generatorId === "svg-path" (bespoke art, pure data). */
  staticPath?: string | undefined;
  /** data-URI preview for the panel tile (optional; a generated preview is used when absent). */
  thumbnail?: string | undefined;
  /**
   * Per-definition overrides of the shared chrome defaults, keyed by chrome param key. Lets a frame
   * ship a sensible box without redeclaring the schema — e.g. Circle sets `aspectLock: true` so it
   * stays a CIRCLE in a 16:9 comp instead of stretching to an oval.
   */
  chromeDefaults?: Record<string, FrameParamValue> | undefined;
}

// --- Tier 2: chrome params (universal box; see FRAMES.md "v1.5 model") -------------------------
//
// Frame-NATIVE names (founder decision D1: frames own their full vocabulary — no coupling to the
// shape-layer field names). Every frame gets these merged in, so even the most exotic pack generator
// has a box for free and never redeclares it. Border chrome (border/borderWidth/borderColor) joins
// this list in Step E, when there is actually a renderer to draw it — knobs ship WITH their pixels.

/** The universal box params merged into every frame definition. */
export const frameChromeParams: TimelineEffectParamDefinition[] = [
  { key: "width", label: "Width", type: "number", min: 1, max: 100, step: 1, defaultValue: 100, unit: "%" },
  { key: "height", label: "Height", type: "number", min: 1, max: 100, step: 1, defaultValue: 100, unit: "%" },
  { key: "aspectLock", label: "Lock Aspect", type: "boolean", defaultValue: false }
];

const chromeParamKeys = new Set(frameChromeParams.map((param) => param.key));

/** A definition's FULL param schema: its own generator params (Tier 1) + the universal chrome (Tier 2). */
export function frameParamSchema(def: FrameDefinition): TimelineEffectParamDefinition[] {
  // A definition may not shadow a chrome key — chrome semantics must stay identical across all frames.
  const own = def.params.filter((param) => !chromeParamKeys.has(param.key));
  return [...own, ...frameChromeParams];
}

/**
 * The card's grouping: generator knobs first ("Shape"), then the universal box. Returned as data so the
 * inspector renders sections without knowing which params belong to which tier.
 */
export function frameParamSections(def: FrameDefinition): Array<{ title: string; params: TimelineEffectParamDefinition[] }> {
  const own = def.params.filter((param) => !chromeParamKeys.has(param.key));
  return [
    ...(own.length ? [{ title: "Shape", params: own }] : []),
    { title: "Box", params: frameChromeParams }
  ];
}

// --- Param helpers -----------------------------------------------------------------------------

function numberParam(params: Record<string, FrameParamValue>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanParam(params: Record<string, FrameParamValue>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Instantiate a param bag from a definition's FULL schema defaults (generator + chrome), applying the
 * definition's `chromeDefaults` overrides. Used when a frame is first applied.
 */
export function frameParamDefaults(def: FrameDefinition): Record<string, FrameParamValue> {
  const out: Record<string, FrameParamValue> = {};
  for (const param of frameParamSchema(def)) {
    // Every param variant carries a `defaultValue` (number | string | boolean) — take it as-is.
    out[param.key] = param.defaultValue;
  }
  for (const [key, value] of Object.entries(def.chromeDefaults ?? {})) {
    if (chromeParamKeys.has(key)) out[key] = value;
  }
  return out;
}

/** Build a fresh `LayerFrame` from a definition (schema defaults + any static art). */
export function makeLayerFrame(def: FrameDefinition): LayerFrame {
  return {
    definitionId: def.id,
    generatorId: def.generatorId,
    params: frameParamDefaults(def),
    ...(def.staticPath ? { staticPath: def.staticPath } : {})
  };
}

// --- Generators: (frame) => unit-box SVG path `d` ----------------------------------------------
// All output is normalised to the [0,1]×[0,1] box (SVG y-down), closed. The renderer scales to the
// layer box. Keeping generators pure + unit-box makes them trivially unit-testable and resolution-free.

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const fmt = (n: number) => Number(n.toFixed(4)).toString();

/** Rounded rectangle. `roundness` 0..100 = percent of the half-min-dimension (100 → fully rounded/stadium). */
function roundedRectPathD(roundness: number): string {
  const r = clamp01((clamp01(roundness / 100) * 0.5)); // half of the unit box's min side (=1) → max 0.5
  if (r <= 0.0001) return "M0 0H1V1H0Z";
  const a = fmt(r);
  const one = "1";
  const oneMinus = fmt(1 - r);
  // Corners clockwise from the top-left, each an elliptical arc of radius r.
  return [
    `M${a} 0`,
    `H${oneMinus}`,
    `A${a} ${a} 0 0 1 ${one} ${a}`,
    `V${oneMinus}`,
    `A${a} ${a} 0 0 1 ${oneMinus} ${one}`,
    `H${a}`,
    `A${a} ${a} 0 0 1 0 ${oneMinus}`,
    `V${a}`,
    `A${a} ${a} 0 0 1 ${a} 0`,
    "Z"
  ].join(" ");
}

/** Full-box ellipse (circle when the box is square). */
function ellipsePathD(): string {
  return "M0 0.5 A0.5 0.5 0 0 1 1 0.5 A0.5 0.5 0 0 1 0 0.5 Z";
}

/** Regular N-gon inscribed in the unit box, `rotationDeg` orients it (0 → a point at the top). */
function polygonPathD(sides: number, rotationDeg: number): string {
  const n = Math.max(3, Math.round(sides));
  const cx = 0.5;
  const cy = 0.5;
  const rot = ((rotationDeg - 90) * Math.PI) / 180; // -90 so 0° puts a vertex at the top
  const pts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push(`${fmt(cx + Math.cos(a) * 0.5)} ${fmt(cy + Math.sin(a) * 0.5)}`);
  }
  return `M${pts[0]} L${pts.slice(1).join(" L")} Z`;
}

/**
 * The unit-box clip outline for a frame, as an SVG path `d`. Unknown generators fall back to the full box
 * (media just fills the layer, no clip) so an unrecognised pack frame degrades safely instead of vanishing.
 * `blob`/`torn-paper` are Phase 2 — they fall back to their nearest simple shape for now.
 */
export function frameOutlinePathD(frame: Pick<LayerFrame, "generatorId" | "params" | "staticPath">): string {
  switch (frame.generatorId) {
    case "rounded-rect":
      return roundedRectPathD(numberParam(frame.params, "roundness", 0));
    case "ellipse":
      return ellipsePathD();
    case "polygon":
      return polygonPathD(numberParam(frame.params, "sides", 6), numberParam(frame.params, "rotation", 0));
    case "svg-path":
      return frame.staticPath && frame.staticPath.trim() ? frame.staticPath : "M0 0H1V1H0Z";
    case "blob":
    case "torn-paper":
      // Phase 2 procedural generators; degrade to a plain box until implemented.
      return "M0 0H1V1H0Z";
    default:
      return "M0 0H1V1H0Z";
  }
}

// --- Built-in frame catalogue (same format a marketplace pack uses) ----------------------------

export const builtInFrames: FrameDefinition[] = [
  {
    id: "kimera.rounded-rect",
    name: "Rounded Rectangle",
    generatorId: "rounded-rect",
    params: [{ key: "roundness", label: "Roundness", type: "number", min: 0, max: 100, step: 1, defaultValue: 20, unit: "%" }]
  },
  {
    // No generator params of its own — a circle is fully described by its box. `aspectLock` is what
    // makes it a CIRCLE rather than an oval stretched to the comp's aspect (QA round 1).
    id: "kimera.circle",
    name: "Circle",
    generatorId: "ellipse",
    params: [],
    chromeDefaults: { aspectLock: true }
  },
  {
    id: "kimera.hexagon",
    name: "Hexagon",
    generatorId: "polygon",
    params: [
      { key: "sides", label: "Sides", type: "number", min: 3, max: 12, step: 1, defaultValue: 6 },
      { key: "rotation", label: "Rotation", type: "number", min: 0, max: 360, step: 1, defaultValue: 0, unit: "°" }
    ],
    // A regular N-gon is only regular in a square box — otherwise it shears with the comp aspect.
    chromeDefaults: { aspectLock: true }
  }
];

/** Look up a built-in frame definition by id (Phase 3 will also consult imported packs). */
export function findFrameDefinition(id: string): FrameDefinition | undefined {
  return builtInFrames.find((frame) => frame.id === id);
}

// --- Render bridge: a frame → a synthesized clip Mask (reuses the pixel-gated mask pipeline) ----
//
// A frame clips its media by becoming a native clip `Mask` inscribed in the comp box: both renderers
// already turn a Mask into an SVG path (`maskShapeToPathD`) and clip to it (DOM `mask-image` + the
// SceneCompositor alpha matte), so Frames add NO new clip code. The layer transform then scales/
// positions the framed media (media masks ride the transform). The mask id is deterministic so the DOM
// def (buildMaskDefsSvg) and the DOM ref (getCompositionMaskCss) resolve to the same stencil.

/**
 * Params after an on-canvas handle drag resized the box (Step C / decision D2: handles resize the FRAME,
 * not the media box). `axis` is what the grabbed handle controls — E/W → "x", N/S → "y", corners → "both".
 *
 * The gesture model (standard design-tool convention; QA 2026-07-16):
 *  - **Corner ("both") = PROPORTIONAL** — a uniform scale that preserves the box's current PIXEL aspect, so
 *    corners never distort the frame. This also makes D6's group scale EXACT (both axes take one factor, so
 *    the media scales unambiguously with the box). Edges are the deliberate way to change proportions.
 *  - **Edge ("x"/"y") = single axis** — moves only its own dimension, so the shape isn't sheared from an edge.
 *  - **aspectLock (circle/hexagon)** overrides: the box must stay SQUARE, so every handle drives the square
 *    (an edge can't make an oval "circle") — corners and edges both keep it regular.
 */
export function setFrameBoxFromResize(
  frame: Pick<LayerFrame, "params"> & { definitionId?: string | undefined },
  requested: { width: number; height: number },
  axis: "x" | "y" | "both",
  comp: { width: number; height: number }
): Record<string, FrameParamValue> {
  const params = frameEffectiveParams(frame);
  const clampPct = (n: number) => Math.min(100, Math.max(1, n));
  if (booleanParam(params, "aspectLock", false)) {
    if (axis === "x") return setFrameBoxAxis(frame, "width", requested.width, comp);
    if (axis === "y") return setFrameBoxAxis(frame, "height", requested.height, comp);
    // Corner: the square follows the larger of the two requested PIXEL extents, so either direction grows it.
    const widthPx = (Math.max(1, comp.width) * clampPct(requested.width)) / 100;
    const heightPx = (Math.max(1, comp.height) * clampPct(requested.height)) / 100;
    const side = Math.max(widthPx, heightPx);
    return setFrameBoxAxis(frame, "width", (side / Math.max(1, comp.width)) * 100, comp);
  }
  if (axis === "both") {
    // Proportional corner: scale BOTH percentages by one factor → the pixel aspect is preserved (both px =
    // %·compDim scale by the same factor). Drive it from whichever axis the pointer favors so the corner
    // tracks the drag, and clamp the FACTOR (not each axis) so both stay in [1,100] with the aspect intact.
    const w0 = clampPct(numberParam(params, "width", 100));
    const h0 = clampPct(numberParam(params, "height", 100));
    const dominant = Math.max(requested.width / w0, requested.height / h0);
    const fMin = Math.max(1 / w0, 1 / h0);
    const fMax = Math.min(100 / w0, 100 / h0);
    const factor = Math.min(fMax, Math.max(fMin, dominant));
    return { ...params, width: w0 * factor, height: h0 * factor };
  }
  return {
    ...params,
    ...(axis === "x" ? { width: clampPct(requested.width) } : {}),
    ...(axis === "y" ? { height: clampPct(requested.height) } : {})
  };
}

/** Deterministic id for a layer's synthesized frame clip mask. */
export function frameMaskId(layerId: string): string {
  return `${layerId}__frame`;
}

/**
 * A frame's params resolved AGAINST its definition: the stored bag is an OVERRIDE layer over the
 * definition's defaults, not a replacement. This keeps three things honest:
 *  - frames saved before a param existed pick it up (a circle stored as `params: {}` still gets
 *    `aspectLock: true` from its definition, so it renders as a CIRCLE rather than a stale oval);
 *  - a pack that adds a param in a later version doesn't break frames already on a timeline;
 *  - an unknown definition (pack not installed) still renders from whatever the layer stored.
 */
export function frameEffectiveParams(frame: {
  definitionId?: string | undefined;
  params: Record<string, FrameParamValue>;
}): Record<string, FrameParamValue> {
  const def = frame.definitionId ? findFrameDefinition(frame.definitionId) : undefined;
  return def ? { ...frameParamDefaults(def), ...frame.params } : { ...frame.params };
}

/**
 * The frame's BOX: a centered rect inside the comp box, in comp pixels. This is the fix for
 * "circle is not circle" (QA round 1): a media layer owns no width/height — its box IS the whole comp
 * frame — so a full-box ellipse in a 16:9 comp is an OVAL by construction. The frame now carries its
 * own `width`/`height` chrome, and `aspectLock` squares the box in PIXELS (not percent), so a circle
 * stays a circle at ANY comp aspect (16:9, 9:16, 1:1) rather than being special-cased per format.
 */
export function frameBoxRect(
  frame: Pick<LayerFrame, "params"> & { definitionId?: string | undefined },
  comp: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const params = frameEffectiveParams(frame);
  const compW = Math.max(1, comp.width);
  const compH = Math.max(1, comp.height);
  const widthPct = Math.min(100, Math.max(1, numberParam(params, "width", 100)));
  const heightPct = Math.min(100, Math.max(1, numberParam(params, "height", 100)));
  let width = (compW * widthPct) / 100;
  let height = (compH * heightPct) / 100;
  if (booleanParam(params, "aspectLock", false)) {
    // Square in pixels — the inscribed side is the smaller of the two, so the shape always fits.
    const side = Math.min(width, height);
    width = side;
    height = side;
  }
  return { x: (compW - width) / 2, y: (compH - height) / 2, width, height };
}

/**
 * The frame box as PERCENTAGES of the comp — i.e. what the user actually sees, which is not always what
 * `params.width`/`params.height` say: `aspectLock` squares the box at render time, so a locked circle
 * stored as 100/100 really occupies 56.25% × 100% of a 16:9 comp. The inspector displays THESE numbers,
 * so the width/height fields can never disagree with the shape on canvas (QA round 2).
 */
export function frameBoxPercent(
  frame: Pick<LayerFrame, "params"> & { definitionId?: string | undefined },
  comp: { width: number; height: number }
): { width: number; height: number } {
  const box = frameBoxRect(frame, comp);
  return { width: (box.width / Math.max(1, comp.width)) * 100, height: (box.height / Math.max(1, comp.height)) * 100 };
}

/**
 * Params after setting one box axis to `percent`, keeping the OTHER axis in sync while `aspectLock` is
 * on so the box stays square in pixels. Without this the partner axis silently caps the locked square
 * (`frameBoxRect` takes the min), and dragging Width past that cap would do nothing.
 *
 * When the requested size can't be square inside the comp (e.g. 100% width in a 16:9 comp needs 177%
 * height), the partner clamps at 100 and the box settles at the largest square that fits — so the field
 * visibly snaps back to the true value instead of holding a number the canvas doesn't honour.
 */
export function setFrameBoxAxis(
  frame: Pick<LayerFrame, "params"> & { definitionId?: string | undefined },
  axis: "width" | "height",
  percent: number,
  comp: { width: number; height: number }
): Record<string, FrameParamValue> {
  const params = { ...frameEffectiveParams(frame) };
  const value = Math.min(100, Math.max(1, percent));
  params[axis] = value;
  if (booleanParam(params, "aspectLock", false)) {
    const compW = Math.max(1, comp.width);
    const compH = Math.max(1, comp.height);
    // Partner % that makes the partner axis span the SAME pixel length as `value` does on `axis`.
    const ratio = axis === "width" ? compW / compH : compH / compW;
    params[axis === "width" ? "height" : "width"] = Math.min(100, Math.max(1, value * ratio));
  }
  return params;
}

/**
 * The clip `Mask` for `layer.frame`, inscribed in the comp box, or null when the frame isn't set / can't
 * yet be expressed as a native mask shape (`svg-path`/`blob`/`torn-paper` — Phase 2; they simply don't
 * clip for now, so media shows un-clipped rather than vanishing). `comp` geometry only affects the
 * outline points; callers that just need the id/mode for a CSS ref may pass the default box.
 */
export function frameClipMask(
  layer: { id: string; frame?: LayerFrame | undefined },
  comp: { width: number; height: number } = { width: 100, height: 100 }
): Mask | null {
  const frame = layer.frame;
  if (!frame) return null;
  // Resolve against the definition so a frame missing a param still renders as its author intended.
  const params = frameEffectiveParams(frame);
  // The frame's own box inside the comp — NOT the full comp box (see frameBoxRect).
  const box = frameBoxRect(frame, comp);
  const { width: w, height: h } = box;
  const left = box.x;
  const top = box.y;
  const right = left + w;
  const bottom = top + h;
  const id = frameMaskId(layer.id);
  const base = {
    id,
    name: "Frame",
    enabled: true,
    mode: "add" as const,
    feather: 0,
    expansion: 0,
    opacity: 100,
    inverted: false,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }
  };
  const corners = (): MaskPoint[] => [
    { id: `${id}_0`, x: left, y: top },
    { id: `${id}_1`, x: right, y: top },
    { id: `${id}_2`, x: right, y: bottom },
    { id: `${id}_3`, x: left, y: bottom }
  ];
  switch (frame.generatorId) {
    case "rounded-rect": {
      const roundness = Math.max(0, Math.min(100, numberParam(params, "roundness", 0)));
      const cornerRadius = ((Math.min(w, h) / 2) * roundness) / 100;
      return { ...base, shape: "rectangle", points: corners(), cornerRadius };
    }
    case "ellipse":
      return { ...base, shape: "ellipse", points: corners() };
    case "polygon": {
      const sides = Math.max(3, Math.round(numberParam(params, "sides", 6)));
      const rotationDeg = numberParam(params, "rotation", 0);
      const cx = left + w / 2;
      const cy = top + h / 2;
      const rot = ((rotationDeg - 90) * Math.PI) / 180;
      const points: MaskPoint[] = [];
      for (let i = 0; i < sides; i += 1) {
        const a = rot + (i / sides) * Math.PI * 2;
        points.push({ id: `${id}_${i}`, x: cx + Math.cos(a) * (w / 2), y: cy + Math.sin(a) * (h / 2) });
      }
      return { ...base, shape: "polygon", points };
    }
    default:
      // svg-path / blob / torn-paper — not a native mask shape yet (Phase 2). No clip.
      return null;
  }
}

// --- Content mode: where the SOURCE media actually sits inside the frame (QA round 5) -----------
//
// In content mode (double-click a framed clip) the selection box must hug the SOURCE clip, not the
// frame box — so the handles describe the media (they shrink on zoom, follow a pan) instead of lying.
// This is the single source of truth for that rect; both the hug outline and the edge-snap read it, so
// they can never disagree. The math is INVERTED from the compositor, not guessed (see scene-compositor):
//
//   baseFit = fitScale(sw, sh, cw, ch, fit)              // comp/draw scale per axis (object-fit)
//   fitVec  = baseFit / content.scale                     // content zoom folds in
//   mediaUv = (v_uv - 0.5 - pan) * fitVec + 0.5,  pan = offset * 0.5
//
// The media is visible where mediaUv ∈ [0,1] → in comp (= media layer-box) fractions it spans
// size `1/fitVec` centred at `0.5 + pan`. NOTE the media fits the COMP, not the frame box (the frame is
// only a clip mask), so the frame box does NOT enter this rect — it's the reference the snap compares to.
// `fitScale` depends only on the two ASPECTS (it's a ratio of ratios), so aspects are all we need here.

/** Per-axis object-fit scale expressed from aspects alone (the aspect form of the compositor's `fitScale`). */
function fitScaleFromAspects(sourceAspect: number, compAspect: number, fit: FrameObjectFit): [number, number] {
  if (fit === "fill" || sourceAspect <= 0 || compAspect <= 0) return [1, 1];
  const ratio = compAspect / sourceAspect; // = (cw/ch)/(sw/sh) = (cw/sw)/(ch/sh)
  if (fit === "contain") return ratio >= 1 ? [ratio, 1] : [1, 1 / ratio];
  // cover
  return ratio >= 1 ? [1, 1 / ratio] : [ratio, 1];
}

/**
 * The rect the SOURCE media occupies, in comp (media layer-box) fractions, SCREEN space (y-down). Ignores
 * the frame's clip — this is the full media rect, which content mode's handles hug. `x`/`y` are the
 * top-left; `width`/`height` the size (both can exceed 1 for `cover` or zoom-in). Derived by inverting the
 * compositor mapping (see block comment above).
 */
export function mediaRectInFrame(args: {
  sourceAspect: number;
  compAspect: number;
  fit: FrameObjectFit;
  contentScale: number;
  contentOffset: { x: number; y: number }; // content offsetX/offsetY, -1..1
}): { x: number; y: number; width: number; height: number } {
  const scale = args.contentScale > 0 ? args.contentScale : 1;
  const baseFit = fitScaleFromAspects(args.sourceAspect, args.compAspect, args.fit);
  const fitVec: [number, number] = [baseFit[0] / scale, baseFit[1] / scale];
  const width = fitVec[0] > 0 ? 1 / fitVec[0] : 1;
  const height = fitVec[1] > 0 ? 1 / fitVec[1] : 1;
  // pan = offset * 0.5; centre = 0.5 + pan. Compositor v_uv.y is Y-UP, so a POSITIVE offsetY moves the
  // media UP → its screen-space centre is 0.5 - offsetY*0.5.
  const cx = 0.5 + args.contentOffset.x * 0.5;
  const cy = 0.5 - args.contentOffset.y * 0.5;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/**
 * Snap a media rect's edges/centre to a frame box while panning in content mode. Returns the comp-fraction
 * shift `{ dx, dy }` to apply to the rect so a near edge (or centre) clicks onto the frame, plus whether each
 * axis snapped (for a HUD). Engages only within `thresholdX`/`thresholdY` (comp fractions — the caller
 * derives these from a fixed SCREEN-px threshold, so it feels identical at any viewer zoom); a deliberate
 * drag past the threshold still wins. This is pure geometry so the same rule pins in a unit test.
 */
export function snapMediaRectToBox(
  rect: { x: number; y: number; width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
  thresholdX: number,
  thresholdY: number
): { dx: number; dy: number; snappedX: boolean; snappedY: boolean } {
  const best = (
    rectLo: number,
    rectSize: number,
    boxLo: number,
    boxSize: number,
    threshold: number
  ): { d: number; snapped: boolean } => {
    // Candidate alignments: left→left, right→right, centre→centre. Pick the smallest shift within range.
    const candidates = [boxLo - rectLo, boxLo + boxSize - (rectLo + rectSize), boxLo + boxSize / 2 - (rectLo + rectSize / 2)];
    let chosen = 0;
    let chosenAbs = Infinity;
    for (const d of candidates) {
      const abs = Math.abs(d);
      if (abs <= threshold && abs < chosenAbs) {
        chosen = d;
        chosenAbs = abs;
      }
    }
    return chosenAbs === Infinity ? { d: 0, snapped: false } : { d: chosen, snapped: true };
  };
  const x = best(rect.x, rect.width, box.x, box.width, thresholdX);
  const y = best(rect.y, rect.height, box.y, box.height, thresholdY);
  return { dx: x.d, dy: y.d, snappedX: x.snapped, snappedY: y.snapped };
}

/**
 * D6 group scale: when a CORNER frame handle resizes the box, the inner media scales WITH it so it keeps
 * its relative coverage of the frame. Returns the factor to multiply `content.scale` by, given the box
 * BEFORE and AFTER the resize (as param bags). Uniform under `aspectLock` (both axes share one factor);
 * for a non-uniform unlocked corner the media zoom is a single uniform scalar, so we take the geometric
 * mean of the two axis factors — the balanced choice that preserves AREA coverage. `1` when degenerate.
 */
export function frameGroupScaleFactor(
  prev: Pick<LayerFrame, "params"> & { definitionId?: string | undefined },
  nextParams: Record<string, FrameParamValue>,
  comp: { width: number; height: number }
): number {
  const before = frameBoxRect(prev, comp);
  const after = frameBoxRect({ ...prev, params: nextParams }, comp);
  if (before.width <= 0 || before.height <= 0 || after.width <= 0 || after.height <= 0) return 1;
  const fx = after.width / before.width;
  const fy = after.height / before.height;
  const factor = Math.sqrt(fx * fy);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

// --- Convert to graphic (D4) — the ONE place frame fields translate to shape fields (D1) --------
//
// Founder decision D4: "Convert to graphic" is a TRUE, one-way conversion — the layer BECOMES a `shape`
// (frame + media dropped, undoable) and fully inherits shape behaviour (graphics panel, colour settings,
// shape keyframes, the shape renderer). D1's containment rule: this frame↔shape translation lives in
// EXACTLY this function and nowhere else, so the two vocabularies' drift stays in one reviewable table.
//
// Native `shapeKind` wherever one exists so simple frames stay parametric AS shapes:
//   rounded-rect → `rounded-rectangle` + `borderRadius`   ellipse → `ellipse`
// otherwise `pen` + `shapePath` (the outline as points in the shape box; exotic curves would carry via
// MaskPoint tangents). `svg-path`/`blob`/`torn-paper` don't clip yet (frameClipMask → null → media shows
// unclipped), so their honest current visual is the full box → `rectangle`.

/** Shape-layer defaults a converted frame adopts (the media is gone, so the shape needs its own paint).
 *  Kept here, not imported from the editor, so this pure module has no app dependency. */
const CONVERT_SHAPE_FILL = "#4D9FFF";
const CONVERT_SHAPE_STROKE = "#ffffff";

/** Regular-polygon vertices as `MaskPoint`s in shape-box coords (0..100), matching `polygonPathD`'s
 *  orientation (0° → a vertex at the top). Used for the `pen` fallback so a polygon frame stays its shape. */
function polygonShapePath(id: string, sides: number, rotationDeg: number): MaskPoint[] {
  const n = Math.max(3, Math.round(sides));
  const rot = ((rotationDeg - 90) * Math.PI) / 180;
  const points: MaskPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = rot + (i / n) * Math.PI * 2;
    points.push({ id: `${id}_${i}`, x: 50 + Math.cos(a) * 50, y: 50 + Math.sin(a) * 50 });
  }
  return points;
}

/**
 * Turn a framed media layer into a native `shape` layer (D4). Returns a NEW layer: `type: "shape"`, the
 * frame's outline expressed as shape fields, the frame box carried over as `widthPercent`/`heightPercent`,
 * and the frame + media-only fields dropped. Pure — the caller decides how to commit it (undoable).
 */
export function frameToShapeLayer(layer: TimelineLayer, comp: { width: number; height: number }): TimelineLayer {
  const frame = layer.frame;
  if (!frame) return layer;
  const params = frameEffectiveParams(frame);
  const box = frameBoxRect(frame, comp); // px — for the border radius
  const boxPct = frameBoxPercent(frame, comp); // the shape box as % of the comp

  // Outline → shape fields (the D1 table).
  let shapeKind: ShapeKind;
  let borderRadius = 0;
  let shapePath: MaskPoint[] | undefined;
  switch (frame.generatorId) {
    case "rounded-rect": {
      shapeKind = "rounded-rectangle";
      const roundness = Math.max(0, Math.min(100, numberParam(params, "roundness", 0)));
      // Same rule frameClipMask uses: roundness% of the half-min side (so the shape looks identical).
      borderRadius = ((Math.min(box.width, box.height) / 2) * roundness) / 100;
      break;
    }
    case "ellipse":
      shapeKind = "ellipse";
      break;
    case "polygon":
      shapeKind = "pen";
      shapePath = polygonShapePath(`${layer.id}__shape`, numberParam(params, "sides", 6), numberParam(params, "rotation", 0));
      break;
    default:
      // svg-path / blob / torn-paper — not clipped today, so the honest visual is the full box.
      shapeKind = "rectangle";
      break;
  }

  const next: TimelineLayer = {
    ...layer,
    type: "shape",
    shapeKind,
    borderRadius,
    widthPercent: boxPct.width,
    heightPercent: boxPct.height,
    // The frame carried no paint (the media was the fill); the shape needs its own, then the colour panel
    // owns it from here (D4 "inherits shape colour settings for free").
    color: layer.color ?? CONVERT_SHAPE_FILL,
    strokeColor: layer.strokeColor ?? CONVERT_SHAPE_STROKE,
    strokeWidth: layer.strokeWidth ?? 0,
    // Drop the frame and every media-only field — this is a one-way conversion, the media is gone.
    frame: undefined,
    assetId: undefined,
    content: undefined,
    fit: undefined,
    matte: undefined,
    ...(shapePath ? { shapePath } : {})
  };
  return next;
}
