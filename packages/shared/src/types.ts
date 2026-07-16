import type { z } from "zod";
import type { PluginEffectManifest, PluginLookManifest, PluginTransitionManifest } from "./plugin-manifest";
import type { ProjectColorSettings, SourceColorMetadata } from "./color/color-management";

export const moduleTypes = [
  "PERSON_EXTRACTION",
  "PERSON_TRACKING",
  "BACKGROUND_REMOVAL",
  "PERSON_REMOVAL",
  "TEXT_BEHIND_PERSON",
  "SMART_3D_FOLLOW_TEXT",
  "AUTO_CAPTIONS",
  "BEAT_SYNC",
  "ZOOM_CUTS",
  "BACKGROUND_REPLACEMENT",
  "MOTION_TEXT",
  "FINAL_RENDER"
] as const;

export type ModuleType = (typeof moduleTypes)[number];

export type AssetKind =
  | "source_video"
  | "source_audio"
  | "person_mask"
  | "person_cutout"
  | "background_plate"
  | "tracking_data"
  | "caption_data"
  | "beat_map"
  | "motion_text_layer"
  | "preview_video"
  | "final_video"
  | "project_graph";

export type ModuleStatus = "available" | "mocked" | "experimental";
export type ProjectStatus = "draft" | "preview_ready" | "export_ready" | "archived";
export type JobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
export type JobType = "preview" | "final";

/** Where an asset came from — drives the media-library tab grouping + source badge. */
export type AssetSource =
  | "local"
  | "ai"
  | "pexels"
  | "unsplash"
  | "graphic"
  | "timeline-generated"
  | "brand";

/** Provenance for a stock/graphic-imported asset (we save a local copy; this records the origin). */
export interface AssetExternalRef {
  provider: "pexels" | "unsplash" | "iconify";
  externalId: string;
  author?: string | undefined;
  sourceUrl?: string | undefined;
  license?: string | undefined;
}

/** A normalized stock-provider search result (before import into our storage). */
/** One downloadable quality/resolution of a stock result (e.g. 4K / 1080p / SD). */
export interface StockVariant {
  /** Human label shown in the quality picker (e.g. "4K", "1080p", "SD", "Original"). */
  label: string;
  downloadUrl: string;
  fileType: string;
  width?: number | undefined;
  height?: number | undefined;
  quality?: string | undefined;
}

export interface StockResult {
  /** Internal only — never shown in the UI (unified, provider-agnostic Search surface). */
  provider: "pexels";
  externalId: string;
  type: "image" | "video";
  /** Small preview/thumbnail URL for the result grid. */
  thumbnailUrl: string;
  /** Lightweight video URL for hover-preview (videos only); the smallest variant. */
  previewUrl?: string | undefined;
  /** Best media URL to download on import (the highest-quality variant). */
  downloadUrl: string;
  width: number;
  height: number;
  durationSeconds?: number | undefined;
  author?: string | undefined;
  sourceUrl?: string | undefined;
  fileType: string;
  /** Available qualities/resolutions, best-first; powers the quality picker. */
  variants?: StockVariant[] | undefined;
}

export type StockOrientation = "all" | "horizontal" | "vertical" | "square";

/** Provenance for an AI-generated asset. */
export interface AssetAiRef {
  model?: string | undefined;
  prompt?: string | undefined;
  seed?: string | undefined;
  referenceAssetIds?: string[] | undefined;
}

export interface SourceAsset {
  id: string;
  userId: string;
  fileName: string;
  fileType: string;
  fileUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  status: "uploaded" | "processing" | "ready" | "failed";
  createdAt: string;
  // --- Media-library metadata (all optional; older assets/clips keep working) ---
  /** Origin of the asset. Absent = treat as "local". */
  source?: AssetSource | undefined;
  /** Virtual category path, e.g. "local/video", "stock/pexels/image", "generated/snapshot". */
  folder?: string | undefined;
  /** Free-form search tags. */
  tags?: string[] | undefined;
  /** Display name (may differ from fileName); falls back to fileName. */
  originalName?: string | undefined;
  /** Poster/thumbnail URL (data URL client-side, or stored URL). */
  thumbnailUrl?: string | undefined;
  /** Lower-res preview/proxy URL used for playback when present. */
  previewUrl?: string | undefined;
  /** Transcoded proxy URL (preferred for playback over fileUrl when present). */
  proxyUrl?: string | undefined;
  /** Server copy URL once the asset has been uploaded to cloud (worker-fetchable). */
  cloudUrl?: string | undefined;
  fps?: number | undefined;
  sizeBytes?: number | undefined;
  /** Optional project binding for project-specific generated assets. */
  projectId?: string | undefined;
  /** Owner project for uploaded (local) media. null/absent = user-level library asset (brand/ai/stock),
   *  reusable across projects. A project's bin = its owned uploads + assets linked to it (ProjectAsset). */
  ownerProjectId?: string | null | undefined;
  updatedAt?: string | undefined;
  external?: AssetExternalRef | undefined;
  ai?: AssetAiRef | undefined;
  /**
   * Detected/assumed source color metadata (primaries/transfer/matrix/range). Absent → assume Rec.709
   * SDR. Detected at ingest/decode (Phase 3); persisted in `SourceAsset.colorJson` and carried into the
   * render manifest so both export paths know each source's color space.
   */
  color?: SourceColorMetadata | undefined;
  /**
   * Container display rotation (0/90/180/270°) read from the MP4 `tkhd` matrix at ingest. Phone
   * footage is often stored landscape-coded with a rotation flag; `<video>` playback applies it, but
   * the WebCodecs decode path emits CODED (unrotated) frames, so the render engine must rotate them to
   * match. Absent/0 = no rotation (the common case) and takes an untouched no-op path in the renderer.
   * Note: `width`/`height` are the DISPLAY dims (read from a `<video>`, already rotation-corrected).
   */
  rotationDegrees?: 0 | 90 | 180 | 270 | undefined;
}

