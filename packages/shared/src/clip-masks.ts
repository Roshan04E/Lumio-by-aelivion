import { evaluateAnimatedValue } from "./animation";
import { COLOR_EFFECT_TYPES } from "./color/types";
import { frameClipMask } from "./frames";
import type { LayerFrame } from "./frames";
import type { Mask, MaskMode, MaskPoint, MaskShape, MaskPathKeyframe, TimelineComposition, TimelineEffect, TimelineKeyframeV2, TimelineLayer } from "./types";

/** The mask scalar properties that can be keyframed via the layer `animations` array (scope "mask"). */
export type MaskScalarProperty =
  | "feather"
  | "expansion"
  | "opacity"
  | "transform.x"
  | "transform.y"
  | "transform.scaleX"
  | "transform.scaleY"
  | "transform.rotation";

export const maskScalarProperties: MaskScalarProperty[] = [
  "feather",
  "expansion",
  "opacity",
  "transform.x",
  "transform.y",
  "transform.scaleX",
  "transform.scaleY",
  "transform.rotation"
];

/**
 * Vector-mask renderer. Builds the SVG `<mask>`/`<filter>` `<defs>` markup and the CSS that references
 * them, consumed *identically* by the web preview and the Remotion export (both Chromium/DOM), so masks
 * are pixel-aligned by construction — the same parity trick the color-filter and warped-text defs use.
 *
 * Geometry is stored in the layer's local comp-pixel space (origin = the layer element's top-left, which
 * equals the comp box when the layer transform is default). The CSS mask is applied to the *transformed*
 * layer element, so the mask follows the clip's Transform automatically.
 *
 * Mode compositing uses `-webkit-mask-composite` (Chromium-only — both renderers are Blink) over one `<mask>`
 * layer per mask; feather/expansion/invert/opacity bake into each layer. The CSS layer list is reversed so the
 * base ends up at the bottom and each mask composites onto the running accumulation by its own mode (Subtract
 * needs `destination-out`, which the standard `mask-composite` can't express) — see `getMaskCss`.
 */

const MASK_DEF_PREFIX = "orreris-mask-";

let maskCounter = 0;
/** Stable-ish unique id for a new mask. */
export function newMaskId(): string {
  maskCounter += 1;
  return `mask_${Date.now().toString(36)}_${maskCounter.toString(36)}`;
}
function newPointId(): string {
  maskCounter += 1;
  return `mp_${Date.now().toString(36)}_${maskCounter.toString(36)}`;
}

export function maskDefId(layerId: string, maskId: string): string {
  return `${MASK_DEF_PREFIX}${layerId}-${maskId}`;
}

/** A mask actually paints something only when enabled and it has a usable outline. */
export function isRenderableMask(mask: Mask): boolean {
  return mask.enabled && mask.points.length >= 2;
}

export function layerHasMasks(layer: { masks?: Mask[] | undefined }): boolean {
  return Array.isArray(layer.masks) && layer.masks.some(isRenderableMask);
}

// --- Keyframe evaluation (scalar props + path) ---------------------------------------------------
// Mask scalar props (feather/expansion/opacity/transform) keyframe through the layer `animations`
// array with `scope: "mask"` + `maskId`; the outline path keyframes through `mask.pathKeyframes`
// (point arrays aren't `AnimatedValue`). Both are evaluated here so preview AND export resolve masks
// identically at any time — the same parity contract the rest of the renderer follows.

/** The static base value of a keyframeable mask scalar (used when no keyframe overrides it). */
export function getMaskScalarBase(mask: Mask, property: MaskScalarProperty): number {
  switch (property) {
    case "feather":
      return mask.feather;
    case "expansion":
      return mask.expansion;
    case "opacity":
      return mask.opacity;
    case "transform.x":
      return mask.transform.x;
    case "transform.y":
      return mask.transform.y;
    case "transform.scaleX":
      return mask.transform.scaleX;
    case "transform.scaleY":
      return mask.transform.scaleY;
    case "transform.rotation":
      return mask.transform.rotation;
    default:
      return 0;
  }
}

/** Effective value of a mask scalar at a layer-local time, honouring `scope: "mask"` keyframes. */
export function evaluateMaskScalar(
  animations: TimelineKeyframeV2[] | undefined,
  maskId: string,
  property: MaskScalarProperty,
  baseValue: number,
  timeSeconds: number
): number {
  const keyframes = (animations ?? []).filter(
    (kf) => kf.target.scope === "mask" && kf.target.maskId === maskId && kf.target.property === property
  );
  if (!keyframes.length) return baseValue;
  return evaluateAnimatedValue({ baseValue, keyframes, property, scope: "mask", timeSeconds });
}

