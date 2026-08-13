import { evaluateAnimatedValue, evaluateTimelineEffectParam, evaluateTimelineTransform } from "./animation";
import type { VisibleContribution } from "./kernel/admission";
import { frameProfiler } from "./color/frame-profiler";
import { COLOR_EFFECT_TYPES, compileColorPipeline, LEGACY_PROJECT_COLOR_SETTINGS, lut3dFromBase64, NEUTRAL_SECONDARY, pipelineToSvgFilter, type ChannelCurves, type ColorEffectInput, type ColorPipeline, type ColorWheels, type CurvePoint, type HslSecondary, type HueSatCurves, type Lut3d, type MediaEffects, type ProjectColorSettings, type SvgColorFilter } from "./color";
import { applyTransitionEasing, getTransition, resolveTransitionParams, type TransitionDefinition } from "./color";
import { getCompositionMaskCss, getMaskCss, isRenderableMask } from "./clip-masks";
import { detectTextScript } from "./text-script";
import type { BlendMode, LayerContentTransform, Mask, MaskPoint, ShapeKind, SourceTextKeyframe, TextRun, TextWarp, TimelineEffect, TimelineKeyframe, TimelineKeyframeV2, TimelineLayer, TransitionDirection, TransitionSpec } from "./types";

export interface CompositionTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  rotateX: number;
  rotateY: number;
  perspective: number;
  z: number;
  /** Anchor point (D3): rotate/scale/tilt pivot, percent of the element box. Absent = 50/50 center
   *  (today's behavior — every consumer's no-anchor path stays byte-identical). */
  anchorX?: number | undefined;
  anchorY?: number | undefined;
}

export interface CompositionLayerStyleInput {
  id?: string | undefined;
  startSeconds?: number | undefined;
  transform?: unknown;
  keyframes?: TimelineKeyframe[] | unknown[] | undefined;
  animations?: TimelineKeyframeV2[] | unknown[] | undefined;
  style?: Record<string, unknown> | undefined;
  color?: string | undefined;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  fontWeight?: number | undefined;
  italic?: boolean | undefined;
  letterSpacing?: number | undefined;
  lineHeight?: number | undefined;
  textWidthPercent?: number | undefined;
  textAlign?: "left" | "center" | "right" | "start" | "end" | string | undefined;
  direction?: "auto" | "ltr" | "rtl" | undefined;
  /**
   * The layer's own text, needed here only so `"auto"` can be RESOLVED at style-resolution time
   * (ADR-023 T-13 as corrected). It is not a style field and is not in the manifest style bag — the
   * manifest carries `text`/`textRuns` at the layer's top level, which is what both renderers hand
   * to `getCompositionTextStyle`.
   */
  text?: string | undefined;
  textRuns?: TextRun[] | undefined;
  textWarp?: TextWarp | undefined;
  fit?: "cover" | "contain" | "fill" | string | undefined;
  blendMode?: BlendMode | undefined;
  widthPercent?: number | undefined;
  heightPercent?: number | undefined;
  shapeKind?: ShapeKind | undefined;
  shapePath?: MaskPoint[] | undefined;
  borderRadius?: number | undefined;
  strokeColor?: string | undefined;
  strokeWidth?: number | undefined;
  strokePaintOrder?: "over" | "under" | undefined;
  backgroundColor?: string | undefined;
  backgroundPaddingEm?: number | undefined;
  backgroundRadiusEm?: number | undefined;
  shadowColor?: string | undefined;
  shadowBlur?: number | undefined;
  shadowOffsetX?: number | undefined;
  shadowOffsetY?: number | undefined;
  effects?: unknown[] | undefined;
  masks?: Mask[] | undefined;
}

export interface CompositionStyleOptions {
  currentTimeSeconds?: number | undefined;
  /**
   * R3.1 handle-aware window: how much of a junction transition's window falls BEFORE the cut (see
   * `resolveTransitionWindowSides`). Consumed by `getCompositionTransition` only; absent → centered.
   */
  transitionPrerollSeconds?: number | undefined;
  /**
   * When true, omit the SVG color filter reference from the returned style object.
   * Use this for layers rendered through `MediaWebGLRenderer` so the WebGL canvas
   * is the sole grading path and the underlying element is a clean source (no double-grade).
   */
  skipColorFilter?: boolean | undefined;
  /**
   * The composition's managed color settings (`composition.settings.color`). Defaults to
   * {@link LEGACY_PROJECT_COLOR_SETTINGS} — "not threaded" means "no project settings in hand", whose
   * only safe reading is today's shipped behaviour. Drives the pipeline's working space and the
   * effect stage's light.
   */
  colorSettings?: ProjectColorSettings | undefined;
}

export const compositionTextDefaults = {
  color: "#ffffff",
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: 64,
  fontWeight: 900,
  lineHeight: 0.95,
  maxWidthPercent: 86,
  paddingEmY: 0.08,
  paddingEmX: 0.16,
  borderRadiusEm: 0.1,
  // No background box by default — new text must be a clean overlay (user report 2026-07-03:
  // the old 14%-alpha tint read as an unwanted grey box behind every caption).
  backgroundColor: "transparent",
  shadowColor: "rgba(0,0,0,0.62)",
  shadowBlur: 19,
  shadowOffsetX: 0,
  shadowOffsetY: 7
} as const;

export const compositionShapeDefaults = {
  shapeKind: "rounded-rectangle" as ShapeKind,
  widthPercent: 44,
  heightPercent: 18,
  borderRadiusPx: 22,
  color: "#C9FF4A"
} as const;

export const compositionMediaDefaults = {
  fit: "cover"
} as const;

export const compositionFontFamilies = [
  compositionTextDefaults.fontFamily,
  "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
  "Georgia, 'Times New Roman', serif",
  "'Courier New', Courier, monospace"
] as const;