export interface DerivedAsset {
  id: string;
  sourceAssetId: string;
  type: AssetKind;
  configHash: string;
  fileUrl?: string;
  jsonData?: unknown;
  status: "queued" | "processing" | "ready" | "failed";
  createdAt: string;
}

export interface EffectModule {
  id: string;
  type: ModuleType;
  name: string;
  description: string;
  inputTypes: AssetKind[];
  outputTypes: AssetKind[];
  configSchema: z.ZodTypeAny;
  estimatedCostCredits: number;
  status: ModuleStatus;
}

export interface PublicEffectModule extends Omit<EffectModule, "configSchema"> {
  configFields: EditableFieldDefinition[];
}

export interface ProjectEffect {
  id: string;
  type: ModuleType;
  name: string;
  input: AssetKind[];
  output: AssetKind[];
  config: Record<string, unknown>;
  status: "idle" | "queued" | "processing" | "ready" | "failed";
}

/**
 * The text-appearance subset of a {@link TimelineLayer} — the fields a saved Text Style captures and
 * bakes. Deliberately excludes text CONTENT, transform/geometry, width, warp, effects and keyframes:
 * a style is *how text looks*, not what it says or where it sits. See `captureTextStyle`/`applyTextStyle`.
 */
export interface TextStyleFields {
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  fontWeight?: number | undefined;
  italic?: boolean | undefined;
  letterSpacing?: number | undefined;
  lineHeight?: number | undefined;
  color?: string | undefined;
  strokeColor?: string | undefined;
  strokeWidth?: number | undefined;
  backgroundColor?: string | undefined;
  backgroundPaddingEm?: number | undefined;
  backgroundRadiusEm?: number | undefined;
  shadowColor?: string | undefined;
  shadowBlur?: number | undefined;
  shadowOffsetX?: number | undefined;
  shadowOffsetY?: number | undefined;
  textAlign?: "left" | "center" | "right" | undefined;
}

/** A named, reusable text look saved in the project (§2 Text Styles). Applied by BAKING its fields
 *  onto a text layer (one-shot — no live link). Project-local; lives in {@link ProjectGraph.textStyles}. */
export interface TextStyle {
  id: string;
  name: string;
  style: TextStyleFields;
}

export interface ProjectGraph {
  projectId: string;
  sourceAssetId?: string | undefined;
  effects: ProjectEffect[];
  editableFields: Record<string, unknown>;
  /** Saved reusable text looks (§2). Project-local, one-shot apply. Absent on projects with none. */
  textStyles?: TextStyle[] | undefined;
  plugins?: {
    effects?: PluginEffectManifest[] | undefined;
    looks?: PluginLookManifest[] | undefined;
    transitions?: PluginTransitionManifest[] | undefined;
  } | undefined;
  composition?: TimelineComposition | undefined;
  /** Auxiliary compositions, used by imported nested timelines/templates. `composition` remains the active/root timeline. */
  compositions?: Record<string, TimelineComposition> | undefined;
  version: number;
}

/** Responsive Pin (§1) axes. "center" (or unset) = hold the box CENTER at a constant percent (today's
 *  behavior); an edge value holds THAT edge of the painted box at a constant percent on reframe. */
export type PinX = "left" | "center" | "right";
export type PinY = "top" | "center" | "bottom";
export interface LayerResponsivePin {
  x?: PinX | undefined;
  y?: PinY | undefined;
}

/** Responsive Time (§5) — protected head/tail durations (layer-local seconds). When the clip's
 *  DURATION changes, keyframes inside these zones keep their crafted timing (head held to the start,
 *  tail re-anchored to the new end) and only the middle stretches. Absent = uniform proportional squeeze. */
export interface LayerResponsiveTime {
  introSeconds: number;
  outroSeconds: number;
}

export type TimelineLayerType = "video" | "image" | "text" | "audio" | "shape" | "adjustment";
export type TimelineTrackType = "video" | "text" | "audio" | "overlay";
export type ShapeKind = "rectangle" | "rounded-rectangle" | "ellipse" | "line" | "triangle" | "diamond" | "pentagon" | "pen";

export interface TimelineVector2 {
  x: number;
  y: number;
}

