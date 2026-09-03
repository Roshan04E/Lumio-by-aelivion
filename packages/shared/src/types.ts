import type { z } from "zod";
import type { PluginEffectManifest, PluginLookManifest, PluginTransitionManifest } from "./plugin-manifest";
import type { ProjectColorSettings, SourceColorMetadata } from "./color/color-management";
import type { FontRef } from "./fonts";

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
  "GENERATIVE_STYLIZE",
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
  /** Transcoded proxy URL (preferred for playback over fileUrl when present). ALWAYS a COMPLETE
   *  proxy covering the whole source — see `partialProxyUrl` for the in-progress kind. */
  proxyUrl?: string | undefined;
  /**
   * PARTIAL proxy: a playable MP4 covering only `[0, partialProxyCoverageSeconds)` of the source,
   * muxed from a build that has not finished (2026-08-11, Slice 3 of
   * `plans/source-proxy-progressive.md`). Video-only.
   *
   * Kept in its OWN field rather than reusing `proxyUrl` because a truncated file is not a
   * substitute for a complete one, and `proxyUrl` has many consumers (AI observers, hover previews,
   * the two-up scrubber, thumbnails) that reasonably assume the whole source is there. Anything
   * that has not opted in keeps seeing only complete proxies.
   *
   * Only the preview's video routing reads this, and only for a layer whose entire source range
   * fits inside coverage — past coverage the decoder CLAMPS rather than returning null, which is
   * the frozen tail this repo has shipped twice. See `sourceProxyCoverage.ts`.
   */
  partialProxyUrl?: string | undefined;
  /** Source seconds from 0 that `partialProxyUrl` actually contains. Never a nominal figure. */
  partialProxyCoverageSeconds?: number | undefined;
  /** Server copy URL once the asset has been uploaded to cloud (worker-fetchable). */
  cloudUrl?: string | undefined;
  fps?: number | undefined;
  sizeBytes?: number | undefined;
  /**
   * TRUE when the local import could NOT persist this asset's bytes on device (DEBT-034). The asset
   * still works for the rest of the SESSION off an in-memory object URL, but it will not survive a
   * refresh and it can never be proxied — the proxy engine reports it as `"no local bytes"`.
   *
   * It exists because the import used to swallow that failure and record the asset as `ready` with a
   * `localblob:` marker asserting bytes that were never written. Measured 2026-09-03: importing 11
   * assets of ~120MB lost 4 of them this way, silently, with the loss only surfacing minutes later at
   * proxy time. Absent/false means the bytes are on device.
   */
  localBytesMissing?: boolean | undefined;
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
  /**
   * ADR-023 S4. The pinned font file travels WITH the stack, always (D1/T-1): a `{source:"system"}`
   * ref means "read the stack", so carrying one without the other is a look that renders in a
   * different typeface than the one it was captured from. It was missing here until S4 — the S1
   * hand-written-list defect, in the preset path instead of the manifest path.
   */
  fontRef?: FontRef | undefined;
  /** See {@link TimelineLayer.fontWeightAxis}. ADR-023 S9a — an axis INSIDE the pinned file. A style
   *  captured before S9a has no key, which keeps meaning "the face's own default instance". */
  fontWeightAxis?: number | undefined;
  fontWidthAxis?: number | undefined;
  fontSize?: number | undefined;
  fontWeight?: number | undefined;
  italic?: boolean | undefined;
  letterSpacing?: number | undefined;
  lineHeight?: number | undefined;
  color?: string | undefined;
  strokeColor?: string | undefined;
  strokeWidth?: number | undefined;
  /** See {@link TimelineLayer.strokePaintOrder}. Part of the look, so a saved style carries it — and
   *  a style captured before S1 simply has no key, which keeps meaning `"over"`. */
  strokePaintOrder?: "over" | "under" | undefined;
  /** See {@link TimelineLayer.strokeOuterColor}. ADR-023 S8 — the concentric second ring. A style
   *  captured before S8 has no key, which keeps meaning "no outer stroke". */
  strokeOuterColor?: string | undefined;
  strokeOuterWidth?: number | undefined;
  /** See {@link TimelineLayer.textPathCurve}. ADR-023 S8 — text on a path. */
  textPathCurve?: number | undefined;
  /**
   * See {@link TimelineLayer.clusterRiseEm} / {@link TimelineLayer.clusterStaggerFraction}. ADR-023
   * S9 — the SHAPE of a per-character reveal is part of the look, so a saved style carries it.
   *
   * `clusterRevealProgress` is deliberately NOT here. It is a position in time, not a look: a preset
   * carrying "40% revealed" would apply a frozen mid-flight state to a layer whose reveal the author
   * has not keyframed yet. A style captured before S9 has no key, which keeps meaning "no animation".
   */
  clusterRiseEm?: number | undefined;
  clusterStaggerFraction?: number | undefined;
  /** See {@link TimelineLayer.fillGradientFrom}. ADR-023 S5 — tier-1 gradient fill. */
  fillGradientFrom?: string | undefined;
  fillGradientTo?: string | undefined;
  fillGradientAngle?: number | undefined;
  /**
   * ADR-023 S5b. Image fill on the glyphs — see {@link TimelineLayer.fillTextureAssetId}.
   *
   * It joins the look here because it always WAS one; it had simply never joined this interface, so
   * S4's two-way constraint could not see it and Save Style dropped it silently (T-15 addendum 2).
   * The constraint was never wrong — it proved the presetable set equals `TextStyleFields`, and this
   * was not in `TextStyleFields`. That is the half a reader has to check separately, every time.
   */
  fillTextureAssetId?: string | undefined;
  fillTextureFit?: "cover" | "tile" | undefined;
  fillTextureScale?: number | undefined;
  backgroundColor?: string | undefined;
  backgroundPaddingEm?: number | undefined;
  backgroundRadiusEm?: number | undefined;
  /** See {@link TimelineLayer.backgroundPerLine}. ADR-023 S5 — per-line caption pills. */
  backgroundPerLine?: boolean | undefined;
  shadowColor?: string | undefined;
  shadowBlur?: number | undefined;
  shadowOffsetX?: number | undefined;
  shadowOffsetY?: number | undefined;
  /** See {@link TimelineLayer.shadowLayers}. ADR-023 S5 — stacked shadows (faked extrude). */
  shadowLayers?: number | undefined;
  textAlign?: "left" | "center" | "right" | "start" | "end" | undefined;
  /**
   * ADR-023 S4. Base paragraph direction is part of the look (it is a paragraph setting in After
   * Effects and Premiere too) and was likewise absent from the pre-S4 copy list. Absent stays absent
   * on capture AND on apply — see `applyTextStyle`, which never writes a key the style does not carry.
   */
  direction?: "auto" | "ltr" | "rtl" | undefined;
}