export const renderSafeFonts = [
  { label: "Arial", family: "Arial, Helvetica, sans-serif" },
  { label: "System", family: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { label: "Impact", family: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif" },
  { label: "Georgia", family: "Georgia, 'Times New Roman', serif" },
  { label: "Courier", family: "'Courier New', Courier, monospace" }
] as const;

export function getCompositionTransform(
  layer: Pick<CompositionLayerStyleInput, "startSeconds" | "transform" | "keyframes" | "animations"> | undefined,
  options: CompositionStyleOptions = {}
): CompositionTransform {
  frameProfiler.bump("grade.transform.calls"); // pure (no cache): allocates + evaluates keyframes every call
  const transform = asRecord(layer?.transform);
  const position = asRecord(transform.position);

  const anchor = asRecord(transform.anchor);
  const hasAnchor = transform.anchor !== undefined && transform.anchor !== null;
  const baseTransform = {
    position: {
      x: numberOr(position.x, 50),
      y: numberOr(position.y, 50)
    },
    scale: numberOr(transform.scale, 1),
    rotation: numberOr(transform.rotation, 0),
    opacity: numberOr(transform.opacity, 100),
    rotateX: numberOr(transform.rotateX, 0),
    rotateY: numberOr(transform.rotateY, 0),
    perspective: numberOr(transform.perspective, 0),
    z: numberOr(transform.z, 0),
    ...(hasAnchor ? { anchor: { x: numberOr(anchor.x, 50), y: numberOr(anchor.y, 50) } } : {})
  };
  const evaluated = evaluateTimelineTransform({
    transform: baseTransform,
    startSeconds: layer?.startSeconds,
    keyframes: layer?.keyframes as TimelineKeyframe[] | undefined,
    animations: layer?.animations as TimelineKeyframeV2[] | undefined,
    timeSeconds: options.currentTimeSeconds
  });

  return {
    x: evaluated.position.x,
    y: evaluated.position.y,
    scale: evaluated.scale,
    rotation: evaluated.rotation,
    opacity: evaluated.opacity,
    rotateX: evaluated.rotateX ?? 0,
    rotateY: evaluated.rotateY ?? 0,
    perspective: evaluated.perspective ?? 0,
    z: evaluated.z ?? 0,
    ...(evaluated.anchor ? { anchorX: evaluated.anchor.x, anchorY: evaluated.anchor.y } : {})
  };
}

export function getCompositionOpacity(layer: Pick<CompositionLayerStyleInput, "transform"> | undefined) {
  return getCompositionTransform(layer).opacity / 100;
}

export interface CompositionTransitionReveal {
  kind: "wipe" | "iris" | "dip";
  /** 0 → fully concealed (outgoing shows), 1 → fully revealed (incoming shows). */
  progress: number;
  direction: TransitionDirection;
  mode: "in" | "out";
  /** Soft-edge width (0..1 of the reveal axis/radius). */
  softness: number;
  /** Dip-through colour as linear rgb 0..1 (only for `dip`). */
  color?: [number, number, number] | undefined;
}

/**
 * The active GPU transition for a layer at `currentTimeSeconds`, or null. Only the shader kinds
 * (`wipe`/`iris`/`dip`) are returned — the opacity/geometry kinds (dissolve/slide/push/zoom) are
 * handled by keyframes. Progress is derived purely from time + the spec window, so all three
 * renderers compute it identically. Returns null once fully revealed (progress ≥ 1) so the rest of
 * the clip draws plainly.
 */
/**
 * The transition's EFFECTIVE window duration: the authored `spec.durationSeconds` clamped to the
 * incoming clip's own length so a start-aligned transition never runs PAST the clip it reveals. This
 * mirrors the keyframe path (`buildTransitionAnimations`, `Math.min(spec.durationSeconds,
 * layer.durationSeconds)`) so the GPU reveal and the keyframed kinds finish at the same instant. When
 * the clip duration is unknown (undefined), the authored duration is used unchanged.
 */
export function effectiveTransitionDuration(
  authoredSeconds: number,
  clipDurationSeconds?: number | undefined
): number {
  const authored = Math.max(1e-4, authoredSeconds);
  if (typeof clipDurationSeconds === "number" && clipDurationSeconds > 0) {
    return Math.min(authored, clipDurationSeconds);
  }
  return authored;
}

export function getCompositionTransition(
  layer: { startSeconds?: number | undefined; durationSeconds?: number | undefined; transitionIn?: TransitionSpec | undefined } | undefined,
  options: CompositionStyleOptions = {}
): CompositionTransitionReveal | null {
  const spec = layer?.transitionIn;
  const kind = spec?.kind;
  if (!spec || (kind !== "wipe" && kind !== "iris" && kind !== "dip")) {
    return null;
  }
  const t = options.currentTimeSeconds;
  if (typeof t !== "number") {
    return null;
  }
  const cut = layer?.startSeconds ?? 0;
  const duration = effectiveTransitionDuration(spec.durationSeconds, layer?.durationSeconds);
  // R3: Premiere-style centered-on-cut window [cut - D/2, cut + D/2] (was start-aligned [cut, cut+D] —
  // see `getActiveTransition`'s doc for the full rationale; this keyed-fade path shares the same model).
  // R3.1: handle-aware placement when the caller resolved the window sides (`transitionPrerollSeconds`).
  const start = cut - Math.max(0, Math.min(duration, options.transitionPrerollSeconds ?? duration / 2));
  const progress = (t - start) / duration;
  if (progress >= 1) {
    return null;
  }
  return {
    kind: kind as "dip" | "wipe" | "iris",
    progress: Math.max(0, Math.min(1, progress)),
    direction: spec.direction ?? "right",
    mode: spec.mode ?? "in",
    softness: Math.max(0, Math.min(1, spec.softness ?? 0.12)),
    color: kind === "dip" ? hexToRgb01(spec.color ?? "#000000") : undefined
  };
}

// ---------------------------------------------------------------------------
// Unified GPU transition engine — shared window detection + progress/param resolution.
// Used IDENTICALLY by web preview, browser export, and Remotion so the three stay pixel-aligned.
// ---------------------------------------------------------------------------

/** A touching same-track clip pair that carries a (registry) junction transition. */
export interface TransitionPair {
  outgoingId: string;
  incomingId: string;
  spec: TransitionSpec;
}

/** The active transition for a clip at a time: its definition, eased progress, and resolved params. */
export interface ActiveTransition {
  def: TransitionDefinition;
  transitionId: string;
  /** 0 → fully outgoing, 1 → fully incoming. ALREADY eased by the definition's curve. */
  progress: number;
  /** GLSL-ready param values (legacy direction/mode/softness/color folded in). */
  params: Record<string, number | number[] | boolean>;
}

interface TransitionLayerLike {
  id: string;
  trackId?: string | undefined;
  startSeconds?: number | undefined;
  durationSeconds?: number | undefined;
  transitionIn?: TransitionSpec | undefined;
  /** Compound clip marker (nesting) — consulted by `findTransitionPairsWithGroupJunctions` only. */
  nestedCompositionId?: string | undefined;
}

/** Map a legacy direction keyword to a unit vec2 in the engine's UV space (y up). */
function directionToVec2(dir: TransitionDirection): [number, number] {
  switch (dir) {
    case "left":
      return [-1, 0];
    case "right":
      return [1, 0];
    case "up":
      return [0, 1];
    case "down":
      return [0, -1];
    default:
      return [1, 0];
  }
}

/** Fold legacy `direction`/`mode`/`softness`/`color` fields into the def's named params (params win). */
function transitionOverrides(def: TransitionDefinition, spec: TransitionSpec): Record<string, number | number[] | boolean> {
  const out: Record<string, number | number[] | boolean> = { ...(spec.params ?? {}) };
  const has = (name: string) => def.params.some((p) => p.name === name);
  if (spec.direction && has("direction") && out.direction === undefined) {
    out.direction = directionToVec2(spec.direction);
  }
  if (spec.softness !== undefined && has("softness") && out.softness === undefined) {
    out.softness = spec.softness;
  }
  if (spec.mode === "out" && has("reverse") && out.reverse === undefined) {
    out.reverse = true;
  }
  if (spec.color !== undefined) {
    const rgb = hexToRgb01(spec.color);
    for (const colorParam of ["dipColor", "flashColor", "leakColor"]) {
      if (has(colorParam) && out[colorParam] === undefined) out[colorParam] = rgb;
    }
  }
  return out;
}

/**
 * Resolve a spec's CURRENT param values against its definition — the same legacy-field folding
 * (`direction`/`mode`/`softness`/`color` → named params) + registry defaults that `getActiveTransition`
 * feeds the shaders. Used by the junction params popover so its controls read exactly what renders.
 */
export function resolveSpecParams(
  def: TransitionDefinition,
  spec: TransitionSpec
): Record<string, number | number[] | boolean> {
  return resolveTransitionParams(def, transitionOverrides(def, spec));
}

/**
 * The active junction transition for the INCOMING clip at `currentTimeSeconds`, or null. Window is
 * `[cut - D/2, cut + D/2]` — the Premiere "centered on cut" model (R3, 2026-07-16; was start-aligned
 * `[cut, cut+D]`, which played the whole transition inside clip B and made a back-loaded easing curve
 * read as "clip A shows again after the cut"). `startSeconds` is the CUT (the incoming clip's own
 * start) — every caller already passes exactly that, so no caller needed to change for this window
 * shift; what DOES need to change per-caller is which layers get rendered/decoded during the pre-roll
 * half, and holding the edge frame when a side lacks handle material (see the R3 plan doc, steps 2-3).
 * Returns null outside the window, for edge fades (no registry entry), or when no spec. Progress is
 * eased here so every renderer feeds the shader the identical value.
 */
export function getActiveTransition(
  spec: TransitionSpec | undefined,
  options: {
    currentTimeSeconds?: number | undefined;
    /** The CUT point (the incoming clip's own start) — NOT the window start. See doc above. */
    startSeconds?: number | undefined;
    /** Incoming clip length — clamps the window so the transition never runs past the clip it reveals. */
    clipDurationSeconds?: number | undefined;
    /**
     * HANDLE-AWARE placement (R3.1): how much of the window falls BEFORE the cut. Callers compute it
     * via `resolveTransitionWindowSides` so the window only consumes material each side actually has
     * (an untrimmed incoming clip has NO head handle — a centered window froze its first frame for
     * the whole pre-roll half, the 2026-07-16 report). Absent → centered (D/2), the pure-math default.
     */
    prerollSeconds?: number | undefined;
  }
): ActiveTransition | null {
  if (!spec) return null;
  const def = getTransition(spec.kind);
  if (!def) return null;
  const t = options.currentTimeSeconds;
  if (typeof t !== "number") return null;
  const cut = options.startSeconds ?? 0;
  const duration = effectiveTransitionDuration(spec.durationSeconds, options.clipDurationSeconds);
  const preroll = Math.max(0, Math.min(duration, options.prerollSeconds ?? duration / 2));
  const start = cut - preroll;
  const linear = (t - start) / duration;
  if (linear < 0 || linear >= 1) return null;
  const eased = applyTransitionEasing(linear, def.easing);
  const params = resolveTransitionParams(def, transitionOverrides(def, spec));
  return { def, transitionId: def.id, progress: eased, params };
}

/** How a junction transition window splits around its cut: `prerollSeconds` before + `postrollSeconds` after. */
export interface TransitionWindowSides {
  prerollSeconds: number;
  postrollSeconds: number;
  /**
   * Seconds of the window that CANNOT be covered by real material even after the handle-aware shift —
   * the edge-hold ("repeated frames") span, on the outgoing side's tail (the incoming never freezes:
   * its pre-roll is capped by its head handle). 0 = clean transition. Drives the Premiere-style zebra
   * warning on the timeline junction pill.
   */
  repeatedFramesSeconds: number;
  /** Per-side split of `repeatedFramesSeconds` (T4): the head term is the incoming clip's uncovered
   *  pre-roll (only reachable with a MANUAL alignment — auto caps pre-roll by the head handle), the
   *  tail term the outgoing clip's uncovered post-roll. `head + tail === repeatedFramesSeconds`. */
  headRepeatedSeconds: number;
  tailRepeatedSeconds: number;
}

/**
 * HANDLE-AWARE window placement (R3.1, the professional model): a junction transition is IDEALLY
 * centered on the cut, but each side can only play material it actually has —
 *  - the INCOMING side's pre-roll consumes its HEAD handle (`sourceInSeconds` worth of source before
 *    its in-point; an untrimmed clip has none),
 *  - the OUTGOING side's post-roll consumes its TAIL handle (asset media past its out-point).
 * The window shifts toward whichever side has material: no head handle → "start at cut" (incoming
 * plays normally from frame one — never frozen); no tail handle → "end at cut". Only when BOTH sides
 * lack material does an edge hold remain (Premiere's "insufficient media — repeated frames").
 * Still/generated layers (image/text/shape/graphic) have unlimited material on both sides.
 * Speed ramps use the base-rate approximation (documented in the R3 plan); the renderers' edge-hold
 * covers any residual shortfall. Every renderer resolves sides through THIS function so the window
 * placement stays pixel-aligned by construction.
 */
export function resolveTransitionWindowSides(input: {
  /** The EFFECTIVE window duration (already clamped via `effectiveTransitionDuration`). */
  durationSeconds: number;
  incoming: { type: string; sourceInSeconds?: number | undefined; speed?: number | undefined };
  outgoing: { type: string; sourceInSeconds?: number | undefined; speed?: number | undefined; durationSeconds: number };
  /** Outgoing asset's total media length; undefined = unknown → assume tail material exists. */
  outgoingAssetDurationSeconds?: number | undefined;
  /** Manual placement override (from `TransitionSpec.alignment`). "auto"/absent = handle-aware (unchanged). */
  alignment?: "auto" | "center" | "start" | "end" | undefined;
}): TransitionWindowSides {
  const duration = Math.max(1e-4, input.durationSeconds);
  const rate = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(16, Math.max(0.05, value)) : 1;
  const isTimedMedia = (type: string) => type === "video" || type === "audio";
  const headHandleSeconds = isTimedMedia(input.incoming.type)
    ? Math.max(0, input.incoming.sourceInSeconds ?? 0) / rate(input.incoming.speed)
    : Number.POSITIVE_INFINITY;
  const outgoingRate = rate(input.outgoing.speed);
  const tailHandleSeconds = !isTimedMedia(input.outgoing.type)
    ? Number.POSITIVE_INFINITY
    : input.outgoingAssetDurationSeconds == null
      ? Number.POSITIVE_INFINITY
      : Math.max(
          0,
          (input.outgoingAssetDurationSeconds - ((input.outgoing.sourceInSeconds ?? 0) + input.outgoing.durationSeconds * outgoingRate)) /
            outgoingRate
        );
  // Ideal = centered; shift toward the side that has material. `duration - tailHandle` is the minimum
  // pre-roll forced by a short tail; the head handle caps it from above; [0, D] bounds everything.
  const prerollSeconds =
    input.alignment === "center"
      ? duration / 2
      : input.alignment === "start"
        ? 0
        : input.alignment === "end"
          ? duration
          : Math.max(0, Math.min(duration, Math.min(headHandleSeconds, Math.max(duration / 2, duration - tailHandleSeconds))));
  const postrollSeconds = duration - prerollSeconds;
  // Auto: pre-roll is capped by the head handle by construction, so the head term is always 0 (unchanged
  // from before manual alignment existed). Manual alignment can exceed EITHER side's material.
  const headRepeatedSeconds = Math.max(0, prerollSeconds - headHandleSeconds);
  const tailRepeatedSeconds = Math.max(0, postrollSeconds - tailHandleSeconds);
  return {
    prerollSeconds,
    postrollSeconds,
    repeatedFramesSeconds: headRepeatedSeconds + tailRepeatedSeconds,
    headRepeatedSeconds,
    tailRepeatedSeconds,
  };
}

/** Find every same-track clip pair joined by a registry junction transition (incoming carries the spec). */
// Kept in sync with `nesting.ts`'s `NEST_ID_SEPARATOR` (same literal) — duplicated locally rather than
// imported because `nesting.ts` imports FROM this module (`isTrackEnabled`), and importing it back here
// would create a cycle.
const NEST_ID_SEPARATOR = "__nest_";

/**
 * R2 fix: the nest a layer id directly belongs to, or `null` for a non-nested (top-level) id. Expansion
 * (`nesting.ts`) collapses every nested child onto the compound clip's PARENT track, so two unrelated
 * clips — one inside a nest, one on the parent track right after it — can land on the same `trackId`
 * with adjacent start/end times. Without this scoping, `findTransitionPairs` could false-match a nested
 * child against that outside neighbour and steal its frame across the nest boundary.
 */
function nestPrefixOf(id: string): string | null {
  const marker = id.lastIndexOf(NEST_ID_SEPARATOR);
  return marker > 0 ? id.slice(0, marker) : null;
}

export function findTransitionPairs(layers: readonly TransitionLayerLike[]): TransitionPair[] {
  const pairs: TransitionPair[] = [];
  for (const incoming of layers) {
    const spec = incoming.transitionIn;
    if (!spec || !getTransition(spec.kind)) continue;
    const incomingStart = incoming.startSeconds ?? 0;
    const incomingNest = nestPrefixOf(incoming.id);
    const outgoing = layers.find(
      (l) =>
        l.id !== incoming.id &&
        l.trackId === incoming.trackId &&
        nestPrefixOf(l.id) === incomingNest &&
        Math.abs((l.startSeconds ?? 0) + (l.durationSeconds ?? 0) - incomingStart) < 1e-3
    );
    if (outgoing) pairs.push({ outgoingId: outgoing.id, incomingId: incoming.id, spec });
  }
  return pairs;
}

/**
 * Junction pairs for a nest-EXPANDED layer list (nesting Block 4c). Pairs found on the expanded
 * layers, PLUS junctions involving a COMPOUND clip — nest expansion removes the compound clip from
 * the tracks, so its junctions are only discoverable on the RAW (unexpanded) composition's layers.
 * The extra pairs keep the compound clip's ID as their side (`build-scene-draws` resolves it against
 * `nestedGroups` and mixes the finished group). `rawLayers` empty/omitted → exactly
 * `findTransitionPairs(layers)`, so non-nested paths are unchanged.
 */
export function findTransitionPairsWithGroupJunctions(
  layers: readonly TransitionLayerLike[],
  rawLayers: readonly TransitionLayerLike[] | undefined
): TransitionPair[] {
  const pairs = findTransitionPairs(layers);
  if (!rawLayers || rawLayers.length === 0) return pairs;
  const rawById = new Map(rawLayers.map((layer) => [layer.id, layer]));
  const seenIncoming = new Set(pairs.map((pair) => pair.incomingId));
  for (const pair of findTransitionPairs(rawLayers)) {
    // Only junctions the expanded scan could NOT see: at least one side is a compound clip.
    if (!rawById.get(pair.incomingId)?.nestedCompositionId && !rawById.get(pair.outgoingId)?.nestedCompositionId) continue;
    if (seenIncoming.has(pair.incomingId)) continue;
    pairs.push(pair);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Blend modes — one mapping for all three renderers (CSS mix-blend-mode for DOM, canvas
// globalCompositeOperation for the 2D export compositor). Keeps preview ↔ export ↔ Remotion aligned.
// ---------------------------------------------------------------------------

/** The subset of CSS `mix-blend-mode` keyword values we emit (matches csstype's MixBlendMode). */
export type CssMixBlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "plus-lighter";

const BLEND_CSS: Record<BlendMode, CssMixBlendMode> = {
  normal: "normal",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
  add: "plus-lighter"
};

const BLEND_CANVAS: Record<BlendMode, string> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
  add: "lighter"
};

export function getCompositionBlendMode(layer: { blendMode?: BlendMode | undefined } | undefined): BlendMode {
  return layer?.blendMode ?? "normal";
}

// ---------------------------------------------------------------------------
// Track enable/solo — one rule for preview, browser export, and the render manifest.
// A track renders/plays unless it's muted, or some OTHER track is soloed while this one isn't.
// ---------------------------------------------------------------------------

interface TrackEnableState {
  muted?: boolean | undefined;
  solo?: boolean | undefined;
}

/** True if a track is rendered/audible given the whole track set (handles mute + solo). */
export function isTrackEnabled(track: TrackEnableState, allTracks: readonly TrackEnableState[]): boolean {
  if (track.muted) return false;
  const anySolo = allTracks.some((t) => t.solo);
  return !anySolo || Boolean(track.solo);
}

/** CSS `mix-blend-mode` value, or undefined for `normal` (so the style object stays clean). */
export function cssBlendMode(mode: BlendMode | undefined): CssMixBlendMode | undefined {
  if (!mode || mode === "normal") return undefined;
  return BLEND_CSS[mode];
}

/** Canvas `globalCompositeOperation` value (`source-over` for normal/undefined). */
export function canvasBlendOp(mode: BlendMode | undefined): string {
  return mode ? BLEND_CANVAS[mode] : "source-over";
}

export function getCompositionObjectFit(layer: Pick<CompositionLayerStyleInput, "fit" | "style"> | undefined) {
  const rawFit = layer?.fit ?? layer?.style?.fit;
  return rawFit === "contain" || rawFit === "fill" || rawFit === "cover" ? rawFit : compositionMediaDefaults.fit;
}

/** Resolved content transform — source-within-frame pan/zoom + crop, normalized + clamped to safe ranges. */
export interface ResolvedContentTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Edge insets as fractions of the frame (0..0.95). */
  crop: { top: number; right: number; bottom: number; left: number };
}

/**
 * Resolve a layer's {@link LayerContentTransform} (source-within-frame pan/zoom/crop) with defaults =
 * identity. Shared by every renderer + the inspector so the preview, export, and controls agree. Media-only;
 * text/shape callers get identity (they have no source to reframe).
 *
 * Time-aware: when `options.currentTimeSeconds` is supplied and the layer carries `content.*` keyframes
 * (`content.scale`, `content.offsetX`, `content.offsetY`, `content.crop.{top,right,bottom,left}`), each field
 * is evaluated at the playhead via the shared {@link evaluateAnimatedValue} — the same primitive the transform
 * evaluator uses, so all three renderers stay pixel-aligned. With no time and no keyframes the result is
 * byte-identical to the static resolve (existing projects unchanged).
 */
export function getCompositionContentTransform(
  layer:
    | (Pick<CompositionLayerStyleInput, "startSeconds" | "animations"> & { content?: LayerContentTransform | undefined })
    | { content?: LayerContentTransform | undefined }
    | undefined,
  options: CompositionStyleOptions = {}
): ResolvedContentTransform {
  const c = layer?.content;
  const cropOf = (v: number) => Math.max(0, Math.min(0.95, v));

  const animations = (("animations" in (layer ?? {}) ? (layer as { animations?: unknown }).animations : undefined) ??
    []) as TimelineKeyframeV2[];
  const startSeconds = numberOr(("startSeconds" in (layer ?? {}) ? (layer as { startSeconds?: unknown }).startSeconds : 0) as number | undefined, 0);
  const layerTime =
    typeof options.currentTimeSeconds === "number" ? Math.max(0, options.currentTimeSeconds - startSeconds) : undefined;
  const anim = (property: string, base: number): number => {
    if (layerTime === undefined) return base;
    const keyframes = animations.filter((kf) => kf.target.scope === "layer" && kf.target.property === property);
    if (!keyframes.length) return base;
    return evaluateAnimatedValue({ baseValue: base, keyframes, property, scope: "layer", timeSeconds: layerTime }) as number;
  };

  return {
    scale: Math.max(0.01, anim("content.scale", numberOr(c?.scale, 1))),
    offsetX: anim("content.offsetX", numberOr(c?.offsetX, 0)),
    offsetY: anim("content.offsetY", numberOr(c?.offsetY, 0)),
    crop: {
      top: cropOf(anim("content.crop.top", numberOr(c?.crop?.top, 0))),
      right: cropOf(anim("content.crop.right", numberOr(c?.crop?.right, 0))),
      bottom: cropOf(anim("content.crop.bottom", numberOr(c?.crop?.bottom, 0))),
      left: cropOf(anim("content.crop.left", numberOr(c?.crop?.left, 0)))
    }
  };
}

/**
 * Evaluate a numeric layer-scope keyframe track (`style.*` text-style properties) at the playhead —
 * the same shared primitive transform/content keyframes use, so every renderer (DOM preview, GPU
 * scene raster, Remotion) animates text style identically. `base` when no time or no keyframes.
 */
function animStyleNumber(
  layer: CompositionLayerStyleInput | TimelineLayer,
  options: CompositionStyleOptions,
  property: string,
  base: number
): number {
  if (typeof options.currentTimeSeconds !== "number") return base;
  const animations = (layer.animations ?? []) as TimelineKeyframeV2[];
  if (!animations.length) return base;
  const keyframes = animations.filter((kf) => kf.target.scope === "layer" && kf.target.property === property);
  if (!keyframes.length) return base;
  const layerTime = Math.max(0, options.currentTimeSeconds - numberOr(layer.startSeconds, 0));
  return evaluateAnimatedValue({ baseValue: base, keyframes, property, scope: "layer", timeSeconds: layerTime }) as number;
}

export function getCompositionTextStyle(layer: CompositionLayerStyleInput | TimelineLayer, options: CompositionStyleOptions = {}) {
  const style = styleOf(layer);
  const transform = getCompositionTransform(layer, options);
  const shadowCss = getTextShadowCss(layer, style, options);
  const textWidth = animStyleNumber(layer, options, "style.textWidthPercent", numberOr(layer.textWidthPercent ?? style.textWidthPercent, 0));
  const strokeWidth = animStyleNumber(layer, options, "style.strokeWidth", numberOr(layer.strokeWidth ?? style.strokeWidth, 0));
  const strokeColor = stringOr(layer.strokeColor ?? style.strokeColor, "#000000");
  // ADR-023 D7 (S1). ABSENT resolves to "over" — the legacy look — and only an explicit "under"
  // changes anything, so every project authored before this field existed emits exactly the CSS it
  // emitted before. See TimelineLayer.strokePaintOrder for why absence is permanent, not defaulted.
  const strokeUnderFill = (layer.strokePaintOrder ?? style.strokePaintOrder) === "under";
  // ADR-023 D6a (S0b) / T-13 corrected (S0c). ABSENT emits NOTHING — no `direction`, no
  // `unicode-bidi` — so an existing project keeps rendering at the CSS initial `ltr` exactly as it
  // does today, permanently. Only a declared value produces declarations, and `"auto"` is resolved
  // to a concrete direction HERE so the DOM and the raster cannot answer it differently.
  const direction = resolveTextDirection(layer.direction ?? style.direction, layer);
  const effectCss = getEffectCss(layer.effects, layer.animations as TimelineKeyframeV2[] | undefined, layer.startSeconds, options.currentTimeSeconds);
  const paddingEmY = animStyleNumber(
    layer,
    options,
    "style.backgroundPaddingEm",
    numberOr(layer.backgroundPaddingEm ?? style.backgroundPaddingEm, compositionTextDefaults.paddingEmY)
  );
  const paddingEmX = paddingEmY * 2;
  const letterSpacing = animStyleNumber(layer, options, "style.letterSpacing", numberOr(layer.letterSpacing ?? style.letterSpacing, 0));
  // NOTE: text warp is NOT a CSS filter here. It is rendered as a vector <path>
  // overlay (opentype outline + envelope mesh) by buildWarpedTextPathSvg; see
  // VideoPreview.tsx / remotion/Root.tsx and font-outlines.ts.
  const filter = combineFilter(effectCss.filter, getCompositionColorFilter(layer, options));

  return {
    left: `${transform.x}%`,
    top: `${transform.y}%`,
    maxWidth: `${compositionTextDefaults.maxWidthPercent}%`,
    padding: `${paddingEmY}em ${paddingEmX}em`,
    borderRadius: `${animStyleNumber(layer, options, "style.backgroundRadiusEm", numberOr(layer.backgroundRadiusEm ?? style.backgroundRadiusEm, compositionTextDefaults.borderRadiusEm))}em`,
    background: stringOr(layer.backgroundColor ?? style.backgroundColor, compositionTextDefaults.backgroundColor),
    color: stringOr(layer.color ?? style.color, compositionTextDefaults.color),
    fontFamily: stringOr(layer.fontFamily ?? style.fontFamily, compositionTextDefaults.fontFamily),
    fontSize: animStyleNumber(layer, options, "style.fontSize", numberOr(layer.fontSize ?? style.fontSize, compositionTextDefaults.fontSize)),
    fontWeight: numberOr(layer.fontWeight ?? style.fontWeight, compositionTextDefaults.fontWeight),
    fontStyle: (layer.italic ?? style.italic) ? "italic" : "normal",
    letterSpacing: letterSpacing !== 0 ? `${letterSpacing}px` : undefined,
    lineHeight: animStyleNumber(layer, options, "style.lineHeight", numberOr(layer.lineHeight ?? style.lineHeight, compositionTextDefaults.lineHeight)),
    opacity: transform.opacity / 100,
    mixBlendMode: cssBlendMode(getCompositionBlendMode(layer)),
    textAlign: getTextAlign(layer.textAlign ?? style.textAlign),
    textShadow: shadowCss,
    filter,
    transform: compositionTransformCss(transform),
    transformOrigin: compositionTransformOriginCss(transform),
    width: textWidth > 0 ? `${textWidth}%` : "max-content",
    WebkitTextStroke: strokeWidth > 0 ? `${strokeWidth}px ${strokeColor}` : undefined,
    // `paint-order: stroke fill` moves the stroke BEHIND the fill so a heavy stroke stops eating the
    // letterform. `undefined` (the legacy case) emits no declaration at all, which is what keeps an
    // existing project's CSS byte-identical rather than merely equivalent.
    paintOrder: strokeUnderFill && strokeWidth > 0 ? ("stroke fill" as const) : undefined,
    // ADR-023 D6a / T-13 corrected. Always a CONCRETE direction by the time it reaches here —
    // `"auto"` was resolved above, once, for both paths. Isolated so the layer can neither leak its
    // level into, nor inherit one from, whatever DOM happens to surround it in the editor.
    direction,
    unicodeBidi: direction ? ("isolate" as const) : undefined,
    whiteSpace: "pre-wrap" as const
  };
}

export function getCompositionTextRuns(layer: { text?: string | undefined; textRuns?: TextRun[] | undefined }): TextRun[] {
  if (layer.textRuns?.length) {
    return layer.textRuns;
  }
  return [{ text: layer.text ?? "" }];
}

/**
 * Evaluate the `textRevealProgress` (0–1) at `layerTimeSeconds` (time relative to layer start)
 * for the typewriter animation. Returns 1 (fully visible) when no reveal keyframes exist.
 */
export function evaluateTextRevealProgress(
  layer: Pick<CompositionLayerStyleInput, "animations"> & { textRevealProgress?: number | undefined },
  layerTimeSeconds: number
): number {
  const base = layer.textRevealProgress ?? 1;
  const keyframes = ((layer.animations ?? []) as TimelineKeyframeV2[]).filter(
    (kf) => kf.target.scope === "layer" && kf.target.property === "textRevealProgress"
  );
  if (!keyframes.length) return base;
  return evaluateAnimatedValue({
    baseValue: base,
    keyframes,
    property: "textRevealProgress",
    scope: "layer",
    timeSeconds: layerTimeSeconds
  }) as number;
}

/** Slice text runs to show only the first `charsToShow` characters. */
export function sliceTextRuns<T extends { text: string }>(runs: T[], charsToShow: number): T[] {
  let remaining = charsToShow;
  const result: T[] = [];
  for (const run of runs) {
    if (remaining <= 0) break;
    if (remaining >= run.text.length) {
      result.push(run);
      remaining -= run.text.length;
    } else {
      result.push({ ...run, text: run.text.slice(0, remaining) });
      remaining = 0;
    }
  }
  return result;
}

/**
 * Get the visible text runs at `currentTimeSeconds`, slicing by the typewriter
 * `textRevealProgress` animation if one exists. All three renderers (preview, Remotion,
 * local canvas) call this instead of `getCompositionTextRuns` directly.
 */
export function getVisibleTextRuns(
  layer: {
    text?: string | undefined;
    textRuns?: TextRun[] | undefined;
    sourceTextKeyframes?: SourceTextKeyframe[] | undefined;
    startSeconds?: number | undefined;
    animations?: unknown[] | undefined;
    textRevealProgress?: number | undefined;
  },
  currentTimeSeconds: number
): TextRun[] {
  const layerTime = Math.max(0, currentTimeSeconds - (layer.startSeconds ?? 0));
  // SOURCE TEXT keyframes (Premiere-style, HOLD): the active entry is the last one at/before the
  // playhead; before the first entry, the first entry shows. Typewriter slicing still applies on
  // top, so both animation styles compose.
  const sourceKeys = layer.sourceTextKeyframes;
  let runs: TextRun[];
  if (sourceKeys?.length) {
    const ordered = [...sourceKeys].sort((a, b) => a.timeSeconds - b.timeSeconds);
    let active = ordered[0]!;
    for (const key of ordered) {
      if (key.timeSeconds <= layerTime + 1e-6) active = key;
      else break;
    }
    runs = active.runs.length ? active.runs : [{ text: "" }];
  } else {
    runs = getCompositionTextRuns(layer);
  }
  const progress = evaluateTextRevealProgress(layer, layerTime);
  if (progress >= 1) return runs;
  const totalChars = runs.reduce((sum, run) => sum + run.text.length, 0);
  const charsToShow = Math.round(totalChars * Math.max(0, progress));
  return sliceTextRuns(runs, charsToShow);
}

export function getCompositionTextRunStyle(
  run: TextRun,
  baseStyle: {
    fontSize?: number | string | undefined;
    fontWeight?: number | string | undefined;
    color?: string | undefined;
    fontFamily?: string | undefined;
    fontStyle?: string | undefined;
  }
): Record<string, unknown> {
  const baseFontSize = numberOr(baseStyle.fontSize, compositionTextDefaults.fontSize);
  return {
    fontWeight: run.bold ? 900 : baseStyle.fontWeight,
    // Like fontWeight above, the run only OVERRIDES the layer style — it must not zero it out.
    // This used to force "normal" whenever the run had no italic flag, which silently discarded
    // the layer-level Italic toggle in EVERY renderer (plain text = one flagless run).
    fontStyle: run.italic ? "italic" : baseStyle.fontStyle ?? "normal",
    color: run.color ?? baseStyle.color,
    // Per-run highlight (marker). Distinct from the layer's background pill.
    backgroundColor: run.backgroundColor,
    fontFamily: run.fontFamily ?? baseStyle.fontFamily,
    fontSize: run.fontSizeMultiplier ? baseFontSize * run.fontSizeMultiplier : baseStyle.fontSize
  };
}

export function getCompositionShapeStyle(layer: CompositionLayerStyleInput | TimelineLayer, options: CompositionStyleOptions = {}) {
  const style = styleOf(layer);
  const transform = getCompositionTransform(layer, options);
  const effectCss = getEffectCss(layer.effects, layer.animations as TimelineKeyframeV2[] | undefined, layer.startSeconds, options.currentTimeSeconds);

  return {
    left: `${transform.x}%`,
    top: `${transform.y}%`,
    width: `${numberOr(layer.widthPercent ?? style.widthPercent, compositionShapeDefaults.widthPercent)}%`,
    height: `${numberOr(layer.heightPercent ?? style.heightPercent, compositionShapeDefaults.heightPercent)}%`,
    shapeKind: (layer.shapeKind ?? style.shapeKind ?? compositionShapeDefaults.shapeKind) as ShapeKind,
    shapePath: layer.shapePath ?? (style.shapePath as MaskPoint[] | undefined),
    borderRadius: numberOr(layer.borderRadius ?? style.borderRadius, compositionShapeDefaults.borderRadiusPx),
    border: getStrokeCss(layer, style),
    boxShadow: getShapeShadowCss(layer, style),
    background: stringOr(layer.color ?? style.color, compositionShapeDefaults.color),
    filter: combineFilter(effectCss.filter, getCompositionColorFilter(layer, options)),
    opacity: transform.opacity / 100,
    mixBlendMode: cssBlendMode(getCompositionBlendMode(layer)),
    transform: compositionTransformCss(transform),
    transformOrigin: compositionTransformOriginCss(transform)
  };
}

export function getCompositionMediaStyle(layer: CompositionLayerStyleInput | TimelineLayer, options: CompositionStyleOptions = {}) {
  const transform = getCompositionTransform(layer, options);
  const effectCss = getEffectCss(layer.effects, layer.animations as TimelineKeyframeV2[] | undefined, layer.startSeconds, options.currentTimeSeconds);
  // When skipColorFilter is true (WebGL renderer active), omit the SVG filter ref so the
  // underlying element is a clean pixel source — the canvas output is the sole graded output.
  const colorFilter = options.skipColorFilter ? null : getCompositionColorFilter(layer, options);

  return {
    left: `${transform.x}%`,
    top: `${transform.y}%`,
    width: "100%",
    height: "100%",
    objectFit: getCompositionObjectFit(layer),
    filter: combineFilter(effectCss.filter, colorFilter),
    boxShadow: effectCss.boxShadow,
    opacity: transform.opacity / 100,
    mixBlendMode: cssBlendMode(getCompositionBlendMode(layer)),
    transform: compositionTransformCss(transform),
    transformOrigin: compositionTransformOriginCss(transform),
    // Vector masks (Phase 1): applied to the full-bleed (comp-sized) media element so layer-local
    // comp-px mask coords align, and the mask follows the clip's transform. No-op when mask-free.
    // `frame` is forwarded so a Frame's clip mask ref is emitted too (see getCompositionMaskCss).
    ...getCompositionMaskCss(layer as { id: string; masks?: Mask[] | undefined; frame?: TimelineLayer["frame"] })
  };
}

export function getCompositionFontsUsed(layers: CompositionLayerStyleInput[]) {
  const fonts = new Set<string>();
  for (const layer of layers) {
    const fontFamily = stringOr(layer.fontFamily ?? layer.style?.fontFamily, compositionTextDefaults.fontFamily);
    fonts.add(fontFamily);
  }
  return [...fonts];
}

export function hasCompositionEffect(effects: unknown[] | undefined, type: TimelineEffect["type"]) {
  return (effects ?? []).some((effect) => {
    const candidate = asRecord(effect);
    return candidate.type === type && candidate.enabled !== false;
  });
}

export function compositionTransformCss(transform: CompositionTransform, extraScale = 1) {
  const z = transform.z || 0;
  const rotateX = transform.rotateX || 0;
  const rotateY = transform.rotateY || 0;
  const perspective = transform.perspective ? `perspective(${transform.perspective}px) ` : "";
  const tilt = rotateX || rotateY ? ` rotateX(${rotateX}deg) rotateY(${rotateY}deg)` : "";
  // Anchor (D3): the translate percentages place the ANCHOR at the layer's position; pair with
  // `compositionTransformOriginCss` (transform-origin at the same point) so rotate/scale/tilt pivot
  // there. Default 50/50 emits the exact historical string.
  const ax = transform.anchorX ?? 50;
  const ay = transform.anchorY ?? 50;
  return `${perspective}translate3d(${-ax}%, ${-ay}%, ${z}px) rotate(${transform.rotation}deg)${tilt} scale(${transform.scale * extraScale})`;
}

/**
 * The `transform-origin` that pairs with {@link compositionTransformCss} (D3 anchor). Undefined for
 * the default center anchor — callers that spread this into a style object leave `transformOrigin`
 * untouched, keeping the no-anchor path byte-identical.
 */
export function compositionTransformOriginCss(transform: CompositionTransform): string | undefined {
  const ax = transform.anchorX ?? 50;
  const ay = transform.anchorY ?? 50;
  return ax === 50 && ay === 50 ? undefined : `${ax}% ${ay}%`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function numberOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function styleOf(layer: CompositionLayerStyleInput | TimelineLayer) {
  return "style" in layer && layer.style ? layer.style : {};
}

/**
 * Fields of {@link CompositionLayerStyleInput} that the manifest carries somewhere OTHER than the
 * style bag: `RenderManifestLayer` has its own top-level slots for them. Excluded here so the
 * exhaustiveness check below is about the style bag and nothing else.
 *
 * `text`/`textRuns` (S0c) joined this list because the style resolver reads the layer's content to
 * resolve `direction: "auto"`. Copying them into the style bag as well would give the same string
 * two homes that can disagree.
 */
type NonStyleBagKey =
  | "id" | "startSeconds" | "transform" | "keyframes" | "animations" | "style" | "effects" | "masks" | "blendMode"
  | "text" | "textRuns";

/** Every style field the manifest's `style` bag is obliged to carry. */
export type ManifestLayerStyleKey = Exclude<keyof CompositionLayerStyleInput, NonStyleBagKey>;

/**
 * The manifest's text/graphic style bag, as data (ADR-023 T-15, stage S0b).
 *
 * WHY THIS EXISTS — the defect it makes impossible. `buildRenderManifest` used to copy these fields
 * into the manifest as a hand-written object literal, in TWO places. S1 added `strokePaintOrder` to
 * the layer and to both renderers, and forgot one of those literals: the editor read the live graph
 * and rendered stroke-under, the export read the manifest and rendered stroke-over, for the same
 * project. `render:compare:pixels` passed at 0.000%, because it compares two consumers of this bag
 * and both agreed perfectly about a field neither of them was given. Parity answers "do the
 * renderers agree"; it cannot answer "is either one listening."
 *
 * The list below is checked against {@link CompositionLayerStyleInput} — the interface
 * `getCompositionTextStyle`/`getCompositionShapeStyle` actually READ from — so the constraint is a
 * real one rather than a restatement: a stage that adds a style property has to add it to that
 * interface in order to read it, and the moment it does, omitting it here FAILS TYPECHECK with the
 * missing key named. S5 adds roughly six of these. The alternative was finding the next one by luck,
 * twice, as S1 did.
 */
export const MANIFEST_LAYER_STYLE_KEYS = [
  "color",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "italic",
  "letterSpacing",
  "lineHeight",
  "textWidthPercent",
  "textAlign",
  "direction",
  "textWarp",
  "fit",
  "widthPercent",
  "heightPercent",
  // Shape geometry — without these a non-default shape (pen path, ellipse, frame-border clone)
  // rendered as the default rounded-rectangle in the cloud path (styleOf reads this bag).
  "shapeKind",
  "shapePath",
  "borderRadius",
  "strokeColor",
  "strokeWidth",
  "strokePaintOrder",
  "backgroundColor",
  "backgroundPaddingEm",
  "backgroundRadiusEm",
  "shadowColor",
  "shadowBlur",
  "shadowOffsetX",
  "shadowOffsetY"
] as const satisfies ReadonlyArray<ManifestLayerStyleKey>;

/**
 * The exhaustiveness half. `satisfies` above only proves every key LISTED is real; this proves every
 * key REQUIRED is listed. A missing one makes `MissingManifestStyleKeys` a union of the offenders,
 * and the assignment below fails with those names in the error text.
 */
type MissingManifestStyleKeys = Exclude<ManifestLayerStyleKey, (typeof MANIFEST_LAYER_STYLE_KEYS)[number]>;
const _manifestStyleKeysAreExhaustive: MissingManifestStyleKeys extends never
  ? true
  : ["manifest style bag is missing these keys — add them to MANIFEST_LAYER_STYLE_KEYS", MissingManifestStyleKeys] = true;
void _manifestStyleKeysAreExhaustive;

/**
 * Copy a layer's style fields into the manifest bag. Every key is assigned unconditionally, so the
 * emitted object has the same shape (and key order) the two hand-written literals produced — this
 * change is a refactor of HOW the bag is built, not of what it contains.
 */
export function pickManifestLayerStyle(layer: TimelineLayer): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  // Indexed directly off `TimelineLayer` rather than through a `Record<string, unknown>` cast: the
  // cast would silently accept a key that exists on the style INPUT interface but not on the layer,
  // and copy `undefined` for it forever. This way that is a compile error too.
  for (const key of MANIFEST_LAYER_STYLE_KEYS) {
    bag[key] = layer[key];
  }
  return bag;
}

/**
 * `"start"`/`"end"` (ADR-023 D6a, S0b) are LOGICAL and pass straight through to CSS `text-align`,
 * which resolves them against the element's `direction`. `"left"`/`"right"` stay PHYSICAL forever.
 * Anything unrecognised still falls back to `"center"`, exactly as before.
 */
function getTextAlign(value: unknown): "left" | "center" | "right" | "start" | "end" {
  return value === "left" || value === "right" || value === "center" || value === "start" || value === "end"
    ? value
    : "center";
}

/**
 * Absent stays absent (ADR-023 D6a). This deliberately does NOT fall back to `"ltr"`: emitting
 * `direction: ltr` for a legacy layer would render identically but change the emitted CSS, and the
 * whole legacy claim is byte-identity, not equivalence. Unrecognised input is treated as absent —
 * "I could not read it" and "it said something else" get the same safe answer, as
 * `normalizeProjectColorSettings` does for colour.
 */
function getTextDirection(value: unknown): "auto" | "ltr" | "rtl" | undefined {
  return value === "auto" || value === "ltr" || value === "rtl" ? value : undefined;
}

/**
 * ADR-023 T-13, **as corrected 2026-08-13** — resolve `"auto"` ONCE, here, and hand both renderers
 * the same concrete answer.
 *
 * S0b delegated `"auto"` to the browser via `unicode-bidi: plaintext`, which is right for a CSS box
 * and impossible for a canvas: `ctx.direction` takes `"ltr"` or `"rtl"`, there is no `plaintext`, and
 * BOTH renderers take their pixels from `scene/text-shape.ts`. So `"auto"` silently drew `ltr`
 * everywhere — measured, byte-identical hashes — and since new text is authored `"auto"`, the
 * shipped default was "Arabic works if you pick RTL".
 *
 * The hazard T-13 exists to prevent is two renderers each deciding for themselves and drifting. This
 * is the opposite: one function, in shared, at style-resolution time, that both paths consume. The
 * DOM path is deliberately given the SAME concrete direction rather than being left on `plaintext`,
 * because a preview resolving per-line while the export resolves per-layer is exactly the divergence
 * the manifest contract exists to forbid. The accepted cost is one direction per LAYER, not per
 * line — which is what After Effects and Premiere both do.
 *
 * Resolution reads the layer's FULL text, never the typewriter-visible slice
 * (`getVisibleTextRuns`): direction must not flip midway through a reveal because the first strong
 * character has not been typed yet.
 */
export function resolveTextDirection(
  declared: unknown,
  textSource: { text?: string | undefined; textRuns?: TextRun[] | undefined }
): "ltr" | "rtl" | undefined {
  const value = getTextDirection(declared);
  if (value === "ltr" || value === "rtl") return value;
  // Absent stays absent — no declaration, no resolution, nothing to migrate.
  if (value !== "auto") return undefined;
  return detectTextScript(getCompositionTextRuns(textSource).map((run) => run.text).join("")).direction;
}

/**
 * ADR-023 T-13a / T-12 — can this layer's text be drawn in VISUAL order at all?
 *
 * A line whose runs all share one style is drawn with a single `fillText`, so the engine performs
 * bidi reordering across the whole line. A line carrying two styles cannot be: canvas 2D exposes no
 * per-character visual positions, so the raster must place each run itself, in logical order. For
 * Latin that is invisible; for a shaping-dependent script it is wrong, and T-12's rule is that we
 * say so rather than emit it silently.
 *
 * Deliberately conservative and layer-level, not line-level: the editor cannot run layout, and a
 * marker that appears only once wrapping happens to put two styles on one line would be worse than
 * one that appears whenever the combination is possible.
 */
export function isTextVisualOrderUnavailable(layer: {
  text?: string | undefined;
  textRuns?: TextRun[] | undefined;
}): boolean {
  const runs = getCompositionTextRuns(layer);
  if (runs.length < 2) return false;
  if (!detectTextScript(runs.map((run) => run.text).join("")).shapingDependent) return false;
  const signatures = new Set(
    runs.map((run) =>
      JSON.stringify([run.bold ?? false, run.italic ?? false, run.color ?? "", run.backgroundColor ?? "", run.fontFamily ?? "", run.fontSizeMultiplier ?? 1])
    )
  );
  return signatures.size > 1;
}

function getTextShadowCss(
  layer: CompositionLayerStyleInput | TimelineLayer,
  style: Record<string, unknown>,
  options: CompositionStyleOptions = {}
) {
  const hasShadow = hasCompositionEffect(layer.effects, "shadow");
  const blur = animStyleNumber(
    layer,
    options,
    "style.shadowBlur",
    numberOr(layer.shadowBlur ?? style.shadowBlur, hasShadow ? compositionTextDefaults.shadowBlur : 0)
  );
  if (blur <= 0) {
    return undefined;
  }

  const color = stringOr(layer.shadowColor ?? style.shadowColor, compositionTextDefaults.shadowColor);
  const offsetX = animStyleNumber(layer, options, "style.shadowOffsetX", numberOr(layer.shadowOffsetX ?? style.shadowOffsetX, compositionTextDefaults.shadowOffsetX));
  const offsetY = animStyleNumber(layer, options, "style.shadowOffsetY", numberOr(layer.shadowOffsetY ?? style.shadowOffsetY, compositionTextDefaults.shadowOffsetY));
  return `${offsetX}px ${offsetY}px ${blur}px ${color}`;
}

function getShapeShadowCss(layer: CompositionLayerStyleInput | TimelineLayer, style: Record<string, unknown>) {
  const blur = numberOr(layer.shadowBlur ?? style.shadowBlur, 0);
  if (blur <= 0) {
    return undefined;
  }

  const color = stringOr(layer.shadowColor ?? style.shadowColor, "rgba(0,0,0,0.5)");
  const offsetX = numberOr(layer.shadowOffsetX ?? style.shadowOffsetX, 0);
  const offsetY = numberOr(layer.shadowOffsetY ?? style.shadowOffsetY, 8);
  return `${offsetX}px ${offsetY}px ${blur}px ${color}`;
}

function getStrokeCss(layer: CompositionLayerStyleInput | TimelineLayer, style: Record<string, unknown>) {
  const strokeWidth = numberOr(layer.strokeWidth ?? style.strokeWidth, 0);
  if (strokeWidth <= 0) {
    return undefined;
  }

  return `${strokeWidth}px solid ${stringOr(layer.strokeColor ?? style.strokeColor, "#ffffff")}`;
}

function getEffectCss(effects: unknown[] | undefined, animations: TimelineKeyframeV2[] | undefined, layerStartSeconds = 0, currentTimeSeconds?: number | undefined) {
  const filters: string[] = [];
  const shadows: string[] = [];

  for (const rawEffect of effects ?? []) {
    const effect = asRecord(rawEffect);
    if (effect.enabled === false) {
      continue;
    }
    // A masked color/blur effect is handled by the duplicate-layer expansion (expandEffectRegionMasks), so it
    // never reaches here masked. `glow` is the exception — region glow is deferred, so a masked glow still
    // applies to the whole clip (don't skip it). Other masked effects (none today) skip to avoid double-apply.
    if (effect.type !== "glow" && Array.isArray(effect.masks) && (effect.masks as Mask[]).some(isRenderableMask)) {
      continue;
    }
    const params = asRecord(effect.params);
    const effectId = stringOr(effect.id, "");
    const layerTimeSeconds = typeof currentTimeSeconds === "number" ? Math.max(0, currentTimeSeconds - layerStartSeconds) : undefined;
    const paramNumber = (key: string, fallback: number) =>
      evaluateTimelineEffectParam({
        animations,
        baseValue: numberOr(params[key], fallback),
        effectId,
        paramKey: key,
        timeSeconds: layerTimeSeconds
      });
    const intensity = numberOr(effect.intensity, 50) / 100;

    if (effect.type === "blur") {
      const amount = paramNumber("amount", Math.round(18 * intensity));
      if (amount > 0) {
        filters.push(`blur(${amount}px)`);
      }
    }

    // Color effects (brightnessContrast / colorGrade / curves) no longer emit CSS
    // filters here — they compile to a real color pipeline applied as an SVG filter
    // via getCompositionColorFilter() (Phase 3 color system; see COLOR_SYSTEM_PLAN.md).
    // CSS filters can't express curves / wheels / per-channel color.

    if (effect.type === "glow") {
      const radius = paramNumber("radius", Math.round(24 * intensity));
      const color = stringOr(params.color, "#C9FF4A");
      if (radius > 0) {
        filters.push(`drop-shadow(0 0 ${radius}px ${color})`);
        shadows.push(`0 0 ${Math.round(radius * 1.3)}px ${color}`);
      }
    }
  }

  return {
    filter: filters.length ? filters.join(" ") : undefined,
    boxShadow: shadows.length ? shadows.join(", ") : undefined
  };
}

export interface CompositionFilterEffects {
  /** Combined Gaussian blur radius in comp px (0 = none). */
  blurPx: number;
  /**
   * Whole-clip glow — strongest enabled glow, or null. `mode` "edge" blooms the alpha silhouette
   * (drop-shadow, for text/cutouts); "highlights" is a luminance bloom (bright areas glow outward, for
   * footage). `threshold` (0..1) + `strength` are only used in highlights mode.
   */
  glow: { radiusPx: number; color: string; mode: "edge" | "highlights"; threshold: number; strength: number } | null;
}

/**
 * Numeric sibling of `getEffectCss` for the single GPU compositor (Method 3, Phase 2). The DOM path
 * applies blur/glow as CSS `filter` on the (now hidden) media canvas, which the scene path can't see;
 * the scene path needs the same params as NUMBERS so it can run real GPU passes. This reads the exact
 * same effect params, defaults, keyframes (`evaluateTimelineEffectParam`) and masked-skip rule as
 * `getEffectCss` — keep the two in lockstep so DOM and GPU stay parity-aligned.
 *
 * Multiple blur effects compose in quadrature (`blur(a) blur(b)` ≈ Gaussian σ=√(a²+b²)); the single
 * blur case is exact. Multiple glows collapse to the largest-radius one (rare).
 */
export function getCompositionFilterEffects(
  layer: { effects?: unknown[] | undefined; animations?: TimelineKeyframeV2[] | undefined; startSeconds?: number | undefined },
  options: CompositionStyleOptions = {}
): CompositionFilterEffects {
  const layerStartSeconds = layer.startSeconds ?? 0;
  const currentTimeSeconds = options.currentTimeSeconds;
  let blurSq = 0;
  let glow: CompositionFilterEffects["glow"] = null;

  for (const rawEffect of layer.effects ?? []) {
    const effect = asRecord(rawEffect);
    if (effect.enabled === false) continue;
    // Same masked-skip as getEffectCss: a masked color/blur is handled by duplicate-layer expansion, so
    // it never reaches here masked; glow is the exception (region glow deferred → masked glow is whole-clip).
    if (effect.type !== "glow" && Array.isArray(effect.masks) && (effect.masks as Mask[]).some(isRenderableMask)) {
      continue;
    }
    const params = asRecord(effect.params);
    const effectId = stringOr(effect.id, "");
    const layerTimeSeconds = typeof currentTimeSeconds === "number" ? Math.max(0, currentTimeSeconds - layerStartSeconds) : undefined;
    const paramNumber = (key: string, fallback: number) =>
      evaluateTimelineEffectParam({ animations: layer.animations, baseValue: numberOr(params[key], fallback), effectId, paramKey: key, timeSeconds: layerTimeSeconds });
    const intensity = numberOr(effect.intensity, 50) / 100;

    if (effect.type === "blur") {
      const amount = paramNumber("amount", Math.round(18 * intensity));
      if (amount > 0) blurSq += amount * amount;
    } else if (effect.type === "glow") {
      const radius = paramNumber("radius", Math.round(24 * intensity));
      const color = stringOr(params.color, "#C9FF4A");
      const mode = stringOr(params.mode, "edge") === "highlights" ? "highlights" : "edge";
      // Threshold 0..100% → 0..1 luminance cutoff (highlights mode). Strength scales with the effect's
      // intensity (the "Mix" slider): 50% → 1×, 100% → 2× additive gain.
      const threshold = Math.max(0, Math.min(1, paramNumber("threshold", 55) / 100));
      const strength = Math.max(0, intensity * 2);
      if (radius > 0 && (!glow || radius > glow.radiusPx)) glow = { radiusPx: radius, color, mode, threshold, strength };
    }
  }

  return { blurPx: blurSq > 0 ? Math.sqrt(blurSq) : 0, glow };
}

export interface MaskedEffectOverlay {
  effectId: string;
  /** CSS to apply as `backdrop-filter` (blurs/affects the clip pixels behind the overlay). */
  backdropFilter: string;
  /** Mask CSS clipping the backdrop-filter to the effect's region (from getMaskCss). */
  maskCss: Record<string, string>;
}

/**
 * Effect-level (region) masks: an enabled effect that carries renderable masks renders as a
 * `backdrop-filter` overlay clipped to its mask, instead of affecting the whole clip — so the effect
 * is limited to a region and blends with the original pixels outside (no crop). Single-copy and
 * Chromium-native, so the live preview and the Remotion export match by construction.
 *
 * v1 supports `blur` (the marquee "blur a face/plate" case — the only backdrop-filterable stylize
 * effect we emit). Other effects keep applying globally even when masked, until added here.
 */
export function getMaskedEffectOverlays(
  layer: { id: string; effects?: unknown[] | undefined; animations?: TimelineKeyframeV2[] | undefined; startSeconds?: number | undefined },
  options: CompositionStyleOptions = {}
): MaskedEffectOverlay[] {
  const overlays: MaskedEffectOverlay[] = [];
  const layerStartSeconds = layer.startSeconds ?? 0;
  const layerTimeSeconds =
    typeof options.currentTimeSeconds === "number" ? Math.max(0, options.currentTimeSeconds - layerStartSeconds) : undefined;

  for (const rawEffect of layer.effects ?? []) {
    const effect = asRecord(rawEffect);
    if (effect.enabled === false) continue;
    const masks = Array.isArray(effect.masks) ? (effect.masks as Mask[]) : [];
    if (!masks.some(isRenderableMask)) continue;
    const params = asRecord(effect.params);
    const effectId = stringOr(effect.id, "");
    const intensity = numberOr(effect.intensity, 50) / 100;
    const paramNumber = (key: string, fallback: number) =>
      evaluateTimelineEffectParam({
        animations: layer.animations,
        baseValue: numberOr(params[key], fallback),
        effectId,
        paramKey: key,
        timeSeconds: layerTimeSeconds
      });

    if (effect.type === "blur") {
      const amount = paramNumber("amount", Math.round(18 * intensity));
      if (amount > 0) {
        overlays.push({ effectId, backdropFilter: `blur(${amount}px)`, maskCss: getMaskCss(layer.id, masks) });
      }
    }
  }
  return overlays;
}

export interface CompositionColorFilter {
  /** SVG `<filter>` id, stable per layer. */
  id: string;
  /** CSS value to append to a layer's `filter` (e.g. `"url(#orreris-color-…)"`). */
  filterRef: string;
  /** The serializable filter spec, for the renderer's `<defs>` injection. */
  svg: SvgColorFilter;
}

/**
 * Compile a layer's color effects (brightnessContrast / colorGrade / curves) into the
 * shared color pipeline and return the SVG filter both renderers apply (Phase 3 color
 * system). Returns `null` when the layer has no non-identity color effect, so the layer
 * carries no `filter` reference. Keyframed color params are resolved at `currentTimeSeconds`.
 */
interface ColorPipelineCacheEntry {
  animations: unknown;
  colorSettings: unknown;
  /** Any effect-scope keyframe forces a per-time recompile (over-conservative on purpose). */
  animated: boolean;
  timeKey: number | undefined;
  result: ColorPipeline | null;
}

// Keyed on the effects ARRAY identity: editor edits replace it immutably, so identity is the
// invalidation signal; WeakMap keeps entries GC-collectable in long sessions and across the
// Remotion worker's per-frame renders. Without this, every graded layer recompiled its full
// pipeline (stage allocation + tone-curve bakes) every frame — pure GC churn for static grades.
const colorPipelineCache = new WeakMap<object, ColorPipelineCacheEntry>();

export function getCompositionColorPipeline(
  layer: CompositionLayerStyleInput | TimelineLayer,
  options: CompositionStyleOptions = {}
): ColorPipeline | null {
  frameProfiler.bump("grade.pipeline.calls");
  const effects = (layer as { effects?: unknown[] | undefined }).effects;
  if (!effects?.length) {
    frameProfiler.bump("grade.pipeline.noEffects");
    return null;
  }
  const animations = layer.animations as TimelineKeyframeV2[] | undefined;
  const layerStartSeconds = layer.startSeconds ?? 0;
  const currentTimeSeconds = options.currentTimeSeconds;
  const layerTimeSeconds = typeof currentTimeSeconds === "number" ? Math.max(0, currentTimeSeconds - layerStartSeconds) : undefined;

  const colorSettings = options.colorSettings ?? LEGACY_PROJECT_COLOR_SETTINGS;
  const cached = colorPipelineCache.get(effects);
  if (
    cached &&
    cached.animations === animations &&
    cached.colorSettings === colorSettings &&
    // Keyframed layers only hit on the exact same resolved time — they recompile per new
    // frame time exactly like the uncached path (no quantization, zero pixel risk).
    (!cached.animated || cached.timeKey === layerTimeSeconds)
  ) {
    frameProfiler.bump("grade.pipeline.hits");
    return cached.result;
  }
  // Cache MISS → full pipeline rebuild (stage allocation + tone-curve bakes) below. A fresh `effects`
  // array each frame (e.g. Flarex `pipelineFor`) misses here EVERY frame — the "rebuilding grade
  // pipelines" signal the profiler is checking for.
  frameProfiler.bump("grade.pipeline.misses");

  const inputs: ColorEffectInput[] = [];
  for (const rawEffect of effects) {
    const effect = asRecord(rawEffect);
    if (effect.enabled === false) {
      continue;
    }
    const type = stringOr(effect.type, "");
    if (!COLOR_EFFECT_TYPES.has(type)) {
      continue;
    }
    // Same masked-skip rule as getEffectCss/getCompositionFilterEffects: a color effect that carries a
    // renderable region mask renders through the region machinery (duplicate-layer clones, whose copy is
    // mask-STRIPPED, or the scene compositor's masked region passes) — baking it here would grade the
    // WHOLE frame. This is what confined adjustment-layer masks: their stamped color effects reach the
    // grade only after `effectsWithLayerRegionMask`, i.e. always masked, so they must never bake globally.
    if (Array.isArray(effect.masks) && (effect.masks as Mask[]).some(isRenderableMask)) {
      continue;
    }
    const params = asRecord(effect.params);
    const effectId = stringOr(effect.id, "");

    // Graph curves carry a JSON `curve` param (ChannelCurves), not numeric sliders.
    if (type === "colorCurves") {
      const curves = parseChannelCurves(params.curve);
      if (curves) {
        inputs.push({ type, params: {}, intensity: numberOr(effect.intensity, 100), curves });
      }
      continue;
    }

    // Color wheels carry a JSON `wheels` param (ColorWheels).
    if (type === "colorWheels") {
      const wheels = parseColorWheels(params.wheels);
      if (wheels) {
        inputs.push({ type, params: {}, intensity: numberOr(effect.intensity, 100), wheels });
      }
      continue;
    }

    // Hue/Sat curves carry a JSON `curves` param (HueSatCurves) — WebGL-only HSL stage.
    if (type === "hueSatCurves") {
      const hueSatCurves = parseHueSatCurves(params.curves);
      if (hueSatCurves) {
        inputs.push({ type, params: {}, intensity: numberOr(effect.intensity, 100), hueSatCurves });
      }
      continue;
    }

    // HSL Secondary carries a JSON `secondary` param (HslSecondary) — WebGL-only HSL stage.
    if (type === "hslSecondary") {
      const secondary = parseSecondary(params.secondary);
      if (secondary) {
        inputs.push({ type, params: {}, intensity: numberOr(effect.intensity, 100), secondary });
      }
      continue;
    }

    // Creative look: carries `look` (name string) + `intensity` (number) scalar params.
    if (type === "creativeLook") {
      const lookName = typeof params.look === "string" ? params.look : "";
      const intensity = typeof params.intensity === "number" ? params.intensity : numberOr(effect.intensity, 100);
      if (lookName) {
        inputs.push({ type, params: { look: 0, intensity }, intensity: 100 });
        // Store look name via a string — pipeline.ts reads params.look directly
        const last = inputs[inputs.length - 1]!;
        (last.params as Record<string, unknown>)["look"] = lookName;
      }
      continue;
    }

    // Imported .cube LUT: deserialise base64 LUT from param and pass to pipeline.
    if (type === "importedLut") {
      const lutBase64 = typeof params.lut === "string" ? params.lut : "";
      if (lutBase64) {
        const importedLut3d = parseLutBase64(lutBase64);
        if (importedLut3d) {
          const paramIntensity = typeof params.intensity === "number" ? params.intensity : 100;
          const mixIntensity = numberOr(effect.intensity, 100);
          const intensity = Math.max(0, Math.min(100, (paramIntensity * mixIntensity) / 100));
          inputs.push({ type, params: { intensity }, intensity: 100, importedLut3d });
        }
      }
      continue;
    }

    const resolved: Record<string, number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== "number") {
        continue;
      }
      resolved[key] = evaluateTimelineEffectParam({ animations, baseValue: value, effectId, paramKey: key, timeSeconds: layerTimeSeconds });
    }
    inputs.push({ type, params: resolved, intensity: numberOr(effect.intensity, 100) });
  }

  let result: ColorPipeline | null = null;
  if (inputs.length > 0) {
    const pipeline = compileColorPipeline(inputs, colorSettings);
    result = pipeline.identity ? null : pipeline;
  }
  colorPipelineCache.set(effects, {
    animations,
    colorSettings,
    animated: (animations ?? []).some((keyframe) => keyframe.target.scope === "effect"),
    timeKey: layerTimeSeconds,
    result
  });
  return result;
}

/** Parse `#rgb`/`#rrggbb` to linear-ish 0..1 rgb (sRGB values, matches shader space). */
function hexToRgb01(hex: string): [number, number, number] {
  const m = hex.trim().replace(/^#/, "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) {
    return [0, 1, 0];
  }
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Build the per-frame pro stylize effects (vignette / grain / chroma key) a layer
 * carries, for the unified WebGL media shader. Numeric params are keyframe-resolved at
 * `currentTimeSeconds`; `timeSeconds` feeds the deterministic grain. Returns `null` when
 * the layer has none, so the renderer skips the stylize uniforms entirely.
 */
export function getCompositionMediaEffects(
  layer: CompositionLayerStyleInput | TimelineLayer,
  options: CompositionStyleOptions = {}
): MediaEffects | null {
  const effects = (layer as { effects?: unknown[] | undefined }).effects;
  if (!effects?.length) {
    return null;
  }
  const animations = layer.animations as TimelineKeyframeV2[] | undefined;
  const layerStartSeconds = layer.startSeconds ?? 0;
  const currentTimeSeconds = options.currentTimeSeconds;
  const layerTimeSeconds = typeof currentTimeSeconds === "number" ? Math.max(0, currentTimeSeconds - layerStartSeconds) : undefined;

  let vignette: MediaEffects["vignette"] = null;
  let grain: MediaEffects["grain"] = null;
  let chromaKey: MediaEffects["chromaKey"] = null;

  for (const rawEffect of effects) {
    const effect = asRecord(rawEffect);
    if (effect.enabled === false) {
      continue;
    }
    const type = stringOr(effect.type, "");
    const params = asRecord(effect.params);
    const effectId = stringOr(effect.id, "");
    const intensity = numberOr(effect.intensity, 100) / 100;
    const num = (key: string, fallback: number) =>
      evaluateTimelineEffectParam({ animations, baseValue: numberOr(params[key], fallback), effectId, paramKey: key, timeSeconds: layerTimeSeconds });

    if (type === "vignette") {
      const amount = (num("amount", 35) / 100) * intensity;
      if (amount > 0.001) {
        vignette = {
          amount: Math.min(1, amount),
          size: Math.min(1, Math.max(0, num("size", 58) / 100)),
          // Defaults reproduce the pre-param shader exactly: feather 100% = fall to the frame
          // corner, roundness 0 = legacy UV circle, highlights 0 = plain multiply.
          feather: Math.min(1, Math.max(0, num("feather", 100) / 100)),
          roundness: Math.min(1, Math.max(0, num("roundness", 0) / 100)),
          highlights: Math.min(1, Math.max(0, num("highlights", 0) / 100))
        };
      }
    } else if (type === "grain") {
      const amount = (num("amount", 18) / 100) * intensity;
      if (amount > 0.001) {
        // Scale to a tasteful range — full slider ≈ 0.25 rgb noise, not blowout.
        // size 100% = the legacy 1280×720 virtual grain grid; >100% = coarser grain.
        grain = { amount: Math.min(1, amount) * 0.25, size: Math.min(4, Math.max(0.25, num("size", 100) / 100)) };
      }
    } else if (type === "chromaKey") {
      // tolerance/softness live in the normalized CbCr-distance domain (0 = the key color's
      // chroma, ~1 = a full key-chroma-magnitude away) — luminance-independent, any key color.
      chromaKey = {
        color: hexToRgb01(stringOr(params.color, "#00FF00")),
        tolerance: Math.max(0.001, num("tolerance", 30) / 100),
        softness: Math.max(0.02, num("softness", 12) / 100),
        despill: Math.min(1, Math.max(0, num("despill", 60) / 100)),
        choke: Math.min(0.99, Math.max(0, num("choke", 0) / 100)),
        matteView: params.matteView === true
      };
    }
  }

  if (!vignette && !grain && !chromaKey) {
    return null;
  }
  return { vignette, grain, chromaKey, timeSeconds: layerTimeSeconds ?? 0 };
}

/**
 * Resolve a layer's audio gain multiplier (0..1+) at `currentTimeSeconds` from its `volume`
 * effect, keyframe-aware via the same `evaluateTimelineEffectParam` used by color params. Returns
 * `1` (unchanged) when the layer has no enabled volume effect. All three audio paths (preview
 * playback, local export mixer, Remotion `<Audio volume>`) sample this so a fade/gain stays in sync.
 */
export function getCompositionVolume(
  layer: CompositionLayerStyleInput | TimelineLayer,
  options: CompositionStyleOptions = {}
): number {
  const effects = (layer as { effects?: unknown[] | undefined }).effects;
  if (!effects?.length) {
    return 1;
  }
  const animations = layer.animations as TimelineKeyframeV2[] | undefined;
  const layerStartSeconds = layer.startSeconds ?? 0;
  const currentTimeSeconds = options.currentTimeSeconds;
  const layerTimeSeconds = typeof currentTimeSeconds === "number" ? Math.max(0, currentTimeSeconds - layerStartSeconds) : undefined;

  let gainPercent = 100;
  let found = false;
  for (const rawEffect of effects) {
    const effect = asRecord(rawEffect);
    if (effect.enabled === false || stringOr(effect.type, "") !== "volume") {
      continue;
    }
    const params = asRecord(effect.params);
    const effectId = stringOr(effect.id, "");
    gainPercent = evaluateTimelineEffectParam({
      animations,
      baseValue: numberOr(params.gain, 100),
      effectId,
      paramKey: "gain",
      timeSeconds: layerTimeSeconds
    });
    found = true;
  }

  return found ? Math.max(0, gainPercent / 100) : 1;
}

/**
 * The SVG-filter form of a layer's color (DOM/SVG render path). Wraps
 * `getCompositionColorPipeline` — the WebGL engine consumes the pipeline directly.
 */
export function getCompositionColorFilter(
  layer: CompositionLayerStyleInput | TimelineLayer,
  options: CompositionStyleOptions = {}
): CompositionColorFilter | null {
  const layerId = stringOr((layer as { id?: unknown }).id, "");
  if (!layerId) {
    return null;
  }
  const pipeline = getCompositionColorPipeline(layer, options);
  if (!pipeline) {
    return null;
  }
  const id = `orreris-color-${layerId}`;
  const svg = pipelineToSvgFilter(pipeline, id);
  if (!svg) {
    return null;
  }
  return { id, filterRef: `url(#${id})`, svg };
}

function parsePointArray(value: unknown): CurvePoint[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const points = value
    .filter((p): p is { x: number; y: number } => typeof p === "object" && p !== null && typeof (p as { x?: unknown }).x === "number" && typeof (p as { y?: unknown }).y === "number")
    .map((p) => ({ x: p.x, y: p.y }));
  return points.length ? points : undefined;
}

/** Parse the `colorCurves` JSON `curve` param into ChannelCurves; null when absent/invalid/empty. */
function parseChannelCurves(value: unknown): ChannelCurves | null {
  if (typeof value !== "string" || !value.trim() || value.trim() === "{}") {
    return null;
  }
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const curves: ChannelCurves = {};
    const master = parsePointArray(raw.master);
    const red = parsePointArray(raw.red);
    const green = parsePointArray(raw.green);
    const blue = parsePointArray(raw.blue);
    if (master) curves.master = master;
    if (red) curves.red = red;
    if (green) curves.green = green;
    if (blue) curves.blue = blue;
    return master || red || green || blue ? curves : null;
  } catch {
    return null;
  }
}

function parseWheel(value: unknown): { x: number; y: number; master: number } {
  const w = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    x: typeof w.x === "number" ? w.x : 0,
    y: typeof w.y === "number" ? w.y : 0,
    master: typeof w.master === "number" ? w.master : 0
  };
}