/**
 * Layer blend mode (how this layer composites over the layers below it). Chosen for DOM↔canvas parity:
 * each value maps 1:1 to a CSS `mix-blend-mode` and a canvas `globalCompositeOperation` (see
 * `cssBlendMode`/`canvasBlendOp` in composition-style). `normal` is the default (plain over-compositing).
 */
export type BlendMode =
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
  | "add";

export interface TimelineTransform {
  position: TimelineVector2;
  scale: number;
  rotation: number;
  opacity: number;
  /** Perspective tilt around the horizontal axis, degrees. Default 0 (no 3D tilt). */
  rotateX?: number | undefined;
  /** Perspective tilt around the vertical axis, degrees. Default 0 (no 3D tilt). */
  rotateY?: number | undefined;
  /** CSS perspective distance in px applied to the layer's parent. Default 0 = no perspective. */
  perspective?: number | undefined;
  /** translateZ in px, used for depth ordering/parallax. Default 0. */
  z?: number | undefined;
}

/**
 * Content transform — positions the SOURCE MEDIA *within* the clip's frame box, independent of the
 * comp-space {@link TimelineTransform} (which moves the whole frame). This is the "adjust the media inside
 * the clip" model (CapCut/Canva): reframe a mismatched-aspect source (e.g. a 9:16 video in a 16:9 comp),
 * pan/zoom the visible part, and crop the frame edges — all without pushing the layer off-canvas. All fields
 * optional, defaults = identity, so existing projects are unchanged. Only meaningful for media (video/image).
 */
export interface LayerContentTransform {
  /** Zoom the source within the frame. 1 = object-fit baseline; >1 zooms in (shows less of the source). */
  scale?: number | undefined;
  /** Pan the source within the frame, as a fraction of the frame (-1..1). 0 = centered, +1 = one frame over. */
  offsetX?: number | undefined;
  offsetY?: number | undefined;
  /** Crop insets — fraction (0..1) trimmed off each edge of the frame (the trimmed area shows what's below). */
  crop?: { top?: number; right?: number; bottom?: number; left?: number } | undefined;
}

/**
 * Editable vector graphic carried directly on a layer (Search → Graphics pick). The SVG is stored normalized
 * so every recolorable fill/stroke reads `currentColor`; `fill` is the current solid color the renderer bakes
 * in (via `graphicToDataUrl`). Vector, so it stays crisp at any scale and recolorable forever — no rasterized
 * asset, no file dependency. `naturalWidth`/`naturalHeight` retain the source viewBox aspect for framing.
 */
export interface LayerGraphic {
  svg: string;
  fill: string;
  naturalWidth?: number | undefined;
  naturalHeight?: number | undefined;
  /**
   * Multicolor graphics (SVGs baked with several paints, e.g. Iconify color icons): one slot per
   * distinct source color. `from` is the literal in the stored SVG, `to` the user's current choice
   * (initially === `from`). Applied as exact-literal substitutions at `graphicToDataUrl` bake time —
   * shared code, so preview/local export/Remotion recolor identically. Single-color graphics use
   * `fill` + `currentColor` instead and carry no palette.
   */
  palette?: Array<{ from: string; to: string }> | undefined;
  /**
   * Playback overrides for a SMIL-animated graphic (line-md-style packs). Both fields are optional and
   * absent by default — the SVG's OWN intent wins (its `dur` cycle; `repeatCount="indefinite"` → loop,
   * `fill="freeze"` one-shot → play once and hold). Set per layer from the Graphic inspector panel.
   * Resolved for every renderer by `resolveGraphicAnimation`; ignored on non-animated graphics.
   */
  animation?:
    | {
        /** `"once"` = play through then hold the final frame; `"infinite"` = repeat for the clip. */
        loop?: GraphicLoopMode | undefined;
        /** Seconds for ONE cycle on the timeline. Differing from the SVG's natural cycle time-scales
         *  playback (slower/faster) without re-authoring the SVG. */
        durationSeconds?: number | undefined;
      }
    | undefined;
}

/** How a SMIL-animated graphic repeats over its clip. See {@link LayerGraphic.animation}. */
export type GraphicLoopMode = "once" | "infinite";

/**
 * Unified vector-mask model (Premiere/AE-style), reused by clip-level masks, effect-level masks, and
 * later color/adjustment/AI masks. Masks are stored in the layer's *local comp-pixel space* (the
 * untransformed layer box == comp size), so applying the mask to the transformed layer element makes it
 * follow the clip's Transform. Rendered to an SVG `<mask>` consumed identically by both renderers — see
 * `clip-masks.ts`. All new; `masks?` is optional everywhere so existing projects keep working.
 */
export type MaskMode = "add" | "subtract" | "intersect" | "exclude";
export type MaskShape = "rectangle" | "ellipse" | "polygon" | "bezier";
/** Where a mask's geometry came from. `manual`/`shape` today; the rest are future-ready (Phase 6). */
export type MaskSource = "manual" | "shape" | "ai-object" | "tracking" | "imported-alpha";

export interface MaskPoint {
  id: string;
  x: number;
  y: number;
  /** Cubic Bezier control handles (relative to the point), used by polygon/bezier shapes. */
  inTangent?: { x: number; y: number } | undefined;
  outTangent?: { x: number; y: number } | undefined;
  lockedTangents?: boolean | undefined;
}