function pathEase(progress: number, interpolation: MaskPathKeyframe["interpolation"]): number {
  const t = Math.max(0, Math.min(1, progress));
  switch (interpolation) {
    case "hold":
      return 0;
    case "easeIn":
      return t * t;
    case "easeOut":
      return t * (2 - t);
    case "ease":
    case "easeInOut":
    case "bezier":
    case "autoBezier":
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    default:
      return t;
  }
}

function lerpPoint(a: MaskPoint, b: MaskPoint, t: number): MaskPoint {
  const lerp = (x: number, y: number) => x + (y - x) * t;
  const point: MaskPoint = { id: a.id, x: lerp(a.x, b.x), y: lerp(a.y, b.y) };
  if (a.inTangent || b.inTangent) {
    point.inTangent = {
      x: lerp(a.inTangent?.x ?? 0, b.inTangent?.x ?? 0),
      y: lerp(a.inTangent?.y ?? 0, b.inTangent?.y ?? 0)
    };
  }
  if (a.outTangent || b.outTangent) {
    point.outTangent = {
      x: lerp(a.outTangent?.x ?? 0, b.outTangent?.x ?? 0),
      y: lerp(a.outTangent?.y ?? 0, b.outTangent?.y ?? 0)
    };
  }
  if (a.lockedTangents) point.lockedTangents = a.lockedTangents;
  return point;
}

/** Outline points of a mask at a layer-local time. Interpolates `pathKeyframes` when point counts
 *  match (holds otherwise — the MVP rule), else falls back to the static `points`. */
export function getMaskPathAtTime(mask: Mask, timeSeconds: number): MaskPoint[] {
  const kfs = mask.pathKeyframes;
  if (!kfs || kfs.length === 0) return mask.points;
  const sorted = [...kfs].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const first = sorted[0]!;
  if (timeSeconds <= first.timeSeconds) return first.points;
  const last = sorted[sorted.length - 1]!;
  if (timeSeconds >= last.timeSeconds) return last.points;
  const nextIndex = sorted.findIndex((kf) => kf.timeSeconds >= timeSeconds);
  const prev = sorted[Math.max(0, nextIndex - 1)]!;
  const next = sorted[nextIndex]!;
  if (prev.points.length !== next.points.length) return prev.points; // counts differ → hold
  const duration = Math.max(0.0001, next.timeSeconds - prev.timeSeconds);
  const t = pathEase((timeSeconds - prev.timeSeconds) / duration, prev.interpolation);
  return prev.points.map((point, index) => lerpPoint(point, next.points[index]!, t));
}