/**
 * The appearance subset of a SHAPE layer — what a shape preset carries (ADR-023 S6, D12).
 *
 * Same doctrine as {@link TextStyleFields} and the same boundary drawn in the same place: this is how
 * a shape LOOKS, never what it is or where it sits. `shapeKind`, `shapePath`, `widthPercent` and
 * `heightPercent` are deliberately absent — a preset that turned your ellipse into a rectangle, or
 * resized it, is the shape equivalent of a text look reflowing the target's lines
 * (`textWidthPercent`, which S4 excluded for exactly this reason).
 *
 * Every key here is a key `getCompositionShapeStyle` actually reads. That is what makes the schema a
 * description of the renderer rather than a wish about it.
 */
export interface ShapeStyleFields {
  color?: string | undefined;
  strokeColor?: string | undefined;
  strokeWidth?: number | undefined;
  borderRadius?: number | undefined;
  /** See {@link TimelineLayer.fillTextureAssetId}. Shapes paint the same texture through the same
   *  resolver and the same `fillTexturePaint` (S5b), so a shape look carries it too. */
  fillTextureAssetId?: string | undefined;
  fillTextureFit?: "cover" | "tile" | undefined;
  fillTextureScale?: number | undefined;
  shadowColor?: string | undefined;
  shadowBlur?: number | undefined;
  shadowOffsetX?: number | undefined;
  shadowOffsetY?: number | undefined;
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
  /**
   * Composition registry. Invariant (since the Block 2 nesting maturity work): holds EVERY
   * composition of the project INCLUDING the root/main one, keyed by id. `composition` remains
   * the ACTIVE composition (the one being edited/rendered) and is mirrored into this record by
   * the editor's single write-through seam. Legacy graphs (registry missing the root, or no
   * pointer fields) are migrated/healed at load time.
   */
  compositions?: Record<string, TimelineComposition> | undefined;
  /** Id of the project's main/root composition inside `compositions`. Absent on legacy graphs. */
  rootCompositionId?: string | undefined;
  /** Id of the composition currently open in the editor (`composition.id`). Absent on legacy graphs. */
  activeCompositionId?: string | undefined;
  /**
   * Flarex node-comp registry (FLAREX.md): per-clip Fusion-style node graphs, keyed by id and
   * referenced from `TimelineLayer.flarexCompId` — the same first-class-registry pattern as
   * `compositions`. Renderers never read this directly; the shared lowering compiler turns a
   * comp into SceneDraw primitives. Carried verbatim through the render manifest.
   */
  flarexComps?: Record<string, import("./flarex/types").FlarexComp> | undefined;
  /**
   * Notes board registry (plans/notes-sonnet-execution.md): Miro/Milanote-style creative
   * organizer boards, keyed by id — same first-class-registry pattern as `flarexComps`.
   */
  notesBoards?: Record<string, import("./notes/types").NotesBoard> | undefined;
  /** Id of the board currently open on the Notes editor page. */
  activeNotesBoardId?: string | undefined;
  /**
   * Per-project media-library organization (folder tree etc. — see shared/media-manifest.ts).
   * Living inside the graph means it syncs to the cloud with the project through the existing
   * save path, so local and cloud keep the same folder structure. Renderers ignore it.
   */
  mediaManifest?: { version: 1; customFolders: string[] } | undefined;
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
  /**
   * Anchor point (D3): the rotate/scale/tilt PIVOT, in percent of the layer's element box
   * (0..100 each; absent = 50/50 = center — today's behavior, byte-identical). Premiere semantics:
   * `position` is the ANCHOR's comp position, so moving the anchor moves the pivot, not the image.
   * Every renderer pivots through this in lockstep (GPU quad, DOM CSS transform-origin, canvas-2D
   * text/shape, clip-mask matte bake) — see plans/effects-paint-deferred.md D3.
   */
  anchor?: TimelineVector2 | undefined;
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
  "chromaticAberration",
  "sketch",
  "oldTv",
  "glitchFx",
  "halftone",
  "posterize",
  "stylize"
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

export type KeyframeTargetScope = "layer" | "effect" | "mask" | "track" | "composition" | "flarexNode";
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
  /**
   * ADR-023 S10 — TWO CONSTANTS, per D1a, never one default.
   *
   * `fontFamily` alone (no `fontRef`) means the run was authored as a raw CSS stack — the rich-text
   * toolbar's pre-S10 behaviour — and MUST keep resolving as `{ source: "system" }` forever, exactly
   * like a layer with no `fontRef` does. `fontRef` present is the S10 pinned path: a hashed,
   * mirrored, embeddable file the export can abort by name on, same as the layer field below it in
   * the inspector. Do not name-match an existing `fontFamily` string onto a catalogue family — "Anton"
   * the system stack and "Anton" the pinned file are different renders (T-17), and a migration here
   * would silently move every project with a per-run font already authored.
   *
   * Both absent means "inherit the layer's font", same as it always has.
   *
   * See `getCompositionRunFontRef` (composition-style.ts) for the one place this is read.
   */
  fontRef?: FontRef | undefined;
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
  /**
   * Source in-point (seconds) the matte's frame 0 corresponds to. 0 (or absent) = the matte covers
   * the source from its start (the default full-source bake). When a matte was baked over only a
   * used SLICE of a long source (Remove Background "Used in timeline"), this is the slice's source
   * start, so every renderer samples the matte at `sourceTime − startSeconds`. Keeping it on the
   * MatteRef (not implied by clip trim) makes the matte robust to later re-trims of the clip.
   */
  startSeconds?: number | undefined;
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
  /** Window placement relative to the cut. "auto" (default/absent) = handle-aware (R3.1): centered when
   *  both sides have media, shifted toward the side that does. Manual values force placement and may
   *  produce repeated frames (zebra warning) where material is missing — exactly Premiere's model. */
  alignment?: "auto" | "center" | "start" | "end" | undefined;
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
  /** References a Flarex node comp in `ProjectGraph.flarexComps` (FLAREX.md). When set, the clip's
   *  rendered output is the comp's MediaOut instead of its plain graded media. */
  flarexCompId?: string | undefined;
  text?: string | undefined;
  textRuns?: TextRun[] | undefined;
  /** Source-text keyframes (hold): when present they OVERRIDE `text`/`textRuns` at render time —
   *  resolved by `getVisibleTextRuns` in every renderer. See {@link SourceTextKeyframe}. */
  sourceTextKeyframes?: SourceTextKeyframe[] | undefined;
  /**
   * The layer's CSS font stack. **Legacy data (ADR-023 T-1), and permanently supported as such.**
   *
   * A stack names a font; it does not provide one, which is why {@link TimelineLayer.fontRef} exists.
   * This field is not deprecated in the "will be removed" sense — a `{ source: "system" }` ref
   * carries exactly this string forever, so a project authored before `FontRef` existed keeps
   * rendering the way it always has, with no migration, ever, automatically (D1a).
   */
  fontFamily?: string | undefined;
  /**
   * ADR-023 D1 — the font REFERENCE. The render identity for pinned fonts is the `fileHash`, not the
   * family name.
   *
   * **ABSENT MEANS `{ source: "system" }` CARRYING {@link TimelineLayer.fontFamily} UNCHANGED,
   * permanently and without migration** — the same two-constants shape as
   * {@link TimelineLayer.strokePaintOrder}, {@link TimelineLayer.direction} and
   * `LEGACY_PROJECT_COLOR_SETTINGS`. See `normalizeFontRef` for why a silent remap would be a
   * reflow, and a reflow in an unattended export.
   */
  fontRef?: FontRef | undefined;
  /**
   * ADR-023 S9a — the `wght` axis of a VARIABLE font, in font units (not a CSS weight).
   *
   * **This is not {@link TimelineLayer.fontWeight}, and the difference is the whole stage.**
   * `fontWeight` is CSS: over a legacy stack the browser synthesises, and over a pinned ref S2.7 has
   * already made the FILE decide, because Google's index enumerates instances and its CDN serves one
   * static file per weight. This field moves an axis INSIDE one file — 550, 620, any coordinate the
   * face's `fvar` exposes — and it does so by registering the file a second time under an alias
   * family with a `variationSettings` descriptor, because canvas 2D cannot apply an axis at draw
   * time and the canvas raster is where both renderers get their pixels (T-13). See
   * `font-variation.ts` for the measurement and for the feature detect that lies.
   *
   * **ABSENT MEANS "the face's own default instance", permanently and without migration** (D1a).
   * Not 400: a variable face's `fvar` default is whatever the foundry chose, so writing a number in
   * would move every layer already pinned to a variable file — and Arimo, which this repo ships and
   * renders with today, is exactly such a file.
   *
   * A `{ source: "system" }` ref REFUSES this field rather than approximating it. A system family has
   * no bytes to re-register, so there is no alias to name and the axis would move the editor's DOM
   * overlay while changing nothing in the export — the "wrong pixels that look like a working
   * feature" shape. The refusal is asserted, not assumed: see `font:axis-falsifier`.
   */
  fontWeightAxis?: number | undefined;
  /** ADR-023 S9a — the `wdth` axis. Same rules as {@link TimelineLayer.fontWeightAxis} throughout. */
  fontWidthAxis?: number | undefined;
  fontSize?: number | undefined;
  fontWeight?: number | undefined;
  italic?: boolean | undefined;
  letterSpacing?: number | undefined;
  lineHeight?: number | undefined;
  textWidthPercent?: number | undefined;
  /**
   * `"left"`/`"right"` are PHYSICAL and stay physical forever — they are never remapped to logical
   * values, because an existing project that says "left" means the left of the frame (ADR-023 D6a).
   * `"start"`/`"end"` are LOGICAL: they resolve against {@link TimelineLayer.direction}, so RTL text
   * aligns to the right edge without the author having to know which edge that is. New text is
   * authored `"start"`.
   */
  textAlign?: "left" | "center" | "right" | "start" | "end" | undefined;
  /**
   * Base paragraph direction for the Unicode Bidi Algorithm (ADR-023 D6a, stage S0b).
   *
   * The UBA resolves the *relative* order of runs correctly on its own, but the paragraph embedding
   * level decides where neutrals land, which edge a line starts from, and what "align start" means.
   * That level is not derivable from the glyph stream — it is data, and this is where it lives.
   *
   * - `"auto"` — first-strong, RESOLVED once by `resolveTextDirection` at style-resolution time and
   *   handed to both renderers as a concrete value (T-13 as corrected, stage S0c). S0b delegated it
   *   to `unicode-bidi: plaintext`, which a CSS box honours and a canvas cannot express at all — so
   *   the raster both renderers draw from silently rendered every `"auto"` layer `ltr`.
   * - `"ltr"` / `"rtl"` — stated explicitly.
   *
   * Both forms emit `unicode-bidi: isolate` on the DOM path. One direction per LAYER, not per line:
   * the After Effects / Premiere model, and the accepted cost of resolving `"auto"` ourselves.
   *
   * **ABSENT MEANS `ltr` WITH PHYSICAL ALIGNMENT, permanently, and is never migrated** — the same
   * two-constants shape as {@link TimelineLayer.strokePaintOrder} and `LEGACY_PROJECT_COLOR_SETTINGS`.
   * An existing project with Arabic text stays exactly as wrong as it is today until its author opts
   * in, because silently re-laying-out a published project is the worse defect.
   *
   * No renderer may infer this from content at paint time (T-13). The detector in `text-script.ts`
   * exists for the AUTHORING-time default only.
   */
  direction?: "auto" | "ltr" | "rtl" | undefined;
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
  /**
   * Where a TEXT layer's stroke paints relative to its fill (ADR-023 D7, stage S1).
   *
   * - `"over"` — the stroke is centred on the glyph outline and painted ON TOP of the fill, so half
   *   its width eats inward and a heavy stroke thins the letterform. That is `-webkit-text-stroke`'s
   *   own behaviour, and what every text layer has always done.
   * - `"under"` — the stroke paints BEHIND the fill (CSS `paint-order: stroke fill`). The whole glyph
   *   stays visible and the stroke reads as an outline around it: the sticker-caption look.
   *
   * **ABSENT MEANS `"over"`, permanently, and is never migrated.** This is D1a's shape applied to a
   * second axis, for the reason `color-management.ts:82-119` gives for keeping
   * `LEGACY_PROJECT_COLOR_SETTINGS` and `NEW_PROJECT_COLOR_SETTINGS` as two constants rather than one
   * default behind a flag: *absent* must keep meaning "authored before this existed" for good, not
   * until someone changes the default. Flipping it under an existing project is a visible pixel
   * change in work the user may already have published. New text is authored `"under"`; everything
   * else renders exactly as it does today until its author opts in.
   */
  strokePaintOrder?: "over" | "under" | undefined;
  /**
   * ADR-023 D8 (S8) — **a second, concentric stroke OUTSIDE the first**: the two-colour sticker
   * outline. `strokeColor`/`strokeWidth` is the inner ring; this is the one around it.
   *
   * **This does not need SVG, and that is a correction to D8, measured** (`s8-premise-probe.mjs`).
   * D8 named multiple independent strokes as one of exactly two things CSS cannot do. Both surfaces
   * that ship a picture do it natively: the canvas raster strokes widest-first and then fills, and
   * the DOM overlay stacks a second copy of the same browser-shaped text behind the first. Both
   * reproduce SVG's own band profile at the authored widths, so a second rendering surface would
   * have bought a second rendering surface and nothing else. SVG is still needed for `<textPath>`.
   *
   * **TWO fields, not a list, for the reason `fillGradientFrom`/`To`/`Angle` is three fields:** a
   * list of independently-coloured strokes is the `list` kind, which is frozen into ADR-003's
   * taxonomy and not yet buildable by `PropertyFieldList`, and ADR-003's promotion clause wants
   * genuine two-system demand. A third ring is **not approximated** — the same answer S5 gave to
   * per-copy shadow colours. Two rings is the look people mean by "multi-colour outline".
   *
   * **Nothing is drawn unless there is an inner stroke to ring, and the outer one is wider than
   * it.** A ring narrower than what it surrounds is entirely covered — invisible either way — and
   * "outer stroke with no inner stroke" is not a ring at all, it is a stroke, which `strokeWidth`
   * already is. Resolved in one place so the raster and the DOM cannot answer it differently, in
   * the same both-or-nothing shape as the gradient's two stops.
   *
   * **ABSENT MEANS NO OUTER STROKE, permanently and without migration** (D1a).
   */
  strokeOuterColor?: string | undefined;
  strokeOuterWidth?: number | undefined;
  /**
   * ADR-023 D8 (S8) — **text on a path**: the arc/curve control. `-100`…`100`, where the sign is the
   * bend direction (positive arcs up like a rainbow, negative down) and the magnitude is how much of
   * a half-circle the run wraps. Absent or under ±1 is straight text, which is every project today.
   *
   * **This is the half of D8 that genuinely needs SVG**, and it is a second rendering SURFACE, never
   * a second text engine (D6/T-5): `<textPath>` shapes the run with the same shaper `fillText` uses
   * and then places the shaped glyphs along the geometry. Measured — an Arabic run on a straight
   * path is 91.64px against flat text's 91.63px, where the isolated-glyph sum is 110.88px.
   *
   * **A NUMBER, not a composite.** `textWarp` is the last hand-written cache-key special case left in
   * the product (S5b), and a second composite would be a second one. One number in one existing kind
   * is emitted like every other look and therefore keyed like every other look.
   *
   * **Not everything survives a curve, and what does not is declared** — see `textPathUnsupported`
   * in `scene/text-path.ts`. Warp wins over a curve when both are set, because warp shipped first.
   *
   * **ABSENT MEANS STRAIGHT, permanently and without migration** (D1a).
   */
  textPathCurve?: number | undefined;
  /**
   * ADR-023 S9 (OQ6, T-14) — **per-character animation**: how far the reveal has got, 0 to 1.
   *
   * A "character" here is a GRAPHEME CLUSTER and nothing else — see `text-cluster-animation.ts` for
   * why that is a correctness decision rather than a precision one, and why a runtime without
   * `Intl.Segmenter` refuses the animation instead of falling back to code points.
   *
   * **Keyframable** (`style.clusterRevealProgress`), which is what makes this a reveal. The stage
   * adds no animation system: the property rides the existing keyframe evaluator, and the only new
   * arithmetic is how one property value is distributed across N clusters.
   *
   * **ABSENT MEANS NO ANIMATION, permanently** (D1a) — and absent is a different thing from a
   * progress of 1. Absent emits no animation key at all, so an existing text layer's emitted style
   * and its raster cache key are byte-identical to what they were before this stage. A layer at
   * progress 1 has an animation that has FINISHED, and renders through the ordinary unsliced draw so
   * that "settled" and "absent" are the same picture rather than two pictures that look alike.
   *
   * **Refused, visibly, on a shaping-dependent script and on a curved run** — `detectTextScript` and
   * `textPathCurve` respectively (P2/P3 of `text:s9-precedence`). Warp is NOT a refusal: the
   * animation composes UNDER a warp, which deforms the already-animated picture (P1).
   */
  clusterRevealProgress?: number | undefined;
  /** ADR-023 S9 — how far below its resting place a cluster starts, in em. 0 is a pure fade. */
  clusterRiseEm?: number | undefined;
  /** ADR-023 S9 — share of the reveal spent handing off between clusters; 0 moves them together. */
  clusterStaggerFraction?: number | undefined;
  /**
   * ADR-023 D7 (S5) — **tier-1 gradient fill for the glyphs**, the CSS `background-clip: text` look.
   *
   * Two stops and an angle, because that is what a frozen taxonomy can describe honestly today: a
   * richer stop list is the `gradient` kind (ADR-003), which is frozen into the union but not yet
   * buildable by `PropertyFieldList`, and inventing a stop-list encoding over `color`/`number` fields
   * to dodge that would be the taxonomy decision taken by accident. Two stops covers the gold /
   * chrome / duotone caption looks this stage exists for; the third stop arrives with the kind.
   *
   * **Both stops must be present for anything to be emitted**, so a half-authored gradient renders as
   * the solid {@link TimelineLayer.color} rather than as a surprise. The gradient paints the GLYPHS
   * (in the DOM it rides the run spans, not the layer box — `background-clip: text` clips the
   * background *colour* too, so putting it on the box would silently eat the background pill), and it
   * overrides every run's own colour, exactly as `fillTexture` does.
   *
   * `fillTexture` (an image fill) wins over a gradient when both are set: it is the more specific
   * paint, and it shipped first.
   *
   * **ABSENT MEANS NO GRADIENT, permanently and without migration** — the D1a shape, as for
   * {@link TimelineLayer.strokePaintOrder} and {@link TimelineLayer.direction}.
   */
  fillGradientFrom?: string | undefined;
  fillGradientTo?: string | undefined;
  /** Gradient angle in CSS degrees (0 = up, 90 = right). Absent = 180 (top→bottom), the CSS default. */
  fillGradientAngle?: number | undefined;
  backgroundColor?: string | undefined;
  backgroundPaddingEm?: number | undefined;
  backgroundRadiusEm?: number | undefined;
  /**
   * ADR-023 D7 (S5) — the background pill is drawn **per line** instead of as one box around the
   * whole block. The caption look people actually mean: three wrapped lines get three pills that hug
   * each line's own width, not one rectangle as wide as the longest.
   *
   * The block keeps its padding (so the element box and therefore the layout do not move) and gives
   * up its background; the pill moves onto the line fragments. In the DOM that is
   * `box-decoration-break: clone` on the inline runs, which is the browser's own per-fragment box; in
   * the raster it is one rounded rect per line, sized from the line's ink metrics so the two agree.
   *
   * **ABSENT MEANS THE SINGLE BLOCK PILL, permanently and without migration** (D1a).
   */
  backgroundPerLine?: boolean | undefined;
  shadowColor?: string | undefined;
  shadowBlur?: number | undefined;
  shadowOffsetX?: number | undefined;
  shadowOffsetY?: number | undefined;
  /**
   * ADR-023 D7 (S5) — how many copies of the shadow are stacked, at 1×…N× the offset.
   *
   * `text-shadow` has always been a LIST and we emitted one entry. Stacking the same shadow at
   * increasing offsets is how a hard 3D extrude is made, and at zero blur it reads as a solid
   * extruded slab rather than as a blur. One number, no new kind, and the existing four shadow
   * fields keep describing the shadow being repeated.
   *
   * Independent per-copy colours (a multi-colour glow) are genuinely a list of shadows and want the
   * `gradient`-adjacent `list` kind; they are NOT approximated here.
   *
   * **ABSENT MEANS ONE SHADOW, permanently and without migration** (D1a). Values below 2 emit
   * exactly what they emitted before this field existed.
   */
  shadowLayers?: number | undefined;
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
  /**
   * Frame hold ("animating on twos/threes", 2026-07-18 — the Spider-Verse 12fps feel): when set
   * (e.g. 12), the layer's VIDEO sampling time quantizes to this many distinct images per timeline
   * second. Audio stays continuous — the hold applies only to picture sampling. Every video
   * consumer must quantize LOCAL time via `layerHeldLocalSeconds` BEFORE mapping through
   * `layerSourceTimeSeconds`, so preview, span proxies, local export, and Remotion hold the
   * IDENTICAL frames (render-manifest law).
   */
  holdFps?: number | undefined;
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
   * Track matte key (Premiere's "use clip above as matte"): the NEAREST visual clip above this one
   * in z order (same scope — top level, or siblings inside the same nested comp; a compound clip
   * counts as one slot) becomes this clip's matte and stops drawing on its own while consumed.
   * `alpha` multiplies by the source's alpha; `luma` by its luminance (transparent reads as black).
   * Resolved per frame in `buildSceneDraws` — when no source clip is present at a time the matte is
   * EMPTY (clip invisible; fully visible when `invert`). Static (not keyframable) for now.
   */
  trackMatte?: { mode: "alpha" | "luma"; invert?: boolean | undefined } | undefined;
  /**
   * Texture fill (D2, text + shape layers): the glyphs / shape body paint with an IMAGE instead of the
   * solid colour. Applied as a canvas pattern inside the shared rasterizer, so all renderers agree.
   *
   * **DECOMPOSED in ADR-023 S5b, from `{ assetId?, url, fit, scale }`.** The composite could not be
   * described by the frozen ADR-003 taxonomy without either a new kind or the `custom` hatch, and
   * ADR-003's own precedent says not to reach for either: *lut* is deliberately not a kind, it is
   * `reference` + `number` (ADR-003 line 38). So the image is a `reference`/asset, the fit is an
   * `enum` and the scale is a `number` — three fields the renderer already builds, which is what makes
   * this a picker rather than a bespoke widget (S4b, `279a616`).
   *
   * **The `url` did not survive, and that is the decomposition working rather than losing something.**
   * A reference serializes as an id (ADR-003); a URL is a machine- and account-specific *resolution* of
   * that id, which is exactly what must NOT be baked into project data a preset will carry to another
   * machine. The render address is resolved once, in shared, by
   * `CompositionStyleOptions.resolveAssetUrl` — the same "resolve once and hand both paths the same
   * concrete answer" shape T-13 was corrected into. What is genuinely narrowed: a fill must now be a
   * project asset rather than an arbitrary URL. Nothing could author an arbitrary URL (there was no
   * editor at all), so no capability a user had is gone, and fills now inherit the local-first asset
   * doctrine for free.
   *
   * **ABSENT MEANS NO TEXTURE, permanently and without migration** — the D1a shape. There is no legacy
   * data to migrate: nothing ever wrote the composite.
   */
  fillTextureAssetId?: string | undefined;
  /** `cover` scales the image to fill the element box (× `scale`); `tile` repeats it at natural size × `scale`. */
  fillTextureFit?: "cover" | "tile" | undefined;
  fillTextureScale?: number | undefined;
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
/** Bezier easing handle on a speed-ramp point — the graph's `temporal` handle convention:
 *  `dx` = SIGNED fraction of the neighbor segment's duration (out ≥ 0 forward, in ≤ 0 backward),
 *  `dy` = fraction of the segment's value delta. Fractions keep the ease shape stable when a
 *  neighbor point is retimed (AE behavior) and plug straight into the graph editor's handle UI. */
export interface SpeedHandle {
  dx: number;
  dy: number;
}

export interface SpeedKeyframe {
  timeSeconds: number;
  value: number;
  /** Stable identity for UI selection/dragging (graph editor speed lane). Optional: older saved
   *  ramps and points minted before this field existed have none — callers fall back to a
   *  position-derived key rather than treat it as required. */
  id?: string | undefined;
  /** S1 bezier easing (2026-07-17): absent = linear on that side, so pre-S1 ramps are untouched.
   *  The timeline→source mapping stays EXACT — an eased segment integrates in closed form
   *  (∫y·x′ ds is polynomial); see `integrateRamp` in timeline.ts. */
  inHandle?: SpeedHandle | undefined;
  outHandle?: SpeedHandle | undefined;
  /** Graph-lane "linked handles" affordance state (mirror-drag), persisted like temporal.linked. */
  handlesLinked?: boolean | undefined;
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
   * Managed color contract for this composition (working/output space + range + effect light).
   * Persisted in the `ProjectGraph` JSON blob; no schema migration needed.
   *
   * **Absent means LEGACY, not "default".** A composition that never stored this was authored before
   * the linear-light effect stage existed, so it normalizes to {@link LEGACY_PROJECT_COLOR_SETTINGS}
   * (display-referred effects) and keeps rendering exactly as it always did. New compositions stamp
   * {@link NEW_PROJECT_COLOR_SETTINGS} explicitly at creation rather than relying on any default.
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