/** Path snapshot at a time, for mask-path keyframing (Phase 5). Point arrays aren't `AnimatedValue`. */
export interface MaskPathKeyframe {
  id: string;
  timeSeconds: number;
  points: MaskPoint[];
  interpolation: KeyframeInterpolation;
}

export interface Mask {
  id: string;
  name: string;
  enabled: boolean;
  shape: MaskShape;
  mode: MaskMode;
  source?: MaskSource | undefined;
  /** Outline points in layer-local comp-pixel space. */
  points: MaskPoint[];
  /** Edge softness in px. */
  feather: number;
  /** Grow (+) / shrink (-) the mask in px. */
  expansion: number;
  /** 0–100 multiplier on this mask's alpha. */
  opacity: number;
  /** Rounds the mask outline's corners, in px (rectangle masks only). Absent/0 = sharp corners. */
  cornerRadius?: number | undefined;
  inverted: boolean;
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
  /** Phase 5: per-property keyframes use the layer `animations` array; path uses this dedicated list. */
  pathKeyframes?: MaskPathKeyframe[] | undefined;
}

export const timelineEffectTypes = [
  "blur",
  "brightnessContrast",
  "colorGrade",
  "curves",
  "colorCurves",
  "colorWheels",
  "hueSatCurves",
  "hslSecondary",
  "creativeLook",
  "importedLut",
  "glow",
  "grain",
  "shadow",
  "vignette",
  "zoom",
  "motionBlur",
  "chromaKey",
  "volume",
  "audioEq",
  "audioCompressor",
  "audioGate",
  "audioLimiter",
  "pluginShader",
  "radialBlur",
  "directionalBlur",
  "sharpen",
  "pixelate",
  "chromaticAberration"
] as const;

export type TimelineEffectType = (typeof timelineEffectTypes)[number];
export type TimelineEffectParamValue = string | number | boolean;

export interface TimelineEffect {
  id: string;
  type: TimelineEffectType;
  name: string;
  enabled: boolean;
  intensity: number;
  params?: Record<string, TimelineEffectParamValue> | undefined;
  /** Optional masks limiting this effect to an area (Phase 4). Empty/absent = effect applies everywhere. */
  masks?: Mask[] | undefined;
}

export interface TimelineKeyframe {
  id: string;
  property: "position.x" | "position.y" | "scale" | "rotation" | "opacity";
  timeSeconds: number;
  value: number;
  easing: "linear" | "easeIn" | "easeOut" | "easeInOut";
}

export type AnimatedValue =
  | number
  | string
  | boolean
  | TimelineVector2
  | { r: number; g: number; b: number; a?: number | undefined };

export type KeyframeTargetScope = "layer" | "effect" | "mask" | "track" | "composition";
export type KeyframeInterpolation = "hold" | "linear" | "ease" | "easeIn" | "easeOut" | "easeInOut" | "bezier" | "autoBezier";

export interface KeyframeHandle {
  dx: number;
  dy: number;
}

export interface TimelineKeyframeV2 {
  id: string;
  target: {
    scope: KeyframeTargetScope;
    property: string;
    effectId?: string | undefined;
    /** Identifies which mask a `scope: "mask"` keyframe animates (feather/expansion/opacity/transform). */
    maskId?: string | undefined;
    component?: "x" | "y" | "r" | "g" | "b" | "a" | undefined;
  };
  timeSeconds: number;
  value: AnimatedValue;
  interpolation: KeyframeInterpolation;
  temporal: {
    in?: KeyframeHandle | undefined;
    out?: KeyframeHandle | undefined;
    linked?: boolean | undefined;
  };
  spatial?: {
    interpolation: "linear" | "bezier" | "autoBezier";
    inTangent?: TimelineVector2 | undefined;
    outTangent?: TimelineVector2 | undefined;
    linked?: boolean | undefined;
  } | undefined;
}

export interface TextRun {
  text: string;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  color?: string | undefined;
  /** Per-run highlight (text marker) — rendered as the run's background in every renderer. */
  backgroundColor?: string | undefined;
  fontFamily?: string | undefined;
  fontSizeMultiplier?: number | undefined;
}

/**
 * A SOURCE TEXT keyframe (Premiere-style): the layer's text content at/after `timeSeconds`
 * (layer-local), HOLD semantics — the active entry is the last one at or before the playhead,
 * and the first entry also covers t=0..first. Lets users author word/line reveals (typewriter
 * variants) by keyframing the text itself; `getVisibleTextRuns` resolves it in every renderer.
 */
export interface SourceTextKeyframe {
  id: string;
  timeSeconds: number;
  runs: TextRun[];
}

/**
 * Reference attached to a visual layer that tells every renderer to composite the
 * layer through a matte (alpha cutout). This is the real, renderer-read signal that
 * replaces the old `withMaskMetadata` disabled-`chromaKey` placeholder.
 *
 * The matte is produced by the Extract Person tool and stored as an artifact. The
 * canonical form is a grayscale "luma" matte video (white = keep, black = drop) sampled
 * per frame; `alpha` means the matte source already carries a usable alpha channel.
 */