/** Parse the `colorWheels` JSON `wheels` param into ColorWheels; null when absent/identity. */
function parseColorWheels(value: unknown): ColorWheels | null {
  if (typeof value !== "string" || !value.trim() || value.trim() === "{}") {
    return null;
  }
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const wheels: ColorWheels = {
      shadows: parseWheel(raw.shadows),
      midtones: parseWheel(raw.midtones),
      highlights: parseWheel(raw.highlights)
    };
    const neutral = (w: { x: number; y: number; master: number }) => w.x === 0 && w.y === 0 && w.master === 0;
    return neutral(wheels.shadows) && neutral(wheels.midtones) && neutral(wheels.highlights) ? null : wheels;
  } catch {
    return null;
  }
}

/** Parse the `hueSatCurves` JSON `curves` param into HueSatCurves; null when absent/empty. */
function parseHueSatCurves(value: unknown): HueSatCurves | null {
  if (typeof value !== "string" || !value.trim() || value.trim() === "{}") {
    return null;
  }
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const curves: HueSatCurves = {};
    const hueVsHue = parsePointArray(raw.hueVsHue);
    const hueVsSat = parsePointArray(raw.hueVsSat);
    const hueVsLuma = parsePointArray(raw.hueVsLuma);
    const lumaVsSat = parsePointArray(raw.lumaVsSat);
    const satVsSat = parsePointArray(raw.satVsSat);
    if (hueVsHue) curves.hueVsHue = hueVsHue;
    if (hueVsSat) curves.hueVsSat = hueVsSat;
    if (hueVsLuma) curves.hueVsLuma = hueVsLuma;
    if (lumaVsSat) curves.lumaVsSat = lumaVsSat;
    if (satVsSat) curves.satVsSat = satVsSat;
    return hueVsHue || hueVsSat || hueVsLuma || lumaVsSat || satVsSat ? curves : null;
  } catch {
    return null;
  }
}