/** A copy of the mask with all keyframeable values resolved at a layer-local time. */
export function resolveMaskAtTime(
  mask: Mask,
  animations: TimelineKeyframeV2[] | undefined,
  timeSeconds: number
): Mask {
  return {
    ...mask,
    points: getMaskPathAtTime(mask, timeSeconds),
    feather: evaluateMaskScalar(animations, mask.id, "feather", mask.feather, timeSeconds),
    expansion: evaluateMaskScalar(animations, mask.id, "expansion", mask.expansion, timeSeconds),
    opacity: evaluateMaskScalar(animations, mask.id, "opacity", mask.opacity, timeSeconds),
    transform: {
      x: evaluateMaskScalar(animations, mask.id, "transform.x", mask.transform.x, timeSeconds),
      y: evaluateMaskScalar(animations, mask.id, "transform.y", mask.transform.y, timeSeconds),
      scaleX: evaluateMaskScalar(animations, mask.id, "transform.scaleX", mask.transform.scaleX, timeSeconds),
      scaleY: evaluateMaskScalar(animations, mask.id, "transform.scaleY", mask.transform.scaleY, timeSeconds),
      rotation: evaluateMaskScalar(animations, mask.id, "transform.rotation", mask.transform.rotation, timeSeconds)
    }
  };
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

function bounds(points: MaskPoint[]): Bounds {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, rx: (maxX - minX) / 2, ry: (maxY - minY) / 2 };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** SVG path `d` for a mask outline (layer-local comp-px). Ellipse uses its bounds; others are polylines
 *  through the points (Phase 2 swaps in cubic segments from point tangents for true Bezier). */
export function maskShapeToPathD(mask: Mask): string {
  const pts = mask.points;
  if (pts.length < 2) return "";

  if (mask.shape === "ellipse") {
    const b = bounds(pts);
    if (b.rx <= 0 || b.ry <= 0) return "";
    return [
      `M ${round(b.minX)} ${round(b.cy)}`,
      `A ${round(b.rx)} ${round(b.ry)} 0 1 0 ${round(b.maxX)} ${round(b.cy)}`,
      `A ${round(b.rx)} ${round(b.ry)} 0 1 0 ${round(b.minX)} ${round(b.cy)}`,
      "Z"
    ].join(" ");
  }

  const hasTangents = (mask.shape === "bezier" || mask.shape === "polygon") && pts.some((p) => p.inTangent || p.outTangent);
  if (hasTangents) {
    let d = `M ${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
    for (let i = 0; i < pts.length; i += 1) {
      const cur = pts[i]!;
      const next = pts[(i + 1) % pts.length]!;
      const c1x = cur.x + (cur.outTangent?.x ?? 0);
      const c1y = cur.y + (cur.outTangent?.y ?? 0);
      const c2x = next.x + (next.inTangent?.x ?? 0);
      const c2y = next.y + (next.inTangent?.y ?? 0);
      d += ` C ${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(next.x)} ${round(next.y)}`;
    }
    return `${d} Z`;
  }

  // rectangle / polygon / bezier-without-tangents → closed polyline through the actual points
  // (independent corner editing makes a "rectangle" a free quad, like pro editors).
  if (mask.shape === "rectangle" && (mask.cornerRadius ?? 0) > 0) {
    return roundedPolygonPathD(pts, mask.cornerRadius!);
  }
  let d = `M ${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
  for (let i = 1; i < pts.length; i += 1) d += ` L ${round(pts[i]!.x)} ${round(pts[i]!.y)}`;
  return `${d} Z`;
}

/** Point on the edge FROM `from` TOWARD `to`, at `distance` px (clamped to the edge's midpoint). */
function edgePoint(from: MaskPoint, to: MaskPoint, distancePx: number): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.min(distancePx, len / 2) / len;
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/**
 * Closed polygon path with each corner rounded by a quadratic Bezier cut at `radiusPx` — works on any
 * point count (used today for the rectangle mask's 4-point quad, which may be a free, non-axis-aligned
 * quad per the independent-corner-editing note above, so this can't rely on a plain SVG `rx`).
 */
function roundedPolygonPathD(pts: MaskPoint[], radiusPx: number): string {
  const n = pts.length;
  if (n < 3) {
    let d = `M ${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
    for (let i = 1; i < n; i += 1) d += ` L ${round(pts[i]!.x)} ${round(pts[i]!.y)}`;
    return `${d} Z`;
  }
  const inward: { x: number; y: number }[] = []; // point on the incoming edge, `radiusPx` before each corner
  const outward: { x: number; y: number }[] = []; // point on the outgoing edge, `radiusPx` after each corner
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    inward.push(edgePoint(cur, prev, radiusPx));
    outward.push(edgePoint(cur, next, radiusPx));
  }
  let d = `M ${round(inward[0]!.x)} ${round(inward[0]!.y)}`;
  for (let i = 0; i < n; i += 1) {
    d += ` Q ${round(pts[i]!.x)} ${round(pts[i]!.y)} ${round(outward[i]!.x)} ${round(outward[i]!.y)}`;
    const nextIn = inward[(i + 1) % n]!;
    d += ` L ${round(nextIn.x)} ${round(nextIn.y)}`;
  }
  return `${d} Z`;
}

/** The SVG `transform` string for a mask's own transform (identity by default; reserved for keyframes). */
function maskTransformAttr(mask: Mask): string {
  const t = mask.transform;
  const b = bounds(mask.points);
  const parts: string[] = [];
  if (t.x || t.y) parts.push(`translate(${round(t.x)} ${round(t.y)})`);
  if (t.rotation) parts.push(`rotate(${round(t.rotation)} ${round(b.cx)} ${round(b.cy)})`);
  if (t.scaleX !== 1 || t.scaleY !== 1) {
    parts.push(`translate(${round(b.cx)} ${round(b.cy)}) scale(${round(t.scaleX)} ${round(t.scaleY)}) translate(${round(-b.cx)} ${round(-b.cy)})`);
  }
  return parts.join(" ");
}

/**
 * Builds the `<svg><defs>…</defs></svg>` markup carrying one `<mask>` (+ feather/expansion `<filter>`) per
 * renderable mask on the layer. Injected once per layer in both renderers. Returns "" when nothing to do.
 */
export function buildMaskDefsSvg(
  layer: {
    id: string;
    masks?: Mask[] | undefined;
    effects?: unknown[] | undefined;
    startSeconds?: number | undefined;
    animations?: TimelineKeyframeV2[] | undefined;
  },
  options: { width: number; height: number; currentTimeSeconds?: number | undefined }
): string {
  // Defs cover the layer's own (clip) masks AND any effect-level (region) masks, so a backdrop-filter
  // overlay's `mask: url(#…)` resolves to the same stencil in both renderers. Ids are unique per mask.
  const effectMasks = (layer.effects ?? []).flatMap((effect) => {
    const masks = (effect as { masks?: Mask[] | undefined } | null)?.masks;
    return Array.isArray(masks) ? masks : [];
  });
  // Frames (see FRAMES.md): a `layer.frame` becomes the BASE clip mask, inscribed in the comp box, so
  // its media clips to the frame outline through this same pixel-gated mask pipeline (no new clip code).
  const frameMask = frameClipMask(layer as { id: string; frame?: LayerFrame | undefined }, { width: options.width, height: options.height });
  const renderable = [...(frameMask ? [frameMask] : []), ...(layer.masks ?? []), ...effectMasks].filter(isRenderableMask);
  if (!renderable.length) return "";
  const { width, height } = options;

  // Resolve keyframed scalars/path at the current time so preview & export agree (static when no time).
  const masks =
    typeof options.currentTimeSeconds === "number"
      ? renderable.map((mask) =>
          resolveMaskAtTime(mask, layer.animations, Math.max(0, options.currentTimeSeconds! - (layer.startSeconds ?? 0)))
        )
      : renderable;

  const defs = masks
    .map((mask) => {
      const id = maskDefId(layer.id, mask.id);
      const d = maskShapeToPathD(mask);
      if (!d) return "";
      const transform = maskTransformAttr(mask);
      const opacity = Math.max(0, Math.min(1, mask.opacity / 100));

      // ALPHA matte: opaque (α=1) where the mask REVEALS, transparent (α=0) where it HIDES — for both
      // non-inverted and inverted (invert = punch the shape out of a full-frame flood). `mask-type="alpha"`
      // so transparent is unambiguously hidden (no luminance "unpainted = visible" quirk), and so multiple
      // masks composite cleanly via CSS mask-composite (Porter-Duff over consistent alpha layers).
      const prim: string[] = [];
      let last = "SourceAlpha"; // start from the shape's coverage (its own alpha)
      if (mask.expansion > 0) {
        prim.push(`<feMorphology in="${last}" operator="dilate" radius="${round(mask.expansion)}" result="m0"/>`);
        last = "m0";
      } else if (mask.expansion < 0) {
        prim.push(`<feMorphology in="${last}" operator="erode" radius="${round(-mask.expansion)}" result="m0"/>`);
        last = "m0";
      }
      if (mask.feather > 0) {
        prim.push(`<feGaussianBlur in="${last}" stdDeviation="${round(mask.feather / 2)}" result="m1"/>`);
        last = "m1";
      }
      if (mask.inverted) {
        // white frame MINUS the shape → opaque outside / transparent inside
        prim.push(`<feFlood flood-color="white" flood-opacity="1" result="flood"/>`);
        prim.push(`<feComposite in="flood" in2="${last}" operator="out" result="inv"/>`);
        last = "inv";
      }
      if (opacity < 1) {
        prim.push(`<feComponentTransfer in="${last}"><feFuncA type="linear" slope="${round(opacity)}"/></feComponentTransfer>`);
      } else if (last !== "SourceAlpha" || mask.inverted) {
        // ensure the chained result is what gets painted (last primitive with no result = filter output)
        prim.push(`<feComponentTransfer in="${last}"><feFuncA type="identity"/></feComponentTransfer>`);
      }
      // Filter region = full comp (userSpaceOnUse) so the invert flood covers the whole frame.
      const filterId = `${id}-fx`;
      const filterDef = prim.length
        ? `<filter id="${filterId}" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">${prim.join("")}</filter>`
        : "";
      const filterRef = prim.length ? ` filter="url(#${filterId})"` : "";

      const groupOpen = `<g${transform ? ` transform="${transform}"` : ""}${filterRef}>`;
      const shape = `<path d="${d}" fill="white"/>`;

      return (
        `${filterDef}` +
        `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" mask-type="alpha">` +
        `${groupOpen}${shape}</g></mask>`
      );
    })
    .join("");

  if (!defs) return "";
  return `<svg width="0" height="0" style="position:absolute;width:0;height:0;pointer-events:none" aria-hidden="true"><defs>${defs}</defs></svg>`;
}

// Porter-Duff keyword per mode for `-webkit-mask-composite`. The mode-bearing mask is the *source* and the
// running accumulation (the masks above it in the panel) is the *destination* — see getMaskCss for why the
// CSS layer order is reversed. `subtract` MUST be `destination-out` (destination ∩ ¬source = keep the base,
// punch out this shape); `source-out` would instead keep this shape minus the base and discard the base.
const WEBKIT_COMPOSITE: Record<MaskMode, string> = {
  add: "source-over",
  subtract: "destination-out",
  intersect: "source-in",
  exclude: "xor"
};

/**
 * CSS referencing a set of mask defs (by `maskDefId(layerId, mask.id)`). Returns `{}` when there are no
 * renderable masks. Shared by clip masks (the whole layer) and effect-region masks (a backdrop-filter overlay).
 *
 * Compositing model (Chromium-only — both the web preview and the Remotion export are Blink):
 * CSS composites each mask layer as the *source* against the layers *below* it (later in the list) as the
 * *destination*, accumulating bottom→top. We want the panel's top→bottom semantics
 * `R0 = base; Rk = R(k-1) <mode_k> Mk`, so we **reverse** the layer list (base becomes the bottom/last entry)
 * and drive compositing with `-webkit-mask-composite` only: the base is `source-over` (just placed), and every
 * other mask uses {@link WEBKIT_COMPOSITE} for its mode against the running accumulation below it. The standard
 * `mask-composite` is intentionally NOT emitted — it can't express `destination-out`, which Subtract needs.
 */
export function getMaskCss(layerId: string, masks: Mask[] | undefined): Record<string, string> {
  const renderable = (masks ?? []).filter(isRenderableMask);
  if (!renderable.length) return {};
  // Reverse so the panel base (index 0) is the bottom/last CSS layer; the panel-bottom mask is first/top.
  const ordered = [...renderable].reverse();
  const lastIndex = ordered.length - 1; // the base (panel index 0) after reversing
  const images = ordered.map((mask) => `url(#${maskDefId(layerId, mask.id)})`).join(", ");
  const webkitComposite = ordered
    .map((mask, index) => (index === lastIndex ? "source-over" : WEBKIT_COMPOSITE[mask.mode]))
    .join(", ");
  const repeat = ordered.map(() => "no-repeat").join(", ");
  // No `maskMode` — the referenced <mask> declares `mask-type="alpha"`, and forcing CSS mask-mode would
  // override that. Compositing is webkit-only (see above); standard `mask-composite` is deliberately omitted.
  return {
    maskImage: images,
    maskRepeat: repeat,
    WebkitMaskImage: images,
    WebkitMaskRepeat: repeat,
    WebkitMaskComposite: webkitComposite
  };
}

/** Clip-level mask CSS for a whole layer (applied to the media element). Wraps {@link getMaskCss}.
 *  A `layer.frame` contributes its BASE clip-mask REF here (the geometry def comes from buildMaskDefsSvg);
 *  the deterministic {@link frameMaskId} keeps ref + def in sync, so no comp dims are needed for the ref. */
export function getCompositionMaskCss(layer: { id: string; masks?: Mask[] | undefined; frame?: LayerFrame | undefined }): Record<string, string> {
  const frameMask = frameClipMask(layer);
  const masks = frameMask ? [frameMask, ...(layer.masks ?? [])] : layer.masks;
  return getMaskCss(layer.id, masks);
}

/**
 * Comp-space mask WRAPPER style for a content-sized overlay (text/shape). Media masks directly on its
 * comp-sized element, so the `userSpaceOnUse` (comp-px) mask aligns; text/shape are content-sized, so the
 * clip mask must instead live on a comp-sized, transform-less wrapper for those coords to align — and to
 * stay fixed in comp space, matching the GPU scene compositor (which samples the matte at `gl_FragCoord`,
 * i.e. comp space, independent of the layer transform). The wrapper is `pointer-events:none` so it doesn't
 * swallow clicks across the whole comp; the inner element re-enables pointer events. Returns `null` when the
 * layer has no renderable masks (render the overlay directly — no wrapper, no behavior change).
 */
export function getOverlayMaskWrapperStyle(layer: { id: string; masks?: Mask[] | undefined }): Record<string, string> | null {
  const maskCss = getCompositionMaskCss(layer);
  if (!Object.keys(maskCss).length) return null;
  return { position: "absolute", inset: "0", pointerEvents: "none", ...maskCss };
}

// --- Effect-region masks for color/glow: render-time duplicate-layer expansion -------------------
//
// Color/glow effects can't use the blur backdrop-filter trick (they run through the WebGL/SVG color
// pipeline). Instead, at RENDER time we split a media layer that carries a region mask on such an effect into:
//   • a base clone with those region effects removed (ungraded outside the region), and
//   • one duplicate clone per region effect — that effect applied globally + the region masks attached as the
//     duplicate's CLIP masks, stacked just above the base.
// Because clip masks + per-layer color/effects already render in EVERY renderer (preview, Remotion, local
// export), region color/glow then works everywhere with no new compositor. Blur keeps its backdrop-filter path
// (its masked effect stays on the base), so this is purely additive. Render-only — never mutate editor state.

/**
 * Effects eligible for region masking via duplicate-layer expansion: the color pipeline (`COLOR_EFFECT_TYPES`)
 * plus `blur` (a CSS filter on the duplicate). Glow is intentionally excluded — its outward bloom must extend
 * beyond the mask, which a region clip mask would clip; glow stays a whole-clip effect until a bloom-preserving
 * implementation lands.
 */
function isRegionEffectType(type: string): boolean {
  return COLOR_EFFECT_TYPES.has(type) || type === "blur";
}

/**
 * Effect types that render through the scene compositor's per-effect fragment-pass harness
 * (`buildFragmentPasses` in scene/build-scene-draws.ts), which natively honours a per-effect `masks`
 * list by building its own matte. So an adjustment layer's clip masks CAN confine these (stamped in
 * `effectsWithLayerRegionMask` below), and region expansion must never strip their masks — no
 * duplicate-layer clone is needed. Keep the list in lockstep with `color/fragment-effects/builtins.ts`.
 */
export const FRAGMENT_PASS_EFFECT_TYPES = new Set([
  "radialBlur",
  "directionalBlur",
  "sharpen",
  "pixelate",
  "chromaticAberration",
  "sketch",
  "oldTv",
  "glitchFx",
  "halftone",
  "posterize",
  "stylize"
]);

/** True for effects whose masks the fragment-pass harness applies itself (builtins + user GLSL). */
export function isFragmentPassEffectType(type: string): boolean {
  return FRAGMENT_PASS_EFFECT_TYPES.has(type) || type === "pluginShader";
}

function effectHasRenderableMask(effect: TimelineEffect): boolean {
  return Array.isArray(effect.masks) && effect.masks.some(isRenderableMask);
}

/**
 * Stamps an adjustment layer's own clip masks onto its maskable effects, so that when those effects are
 * merged into the layers below (`applyActiveAdjustmentEffects` / `mergedLayer`) they stay confined to the
 * adjustment layer's mask shape instead of hitting the whole frame. Two mask machineries apply:
 * region-eligible effects (color/blur) go through the effect-region expansion / scene region passes
 * (`expandLayerEffectRegions` et al), while fragment-pass effects (radial/directional blur, pixelate,
 * stylize, custom shaders, …) carry their masks straight into `buildFragmentPasses`, which mattes them
 * itself. Effect types in neither camp (glow) ride along unchanged — an adjustment layer's mask simply
 * doesn't constrain those, same limitation as any other layer's effect masks.
 */
export function effectsWithLayerRegionMask(layer: { masks?: Mask[] | undefined; effects: TimelineEffect[] }): TimelineEffect[] {
  const masks = (layer.masks ?? []).filter(isRenderableMask);
  if (!masks.length) return layer.effects;
  return layer.effects.map((effect) =>
    isRegionEffectType(effect.type) || isFragmentPassEffectType(effect.type)
      ? { ...effect, masks: [...(effect.masks ?? []), ...masks] }
      : effect
  );
}

/**
 * True if a visual layer has at least one color/blur effect limited to a region (so it needs expansion).
 * Applies to media AND text/shape: the duplicate-layer cascade below works for any layer whose grade + clip
 * mask render, which text/shape do (Phase 4.1c). Adjustment layers are excluded — they have no content to
 * region-mask (a region adjustment would need to clip the whole stack below, not this layer).
 */
export function hasRegionColorEffect(layer: TimelineLayer): boolean {
  return (
    (layer.type === "video" || layer.type === "image" || layer.type === "text" || layer.type === "shape") &&
    layer.effects.some((effect) => isRegionEffectType(effect.type) && effectHasRenderableMask(effect))
  );
}

/**
 * Expand one layer into [base, ...cascaded duplicates], or return [layer] unchanged when it has no region
 * color/blur effect. Region effects **cascade** in effects-panel order: each duplicate applies all region
 * effects up to and including itself (so a blur region nested in a color region shows color+blur), clipped to
 * its own region. Non-region effects ride along on every clone (masks stripped) so the whole clip keeps its
 * overall look.
 */
export function expandLayerEffectRegions(layer: TimelineLayer): TimelineLayer[] {
  if (!hasRegionColorEffect(layer)) return [layer];
  const regionEffects = layer.effects.filter((e) => isRegionEffectType(e.type) && effectHasRenderableMask(e));
  // Fragment-pass effects keep their masks — buildFragmentPasses mattes them per-effect, so stripping here
  // would silently un-mask e.g. a masked radial blur whenever the layer ALSO carries a region color effect.
  const strip = (e: TimelineEffect): TimelineEffect => (isFragmentPassEffectType(e.type) ? e : { ...e, masks: undefined });
  // Everything that isn't a region effect, applied globally on every clone (a leftover masked glow rides here
  // mask-stripped so it still glows on the whole clip).
  const globals = layer.effects.filter((e) => !regionEffects.includes(e)).map(strip);
  const base: TimelineLayer = { ...layer, effects: globals };
  const clipMasks = layer.masks ?? [];
  const duplicates = regionEffects.map((effect, index) => {
    const regionMasks = effect.masks ?? [];
    // Confine the effect to `clip ∩ region`, NOT `clip ∪ region`. The CLIP masks lead and compose by their own
    // modes into the clip compound C (so a COMPOUND clip — e.g. blob ∪ rect, plus holes/invert — is built
    // intact); the region masks are then appended with the first forced to `intersect`, so the region group
    // binds onto C by intersection (C ∩ region0 [then the region's other modes]). Clip-first matters: a
    // region-first order would let a union clip mask (e.g. the `rect`) OR its whole area back in after the
    // intersect → the effect leaks across it. Exact for compound clips, a single region, and a region with a
    // carved hole. (Only multiple separate `add` regions on ONE effect + a clip mask stays approximate — flat
    // mask lists can't express `C ∩ (r0 ∪ r1)`; that needs the deferred nesting / Method 3.)
    const masks = clipMasks.length
      ? [...clipMasks, ...regionMasks.map((m, i) => (i === 0 ? { ...m, mode: "intersect" as MaskMode } : m))]
      : [...regionMasks];
    return {
      ...layer,
      id: `${layer.id}__rfx_${effect.id}`,
      // Each region effect is INDEPENDENT: this clone applies ONLY its own region effect, in ONLY its own
      // region (+ the whole-clip globals every clone shares). Region effects do NOT inherit each other — that
      // cross-effect merge was the ROOT of the leak (a blur "region" whose mask was stripped and re-applied
      // across another effect's whole region). Where two regions overlap, the clones simply stack in panel
      // order, so the top region effect wins its area — no bleed. (Correctly COMBINING two effects in an
      // overlap for any geometry needs per-effect masked post-composite passes — see the region-effect
      // pass model in todo.md — which this flat one-mask-per-clone model can't express.)
      effects: [...globals, strip(effect)],
      masks
    };
  });
  return [base, ...duplicates]; // base below; each duplicate stacks above, the last carrying the full stack
}

/** Composition-wide {@link expandLayerEffectRegions}. Returns the same object when nothing expands. */
export function expandEffectRegionMasks(composition: TimelineComposition): TimelineComposition {
  let changed = false;
  const tracks = composition.tracks.map((track) => {
    if (!track.layers.some(hasRegionColorEffect)) return track;
    changed = true;
    return { ...track, layers: track.layers.flatMap(expandLayerEffectRegions) };
  });
  return changed ? { ...composition, tracks } : composition;
}

/**
 * Region-blur clones ({@link expandLayerEffectRegions} produces `${baseId}__rfx_${effectId}`) whose ONLY
 * effects beyond their base are `blur` render pixel-identical MEDIA to the base — blur is a GPU compositor
 * pass here, NOT baked into the color grade — so the clone can reuse the base's already-graded frame instead
 * of decoding + grading a second copy of the same source. Both the editor preview and the local export MUST
 * alias these clones the same way, or the two diverge: the viewer (which aliases) shows the masked blur while
 * the export/proxy (which decoded the clone independently) can drop it whenever that second decoder fails or
 * isn't ready — the reported "no blur in the proxy" bug. Aliasing also removes a decoder + GL context per
 * clone (the context-budget win) and keeps the clone frame-synced to the base (no second decoder to drift).
 *
 * A clone that adds a region COLOR grade over its base genuinely needs its own graded frame, so it is NOT
 * aliased. `layers` MUST be the EXPANDED + adjustment-merged layer list both renderers build (the base and
 * clone carry the same merged adjustment effects, so those cancel and only the region effects remain "extra").
 * Returns a map of clone layer id → base layer id.
 */
export function buildRegionBlurCloneAliases(layers: readonly TimelineLayer[]): Map<string, string> {
  const map = new Map<string, string>();
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  for (const layer of layers) {
    const sep = layer.id.indexOf("__rfx_");
    if (sep < 0 || (layer.type !== "video" && layer.type !== "image")) continue;
    const baseId = layer.id.slice(0, sep);
    const base = byId.get(baseId);
    if (!base) continue;
    const baseEffectIds = new Set(base.effects.map((effect) => effect.id));
    const extra = layer.effects.filter((effect) => !baseEffectIds.has(effect.id));
    if (extra.length > 0 && extra.every((effect) => effect.type === "blur")) {
      map.set(layer.id, baseId);
    }
  }
  return map;
}

// --- Factories used by the preview drawing tools -------------------------------------------------

function rectPoints(x0: number, y0: number, x1: number, y1: number): MaskPoint[] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  return [
    { id: newPointId(), x: minX, y: minY },
    { id: newPointId(), x: maxX, y: minY },
    { id: newPointId(), x: maxX, y: maxY },
    { id: newPointId(), x: minX, y: maxY }
  ];
}

export function createMask(shape: MaskShape, points: MaskPoint[], name: string): Mask {
  return {
    id: newMaskId(),
    name,
    enabled: true,
    shape,
    mode: "add",
    source: "manual",
    points,
    feather: 0,
    expansion: 0,
    opacity: 100,
    inverted: false,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }
  };
}

/** Rectangle/ellipse mask from a drag box (layer-local comp-px). */
export function createBoxMask(shape: "rectangle" | "ellipse", x0: number, y0: number, x1: number, y1: number, index: number): Mask {
  return createMask(shape, rectPoints(x0, y0, x1, y1), `${shape === "ellipse" ? "Ellipse" : "Rectangle"} ${index}`);
}

/**
 * The centered rect a `contain` source actually paints into (layer-local comp px) — the comp box
 * shrunk on one axis to the source's natural aspect. Null when unknown or effectively full-frame.
 * Used to size default masks (and anything else that should hug the CONTENT, not the comp box —
 * e.g. a letterboxed vector graphic).
 */
export function containContentRect(
  compWidth: number,
  compHeight: number,
  sourceAspect: number | undefined
): { x: number; y: number; width: number; height: number } | null {
  if (!sourceAspect || sourceAspect <= 0 || compWidth <= 0 || compHeight <= 0) return null;
  const frameAspect = compWidth / compHeight;
  let w = compWidth;
  let h = compHeight;
  if (sourceAspect > frameAspect) h = compWidth / sourceAspect;
  else w = compHeight * sourceAspect;
  if (w / compWidth >= 0.999 && h / compHeight >= 0.999) return null;
  return { x: (compWidth - w) / 2, y: (compHeight - h) / 2, width: w, height: h };
}

/**
 * A centered default mask, for the "+ Rectangle/Ellipse" inspector buttons / Shift+M. Covers ~60%
 * of the comp — or, when `contentRect` is passed (a `contain` layer's painted rect, see
 * {@link containContentRect}), hugs that rect instead so the default mask lands ON the artwork.
 */
export function createDefaultMask(
  shape: "rectangle" | "ellipse",
  width: number,
  height: number,
  index: number,
  contentRect?: { x: number; y: number; width: number; height: number } | null
): Mask {
  if (contentRect) {
    return createBoxMask(shape, contentRect.x, contentRect.y, contentRect.x + contentRect.width, contentRect.y + contentRect.height, index);
  }
  const mw = width * 0.6;
  const mh = height * 0.6;
  const x0 = (width - mw) / 2;
  const y0 = (height - mh) / 2;
  return createBoxMask(shape, x0, y0, x0 + mw, y0 + mh, index);
}

/** Regular polygon points inscribed in a centered ellipse covering ~58% of the comp. */
function regularPolygonPoints(width: number, height: number, sides: number): MaskPoint[] {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width * 0.29;
  const ry = height * 0.29;
  const points: MaskPoint[] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = -Math.PI / 2 + (i / sides) * Math.PI * 2; // start at top
    points.push({ id: newPointId(), x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  }
  return points;
}

/** A centered default polygon (pentagon by default) for the "+ Polygon" inspector button. */
export function createDefaultPolygonMask(width: number, height: number, index: number, sides = 5): Mask {
  return createMask("polygon", regularPolygonPoints(width, height, sides), `Polygon ${index}`);
}

/** A centered default smooth Bezier blob (auto-tangented circle) for the "+ Pen" inspector button. */
export function createDefaultBezierMask(width: number, height: number, index: number): Mask {
  const points = regularPolygonPoints(width, height, 4);
  return createMask("bezier", withAutoTangents(points), `Pen ${index}`);
}

/** Give each point smooth in/out tangents derived from its neighbours (Catmull-Rom-ish), making a
 *  polygon point set into a smooth closed Bezier. Used by the Pen default + the "smooth point" action. */
export function withAutoTangents(points: MaskPoint[], smoothness = 0.33): MaskPoint[] {
  const n = points.length;
  if (n < 3) return points.map((p) => ({ ...p }));
  return points.map((point, index) => {
    const prev = points[(index - 1 + n) % n]!;
    const next = points[(index + 1) % n]!;
    const dx = (next.x - prev.x) * smoothness;
    const dy = (next.y - prev.y) * smoothness;
    return {
      ...point,
      inTangent: { x: -dx, y: -dy },
      outTangent: { x: dx, y: dy },
      lockedTangents: true
    };
  });
}

export { newPointId };