export interface MatteRef {
  /** Tool artifact id holding the matte (resolved to `uri` at render time). */
  artifactId: string;
  /** Resolved matte source URL (luma-matte video / sprite / alpha video). */
  uri?: string | undefined;
  /** `luma` = grayscale matte (canonical). `alpha` = source already has alpha. */
  kind: "luma" | "alpha";
  /** Matte playback rate so a frame time can be mapped to a matte sample. */
  fps: number;
  /** Edge softness in pixels applied during compositing. */
  feather: number;
  /** Fast = lighter preview matte; clean = higher-quality baked matte. */
  edgeMode: "fast" | "clean";
  /** Invert the matte (e.g. drop the subject instead of the background). */
  invert?: boolean | undefined;
  /** Extra multiplier on the resulting alpha (0-1). */
  opacity?: number | undefined;
}

export type TextWarpStyle = "none" | "arc" | "arcLower" | "arch" | "bulge" | "wave" | "flag" | "fisheye";

export interface TextWarp {
  style: TextWarpStyle;
  /** -100..100. Direction/magnitude of the primary distortion. */
  bend: number;
  /** -100..100. Extra horizontal skew applied on top of the style's base map. */
  distortH: number;
  /** -100..100. Extra vertical skew applied on top of the style's base map. */
  distortV: number;
}

/**
 * The transition vocabulary. Opacity kinds (`fadeIn`/`fadeOut`/`crossDissolve`) and the
 * geometry kinds (`slide`/`push`/`zoom`) are realised as `_transition_`-tagged keyframes the
 * shared animation evaluator already drives, so every renderer matches for free. `dip` is a
 * transient solid-colour layer at the cut. `wipe`/`iris` are real per-pixel GPU reveals done in
 * the shared media shader (`MediaWebGLRenderer`), driven by `TransitionSpec` + the time-derived
 * progress from `getCompositionTransition`.
 */
export type BuiltInTransitionKind =
  // Per-clip edge fades (keyframe-driven, no second clip to mix).
  | "fadeIn"
  | "fadeOut"
  // Basic junction kinds (GPU two-texture engine).
  | "crossDissolve"
  | "dip"
  | "slide"
  | "push"
  | "zoom"
  | "wipe"
  | "iris"
  // Creator pack (GPU two-texture engine).
  | "punchZoom"
  | "zoomBlur"
  | "whipPan"
  | "blurSwipe"
  | "flash"
  | "shake"
  | "spin"
  // Cinematic.
  | "lumaFade"
  | "lightLeak"
  | "filmBurn"
  | "parallaxPush"
  // Glitch.
  | "glitch"
  | "pixelate"
  // Mask.
  | "maskReveal";

export type TransitionKind = BuiltInTransitionKind | (string & {});

export type TransitionDirection = "left" | "right" | "up" | "down";

/**
 * A junction (or edge) transition's full description. Stored on the incoming clip as
 * `transitionIn` so the timeline element knows its kind for label/resize, and so the shader
 * kinds (`wipe`/`iris`) can be read by all three renderers. `durationSeconds` is the overlap
 * (junction) or fade (edge) length; `direction` applies to slide/push/wipe; `mode` to zoom/iris
 * (`in`/`out`); `softness` to wipe/iris edge; `color` to dip.
 */
export interface TransitionSpec {
  /** Registry id of the transition (the manifest contract; see `color/transitions/registry`). */
  kind: TransitionKind;
  durationSeconds: number;
  direction?: TransitionDirection | undefined;
  mode?: "in" | "out" | undefined;
  softness?: number | undefined;
  color?: string | undefined;
  /**
   * Per-transition param overrides keyed by the registry param name (e.g. `strength`, `motionBlur`,
   * `flashColor`). Values not present fall back to the definition default. Legacy `direction`/`mode`/
   * `softness`/`color` are mapped into params by the renderers for back-compat.
   */
  params?: Record<string, number | number[] | boolean> | undefined;
}