/** Parse the `hslSecondary` JSON `secondary` param into HslSecondary (filled from neutral defaults). */
function parseSecondary(value: unknown): HslSecondary | null {
  if (typeof value !== "string" || !value.trim() || value.trim() === "{}") {
    return null;
  }
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const n = (key: keyof HslSecondary): number => (typeof raw[key] === "number" ? (raw[key] as number) : (NEUTRAL_SECONDARY[key] as number));
    return {
      hueCenter: n("hueCenter"),
      hueWidth: n("hueWidth"),
      satMin: n("satMin"),
      satMax: n("satMax"),
      lumMin: n("lumMin"),
      lumMax: n("lumMax"),
      softness: n("softness"),
      invert: typeof raw.invert === "boolean" ? raw.invert : NEUTRAL_SECONDARY.invert,
      hueShift: n("hueShift"),
      satScale: n("satScale"),
      lumScale: n("lumScale"),
      showMask: typeof raw.showMask === "boolean" ? raw.showMask : NEUTRAL_SECONDARY.showMask
    };
  } catch {
    return null;
  }
}

/** Deserialise a base64-encoded LUT string to a Lut3d; returns null on failure. */
function parseLutBase64(value: unknown): Lut3d | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return lut3dFromBase64(value);
}

/** Merge a layer's CSS effect filter with its color-pipeline `url(#…)` reference. */
function combineFilter(cssFilter: string | undefined, colorFilter: CompositionColorFilter | null): string | undefined {
  const parts = [cssFilter, colorFilter?.filterRef].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * What a timeline layer contributes to the picture right now, for decode admission (ADR-012 §6.3,
 * slice S4.3).
 *
 * ## Where this lives, and why not in the kernel
 *
 * The kernel owns the VOCABULARY (`VisibleContribution`) and the ranking; it must never learn what a
 * `TimelineLayer` is — I-36 keeps it free of product types as surely as it keeps it free of the DOM.
 * The derivation is a product question ("what does a layer contribute?"), so it lives beside the other
 * composition accessors and every host — preview, export, a headless harness — computes it the same way.
 *
 * ## What is deliberately NOT folded in
 *
 * Two flags that look like zero contribution and are not, both named at `AcquireOptions.contribution`:
 *
 *  - **`hidden`** — a pre-roll shell, about to be on screen. Ranking it at zero denies the decoder that
 *    exists precisely to make the next cut instant, so pre-roll would defeat itself.
 *  - **`suspended`** — a demoted source (a comp proxy is serving). **I-24: a presentation policy MUST
 *    NOT change resource lifetime.** Demotion suspends the pull, never the session; letting it lower a
 *    rank would let a presentation decision evict a decoder, which is the exact coupling S3.5 removed.
 *
 * Neither is a caller's option to override, which is why they are absent from the signature rather than
 * defaulted in it.
 *
 * ## Area is an estimate, and says so
 *
 * True contributed area needs occlusion and the composited draw rect, which the scene builder owns and
 * the acquire path cannot see. `scale²` clamped to 1 is the honest approximation for media, which fills
 * its frame by default: it is monotonic in the quantity that matters and never claims more than the
 * output. When the draw-rect owner can supply a real figure it replaces this without changing the shape.
 */
export function getLayerVisibleContribution(
  layer: Pick<CompositionLayerStyleInput, "startSeconds" | "transform" | "keyframes" | "animations"> | undefined,
  options: CompositionStyleOptions & { reachable?: boolean; underDisabledBranch?: boolean } = {}
): VisibleContribution {
  const transform = getCompositionTransform(layer, options);
  const scale = Number.isFinite(transform.scale) ? Math.max(0, transform.scale) : 1;
  return {
    reachable: options.reachable !== false,
    area: Math.min(1, scale * scale),
    opacity: Math.min(1, Math.max(0, transform.opacity / 100)),
    underDisabledBranch: options.underDisabledBranch === true,
  };
}
