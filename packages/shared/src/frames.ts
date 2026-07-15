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
import type { Mask, MaskPoint } from "./types";

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
 * not the media box). `axis` is what the grabbed handle controls — E/W → "x", N/S → "y", corners → "both" —
 * so an edge handle only moves its own axis instead of shearing the shape, and `aspectLock` keeps the box
 * square by driving the partner from whichever axis the user actually dragged (corners take the larger).
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
  return {
    ...params,
    ...(axis === "x" || axis === "both" ? { width: clampPct(requested.width) } : {}),
    ...(axis === "y" || axis === "both" ? { height: clampPct(requested.height) } : {})
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