export interface TimelineLayer {
  id: string;
  trackId: string;
  type: TimelineLayerType;
  name: string;
  startSeconds: number;
  durationSeconds: number;
  /**
   * In-point into the source media (seconds). The clip plays source from
   * `sourceInSeconds` to `sourceInSeconds + durationSeconds`. Defaults to 0
   * (clip plays from the start of its source). This is what makes split/trim
   * source-aware: the right half of a split video continues from the correct
   * source frame instead of restarting. Both renderers honor it; only meaningful
   * for time-based media (video/audio).
   */
  sourceInSeconds?: number | undefined;
  assetId?: string | undefined;
  /**
   * Editor-only color label (Premiere-style), e.g. "violet". Purely cosmetic: colors the clip in
   * the timeline UI. Set per clip via the clip context menu; when absent the clip inherits the
   * label of its source asset. Renderers and the preview proxy cache must ignore it.
   */
  label?: string | undefined;
  /** References a composition stored in `ProjectGraph.compositions`; used for imported nested timelines. */
  nestedCompositionId?: string | undefined;
  text?: string | undefined;
  textRuns?: TextRun[] | undefined;
  /** Source-text keyframes (hold): when present they OVERRIDE `text`/`textRuns` at render time —
   *  resolved by `getVisibleTextRuns` in every renderer. See {@link SourceTextKeyframe}. */
  sourceTextKeyframes?: SourceTextKeyframe[] | undefined;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  fontWeight?: number | undefined;
  italic?: boolean | undefined;
  letterSpacing?: number | undefined;
  lineHeight?: number | undefined;
  textWidthPercent?: number | undefined;
  textAlign?: "left" | "center" | "right" | undefined;
  textWarp?: TextWarp | undefined;
  color?: string | undefined;
  fit?: "cover" | "contain" | "fill" | undefined;
  /** Source-within-frame pan/zoom/crop (media only) — see {@link LayerContentTransform}. */
  content?: LayerContentTransform | undefined;
  widthPercent?: number | undefined;
  heightPercent?: number | undefined;
  /** Editable vector graphic (Search → Graphics). Present on `image` layers whose pixel source is a recolored
   *  SVG rather than a file asset — the layer is self-contained (no SourceAsset needed) and stays recolorable.
   *  See {@link LayerGraphic} and `graphicToDataUrl`. */
  graphic?: LayerGraphic | undefined;
  /** Basic graphic primitive for shape layers. Defaults to rounded rectangle for older projects. */
  shapeKind?: ShapeKind | undefined;
  /** Shape-local path points for Pen/custom graphic shapes. Coordinates are 0..100 inside the shape box. */
  shapePath?: MaskPoint[] | undefined;
  borderRadius?: number | undefined;
  strokeColor?: string | undefined;
  strokeWidth?: number | undefined;
  backgroundColor?: string | undefined;
  backgroundPaddingEm?: number | undefined;
  backgroundRadiusEm?: number | undefined;
  shadowColor?: string | undefined;
  shadowBlur?: number | undefined;
  shadowOffsetX?: number | undefined;
  shadowOffsetY?: number | undefined;
  /** Person/background cutout matte produced by Extract Person. Read by both renderers. */
  matte?: MatteRef | undefined;
  /**
   * Junction/edge transition applied to the START of this clip (the incoming side). Source of
   * truth for the timeline transition element (kind/duration/params for label + resize) and, for
   * the `wipe`/`iris` shader kinds, read by every renderer via `getCompositionTransition`. The
   * opacity/geometry kinds also write `_transition_`-tagged keyframes into `animations`.
   */
  transitionIn?: TransitionSpec | undefined;
  /**
   * Typewriter reveal progress (0–1). When animated via keyframes, both the web
   * preview and Remotion renderer show only `floor(text.length * progress)`
   * characters. Absent or 1 means fully visible (default). Set by the
   * "Typewriter" animation preset.
   */
  textRevealProgress?: number | undefined;
  transform: TimelineTransform;
  /**
   * Constant playback speed (rate stretch). 1 (or absent) = normal. Source time consumed per
   * timeline second = `speed`, so `sourceTime = sourceInSeconds + (t - startSeconds) * speed`.
   * Every consumer must map through `getLayerSpeed` (timeline.ts) — never read this raw.
   */
  speed?: number | undefined;
  /**
   * Speed ramp / time remap (2026-07-03). Layer-LOCAL times (seconds since clip start), values are
   * playback rates, LINEAR interpolation between points (deliberate: linear segments integrate in
   * closed form, so `sourceTime = sourceIn + ∫speed` is EXACT and bit-identical in every renderer —
   * no numerical stepping to keep in sync). When present (≥1 point) it OVERRIDES `speed`.
   * Every consumer must map through `getLayerSpeedAt` / `layerSourceTimeSeconds` — never raw.
   */
  speedKeyframes?: SpeedKeyframe[] | undefined;
  /** How this layer composites over the layers below it. Default `normal`. */
  blendMode?: BlendMode | undefined;
  /** Vector masks that hide/reveal parts of this clip (Phase 1). Empty/absent = no masking. */
  masks?: Mask[] | undefined;
  effects: TimelineEffect[];
  keyframes: TimelineKeyframe[];
  animations?: TimelineKeyframeV2[] | undefined;
  linkedGroupId?: string | undefined;
  locked?: boolean | undefined;
  muted?: boolean | undefined;
  /**
   * Clip enable toggle ("d" in the timeline, Premiere's Enable): a disabled clip renders nowhere
   * (web preview, export, worker — all gate on this) and is silent, but stays fully editable,
   * selectable and draggable in the timeline (drawn dimmed).
   */
  disabled?: boolean | undefined;
  /**
   * Clip markers (Premiere-style): `timeSeconds` is CLIP-LOCAL (0 = clip head), so markers travel
   * with the clip on move and stay glued to content. Editor-only — no render effect. The `M` key
   * writes here when a selected clip spans the playhead, otherwise to the timeline ruler markers.
   */
  markers?: TimelineMarker[] | undefined;
  /**
   * Responsive Pin (§1) — how this layer re-anchors when the CANVAS is reframed
   * (16:9 ↔ 9:16, size change). Absent or all-"center" = today's behavior (the box
   * center is held at a constant percent). A non-center axis holds that EDGE of the
   * painted box at a constant percent instead, so e.g. a right-pinned lower-third keeps
   * its right margin on reframe. Resolved by BAKING new `transform.position` values at
   * reframe time (editor-side) — both renderers keep consuming plain percent positions,
   * so this never crosses the render-manifest line. Uniform scale is untouched (no
   * stretch — Pin+scale is deferred). See `responsive-pin.ts`.
   */
  responsive?: LayerResponsivePin | undefined;
  /**
   * Responsive Time (§5) — protected intro/outro when this clip's DURATION changes (trim/resize).
   * With this set, `squeezeLayerKeyframesTo` holds the first `introSeconds` and last `outroSeconds`
   * of animation and stretches only the middle, instead of rescaling everything proportionally.
   * Absent = today's uniform squeeze. Non-source layers only (text/shape/image). See `remapResponsiveTime`.
   */
  responsiveTime?: LayerResponsiveTime | undefined;
  /**
   * Frames (see FRAMES.md) — a parametric shape this layer's media clips to. Data-only:
   * `{ generatorId, params }` chosen from a `FrameDefinition`. When set with NO asset the layer is an
   * empty frame placeholder; with media it clips to the generated outline (via the existing clip-mask).
   * Its params are edited in the Effects subpanel. `LayerFrame` lives in `frames.ts`.
   */
  frame?: import("./frames").LayerFrame | undefined;
  /**
   * Template authoring marker. When a project is saved as a template, layers
   * flagged as slots become the user-fillable parts: `media` slots accept a
   * replacement asset on instantiation, `text` slots expose their copy as an
   * editable field, `color` slots expose their color. `key` binds the slot to a
   * `ProjectGraph.editableFields` entry. Absent on normal (non-template) layers.
   */
  slot?: TemplateSlot | undefined;
}

export interface TemplateSlot {
  key: string;
  label: string;
  kind: "media" | "text" | "color";
  replaceable: boolean;
}

export interface TimelineTrack {
  id: string;
  type: TimelineTrackType;
  name: string;
  layers: TimelineLayer[];
  locked?: boolean | undefined;
  muted?: boolean | undefined;
  /** Solo: when ANY track is soloed, only soloed tracks render/are audible. */
  solo?: boolean | undefined;
  /**
   * Track mixer fader gain (audio tracks). 0..2 linear, 1/absent = unity. Multiplies every
   * clip's own volume. Read through `getTrackAudioGain` — never raw.
   */
  volume?: number | undefined;
  /**
   * Track fader automation (absolute composition seconds, linear interpolation, v1).
   * When present it OVERRIDES the static `volume` during playback/export — evaluate via
   * `getTrackAudioGainAt`. Same convention for `panKeyframes`/`getTrackPanAt`.
   */
  volumeKeyframes?: TrackAudioKeyframe[] | undefined;
  panKeyframes?: TrackAudioKeyframe[] | undefined;
  /**
   * Track stereo pan (audio tracks). −1 (full left) .. 1 (full right), 0/absent = center.
   * Read through `getTrackPan`. Applied in preview + local export (StereoPanner) and in cloud
   * export via the worker's audio post-mix (Remotion renders video muted; the worker mixes audio
   * with the same shared evaluators + ffmpeg mux — see apps/worker/src/audio-post-mix.ts).
   */
  pan?: number | undefined;
}

/** One speed-ramp point: layer-local seconds → playback rate (linear segments; see TimelineLayer.speedKeyframes). */
export interface SpeedKeyframe {
  timeSeconds: number;
  value: number;
}

/** One point of track-level audio automation (mixer fader/pan), in absolute composition seconds. */
export interface TrackAudioKeyframe {
  timeSeconds: number;
  value: number;
}

/** Named/colored timeline bookmark (Premiere-style marker). Editor-only — no render effect. */
export interface TimelineMarker {
  timeSeconds: number;
  name?: string | undefined;
  /** One of TIMELINE_MARKER_COLORS (timeline-ops) or any CSS color. Absent = default accent. */
  color?: string | undefined;
}

export type TimelineViewportPreset = "vertical_1080x1920" | "landscape_1920x1080" | "square_1080" | "youtube_4k" | "custom";
export type TimelineResizeBehavior = "keep-layout" | "scale-visuals";
export type TimelineTimeDisplay = "seconds" | "timecode" | "frames";

export interface TimelineCompositionSettings {
  /**
   * Managed color contract for this composition (working/output space + range). Absent on legacy
   * projects → treat as {@link DEFAULT_PROJECT_COLOR_SETTINGS} (Rec.709 linear working, Rec.709 SDR
   * limited output). Persisted in the `ProjectGraph` JSON blob; no schema migration needed.
   */
  color?: ProjectColorSettings | undefined;
  viewport: {
    preset: TimelineViewportPreset;
    width: number;
    height: number;
    fps: number;
    backgroundColor: string;
    resizeBehavior: TimelineResizeBehavior;
  };
  timeline: {
    baseDurationSeconds: number;
    autoGrow: boolean;
    tailPaddingSeconds: number;
    snapSeconds: number;
    timeDisplay: TimelineTimeDisplay;
    /**
     * Timeline bookmarks. Legacy entries are bare numbers (seconds); new entries are
     * {@link TimelineMarker} objects with optional name/color. Always read through
     * `normalizeTimelineMarkers` — never assume one shape.
     */
    markers?: (number | TimelineMarker)[] | undefined;
    /** Premiere-style work area: export is clipped to [inPointSeconds, outPointSeconds] when set. Editor playback/preview always shows the full timeline. */
    inPointSeconds?: number | undefined;
    outPointSeconds?: number | undefined;
  };
}

export interface TimelineComposition {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  tracks: TimelineTrack[];
  backgroundColor: string;
  settings?: TimelineCompositionSettings | undefined;
}

export interface EditableFieldDefinition {
  key: string;
  label: string;
  type: "text" | "select" | "color" | "number" | "boolean";
  defaultValue: string | number | boolean;
  options?: string[];
}

export interface TemplateDefinition {
  id: string;
  /** null/absent = curated (shared with everyone); set = one user's own save-as-template. */
  userId?: string | null | undefined;
  name: string;
  slug: string;
  category: string;
  description: string;
  previewUrl: string;
  thumbnailUrl: string;
  durationSeconds: number;
  requiredModules: ModuleType[];
  editableFields: EditableFieldDefinition[];
  templateGraph: ProjectGraph;
  creditCost: number;
  active: boolean;
}

export interface ToolDefinition {
  id: string;
  name: string;
  slug: string;
  description: string;
  moduleType: ModuleType;
  steps: string[];
  creditCost: number;
  bestFor: string;
}

export type ToolStage =
  | "upload"
  | "analyze"
  | "transcribe"
  | "extract"
  | "mask"
  | "track"
  | "style"
  | "text"
  | "tune"
  | "inspect"
  | "preview"
  | "apply"
  | "export";

export type ToolArtifactType =
  | "transcript"
  | "captionTrack"
  | "maskSequence"
  | "alphaClip"
  | "greenScreenClip"
  | "inpaintedClip"
  | "trackingPath"
  | "subjectBounds"
  | "subjectDepth"
  | "timelinePatch"
  | "renderManifest"
  | "generatedImage"
  | "generatedVideo"
  | "thumbnail"
  | "diagnostics";

export type ToolInputType = "video" | "image" | "audio" | "transcript" | "mask" | "trackingPath";
export type ToolAdapterType = "mock" | "browser" | "cloud" | "desktop";
export type ToolTimelineAction = "createLayers" | "updateLayer" | "addEffects" | "addKeyframes" | "createAssets";
export type ToolCategory = "captions" | "masking" | "tracking" | "compositing" | "motion" | "export";
export type ToolBrowserMode = "instant" | "progressive" | "heavy";
export type ToolRunStatus = "draft" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface ToolCapabilityDefinition {
  id: string;
  name: string;
  slug: string;
  shortDescription: string;
  aiDescription: string;
  userDescription: string;
  category: ToolCategory;
  moduleType: ModuleType;
  accepts: ToolInputType[];
  outputs: ToolArtifactType[];
  stages: ToolStage[];
  browserMode: ToolBrowserMode;
  adapters: ToolAdapterType[];
  timelineActions: ToolTimelineAction[];
  estimatedCredits?: number | undefined;
  bestFor: string;
  limitations: string[];
  /** Renderer-agnostic icon key. UIs map this to their own glyph set (e.g. a lucide icon in web).
   *  Keeps `shared` free of any icon library; new tools declare their glyph here, not in the page. */
  icon?: ToolIconKey | undefined;
}

/** Stable icon identifiers a tool can request. Extend as new tool families arrive. */
export type ToolIconKey =
  | "captions"
  | "text-behind"
  | "background-removal"
  | "follow-text"
  | "person-extraction"
  | "generic";

export interface ToolDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
  code?: string | undefined;
}

export interface ToolArtifact {
  id: string;
  type: ToolArtifactType;
  assetId?: string | undefined;
  uri?: string | undefined;
  metadata: Record<string, unknown>;
  preview?: {
    thumbnailAssetId?: string | undefined;
    durationSeconds?: number | undefined;
    frameCount?: number | undefined;
  } | undefined;
}

export interface ToolRun {
  id: string;
  toolId: string;
  status: ToolRunStatus;
  progress: number;
  stage: ToolStage;
  inputAssetIds: string[];
  params: Record<string, unknown>;
  artifacts: ToolArtifact[];
  diagnostics: ToolDiagnostic[];
  createdAt: string;
  updatedAt: string;
}

export interface RenderJob {
  id: string;
  projectId: string;
  userId: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  manifest?: unknown;
  manifestVersion?: number;
  errorMessage?: string;
  outputUrl?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WalletPack {
  id: "starter" | "creator" | "growth";
  name: string;
  priceInr: number;
  credits: number;
  description: string;
}

export interface AiPlan {
  style: string;
  language: "english" | "hindi" | "hinglish";
  templateSlug: string;
  effects: ModuleType[];
  editableFields: Record<string, string | number | boolean>;
}
