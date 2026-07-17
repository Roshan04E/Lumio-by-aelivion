import { Fragment, lazy, memo, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Download,
  Eye,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Cloud,
  CloudOff,
  CloudUpload,
  Diamond,
  Droplet,
  FileCode,
  Clapperboard,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Grid2X2,
  Image,
  Layers,
  MoreVertical,
  Palette,
  Plus,
  Search,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CaseSensitive,
  Italic,
  LayoutList,
  Lock,
  Maximize2,
  Minimize2,
  MonitorDown,
  PanelRightClose,
  PanelRightOpen,
  Move,
  PanelLeftClose,
  PanelLeftOpen,
  MoveHorizontal,
  MoveVertical,
  Image as ImageIcon,
  Music,
  PaintBucket,
  Pause,
  PenLine,
  Pipette,
  Play,
  FileText,
  Radius,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Settings,
  LayoutTemplate,
  SkipBack,
  SkipForward,
  GripVertical,
  SlidersHorizontal,
  Sparkles,
  Spline,
  Square,
  StepBack,
  StepForward,
  Trash2,
  Type,
  Upload,
  X
} from "lucide-react";
import {
  applyTimelineTemplatePackage,
  buildKimeraPackageZipAsync,
  buildTimelineTemplatePackage,
  buildTemplateGraphFromProject,
  exportCompositionToFcpxml,
  isKimeraPackageZipBytes,
  parseKimeraPackageZipAsync,
  buildTransitionKeyframes,
  COLOR_EFFECT_TYPES,
  getTransition,
  TRANSITION_MARKER,
  applyJunctionTransition,
  removeJunctionTransition,
  findTransitionCutForClip,
  resolveTransitionWindowSides,
  effectiveTransitionDuration,
  trimOutgoingForTransition,
  advanceIncomingSourceForTransition,
  DEFAULT_CROSS_DISSOLVE_SECONDS,
  canApplyEffectManifestToLayer,
  createTimelineEffect,
  createTimelineEffectFromManifest,
  resolveEffectManifest,
  resolveLookManifest,
  defaultTextWarp,
  ensureComposition,
  evaluateTimelineEffectParam,
  evaluateTimelineTransform,
  estimateCreditsForEffects,
  flattenTimelineLayers,
  getFragmentEffect,
  getLayerAnimations,
  getTimelineEffectDefinition,
  getTimelineEffectsForLayer,
  SHADER_MANIFEST_ID_PARAM_KEY,
  isExternalTimelineFile,
  normalizeTimelineEffect,
  normalizeTimelineMarkers,
  parseExternalTimelineFile,
  renderSafeFonts,
  splitLayerAtTime,
  commitGroupMove,
  DEFAULT_EDITING_POLICY,
  ensureVacantEdgeTracks,
  rippleDeleteLayer,
  rippleTrimLayer,
  rollEditAtCut,
  slideLayer,
  trimLayerEdgeTo,
  resolveEdgeTrim,
  applyEdgeTrim,
  collectEditPoints,
  copyLayerAttributes,
  hasClipboardAttributes,
  pasteLayerAttributes,
  duplicateLayer,
  moveLayerWithinTrack,
  copyLayerToClipboard,
  getLayerSpeed,
  getLayerSpeedAt,
  getSpeedRamp,
  layerSourceSecondsConsumed,
  upsertSpeedRampPoint,
  removeSpeedRampPoint,
  getToolCapability,
  getTrackAudioGainAt,
  getTrackPanAt,
  hasClipboardLayer,
  pasteLayerFromClipboard,
  parseTimelineTemplatePackage,
  resolveTargetLayer,
  trackingPathToPositionKeyframes,
  timelineTemplatePackageToJson,
  updateTimelineLayer,
  updateTimelineLayers,
  deriveNestBreadcrumb,
  getNestedSourceDurationSeconds,
  healCompositionRegistry,
  nestLayersIntoComposition,
  stampCompositionRegistry,
  unnestClip,
  wouldCreateCompositionCycle,
  type NestBreadcrumbEntry,
  applyTextStyle,
  captureTextStyle,
  createTextStyleFromLayer,
  createDefaultMask,
  containContentRect,
  type AssetSource,
  type ImportedExternalTimeline,
  type Mask,
  type ProjectGraph,
  type TextStyle,
  type PluginEffectManifest,
  type PluginLookManifest,
  type PluginTransitionManifest,
  sourceColorWarnings,
  colorWarningsLabel,
  type RenderJob,
  type SourceAsset,
  type SourceColorMetadata,
  type ShapeKind,
  type StockOrientation,
  type StockResult,
  type StockVariant,
  type TextWarp,
  type TextWarpStyle,
  type TimelineComposition,
  type TimelineCompositionSettings,
  type TimelineEffect,
  type TimelineEffectParamDefinition,
  type TimelineImportReportItem,
  type KeyframeInterpolation,
  type SourceTextKeyframe,
  type TextRun,
  type MaskPoint,
  type TimelineKeyframeV2,
  type TimelineLayer,
  type TimelineLayerType,
  type TimelineToolMode,
  type TimelineTrack,
  type ToolCapabilityDefinition,
  type TrackAudioKeyframe,
  type TrackingPathArtifactData,
  type TransitionKind,
  type TransitionSpec
} from "@kimera-by-aelivion/shared";
import { AiActivityIndicator } from "../components/AiActivityIndicator";
// Lazy: the AI chat panel pulls the whole ai/ graph (planner, executor, memory, talk streaming)
// — none of it should load until the AI dock is actually opened.
const AiChatPanel = lazy(() => import("../components/ai/AiChatPanel").then((module) => ({ default: module.AiChatPanel })));
// Lazy: the Generate Studio pulls the generation client + local-gen probes — load on demand.
const GenerateStudio = lazy(() => import("../components/generate/GenerateStudio").then((module) => ({ default: module.GenerateStudio })));
import type { GenerateStudioPrefill } from "../components/generate/GenerateStudio";
import type { ToolStepResult } from "../ai/executor/PlanExecutor";
import type { PlanStep } from "../ai/types";
import { NumberControl } from "../editor/inspector/controls/NumberControl";
import { KeyframeButtons } from "../editor/inspector/controls/KeyframeButtons";
import { ThemedSelect, type ThemedSelectGroup } from "../editor/inspector/controls/ThemedSelect";
import { InspectorHost } from "../editor/inspector/InspectorHost";
import {
  validateEditorCommand,
  type EditorCommandId,
  type EditorCommandParams,
  type EditorCommandResult
} from "../editor/editor-commands";
import { loadWakeWordEnabled } from "../ai/wake-word";
import { AutoKeyframeContext } from "../editor/inspector/autoKeyframeContext";
import type { MaskTool } from "../editor/registry/inspector";
import { recordMaskPoints } from "../editor/inspector/maskKeyframeUtils";
import { EffectMaskControls } from "../editor/inspector/EffectMaskControls";
import { InspectorSection } from "../editor/inspector/InspectorSection";
import { InspectorTabs, rememberInspectorTab, rememberedInspectorTab, type InspectorTabId } from "../editor/inspector/InspectorTabs";
import GraphicsStackPanel from "../editor/inspector/panels/GraphicsStackPanel";
import GraphicsAlignPanel from "../editor/inspector/panels/GraphicsAlignPanel";
import GraphicsPinPanel from "../editor/inspector/panels/GraphicsPinPanel";
import { reflowCompositionForResize } from "../editor/inspector/panels/graphicsReflow";
import { TextStylesSection } from "../editor/inspector/TextStylesSection";
import { FrameEffectCard } from "../editor/inspector/FrameEffectCard";
import { deleteGraphicPreset, listGraphicPresets, subscribeGraphicPresets } from "../editor/graphic-presets";
import { RichTextEditor } from "../components/RichTextEditor";
import { BottomWorkspace } from "../editor/graph/BottomWorkspace";
import { seedBuiltinRegistries } from "../editor";
import { getPreviewQualityProfile } from "../editor/performance/previewQuality";
import { isAdaptiveQualityOn, setAdaptiveQualityOn } from "../editor/performance/adaptive-quality";
import {
  createPreviewCacheController,
  previewPluginSignature,
  previewCacheRulerSegments,
  summarizePreviewCacheStatus,
  type CachedPreviewSpan,
  type PreviewCacheController,
  type PreviewCacheRulerSegment,
  type ProxyCacheStatus,
  type TimelineInterval
} from "../editor/performance/renderCache";
import { createProxyBlobStore, isProxyMediaSupported, type ProxyBlobStore } from "../editor/performance/proxyMediaStore";
import { generateSpanProxy, ProxyGenerationAborted, type ProxyGenerationDiagnostic } from "../editor/performance/proxyWorkerClient";
import { SpanVerificationAborted, verifySpanBlobIntegrity } from "../editor/performance/spanVerification";
import { ensureSourceProxy, setSourceProxyBuildSuspended, setSourceProxyFirstBuildListener } from "../editor/performance/sourceProxyEngine";
import { isBackgroundWorkAllowed, setBackgroundGate, subscribeBackgroundGate } from "../editor/performance/backgroundScheduler";
import { ensureDegradationControllerStarted } from "../editor/performance/degradation";
import { captureSpanProxyFromViewer, verifySpanProxyAgainstViewer, ViewerCaptureAborted } from "../editor/performance/viewerProxyCapture";
import { getProxyViewerCaptureEnabled } from "../color/render-engine";
import type { SceneViewerCaptureHandle } from "../components/ScenePreviewCanvas";
import type { ProxyPlaybackHit } from "../components/ProxyPlaybackLayer";
import {
  applyAnimationPreset,
  applyContentValueAtTime,
  applyEffectParamValueAtTime,
  applyStyleValueAtTime,
  applyTransformValueAtTime,
  clearEffectParamKeyframes,
  clearStyleKeyframes,
  findStyleKeyframe,
  getActiveStyleKeyframe,
  getStyleKeyframes,
  keyframeTimeTolerance,
  setStyleKeyframeInterpolation,
  styleValueAt,
  toggleStyleKeyframe,
  findEffectParamKeyframe,
  getActiveEffectParamKeyframe,
  getEffectParamKeyframes,
  mintKeyframeId,
  setEffectParamInterpolation,
  toggleEffectParamKeyframe,
  updateEffectParamAtTime,
  updatePositionKeyframesAtTime,
  updatePositionSpatialHandleAtTime,
  type AnimationPresetId
} from "../editor/inspector/keyframeUtils";
import { useAutoKeyframe } from "../editor/inspector/autoKeyframeContext";
import { Badge } from "../components/Badge";
import { ColorWheels } from "../components/ColorWheels";
import { CurveEditor } from "../components/CurveEditor";
import { ScrubNumberInput } from "../components/ScrubNumberInput";
import { EffectSliderControl } from "../components/EffectSliderControl";
import { EffectPresetRow } from "../components/EffectPresetRow";
import { effectSliderTone } from "../components/effectSliderTone";
import { HueSatCurves } from "../components/HueSatCurves";
import { HslSecondary } from "../components/HslSecondary";
import { LutFileImport } from "../components/LutFileImport";
import { ColorScopes, type ScopeFrameSampler } from "../components/ColorScopes";
import { LumetriPanel } from "../components/LumetriPanel";
import { Button } from "../components/Button";
import { ColorControl } from "../components/ColorControl";
import { CreditBadge } from "../components/CreditBadge";
import { EmptyState } from "../components/EmptyState";
import { ResetButton } from "../components/ResetButton";
import { TimelineStrip, type ShapeAddOptions } from "../components/TimelineStrip";
import { TimelineAudioMeters } from "../components/TimelineAudioMeters";
import { AudioMixerPanel } from "../components/AudioMixerPanel";
import { analyzeSidechainRegions, applyDuckingKeyframes, type DuckingOptions } from "../editor/audio-ducking";
import { setIngestProxyPlaybackEnabled, VideoPreview } from "../components/VideoPreview";
import { SourceMonitor, type SourceDragPayload } from "../components/SourceMonitor";
import { applyThreePointEdit, type ThreePointEditRequest, type ThreePointOp } from "../editor/three-point-edit";
import { flushColdPlaybackNotify, getPlaybackClock, setColdPlaybackSuspended, setLivePlaybackTimeReader, setPlaybackClock, useColdPlaybackTime, usePlaybackClock } from "../playback/playback-clock";
import { HARD_RESYNC_S, MAX_SERVO_PER_TICK_S, SERVO_GAIN, getAudioClockEnabled, getAudioMasterTime, noteAudioClockDrift } from "../playback/audio-clock";
import { EDITOR_RESPONSIVE_LAYOUT, getEditorPaneResizeBounds, useEditorResponsiveLayout, type EditorOverlayPanel } from "../editor/responsive-layout";
import { averageTrackConfidence, type SavedTrack } from "../lib/trackLibrary";
import {
  createAsset,
  cancelJob,
  createTemplate,
  deleteAsset,
  deleteTemplate,
  exportFinal,
  generatePreview,
  getProject,
  getRenderManifest,
  getStockStatus,
  importStock,
  fetchAssetById,
  getLinkedAssetIdsForProject,
  linkAssetToProject,
  listAssets,
  listProjectAssets,
  listMyTemplates,
  presignAssetUpload,
  updateLocalAssetRecord,
  listPluginPackages,
  searchStock,
  STOCK_PAGE_SIZE,
  updateAssetFolder,
  updateAssetTags,
  AuthRequiredError,
  type ProjectRecord
} from "../lib/api";
import { usePro } from "../lib/proMode";
import { collectGraphAssetIds, ensureProjectMediaLocal, refreshAssetFromCloud } from "../lib/media-pull";
import { putBlobToCloud } from "../lib/cloud-upload";
import { searchIconifyGraphics, fetchIconifySvg, type IconifyGraphicResult } from "../lib/graphics-search";

/** How many Iconify results the Graphics chip requests per "Show more" step (the API has no offset paging,
 *  so each step re-fetches at a higher limit). Also the recommendation-strip size. */
const GRAPHICS_PAGE_SIZE = 40;

/** Default object-fit for a freshly dropped media layer. Images/graphics land at their natural aspect
 *  (`contain`, Canva-style — a circle stays a circle, nothing is silently cropped); video fills the frame
 *  (`cover`) as before. Users can still switch fit per clip in the inspector. */
function defaultMediaFit(type: TimelineLayerType): "cover" | "contain" {
  return type === "image" ? "contain" : "cover";
}

/** Derive a search keyword for magic recommendations from a graphic's display name — the first meaningful
 *  word (skipping generic filler), lowercased. Returns "" when nothing usable remains. */
function graphicRecommendKeyword(name: string): string {
  const stop = new Set(["the", "a", "an", "icon", "outline", "solid", "fill", "filled", "line"]);
  const words = name.toLowerCase().replace(/[-_]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !stop.has(w));
  return words[0] ?? "";
}
import {
  listBundledGraphics,
  searchBundledGraphics,
  builtInFrames,
  makeLayerFrame,
  setFrameBoxFromResize,
  frameGroupScaleFactor,
  frameOutlinePathD,
  type FrameDefinition,
  instantiateTemplateComposition,
  normalizeGraphicSvg,
  extractSvgPalette,
  getCompositionTextRuns,
  graphicToDataUrl,
  DEFAULT_GRAPHIC_FILL,
  type BundledGraphic,
  type LayerGraphic,
  type TemplateDefinition
} from "@kimera-by-aelivion/shared";
import { getVideoPoster, useVideoPoster } from "../lib/videoThumbnails";
import { ASSET_LABEL_COLORS, assetLabelOf, defaultAssetLabelOf, tagsWithAssetLabel } from "../lib/assetLabels";
import { assetHasAudioStream } from "../lib/assetAudio";
import { getAssetBlobStore } from "../lib/asset-blob-store";
import { useRenderCost } from "../lib/perfDiagnostics";
import { useStableHandler, useStableHandlers } from "../lib/useStableHandler";
import { NoticeToast, getNotice, setNotice } from "../lib/noticeStore";
import {
  checkNow,
  clearLocalAssetPromotion,
  countLocalProjectsUsingAsset,
  ensureExportReady,
  getAssetPromotionMap,
  getRecordedServerAssetId,
  markLocalAssetPromoted,
  markServerProjectSynced,
  promoteProject,
  resolveProjectId,
  scheduleGraphSave,
  subscribe as subscribeSync,
  RelinkRequiredError,
  SyncRequiredError,
  type RelinkAssetNeed
} from "../lib/sync";
import { discardRecoveryCheckpoint, readRecoveryCheckpoint, type RecoveryCheckpoint } from "../lib/crash-recovery";
import { SyncBadge } from "../components/SyncBadge";
import { RelinkMediaModal } from "../components/RelinkMediaModal";
import { canExportLocally, exportLocally, saveExportedFile } from "../export/local-export";
import type { ExportFormat } from "../export/video-encoder";
import { detectSourceMetadataFromFile } from "../export/source-color";
import { probeDecodableEndSeconds } from "../export/webcodecs-decoder";
import { Modal } from "../components/Modal";
import { PasteAttributesModal } from "../components/PasteAttributesModal";
import { AssetViewerModal, type AssetViewerTarget } from "../components/AssetViewerModal";
import { buildBackgroundColor, parseBackgroundColor } from "../lib/colorBackground";
import { defaultColorPalette, extractPaletteFromAsset } from "../lib/colorPalette";
import { useWheelScrollPerformance } from "../lib/useWheelScrollPerformance";
import {
  EMPTY_IMPORTED_PLUGIN_LIBRARY,
  hydrateEffectManifests,
  hydrateLookManifests,
  hydrateTransitionManifests,
  loadHiddenEffectManifestIds,
  loadHiddenLookManifestIds,
  loadHiddenTransitionManifestIds,
  loadImportedPluginLibrary,
  mergeLookManifest,
  mergeEffectManifest,
  mergeTransitionManifest,
  removeEffectManifest,
  removeLookManifest,
  removeTransitionManifest,
  normalizeImportedPluginLibrary,
  pluginPackagesToImportedLibrary,
  saveHiddenEffectManifestIds,
  saveHiddenLookManifestIds,
  saveHiddenTransitionManifestIds,
  saveImportedPluginLibrary,
  type ImportedPluginLibrary
} from "../editor/effects/pluginManifestStore";

function proxyDebugEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return (
      params.get("debugGl") === "1" ||
      params.get("debugProxy") === "1" ||
      window.localStorage?.getItem("kimera_debug_gl") === "1" ||
      window.localStorage?.getItem("kimera_debug_proxy") === "1"
    );
  } catch {
    return false;
  }
}

// Lazy-loaded so the editor's initial chunk stays light: the Effects panel + its catalog load when
// the Effects tab opens, and the tool-runner modals (which pull the heavy ML handler graph) load
// only when a tool is actually run.
const EffectGraphPanel = lazy(() => import("../components/EffectGraphPanel"));
type TransitionApplySpec = import("../components/EffectGraphPanel").TransitionApplySpec;
const ToolEffectRunnerModal = lazy(() =>
  import("../components/ToolEffectRunnerModal").then((module) => ({ default: module.ToolEffectRunnerModal }))
);
const SmartFollowTextEffectModal = lazy(() =>
  import("../components/SmartFollowTextEffectModal").then((module) => ({ default: module.SmartFollowTextEffectModal }))
);
// Tracking workspace pulls the browser ML tracking/segmentation graph — load it only when opened.
const TrackWorkspaceModal = lazy(() =>
  import("../components/TrackWorkspaceModal").then((module) => ({ default: module.TrackWorkspaceModal }))
);

const defaultTextStyle = {
  fontFamily: renderSafeFonts[0].family,
  fontSize: 72,
  fontWeight: 900,
  italic: false,
  letterSpacing: 0,
  lineHeight: 0.95,
  textAlign: "center" as const,
  textWidthPercent: 0,
  color: "#4D9FFF",
  strokeColor: "#161618",
  strokeWidth: 0,
  backgroundColor: "transparent",
  backgroundPaddingEm: 0.08,
  backgroundRadiusEm: 0.1,
  shadowColor: "#000000",
  shadowBlur: 19,
  shadowOffsetX: 0,
  shadowOffsetY: 7,
  textWarp: defaultTextWarp
};
const defaultShapeStyle = {
  shapeKind: "rounded-rectangle" as const,
  widthPercent: 44,
  heightPercent: 18,
  borderRadius: 22,
  color: "#4D9FFF",
  strokeColor: "#ffffff",
  strokeWidth: 0,
  shadowColor: "#000000",
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 8
};

const shapeKindOptions: Array<{ value: ShapeKind; label: string }> = [
  { value: "rectangle", label: "Rectangle" },
  { value: "rounded-rectangle", label: "Rounded rectangle" },
  { value: "ellipse", label: "Ellipse / circle" },
  { value: "line", label: "Line" },
  { value: "triangle", label: "Triangle" },
  { value: "diamond", label: "Diamond" },
  { value: "pentagon", label: "Pentagon" },
  { value: "pen", label: "Pen" }
];

function defaultShapePathPoints(prefix: string): MaskPoint[] {
  const points = [
    { id: `${prefix}_top`, x: 50, y: 4 },
    { id: `${prefix}_right`, x: 96, y: 50 },
    { id: `${prefix}_bottom`, x: 50, y: 96 },
    { id: `${prefix}_left`, x: 4, y: 50 }
  ];
  return points.map((point, index) => {
    const prev = points[(index - 1 + points.length) % points.length]!;
    const next = points[(index + 1) % points.length]!;
    const dx = (next.x - prev.x) * 0.33;
    const dy = (next.y - prev.y) * 0.33;
    return {
      ...point,
      inTangent: { x: -dx, y: -dy },
      outTangent: { x: dx, y: dy },
      lockedTangents: true
    };
  });
}

/**
 * Isolates a playhead-time re-render to its own subtree. EditorPage NO LONGER holds `currentTime` in
 * React state (that re-rendered the whole ~9000-line tree on every ruler click / scrub settle — the
 * ~250–600ms cold-commit blocks in the 2026-07-04 __rfRenderCost captures). Instead the few panels
 * that need the playhead at a low rate — inspector keyframe readouts, color scopes, audio-mixer
 * readouts — render through this wrapper, which subscribes to the LOW-RATE cold clock
 * (`useColdPlaybackTime`, ≤120ms) so only THIS subtree re-renders on a playhead move, never
 * EditorPage. The render-prop closure captures the panel's other props from EditorPage's last real
 * render — stable between edits, since a playhead move no longer re-renders EditorPage at all.
 */
function ColdTime({ children }: { children: (currentTime: number) => ReactNode }) {
  const currentTime = useColdPlaybackTime();
  return <>{children(currentTime)}</>;
}

/**
 * Transport time readout. Subscribes to the high-frequency playback clock directly so the number
 * stays smooth during playback WITHOUT re-rendering `EditorPage` every tick (the whole point of the
 * clock store), and tracks paused seeks/scrubs instantly. `fallback` is only used before the first
 * clock push (fixtures/tests); the editor always drives the clock.
 */
function PlayheadTimeReadout({ fallback }: { fallback: number }) {
  const time = usePlaybackClock(fallback, true);
  return <span className="viewer-time-readout">{time.toFixed(2)}s</span>;
}

/**
 * Slip two-up (Premiere-style): while a slip drag is live in the timeline, show the slipped range's
 * first + last frame over the viewer. Fed by a window event (`lumio:slip-preview`) instead of
 * EditorPage state so per-pointermove updates re-render ONLY this overlay, never the page tree
 * (selection-render-diet doctrine). `resolve` maps a layerId to its playable URL + source-domain
 * span at event time (refs inside, so it never goes stale mid-drag).
 */
function SlipTwoUpOverlay({
  resolve
}: {
  resolve: (layerId: string) => { url: string; durationSourceSeconds: number } | null;
}) {
  const [slip, setSlip] = useState<{ layerId: string; sourceInSeconds: number } | null>(null);
  const inVideoRef = useRef<HTMLVideoElement | null>(null);
  const outVideoRef = useRef<HTMLVideoElement | null>(null);
  // LATEST-WINS SEEK SCHEDULER: a <video> can only run one seek at a time, and issuing a new
  // `currentTime` while `seeking` is true queues behind the in-flight one — a fast drag stacked
  // dozens of seeks and the frames arrived seconds late ("not real time"). Instead each side keeps
  // ONE pending target: while a seek is in flight new targets just overwrite it, and the `seeked`
  // handler chases the latest. During the drag we use `fastSeek` when available (nearest keyframe —
  // cheap); a short settle timer lands one precise seek when the pointer pauses.
  const seekStateRef = useRef<{ in: { target: number; settle: number | null }; out: { target: number; settle: number | null } }>({
    in: { target: -1, settle: null },
    out: { target: -1, settle: null }
  });
  useEffect(() => {
    const onSlip = (event: Event) => {
      setSlip((event as CustomEvent<{ layerId: string; sourceInSeconds: number } | null>).detail ?? null);
    };
    window.addEventListener("lumio:slip-preview", onSlip);
    return () => window.removeEventListener("lumio:slip-preview", onSlip);
  }, []);
  const media = slip ? resolve(slip.layerId) : null;
  const inSeconds = slip?.sourceInSeconds ?? 0;
  const outSeconds = inSeconds + (media?.durationSourceSeconds ?? 0);
  useEffect(() => {
    const frame = 1 / 30;
    const issueFast = (video: HTMLVideoElement, target: number) => {
      const fastSeek = (video as HTMLVideoElement & { fastSeek?: (time: number) => void }).fastSeek;
      if (typeof fastSeek === "function") fastSeek.call(video, target);
      else video.currentTime = target;
    };
    const requestSeek = (video: HTMLVideoElement | null, side: "in" | "out", target: number) => {
      if (!video || !Number.isFinite(target)) return;
      const state = seekStateRef.current[side];
      state.target = target;
      // Precise settle once the drag pauses — fastSeek only guarantees a nearby keyframe.
      if (state.settle !== null) window.clearTimeout(state.settle);
      state.settle = window.setTimeout(() => {
        state.settle = null;
        if (!video.seeking && Math.abs(video.currentTime - state.target) > frame / 2) {
          video.currentTime = state.target;
        }
      }, 180);
      if (video.seeking) return; // in flight — the seeked handler chases state.target
      if (Math.abs(video.currentTime - target) < frame / 2) return;
      issueFast(video, target);
    };
    const chase = (video: HTMLVideoElement, side: "in" | "out") => () => {
      const state = seekStateRef.current[side];
      if (Math.abs(video.currentTime - state.target) > frame) {
        issueFast(video, state.target);
      }
    };
    const inVideo = inVideoRef.current;
    const outVideo = outVideoRef.current;
    const inChase = inVideo ? chase(inVideo, "in") : null;
    const outChase = outVideo ? chase(outVideo, "out") : null;
    if (inVideo && inChase) inVideo.addEventListener("seeked", inChase);
    if (outVideo && outChase) outVideo.addEventListener("seeked", outChase);
    if (media) {
      requestSeek(inVideo, "in", inSeconds);
      requestSeek(outVideo, "out", outSeconds);
    }
    return () => {
      if (inVideo && inChase) inVideo.removeEventListener("seeked", inChase);
      if (outVideo && outChase) outVideo.removeEventListener("seeked", outChase);
      for (const side of ["in", "out"] as const) {
        const state = seekStateRef.current[side];
        if (state.settle !== null) {
          window.clearTimeout(state.settle);
          state.settle = null;
        }
      }
    };
  }, [media, inSeconds, outSeconds]);
  if (!slip || !media) {
    return null;
  }
  return (
    <div className="viewer-slip-two-up" aria-label="Slip preview: first and last frame">
      <figure>
        <video ref={inVideoRef} src={media.url} muted playsInline preload="auto" />
        <figcaption>IN {inSeconds.toFixed(2)}s</figcaption>
      </figure>
      <figure>
        <video ref={outVideoRef} src={media.url} muted playsInline preload="auto" />
        <figcaption>OUT {outSeconds.toFixed(2)}s</figcaption>
      </figure>
    </div>
  );
}

function downloadJsonFile(contents: string, fileName: string) {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadBlobFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function safeFileStem(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "kimera-template"
  );
}

type LayerSelectMode = "replace" | "toggle" | "range" | "add-range";
type LayerCollectionSelectMode = "replace" | "add" | "toggle";
type ExternalTimelineImportMode = "replace" | "append";
type EditorHistorySnapshot = {
  durationSeconds: number;
  projectGraph: ProjectGraph;
};

/** Platform-correct modifier labels for shortcut hints (⌘/⌥ on macOS, Ctrl/Alt elsewhere). */
const isMacPlatform = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
const shortcutModifierLabel = isMacPlatform ? "⌘" : "Ctrl";
const altKeyLabel = isMacPlatform ? "⌥" : "Alt";

export function EditorPage() {
  // Render-cost probe (window.__rfRenderCost.EditorPage = whole tree per commit).
  useRenderCost("EditorPage");
  // Ensure editor registries (inspector panels, modules, AI commands) are
  // populated before the inspector renders. Idempotent — safe every render.
  seedBuiltinRegistries();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [pro] = usePro();
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // `notice` toasts live in the noticeStore module (leaf <NoticeToast/> below) — the ~106 setNotice
  // call sites no longer re-render this component.
  // Set when export needs missing media bytes re-selected (relink flow).
  const [relinkNeeds, setRelinkNeeds] = useState<RelinkAssetNeed[] | null>(null);
  // Crash-recovery checkpoint found on open that is newer than the loaded project.
  const [recoveryOffer, setRecoveryOffer] = useState<RecoveryCheckpoint | null>(null);
  // Local (in-browser) export progress + cancel.
  const [localExport, setLocalExport] = useState<{ progress: number; label: string } | null>(null);
  const localExportAbortRef = useRef<AbortController | null>(null);
  const [localExportSupported] = useState(() => canExportLocally());
  // Premiere-style export settings (frame rate + format), chosen at export time.
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFps, setExportFps] = useState<number | null>(null); // null → project fps
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mp4");
  // Which saved track (if any) the Track modal is currently editing/retracking - undefined id means "new track".
  const [trackModalState, setTrackModalState] = useState<{ editingTrackId?: string | undefined } | undefined>(undefined);
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([]);
  // Nesting (NESTING_MATURITY.md Block 2): when non-empty, `composition`/`graph.composition` is a
  // NESTED sequence being edited in place (swap trick — see `handleOpenNestedClip`) and this is the
  // ancestor chain root→…→direct parent. Multi-level (nests-in-nests open fine). Restored on load
  // from the persisted root/active pointers via `healCompositionRegistry`, so a refresh inside a
  // group no longer strands the project.
  const [nestPath, setNestPath] = useState<NestBreadcrumbEntry[]>([]);
  // The playhead lives in `currentTimeRef` + the clock store ONLY — no React `currentTime` state.
  // Hot leaves (preview, timeline playhead, timecode) ride the clock store; cold panels (inspector,
  // scopes, mixer) subscribe to the throttled cold clock via <ColdTime>. A playhead move therefore
  // never re-renders EditorPage.
  // When a transition is applied with no selection and several clips sit under the playhead, ask which.
  const [transitionChoice, setTransitionChoice] = useState<{ spec: TransitionApplySpec; candidates: TimelineLayer[] } | null>(null);
  const [assets, setAssets] = useState<SourceAsset[]>([]);
  const [panelTab, setPanelTab] = useState<"assets" | "effects" | "color" | "settings">("assets");
  // Clip properties now live in the always-visible right Inspector (driven by selection), so actions that
  // used to switch the left panel to a "Controls" tab just need the clip selected — this is the shim.
  const focusInspector = () => {};
  // Expanded-panel layout: a side panel takes the full window height and the timeline
  // moves under the viewer (giving controls/effects room when they get dense). The left
  // (browse) panel and the right (Inspector) each get their own toggle.
  const [panelExpanded, setPanelExpanded] = useState(false);
  // Inspector opens FULL height (founder call 2026-07-15): editors spend most of their time in property
  // edits, so the dense panel gets the room by default and half-height is the opt-in (Alt+R / the
  // header toggle). Only the DEFAULT flipped — the toggle itself is unchanged.
  const [inspectorExpanded, setInspectorExpanded] = useState(true);
  // Fully collapse the Inspector to a slim rail — reclaims its width (handy when the AI
  // dock is open and the viewer gets cramped). Starts COLLAPSED (user request 2026-07-11):
  // the viewer gets the space until the user opens the inspector.
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  // Same idea for the left browse panel — collapse to a rail to give the viewer full width.
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // Masking (Phase 2): active draw tool, the mask being edited in the preview, and overlay visibility.
  const [maskTool, setMaskTool] = useState<MaskTool>("select");
  const [activeMaskId, setActiveMaskId] = useState<string | null>(null);
  // Picking a DRAW tool (rect/ellipse/polygon/pen) also turns the mask overlay on, so the tool always has a
  // surface to draw into even if the overlay was toggled off — otherwise the viewer top-bar tools look dead.
  const changeMaskTool = useCallback((tool: MaskTool) => {
    setMaskTool(tool);
    if (tool !== "select") setShowMasks(true);
  }, []);
  // When set, the preview overlay edits this effect's region masks (Phase 3) instead of the clip masks.
  const [activeMaskEffectId, setActiveMaskEffectId] = useState<string | null>(null);
  const [showMasks, setShowMasks] = useState(true);
  // Auto-keyframe ("stopwatch") mode — when on, editing any keyframeable value (inspector or in-viewer
  // gesture) drops a keyframe at the playhead. Default off, matching After Effects / Premiere.
  const [autoKeyframe, setAutoKeyframe] = useState(false);
  // Bottom workspace (Graph editor drawer, Shift+G). Also opened by the
  // "kimera:open-graph-editor" event from inspector rows / timeline keyframe diamonds.
  const [bottomWorkspaceOpen, setBottomWorkspaceOpen] = useState(false);
  const [graphFocusTargetKey, setGraphFocusTargetKey] = useState<string | undefined>(undefined);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.shiftKey && (event.key === "G" || event.key === "g"))) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      setBottomWorkspaceOpen((open) => !open);
    };
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ targetKey?: string }>).detail;
      setGraphFocusTargetKey(detail?.targetKey);
      setBottomWorkspaceOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("kimera:open-graph-editor", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("kimera:open-graph-editor", onOpen);
    };
  }, []);
  // Remember the last single-selected layer so the Controls tab keeps showing
  // its controls after the user deselects (better UX than collapsing to empty).
  const [lastInspectedLayerId, setLastInspectedLayerId] = useState<string | null>(null);
  // When set, the asset bin is in "pick a replacement" mode for this layer; tile
  // clicks swap the clip's asset instead of adding a new layer.
  const [assetPickerForLayerId, setAssetPickerForLayerId] = useState<string | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [pasteAttributesModalOpen, setPasteAttributesModalOpen] = useState(false);
  const [pendingExternalTimelineImport, setPendingExternalTimelineImport] = useState<ImportedExternalTimeline | null>(null);
  const [externalTimelineImportMode, setExternalTimelineImportMode] = useState<ExternalTimelineImportMode>("append");
  // Raw source kept alongside the parsed report so the multi-sequence picker (Task 2.3) can re-parse
  // with a different `sequenceId` without re-prompting the user for the file.
  const [pendingExternalTimelineSource, setPendingExternalTimelineSource] = useState<{ fileName: string; contents: string } | null>(null);
  const templatePackageInputRef = useRef<HTMLInputElement | null>(null);
  const [backendPluginLibrary, setBackendPluginLibrary] = useState<ImportedPluginLibrary>(EMPTY_IMPORTED_PLUGIN_LIBRARY);
  const [hiddenEffectManifestIds, setHiddenEffectManifestIds] = useState<Set<string>>(() => loadHiddenEffectManifestIds());
  const [hiddenLookManifestIds, setHiddenLookManifestIds] = useState<Set<string>>(() => loadHiddenLookManifestIds());
  const [hiddenTransitionManifestIds, setHiddenTransitionManifestIds] = useState<Set<string>>(() => loadHiddenTransitionManifestIds());
  const [activeLayerToolEffect, setActiveLayerToolEffect] = useState<
    { tool: ToolCapabilityDefinition; layer: TimelineLayer; asset: SourceAsset } | undefined
  >(undefined);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  // Bumped by the "/" shortcut to (re)focus the AI composer — a monotonic token so the panel
  // re-focuses even when it was already open. See the "/" keydown effect and AiChatPanel's focusToken.
  const [aiFocusToken, setAiFocusToken] = useState(0);
  // Bumped by the Alt+M shortcut to toggle voice dictation in the AI composer — same token pattern as
  // aiFocusToken. See the Alt+M keydown effect and AiChatPanel's micToggleToken.
  const [aiMicToggleToken, setAiMicToggleToken] = useState(0);
  // Alt+L ("Kimera, listen") → toggle the hands-free VOICE SESSION (distinct from Alt+M dictation).
  // Deliberately does NOT open the chat panel: `aiVoiceWanted` mounts the dock HIDDEN so the
  // session can run, the aurora + the topbar AI button carry the "AI is live" signal, and
  // `aiVoiceActive` mirrors the panel's real session state back up for that button.
  // The toggle travels as a monotonic TOKEN (micToggleToken pattern) — a COMMAND, not state to
  // converge on: the earlier two-way `voiceDesired` boolean ping-ponged with the panel's mirror
  // (each side "correcting" the other's stale value = the infinite on/off loop, seen live).
  const [aiVoiceWanted, setAiVoiceWanted] = useState(false);
  const [aiVoiceActive, setAiVoiceActive] = useState(false);
  const [aiVoiceToggleToken, setAiVoiceToggleToken] = useState(0);
  // "Hey Kimera" standby lives INSIDE AiChatPanel — while the Ear is armed the dock must stay
  // mounted (hidden) even with the chat closed, or the wake word is deaf.
  const [aiWakeArmed, setAiWakeArmed] = useState(loadWakeWordEnabled);
  const [generateStudioOpen, setGenerateStudioOpen] = useState(false);
  const [generateStudioPrefill, setGenerateStudioPrefill] = useState<GenerateStudioPrefill | undefined>(undefined);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackStart, setPlaybackStart] = useState<{ clockMs: number; timeSeconds: number } | null>(null);
  // Transport "A" (Auto) toggle: ON = adaptive quality may drop playback res below the chosen
  // profile under load; OFF = the manual ¼/½/1 choice is absolute (strong-GPU users).
  const [adaptiveResOn, setAdaptiveResOn] = useState(() => isAdaptiveQualityOn());
  const [previewQuality, setPreviewQuality] = useState<"performance" | "balanced" | "quality">(() =>
    readStoredChoice("kimera_preview_quality", "balanced", ["performance", "balanced", "quality"] as const)
  );
  const previewCacheControllerRef = useRef<PreviewCacheController | null>(null);
  const previewCacheRenderStateRef = useRef<{ signature: string; renderScale: number; fps: number; durationSeconds: number } | null>(null);
  const [proxyCacheSegments, setProxyCacheSegments] = useState<PreviewCacheRulerSegment[]>([]);
  const [proxyCacheStatus, setProxyCacheStatus] = useState<ProxyCacheStatus | null>(null);
  // Background proxy generation (worker-driven, playhead-independent). Refs let the async loop read the
  // live isPlaying/asset state without stale closures.
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  // Live selection for keyboard handlers: a keydown can land in the same frame as a selection
  // click, BEFORE the keydown effect re-binds with the new `selectedLayerIds` closure — the ref
  // always reflects the committed selection (the paste-attributes race: V right after a click
  // pasted onto the PREVIOUS clip).
  const selectedLayerIdsRef = useRef<string[]>([]);
  selectedLayerIdsRef.current = selectedLayerIds;
  const proxyBlobStoreRef = useRef<ProxyBlobStore | null>(null);
  const proxyGenAbortRef = useRef<AbortController | null>(null);
  const proxyGenRunningRef = useRef(false);
  // Viewer-capture handle published by ScenePreviewCanvas (todo.md Phase 6B P1a — proxies render through
  // the visible preview's own compositor when `?proxyViewerCapture=1`).
  const proxyCaptureRef = useRef<SceneViewerCaptureHandle | null>(null);
  // Trustworthy scope source: downsample the scene compositor's RETAINED composite (not the fragile
  // DOM `querySelector("canvas")`). Returns null when the scene compositor isn't active → ColorScopes
  // falls back to sampling the DOM preview element and flags itself "approx".
  const scopeSampleBufferRef = useRef<Uint8Array | null>(null);
  const sampleScopeFrame = useCallback<ScopeFrameSampler>((w, h) => {
    const handle = proxyCaptureRef.current;
    if (!handle) return null;
    const need = w * h * 4;
    if (!scopeSampleBufferRef.current || scopeSampleBufferRef.current.byteLength < need) {
      scopeSampleBufferRef.current = new Uint8Array(need);
    }
    const res = handle.readCompositeThumbnail(w, h, scopeSampleBufferRef.current);
    if (!res) return null;
    return {
      data: new Uint8ClampedArray(res.pixels.buffer, res.pixels.byteOffset, res.width * res.height * 4),
      width: res.width,
      height: res.height
    };
  }, []);
  const proxyGenLastReadyRef = useRef<{ id: string; ms: number; bytes: number } | null>(null);
  const proxyGenLastErrorRef = useRef<string | null>(null);
  const proxyGenEventsRef = useRef<Array<ProxyGenerationDiagnostic & { id: string; reason: string; layerIds: string[]; at: number }>>([]);
  const proxyGenFailuresRef = useRef<Array<{ id: string; startSeconds: number; endSeconds: number; reason: string; layerIds: string[]; message: string; at: number }>>([]);
  const resolvedAssetsRef = useRef<SourceAsset[]>([]);
  const [proxyGenSupported] = useState(() => canExportLocally() && isProxyMediaSupported());
  // User escape hatch: play the LIVE compositor instead of preview proxies. When on, no proxies are
  // generated and playback never substitutes one — the viewer is always authoritative (useful while proxy
  // faithfulness is being fixed, or on a machine where generation is costly). Persisted across sessions.
  // Default ON: preview-proxy generation is opt-in (user request 2026-07-14) — most users should get the
  // live compositor by default and turn proxy generation on deliberately if their machine needs it.
  const [livePlaybackMode, setLivePlaybackMode] = useState(
    () => readStoredChoice("kimera_live_playback", "on", ["on", "off"] as const) === "on"
  );
  // Transport "1" with Auto off = FULL-quality playback (see the effect further down): originals play
  // raw, and the span-proxy system goes DORMANT — no generation at scale 1 (expensive, nobody plays it),
  // no playback substitution, and no reconcile at scale 1 (which would DELETE every softer ½/¼ span —
  // see updateProxyCacheRuler). The softer spans stay cached so returning to ½/¼ replays them instantly
  // instead of regenerating. User rule 2026-07-05.
  const fullQualityPlayback = previewQuality === "quality" && !adaptiveResOn;
  const proxyGenActive = proxyGenSupported && !livePlaybackMode && !fullQualityPlayback;
  // Bumped to (re)kick background generation when nothing else in the dep list changed — e.g. after a
  // manual In/Out regenerate, which marks spans dirty without altering the composition reference.
  const [proxyGenNonce, setProxyGenNonce] = useState(0);
  const editorPageRef = useRef<HTMLDivElement | null>(null);
  const [leftPaneWidth, setLeftPaneWidth] = useState(() => readStoredNumber("kimera_editor_left_width", EDITOR_RESPONSIVE_LAYOUT.panes.left.preferred));
  const [rightPaneWidth, setRightPaneWidth] = useState(() => readStoredNumber("kimera_editor_right_width", EDITOR_RESPONSIVE_LAYOUT.panes.right.preferred));
  const [timelineHeight, setTimelineHeight] = useState(() => readStoredNumber("kimera_editor_timeline_height", EDITOR_RESPONSIVE_LAYOUT.panes.timeline.preferred));
  const [timelineTrackHeight, setTimelineTrackHeight] = useState(() => readStoredNumber("kimera_editor_track_height", 44));
  // Fraction (0-1) of .viewer-monitors width given to the source monitor in dual-monitor mode.
  const [sourceMonitorSplit, setSourceMonitorSplit] = useState(() => readStoredNumber("kimera_editor_source_split", 0.5));
  const responsiveLayout = useEditorResponsiveLayout(editorPageRef, { leftPaneWidth, rightPaneWidth, timelineHeight });
  const [activeResponsiveOverlay, setActiveResponsiveOverlay] = useState<EditorOverlayPanel>(null);
  const [expandedResponsiveOverlays, setExpandedResponsiveOverlays] = useState<Set<NonNullable<EditorOverlayPanel>>>(() => new Set());
  const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
  const [editorTheme, setEditorTheme] = useState<EditorThemeId>(() =>
    readStoredChoice("kimera_editor_theme", "blue", EDITOR_THEME_IDS)
  );
  // Accent-theme dropdown — portaled to <body> at the trigger's rect (same pattern as ThemedSelect
  // and the asset menu): CSS-hardcoded fixed coords drifted whenever the topbar layout changed.
  const [themeMenu, setThemeMenu] = useState<{ left: number; top: number } | null>(null);
  const [timelineTool, setTimelineTool] = useState<TimelineToolMode>("select");
  const [snapEnabled, setSnapEnabled] = useState(() => readStoredChoice("kimera_timeline_snap", "on", ["on", "off"] as const) === "on");
  // Magnetic timeline (opt-in, off by default so free positioning stays the norm): when on, a move
  // compacts the touched tracks gapless + overlap-free through the editing-policy seam (commitGroupMove).
  const [magneticEnabled, setMagneticEnabled] = useState(() => readStoredChoice("kimera_timeline_magnetic", "off", ["on", "off"] as const) === "on");
  // Viewer scaling (Premiere-style): "fit" auto-scales the comp to the viewer (re-fits on panel resize);
  // "manual" uses `manualScale` (1:1 — 1.0 = 100% actual pixels). `fitScale` is reported up from the
  // preview (measured from the stable viewer box, no feedback) purely so the toolbar can show the % in
  // fit mode. Single scale end-to-end — no width/height fit modes, no zoom² coupling.
  const [viewMode, setViewMode] = useState<"fit" | "manual">(() =>
    readStoredChoice("kimera_viewer_view_mode", "fit", ["fit", "manual"] as const)
  );
  const [manualScale, setManualScale] = useState(() => readStoredNumber("kimera_viewer_manual_scale", 1));
  const [fitScale, setFitScale] = useState(1);
  const isResponsiveOverlayExpanded = useCallback(
    (panel: NonNullable<EditorOverlayPanel>) => responsiveLayout.usesPhoneShell && expandedResponsiveOverlays.has(panel),
    [expandedResponsiveOverlays, responsiveLayout.usesPhoneShell]
  );
  const toggleResponsiveOverlayExpansion = useCallback((panel: NonNullable<EditorOverlayPanel>) => {
    setExpandedResponsiveOverlays((current) => {
      const next = new Set(current);
      if (next.has(panel)) next.delete(panel);
      else next.add(panel);
      return next;
    });
  }, []);
  const zoomTo = useCallback((scale: number) => {
    setManualScale(scale);
    setViewMode("manual");
  }, []);
  useEffect(() => {
    localStorage.setItem("kimera_viewer_view_mode", viewMode);
  }, [viewMode]);
  const [imagePalette, setImagePalette] = useState(defaultColorPalette);
  const [historyVersion, setHistoryVersion] = useState(0);
  const currentTimeRef = useRef(0);
  const playbackStartRef = useRef<{ clockMs: number; timeSeconds: number } | null>(null);
  // JKL shuttle (see startShuttle): rAF-driven playhead scrub at ±1/2/4x. `shuttleRate` mirrors
  // the ref purely for the viewer badge.
  const shuttleRef = useRef<{ rate: number; raf: number; lastMs: number } | null>(null);
  const [shuttleRate, setShuttleRate] = useState<number | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const undoStackRef = useRef<EditorHistorySnapshot[]>([]);
  const redoStackRef = useRef<EditorHistorySnapshot[]>([]);
  const studioPanelRef = useRef<HTMLElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const viewerSectionRef = useRef<HTMLElement | null>(null);
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  // Source monitor (3-point editing): a video/audio asset opened for preview + In/Out marking,
  // independent of the program viewer/composition — see handleOpenInSourceMonitor.
  const [sourceMonitorAsset, setSourceMonitorAsset] = useState<SourceAsset | null>(null);
  const [sourceInSeconds, setSourceInSeconds] = useState<number | null>(null);
  const [sourceOutSeconds, setSourceOutSeconds] = useState<number | null>(null);
  const [activeMonitor, setActiveMonitor] = useState<"source" | "program">("program");

  useEffect(() => {
    function onFullscreenChange() {
      setViewerFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // Toggle fullscreen for the whole window (same as F11), not just the preview.
  const toggleViewerFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen?.();
    }
  };

  // Top-toolbar panel toggles (DaVinci-style): drives the same panelTab/panelCollapsed
  // state the left panel's own controls use, so behavior stays identical across modes.
  function isLeftPanelTabActive(tab: "assets" | "effects" | "color" | "settings") {
    return responsiveLayout.usesOverlayPanels
      ? activeResponsiveOverlay === "assets" && panelTab === tab
      : !panelCollapsed && panelTab === tab;
  }
  function toggleLeftPanelTab(tab: "assets" | "effects" | "color" | "settings") {
    if (isLeftPanelTabActive(tab)) {
      if (responsiveLayout.usesOverlayPanels) setActiveResponsiveOverlay(null);
      else setPanelCollapsed(true);
      return;
    }
    setPanelTab(tab);
    if (responsiveLayout.usesOverlayPanels) setActiveResponsiveOverlay("assets");
    else setPanelCollapsed(false);
  }
  function toggleInspectorFromTopbar() {
    if (responsiveLayout.usesOverlayPanels) {
      setActiveResponsiveOverlay((current) => (current === "inspector" ? null : "inspector"));
    } else {
      setInspectorCollapsed((value) => !value);
    }
  }
  const isInspectorOpenFromTopbar = responsiveLayout.usesOverlayPanels
    ? activeResponsiveOverlay === "inspector"
    : !inspectorCollapsed;
  /**
   * Full-height Inspector drives the EXPANDED grid (`is-any-expanded` hoists .editor-main via
   * `display: contents` and re-lays the whole editor). A COLLAPSED inspector isn't even mounted, so it
   * must not drag the layout into that mode — otherwise the now-default `inspectorExpanded` would
   * silently drop the viewer's min-height and the panels' min-widths on first load, while the inspector
   * is still a rail. Height intent is remembered; it just doesn't apply until the panel is actually open.
   */
  const inspectorFullHeight = inspectorExpanded && !inspectorCollapsed;

  // Dual source/program monitor (3-point editing): a source asset open + enough width to show
  // both side by side (DaVinci's comfortable-density layout). Below that, a Source|Program tab
  // toggle shows one full-size monitor at a time (14" laptop widths land here).
  const showSourceMonitor = sourceMonitorAsset !== null && !responsiveLayout.usesOverlayPanels;
  const dualMonitors = showSourceMonitor && responsiveLayout.density === "comfortable";

  const [scopesOpen, setScopesOpen] = useState(false);
  // Resolver for an AI-driven tool step: set when the AI executor opens a tool
  // modal, resolved by the modal's Apply (applied) or Close (cancelled) so the
  // executor pauses until the user confirms (e.g. picks tracking points).
  const toolStepResolverRef = useRef<((result: ToolStepResult) => void) | null>(null);

  useWheelScrollPerformance(studioPanelRef);

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }
    let cancelled = false;
    // A previously-promoted local draft redirects to its server project.
    const resolvedId = resolveProjectId(projectId);
    // Load with a bounded retry: getProject now THROWS on a transient miss instead of fabricating a blank
    // "Untitled reel" (which the user could unknowingly edit). A short retry rides out a network blip; only
    // after that do we surface an error — we never replace the user's project with an empty one.
    const loadProject = async (attempt: number): Promise<void> => {
      try {
        const fetched = await getProject(resolvedId);
        if (cancelled) return;
        // Block 2 migration/healer: stamp the composition-registry invariant (main comp lives in
        // `compositions` too, root/active pointers set) and derive the nest breadcrumb from the
        // PERSISTED pointers — this both restores "refresh while inside a group" navigation and
        // heals projects stranded by the old swap bug (nest saved as the root, Main unreachable).
        // Not saved here — the healed shape persists with the first edit through updateGraph.
        const healed = healCompositionRegistry(fetched.projectGraph);
        const loaded = healed.graph === fetched.projectGraph ? fetched : { ...fetched, projectGraph: healed.graph };
        setProject(loaded);
        setNestPath(healed.breadcrumb);
        if (!loaded.id.startsWith("project_local_")) {
          markServerProjectSynced(loaded.id);
        }
        void offerCrashRecovery(loaded);
        void syncProjectMedia(loaded).catch(() => undefined);
      } catch (error) {
        if (cancelled) return;
        // Auth failure (guest / expired session) on a server-only project: retrying without a token can't
        // succeed and there's no local copy to fall back to. Send the user to sign in, remembering where to
        // return — after login the project loads normally. NOT a transient error, so no retry.
        if (error instanceof AuthRequiredError) {
          const from = `${window.location.pathname}${window.location.search}`;
          navigate(`/login?from=${encodeURIComponent(from)}`, { replace: true });
          return;
        }
        if (attempt < 2) {
          window.setTimeout(() => void loadProject(attempt + 1), 600 * (attempt + 1));
          return;
        }
        setNotice(error instanceof Error ? error.message : "Could not load this project. Check your connection and try again.");
      }
    };
    // A crash checkpoint (OPFS, written on every edit) newer than the record we just
    // loaded means the last session ended before its edits were persisted/synced —
    // offer them back. User-confirmed only; an older/equal checkpoint is never offered
    // (restoring it would lose work).
    const offerCrashRecovery = async (loaded: ProjectRecord) => {
      const checkpoint = await readRecoveryCheckpoint(loaded.id);
      if (cancelled || !checkpoint) return;
      const savedAtMs = Date.parse(checkpoint.savedAt);
      const updatedAtMs = Date.parse(loaded.updatedAt);
      if (!Number.isFinite(savedAtMs)) return;
      // 2s slack rides out save/sync races and small clock skew.
      if (Number.isFinite(updatedAtMs) && savedAtMs <= updatedAtMs + 2000) return;
      if (JSON.stringify(checkpoint.graph) === JSON.stringify(loaded.projectGraph)) return;
      setRecoveryOffer(checkpoint);
    };
    setRecoveryOffer(null);
    // PROJECT-SCOPED bin load (2026-07-17 perf fix): owned+linked assets + the user-level library
    // pool — NOT the whole account (a new project used to enumerate and resolve every asset the
    // user ever imported anywhere). Graph-referenced ids outside both scopes are healed below.
    // Strip any persisted session-scoped proxy object URL (defensive — proxyUrl should never be
    // saved, but a stale `blob:` here would black out every clip using that asset).
    const stripProxyBlobs = (list: SourceAsset[]) =>
      list.map((asset) => (asset.proxyUrl?.startsWith("blob:") ? { ...asset, proxyUrl: undefined } : asset));
    const assetsPromise: Promise<SourceAsset[]> = listProjectAssets(resolvedId)
      .then((list) => {
        const stripped = stripProxyBlobs(list);
        if (!cancelled) setAssets(stripped);
        return stripped;
      })
      .catch(() => []);
    // Per-project media sync (plans/media-cloud-architecture.md M2, download-only): once BOTH the
    // project and its scoped assets are in, (a) heal graph-referenced ids the scoped load missed
    // (legacy remap-era graphs), (b) pull missing bytes from the cloud into the on-device store —
    // skipping anything already local — then refresh the bin so playback reads local bytes.
    const syncProjectMedia = async (loaded: ProjectRecord) => {
      const list = await assetsPromise;
      if (cancelled) return;
      const known = new Set(list.map((asset) => asset.id));
      const missingIds = [...collectGraphAssetIds(loaded.projectGraph)].filter((id) => !known.has(id));
      const healed = (await Promise.all(missingIds.map((id) => fetchAssetById(id)))).filter(
        (asset): asset is SourceAsset => asset !== null
      );
      if (cancelled) return;
      if (healed.length) {
        setAssets((current) => {
          const have = new Set(current.map((asset) => asset.id));
          return [...current, ...stripProxyBlobs(healed.filter((asset) => !have.has(asset.id)))];
        });
      }
      const report = await ensureProjectMediaLocal(loaded.projectGraph, [...list, ...healed], { userId: loaded.userId });
      if (cancelled) return;
      if (report.pulled.length > 0) {
        // Re-resolve so the freshly-cached assets play from on-device bytes this session.
        const refreshed = await listProjectAssets(resolvedId).catch(() => null);
        if (!cancelled && refreshed) setAssets(stripProxyBlobs(refreshed));
        setNotice(`Pulled ${report.pulled.length} project asset${report.pulled.length === 1 ? "" : "s"} from cloud`);
      }
    };
    void loadProject(0);
    // Kick connectivity: promotes any pending local draft (incl. this one) when online.
    void checkNow();
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryVersion((value) => value + 1);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Source (ingest) proxies — the Premiere model: every local video asset gets a small,
  // keyframe-dense proxy file built ONCE in the background (sourceProxyEngine), and the live
  // preview plays that instead of the original camera file (resolvePlaybackUrl prefers
  // asset.proxyUrl). Exports keep reading the original bytes. The proxyUrl patch is deferred
  // while the transport is playing so a src swap never glitches active playback.
  const pendingProxyUrlsRef = useRef<Map<string, string>>(new Map());
  const applySourceProxyPatches = useCallback(() => {
    const pending = pendingProxyUrlsRef.current;
    if (pending.size === 0) {
      return;
    }
    const patches = new Map(pending);
    pending.clear();
    setAssets((current) => current.map((asset) => (patches.has(asset.id) ? { ...asset, proxyUrl: patches.get(asset.id) } : asset)));
  }, []);
  useEffect(() => {
    for (const asset of assets) {
      if (asset.proxyUrl) {
        continue; // already proxied (or server-side proxy) — ensureSourceProxy is also idempotent
      }
      ensureSourceProxy(asset, (assetId, url) => {
        pendingProxyUrlsRef.current.set(assetId, url);
        if (!isPlayingRef.current) {
          applySourceProxyPatches();
        }
      });
    }
  }, [assets, applySourceProxyPatches]);
  useEffect(() => {
    if (!isPlaying) {
      applySourceProxyPatches();
    }
  }, [isPlaying, applySourceProxyPatches]);
  // Cold-origin UX (1e): the first REAL transcode of the session means this browser origin had no
  // proxies for this media yet (typical on the production build's separate storage) — one passive
  // notice; playback is never blocked on it.
  useEffect(() => {
    setSourceProxyFirstBuildListener(() => {
      setNotice("Optimizing media in the background — playback may be softer until it finishes");
    });
    return () => setSourceProxyFirstBuildListener(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listPluginPackages()
      .then((catalog) => {
        if (!cancelled) {
          setBackendPluginLibrary(pluginPackagesToImportedLibrary(catalog.packages));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBackendPluginLibrary(EMPTY_IMPORTED_PLUGIN_LIBRARY);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Adopt the server id if the project gets promoted in the background (reconnect monitor).
  useEffect(() => {
    if (!project) {
      return undefined;
    }
    const currentId = project.id;
    return subscribeSync(() => {
      const serverId = resolveProjectId(currentId);
      if (serverId !== currentId) {
        getProject(serverId)
          .then((promoted) => {
            setProject(promoted);
            try {
              const newPath = window.location.pathname.replace(currentId, serverId);
              window.history.replaceState(window.history.state, "", newPath);
            } catch {
              /* route swap is best-effort */
            }
          })
          .catch(() => {
            /* Best-effort background adopt: keep the current (working) project if the promoted fetch fails. */
          });
      }
    });
  }, [project?.id]);

  const graph = project?.projectGraph;
  const importedPluginLibrary = useMemo(
    () => {
      const merged = mergeImportedPluginLibraries(
        backendPluginLibrary,
        mergeImportedPluginLibraries(loadImportedPluginLibrary(), normalizeImportedPluginLibrary(graph?.plugins))
      );
      return {
        ...merged,
        effects: merged.effects.filter((item) => !hiddenEffectManifestIds.has(item.id)),
        looks: merged.looks.filter((item) => !hiddenLookManifestIds.has(item.id)),
        transitions: merged.transitions.filter((item) => !hiddenTransitionManifestIds.has(item.id))
      };
    },
    [backendPluginLibrary, graph?.plugins, hiddenEffectManifestIds, hiddenLookManifestIds, hiddenTransitionManifestIds]
  );
  const importedPluginSignature = useMemo(() => previewPluginSignature(importedPluginLibrary), [importedPluginLibrary]);
  useEffect(() => {
    const warnings = [
      ...hydrateLookManifests(importedPluginLibrary.looks),
      ...hydrateTransitionManifests(importedPluginLibrary.transitions),
      ...hydrateEffectManifests(importedPluginLibrary.effects)
    ];
    if (warnings.length) {
      console.warn("[plugins] import warnings", warnings);
    }
  }, [importedPluginLibrary.looks, importedPluginLibrary.transitions]);
  const composition = useMemo(
    () => (project && graph ? ensureComposition(graph, { name: project.title, durationSeconds: project.durationSeconds }) : undefined),
    [graph, project]
  );
  const compositionRef = useRef(composition);
  compositionRef.current = composition;
  // Timelines media-pool TAB (nesting Block 3): every registry comp, Main first, with per-comp
  // instance counts (how many compound clips reference it anywhere — 0 shows an "Unused" badge).
  // The active comp is unioned in because updateGraph's write-through mirrors it on the NEXT write.
  // Memoized as ONE object so the memo'd AssetBin's `timelines` prop stays identity-stable.
  const timelinesTabData = useMemo(() => {
    if (!graph || !composition) return undefined;
    const registry = { ...(graph.compositions ?? {}), [composition.id]: composition };
    const rootId = graph.rootCompositionId ?? composition.id;
    const counts = new Map<string, number>();
    for (const comp of Object.values(registry)) {
      for (const track of comp.tracks) {
        for (const layer of track.layers) {
          if (layer.nestedCompositionId) counts.set(layer.nestedCompositionId, (counts.get(layer.nestedCompositionId) ?? 0) + 1);
        }
      }
    }
    const entries = Object.values(registry)
      .sort((a, b) => (a.id === rootId ? -1 : b.id === rootId ? 1 : a.name.localeCompare(b.name)))
      .map((comp) => ({ comp, instances: counts.get(comp.id) ?? 0 }));
    return { entries, rootId, activeId: composition.id };
  }, [graph, composition]);
  const resolvedAssets = useMemo(() => {
    if (!project?.sourceAsset || assets.some((asset) => asset.id === project.sourceAsset?.id)) {
      return assets;
    }

    return [project.sourceAsset, ...assets];
  }, [assets, project?.sourceAsset]);
  useEffect(() => {
    resolvedAssetsRef.current = resolvedAssets;
  }, [resolvedAssets]);
  const layers = useMemo(() => (composition ? flattenTimelineLayers(composition) : []), [composition]);
  // Memoized: was an inline getAssetUseCounts(layers) in the AssetBin props — a fresh walk + fresh
  // object identity on EVERY EditorPage render (incl. each playhead move), defeating any future
  // memoization of the panel. Only recomputes when the timeline actually changes.
  const assetUseCounts = useMemo(() => getAssetUseCounts(layers), [layers]);
  // Identity-stable wrappers for the memo'd AssetBin's function props (see useStableHandler):
  // every wrapper always calls the LATEST closure, but its identity never changes, so unrelated
  // EditorPage renders (playhead cold commits, selection, inspector edits) skip the whole panel.
  // The named handlers are hoisted function declarations, so referencing them here is safe.
  const stableAssignAsset = useStableHandler(handleAssignAsset);
  const stableAddAssetToTimeline = useStableHandler(handleAddAssetToTimeline);
  const stableAddGraphic = useStableHandler(handleAddGraphic);
  const stableApplyFrame = useStableHandler(handleApplyFrame);
  const stablePickReplacement = useStableHandler(handlePickReplacement);
  const stableCancelReplace = useStableHandler(() => setAssetPickerForLayerId(null));
  const stableDeleteAsset = useStableHandler(handleDeleteAsset);
  const stableFocusAssetUse = useStableHandler((assetId: string) => focusAssetUse(assetId, layers));
  const stableUploadAsset = useStableHandler(handleUploadAsset);
  const stableImportFile = useStableHandler(importTimelineOrTemplateFile);
  const stableApplyTemplate = useStableHandler(handleApplyTemplate);
  const stableRegisterAsset = useStableHandler(registerAsset);
  const stableMoveAssetFolder = useStableHandler(handleMoveAssetFolder);
  const stableSetAssetLabel = useStableHandler(handleSetAssetLabel);
  const stableUploadToCloud = useStableHandler(handleUploadAssetToCloud);
  const stableSyncAllToCloud = useStableHandler(handleSyncAllToCloud);
  const stableRemoveFromCloud = useStableHandler(handleRemoveAssetFromCloud);
  const stableRefreshFromCloud = useStableHandler(handleRefreshAssetFromCloud);
  const stablePinOffline = useStableHandler(handlePinAssetOffline);
  const stableChangeCustomFolders = useStableHandler(handleChangeCustomFolders);
  const stableOpenSourceMonitor = useStableHandler(handleOpenInSourceMonitor);
  // Timelines tab handlers (nesting Block 3) — same identity-stability contract as above.
  const stableOpenTimeline = useStableHandler(handleOpenCompositionById);
  const stableInsertTimelineAtPlayhead = useStableHandler(handleInsertCompositionAtPlayhead);
  const stableRenameTimeline = useStableHandler((compositionId: string, name: string) => void handleRenameComposition(compositionId, name));
  const stableDuplicateTimeline = useStableHandler((compositionId: string) => void handleDuplicateComposition(compositionId));
  const stableDeleteTimeline = useStableHandler((compositionId: string) => void handleDeleteComposition(compositionId));
  const stableCreateTimeline = useStableHandler(() => void handleCreateTimelineComposition());
  // Browser-local assets awaiting cloud upload — drives the Media Pool header "sync all" chip.
  const cloudPendingLocalCount = useMemo(() => assets.filter(isAssetLocalOnly).length, [assets]);
  const layerMaxDurations = useMemo(
    () => (composition ? buildLayerMaxDurations(composition, resolvedAssets, graph?.compositions) : {}),
    [composition, resolvedAssets, graph?.compositions]
  );
  const selectedLayerId = selectedLayerIds.length === 1 ? selectedLayerIds[0] : undefined;
  const selectedLayer = selectedLayerId ? layers.find((layer) => layer.id === selectedLayerId) : undefined;
  // Two real frames from the timeline's first clips → A/B samples for the transition gallery previews
  // (so previews show the effect on actual footage). Same pair for every tile; gradients fall back.
  const transitionSampleFrames = useMemo(() => {
    const out: Array<{ url: string; kind: "video" | "image" }> = [];
    for (const layer of layers) {
      if ((layer.type === "video" || layer.type === "image") && layer.assetId) {
        const asset = resolvedAssets.find((item) => item.id === layer.assetId);
        if (asset?.fileUrl) {
          out.push({ url: asset.fileUrl, kind: layer.type });
          if (out.length === 2) break;
        }
      }
    }
    return out;
  }, [layers, resolvedAssets]);
  // Multiselect property editing: with 2+ clips selected, the inspector edits the PRIMARY clip (the
  // last one clicked, tracked by selectionAnchorRef — falls back to the last array entry if the anchor
  // isn't in the current selection, e.g. after a "Select All") and broadcasts every change to the rest.
  const multiSelectPrimaryLayer =
    selectedLayerIds.length > 1
      ? layers.find((layer) => layer.id === selectionAnchorRef.current && selectedLayerIds.includes(layer.id)) ??
        layers.find((layer) => layer.id === selectedLayerIds[selectedLayerIds.length - 1])
      : undefined;
  // The layer whose controls the Controls tab shows: the current single selection, the multiselect
  // primary above, or — when nothing is selected — the last one inspected (kept alive so controls
  // stay put after deselecting). Falls back to empty if that layer is gone.
  const inspectorLayer =
    selectedLayer ?? multiSelectPrimaryLayer ?? (selectedLayerIds.length === 0 ? layers.find((layer) => layer.id === lastInspectedLayerId) : undefined);
  // Graph editor ghost curves: the OTHER selected clips (read-only, drawn faded under the primary).
  const graphGhostLayers = useMemo(
    () =>
      inspectorLayer && selectedLayerIds.length > 1
        ? layers.filter((item) => selectedLayerIds.includes(item.id) && item.id !== inspectorLayer.id)
        : undefined,
    [layers, selectedLayerIds, inspectorLayer]
  );
  const selectedPaletteAsset = useMemo(() => {
    const selectedAsset = selectedLayer?.assetId ? resolvedAssets.find((asset) => asset.id === selectedLayer.assetId) : undefined;
    return selectedAsset ?? project?.sourceAsset ?? resolvedAssets.find((asset) => asset.fileType.startsWith("image/") || asset.fileType.startsWith("video/"));
  }, [project?.sourceAsset, resolvedAssets, selectedLayer?.assetId]);
  const renderJobs = project?.renderJobs ?? [];
  const activeRenderJob = renderJobs.find((job) => job.status === "queued" || job.status === "processing");
  const latestFinalJob = findLatestRenderJob(renderJobs, "final");
  const finalDownloadUrl = project?.finalUrl ?? (latestFinalJob?.status === "completed" ? latestFinalJob.outputUrl : undefined);
  // Non-reactive fallback read: when an active job exists (the only time renderNotice is shown),
  // getRenderNotice never reaches the fallback, so a subscription here would only add renders.
  const renderNotice = getRenderNotice(activeRenderJob, latestFinalJob, getNotice());
  const creditEstimate = useMemo(
    () => (project && graph ? estimateCreditsForEffects(graph.effects, project.durationSeconds) : 0),
    [graph, project]
  );

  useEffect(() => {
    // Clamp the playhead when the composition SHRINKS below it (e.g. deleting the last clip). Keyed
    // on composition only now — there is no `currentTime` state to trip this; the ref is the truth.
    // ref + clock move together, then flush the cold clock so inspector/scopes land on the clamp
    // immediately (this is a discrete edit event, not a scrub — see flushColdPlaybackNotify).
    if (composition && currentTimeRef.current > composition.durationSeconds) {
      currentTimeRef.current = composition.durationSeconds;
      setPlaybackClock(composition.durationSeconds);
      flushColdPlaybackNotify();
    }
  }, [composition]);

  useEffect(() => {
    if (!selectedLayerIds.length) {
      return;
    }

    const existingIds = new Set(layers.map((layer) => layer.id));
    setSelectedLayerIds((current) => {
      const next = current.filter((layerId) => existingIds.has(layerId));
      // Bail when nothing was removed — `filter` always returns a NEW array, so returning it unconditionally
      // would schedule a no-op state update (and re-render) every time this effect runs. Same-ref → React skips.
      return next.length === current.length ? current : next;
    });
  }, [layers, selectedLayerIds.length]);

  const playbackCommitIntervalMs = previewQuality === "quality" ? 16 : previewQuality === "balanced" ? 40 : 90;

  // Live playhead reader for the audio-master authority gate: the store clock is only committed
  // every `playbackCommitIntervalMs`, but `currentTimeRef` is updated on EVERY playback tick (and
  // by every seek/pause path), so it is the sub-commit-precision truth. See playback-clock.ts.
  useEffect(() => {
    // Degrade-instead-of-die (Phase 4): long-task pressure / heap pressure suspend background work
    // via the gate, step the adaptive cap, and clear regenerable caches. Idempotent module start.
    ensureDegradationControllerStarted();
    setLivePlaybackTimeReader(() => currentTimeRef.current);
    // The clock store is module-global: reset it to THIS editor's playhead on mount so a leftover
    // value from a previously opened project can't position the clock-driven leaves (preview,
    // timeline playhead) at a stale time. Also clear a stale cold-suspend flag (a previous session
    // could have unmounted mid-playback), else the cold panels would stay frozen.
    setColdPlaybackSuspended(false);
    setPlaybackClock(currentTimeRef.current);
    return () => {
      setLivePlaybackTimeReader(null);
      setColdPlaybackSuspended(false);
    };
  }, []);

  useEffect(() => {
    if (!isPlaying || !composition) {
      // Leaving playback: un-suspend the cold clock and flush it so the cold panels (inspector,
      // scopes, mixer) land exactly where playback stopped, not on the last throttled low-rate notify.
      setColdPlaybackSuspended(false);
      if (playbackStartRef.current) {
        const stopped = getPlaybackClock();
        currentTimeRef.current = stopped;
        flushColdPlaybackNotify();
      }
      playbackStartRef.current = null;
      setPlaybackStart(null);
      noteAudioClockDrift(null); // paused → no master, HUD shows "—"
      return;
    }

    // Entering playback: SUSPEND cold notifications so inspector/scopes/mixer freeze while playing —
    // only the hot leaves (preview/playhead/timecode) update per frame, keeping playback smooth.
    setColdPlaybackSuspended(true);
    const started = { clockMs: performance.now(), timeSeconds: currentTimeRef.current };
    playbackStartRef.current = started;
    setPlaybackStart(started);
    setPlaybackClock(started.timeSeconds);
    let frame = 0;
    let lastClockCommitMs = 0;
    const audioClockEnabled = getAudioClockEnabled(); // read once per playback session
    // The clock store drives the hot leaves (preview/transport/scopes) at the quality cadence.
    // React `currentTime` re-renders the whole editor, so the playback loop does not mirror it
    // while playing; stop/seek/end paths flush the exact time back into React state.

    const tick = (clockMs: number) => {
      const started = playbackStartRef.current;
      if (!started) {
        return;
      }

      // Wall-clock playhead, SERVOED to the master audio element when one is playing (audio-clock.ts).
      // Playback smoothness for the PICTURE comes from native media playback (the live <video> frame loop
      // and — over ready spans — the proxy <video> substitution overlay), both of which present off the
      // main thread and stay in sync with real time. Keeping this clock real-time is what holds the proxy
      // <video> aligned with the playhead — and the audio element ALSO runs in real time, so slaving the
      // anchor to it preserves that while eliminating persistent A/V offset (audio start latency, decode
      // stalls, main-thread jank). The servo nudges the SHARED `playbackStart` anchor (≤4ms/tick, one hard
      // re-anchor past 250ms), so the timeline playhead / transport / getLivePlaybackTime — which all
      // derive from the same anchor — follow audio in lockstep. No audible clip → pure wall clock.
      if (audioClockEnabled) {
        const wallTime = started.timeSeconds + (clockMs - started.clockMs) / 1000;
        const audioTime = getAudioMasterTime();
        if (audioTime != null) {
          const drift = audioTime - wallTime;
          noteAudioClockDrift(drift * 1000);
          if (Math.abs(drift) > HARD_RESYNC_S) {
            started.timeSeconds += drift;
          } else {
            started.timeSeconds += Math.max(-MAX_SERVO_PER_TICK_S, Math.min(MAX_SERVO_PER_TICK_S, drift * SERVO_GAIN));
          }
        } else {
          noteAudioClockDrift(null);
        }
      }
      const nextTime = started.timeSeconds + (clockMs - started.clockMs) / 1000;
      currentTimeRef.current = nextTime; // always live for handlers reading the ref
      if (nextTime >= composition.durationSeconds) {
        setPlaybackClock(composition.durationSeconds);
        setColdPlaybackSuspended(false);
        flushColdPlaybackNotify(); // end of playback — settle cold panels on the final frame
        setIsPlaying(false);
        return;
      }

      if (clockMs - lastClockCommitMs >= playbackCommitIntervalMs) {
        lastClockCommitMs = clockMs;
        setPlaybackClock(nextTime);
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [composition, isPlaying, playbackCommitIntervalMs]);

  useEffect(() => {
    if (!projectId || !activeRenderJob) {
      return;
    }

    // Signature of the render-progress fields the poll cares about, so we can detect "nothing changed".
    const jobsSig = (jobs?: { id: string; status: string; progress: number; outputUrl?: string | undefined }[]) =>
      (jobs ?? []).map((j) => `${j.id}:${j.status}:${j.progress}:${j.outputUrl ?? ""}`).join("|");

    const interval = window.setInterval(() => {
      getProject(projectId).then((fresh) =>
        // Adopt only render-progress fields. Replacing the whole project here would clobber
        // the live, possibly-unsaved edit (graph/duration/title) with the server's last-saved
        // snapshot every 1.5s — the source of the "snap to previous, then back to latest"
        // flicker while a render job is active.
        setProject((current) => {
          if (!current) return fresh;
          // No-op when nothing render-related changed: returning the SAME reference makes React bail
          // out of the re-render. Without this, a render job stuck in queued/processing (e.g. the dev
          // worker never finishes it) re-rendered the entire editor every 1.5s, periodically stalling
          // the main thread — the "playhead is smooth then freezes for ~300ms, repeating" lag that
          // vanished on a fresh project (no active job → this poll never runs).
          if (
            current.status === fresh.status &&
            current.previewUrl === fresh.previewUrl &&
            current.finalUrl === fresh.finalUrl &&
            jobsSig(current.renderJobs) === jobsSig(fresh.renderJobs)
          ) {
            return current;
          }
          return {
            ...current,
            status: fresh.status,
            previewUrl: fresh.previewUrl,
            finalUrl: fresh.finalUrl,
            ...(fresh.renderJobs ? { renderJobs: fresh.renderJobs } : {})
          };
        })
      );
    }, 1500);
    return () => window.clearInterval(interval);
  }, [activeRenderJob, projectId]);

  useEffect(() => {
    localStorage.setItem("kimera_preview_quality", previewQuality);
  }, [previewQuality]);

  // FULL-QUALITY PLAYBACK (pro ask, 2026-07-05): fixed "1" (quality, Auto off) also bypasses the
  // ingest proxies, so playback AND the paused frame show ORIGINAL pixels — "at full quality it's
  // still showing proxy quality" was the report. ½/¼/Auto keep the proxy substitution (smoothness
  // path for weaker machines). The flag lives in VideoPreview (module scope); this state change
  // re-renders the tree so every media layer re-resolves its src immediately. (fullQualityPlayback is
  // declared up by proxyGenActive, which it also gates.)
  useEffect(() => {
    setIngestProxyPlaybackEnabled(!fullQualityPlayback);
  }, [fullQualityPlayback]);

  // BACKGROUND-WORK GATE (Phase 2, 2026-07-06). Deferrable work — transcodes, span generation,
  // filmstrips, waveforms, still proxies — must never compete with playback (the "plays ~4s then
  // freezes" family), an in-flight timeline gesture, or an export. Each condition feeds the single
  // gate in backgroundScheduler.ts; producers consult the gate instead of each condition separately.
  useEffect(() => {
    setBackgroundGate("playing", isPlaying);
  }, [isPlaying]);
  // Timeline gesture: any pointer press inside the timeline closes the gate until release. Capture
  // phase on window so the imperative gesture handlers (do-not-touch zone) stay untouched.
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.(".timeline-workspace")) {
        setBackgroundGate("gesture", true);
      }
    };
    const up = () => setBackgroundGate("gesture", false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      setBackgroundGate("gesture", false);
    };
  }, []);
  // The ingest-proxy engine's suspension now follows the WHOLE gate (playing OR gesture OR export);
  // the engine re-checks per frame (worker builds get it forwarded), so in-flight work parks fast.
  useEffect(() => {
    const sync = () => setSourceProxyBuildSuspended(!isBackgroundWorkAllowed());
    sync();
    const unsubscribe = subscribeBackgroundGate(sync);
    return () => {
      unsubscribe();
      setSourceProxyBuildSuspended(false);
      setBackgroundGate("playing", false);
    };
  }, []);

  useEffect(() => {
    previewCacheControllerRef.current?.clear();
    setProxyCacheSegments([]);
    setProxyCacheStatus(null);
  }, [composition?.id]);

  const getPreviewCacheController = useCallback((): PreviewCacheController => {
    previewCacheControllerRef.current ??= createPreviewCacheController({
      // When a span is evicted/invalidated/pruned, delete its backing proxy blob so storage tracks reality.
      onDisposeSpanMedia: (span) => {
        void proxyBlobStoreRef.current?.remove(span.id);
      }
    });
    return previewCacheControllerRef.current;
  }, []);

  // Repaint the ruler segments + status chip from the current cache entries. Both derive from the same
  // entry snapshot so the thin ruler and the "N/M ready" chip never disagree.
  const paintProxyCacheState = useCallback((entries: readonly CachedPreviewSpan[], durationSeconds: number) => {
    const status = summarizePreviewCacheStatus(entries);
    setProxyCacheSegments(previewCacheRulerSegments({ entries, durationSeconds }));
    setProxyCacheStatus(status);
    if (typeof window !== "undefined") {
      (window as Window & { __rfProxyDebug?: unknown }).__rfProxyDebug = {
        supported: proxyGenSupported,
        blobStoreKind: proxyBlobStoreRef.current?.kind ?? null,
        counts: {
          pending: status.pending,
          ready: status.ready,
          readyWithUrl: status.readyWithUrl,
          dirty: status.dirty,
          failed: status.failed,
          live: status.live,
          total: status.total
        },
        liveSeconds: status.liveSeconds,
        byteSize: status.byteSize,
        running: proxyGenRunningRef.current,
        lastReady: proxyGenLastReadyRef.current,
        lastError: proxyGenLastErrorRef.current,
        events: proxyGenEventsRef.current,
        failures: proxyGenFailuresRef.current,
        // Per-span snapshot for divergence triage: after editing an effect, watch the span covering the
        // playhead. If its `contentSignature` does NOT change on the edit, the signature isn't capturing that
        // field (fix in spanContentSignature). If it changes + regenerates but the proxy still looks wrong,
        // it's a clip-time render issue in the span composition.
        spans: entries.map((span) => ({
          id: span.id,
          status: span.status,
          reason: span.reason,
          contentSignature: span.contentSignature,
          startSeconds: span.startSeconds,
          endSeconds: span.endSeconds,
          hasUrl: span.url !== undefined,
          layerIds: span.layerIds
        }))
      };
    }
  }, [proxyGenSupported]);

  // OPFS proxy-cache rehydration (once per base signature): restore spans persisted by a previous
  // session instead of regenerating them. Safety is delegated to `markSpanReady`, which re-validates
  // id + base signature + per-span CONTENT signature against the freshly planned spans — a record
  // whose content changed since it was saved is rejected there, and its blob deleted via
  // `onDisposeSpanMedia`. Foreign records (other project / render scale) are pruned so OPFS doesn't
  // accumulate across projects (the old clear-on-switch hygiene, moved to open-time).
  const rehydratedSignaturesRef = useRef<Set<string>>(new Set());
  const rehydratePersistedProxies = useCallback(
    async (signature: string, durationSeconds: number) => {
      if (rehydratedSignaturesRef.current.has(signature)) {
        return;
      }
      rehydratedSignaturesRef.current.add(signature);
      try {
        proxyBlobStoreRef.current ??= await createProxyBlobStore();
        const store = proxyBlobStoreRef.current;
        const controller = previewCacheControllerRef.current;
        if (!controller) {
          return;
        }
        const records = await store.readIndex();
        // Foreign records (another project — render scale no longer flips the signature; sharper
        // records rehydrate across quality switches) are kept for a day — deleting them immediately
        // would wipe the cache on a quick project switch — then aged out so OPFS stays bounded.
        const FOREIGN_SPAN_TTL_MS = 24 * 60 * 60 * 1000;
        let restored = 0;
        for (const record of records) {
          if (record.signature !== signature) {
            if (Date.now() - record.savedAt > FOREIGN_SPAN_TTL_MS) {
              await store.remove(record.id);
            }
            continue;
          }
          const url = await store.getObjectUrl(record.id);
          if (!url) {
            store.removeRecord(record.id); // index points at a missing blob — drop the record
            continue;
          }
          const sealed = controller.store.markSpanReady({
            id: record.id,
            signature: record.signature,
            contentSignature: record.contentSignature,
            url,
            byteSize: record.byteSize,
            // Newer records carry scale + range, letting a SHARPER blob (saved at 1×) seal a
            // range-equal span planned at the session's softer quality. Old records fall back to
            // exact-id sealing.
            renderScale: record.renderScale,
            startSeconds: record.startSeconds,
            endSeconds: record.endSeconds
          });
          if (sealed) {
            restored += 1;
          } else {
            store.release(record.id); // rejected as stale — markSpanReady already disposed the blob
          }
        }
        if (proxyDebugEnabled()) {
          console.debug(`preview proxy rehydrated ${restored}/${records.length} span(s) for this session`);
        }
        if (restored > 0) {
          paintProxyCacheState(controller.store.entries, durationSeconds);
        }
      } catch {
        /* rehydration is best-effort — worst case the spans regenerate like before */
      }
    },
    [paintProxyCacheState]
  );

  const updateProxyCacheRuler = useCallback(
    (targetRange?: TimelineInterval | undefined) => {
      if (!composition) {
        setProxyCacheSegments([]);
        setProxyCacheStatus(null);
        return;
      }
      const controller = getPreviewCacheController();
      if (fullQualityPlayback) {
        // DORMANT at fixed full quality: reconciling here at renderScale 1 would DELETE every softer
        // ½/¼ span (reconcile prunes spans that can't serve the current scale) and plan expensive
        // full-res spans nobody plays (playback is raw originals). Leave the store untouched — the
        // softer spans survive for the return to a proxy quality (same base signature; edits made
        // meanwhile invalidate only the spans they overlap, via per-span content signatures on that
        // next reconcile) — and keep painting what's cached so the ruler stays truthful.
        paintProxyCacheState(controller.store.entries, composition.durationSeconds);
        return;
      }
      const renderScale = getPreviewQualityProfile(previewQuality).resolutionScale;
      const snapshot = controller.update({
        composition,
        renderScale,
        playheadSeconds: currentTimeRef.current,
        pluginSignature: importedPluginSignature,
        ...(targetRange !== undefined ? { targetRange } : {}),
        now: Date.now()
      });
      previewCacheRenderStateRef.current = {
        signature: snapshot.signature,
        renderScale,
        fps: composition.fps,
        durationSeconds: composition.durationSeconds
      };
      paintProxyCacheState(snapshot.entries, composition.durationSeconds);
      // The plan for this signature now exists in the store — restore any spans persisted by a
      // previous session (no-op after the first call per signature; validated by markSpanReady).
      void rehydratePersistedProxies(snapshot.signature, composition.durationSeconds);
    },
    [composition, getPreviewCacheController, importedPluginSignature, previewQuality, fullQualityPlayback, paintProxyCacheState, rehydratePersistedProxies]
  );

  useEffect(() => {
    updateProxyCacheRuler();
  }, [composition, isPlaying, previewQuality, updateProxyCacheRuler]);

  const handlePreviewFrameRendered = useCallback(
    (timeSeconds: number, renderScale: number) => {
      if (!composition) {
        return;
      }
      const controller = previewCacheControllerRef.current;
      const state = previewCacheRenderStateRef.current;
      if (!controller || !state || state.renderScale !== renderScale) {
        return;
      }
      const span = controller.markFrameRendered({
        signature: state.signature,
        renderScale,
        timeSeconds,
        frameDurationSeconds: 1 / Math.max(1, composition.fps),
        now: Date.now()
      });
      if (span && typeof window !== "undefined") {
        const debug = (window as Window & { __rfProxyDebug?: Record<string, unknown> }).__rfProxyDebug;
        if (debug && typeof debug === "object") {
          debug.lastLive = { spanId: span.id, timeSeconds };
        }
      }
    },
    [composition]
  );

  const handleRegenerateProxyCache = useCallback(
    (target: "all" | "inOut") => {
      if (!composition) {
        return;
      }
      const controller = getPreviewCacheController();
      let targetRange: TimelineInterval | undefined;
      if (target === "inOut") {
        const startSeconds = composition.settings?.timeline.inPointSeconds;
        const endSeconds = composition.settings?.timeline.outPointSeconds;
        if (startSeconds == null || endSeconds == null || startSeconds >= endSeconds) {
          setNotice("Set both In and Out points to regenerate that proxy range");
          return;
        }
        targetRange = { startSeconds, endSeconds };
        controller.markDirty(targetRange);
      } else {
        controller.clear();
      }

      updateProxyCacheRuler(targetRange);
      setProxyGenNonce((value) => value + 1); // kick the background generator for the freshly-queued spans
      const rangeLabel = targetRange ? `${targetRange.startSeconds.toFixed(2)}s-${targetRange.endSeconds.toFixed(2)}s` : "whole timeline";
      setNotice(`Preview proxy regeneration queued for ${rangeLabel}`);
    },
    [composition, getPreviewCacheController, updateProxyCacheRuler]
  );

  // Playback substitution lookup: is there a ready flattened-proxy covering this time? The preview plays it
  // as a native <video> (smooth through main-thread stalls) instead of live-compositing. Returns the object
  // URL + span start so the overlay can seek to span-local time. undefined → live compositor renders.
  const resolveProxyPlayback = useCallback(
    (timeSeconds: number): ProxyPlaybackHit | undefined => {
      if (!proxyGenActive) {
        return undefined;
      }
      const controller = previewCacheControllerRef.current;
      const state = previewCacheRenderStateRef.current;
      if (!controller || !state) {
        return undefined;
      }
      const media = controller.store.getReadySpanMedia(timeSeconds, state.signature, state.renderScale);
      if (!media) {
        return undefined;
      }
      return { url: media.url, spanStartSeconds: media.spanStartSeconds, spanId: media.spanId };
    },
    [proxyGenActive]
  );

  // Background proxy generation loop. Runs ONLY while paused/idle (so it never competes with playback),
  // renders pending spans off the main thread in the export Worker (no new preview WebGL context), stores
  // the resulting webm, and seals the span. Fully playhead-independent: it processes whatever is pending,
  // regardless of where the playhead is. Aborts the instant playback starts or the timeline changes.
  const runProxyGeneration = useCallback(async () => {
    if (proxyGenRunningRef.current || !proxyGenActive) {
      return;
    }
    // Phase 2: the whole background gate (playing OR gesture OR export) governs span generation,
    // not just isPlaying — the gate-reopen subscription below re-kicks this when work may resume.
    if (!composition || isPlayingRef.current || !isBackgroundWorkAllowed()) {
      return;
    }
    const controller = previewCacheControllerRef.current;
    const state = previewCacheRenderStateRef.current;
    if (!controller || !state) {
      return;
    }
    proxyGenRunningRef.current = true;
    const debugProxy = proxyDebugEnabled();
    if (debugProxy) {
      console.debug("preview proxy generation start");
    }
    try {
      proxyBlobStoreRef.current ??= await createProxyBlobStore();
      const store = proxyBlobStoreRef.current;
      // Snapshot the composition for this run; an edit changes the ref and the trigger effect re-kicks.
      const runComposition = composition;
      while (!isPlayingRef.current && isBackgroundWorkAllowed()) {
        const activeState = previewCacheRenderStateRef.current;
        if (!activeState || activeState.signature !== state.signature) {
          break; // signature changed (resolution/project) — a fresh run will take over
        }
        const span = controller.store.nextPending();
        if (!span) {
          if (debugProxy) {
            console.debug("preview proxy generation drained");
          }
          break;
        }
        const abort = new AbortController();
        proxyGenAbortRef.current = abort;
        try {
          const startedMs = typeof performance !== "undefined" ? performance.now() : Date.now();
          const recordProxyEvent = (event: ProxyGenerationDiagnostic) => {
            const entry = { ...event, id: span.id, reason: span.reason, layerIds: span.layerIds, at: Date.now() };
            proxyGenEventsRef.current = [...proxyGenEventsRef.current.slice(-39), entry];
            if (debugProxy) {
              console.debug("preview proxy event", entry);
            }
          };
          if (debugProxy) {
            console.debug(`preview proxy start ${span.id}`);
          }
          // Viewer capture first (flag-gated): the span renders through the LIVE preview compositor —
          // faithful by construction, `<video>` decode, zero new GL contexts. Any failure (except abort)
          // falls back to the export-Worker pipeline below, so capture can never make a span WORSE.
          let blob: Blob | null = null;
          const captureHandle = proxyCaptureRef.current;
          if (getProxyViewerCaptureEnabled() && captureHandle) {
            try {
              recordProxyEvent({ stage: "viewer-start", spanStartSeconds: span.startSeconds, spanEndSeconds: span.endSeconds });
              blob = await captureSpanProxyFromViewer({
                composition: runComposition,
                spanStartSeconds: span.startSeconds,
                spanEndSeconds: span.endSeconds,
                fps: runComposition.fps,
                capture: captureHandle,
                resolveAssetUrl: (id) => resolvedAssetsRef.current.find((asset) => asset.id === id)?.fileUrl,
                signal: abort.signal
              });
              recordProxyEvent({ stage: "viewer-ready", spanStartSeconds: span.startSeconds, spanEndSeconds: span.endSeconds });
            } catch (captureError) {
              if (abort.signal.aborted || captureError instanceof ViewerCaptureAborted) {
                throw new ProxyGenerationAborted();
              }
              blob = null;
              recordProxyEvent({
                stage: "viewer-failed",
                spanStartSeconds: span.startSeconds,
                spanEndSeconds: span.endSeconds,
                message: captureError instanceof Error ? captureError.message : String(captureError)
              });
            }
          }
          blob ??= await generateSpanProxy({
            composition: runComposition,
            spanStartSeconds: span.startSeconds,
            spanEndSeconds: span.endSeconds,
            fps: runComposition.fps,
            urlForAsset: (id) => resolvedAssetsRef.current.find((asset) => asset.id === id)?.fileUrl,
            transitionManifests: importedPluginLibrary.transitions,
            lookManifests: importedPluginLibrary.looks,
            signal: abort.signal,
            onDiagnostic: recordProxyEvent
          });
          // P1b parity self-check (todo.md Phase 6B): before sealing, decode sample frames from the webm
          // (whichever pipeline produced it) and compare against a fresh offscreen viewer render. A gross
          // mismatch (black frame, missing effect) FAILS the span — playback stays on the correct live
          // compositor — making proxy/viewer divergence impossible to ship silently.
          if (getProxyViewerCaptureEnabled() && proxyCaptureRef.current) {
            try {
              const parity = await verifySpanProxyAgainstViewer({
                blob,
                composition: runComposition,
                spanStartSeconds: span.startSeconds,
                spanEndSeconds: span.endSeconds,
                fps: runComposition.fps,
                capture: proxyCaptureRef.current,
                resolveAssetUrl: (id) => resolvedAssetsRef.current.find((asset) => asset.id === id)?.fileUrl,
                signal: abort.signal
              });
              recordProxyEvent({
                stage: parity.ok ? "parity-ok" : "parity-failed",
                spanStartSeconds: span.startSeconds,
                spanEndSeconds: span.endSeconds,
                message: `worst ${(parity.worstDiffRatio * 100).toFixed(2)}% @ [${parity.sampledTimes.map((t) => t.toFixed(2)).join(", ")}]s`
              });
              if (!parity.ok) {
                const message = `parity self-check failed (${(parity.worstDiffRatio * 100).toFixed(2)}% of pixels diverge from the viewer)`;
                proxyGenLastErrorRef.current = message;
                controller.store.markFailed(span.id, message);
                paintProxyCacheState(controller.store.entries, activeState.durationSeconds);
                continue;
              }
            } catch (parityError) {
              if (abort.signal.aborted || parityError instanceof ViewerCaptureAborted) {
                throw new ProxyGenerationAborted();
              }
              // The check itself failing (sources unavailable, decode error) is NOT proof of divergence —
              // log and seal as before; the check is a safety net, never a new failure mode.
              recordProxyEvent({
                stage: "parity-failed",
                spanStartSeconds: span.startSeconds,
                spanEndSeconds: span.endSeconds,
                message: `check errored: ${parityError instanceof Error ? parityError.message : String(parityError)}`
              });
            }
          }
          // P3 SPAN-VERIFICATION GATE (PREVIEW_PIPELINE.md §3): always-on, blob-side integrity
          // check — undecodable/truncated, frozen-while-motion-expected (the shipped soak bug),
          // and black-while-media-expected (belt for the worker guard; covers viewer capture,
          // which skips the worker). Fail → span marked failed, live compositor serves the range.
          // The check ERRORING is not proof of a bad span (never a new failure mode) — but a
          // FAILED VERDICT is authoritative.
          try {
            const spanOverlaps = (layerType: "video" | "any") =>
              runComposition.tracks.some((track) =>
                track.layers.some(
                  (candidate) =>
                    (layerType === "video" ? candidate.type === "video" : candidate.type === "video" || candidate.type === "image") &&
                    candidate.startSeconds < span.endSeconds &&
                    candidate.startSeconds + candidate.durationSeconds > span.startSeconds
                )
              );
            const verdict = await verifySpanBlobIntegrity({
              blob,
              spanDurationSeconds: span.endSeconds - span.startSeconds,
              motionExpected: spanOverlaps("video"),
              mediaExpected: spanOverlaps("any"),
              signal: abort.signal
            });
            const verifyStats = ((window as unknown as { __rfSpanVerify?: { ok: number; failed: number; lastReason: string | null } }).__rfSpanVerify ??= {
              ok: 0,
              failed: 0,
              lastReason: null
            });
            if (verdict.ok) {
              verifyStats.ok += 1;
              recordProxyEvent({
                stage: "verify-ok",
                spanStartSeconds: span.startSeconds,
                spanEndSeconds: span.endSeconds,
                message: `diff ${(verdict.maxAdjacentDiff * 100).toFixed(3)}% luma ${(verdict.meanLuma * 100).toFixed(1)}%`
              });
            } else {
              verifyStats.failed += 1;
              verifyStats.lastReason = verdict.reason ?? "unknown";
              const message = `span verification failed: ${verdict.reason}`;
              recordProxyEvent({ stage: "verify-failed", spanStartSeconds: span.startSeconds, spanEndSeconds: span.endSeconds, message });
              proxyGenLastErrorRef.current = message;
              controller.store.markFailed(span.id, message);
              paintProxyCacheState(controller.store.entries, activeState.durationSeconds);
              continue;
            }
          } catch (verifyError) {
            if (abort.signal.aborted || verifyError instanceof SpanVerificationAborted) {
              throw new ProxyGenerationAborted();
            }
            recordProxyEvent({
              stage: "verify-failed",
              spanStartSeconds: span.startSeconds,
              spanEndSeconds: span.endSeconds,
              message: `check errored (span sealed): ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`
            });
          }
          await store.put(span.id, blob);
          const url = await store.getObjectUrl(span.id);
          if (url) {
            const sealed = controller.store.markSpanReady({
              id: span.id,
              signature: activeState.signature,
              contentSignature: span.contentSignature,
              url,
              byteSize: blob.size,
              // Stamp what this run ACTUALLY rendered at (viewer capture follows the live preview
              // quality) — the store clamps the span to it so a quality flip mid-drain can never
              // label soft pixels as sharp.
              renderScale: activeState.renderScale,
              startSeconds: span.startSeconds,
              endSeconds: span.endSeconds
            });
            // Persist the span's identity so the NEXT session can rehydrate this blob instead of
            // regenerating (markSpanReady re-validates id + signatures then, so stale is impossible).
            // Sealed-only: a rejected seal already disposed the blob — a record would point at nothing.
            if (sealed) {
              store.saveRecord({
                id: sealed.id,
                signature: activeState.signature,
                contentSignature: span.contentSignature,
                byteSize: blob.size,
                savedAt: Date.now(),
                renderScale: sealed.renderScale,
                startSeconds: sealed.startSeconds,
                endSeconds: sealed.endSeconds
              });
            }
            const elapsedMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedMs);
            proxyGenLastReadyRef.current = { id: span.id, ms: elapsedMs, bytes: blob.size };
            proxyGenLastErrorRef.current = null;
            if (debugProxy) {
              console.debug(`preview proxy ready ${span.id} ${blob.size} bytes in ${elapsedMs}ms`);
            }
          } else {
            const message = "proxy blob store returned no url";
            proxyGenLastErrorRef.current = message;
            proxyGenFailuresRef.current = [
              ...proxyGenFailuresRef.current.slice(-19),
              { id: span.id, startSeconds: span.startSeconds, endSeconds: span.endSeconds, reason: span.reason, layerIds: span.layerIds, message, at: Date.now() }
            ];
            controller.store.markFailed(span.id, message);
            if (debugProxy) {
              console.debug(`preview proxy failed ${span.id}: ${message}`);
            }
          }
        } catch (error) {
          if (error instanceof ProxyGenerationAborted) {
            if (debugProxy) {
              console.debug("preview proxy generation aborted");
            }
            break;
          }
          const message = error instanceof Error ? error.message : String(error);
          proxyGenLastErrorRef.current = message;
          proxyGenFailuresRef.current = [
            ...proxyGenFailuresRef.current.slice(-19),
            { id: span.id, startSeconds: span.startSeconds, endSeconds: span.endSeconds, reason: span.reason, layerIds: span.layerIds, message, at: Date.now() }
          ];
          controller.store.markFailed(span.id, message);
          if (debugProxy) {
            console.debug(`preview proxy failed ${span.id}: ${message}`);
          }
        } finally {
          proxyGenAbortRef.current = null;
        }
        paintProxyCacheState(controller.store.entries, activeState.durationSeconds);
      }
    } finally {
      proxyGenRunningRef.current = false;
      paintProxyCacheState(controller.store.entries, state.durationSeconds);
      if (debugProxy) {
        console.debug("preview proxy generation exit");
      }
    }
  }, [composition, importedPluginLibrary.looks, importedPluginLibrary.transitions, paintProxyCacheState, proxyGenActive]);

  // Kick generation when idle; abort it the moment playback starts, live-playback is toggled on, or the
  // timeline/quality changes.
  useEffect(() => {
    if (isPlaying || !composition || !proxyGenActive) {
      proxyGenAbortRef.current?.abort();
      return;
    }
    const timer = window.setTimeout(() => {
      void runProxyGeneration();
    }, 600);
    return () => {
      window.clearTimeout(timer);
      proxyGenAbortRef.current?.abort();
    };
  }, [isPlaying, composition, previewQuality, proxyGenNonce, proxyGenActive, runProxyGeneration]);
  // Phase 2: the gate has reasons the effect above can't see (gesture, export). Abort generation the
  // moment the gate closes; re-kick when it reopens (runProxyGeneration self-guards re-entrancy).
  useEffect(() => {
    return subscribeBackgroundGate(() => {
      if (!isBackgroundWorkAllowed()) {
        proxyGenAbortRef.current?.abort();
      } else if (!isPlayingRef.current) {
        void runProxyGeneration();
      }
    });
  }, [runProxyGeneration]);

  useEffect(() => {
    localStorage.setItem("kimera_live_playback", livePlaybackMode ? "on" : "off");
  }, [livePlaybackMode]);

  // On project switch/unmount: release object URLs only — the OPFS blobs + span index stay so the
  // next session REHYDRATES them (deleting here was why the cache regenerated every session; stale
  // and foreign-project spans are pruned by `rehydratePersistedProxies` on the next open instead).
  useEffect(() => {
    return () => {
      proxyGenAbortRef.current?.abort();
      proxyBlobStoreRef.current?.releaseAllUrls();
    };
  }, [composition?.id]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const wantsModifierShortcut = event.ctrlKey || event.metaKey;
      if (wantsModifierShortcut && !event.altKey && event.key.toLowerCase() === "a") {
        const allLayerIds = composition?.tracks.flatMap((track) => track.layers.map((layer) => layer.id)) ?? [];
        if (!allLayerIds.length) return;
        event.preventDefault();
        selectionAnchorRef.current = allLayerIds[allLayerIds.length - 1] ?? null;
        setSelectedLayerIds(allLayerIds);
        setNotice(`Selected ${allLayerIds.length} clip${allLayerIds.length === 1 ? "" : "s"}`);
        return;
      }
      // Paste attributes (Premiere): ⌃⌥C copies the selected clip's effects/transform/fit,
      // ⌃⌥V applies them to every selected clip. Checked BEFORE plain ⌘Z etc. since it needs Alt.
      if (wantsModifierShortcut && event.altKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        // Selection via ref: a copy right after a selection click must use the NEW selection,
        // not the closure captured before the click's state committed.
        const selection = selectedLayerIdsRef.current;
        const source = selection.length === 1 ? layers.find((item) => item.id === selection[0]) : undefined;
        if (source) {
          copyLayerAttributes(source);
          setNotice(`Copied attributes from "${source.name}"`);
        } else {
          setNotice("Select one clip to copy attributes from");
        }
        return;
      }
      if (wantsModifierShortcut && event.altKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        const selection = selectedLayerIdsRef.current;
        if (!composition || !selection.length) {
          setNotice("Select clip(s) to paste attributes onto");
          return;
        }
        if (!hasClipboardAttributes()) {
          setNotice("Copy attributes first (Ctrl+Alt+C)");
          return;
        }
        const editable = selection.filter((id) => isLayerEditable(id));
        if (!editable.length) return;
        if (event.shiftKey) {
          // Fast path: paste every attribute group without opening the chooser.
          void updateComposition(pasteLayerAttributes(composition, editable)).then(() => {
            setNotice(`Attributes pasted onto ${editable.length} clip${editable.length === 1 ? "" : "s"}`);
          });
          return;
        }
        setPasteAttributesModalOpen(true);
        return;
      }
      // Nest / un-nest (Ctrl/Cmd+G, Shift = un-nest) — the industry "Group"/"Ungroup" shortcut.
      if (wantsModifierShortcut && !event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        const selection = selectedLayerIdsRef.current;
        if (event.shiftKey) {
          if (selection.length !== 1) {
            setNotice("Select one group to ungroup");
            return;
          }
          void handleUnnestClip(selection[0]!);
          return;
        }
        void handleNestSelection();
        return;
      }
      if (wantsModifierShortcut && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          void redo();
        } else {
          void undo();
        }
        return;
      }
      if (wantsModifierShortcut && event.key.toLowerCase() === "y") {
        event.preventDefault();
        void redo();
        return;
      }
      if (wantsModifierShortcut) {
        return; // leave other Ctrl/Cmd combos to their own handlers
      }
      if (event.altKey) {
        return; // Alt combos (Alt+1..4/E/R/M/L panel+AI shortcuts) have their own listeners —
        // without this bail, Alt+L would ALSO hit the bare "L" shuttle below.
      }
      // Playback transport (matches the viewer buttons): Space play/pause, Home/End jump,
      // ← → step one frame (⇧ = 5 frames), ↑ ↓ previous/next edit point, J K L shuttle,
      // Q W ripple-trim head/tail of the clip under the playhead.
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        goToStart();
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        goToEnd();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepFrame(-1, event.shiftKey ? 5 : 1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        stepFrame(1, event.shiftKey ? 5 : 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        jumpToEditPoint(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        jumpToEditPoint(1);
        return;
      }
      const key = event.key.toLowerCase();
      // JKL: held keys auto-repeat — only deliberate presses should ramp the shuttle rate.
      if (key === "j" && !event.repeat) {
        event.preventDefault();
        startShuttle(-1);
        return;
      }
      if (key === "k" && !event.repeat) {
        event.preventDefault();
        stopShuttle();
        if (isPlayingRef.current) pausePlaybackAtLiveClock();
        return;
      }
      if (key === "l" && !event.repeat) {
        event.preventDefault();
        if (!isPlayingRef.current && !shuttleRef.current) {
          setIsPlaying(true); // first L from a stop = normal 1x engine playback (with audio)
        } else {
          startShuttle(1);
        }
        return;
      }
      if (key === "q" && !event.repeat) {
        event.preventDefault();
        void handleRippleTrimAtPlayhead("head");
        return;
      }
      if (key === "w" && !event.repeat) {
        event.preventDefault();
        void handleRippleTrimAtPlayhead("tail");
        return;
      }
      if (key === "e" && !event.repeat) {
        event.preventDefault();
        void handleExtendEditToPlayhead();
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composition, isPlaying, project, selectedLayerIds]);

  // Shuttle must not outlive the editor (or keep driving a stale project's playhead).
  useEffect(() => {
    return () => stopShuttle();
  }, [composition?.id]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return;
      }
      // Shift+Delete/Backspace is ripple-delete, handled by the timeline's own
      // shortcut listener (TimelineStrip.tsx) - don't double-delete here.
      if ((event.key === "Delete" || event.key === "Backspace") && !event.shiftKey && selectedLayerIds.length) {
        event.preventDefault();
        void handleDeleteLayers(selectedLayerIds);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composition, selectedLayerIds]);

  // Mask shortcuts: V = select tool, Esc = back to select, ⇧M = add a rectangle mask to the selected
  // media clip. (Delete stays on the inspector button in Phase 1 to avoid clashing with clip-delete.)
  // ⇧M, not plain M: M is the timeline MARKER toggle (Premiere-parity) — when both handlers fired on
  // the same keydown their two updateComposition writes raced and the mask write clobbered the marker.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      // Modifier combos (e.g. ⌘/Ctrl+M = local export) are owned by their own handlers — never treat
      // them as the bare tool/mask shortcuts below.
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.key === "Escape" || event.key === "v" || event.key === "V") {
        setMaskTool("select");
        return;
      }
      if (event.key === "p" || event.key === "P") {
        setMaskTool("pen");
        return;
      }
      if (event.shiftKey && (event.key === "m" || event.key === "M")) {
        const layer = selectedLayer;
        if (layer && (layer.type === "video" || layer.type === "image") && composition) {
          event.preventDefault();
          // A `contain` layer with a known natural aspect (vector graphics know theirs from the
          // parsed viewBox) gets a default mask hugging the painted content rect, not 60% of comp.
          const sourceAspect =
            layer.graphic?.naturalWidth && layer.graphic.naturalHeight
              ? layer.graphic.naturalWidth / layer.graphic.naturalHeight
              : undefined;
          const contentRect =
            (layer.fit ?? (layer.graphic ? "contain" : undefined)) === "contain"
              ? containContentRect(composition.width, composition.height, sourceAspect)
              : null;
          const mask = createDefaultMask("rectangle", composition.width, composition.height, (layer.masks?.length ?? 0) + 1, contentRect);
          void updateLayer(layer.id, (current) => ({ ...current, masks: [...(current.masks ?? []), mask] }));
          setActiveMaskId(mask.id);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composition, selectedLayer]);

  // Export shortcuts: ⌘/Ctrl+M → local (on-device) export, ⌘/Ctrl+⇧+M → cloud export. Mirror the
  // toolbar buttons exactly (same gating), so the keys never start a render the buttons wouldn't.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "m") {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        // Cloud export (same gate as the Export button).
        if (busy === "export" || activeRenderJob) return;
        void renderFinal();
        return;
      }
      // Local export (same gate + setup as the on-device button: opens the fps/format dialog).
      if (!localExportSupported || localExport || !composition) return;
      setExportFps(null);
      setExportFormat("mp4");
      setExportDialogOpen(true);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, activeRenderJob, localExportSupported, localExport, composition, project]);

  // ⌘/Ctrl+/ → toggle the AI chat panel. Works even while its composer is focused (so the same
  // combo closes it), which is why we don't bail on input targets here.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "/") {
        return;
      }
      event.preventDefault();
      setAiPanelOpen((open) => !open);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Bare "/" → jump to the AI composer (opens the panel if closed, then focuses its input). Guarded
  // against typing contexts so "/" types normally in any field — including the AI box itself, so it
  // never hijacks a slash you meant to type.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setAiPanelOpen(true);
      setAiFocusToken((token) => token + 1);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // "." → toggle AI voice dictation (user request 2026-07-10: one-hand key instead of two-hand
  // Alt+M). Bails in typing contexts so "." still types normally in any field (incl. the AI
  // composer); the Source Monitor's scoped "." (overwrite edit) stopPropagation()s before this
  // window listener, so its behavior is untouched. ⌘/Ctrl+"." (user request) and Alt+M have NO
  // typing bail — they toggle the mic even while the composer is focused (already in input mode).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const altM = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyM";
      const ctrlDot = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === ".";
      const bareDot = event.key === "." && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (!altM && !ctrlDot && !bareDot) {
        return;
      }
      if (bareDot) {
        const target = event.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          (target instanceof HTMLElement && target.isContentEditable)
        ) {
          return;
        }
      }
      event.preventDefault();
      setAiPanelOpen(true);
      setAiMicToggleToken((token) => token + 1);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Alt+L → toggle hands-free voice mode ("Kimera, listen"). No typing bail on purpose — it must
  // work mid-edit and even while the composer is focused, exactly like Alt+M. It does NOT open
  // the chat panel (user request): the aurora + topbar AI button show the session instead.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyL") {
        return;
      }
      event.preventDefault();
      // Mount the dock (hidden) if needed, and COMMAND a toggle — the panel owns the session.
      setAiVoiceWanted(true);
      setAiVoiceToggleToken((token) => token + 1);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // The panel owns the real session (Esc / "stop listening" / Ear exits happen there) — mirror
  // its state up so the header button and the hidden-dock mount stay truthful. This is a
  // one-way report: it must NEVER feed back into a command to the panel (that was the loop).
  const handleVoiceSessionChange = useCallback((active: boolean) => {
    setAiVoiceActive(active);
    setAiVoiceWanted(active);
  }, []);
  const handleWakeWordChange = useCallback((on: boolean) => {
    setAiWakeArmed(on);
  }, []);

  // Panel shortcuts (Alt-based so they never collide with the bare tool keys or ⌘/Ctrl combos):
  //   Alt+1/2/3 → left panel Assets/Effects/Color · Alt+[ / Alt+] → left panel / inspector full⇄half.
  // Uses event.code so it's layout-independent (Alt+[ is a dead key on some layouts).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      switch (event.code) {
        case "Digit1":
          event.preventDefault();
          toggleLeftPanelTab("assets");
          break;
        case "Digit2":
          event.preventDefault();
          toggleLeftPanelTab("effects");
          break;
        case "Digit3":
          event.preventDefault();
          toggleLeftPanelTab("color");
          break;
        case "Digit4":
          event.preventDefault();
          toggleInspectorFromTopbar();
          break;
        // Left-hand-only height toggles (E/R sit under the left fingers while the thumb holds
        // Alt) — one-handed panel scheme. E = left panel, R = inspector (ordered left→right to
        // match the panel positions). Was R/T; remapped to E/R on user request 2026-07-11.
        case "KeyE":
          event.preventDefault();
          setPanelExpanded((value) => !value);
          break;
        case "KeyR":
          event.preventDefault();
          setInspectorExpanded((value) => !value);
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleLeftPanelTab, toggleInspectorFromTopbar]);

  useEffect(() => {
    localStorage.setItem("kimera_editor_left_width", String(leftPaneWidth));
  }, [leftPaneWidth]);

  useEffect(() => {
    localStorage.setItem("kimera_editor_right_width", String(rightPaneWidth));
  }, [rightPaneWidth]);

  useEffect(() => {
    localStorage.setItem("kimera_editor_timeline_height", String(timelineHeight));
  }, [timelineHeight]);

  useEffect(() => {
    localStorage.setItem("kimera_editor_source_split", String(sourceMonitorSplit));
  }, [sourceMonitorSplit]);

  useEffect(() => {
    if (!responsiveLayout.usesOverlayPanels) {
      setActiveResponsiveOverlay(null);
    }
  }, [responsiveLayout.usesOverlayPanels]);

  useEffect(() => {
    if (!responsiveLayout.usesTopbarOverflow) {
      setTopbarMenuOpen(false);
    }
  }, [responsiveLayout.usesTopbarOverflow]);

  useEffect(() => {
    if (!topbarMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".editor-actions-overflow")) return;
      setTopbarMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTopbarMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [topbarMenuOpen]);

  useEffect(() => {
    localStorage.setItem("kimera_editor_theme", editorTheme);
  }, [editorTheme]);

  useEffect(() => {
    if (!themeMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".topbar-theme-picker") || target?.closest(".topbar-theme-menu")) return;
      setThemeMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThemeMenu(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [themeMenu]);

  useEffect(() => {
    localStorage.setItem("kimera_timeline_snap", snapEnabled ? "on" : "off");
  }, [snapEnabled]);

  useEffect(() => {
    localStorage.setItem("kimera_timeline_magnetic", magneticEnabled ? "on" : "off");
  }, [magneticEnabled]);

  useEffect(() => {
    localStorage.setItem("kimera_editor_track_height", String(timelineTrackHeight));
  }, [timelineTrackHeight]);

  useEffect(() => {
    if (selectedLayerId) {
      setLastInspectedLayerId(selectedLayerId);
    }
  }, [selectedLayerId]);

  useEffect(() => {
    localStorage.setItem("kimera_viewer_manual_scale", String(manualScale));
  }, [manualScale]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedPaletteAsset || (!selectedPaletteAsset.fileType.startsWith("image/") && !selectedPaletteAsset.fileType.startsWith("video/"))) {
      setImagePalette(defaultColorPalette);
      return;
    }

    extractPaletteFromAsset(selectedPaletteAsset)
      .then((palette) => {
        if (!cancelled) {
          setImagePalette(palette.length ? palette : defaultColorPalette);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImagePalette(defaultColorPalette);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPaletteAsset]);

  async function updateGraph(nextGraph: ProjectGraph, durationSeconds?: number, options: { recordHistory?: boolean } = {}) {
    if (!project) {
      return;
    }

    const nextDuration = durationSeconds ?? project.durationSeconds;
    if (options.recordHistory !== false) {
      const changed = project.projectGraph !== nextGraph || project.durationSeconds !== nextDuration;
      if (changed) {
        undoStackRef.current.push({
          projectGraph: project.projectGraph,
          durationSeconds: project.durationSeconds
        });
        if (undoStackRef.current.length > 150) {
          undoStackRef.current.shift();
        }
        redoStackRef.current = [];
        setHistoryVersion((value) => value + 1);
      }
    }

    // Composition-registry write-through (Block 2, NESTING_MATURITY.md): every persisted graph
    // mirrors the active comp into `compositions[id]` and keeps root/active pointers stamped, so a
    // refresh while inside a nest can always find its way back to Main. Single seam — no other
    // write site needs to know the invariant exists.
    const stampedGraph = stampCompositionRegistry(nextGraph);

    // Local-first: update in-memory + on-device immediately, then sync to the server in
    // the background (debounced). The SyncBadge surfaces Saved locally → Syncing → Synced.
    // Functional update so a stale closure can't overwrite a newer edit committed in between.
    setProject((current) => (current ? { ...current, projectGraph: stampedGraph, durationSeconds: nextDuration } : current));
    scheduleGraphSave(project.id, stampedGraph, nextDuration);
  }

  async function undo() {
    if (!project) {
      return;
    }

    const previous = undoStackRef.current.pop();
    if (!previous) {
      return;
    }

    redoStackRef.current.push({ projectGraph: project.projectGraph, durationSeconds: project.durationSeconds });
    setHistoryVersion((value) => value + 1);
    await updateGraph(previous.projectGraph, previous.durationSeconds, { recordHistory: false });
    setNotice("Undo complete");
  }

  async function redo() {
    if (!project) {
      return;
    }

    const next = redoStackRef.current.pop();
    if (!next) {
      return;
    }

    undoStackRef.current.push({ projectGraph: project.projectGraph, durationSeconds: project.durationSeconds });
    setHistoryVersion((value) => value + 1);
    await updateGraph(next.projectGraph, next.durationSeconds, { recordHistory: false });
    setNotice("Redo complete");
  }

  /** Apply the crash-recovery checkpoint. Records history, so the restore itself is undoable. */
  async function restoreRecoveryOffer() {
    if (!recoveryOffer) {
      return;
    }
    setRecoveryOffer(null);
    await updateGraph(recoveryOffer.graph, recoveryOffer.durationSeconds);
    setNotice("Unsaved changes restored");
  }

  function discardRecoveryOffer() {
    setRecoveryOffer(null);
    if (project) {
      void discardRecoveryCheckpoint(project.id);
    }
  }

  async function updateComposition(nextComposition: TimelineComposition, options: { plugins?: ImportedPluginLibrary | undefined } = {}) {
    if (!graph) {
      return;
    }

    // Auto-vacant edge tracks (CapCut/Resolve behavior) — normalized at this single write choke
    // point so it never runs mid-gesture and lands inside the same undo entry as the edit itself.
    const normalizedComposition = normalizeCompositionDuration(ensureVacantEdgeTracks(nextComposition));
    await updateGraph({
      ...graph,
      composition: normalizedComposition,
      ...(options.plugins ? { plugins: options.plugins } : {}),
      version: graph.version + 1
    }, normalizedComposition.durationSeconds);
  }

  /**
   * Applies a Smart 3D Follow Text result in one atomic step: merges the new composition
   * AND seeds the tracked targets into editableFields.trackLibrary in a single updateGraph
   * call (rather than two sequential calls to updateComposition/updateEditableFields, which
   * would race against each other since both read from the same `graph` snapshot). Seeding
   * the library is what lets the exact same tracking later be attached to a different layer
   * via the "Attach track" control, with no re-tracking.
   */
  async function applySmartFollowTextResult(nextComposition: TimelineComposition, savedTracks: SavedTrack[]) {
    if (!graph) {
      return;
    }

    const normalizedComposition = normalizeCompositionDuration(nextComposition);
    const currentTrackLibrary = Array.isArray(graph.editableFields.trackLibrary)
      ? (graph.editableFields.trackLibrary as SavedTrack[])
      : [];
    const nextTrackLibrary = [
      ...currentTrackLibrary.filter((item) => !savedTracks.some((next) => next.id === item.id)),
      ...savedTracks
    ];

    await updateGraph(
      {
        ...graph,
        composition: normalizedComposition,
        editableFields: { ...graph.editableFields, trackLibrary: nextTrackLibrary },
        version: graph.version + 1
      },
      normalizedComposition.durationSeconds
    );
    setNotice(savedTracks.length > 0 ? "Effect applied · track saved" : "Effect applied");
  }

  /**
   * Apply a one-click tool result plus the handler's durable artifact patch
   * (describeEditableFields: masks/tracking) in ONE graph update — same atomic
   * pattern as applySmartFollowTextResult, avoiding a stale-graph race between
   * separate composition/editableFields writes. With no patch it stays on the
   * plain composition path.
   */
  async function applyToolEffectResult(nextComposition: TimelineComposition, editableFieldsPatch?: Record<string, unknown>) {
    if (!graph || !editableFieldsPatch || Object.keys(editableFieldsPatch).length === 0) {
      await updateComposition(nextComposition);
      return;
    }
    const normalizedComposition = normalizeCompositionDuration(nextComposition);
    await updateGraph(
      {
        ...graph,
        composition: normalizedComposition,
        editableFields: { ...graph.editableFields, ...editableFieldsPatch },
        version: graph.version + 1
      },
      normalizedComposition.durationSeconds
    );
  }

  function updateCompositionSettings(updater: (settings: TimelineCompositionSettings) => TimelineCompositionSettings) {
    if (!composition) {
      return;
    }

    const settings = updater(getCompositionSettings(composition));
    const nextComposition = applyCompositionSettings(composition, settings);
    // Responsive Pin (§1): if the CANVAS was reframed, bake pinned layers' new positions now so both
    // renderers keep consuming plain percents (no render-time pin logic). No-op when dims are unchanged.
    const reflowed =
      nextComposition.width !== composition.width || nextComposition.height !== composition.height
        ? reflowCompositionForResize(nextComposition, { width: composition.width, height: composition.height }, currentTimeRef.current)
        : nextComposition;
    void updateComposition(reflowed);
  }

  async function updateLayer(layerId: string, updater: (layer: TimelineLayer) => TimelineLayer) {
    if (!composition) {
      return;
    }

    await updateComposition(updateTimelineLayer(composition, layerId, updater));
  }

  /** Multiselect property editing: applies `updater` to every layer in `layerIds`, each against its OWN value. */
  async function updateLayers(layerIds: readonly string[], updater: (layer: TimelineLayer) => TimelineLayer) {
    if (!composition) {
      return;
    }

    await updateComposition(updateTimelineLayers(composition, layerIds, updater));
  }

  /**
   * Persists a value into the project's editableFields bag - the same mechanism
   * every tool's Apply step uses, so a saved track survives reloads exactly like any
   * other project data instead of being lost the moment the tab closes.
   */
  async function updateEditableFields(updater: (fields: Record<string, unknown>) => Record<string, unknown>) {
    if (!graph) {
      return;
    }
    await updateGraph({ ...graph, editableFields: updater(graph.editableFields), version: graph.version + 1 }, undefined, {
      recordHistory: false
    });
  }

  async function updateImportedPluginLibrary(library: ImportedPluginLibrary) {
    saveImportedPluginLibrary(library);
    if (!graph) {
      return;
    }
    await updateGraph({ ...graph, plugins: library, version: graph.version + 1 }, undefined, {
      recordHistory: false
    });
  }

  function projectPluginLibraryWithEffectManifest(manifest: PluginEffectManifest): ImportedPluginLibrary {
    return mergeEffectManifest(normalizeImportedPluginLibrary(graph?.plugins), manifest);
  }

  function projectPluginLibraryWithLookManifest(manifest: PluginLookManifest): ImportedPluginLibrary {
    return mergeLookManifest(normalizeImportedPluginLibrary(graph?.plugins), manifest);
  }

  function projectPluginLibraryWithTransitionManifest(manifest: PluginTransitionManifest): ImportedPluginLibrary {
    return mergeTransitionManifest(normalizeImportedPluginLibrary(graph?.plugins), manifest);
  }

  async function handleImportEffectManifest(manifest: PluginEffectManifest): Promise<string> {
    const existed = importedPluginLibrary.effects.some((item) => item.id === manifest.id);
    hydrateEffectManifests([manifest]);
    const resolved = resolveEffectManifest(manifest);
    const next = mergeEffectManifest(importedPluginLibrary, manifest);
    setHiddenEffectManifestIds((prev) => {
      if (!prev.has(manifest.id)) return prev;
      const unhidden = new Set(prev);
      unhidden.delete(manifest.id);
      saveHiddenEffectManifestIds(unhidden);
      return unhidden;
    });
    await updateImportedPluginLibrary(next);
    const base = `${existed ? "Updated" : "Imported"} effect ${manifest.name}`;
    const warnings = resolved.warnings.length ? ` ${resolved.warnings.join(" ")}` : "";
    if (selectedLayer && !resolved.compatibleLayerTypes.includes(selectedLayer.type)) {
      return `${base}. It is saved, but hidden for the selected ${selectedLayer.type} layer. Select a compatible visual layer to apply it.${warnings}`;
    }
    return `${base}.${warnings}`;
  }

  async function handleRemoveEffectManifest(manifestId: string): Promise<string> {
    const existing = importedPluginLibrary.effects.find((item) => item.id === manifestId);
    const next = removeEffectManifest(importedPluginLibrary, manifestId);
    setHiddenEffectManifestIds((prev) => {
      const hidden = new Set(prev);
      hidden.add(manifestId);
      saveHiddenEffectManifestIds(hidden);
      return hidden;
    });
    await updateImportedPluginLibrary(next);
    return existing ? `Removed effect ${existing.name}.` : "Removed uploaded effect.";
  }

  async function handleImportLookManifest(manifest: PluginLookManifest): Promise<string> {
    const existed = importedPluginLibrary.looks.some((item) => item.id === manifest.id);
    const resolved = resolveLookManifest(manifest);
    const next = mergeLookManifest(importedPluginLibrary, manifest);
    setHiddenLookManifestIds((prev) => {
      if (!prev.has(manifest.id)) return prev;
      const unhidden = new Set(prev);
      unhidden.delete(manifest.id);
      saveHiddenLookManifestIds(unhidden);
      return unhidden;
    });
    const warnings = hydrateLookManifests([manifest]);
    await updateImportedPluginLibrary(next);
    return warnings.length
      ? `${existed ? "Updated" : "Imported"} look ${resolved.look.name}: ${warnings.join(" ")}`
      : `${existed ? "Updated" : "Imported"} look ${resolved.look.name}.`;
  }

  async function handleImportTransitionManifest(manifest: PluginTransitionManifest): Promise<string> {
    const existed = importedPluginLibrary.transitions.some((item) => item.id === manifest.id);
    const next = mergeTransitionManifest(importedPluginLibrary, manifest);
    setHiddenTransitionManifestIds((prev) => {
      if (!prev.has(manifest.id)) return prev;
      const unhidden = new Set(prev);
      unhidden.delete(manifest.id);
      saveHiddenTransitionManifestIds(unhidden);
      return unhidden;
    });
    const warnings = hydrateTransitionManifests([manifest]);
    await updateImportedPluginLibrary(next);
    return warnings.length
      ? `${existed ? "Updated" : "Imported"} transition ${manifest.name}: ${warnings.join(" ")}`
      : `${existed ? "Updated" : "Imported"} transition ${manifest.name}`;
  }

  async function handleRemoveLookManifest(manifestId: string): Promise<string> {
    const existing = importedPluginLibrary.looks.find((item) => item.id === manifestId);
    const next = removeLookManifest(importedPluginLibrary, manifestId);
    setHiddenLookManifestIds((prev) => {
      const hidden = new Set(prev);
      hidden.add(manifestId);
      saveHiddenLookManifestIds(hidden);
      return hidden;
    });
    await updateImportedPluginLibrary(next);
    return existing ? `Removed look ${existing.name}.` : "Removed uploaded look.";
  }

  async function handleRemoveTransitionManifest(manifestId: string): Promise<string> {
    const existing = importedPluginLibrary.transitions.find((item) => item.id === manifestId);
    const next = removeTransitionManifest(importedPluginLibrary, manifestId);
    setHiddenTransitionManifestIds((prev) => {
      const hidden = new Set(prev);
      hidden.add(manifestId);
      saveHiddenTransitionManifestIds(hidden);
      return hidden;
    });
    await updateImportedPluginLibrary(next);
    return existing ? `Removed transition ${existing.name}.` : "Removed uploaded transition.";
  }

  const trackLibrary: SavedTrack[] = useMemo(() => {
    const stored = graph?.editableFields.trackLibrary;
    return Array.isArray(stored) ? (stored as SavedTrack[]) : [];
  }, [graph]);

  /** The clip Track works against - the timeline's main video/image source, independent of whichever layer is selected (you track the subject once, then attach the result to any layer, including ones with no media of their own like text or shapes). */
  const mainTrackableAsset = useMemo(() => {
    const mainAssetId = layers.find((item) => (item.type === "video" || item.type === "image") && item.assetId)?.assetId;
    return mainAssetId ? resolvedAssets.find((asset) => asset.id === mainAssetId) : undefined;
  }, [layers, resolvedAssets]);

  function handleSaveTracks(tracks: SavedTrack[]) {
    if (!tracks.length) {
      return;
    }
    void updateEditableFields((fields) => {
      const current = Array.isArray(fields.trackLibrary) ? (fields.trackLibrary as SavedTrack[]) : [];
      return {
        ...fields,
        trackLibrary: [...current.filter((item) => !tracks.some((next) => next.id === item.id)), ...tracks]
      };
    });
    setTrackModalState(undefined);
    const [first] = tracks;
    setNotice(
      tracks.length > 1 || !first
        ? `${tracks.length} tracks saved - attach them to any layer below.`
        : `Track "${first.label}" saved - attach it to any layer below.`
    );
  }

  function handleRemoveTrack(trackId: string) {
    void updateEditableFields((fields) => {
      const current = Array.isArray(fields.trackLibrary) ? (fields.trackLibrary as SavedTrack[]) : [];
      return { ...fields, trackLibrary: current.filter((item) => item.id !== trackId) };
    });
  }

  function handleAttachSavedTrack(trackId: string, layerId: string) {
    const track = trackLibrary.find((item) => item.id === trackId);
    if (!track) {
      return;
    }
    void updateLayer(layerId, (item) => ({
      ...item,
      // Replace any keyframes a previous attach of THIS track left on this layer
      // instead of stacking duplicates; keyframes from a different saved track are
      // left alone so multiple tracks can drive different properties if needed.
      // basePosition = the layer's current placement, so the graphic stays exactly
      // where the user put it in the frame and just inherits the tracked motion
      // (rather than snapping onto the tracked point).
      animations: [
        ...(item.animations ?? []).filter((keyframe) => !keyframe.id.startsWith(`${layerId}_track_${trackId}_`)),
        ...trackingPathToPositionKeyframes(track.trackingPath, { layerId, basePosition: item.transform.position, keyPrefix: `${layerId}_track_${trackId}` })
      ]
    }));
    setNotice(`"${track.label}" attached - layer keeps its position and follows the motion`);
  }

  function handlePreviewMoveLayer(layerId: string, position: { x: number; y: number }, commit: boolean) {
    // Same routing as scale/rotate: animated (or auto-keyframe) position drags land as
    // keyframes at the playhead — a bare base write is overridden by the animation, which
    // made keyframed clips undraggable in the viewer (user report 2026-07-12).
    const updater = (layer: TimelineLayer): TimelineLayer => {
      const layerTime = clamp(currentTimeRef.current - layer.startSeconds, 0, layer.durationSeconds);
      return applyTransformValueAtTime(
        applyTransformValueAtTime(layer, "transform.position.x", layerTime, roundEditorNumber(position.x), {
          autoKeyframe
        }),
        "transform.position.y",
        layerTime,
        roundEditorNumber(position.y),
        { autoKeyframe }
      );
    };

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }

    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) {
        return current;
      }

      return {
        ...current,
        projectGraph: {
          ...currentGraph,
          composition: updateTimelineLayer(currentGraph.composition, layerId, updater)
        }
      };
    });
  }

  // Live feather/opacity from the on-canvas mask widget: transient (no history) while dragging, committed on
  // release. Routes to the active effect's region masks when one is being edited, else the clip masks.
  function handlePreviewMaskScalar(
    layerId: string,
    maskId: string,
    patch: { feather?: number; opacity?: number },
    commit: boolean
  ) {
    const applyToMasks = (masks: Mask[] | undefined) =>
      (masks ?? []).map((m) =>
        m.id === maskId
          ? {
              ...m,
              ...(patch.feather != null ? { feather: Math.round(patch.feather) } : {}),
              ...(patch.opacity != null ? { opacity: Math.round(patch.opacity) } : {})
            }
          : m
      );
    const updater = (layer: TimelineLayer): TimelineLayer =>
      activeMaskEffectId
        ? { ...layer, effects: layer.effects.map((e) => (e.id === activeMaskEffectId ? { ...e, masks: applyToMasks(e.masks) } : e)) }
        : { ...layer, masks: applyToMasks(layer.masks) };

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }
    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) return current;
      return { ...current, projectGraph: { ...currentGraph, composition: updateTimelineLayer(currentGraph.composition, layerId, updater) } };
    });
  }

  // Generic transient/commit layer edit — used by the timeline audio volume envelope: transient `setProject`
  // (no history, live audio via AudioPreviewLayer's GainNode) while dragging, committed on release.
  function handlePreviewLayer(layerId: string, updater: (layer: TimelineLayer) => TimelineLayer, commit: boolean) {
    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }
    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) return current;
      return { ...current, projectGraph: { ...currentGraph, composition: updateTimelineLayer(currentGraph.composition, layerId, updater) } };
    });
  }

  function handlePreviewMovePositionKeyframe(layerId: string, timeSeconds: number, position: { x: number; y: number }, commit: boolean) {
    const updater = (layer: TimelineLayer): TimelineLayer =>
      updatePositionKeyframesAtTime(layer, timeSeconds, {
        x: roundEditorNumber(position.x),
        y: roundEditorNumber(position.y)
      });

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }

    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) {
        return current;
      }

      return {
        ...current,
        projectGraph: {
          ...currentGraph,
          composition: updateTimelineLayer(currentGraph.composition, layerId, updater)
        }
      };
    });
  }

  function handlePreviewMoveSpatialHandle(
    layerId: string,
    timeSeconds: number,
    handle: "in" | "out",
    tangent: { x: number; y: number },
    linked: boolean,
    commit: boolean
  ) {
    const updater = (layer: TimelineLayer): TimelineLayer => updatePositionSpatialHandleAtTime(layer, timeSeconds, handle, tangent, linked);

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }

    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) {
        return current;
      }

      return {
        ...current,
        projectGraph: {
          ...currentGraph,
          composition: updateTimelineLayer(currentGraph.composition, layerId, updater)
        }
      };
    });
  }

  function handlePreviewScaleLayer(layerId: string, scale: number, commit: boolean) {
    // No upper cap on scale (Premiere-style: tiny → huge is the user's call). A small positive floor
    // only, so the layer can't collapse to a zero-size, ungrabbable point. Auto-keyframe / already-animated
    // routing lands the value as a keyframe at the playhead; otherwise it edits the base (unchanged).
    const nextScale = roundEditorNumber(Math.max(0.01, scale));
    const updater = (layer: TimelineLayer): TimelineLayer =>
      applyTransformValueAtTime(
        layer,
        "transform.scale",
        clamp(currentTimeRef.current - layer.startSeconds, 0, layer.durationSeconds),
        nextScale,
        { autoKeyframe }
      );

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }

    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) {
        return current;
      }

      return {
        ...current,
        projectGraph: {
          ...currentGraph,
          composition: updateTimelineLayer(currentGraph.composition, layerId, updater)
        }
      };
    });
  }

  // Edge-handle crop (N/E/S/W). Each drag trims one edge, written as a `content.crop.<edge>` fraction so it
  // flows through the same content-transform pipeline the preview, WebGL compositor, and Remotion all honor.
  // Auto-keyframe / already-animated routing matches every other spatial edit.
  function handlePreviewCropLayer(layerId: string, edge: "top" | "right" | "bottom" | "left", value: number, commit: boolean) {
    const nextValue = roundEditorNumber(clamp(value, 0, 0.95));
    const updater = (layer: TimelineLayer): TimelineLayer =>
      applyContentValueAtTime(
        layer,
        `content.crop.${edge}`,
        clamp(currentTimeRef.current - layer.startSeconds, 0, layer.durationSeconds),
        nextValue,
        { autoKeyframe }
      );

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }

    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) {
        return current;
      }
      return {
        ...current,
        projectGraph: {
          ...currentGraph,
          composition: updateTimelineLayer(currentGraph.composition, layerId, updater)
        }
      };
    });
  }

  function handlePreviewResizeShapeLayer(layerId: string, size: { widthPercent: number; heightPercent: number }, commit: boolean) {
    const updater = (layer: TimelineLayer): TimelineLayer => ({
      ...layer,
      widthPercent: roundEditorNumber(clamp(size.widthPercent, 2, 400)),
      heightPercent: roundEditorNumber(clamp(size.heightPercent, 2, 400))
    });

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }

    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) {
        return current;
      }

      return {
        ...current,
        projectGraph: {
          ...currentGraph,
          composition: updateTimelineLayer(currentGraph.composition, layerId, updater)
        }
      };
    });
  }

  /**
   * Frame-box resize from the canvas handles (Step C / decision D2). Mirrors the shape-layer resize
   * flow above — live drags go straight to local state, only the release commits — but writes the FRAME's
   * own box params. `setFrameBoxFromResize` owns the geometry (aspectLock linking, per-axis edges), so the
   * canvas and the inspector's Width/Height fields go through the exact same rule and can't disagree.
   */
  function handlePreviewResizeFrameLayer(
    layerId: string,
    size: { widthPercent: number; heightPercent: number },
    axis: "x" | "y" | "both",
    commit: boolean
  ) {
    // Read the comp through the ref: a resize drag fires continuously, and the ref is always current.
    const activeComposition = compositionRef.current;
    if (!activeComposition) return;
    const comp = { width: activeComposition.width, height: activeComposition.height };
    const updater = (layer: TimelineLayer): TimelineLayer => {
      if (!layer.frame) return layer;
      const nextParams = setFrameBoxFromResize(layer.frame, { width: size.widthPercent, height: size.heightPercent }, axis, comp);
      const withFrame: TimelineLayer = { ...layer, frame: { ...layer.frame, params: nextParams } };
      // D6 (founder call): a CORNER frame handle scales the inner media WITH the box (group scale), so the
      // media keeps its coverage instead of the frame just masking more/less of it. Edges only reveal/hide
      // (uniform `content.scale` can't stretch one axis). The per-drag factor telescopes across a live drag
      // because each fire's box is absolute → cumulative = startBox→finalBox. Written as a BASE content edit
      // (the frame box isn't keyframeable), in the SAME updater as the box so a drag commits as one entry.
      if (axis !== "both") return withFrame;
      const factor = frameGroupScaleFactor(layer.frame, nextParams, comp);
      if (factor === 1) return withFrame;
      const baseScale = layer.content?.scale ?? 1;
      const nextScale = roundEditorNumber(clamp(baseScale * factor, 0.05, 20));
      return { ...withFrame, content: { ...layer.content, scale: nextScale } };
    };

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }

    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) {
        return current;
      }
      return {
        ...current,
        projectGraph: {
          ...currentGraph,
          composition: updateTimelineLayer(currentGraph.composition, layerId, updater)
        }
      };
    });
  }

  /**
   * Content mode (decision D3) — double-click a framed clip, then drag/wheel to reposition the media
   * INSIDE the frame. Writes through `applyContentValueAtTime`, the same rule the inspector's Content/Crop
   * panel uses, so auto-keyframe / already-animated routing behaves identically whether you adjust the
   * media on canvas or in the panel (they are the same `content.*` properties).
   */
  function handlePreviewContentTransformLayer(
    layerId: string,
    next: { offsetX?: number; offsetY?: number; scale?: number },
    commit: boolean
  ) {
    const updater = (layer: TimelineLayer): TimelineLayer => {
      const layerTime = clamp(currentTimeRef.current - layer.startSeconds, 0, layer.durationSeconds);
      let updated = layer;
      for (const [property, value] of [
        ["content.offsetX", next.offsetX],
        ["content.offsetY", next.offsetY],
        ["content.scale", next.scale]
      ] as const) {
        if (value === undefined) continue;
        updated = applyContentValueAtTime(updated, property, layerTime, roundEditorNumber(value), { autoKeyframe });
      }
      return updated;
    };

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }

    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) {
        return current;
      }
      return {
        ...current,
        projectGraph: {
          ...currentGraph,
          composition: updateTimelineLayer(currentGraph.composition, layerId, updater)
        }
      };
    });
  }

  function handlePreviewRotateLayer(layerId: string, rotation: number, commit: boolean) {
    // Auto-keyframe / already-animated routing drops the rotation as a keyframe at the playhead;
    // otherwise it edits the base rotation (unchanged behavior).
    const nextRotation = roundEditorNumber(normalizeRotation(rotation));
    const updater = (layer: TimelineLayer): TimelineLayer =>
      applyTransformValueAtTime(
        layer,
        "transform.rotation",
        clamp(currentTimeRef.current - layer.startSeconds, 0, layer.durationSeconds),
        nextRotation,
        { autoKeyframe }
      );

    if (commit) {
      void updateLayer(layerId, updater);
      return;
    }

    setNotice("Unsaved");
    setProject((current) => {
      const currentGraph = current?.projectGraph;
      if (!current || !currentGraph?.composition) {
        return current;
      }

      return {
        ...current,
        projectGraph: {
          ...currentGraph,
          composition: updateTimelineLayer(currentGraph.composition, layerId, updater)
        }
      };
    });
  }

  async function handleMoveLayer(
    layerId: string,
    startSeconds: number,
    trackId?: string | undefined,
    movedLayerIds?: string[] | undefined,
    targetTrackByLayerId?: Record<string, string> | undefined,
    targetStartByLayerId?: Record<string, number> | undefined
  ) {
    if (!composition) {
      return;
    }

    // Drag path: apply the resolver's exact placements verbatim (start + track per affected layer).
    // The clamping/track-family/linked-companion logic already ran in `resolveGroupMove` during the
    // preview, so commit just writes what was shown — preview and commit can't diverge.
    if (targetStartByLayerId && Object.keys(targetStartByLayerId).length > 0) {
      const layerById = new Map(layers.map((item) => [item.id, item]));
      const placements = Object.entries(targetStartByLayerId)
        .map(([id, start]) => {
          const item = layerById.get(id);
          return item ? { layerId: id, startSeconds: start, trackId: targetTrackByLayerId?.[id] ?? item.trackId, member: true } : null;
        })
        .filter((placement): placement is NonNullable<typeof placement> => placement !== null);
      // Commit through the editing-policy seam. Magnetic mode (opt-in toggle) compacts the touched
      // tracks gapless + overlap-free; otherwise overlap stays "allow" (free positioning, today's default).
      const committed = commitGroupMove(composition, placements, placements.map((p) => p.layerId), {
        ...DEFAULT_EDITING_POLICY,
        magnetic: magneticEnabled
      });
      await updateComposition(committed.composition);
      return;
    }

    // Legacy path with a MULTI-selection (per-layer placement map missing or empty): never funnel
    // into the single-primary+targetTrack branch below — it moves only the primary to `trackId` and
    // time-shifts nothing else's track, which collapses the group onto one lane. Pure time-shift on
    // each layer's OWN track instead.
    if (movedLayerIds && movedLayerIds.length > 1) {
      const layerById = new Map(layers.map((item) => [item.id, item]));
      const primary = layerById.get(layerId);
      const groupDeltaSeconds = primary ? startSeconds - primary.startSeconds : 0;
      const placements = movedLayerIds
        .map((id) => {
          const item = layerById.get(id);
          return item
            ? { layerId: id, startSeconds: Math.max(0, item.startSeconds + groupDeltaSeconds), trackId: item.trackId, member: true }
            : null;
        })
        .filter((placement): placement is NonNullable<typeof placement> => placement !== null);
      const committed = commitGroupMove(composition, placements, placements.map((p) => p.layerId), {
        ...DEFAULT_EDITING_POLICY,
        magnetic: magneticEnabled
      });
      await updateComposition(committed.composition);
      return;
    }

    const layer = layers.find((item) => item.id === layerId);
    const targetTrack = trackId ? composition.tracks.find((track) => track.id === trackId) : undefined;
    const deltaSeconds = layer ? startSeconds - layer.startSeconds : 0;
    if (!layer || !targetTrack || targetTrack.type === "audio" !== (layer.type === "audio")) {
      await updateComposition(moveLayerAndLinkedCompanions(composition, layerId, startSeconds, deltaSeconds));
      return;
    }

    const nextComposition: TimelineComposition = {
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers:
          track.id === targetTrack.id
            ? [...track.layers.filter((item) => item.id !== layerId), { ...layer, startSeconds, trackId: targetTrack.id }]
            : track.layers
                .filter((item) => item.id !== layerId)
                .map((item) =>
                  item.linkedGroupId && item.linkedGroupId === layer.linkedGroupId
                    ? {
                        ...item,
                        startSeconds: Math.max(0, item.startSeconds + deltaSeconds)
                      }
                    : item
                )
      }))
    };
    await updateComposition(nextComposition);
  }

  async function handleUnlinkLayer(layerId: string) {
    if (!composition) {
      return;
    }

    const layer = layers.find((item) => item.id === layerId);
    if (!layer?.linkedGroupId) {
      return;
    }

    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((item) =>
          item.linkedGroupId === layer.linkedGroupId
            ? {
                ...item,
                linkedGroupId: undefined
              }
            : item
        )
      }))
    });
    setNotice("Media unlinked");
    return;
  }

  /**
   * "d" toggle (Premiere's Enable): flip `disabled` on every selected clip + linked companions in ONE
   * composition write (one undo step). Mixed groups converge — if ANY targeted clip is still enabled,
   * everything disables; only a fully-disabled group re-enables.
   */
  async function handleToggleLayersDisabled() {
    if (!composition) {
      return;
    }
    // Ref, not state: invoked from keydown, and selection state can lag the imperative highlight.
    const selected = selectedLayerIdsRef.current.length > 0 ? selectedLayerIdsRef.current : selectedLayerIds;
    const targetIds = new Set(expandLayerSelection(selected));
    if (targetIds.size === 0) {
      return;
    }
    const targets = layers.filter((layer) => targetIds.has(layer.id));
    const nextDisabled = targets.some((layer) => !layer.disabled);
    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((item) => (targetIds.has(item.id) ? { ...item, disabled: nextDisabled ? true : undefined } : item))
      }))
    });
    setNotice(nextDisabled ? (targets.length > 1 ? `${targets.length} clips disabled` : "Clip disabled") : targets.length > 1 ? `${targets.length} clips enabled` : "Clip enabled");
  }

  async function handleLinkSelectedLayers() {
    if (!composition || selectedLayerIds.length < 2) {
      setNotice("Select clips to link");
      return;
    }

    const selectedIds = new Set(selectedLayerIds);
    const linkedGroupId = `link_${Date.now()}`;
    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((layer) =>
          selectedIds.has(layer.id)
            ? {
                ...layer,
                linkedGroupId
              }
            : layer
        )
      }))
    });
    setNotice(`${selectedLayerIds.length} clips linked`);
  }

  async function handleUnlinkSelectedLayers() {
    if (!composition || !selectedLayerIds.length) {
      return;
    }

    const selectedIds = new Set(selectedLayerIds);
    const linkedGroups = new Set(
      layers.filter((layer) => selectedIds.has(layer.id) && layer.linkedGroupId).map((layer) => layer.linkedGroupId as string)
    );
    if (!linkedGroups.size) {
      return;
    }

    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((layer) =>
          layer.linkedGroupId && linkedGroups.has(layer.linkedGroupId)
            ? {
                ...layer,
                linkedGroupId: undefined
              }
            : layer
        )
      }))
    });
    setNotice("Clips unlinked");
  }

  // --- Nesting (compound clips, NESTING.md Phase B) --------------------------------------------
  async function handleNestSelection() {
    if (!composition || !graph) {
      return;
    }
    // Unique sequence names ("Group 01", "Group 02", …) so the Timelines panel stays legible.
    const takenNames = new Set(
      [composition.name, ...Object.values(graph.compositions ?? {}).map((comp) => comp.name)].filter(Boolean)
    );
    let groupNumber = Object.keys(graph.compositions ?? {}).length + 1;
    let groupName = `Group ${String(groupNumber).padStart(2, "0")}`;
    while (takenNames.has(groupName)) {
      groupNumber += 1;
      groupName = `Group ${String(groupNumber).padStart(2, "0")}`;
    }
    const result = nestLayersIntoComposition(composition, selectedLayerIds, { name: groupName });
    if (!result) {
      setNotice("Select 2+ clips to group");
      return;
    }
    const normalized = normalizeCompositionDuration(result.composition);
    await updateGraph(
      {
        ...graph,
        composition: normalized,
        compositions: { ...(graph.compositions ?? {}), [result.nestedComposition.id]: result.nestedComposition },
        version: graph.version + 1
      },
      normalized.durationSeconds
    );
    setSelectedLayerIds([result.clipId]);
    setNotice(`Grouped ${selectedLayerIds.length} clips`);
  }

  async function handleUnnestClip(layerId: string) {
    if (!composition) {
      return;
    }
    const result = unnestClip(composition, graph?.compositions, layerId);
    if (!result) {
      setNotice("Can't ungroup a trimmed or sped-up group");
      return;
    }
    await updateComposition(result.composition);
    setSelectedLayerIds([]);
    setNotice("Ungrouped");
  }

  // --- Text Styles (§2) — reusable text looks saved project-local in graph.textStyles ------------
  /** Selected TEXT layers, else fall back to the inspected layer when it's text (Align parity). */
  function textStyleTargetIds(): string[] {
    const selected = new Set(selectedLayerIds);
    const ids = layers.filter((item) => selected.has(item.id) && item.type === "text").map((item) => item.id);
    if (ids.length) return ids;
    return inspectorLayer?.type === "text" ? [inspectorLayer.id] : [];
  }

  async function handleSaveTextStyle() {
    if (!graph || inspectorLayer?.type !== "text") {
      setNotice("Select a text layer to save its style");
      return;
    }
    const name = `Style ${(graph.textStyles?.length ?? 0) + 1}`;
    const style = createTextStyleFromLayer(inspectorLayer, name);
    await updateGraph({ ...graph, textStyles: [...(graph.textStyles ?? []), style], version: graph.version + 1 });
    setNotice(`Saved "${style.name}"`);
  }

  async function handleApplyTextStyle(style: TextStyle) {
    const targetIds = textStyleTargetIds();
    if (!targetIds.length) {
      setNotice("Select a text layer to apply a style");
      return;
    }
    // One history entry across all targets (batch), mirroring Align/distribute.
    await updateLayers(targetIds, (item) => applyTextStyle(item, style.style));
    setNotice(targetIds.length > 1 ? `Applied "${style.name}" to ${targetIds.length} layers` : `Applied "${style.name}"`);
  }

  async function handleUpdateTextStyle(styleId: string) {
    if (!graph || inspectorLayer?.type !== "text") {
      setNotice("Select a text layer to update the style from");
      return;
    }
    const captured = captureTextStyle(inspectorLayer);
    await updateGraph({
      ...graph,
      textStyles: (graph.textStyles ?? []).map((style) => (style.id === styleId ? { ...style, style: captured } : style)),
      version: graph.version + 1
    });
    setNotice("Style updated");
  }

  async function handleRenameTextStyle(styleId: string, name: string) {
    if (!graph) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    await updateGraph({
      ...graph,
      textStyles: (graph.textStyles ?? []).map((style) => (style.id === styleId ? { ...style, name: trimmed } : style)),
      version: graph.version + 1
    });
  }

  async function handleDeleteTextStyle(styleId: string) {
    if (!graph) return;
    await updateGraph({
      ...graph,
      textStyles: (graph.textStyles ?? []).filter((style) => style.id !== styleId),
      version: graph.version + 1
    });
  }

  // Navigate to ANY composition in the registry (breadcrumb jumps, Timelines tiles, opening a
  // nested clip): swap the target into the `graph.composition` slot every existing read/write site
  // already targets — the write-through seam in updateGraph mirrors the outgoing comp into
  // `compositions` and keeps the pointers stamped. Kept OUT of undo history — it's navigation, not
  // an edit; edits made while inside still record normally. `path` is the new ancestor chain
  // (root→…→parent) shown in the breadcrumb.
  function navigateToComposition(target: TimelineComposition, path: NestBreadcrumbEntry[]) {
    if (!composition || !graph) {
      return;
    }
    void updateGraph(
      {
        ...graph,
        composition: target,
        compositions: { ...(graph.compositions ?? {}), [composition.id]: composition },
        version: graph.version + 1
      },
      target.durationSeconds,
      { recordHistory: false }
    );
    setNestPath(path);
    setSelectedLayerIds([]);
  }

  // "Open" a compound clip: descend one level — the current comp joins the breadcrumb chain.
  function handleOpenNestedClip(layerId: string) {
    if (!composition || !graph) {
      return;
    }
    const clip = layers.find((item) => item.id === layerId);
    const nested = clip?.nestedCompositionId ? graph.compositions?.[clip.nestedCompositionId] : undefined;
    if (!clip || !nested) {
      setNotice("Group not found");
      return;
    }
    navigateToComposition(nested, [...nestPath, { id: composition.id, name: composition.name }]);
    setNotice(`Editing "${nested.name}"`);
  }

  /** Breadcrumb jump: return to `entry` (an ancestor), truncating the chain there. */
  function handleReturnToBreadcrumb(entry: NestBreadcrumbEntry) {
    if (!composition || !graph) {
      return;
    }
    const index = nestPath.findIndex((item) => item.id === entry.id);
    const target = graph.compositions?.[entry.id];
    if (index < 0 || !target) {
      setNotice("Sequence not found");
      return;
    }
    navigateToComposition(target, nestPath.slice(0, index));
    setNotice(`Back to "${target.name}"`);
  }

  /** Open any registry composition by id (Timelines tiles) — breadcrumb derived from nest links. */
  function handleOpenCompositionById(compositionId: string) {
    if (!composition || !graph) {
      return;
    }
    if (compositionId === composition.id) {
      return;
    }
    const registry = { ...(graph.compositions ?? {}), [composition.id]: composition };
    const target = registry[compositionId];
    if (!target) {
      setNotice("Sequence not found");
      return;
    }
    const rootId = graph.rootCompositionId ?? composition.id;
    const breadcrumb = deriveNestBreadcrumb(registry, rootId, compositionId);
    navigateToComposition(target, breadcrumb);
    setNotice(`Editing "${target.name}"`);
  }

  // --- Timelines media-pool section (NESTING_MATURITY.md Block 3) -----------------------------
  /** The full registry INCLUDING the (possibly not-yet-mirrored) active comp. */
  function compositionRegistry(): Record<string, TimelineComposition> {
    if (!graph || !composition) return {};
    return { ...(graph.compositions ?? {}), [composition.id]: composition };
  }

  /** Drag a Timelines tile onto a timeline track → insert a compound clip referencing it. */
  async function handleInsertCompositionClip(compositionId: string, trackId: string, startSeconds: number) {
    if (!composition || !graph) {
      return;
    }
    const registry = compositionRegistry();
    const nested = registry[compositionId];
    const track = composition.tracks.find((item) => item.id === trackId);
    if (!nested || !track || track.type === "audio" || track.locked) {
      return;
    }
    if (wouldCreateCompositionCycle(registry, composition.id, compositionId)) {
      setNotice("Can't place a sequence inside itself");
      return;
    }
    const base = createEditorLayer("video", track, composition, layers.length + 1);
    const clip: TimelineLayer = {
      ...base,
      name: nested.name,
      startSeconds: Math.max(0, startSeconds),
      durationSeconds: nested.durationSeconds,
      sourceInSeconds: 0,
      nestedCompositionId: nested.id,
      fit: "cover"
    };
    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((item) => (item.id === track.id ? { ...item, layers: [...item.layers, clip] } : item))
    });
    setSelectedLayerIds([clip.id]);
    setNotice(`Placed "${nested.name}"`);
  }

  /** Rename a sequence everywhere: the comp itself + every compound clip referencing it. */
  async function handleRenameComposition(compositionId: string, rawName: string) {
    if (!composition || !graph) {
      return;
    }
    const name = rawName.trim();
    if (!name) {
      return;
    }
    const apply = (comp: TimelineComposition): TimelineComposition => {
      const withInstanceNames: TimelineComposition = {
        ...comp,
        tracks: comp.tracks.map((track) => ({
          ...track,
          layers: track.layers.map((layer) => (layer.nestedCompositionId === compositionId ? { ...layer, name } : layer))
        }))
      };
      return comp.id === compositionId ? { ...withInstanceNames, name } : withInstanceNames;
    };
    await updateGraph({
      ...graph,
      composition: apply(composition),
      compositions: Object.fromEntries(Object.entries(graph.compositions ?? {}).map(([id, comp]) => [id, apply(comp)])),
      version: graph.version + 1
    });
    setNestPath((path) => path.map((entry) => (entry.id === compositionId ? { ...entry, name } : entry)));
  }

  /** Deep-clone a sequence under a fresh id (instances inside it keep referencing their nests). */
  async function handleDuplicateComposition(compositionId: string) {
    if (!composition || !graph) {
      return;
    }
    const source = compositionRegistry()[compositionId];
    if (!source) {
      return;
    }
    const freshId = (prefix: string) =>
      `${prefix}_${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)}`;
    const cloned: TimelineComposition = structuredClone(source);
    const clone: TimelineComposition = {
      ...cloned,
      id: freshId("nest"),
      name: `${source.name} copy`,
      tracks: cloned.tracks.map((track) => {
        const nextTrackId = freshId("ntrack");
        return { ...track, id: nextTrackId, layers: track.layers.map((layer) => ({ ...layer, id: freshId("clip"), trackId: nextTrackId })) };
      })
    };
    await updateGraph({
      ...graph,
      compositions: { ...(graph.compositions ?? {}), [clone.id]: clone },
      version: graph.version + 1
    });
    setNotice(`Duplicated as "${clone.name}"`);
  }

  /** Delete a sequence from the project. Referenced → confirm and remove its instance clips too. */
  async function handleDeleteComposition(compositionId: string) {
    if (!composition || !graph) {
      return;
    }
    const rootId = graph.rootCompositionId ?? composition.id;
    if (compositionId === rootId) {
      setNotice("Can't delete the main timeline");
      return;
    }
    if (compositionId === composition.id || nestPath.some((entry) => entry.id === compositionId)) {
      setNotice("Can't delete a sequence that's open — go back to Main first");
      return;
    }
    const registry = compositionRegistry();
    const target = registry[compositionId];
    if (!target) {
      return;
    }
    const instanceCount = Object.values(registry).reduce(
      (count, comp) =>
        count + comp.tracks.reduce((c, track) => c + track.layers.filter((layer) => layer.nestedCompositionId === compositionId).length, 0),
      0
    );
    if (instanceCount > 0) {
      const ok = window.confirm(`Delete "${target.name}" and remove ${instanceCount} clip${instanceCount === 1 ? "" : "s"} using it?`);
      if (!ok) {
        return;
      }
    }
    const strip = (comp: TimelineComposition): TimelineComposition => ({
      ...comp,
      tracks: comp.tracks.map((track) => ({
        ...track,
        layers: track.layers.filter((layer) => layer.nestedCompositionId !== compositionId)
      }))
    });
    const nextCompositions = Object.fromEntries(
      Object.entries(graph.compositions ?? {})
        .filter(([id]) => id !== compositionId)
        .map(([id, comp]) => [id, strip(comp)])
    );
    await updateGraph({ ...graph, composition: strip(composition), compositions: nextCompositions, version: graph.version + 1 });
    setNotice(`Deleted "${target.name}"`);
  }

  /** "Place at playhead" (context menu): first unlocked video track, at the current time. */
  function handleInsertCompositionAtPlayhead(compositionId: string) {
    if (!composition) {
      return;
    }
    const track = composition.tracks.find((item) => item.type !== "audio" && !item.locked);
    if (!track) {
      setNotice("No unlocked video track to place on");
      return;
    }
    void handleInsertCompositionClip(compositionId, track.id, currentTimeRef.current);
  }

  /** New empty sequence at project dims/fps; opens immediately. */
  async function handleCreateTimelineComposition() {
    if (!composition || !graph) {
      return;
    }
    const freshId = (prefix: string) =>
      `${prefix}_${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)}`;
    const taken = new Set(Object.values(compositionRegistry()).map((comp) => comp.name));
    let n = Object.keys(graph.compositions ?? {}).length + 1;
    let name = `Timeline ${String(n).padStart(2, "0")}`;
    while (taken.has(name)) {
      n += 1;
      name = `Timeline ${String(n).padStart(2, "0")}`;
    }
    const trackId = freshId("ntrack");
    const audioTrackId = freshId("ntrack");
    const created: TimelineComposition = {
      id: freshId("nest"),
      name,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      durationSeconds: 10,
      tracks: [
        { id: trackId, type: "video", name: "V1", layers: [] },
        { id: audioTrackId, type: "audio", name: "A1", layers: [] }
      ],
      backgroundColor: composition.backgroundColor
    };
    // One write: stash the current comp, register + open the new one (navigation, not an edit).
    void updateGraph(
      {
        ...graph,
        composition: created,
        compositions: { ...(graph.compositions ?? {}), [composition.id]: composition, [created.id]: created },
        version: graph.version + 1
      },
      created.durationSeconds,
      { recordHistory: false }
    );
    const rootId = graph.rootCompositionId ?? composition.id;
    setNestPath(rootId === composition.id ? [{ id: composition.id, name: composition.name }] : [...nestPath, { id: composition.id, name: composition.name }]);
    setSelectedLayerIds([]);
    setNotice(`Created "${name}"`);
  }


  async function handleResizeLayer(layerId: string, startSeconds: number, durationSeconds: number) {
    if (!composition) {
      return;
    }

    // Minimum clip length is a single frame — applies to every layer type.
    const minDur = 1 / Math.max(1, Math.round(composition.fps) || 30);

    // Edge-trim geometry (source reveal, duration cap, keyframe/anim timing) lives in the shared
    // resolveEdgeTrim/applyEdgeTrim primitive — the SAME one the drag preview calls, so what the user
    // sees while dragging a handle is exactly what commits (no head-overshoot snap-back).
    await updateLayer(layerId, (layer) => {
      const maxDurationSeconds = getLayerMaxDuration(layer, resolvedAssets, composition.durationSeconds, graph?.compositions);
      const resolution = resolveEdgeTrim(layer, { startSeconds, durationSeconds }, { maxDurationSeconds, minDurationSeconds: minDur });
      return applyEdgeTrim(layer, resolution);
    });
  }

  async function handleMoveKeyframe(layerId: string, keyframeId: string, timeSeconds: number) {
    if (!composition) {
      return;
    }

    await updateLayer(layerId, (layer) => {
      const nextTime = clamp(timeSeconds, 0, layer.durationSeconds);
      return {
        ...layer,
        keyframes: layer.keyframes.map((keyframe) =>
          keyframe.id === keyframeId
            ? {
                ...keyframe,
                timeSeconds: layer.startSeconds + nextTime
              }
            : keyframe
        ),
        animations: (layer.animations ?? []).map((keyframe) =>
          keyframe.id === keyframeId
            ? {
                ...keyframe,
                timeSeconds: nextTime
              }
            : keyframe
        )
      };
    });
  }

  async function handleDeleteKeyframe(layerId: string, keyframeId: string) {
    await updateLayer(layerId, (layer) => ({
      ...layer,
      keyframes: layer.keyframes.filter((keyframe) => keyframe.id !== keyframeId),
      animations: (layer.animations ?? []).filter((keyframe) => keyframe.id !== keyframeId)
    }));
  }

  /**
   * Mixer fader/pan writes — track-level audio, read everywhere via getTrackAudioGainAt/getTrackPanAt.
   * When the property is KEYFRAMED, a slider move upserts a keyframe at the playhead (Premiere-style
   * write-automation); otherwise it sets the static value.
   */
  async function handleChangeTrackAudio(trackId: string, patch: { volume?: number | undefined; pan?: number | undefined }) {
    if (!composition) {
      return;
    }
    const now = Number(currentTimeRef.current.toFixed(3));
    const epsilon = 1 / clamp(Math.round(composition.fps) || 30, 1, 120);
    const upsert = (keyframes: TrackAudioKeyframe[], value: number): TrackAudioKeyframe[] =>
      [...keyframes.filter((k) => Math.abs(k.timeSeconds - now) > epsilon / 2), { timeSeconds: now, value }].sort(
        (a, b) => a.timeSeconds - b.timeSeconds
      );
    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => {
        if (track.id !== trackId) return track;
        let next = track;
        if (patch.volume !== undefined) {
          const value = clamp(Number(patch.volume.toFixed(2)), 0, 2);
          next = track.volumeKeyframes?.length
            ? { ...next, volumeKeyframes: upsert(track.volumeKeyframes, value) }
            : { ...next, volume: value };
        }
        if (patch.pan !== undefined) {
          const value = clamp(Number(patch.pan.toFixed(2)), -1, 1);
          next = next.panKeyframes?.length
            ? { ...next, panKeyframes: upsert(next.panKeyframes ?? [], value) }
            : { ...next, pan: value };
        }
        return next;
      })
    });
  }

  /**
   * Auto-ducking (mixer "Duck" form): analyze the sidechain track's loudness and REPLACE the
   * target track clips' volume keyframes with the generated dip envelope (editor/audio-ducking.ts).
   * Plain composition data → undoable, hand-editable, and rendered identically by all three
   * renderers through the existing getCompositionVolume path.
   */
  async function handleAutoDuck(trackId: string, sidechainTrackId: string, options: DuckingOptions) {
    if (!composition) {
      return;
    }
    try {
      const regions = await analyzeSidechainRegions(
        composition,
        sidechainTrackId,
        (id) => resolvedAssetsRef.current.find((asset) => asset.id === id)?.fileUrl,
        options
      );
      if (!regions.length) {
        setNotice("No audio above the ducking sensitivity found on that track");
        return;
      }
      await updateComposition(applyDuckingKeyframes(composition, trackId, regions, options));
      setNotice(`Ducking applied under ${regions.length} ${regions.length === 1 ? "region" : "regions"}`);
    } catch {
      setNotice("Couldn't analyze that track's audio for ducking");
    }
  }

  /**
   * Mixer keyframe diamond: toggle a fader/pan automation keyframe at the playhead. The FIRST
   * toggle seeds the automation with the current value; removing the last keyframe bakes the
   * value at the playhead back into the static fader/pan.
   */
  async function handleToggleTrackAudioKeyframe(trackId: string, property: "volume" | "pan") {
    if (!composition) {
      return;
    }
    const now = Number(currentTimeRef.current.toFixed(3));
    const epsilon = 1 / clamp(Math.round(composition.fps) || 30, 1, 120);
    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => {
        if (track.id !== trackId) return track;
        const keyframes = (property === "volume" ? track.volumeKeyframes : track.panKeyframes) ?? [];
        const currentValue = property === "volume" ? getTrackAudioGainAt(track, now) : getTrackPanAt(track, now);
        const existing = keyframes.find((k) => Math.abs(k.timeSeconds - now) <= epsilon / 2);
        const nextKeyframes = existing
          ? keyframes.filter((k) => k !== existing)
          : [...keyframes, { timeSeconds: now, value: Number(currentValue.toFixed(3)) }].sort((a, b) => a.timeSeconds - b.timeSeconds);
        if (property === "volume") {
          return nextKeyframes.length
            ? { ...track, volumeKeyframes: nextKeyframes }
            : { ...track, volumeKeyframes: undefined, volume: clamp(Number(currentValue.toFixed(2)), 0, 2) };
        }
        return nextKeyframes.length
          ? { ...track, panKeyframes: nextKeyframes }
          : { ...track, panKeyframes: undefined, pan: clamp(Number(currentValue.toFixed(2)), -1, 1) };
      })
    });
  }

  async function handleClearTrackAudioKeyframes(trackId: string, property: "volume" | "pan") {
    if (!composition) {
      return;
    }
    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => {
        if (track.id !== trackId) return track;
        return property === "volume"
          ? { ...track, volumeKeyframes: undefined, volume: getTrackAudioGainAt(track, currentTimeRef.current) }
          : { ...track, panKeyframes: undefined, pan: getTrackPanAt(track, currentTimeRef.current) };
      })
    });
  }

  async function handleToggleTrack(trackId: string, patch: Partial<Pick<TimelineTrack, "locked" | "muted" | "solo">>) {
    if (!composition) {
      return;
    }
    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track))
    });
  }

  async function handleDeleteTrack(trackId: string) {
    if (!composition || composition.tracks.length <= 1) {
      return;
    }
    await updateComposition({
      ...composition,
      tracks: composition.tracks.filter((track) => track.id !== trackId)
    });
  }

  async function handleReorderTrack(trackId: string, targetTrackId: string, placement: "before" | "after") {
    if (!composition || trackId === targetTrackId) {
      return;
    }
    const source = composition.tracks.find((track) => track.id === trackId);
    const target = composition.tracks.find((track) => track.id === targetTrackId);
    if (!source || !target || (source.type === "audio") !== (target.type === "audio")) {
      return;
    }
    const familyTracks = composition.tracks.filter((track) => (track.type === "audio") === (source.type === "audio"));
    const reorderedFamily = familyTracks.filter((track) => track.id !== trackId);
    const targetIndex = reorderedFamily.findIndex((track) => track.id === targetTrackId);
    if (targetIndex < 0) return;
    reorderedFamily.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, source);
    const visualTracks = source.type === "audio" ? composition.tracks.filter((track) => track.type !== "audio") : reorderedFamily;
    const audioTracks = source.type === "audio" ? reorderedFamily : composition.tracks.filter((track) => track.type === "audio");
    await updateComposition({ ...composition, tracks: [...visualTracks, ...audioTracks] });
    setNotice(`Moved ${source.name}`);
  }

  async function handleDeleteLayer(layerId: string) {
    if (!composition) {
      return;
    }

    const owningTrack = composition.tracks.find((track) => track.layers.some((layer) => layer.id === layerId));
    const layer = owningTrack?.layers.find((item) => item.id === layerId);
    if (!owningTrack || !layer || owningTrack.locked || layer.locked) {
      return;
    }

    const nextTracks = composition.tracks.map((track) => ({
      ...track,
      layers: track.layers.filter((item) => item.id !== layerId)
    }));
    const nextLayer = nextTracks.flatMap((track) => track.layers)[0];
    setSelectedLayerIds(nextLayer?.id ? [nextLayer.id] : []);
    await updateComposition({
      ...composition,
      tracks: nextTracks
    });
  }

  function isLayerEditable(layerId: string): boolean {
    if (!composition) return false;
    const owningTrack = composition.tracks.find((track) => track.layers.some((layer) => layer.id === layerId));
    const layer = owningTrack?.layers.find((item) => item.id === layerId);
    return Boolean(owningTrack && layer && !owningTrack.locked && !layer.locked);
  }

  /** Delete every selected clip in one history step (skips locked clips/tracks). */
  async function handleDeleteLayers(layerIds: string[]) {
    if (!composition || !layerIds.length) {
      return;
    }
    if (layerIds.length === 1) {
      await handleDeleteLayer(layerIds[0]!);
      return;
    }
    const removable = new Set(layerIds.filter((id) => isLayerEditable(id)));
    if (!removable.size) {
      return;
    }
    const nextTracks = composition.tracks.map((track) => ({
      ...track,
      layers: track.layers.filter((item) => !removable.has(item.id))
    }));
    setSelectedLayerIds([]);
    await updateComposition({ ...composition, tracks: nextTracks });
    setNotice(`${removable.size} clips deleted`);
  }

  /** Duplicate every selected clip in one history step (skips locked clips/tracks); selects the copies. */
  async function handleDuplicateLayers(layerIds: string[]) {
    if (!composition || !layerIds.length) {
      return;
    }
    if (layerIds.length === 1) {
      await handleDuplicateLayer(layerIds[0]!);
      return;
    }
    let next = composition;
    const newIds: string[] = [];
    for (const id of layerIds) {
      if (!isLayerEditable(id)) continue;
      const result = duplicateLayer(next, id);
      next = result.composition;
      if (result.newLayerId) newIds.push(result.newLayerId);
    }
    if (next === composition) {
      return;
    }
    setSelectedLayerIds(newIds);
    await updateComposition(next);
    setNotice(`${newIds.length} clips duplicated`);
  }

  async function handleSplitLayerAt(layerId: string, atSeconds: number) {
    if (!composition || !isLayerEditable(layerId)) {
      return;
    }
    await updateComposition(splitLayerAtTime(composition, layerId, atSeconds));
  }

  async function handleSplitAtPlayhead() {
    if (!composition) {
      return;
    }
    // Split every selected clip the playhead passes through; with NO selection, split every
    // editable clip under the playhead (Premiere ⌘K / Resolve ⌘B behaviour — before this, the
    // S key and the scissors button were silent no-ops until you selected something).
    const time = currentTimeRef.current;
    const splittable = flattenTimelineLayers(composition).filter(
      (layer) =>
        (selectedLayerIds.length === 0 || selectedLayerIds.includes(layer.id)) &&
        isLayerEditable(layer.id) &&
        time > layer.startSeconds + 0.0001 &&
        time < layer.startSeconds + layer.durationSeconds - 0.0001
    );
    if (!splittable.length) {
      return;
    }
    let next = composition;
    for (const layer of splittable) {
      next = splitLayerAtTime(next, layer.id, time);
    }
    await updateComposition(next);
  }

  async function handleRippleDeleteLayer(layerId: string) {
    if (!composition || !isLayerEditable(layerId)) {
      return;
    }
    setSelectedLayerIds([]);
    await updateComposition(rippleDeleteLayer(composition, layerId));
  }

  // Trim-suite clamp inputs shared by roll/slide/extend: asset-backed max durations + one frame minimum.
  function trimLimitOptions() {
    return { maxDurationsSeconds: layerMaxDurations, minDurationSeconds: composition ? 1 / composition.fps : 1 / 30 };
  }

  async function handleRollEdit(leftLayerId: string, rightLayerId: string, deltaSeconds: number) {
    if (!composition || !isLayerEditable(leftLayerId) || !isLayerEditable(rightLayerId)) {
      return;
    }
    const next = rollEditAtCut(composition, leftLayerId, rightLayerId, deltaSeconds, trimLimitOptions());
    if (next !== composition) await updateComposition(next);
  }

  async function handleSlideLayer(layerId: string, deltaSeconds: number) {
    if (!composition || !isLayerEditable(layerId)) {
      return;
    }
    const next = slideLayer(composition, layerId, deltaSeconds, trimLimitOptions());
    if (next !== composition) await updateComposition(next);
  }

  /**
   * E — extend edit to playhead (Premiere): move the selected clip's NEAREST edge to the
   * playhead. A touching neighbour makes it a roll (both clips adjust, timeline length
   * unchanged); a free edge is a plain trim/extend of just that clip.
   */
  async function handleExtendEditToPlayhead() {
    if (!composition || selectedLayerIds.length !== 1) return;
    const layerId = selectedLayerIds[0]!;
    const layer = layers.find((item) => item.id === layerId);
    if (!layer || !isLayerEditable(layerId)) return;
    const time = currentTimeRef.current;
    const tailTime = layer.startSeconds + layer.durationSeconds;
    const side: "head" | "tail" = Math.abs(time - layer.startSeconds) <= Math.abs(time - tailTime) ? "head" : "tail";
    const track = composition.tracks.find((item) => item.layers.some((candidate) => candidate.id === layerId));
    const ordered = [...(track?.layers ?? [])].sort((a, b) => a.startSeconds - b.startSeconds);
    const index = ordered.findIndex((item) => item.id === layerId);
    const neighbour = side === "head" ? (index > 0 ? ordered[index - 1]! : null) : (index >= 0 && index < ordered.length - 1 ? ordered[index + 1]! : null);
    const cut = side === "head" ? layer.startSeconds : tailTime;
    const touching =
      neighbour !== null &&
      Math.abs(side === "head" ? cut - (neighbour.startSeconds + neighbour.durationSeconds) : neighbour.startSeconds - cut) < 0.02;
    const options = trimLimitOptions();
    const next =
      touching && neighbour
        ? side === "head"
          ? rollEditAtCut(composition, neighbour.id, layerId, time - cut, options)
          : rollEditAtCut(composition, layerId, neighbour.id, time - cut, options)
        : trimLayerEdgeTo(composition, layerId, side, time, options);
    if (next !== composition) await updateComposition(next);
  }

  /** Responsive-Time (§5): set/clear a clip's protected intro/outro. Both 0 → clears the field. */
  async function handleSetResponsiveTime(layerId: string, value: { introSeconds: number; outroSeconds: number }) {
    if (!composition) {
      return;
    }
    const introSeconds = Math.max(0, value.introSeconds);
    const outroSeconds = Math.max(0, value.outroSeconds);
    const responsiveTime = introSeconds <= 0.0001 && outroSeconds <= 0.0001 ? undefined : { introSeconds, outroSeconds };
    await updateLayer(layerId, (item) => ({ ...item, responsiveTime }));
  }

  /** Graphics-stack drag-reorder: change a layer's Z relative to a same-track sibling (one history step). */
  async function handleReorderLayerWithinTrack(layerId: string, targetLayerId: string, place: "front-of" | "behind") {
    if (!composition) {
      return;
    }
    const next = moveLayerWithinTrack(composition, layerId, targetLayerId, place);
    if (next !== composition) await updateComposition(next);
  }

  async function handleDuplicateLayer(layerId: string) {
    if (!composition || !isLayerEditable(layerId)) {
      return;
    }
    const { composition: next, newLayerId } = duplicateLayer(composition, layerId);
    if (newLayerId) {
      setSelectedLayerIds([newLayerId]);
    }
    await updateComposition(next);
  }

  // Markers are timeline-only bookmarks (no render effect): toggling at the
  // playhead either drops a new one or removes an existing one within ~0.05s.
  // Stored as TimelineMarker objects (name/color); legacy bare-number entries
  // are upgraded through normalizeTimelineMarkers on every write.
  function handleToggleMarkerAtPlayhead() {
    if (!composition) {
      return;
    }
    const time = Number(currentTimeRef.current.toFixed(3));
    // CLIP marker first (Premiere behavior): when a SELECTED clip spans the playhead, the marker
    // belongs to that clip (clip-local time, travels with it). No selected clip under the playhead
    // → timeline ruler marker as before. Ref, not state — 'M' fires from keydown.
    const selectedUnderPlayhead = selectedLayerIdsRef.current
      .map((id) => layers.find((item) => item.id === id))
      .find((item) => item && time >= item.startSeconds && time <= item.startSeconds + item.durationSeconds);
    if (selectedUnderPlayhead) {
      const localTime = Number((time - selectedUnderPlayhead.startSeconds).toFixed(3));
      void updateLayer(selectedUnderPlayhead.id, (layer) => {
        const existing = layer.markers ?? [];
        const nearby = existing.find((marker) => Math.abs(marker.timeSeconds - localTime) < 0.05);
        const nextMarkers = nearby
          ? existing.filter((marker) => marker.timeSeconds !== nearby.timeSeconds)
          : [...existing, { timeSeconds: localTime }].sort((a, b) => a.timeSeconds - b.timeSeconds);
        return { ...layer, markers: nextMarkers.length > 0 ? nextMarkers : undefined };
      });
      return;
    }
    updateCompositionSettings((settings) => {
      const existing = normalizeTimelineMarkers(settings.timeline.markers);
      const nearby = existing.find((marker) => Math.abs(marker.timeSeconds - time) < 0.05);
      const nextMarkers = nearby
        ? existing.filter((marker) => marker.timeSeconds !== nearby.timeSeconds)
        : [...existing, { timeSeconds: time }].sort((a, b) => a.timeSeconds - b.timeSeconds);
      return { ...settings, timeline: { ...settings.timeline, markers: nextMarkers } };
    });
  }

  function handleRemoveMarker(markerTime: number) {
    updateCompositionSettings((settings) => ({
      ...settings,
      timeline: {
        ...settings.timeline,
        markers: normalizeTimelineMarkers(settings.timeline.markers).filter((marker) => marker.timeSeconds !== markerTime)
      }
    }));
  }

  /** Rename/recolor the marker at `markerTime` (identified by time — markers have no ids). */
  function handleUpdateMarker(markerTime: number, patch: { name?: string | undefined; color?: string | undefined }) {
    updateCompositionSettings((settings) => ({
      ...settings,
      timeline: {
        ...settings.timeline,
        markers: normalizeTimelineMarkers(settings.timeline.markers).map((marker) =>
          marker.timeSeconds === markerTime ? { ...marker, ...patch } : marker
        )
      }
    }));
  }

  /** Remove a clip marker (identified by clip-local time — markers have no ids). */
  function handleRemoveClipMarker(layerId: string, markerTime: number) {
    void updateLayer(layerId, (layer) => {
      const nextMarkers = (layer.markers ?? []).filter((marker) => marker.timeSeconds !== markerTime);
      return { ...layer, markers: nextMarkers.length > 0 ? nextMarkers : undefined };
    });
  }

  /** Rename/recolor a clip marker (identified by clip-local time). */
  function handleUpdateClipMarker(layerId: string, markerTime: number, patch: { name?: string | undefined; color?: string | undefined }) {
    void updateLayer(layerId, (layer) => ({
      ...layer,
      markers: (layer.markers ?? []).map((marker) => (marker.timeSeconds === markerTime ? { ...marker, ...patch } : marker))
    }));
  }

  // In/out points mark the exportable sub-range of the timeline (Premiere-style
  // "work area"). Setting one past the other clears the one it crossed so the
  // range never inverts. They're export-only - the editor still shows/plays the
  // full timeline.
  function handleSetInPoint(timeSeconds?: number) {
    if (!composition) {
      return;
    }
    const time = Number((timeSeconds ?? currentTimeRef.current).toFixed(3));
    updateCompositionSettings((settings) => {
      const outPoint = settings.timeline.outPointSeconds;
      return {
        ...settings,
        timeline: { ...settings.timeline, inPointSeconds: time, outPointSeconds: outPoint !== undefined && time >= outPoint ? undefined : outPoint }
      };
    });
  }

  function handleSetOutPoint(timeSeconds?: number) {
    if (!composition) {
      return;
    }
    const time = Number((timeSeconds ?? currentTimeRef.current).toFixed(3));
    updateCompositionSettings((settings) => {
      const inPoint = settings.timeline.inPointSeconds;
      return {
        ...settings,
        timeline: { ...settings.timeline, outPointSeconds: time, inPointSeconds: inPoint !== undefined && time <= inPoint ? undefined : inPoint }
      };
    });
  }

  function handleClearInPoint() {
    updateCompositionSettings((settings) => ({ ...settings, timeline: { ...settings.timeline, inPointSeconds: undefined } }));
  }

  function handleClearOutPoint() {
    updateCompositionSettings((settings) => ({ ...settings, timeline: { ...settings.timeline, outPointSeconds: undefined } }));
  }

  function handleClearInOutPoints() {
    updateCompositionSettings((settings) => ({ ...settings, timeline: { ...settings.timeline, inPointSeconds: undefined, outPointSeconds: undefined } }));
  }

  // Slip: shift a clip's source in-point (clip position/duration unchanged). Clamp
  // to the source asset so the clip's window never runs past the end of the media.
  function handleSlipLayer(layerId: string, sourceInSeconds: number) {
    if (!composition) {
      return;
    }
    const layer = flattenTimelineLayers(composition).find((item) => item.id === layerId);
    if (!layer) {
      return;
    }
    // Slip bounds live in SOURCE seconds: the clip consumes durationSeconds * speed of media.
    const speed = getLayerSpeed(layer);
    const maxDuration = getLayerMaxDuration(layer, resolvedAssets, composition.durationSeconds, graph?.compositions);
    const clamped = clamp(Number(sourceInSeconds.toFixed(3)), 0, Math.max(0, (maxDuration - layer.durationSeconds) * Math.abs(speed)));
    if (clamped === (layer.sourceInSeconds ?? 0)) {
      return;
    }
    void updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((item) => (item.id === layerId ? { ...item, sourceInSeconds: clamped } : item))
      }))
    });
  }

  /**
   * Rate stretch (Premiere's Clip Speed dialog, non-ripple): change a clip's constant playback
   * speed, re-deriving its timeline duration so it keeps playing the SAME source span
   * (duration = sourceSpan / speed). Tail growth is clamped at the next clip on the same track
   * (no overlaps, like Premiere without ripple). Linked companions (video+audio pairs) get the
   * same speed + duration so they never drift apart.
   */
  function handleChangeLayerSpeed(layerId: string, requestedSpeed: number) {
    if (!composition) {
      return;
    }
    const layer = flattenTimelineLayers(composition).find((item) => item.id === layerId);
    if (!layer || !isLayerEditable(layerId)) {
      return;
    }
    const newSpeedMagnitude = clamp(Math.abs(Number(requestedSpeed.toFixed(3))), 0.05, 16);
    const newSpeed = requestedSpeed < 0 ? -newSpeedMagnitude : newSpeedMagnitude; // S2: negative = reverse
    const oldSpeed = getLayerSpeed(layer);
    if (Math.abs(newSpeed - oldSpeed) < 0.0005) {
      return;
    }
    const frameSeconds = 1 / clamp(Math.round(composition.fps) || 30, 1, 120);
    const groupIds = new Set<string>(
      layer.linkedGroupId
        ? flattenTimelineLayers(composition)
            .filter((item) => item.linkedGroupId === layer.linkedGroupId)
            .map((item) => item.id)
        : [layerId]
    );
    const sourceSpan = layer.durationSeconds * Math.abs(oldSpeed);
    let newDuration = Math.max(frameSeconds, sourceSpan / newSpeedMagnitude);
    // Clamp tail growth at the earliest next clip across every track a group member sits on.
    for (const track of composition.tracks) {
      for (const member of track.layers) {
        if (!groupIds.has(member.id)) continue;
        const nextStart = track.layers
          .filter((other) => !groupIds.has(other.id) && other.startSeconds >= member.startSeconds + member.durationSeconds - 0.02)
          .reduce<number | null>((best, other) => (best === null || other.startSeconds < best ? other.startSeconds : best), null);
        if (nextStart !== null) {
          newDuration = Math.min(newDuration, Math.max(frameSeconds, nextStart - member.startSeconds));
        }
      }
    }
    void updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((item) =>
          groupIds.has(item.id) ? { ...item, speed: newSpeed, durationSeconds: Number(newDuration.toFixed(3)) } : item
        )
      }))
    });
    setNotice(`Speed ${Math.round(newSpeed * 100)}%`);
  }

  // Replace asset: open the asset bin in "pick one" mode bound to this layer; the
  // tile click handler routes through the existing replace path in handleDropAsset.
  function handleReplaceLayerAsset(layerId: string) {
    if (!composition) {
      return;
    }
    const layer = flattenTimelineLayers(composition).find((item) => item.id === layerId);
    if (!layer) {
      return;
    }
    setAssetPickerForLayerId(layerId);
    setPanelTab("assets");
    setNotice("Pick an asset to replace this clip");
  }

  async function handleSaveAsTemplate(input: { name: string; category: string; description: string }) {
    if (!composition || !graph) {
      return;
    }
    setBusy("template");
    try {
      // Snapshot the live composition into a reusable template graph (auto-marks
      // media/text slots, strips project-specific asset bindings from media slots).
      const templateGraph = buildTemplateGraphFromProject({ ...graph, composition });
      const requiredModules = [...new Set(graph.effects.map((effect) => effect.type))];
      await createTemplate({
        name: input.name,
        category: input.category || "Custom",
        description: input.description || `Template from ${project?.title ?? "project"}`,
        durationSeconds: composition.durationSeconds,
        requiredModules,
        templateGraph
      });
      setTemplateModalOpen(false);
      setNotice(`Saved "${input.name}" as a template`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save template");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Apply a Templates-gallery pick into the CURRENTLY OPEN project. Always append (never replaces the
   * existing timeline) — safe by default, mirrors how a stock/asset pick is added to the timeline, and
   * needs no "append vs replace" confirmation prompt. Media slots on the incoming layers ship with no
   * assetId (see `buildTemplateGraphFromProject`); they land as empty clips the user fills via the normal
   * replace-asset flow, so a template never silently drags in another project's media.
   */
  async function handleApplyTemplate(template: TemplateDefinition) {
    if (!project || !graph || !composition) return;
    const templateComposition = template.templateGraph?.composition;
    if (!templateComposition) {
      setNotice("This template has no timeline content to apply");
      return;
    }
    setBusy("template-apply");
    try {
      const isEmpty = flattenTimelineLayers(composition).length === 0;
      const { composition: nextComposition, offsetSeconds } = isEmpty
        ? { composition: instantiateTemplateComposition(templateComposition, project.id), offsetSeconds: 0 }
        : appendTimelineComposition(composition, templateComposition, project.id);
      const nextGraph: ProjectGraph = { ...graph, composition: nextComposition, version: graph.version + 1 };
      await updateGraph(nextGraph, nextComposition.durationSeconds);
      setSelectedLayerIds([]);
      setEditorCurrentTime(offsetSeconds);
      const emptySlots = flattenTimelineLayers(nextComposition).filter((item) => item.slot?.kind === "media" && !item.assetId).length;
      setNotice(`Added "${template.name}"${emptySlots ? ` · ${emptySlots} empty media slot${emptySlots === 1 ? "" : "s"} need an asset` : ""}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not apply template");
    } finally {
      setBusy(null);
    }
  }

  function exportTimelineTemplatePackage(event?: { shiftKey?: boolean }) {
    if (!project || !graph || !composition) {
      setNotice("Open a timeline before exporting a template package");
      return;
    }
    // Default = ".kimera" ZIP with embedded media (self-contained, no relink warnings on import).
    // Shift+click = the lightweight bare ".kimera-template.json" (no media, git-friendly).
    if (!event?.shiftKey) {
      void exportTimelineTemplatePackageZip();
      return;
    }
    try {
      const pkg = buildTimelineTemplatePackage({
        projectId: project.id,
        title: `${project.title} Template`,
        description: `Kimera template package exported from ${project.title}.`,
        graph,
        composition,
        assets: resolvedAssets
      });
      downloadJsonFile(timelineTemplatePackageToJson(pkg), `${safeFileStem(project.title)}.kimera-template.json`);
      const warningText = pkg.warnings.length ? ` (${pkg.warnings.length} warning${pkg.warnings.length === 1 ? "" : "s"})` : "";
      setNotice(`Template package exported${warningText}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Template package export failed");
    }
  }

  /** Reads an asset's bytes for ZIP embedding: local blob store (OPFS/IDB/memory) first, else fetch fileUrl. */
  async function readAssetBytesForPackage(asset: SourceAsset): Promise<Uint8Array | null> {
    try {
      const store = await getAssetBlobStore();
      const blob = await store.getBlob(asset.id);
      if (blob) return new Uint8Array(await blob.arrayBuffer());
    } catch {
      /* fall through to a remote fetch */
    }
    if (asset.fileUrl) {
      try {
        const response = await fetch(asset.fileUrl);
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
      } catch {
        /* asset stays unembedded; the ZIP still carries its metadata, so import still relinks by name */
      }
    }
    return null;
  }

  async function exportTimelineTemplatePackageZip() {
    if (!project || !graph || !composition) {
      setNotice("Open a timeline before exporting a template package");
      return;
    }
    setBusy("template-package");
    setNotice("Building .kimera package (embedding media)…");
    try {
      const pkg = buildTimelineTemplatePackage({
        projectId: project.id,
        title: `${project.title} Template`,
        description: `Kimera template package exported from ${project.title}.`,
        graph,
        composition,
        assets: resolvedAssets
      });
      const assetBytesById = await Promise.all(
        pkg.assets.map(async (assetRef) => {
          const sourceAsset = resolvedAssets.find((a) => a.id === assetRef.id);
          const bytes = sourceAsset ? await readAssetBytesForPackage(sourceAsset) : null;
          return bytes ? { id: assetRef.id, fileName: assetRef.fileName, bytes } : null;
        })
      );
      const embeddedAssets = assetBytesById.filter((a): a is { id: string; fileName: string; bytes: Uint8Array } => a !== null);
      const zip = await buildKimeraPackageZipAsync({ pkg, assets: embeddedAssets });
      downloadBlobFile(new Blob([zip.slice()], { type: "application/zip" }), `${safeFileStem(project.title)}.kimera`);
      const skipped = pkg.assets.length - embeddedAssets.length;
      const warningText = pkg.warnings.length ? ` (${pkg.warnings.length} warning${pkg.warnings.length === 1 ? "" : "s"})` : "";
      const skippedText = skipped > 0 ? ` · ${skipped} asset${skipped === 1 ? "" : "s"} could not be embedded and stay relink-by-name` : "";
      setNotice(`Template package exported with ${embeddedAssets.length} embedded asset${embeddedAssets.length === 1 ? "" : "s"}${skippedText}${warningText}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Template package export failed");
    } finally {
      setBusy(null);
    }
  }

  async function importTimelineOrTemplateFile(file: File | undefined) {
    if (!file || !project) {
      return;
    }

    if (file.name.toLowerCase().endsWith(".kimera")) {
      await importKimeraPackageZip(file);
      return;
    }
    // Non-".kimera"-named files still get sniffed for the ZIP magic (a renamed/downloaded package),
    // matching how the JSON branch below already sniffs content rather than trusting the extension.
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (isKimeraPackageZipBytes(head)) {
      await importKimeraPackageZip(file);
      return;
    }

    setBusy("template-package");
    try {
      const contents = isExternalTimelineFile(file.name) ? await readExternalTimelineFileText(file) : await file.text();
      if (isExternalTimelineFile(file.name) && !contents.trimStart().startsWith("{")) {
        const imported = parseExternalTimelineFile({
          fileName: file.name,
          contents,
          projectId: project.id,
          projectTitle: project.title
        });
        setExternalTimelineImportMode("append");
        setPendingExternalTimelineImport(imported);
        setPendingExternalTimelineSource({ fileName: file.name, contents });
        setNotice(`Review timeline import report for "${imported.report.title}"`);
        return;
      }
      const raw = JSON.parse(contents) as unknown;
      const pkg = parseTimelineTemplatePackage(raw);
      const applied = applyTimelineTemplatePackage({
        package: pkg,
        projectId: project.id,
        projectTitle: project.title,
        sourceAssetId: project.sourceAssetId ?? project.sourceAsset?.id ?? undefined,
        availableAssetIds: resolvedAssets.map((asset) => asset.id)
      });
      await updateGraph(applied.graph, applied.composition?.durationSeconds ?? project.durationSeconds);
      setSelectedLayerIds([]);
      setEditorCurrentTime(0);
      if (applied.warnings.length) {
        console.warn("[templates] import warnings", applied.warnings);
      }
      setNotice(applied.warnings[0] ? `Imported "${pkg.manifest.name}" · ${applied.warnings[0]}` : `Imported "${pkg.manifest.name}"`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Template package import failed");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Import a ".kimera" ZIP package: unzip, create a real local `SourceAsset` per embedded asset (via the
   * normal `createAsset` — local OPFS-first with an opt-in server fallback, same as any drag-drop upload),
   * then remap `layer.assetId` from the package's original ids to the freshly created ones so the applied
   * composition points at real, present media instead of relink-by-name placeholders.
   */
  async function importKimeraPackageZip(file: File) {
    if (!project) return;
    setBusy("template-package");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { pkg, assetBytes } = await parseKimeraPackageZipAsync(bytes);
      const idMap = new Map<string, string>();
      const assetWarnings: string[] = [];
      for (const assetRef of pkg.assets) {
        const embedded = assetBytes.get(assetRef.id);
        if (!embedded) {
          assetWarnings.push(`"${assetRef.fileName}" was not embedded; relink it manually.`);
          continue;
        }
        try {
          const blobFile = new File([embedded.slice()], assetRef.fileName, { type: assetRef.fileType || "application/octet-stream" });
          const metadata = blobFile.type.startsWith("video/") || blobFile.type.startsWith("image/")
            ? await readMediaMetadata(blobFile)
            : undefined;
          const kind = blobFile.type.startsWith("image/") ? "image" : blobFile.type.startsWith("audio/") ? "audio" : "video";
          const created = await createAsset({
            file: blobFile,
            durationSeconds: metadata?.durationSeconds ?? assetRef.durationSeconds,
            width: metadata?.width ?? assetRef.width,
            height: metadata?.height ?? assetRef.height,
            hasAudio: metadata?.hasAudio,
            source: assetRef.source ?? "local",
            // Local-first, like a normal import: embedded package media stays on-device until pushed.
            localOnly: true,
            folder: `local/${kind}`,
            originalName: assetRef.fileName,
            sizeBytes: embedded.byteLength,
            // Package media is imported FOR this project — own it here (same "pile" rule as uploads).
            projectId: project.id
          });
          idMap.set(assetRef.id, created.id);
          registerAsset(created);
        } catch {
          assetWarnings.push(`Could not import embedded asset "${assetRef.fileName}".`);
        }
      }
      const applied = applyTimelineTemplatePackage({
        package: pkg,
        projectId: project.id,
        projectTitle: project.title,
        sourceAssetId: project.sourceAssetId ?? project.sourceAsset?.id ?? undefined,
        availableAssetIds: [...resolvedAssets.map((asset) => asset.id), ...idMap.values()]
      });
      const remappedComposition = applied.composition ? remapCompositionAssetIds(applied.composition, idMap) : applied.composition;
      const remappedAuxCompositions = applied.graph.compositions
        ? Object.fromEntries(
            Object.entries(applied.graph.compositions).map(([id, comp]) => [id, remapCompositionAssetIds(comp, idMap)])
          )
        : applied.graph.compositions;
      await updateGraph(
        { ...applied.graph, composition: remappedComposition, compositions: remappedAuxCompositions },
        remappedComposition?.durationSeconds ?? project.durationSeconds
      );
      setSelectedLayerIds([]);
      setEditorCurrentTime(0);
      const warnings = [...applied.warnings, ...assetWarnings];
      if (warnings.length) {
        console.warn("[templates] .kimera import warnings", warnings);
      }
      setNotice(
        warnings[0]
          ? `Imported "${pkg.manifest.name}" · ${idMap.size} embedded asset(s) · ${warnings[0]}`
          : `Imported "${pkg.manifest.name}" with ${idMap.size} embedded asset(s)`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : ".kimera package import failed");
    } finally {
      setBusy(null);
    }
  }

  /** Re-parse the pending import against a different `.prproj` sequence (Task 2.3 multi-sequence picker). */
  function reparseExternalTimelineWithSequence(sequenceId: string) {
    if (!project || !pendingExternalTimelineSource) return;
    const imported = parseExternalTimelineFile({
      fileName: pendingExternalTimelineSource.fileName,
      contents: pendingExternalTimelineSource.contents,
      projectId: project.id,
      projectTitle: project.title,
      sequenceId
    });
    setPendingExternalTimelineImport(imported);
  }

  async function applyPendingExternalTimelineImport(mode: ExternalTimelineImportMode) {
    if (!project || !graph || !composition || !pendingExternalTimelineImport) {
      return;
    }
    const imported = pendingExternalTimelineImport;
    setBusy("timeline-import");
    try {
      const appended = mode === "append" ? appendTimelineComposition(composition, imported.composition, project.id) : undefined;
      const nextComposition = appended?.composition ?? imported.composition;
      const nextGraph: ProjectGraph = {
        ...imported.graph,
        projectId: project.id,
        sourceAssetId: project.sourceAssetId ?? project.sourceAsset?.id ?? graph.sourceAssetId,
        effects: graph.effects,
        composition: nextComposition,
        plugins: graph.plugins,
        editableFields: {
          ...graph.editableFields,
          timelineImportReport: imported.report,
          timelineImportReports: [...readTimelineImportReports(graph.editableFields.timelineImportReports), imported.report]
        },
        version: graph.version + 1
      };
      await updateGraph(nextGraph, nextComposition.durationSeconds);
      setPendingExternalTimelineImport(null);
      setSelectedLayerIds([]);
      setEditorCurrentTime(appended?.offsetSeconds ?? 0);
      setNotice(
        `${mode === "append" ? "Appended" : "Imported"} ${imported.report.counts.clips} clip${imported.report.counts.clips === 1 ? "" : "s"} from "${imported.report.title}"`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Timeline import failed");
    } finally {
      setBusy(null);
    }
  }

  async function handlePickReplacement(asset: SourceAsset) {
    const layerId = assetPickerForLayerId;
    if (!composition || !layerId) {
      return;
    }
    const layer = flattenTimelineLayers(composition).find((item) => item.id === layerId);
    setAssetPickerForLayerId(null);
    if (!layer) {
      return;
    }
    await handleDropAsset(asset.id, layer.trackId, layer.startSeconds, layerId);
    setNotice(`Replaced clip with ${asset.fileName}`);
  }

  function handleCopyLayer(layerId: string) {
    if (!composition) {
      return;
    }
    const layer = flattenTimelineLayers(composition).find((item) => item.id === layerId);
    if (layer) {
      copyLayerToClipboard(layer);
      setNotice("Clip copied");
    }
  }

  async function handlePasteLayer() {
    if (!composition || !hasClipboardLayer()) {
      return;
    }
    const pasted = pasteLayerFromClipboard(currentTimeRef.current);
    if (!pasted) {
      return;
    }
    // Drop the paste onto its original track if it still exists, else the first track.
    const targetTrack = composition.tracks.find((track) => track.id === pasted.trackId) ?? composition.tracks[0];
    if (!targetTrack) {
      return;
    }
    pasted.trackId = targetTrack.id;
    setSelectedLayerIds([pasted.id]);
    await updateComposition({
      ...composition,
      tracks: composition.tracks.map((track) =>
        track.id === targetTrack.id ? { ...track, layers: [...track.layers, pasted] } : track
      )
    });
  }

  async function handleAddLayer(type: TimelineLayerType, options?: ShapeAddOptions) {
    if (!composition) {
      return;
    }

    const selectedTrack = selectedLayer ? composition.tracks.find((item) => item.id === selectedLayer.trackId) : undefined;
    const track =
      type === "audio"
        ? composition.tracks.find((item) => item.type === "audio")
        : selectedTrack && selectedTrack.type !== "audio"
          ? selectedTrack
          : composition.tracks.find((item) => item.type !== "audio");
    if (!track) {
      return;
    }

    const layer = createEditorLayer(type, track, composition, layers.length + 1, currentTimeRef.current, options);
    const nextComposition: TimelineComposition = {
      ...composition,
      tracks: composition.tracks.map((item) =>
        item.id === track.id
          ? {
              ...item,
              layers: [...item.layers, layer]
            }
          : item
      )
    };
    setSelectedLayerIds([layer.id]);
    // Draw-first pen flow: the new pen layer has no geometry yet — arm the viewer pen tool so the
    // next canvas clicks draw the outline (committed via stablePreviewCommitShapePath).
    if (options?.shapeKind === "pen") changeMaskTool("pen");
    await updateComposition(nextComposition);
  }

  // Add a Search → Graphics pick as a self-contained editable VECTOR layer (no rasterized asset): an image
  // layer whose pixel source is the recolored SVG data URL. Stays crisp at any scale and recolorable via the
  // inspector. Persists inside the project graph — no asset/file dependency.
  async function handleAddGraphic(graphic: LayerGraphic, name: string) {
    if (!composition) {
      return;
    }
    const selectedTrack = selectedLayer ? composition.tracks.find((item) => item.id === selectedLayer.trackId) : undefined;
    const track =
      selectedTrack && selectedTrack.type !== "audio"
        ? selectedTrack
        : composition.tracks.find((item) => item.type !== "audio");
    if (!track) {
      return;
    }
    const base = createEditorLayer("image", track, composition, layers.length + 1, currentTimeRef.current);
    const layer: TimelineLayer = { ...base, name: name || "Graphic", graphic, fit: "contain" };
    const nextComposition: TimelineComposition = {
      ...composition,
      tracks: composition.tracks.map((item) => (item.id === track.id ? { ...item, layers: [...item.layers, layer] } : item))
    };
    setSelectedLayerIds([layer.id]);
    await updateComposition(nextComposition);
  }

  /**
   * Frames (Phase 1): apply a picked frame. With an image/video clip selected the media clips to the
   * frame's shape. With NOTHING applicable selected, drop an EMPTY placeholder frame (Step 4 — the Canva
   * "drop into the frame" gesture): a media layer with `frame` set and no asset → renders a dashed
   * placeholder (never exported, since a no-asset layer resolves to no source) that the user fills by
   * dropping/picking media.
   */
  async function handleApplyFrame(def: FrameDefinition) {
    if (!composition) return;
    const target = selectedLayer;
    if (target && (target.type === "image" || target.type === "video")) {
      await updateLayer(target.id, (item) => ({ ...item, frame: makeLayerFrame(def) }));
      focusInspector();
      setNotice(`Framed with ${def.name}`);
      return;
    }
    // No clip to frame → create an empty placeholder to fill.
    const selectedTrack = target ? composition.tracks.find((item) => item.id === target.trackId) : undefined;
    const track =
      selectedTrack && selectedTrack.type !== "audio" ? selectedTrack : composition.tracks.find((item) => item.type !== "audio");
    if (!track) {
      setNotice("Add a video track first");
      return;
    }
    const base = createEditorLayer("image", track, composition, layers.length + 1, currentTimeRef.current);
    const layer: TimelineLayer = { ...base, name: `${def.name} frame`, assetId: undefined, frame: makeLayerFrame(def), fit: "cover" };
    const nextComposition: TimelineComposition = {
      ...composition,
      tracks: composition.tracks.map((item) => (item.id === track.id ? { ...item, layers: [...item.layers, layer] } : item))
    };
    setSelectedLayerIds([layer.id]);
    await updateComposition(nextComposition);
    focusInspector();
    setNotice(`Empty ${def.name} — drop media to fill`);
  }

  async function handleUploadAsset(file: File | null, options?: { source?: AssetSource; folder?: string }) {
    if (!file) {
      return;
    }

    setBusy("asset-upload");
    // File-explorer bin (2026-07-17): ANY file imports. Media gets metadata-probed as before;
    // non-media (.cube, .json, docs…) skips the probe and lands as a generic "file" asset. Files
    // whose browser-reported MIME is empty (e.g. .cube) get an extension-derived one so the bin
    // can tell them apart from legacy video records.
    const isMediaFile = /^(video|image|audio)\//.test(file.type);
    const uploadFile = file.type
      ? file
      : new File([file], file.name, { type: genericMimeFor(file.name) });
    const metadata = isMediaFile ? await readMediaMetadata(file) : {};
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : isMediaFile ? "video" : "files";
    const source = options?.source ?? "local";
    const asset = await createAsset({
      file: uploadFile,
      ...metadata,
      source,
      // Local-first: keep the bytes on-device. Nothing is auto-uploaded on import — the user pushes
      // to the cloud explicitly (Media Pool cloud toggle), or the export preflight promotes it.
      localOnly: true,
      folder: options?.folder ?? `${source === "brand" ? "brand" : "local"}/${kind}`,
      originalName: file.name,
      sizeBytes: file.size,
      // Local uploads are OWNED by this project (the "pile" fix): without this they were created
      // ownerless and leaked into every project's bin forever. Brand uploads stay user-level by
      // design — the brand kit is a cross-project library.
      ...(source !== "brand" && project?.id ? { projectId: project.id } : {})
    });
    setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
    setBusy(null);
  }

  /** Extension-derived MIME for files the browser reports with an empty type (.cube, .kimera…). */
  function genericMimeFor(fileName: string): string {
    const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
    const map: Record<string, string> = {
      cube: "application/x-cube-lut",
      json: "application/json",
      txt: "text/plain",
      srt: "application/x-subrip",
      vtt: "text/vtt"
    };
    return map[ext] ?? "application/octet-stream";
  }

  /** Add a library asset that was created elsewhere (stock import, generated, AI). */
  function registerAsset(asset: SourceAsset) {
    setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
  }

  /** True when an asset still lives only in the browser (no cloud copy recorded yet). */
  function isAssetLocalOnly(asset: SourceAsset) {
    return !asset.cloudUrl && (asset.fileUrl.startsWith("localblob:") || asset.id.startsWith("asset_local_"));
  }

  /**
   * Push one browser-local asset's bytes to the cloud and return the server asset. Prefers the
   * presigned direct-to-R2 path (streams browser → bucket in a worker: off the main thread, no API
   * RAM buffering, no double bandwidth); falls back to the multipart API upload when the backend is
   * on local-disk storage (presign unsupported). Never touches the timeline — the caller records
   * the local↔server pairing via recordAssetCloudCopy (one asset, two locations).
   */
  async function uploadAssetBytesToCloud(asset: SourceAsset): Promise<SourceAsset> {
    const response = await fetch(asset.fileUrl, { cache: "no-store" });
    const blob = await response.blob();
    const contentType = asset.fileType || blob.type || "application/octet-stream";
    const meta = {
      fileName: asset.fileName,
      fileType: contentType,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height,
      source: asset.source ?? "local",
      folder: asset.folder,
      originalName: asset.originalName ?? asset.fileName,
      sizeBytes: blob.size,
      // Preserve ownership: a project-owned local asset stays owned by that project on the server
      // (keeps the bin scoping identical). Library assets (no owner) stay user-level.
      ...(asset.ownerProjectId ? { projectId: asset.ownerProjectId } : {})
    };

    const presigned = await presignAssetUpload(meta);
    if (presigned) {
      try {
        await putBlobToCloud(presigned.uploadUrl, blob, contentType);
      } catch (error) {
        // The row was created before the PUT; drop it so a failed upload leaves no orphan asset.
        await deleteAsset(presigned.asset.id).catch(() => {});
        throw error;
      }
      return presigned.asset;
    }

    // Local-disk backend: no presign. Buffer through the API as before.
    const file = new File([blob], asset.fileName, { type: contentType });
    return createAsset({ file, ...meta });
  }

  /**
   * Record that a local asset now has a cloud copy — ONE asset, two locations. The LOCAL id stays
   * on the timeline (playback keeps reading on-device bytes; local-first is never violated) and the
   * bin keeps ONE tile, now showing the synced state. listAssets hides the paired server asset, and
   * export (ensureExportReady) remaps local→server ids from this same registry without re-uploading.
   */
  function recordAssetCloudCopy(local: SourceAsset, serverAsset: SourceAsset): SourceAsset {
    markLocalAssetPromoted(local.id, serverAsset.id, serverAsset.fileUrl);
    void updateLocalAssetRecord(local.id, { cloudUrl: serverAsset.fileUrl });
    return { ...local, cloudUrl: serverAsset.fileUrl };
  }

  /** Remap every timeline clip + the project's source asset from `fromId` → `toId`. */
  function remapGraphAssetId(fromId: string, toId: string) {
    if (!composition || !graph || fromId === toId) return null;
    const nextTracks = composition.tracks.map((track) => ({
      ...track,
      layers: track.layers.map((layer) => (layer.assetId === fromId ? { ...layer, assetId: toId } : layer))
    }));
    return {
      ...graph,
      sourceAssetId: graph.sourceAssetId === fromId ? toId : graph.sourceAssetId,
      composition: { ...composition, tracks: nextTracks },
      version: graph.version + 1
    };
  }

  async function handleUploadAssetToCloud(asset: SourceAsset) {
    if (!pro) {
      setNotice("Turn on the ✨ toggle in the header to upload media to the cloud");
      return;
    }
    setBusy(`asset-cloud-${asset.id}`);
    try {
      const serverAsset = await uploadAssetBytesToCloud(asset);
      // NO timeline remap and NO second bin entry: the local id + on-device playback stay exactly
      // as they are; the cloud copy is only recorded (see recordAssetCloudCopy).
      const synced = recordAssetCloudCopy(asset, serverAsset);
      setAssets((current) => current.map((item) => (item.id === asset.id ? { ...item, cloudUrl: synced.cloudUrl } : item)));
      setNotice("Uploaded to cloud");
    } catch {
      setNotice("Cloud upload failed");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Sync ALL browser-local assets to the cloud in one action (the media-pool header chip).
   * Uploads run sequentially (bandwidth-friendly, predictable memory). Each success only RECORDS
   * the cloud pairing — the timeline is never touched, so a failed batch can't corrupt a project.
   */
  async function handleSyncAllToCloud() {
    if (!pro) {
      setNotice("Turn on the ✨ toggle in the header to upload media to the cloud");
      return;
    }
    const pending = assets.filter(isAssetLocalOnly);
    if (pending.length === 0) {
      setNotice("Everything's already in the cloud");
      return;
    }
    setBusy("assets-cloud-sync-all");
    let synced = 0;
    let failures = 0;
    try {
      for (const asset of pending) {
        try {
          const serverAsset = await uploadAssetBytesToCloud(asset);
          const updated = recordAssetCloudCopy(asset, serverAsset);
          setAssets((current) => current.map((item) => (item.id === asset.id ? { ...item, cloudUrl: updated.cloudUrl } : item)));
          synced += 1;
        } catch {
          failures += 1;
        }
      }

      if (failures === 0) setNotice(`Synced ${synced} to the cloud`);
      else if (synced === 0) setNotice("Cloud sync failed");
      else setNotice(`Synced ${synced}, ${failures} failed`);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Remove an asset's cloud copy (the inverse of "upload to cloud").
   *
   * Synced LOCAL asset (the normal case): the bytes are already on this device and the timeline
   * still uses the local id, so removal is trivially safe — delete the paired server row + R2
   * object and forget the pairing. A later export simply re-uploads on demand.
   *
   * Pure SERVER asset (stock/AI/legacy uploads with no local bytes): pull the bytes back to the
   * device FIRST (re-import as a local asset + remap the timeline), and only then delete the cloud
   * copy. If the pull-back fails we abort WITHOUT deleting — media is never destroyed.
   */
  async function handleRemoveAssetFromCloud(asset: SourceAsset) {
    if (asset.id.startsWith("asset_local_")) {
      const serverId = getRecordedServerAssetId(asset.id);
      setBusy(`asset-cloud-del-${asset.id}`);
      try {
        if (serverId) {
          // Graphs saved by the old remap-era flow (or export promotion) may reference the SERVER
          // id — point them back at the local id before its cloud copy disappears.
          const healed = remapGraphAssetId(serverId, asset.id);
          if (healed) await updateGraph(healed);
          await deleteAsset(serverId).catch(() => {});
        }
        clearLocalAssetPromotion(asset.id);
        await updateLocalAssetRecord(asset.id, { cloudUrl: undefined });
        setAssets((current) =>
          current.map((item) => {
            if (item.id !== asset.id) return item;
            const { cloudUrl: _dropped, ...rest } = item;
            return rest as SourceAsset;
          })
        );
        setNotice("Removed from cloud — kept on this device");
      } finally {
        setBusy(null);
      }
      return;
    }

    // Warn if the cloud copy is shared: pulling it local serves THIS project, but clips in any
    // OTHER project pointing at the same server file lose their media source.
    const othersUsing = countLocalProjectsUsingAsset(asset.id, project?.id);
    if (othersUsing > 0) {
      const confirmed = window.confirm(
        `This media is also used in ${othersUsing} other project${othersUsing === 1 ? "" : "s"}. ` +
          `Removing it from the cloud keeps a copy in this project, but ${othersUsing === 1 ? "that project's" : "those projects'"} ` +
          `clips will break (they can no longer reach the cloud file). Continue?`
      );
      if (!confirmed) return;
    }
    setBusy(`asset-cloud-del-${asset.id}`);
    try {
      const response = await fetch(asset.fileUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not read the cloud copy");
      const blob = await response.blob();
      const contentType = asset.fileType || blob.type || "application/octet-stream";
      const file = new File([blob], asset.fileName, { type: contentType });
      const localAsset = await createAsset({
        file,
        localOnly: true,
        fileName: asset.fileName,
        fileType: contentType,
        durationSeconds: asset.durationSeconds,
        width: asset.width,
        height: asset.height,
        source: asset.source ?? "local",
        folder: asset.folder,
        originalName: asset.originalName ?? asset.fileName,
        sizeBytes: blob.size,
        ...(asset.ownerProjectId ? { projectId: asset.ownerProjectId } : {})
      });
      const nextGraph = remapGraphAssetId(asset.id, localAsset.id);
      if (nextGraph) await updateGraph(nextGraph);
      // Bytes are safely on-device + timeline remapped → now delete the cloud copy (DB row + R2 object).
      await deleteAsset(asset.id).catch(() => {});
      setAssets((current) => [localAsset, ...current.filter((item) => item.id !== asset.id && item.id !== localAsset.id)]);
      setNotice("Removed from cloud — kept on this device");
    } catch {
      setNotice("Couldn't remove from cloud — media left untouched");
    } finally {
      setBusy(null);
    }
  }

  /**
   * "Refresh from cloud" (plans/media-cloud-architecture.md M2, corruption repair): re-download the
   * asset's bytes from its cloud/provider copy and replace the on-device blob under the SAME id.
   * Fetch-verify-then-write — a failed/mismatched download leaves existing local bytes untouched.
   */
  async function handleRefreshAssetFromCloud(asset: SourceAsset) {
    setBusy(`asset-cloud-refresh-${asset.id}`);
    try {
      await refreshAssetFromCloud(asset, project?.userId);
      // Re-resolve so this session reads the fresh bytes (the store invalidated the object URL).
      if (project?.id) {
        const refreshed = await listProjectAssets(project.id).catch(() => null);
        if (refreshed) setAssets(refreshed.map((item) => (item.proxyUrl?.startsWith("blob:") ? { ...item, proxyUrl: undefined } : item)));
      }
      setNotice("Refreshed from cloud — local copy replaced");
    } catch (error) {
      setNotice(error instanceof Error ? `Refresh failed: ${error.message} — local copy untouched` : "Refresh failed — local copy untouched");
    } finally {
      setBusy(null);
    }
  }

  /**
   * "Pin offline" (stock URL-first, M3): a provider-referenced stock asset streams from the
   * provider's CDN — pinning downloads those bytes into the on-device cache (media-pull overlay)
   * so the asset keeps working offline / if the provider URL dies. No server upload involved.
   */
  async function handlePinAssetOffline(asset: SourceAsset) {
    setBusy(`asset-pin-${asset.id}`);
    try {
      await refreshAssetFromCloud(asset, project?.userId);
      // Re-resolve so THIS session already plays the on-device copy (overlayPulledAssetUrls).
      if (project?.id) {
        const refreshed = await listProjectAssets(project.id).catch(() => null);
        if (refreshed) setAssets(refreshed.map((item) => (item.proxyUrl?.startsWith("blob:") ? { ...item, proxyUrl: undefined } : item)));
      }
      setNotice("Saved on this device — plays locally from now on");
    } catch (error) {
      setNotice(error instanceof Error ? `Couldn't save locally: ${error.message} — still streams from the provider` : "Couldn't save locally — still streams from the provider");
    } finally {
      setBusy(null);
    }
  }

  /** Persist the bin's user-created folder list into the project media manifest (M0) — travels
   *  with the project through the normal graph save/sync path, never a global key. */
  function handleChangeCustomFolders(next: string[]) {
    if (!graph) return;
    const current = graph.mediaManifest?.customFolders ?? [];
    if (next.length === current.length && next.every((item, i) => current[i] === item)) return;
    void updateGraph(
      { ...graph, mediaManifest: { version: 1 as const, customFolders: next }, version: graph.version + 1 },
      undefined,
      { recordHistory: false }
    );
  }

  /**
   * Capture the selected video clip's current frame as a reusable image asset
   * (timeline-generated → appears in the AI/Generated tab and is draggable like any clip).
   */
  async function handleSaveFreezeFrame() {
    const layer = selectedLayer;
    if (!layer || layer.type !== "video" || !layer.assetId) {
      setNotice("Select a video clip to capture a freeze frame");
      return;
    }
    const asset = assets.find((item) => item.id === layer.assetId);
    // Freeze frames capture from the ORIGINAL bytes — a 480p ingest proxy would bake a soft still.
    const url = asset?.fileUrl ?? asset?.previewUrl ?? asset?.proxyUrl;
    if (!asset || !url) {
      setNotice("Could not read the clip's frame");
      return;
    }
    setBusy("freeze-frame");
    try {
      const sourceSeconds = (layer.sourceInSeconds ?? 0) + Math.max(0, currentTimeRef.current - layer.startSeconds);
      const dataUrl = await getVideoPoster(url, sourceSeconds);
      if (!dataUrl) {
        setNotice("Could not read the clip's frame");
        return;
      }
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `freeze-${Math.round(sourceSeconds * 100) / 100}s.jpg`, { type: "image/jpeg" });
      const frameAsset = await createAsset({
        file,
        fileType: "image/jpeg",
        durationSeconds: 5,
        width: asset.width,
        height: asset.height,
        source: "timeline-generated",
        folder: "generated/freeze-frame",
        originalName: `Freeze · ${asset.originalName ?? asset.fileName}`
      });
      registerAsset(frameAsset);
      setNotice("Freeze frame saved to library");
    } catch {
      setNotice("Freeze frame failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteAsset(asset: SourceAsset) {
    setBusy(`asset-delete-${asset.id}`);
    setAssets((current) => current.filter((item) => item.id !== asset.id));

    if (composition && graph) {
      const nextTracks = composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.filter((layer) => layer.assetId !== asset.id)
      }));
      const nextLayer = nextTracks.flatMap((track) => track.layers)[0];
      if (selectedLayer?.assetId === asset.id) {
        setSelectedLayerIds(nextLayer?.id ? [nextLayer.id] : []);
      }
      await updateGraph({
        ...graph,
        sourceAssetId: graph.sourceAssetId === asset.id ? undefined : graph.sourceAssetId,
        composition: {
          ...composition,
          tracks: nextTracks
        },
        version: graph.version + 1
      });
    }

    await deleteAsset(asset.id);
    setProject((current) =>
      current?.sourceAssetId === asset.id
        ? {
            ...current,
            sourceAssetId: null,
            sourceAsset: null
          }
        : current
    );
    setBusy(null);
  }

  async function handleMoveAssetFolder(asset: SourceAsset, folder: string | null) {
    const normalizedFolder = normalizeAssetFolder(folder);
    const nextFolder = normalizedFolder || undefined;
    if ((asset.folder ?? undefined) === nextFolder) return;

    setAssets((current) => current.map((item) => (item.id === asset.id ? { ...item, folder: nextFolder } : item)));
    try {
      const updated = await updateAssetFolder(asset.id, normalizedFolder || null);
      setAssets((current) => current.map((item) => (item.id === asset.id ? { ...item, ...updated, folder: updated.folder } : item)));
    } catch {
      setAssets((current) => current.map((item) => (item.id === asset.id ? asset : item)));
      setNotice("Could not move asset");
    }
  }

  async function handleSetAssetLabel(asset: SourceAsset, label: string | null) {
    const nextTags = tagsWithAssetLabel(asset.tags, label);
    setAssets((current) => current.map((item) => (item.id === asset.id ? { ...item, tags: nextTags } : item)));
    try {
      const updated = await updateAssetTags(asset.id, nextTags);
      setAssets((current) => current.map((item) => (item.id === asset.id ? { ...item, ...updated, tags: updated.tags } : item)));
    } catch {
      setAssets((current) => current.map((item) => (item.id === asset.id ? asset : item)));
      setNotice("Could not set label");
    }
  }

  async function handleAssignAsset(asset: SourceAsset) {
    if (!composition || !selectedLayer || (selectedLayer.type !== "video" && selectedLayer.type !== "image")) {
      return;
    }

    const nextType: TimelineLayerType = asset.fileType.startsWith("image/") ? "image" : "video";
    const nextDuration = asset.fileType.startsWith("image/") ? selectedLayer.durationSeconds : Math.max(0.2, asset.durationSeconds);
    const nextTracks = composition.tracks.map((track) => ({
      ...track,
      layers: track.layers.map((layer) =>
        layer.id === selectedLayer.id
          ? {
              ...layer,
              type: nextType,
              assetId: asset.id,
              name: asset.fileName,
              durationSeconds: nextDuration,
              fit: layer.fit ?? "cover"
            }
          : layer
      )
    }));
    await updateComposition(
      addCompanionAudioLayer(
        { ...composition, tracks: nextTracks },
        asset,
        { id: selectedLayer.id, startSeconds: selectedLayer.startSeconds, durationSeconds: nextDuration },
        layers.length + 1
      )
    );
  }

  async function handleAddAssetToTimeline(asset: SourceAsset, mode: AssetAddMode = "auto") {
    if (!composition) {
      return;
    }
    // Generic (non-media) file assets live in the bin only — nothing sensible to place on a track.
    if (asset.fileType && !/^(video|image|audio)\//.test(asset.fileType)) {
      setNotice("This file type can't be placed on the timeline");
      return;
    }
    if (mode === "audio" && asset.fileType.startsWith("video/") && assetHasAudioStream(asset) === false) {
      setNotice("No audio stream found in this asset");
      return;
    }

    const trackId = findCompatibleTrackId(composition, asset, mode);
    if (!trackId) {
      setNotice("No compatible track");
      return;
    }

    // Record project membership for a reusable library asset (brand/ai/stock) pulled into this project, so it
    // persists in the project-scoped bin. Owned uploads are already linked at create time. Best-effort.
    if (project?.id && asset.ownerProjectId !== project.id) {
      void linkAssetToProject(asset.id, project.id);
    }

    // Pass the asset object through: a just-imported asset (e.g. a graphic) may not be in `resolvedAssets`
    // state yet on this tick, so the id-lookup in handleDropAsset would miss it.
    await handleDropAsset(asset.id, trackId, currentTimeRef.current, undefined, mode, undefined, asset);
  }

  async function handleDropAsset(
    assetId: string,
    trackId: string,
    startSeconds: number,
    replaceLayerId?: string | undefined,
    mode: AssetAddMode = "auto",
    sourceDrag?: SourceDragPayload | undefined,
    assetOverride?: SourceAsset | undefined
  ) {
    if (!composition) {
      return;
    }

    const asset = assetOverride ?? resolvedAssets.find((item) => item.id === assetId);
    const track = composition.tracks.find((item) => item.id === trackId);
    if (!asset || !track) {
      return;
    }
    // Generic (non-media) file assets live in the bin only (file-explorer bin, 2026-07-17).
    if (asset.fileType && !/^(video|image|audio)\//.test(asset.fileType)) {
      setNotice("This file type can't be placed on the timeline");
      return;
    }

    const dragSourceIn = sourceDrag && sourceDrag.sourceInSeconds > 0.001 ? sourceDrag.sourceInSeconds : undefined;
    const dragDuration = sourceDrag ? Math.max(0.05, sourceDrag.durationSeconds) : undefined;
    // A source-monitor drag always carries its OWN mode (dragging the "V" chip is video-only
    // regardless of the monitor's currently-selected radio) — it overrides the caller's default.
    mode = sourceDrag?.mode ?? mode;

    const assetLayerType: TimelineLayerType = mode === "audio"
      ? "audio"
      : asset.fileType.startsWith("audio/")
      ? "audio"
      : asset.fileType.startsWith("image/")
        ? "image"
        : "video";
    const addCompanionAudio = shouldCreateCompanionAudio(asset, mode);
    const isAudioAsset = assetLayerType === "audio";
    if (isAudioAsset !== (track.type === "audio")) {
      return;
    }
    if (mode === "audio" && asset.fileType.startsWith("video/") && assetHasAudioStream(asset) === false) {
      setNotice("No audio stream found in this asset");
      return;
    }

    if (replaceLayerId) {
      const replacedLayer = layers.find((layer) => layer.id === replaceLayerId);
      const nextDuration = dragDuration ?? replacedLayer?.durationSeconds ?? Math.max(0.2, asset.durationSeconds);
      const nextTracks = composition.tracks.map((item) => ({
        ...item,
        layers: item.layers.map((layer) =>
          layer.id === replaceLayerId
            ? {
                ...layer,
                type: assetLayerType,
                assetId: asset.id,
                name: asset.fileName,
                durationSeconds: nextDuration,
                // A swapped-in asset must not inherit the previous clip's source in-point —
                // reset to play from its start, unless a source-monitor drag marked a range.
                sourceInSeconds: dragSourceIn,
                // Filling a FRAME auto-fits to `cover` so the media fills the whole shape with no gaps
                // (Step 4). `cover` fills the comp, and the frame box ⊆ comp, so the shape is fully
                // covered; the user then pans/zooms inside via content mode. Non-framed clips keep their
                // existing fit (or the media default).
                fit:
                  assetLayerType === "image" || assetLayerType === "video"
                    ? layer.frame
                      ? "cover"
                      : (layer.fit ?? defaultMediaFit(assetLayerType))
                    : undefined
              }
            : layer
        )
      }));
      await updateComposition({ ...composition, tracks: nextTracks });
      setSelectedLayerIds(expandLayerSelection([replaceLayerId]));
      return;
    }

    const layer = createEditorLayer(assetLayerType, track, composition, layers.length + 1);
    const nextLayer: TimelineLayer = {
      ...layer,
      assetId: asset.id,
      name: asset.fileName,
      startSeconds,
      durationSeconds:
        assetLayerType === "image"
          ? 3
          : dragDuration ?? Math.max(0.2, asset.durationSeconds),
      sourceInSeconds: dragSourceIn,
      fit: assetLayerType === "image" || assetLayerType === "video" ? defaultMediaFit(assetLayerType) : undefined
    };

    const compositionWithLayer = {
      ...composition,
      tracks: composition.tracks.map((item) =>
        item.id === track.id
          ? {
              ...item,
              layers: [...item.layers, nextLayer]
            }
          : item
      )
    };
    const nextComposition =
      addCompanionAudio && assetLayerType === "video"
        ? addCompanionAudioLayer(compositionWithLayer, asset, nextLayer, layers.length + 2, dragSourceIn)
        : compositionWithLayer;

    setSelectedLayerIds(expandLayerSelection([nextLayer.id]));
    await updateComposition(nextComposition);
  }

  // Source monitor (3-point editing) — see components/SourceMonitor.tsx.
  function handleOpenInSourceMonitor(asset: SourceAsset) {
    setSourceMonitorAsset(asset);
    setSourceInSeconds(null);
    setSourceOutSeconds(null);
    setActiveMonitor("source");
  }

  function handleCloseSourceMonitor() {
    setSourceMonitorAsset(null);
    setSourceInSeconds(null);
    setSourceOutSeconds(null);
    setActiveMonitor("program");
  }

  async function handleSourceMonitorEdit(op: ThreePointOp, srcIn: number, srcOut: number, mode: AssetAddMode = "auto") {
    if (!composition || !sourceMonitorAsset) {
      return;
    }
    const asset = sourceMonitorAsset;
    if (mode === "audio" && asset.fileType.startsWith("video/") && assetHasAudioStream(asset) === false) {
      setNotice("No audio stream found in this asset");
      return;
    }

    const trackId = findCompatibleTrackId(composition, asset, mode);
    const track = composition.tracks.find((item) => item.id === trackId);
    if (!trackId || !track) {
      setNotice("No compatible track");
      return;
    }

    const duration = Math.max(0.05, Number((srcOut - srcIn).toFixed(3)));
    const startSeconds = Number((getCompositionSettings(composition).timeline.inPointSeconds ?? currentTimeRef.current).toFixed(3));
    const assetLayerType: TimelineLayerType = mode === "audio"
      ? "audio"
      : asset.fileType.startsWith("audio/")
      ? "audio"
      : asset.fileType.startsWith("image/")
        ? "image"
        : "video";
    const addCompanionAudio = shouldCreateCompanionAudio(asset, mode);
    const audioTrack = addCompanionAudio && assetLayerType === "video" ? composition.tracks.find((item) => item.type === "audio") : undefined;

    const baseLayer = createEditorLayer(assetLayerType, track, composition, layers.length + 1);
    const linkedGroupId = audioTrack ? `link_${asset.id}_${baseLayer.id}` : undefined;
    const nextLayer: TimelineLayer = {
      ...baseLayer,
      assetId: asset.id,
      name: asset.fileName,
      startSeconds,
      durationSeconds: duration,
      sourceInSeconds: srcIn > 0.001 ? Number(srcIn.toFixed(3)) : undefined,
      fit: assetLayerType === "image" || assetLayerType === "video" ? defaultMediaFit(assetLayerType) : undefined,
      linkedGroupId
    };

    const edits: ThreePointEditRequest[] = [{ trackId: track.id, layer: nextLayer }];
    if (audioTrack) {
      const audioBase = createEditorLayer("audio", audioTrack, composition, layers.length + 2);
      const companionLayer: TimelineLayer = {
        ...audioBase,
        id: `${nextLayer.id}_audio`,
        assetId: asset.id,
        linkedGroupId,
        name: `${asset.fileName} audio`,
        startSeconds: nextLayer.startSeconds,
        durationSeconds: nextLayer.durationSeconds,
        sourceInSeconds: nextLayer.sourceInSeconds
      };
      edits.push({ trackId: audioTrack.id, layer: companionLayer });
    }

    const nextComposition = applyThreePointEdit(composition, edits, op);
    setSelectedLayerIds(expandLayerSelection([nextLayer.id]));
    await updateComposition(nextComposition);
    setNotice(op === "insert" ? "Inserted at playhead" : "Overwrote at playhead");
  }

  async function handleAddTrack(type: TimelineTrack["type"]) {
    if (!composition) {
      return;
    }

    const id = `track_${Date.now()}_${type}`;
    const sameTypeCount = composition.tracks.filter((track) => track.type === type).length + 1;
    const track: TimelineTrack = {
      id,
      type,
      name: `${type === "audio" ? "Audio" : "Video"} ${sameTypeCount}`,
      layers: []
    };
    const visualTrack = type !== "audio";
    const nextComposition: TimelineComposition = {
      ...composition,
      tracks: visualTrack ? [track, ...composition.tracks] : [...composition.tracks, track]
    };
    await updateComposition(nextComposition);
  }

  async function handleRemoveEffect(effectId: string) {
    if (!project || !graph) {
      return;
    }
    await updateGraph({
      ...graph,
      effects: graph.effects.filter((effect) => effect.id !== effectId),
      version: graph.version + 1
    });
  }

  function handleAddTimelineEffect(type: TimelineEffect["type"]) {
    if (selectedLayerIds.length > 1) {
      // Multiselect: add to every selected clip, each with its own fresh effect id (createTimelineEffect's
      // Date.now()-based id can collide when called repeatedly in the same tick — mint per-layer here).
      void updateLayers(selectedLayerIds, (layer) => ({
        ...layer,
        effects: [...layer.effects, { ...createTimelineEffect(type), id: `effect_${type}_${layer.id}_${Math.random().toString(36).slice(2, 8)}` }]
      }));
      focusInspector();
      setNotice(`Effect added to ${selectedLayerIds.length} clips`);
      return;
    }
    if (!selectedLayer) {
      setNotice("Select a timeline element first");
      focusInspector();
      return;
    }

    void updateLayer(selectedLayer.id, (layer) => ({
      ...layer,
      effects: [...layer.effects, createTimelineEffect(type)]
    }));
    focusInspector();
    setNotice("Effect added");
  }

  function handleApplyEffectManifest(manifest: PluginEffectManifest) {
    if (!selectedLayer || !composition) {
      setNotice("Select a timeline element first");
      focusInspector();
      return;
    }
    if (!canApplyEffectManifestToLayer(manifest, selectedLayer.type)) {
      setNotice("Effect is not compatible with this layer");
      return;
    }

    const effect = createTimelineEffectFromManifest(manifest);
    const nextComposition = updateTimelineLayer(composition, selectedLayer.id, (layer) => ({
      ...layer,
      effects: [...layer.effects, effect]
    }));
    void updateComposition(nextComposition, { plugins: projectPluginLibraryWithEffectManifest(manifest) });
    focusInspector();
    setNotice(`${effect.name} added`);
  }

  /** Apply an animation preset (Pop In, Typewriter, …) from the Effects catalog. */
  function lookEffect(lookName: string): TimelineEffect {
    return {
      ...createTimelineEffect("creativeLook"),
      params: { look: lookName, intensity: 100 }
    };
  }

  function applyLookToLayer(layer: TimelineLayer, lookName: string): TimelineLayer {
    const existing = layer.effects.find((effect) => effect.type === "creativeLook");
    if (!existing) {
      return { ...layer, effects: [...layer.effects, lookEffect(lookName)] };
    }
    return {
      ...layer,
      effects: layer.effects.map((effect) =>
        effect.id === existing.id
          ? {
              ...effect,
              enabled: true,
              intensity: 100,
              params: { ...(effect.params ?? {}), look: lookName, intensity: 100 }
            }
          : effect
      )
    };
  }

  function handleApplyLook(lookName: string, mode: "clip" | "adjustment", manifest?: PluginLookManifest | undefined) {
    if (mode === "clip") {
      if (!selectedLayer || !composition) {
        setNotice("Select a timeline element first");
        focusInspector();
        return;
      }
      if (selectedLayer.type === "audio") {
        setNotice("Looks need a visual layer");
        return;
      }
      const nextComposition = updateTimelineLayer(composition, selectedLayer.id, (layer) => applyLookToLayer(layer, lookName));
      void updateComposition(nextComposition, manifest ? { plugins: projectPluginLibraryWithLookManifest(manifest) } : {});
      focusInspector();
      setNotice("Look applied");
      return;
    }

    if (!composition) {
      return;
    }
    const selectedTrack = selectedLayer ? composition.tracks.find((item) => item.id === selectedLayer.trackId) : undefined;
    const track =
      selectedTrack && selectedTrack.type !== "audio"
        ? selectedTrack
        : composition.tracks.find((item) => item.type !== "audio");
    if (!track) {
      setNotice("Add a visual track first");
      return;
    }
    const layer = applyLookToLayer(createEditorLayer("adjustment", track, composition, layers.length + 1, currentTimeRef.current), lookName);
    setSelectedLayerIds([layer.id]);
    void updateComposition(
      {
        ...composition,
        tracks: composition.tracks.map((item) => (item.id === track.id ? { ...item, layers: [...item.layers, layer] } : item))
      },
      manifest ? { plugins: projectPluginLibraryWithLookManifest(manifest) } : {}
    );
    focusInspector();
    setNotice("Adjustment look added");
  }

  function handleApplyPreset(presetId: string) {
    if (!selectedLayer) {
      setNotice("Select a timeline element first");
      focusInspector();
      return;
    }
    void updateLayer(selectedLayer.id, (layer) => applyAnimationPreset(layer, presetId as AnimationPresetId));
    focusInspector();
    setNotice("Animation added");
  }

  // Slip two-up media resolver (see SlipTwoUpOverlay): reads through refs so it can't go stale
  // mid-drag; only video clips with a playable asset URL get the overlay.
  const resolveSlipPreviewMedia = useCallback(
    (layerId: string): { url: string; durationSourceSeconds: number } | null => {
      const comp = compositionRef.current;
      const layer = comp ? flattenTimelineLayers(comp).find((item) => item.id === layerId) : undefined;
      if (!layer || layer.type !== "video" || !layer.assetId) return null;
      const asset = assets.find((item) => item.id === layer.assetId);
      // Proxy first: the ingest proxy is small with dense keyframes, so its seeks land in tens of
      // ms — seeking the full-res original is what made the two-up feel seconds behind the drag.
      const url = asset?.proxyUrl ?? asset?.previewUrl ?? asset?.fileUrl;
      if (!url) return null;
      return { url, durationSourceSeconds: layer.durationSeconds * Math.abs(getLayerSpeed(layer)) };
    },
    [assets]
  );

  /** Visual clips (video/image/text/shape) the playhead is currently over — transition targets. */
  function clipsUnderPlayhead(): TimelineLayer[] {
    if (!composition) {
      return [];
    }
    // Ref, not state: called from event handlers, and state can lag a fresh seek by the cold-commit
    // window — targeting transitions at the clip the user just scrubbed AWAY from would be wrong.
    const playheadSeconds = currentTimeRef.current;
    return flattenTimelineLayers(composition).filter(
      (layer) =>
        (layer.type === "video" || layer.type === "image" || layer.type === "text" || layer.type === "shape") &&
        !layer.muted &&
        !layer.disabled &&
        playheadSeconds >= layer.startSeconds &&
        playheadSeconds <= layer.startSeconds + layer.durationSeconds
    );
  }

  /**
   * Add a transition from the Effects catalog/gallery. Target resolution: the selected clip if one is
   * selected; otherwise the clip under the playhead; if several clips are under the playhead, ask which.
   * Junction transitions apply to a cut: selected clip's right edge first, else its left edge.
   */
  function handleAddTransition(spec: TransitionApplySpec) {
    if (selectedLayer) {
      applyTransitionToClip(selectedLayer.id, spec);
      return;
    }
    const candidates = clipsUnderPlayhead();
    if (candidates.length === 0) {
      setNotice("Select a clip or move the playhead over one");
      return;
    }
    if (candidates.length === 1) {
      applyTransitionToClip(candidates[0]!.id, spec);
      return;
    }
    // Ambiguous — let the user pick which clip gets the transition.
    setTransitionChoice({ spec, candidates });
  }

  /**
   * Apply a transition to a specific clip. Per-clip edge fades (fadeIn/fadeOut) write opacity keyframes
   * on the clip; every junction kind applies at a cut. If both sides are possible, prefer this clip's
   * right edge (between this clip and the next clip), matching the timeline right-click menu.
   */
  function applyTransitionToClip(clipId: string, spec: TransitionApplySpec) {
    if (!composition) {
      return;
    }
    if (spec.kind === "fadeIn" || spec.kind === "fadeOut") {
      const nextComposition = updateTimelineLayer(composition, clipId, (layer) => ({
        ...layer,
        animations: buildTransitionKeyframes(layer, spec.kind as "fadeIn" | "fadeOut")
      }));
      void updateComposition(nextComposition, spec.manifest ? { plugins: projectPluginLibraryWithTransitionManifest(spec.manifest) } : {});
      setNotice("Transition added");
      return;
    }
    const target = findTransitionCutForClip(composition, clipId);
    if (!target) {
      setNotice("Transitions need a cut between two touching clips");
      return;
    }
    const fullSpec: TransitionSpec = {
      kind: spec.kind,
      durationSeconds: getTransition(spec.kind)?.defaultDurationSeconds ?? DEFAULT_CROSS_DISSOLVE_SECONDS,
      direction: spec.direction,
      mode: spec.mode,
      color: spec.color,
      params: spec.params
    };
    void updateComposition(
      applyJunctionTransition(composition, target.left.id, target.right.id, fullSpec),
      spec.manifest ? { plugins: projectPluginLibraryWithTransitionManifest(spec.manifest) } : {}
    );
    setNotice(target.side === "right" ? "Transition added to right cut" : "Transition added to left cut");
  }

  /**
   * Resize (or create, via the clip corner fade handles) a fade band on the timeline — rewrites
   * just that direction's `_transition_` keyframes. VISUAL clips fade opacity; AUDIO clips fade
   * the volume effect's gain (opacity is inaudible) using the SAME marker-id convention, so the
   * band rendering, drag-resize, and double-click-remove all work identically — and the fade
   * shows up as editable points on the clip's volume rubber band.
   */
  function handleSetTransition(layerId: string, kind: TransitionKind, durationSeconds: number) {
    if (kind !== "fadeIn" && kind !== "fadeOut" && kind !== "crossDissolve") {
      return;
    }
    // Sub-frame duration = no fade: a corner-handle click without a drag stays a no-op, and
    // dragging an existing band back to the clip edge removes it (same as double-click).
    if (durationSeconds < 0.02 && (kind === "fadeIn" || kind === "fadeOut")) {
      // TransitionKind is an open union (plugin kinds), so the equality checks don't narrow it.
      handleRemoveTransition(layerId, kind as "fadeIn" | "fadeOut");
      return;
    }
    void updateLayer(layerId, (layer) => {
      if (layer.type !== "audio") {
        return { ...layer, animations: buildTransitionKeyframes(layer, kind as "fadeIn" | "fadeOut" | "crossDissolve", durationSeconds) };
      }
      // Audio fade: gain envelope on the volume effect, marker-tagged like the opacity fades.
      const side = kind === "fadeOut" ? "out" : "in";
      const existing = layer.effects.find((effect) => effect.type === "volume");
      const effect = existing ?? createTimelineEffect("volume");
      const base = Math.max(0, Number((effect.params?.gain as number | undefined) ?? 100));
      // A fade may span up to the whole clip minus the opposing fade (fadeIn + fadeOut ≤ duration),
      // matching the visual-clip rule in buildTransitionKeyframes — no half-duration cap.
      const existingAnimations = layer.animations ?? [];
      const opposingKey =
        side === "in"
          ? existingAnimations.find((kf) => kf.id.includes(`${TRANSITION_MARKER}out_0`))
          : existingAnimations.find((kf) => kf.id.includes(`${TRANSITION_MARKER}in_1`));
      const opposingFade = opposingKey
        ? side === "in"
          ? Math.max(0, layer.durationSeconds - opposingKey.timeSeconds)
          : Math.max(0, opposingKey.timeSeconds)
        : 0;
      const fade = Math.min(durationSeconds, Math.max(0, layer.durationSeconds - opposingFade));
      const end = layer.durationSeconds;
      const gainKey = (suffix: string, timeSeconds: number, value: number): TimelineKeyframeV2 => ({
        id: `${layer.id}${TRANSITION_MARKER}${suffix}`,
        target: { scope: "effect", effectId: effect.id, property: "gain" },
        timeSeconds: Math.max(0, timeSeconds),
        value,
        interpolation: "easeInOut",
        temporal: {}
      });
      const fresh =
        side === "in"
          ? [gainKey("in_0", 0, 0), gainKey("in_1", fade, base)]
          : [gainKey("out_0", end - fade, base), gainKey("out_1", end, 0)];
      const marker = `${TRANSITION_MARKER}${side}`;
      return {
        ...layer,
        effects: existing ? layer.effects : [...layer.effects, effect],
        animations: [...(layer.animations ?? []).filter((kf) => !kf.id.includes(marker)), ...fresh]
      };
    });
  }

  /** Remove one fade direction (double-click a band) by stripping its `_transition_` keyframes. */
  function handleRemoveTransition(layerId: string, side: "fadeIn" | "fadeOut") {
    const marker = `${TRANSITION_MARKER}${side === "fadeIn" ? "in" : "out"}`;
    void updateLayer(layerId, (layer) => ({
      ...layer,
      animations: (layer.animations ?? []).filter((kf) => !kf.id.includes(marker))
    }));
  }

  /**
   * Apply (or replace) a junction transition between two touching same-track clips. `spec` carries the
   * kind + params; right-click "default transition" passes a 0.5s cross-dissolve. Drag-from-the-browser
   * passes the dropped kind (+ its plugin `manifest` for uploaded transitions — registered in the same
   * update so `applyJunctionTransition`'s registry check sees the kind, mirroring applyTransitionToClip).
   * The same handler re-applies on a kind/param change.
   */
  function handleAddCrossDissolve(leftId: string, rightId: string, spec?: TransitionSpec, manifest?: PluginTransitionManifest) {
    if (!composition) {
      return;
    }
    const applied = spec ?? { kind: "crossDissolve" as const, durationSeconds: DEFAULT_CROSS_DISSOLVE_SECONDS };
    void updateComposition(
      applyJunctionTransition(composition, leftId, rightId, applied),
      manifest ? { plugins: projectPluginLibraryWithTransitionManifest(manifest) } : {}
    );
    setNotice("Transition added");
  }

  /** Drag the on-timeline transition element → re-apply the pair's transition at the new duration (kept kind/params). */
  function handleSetCrossDissolve(leftId: string, rightId: string, durationSeconds: number) {
    if (!composition) {
      return;
    }
    const right = flattenTimelineLayers(composition).find((layer) => layer.id === rightId);
    const spec: TransitionSpec = { ...(right?.transitionIn ?? { kind: "crossDissolve" }), durationSeconds };
    void updateComposition(applyJunctionTransition(composition, leftId, rightId, spec));
  }

  /** Double-click the transition element → strip the transition and re-separate the clips (un-ripple). */
  function handleRemoveCrossDissolve(leftId: string, rightId: string) {
    if (!composition) {
      return;
    }
    void updateComposition(removeJunctionTransition(composition, leftId, rightId));
    setNotice("Transition removed");
  }

  /**
   * Resolve-style "Trim clips to create overlap": when a junction transition would repeat frames
   * (insufficient tail material — the zebra-striped pill), shorten the outgoing clip's out-point by
   * exactly the uncovered span and ripple the cut left, so the whole window plays real media. One
   * `updateComposition` = one undo step; linked A/V companions trim/shift in sync (see
   * `trimOutgoingForTransition`).
   */
  function handleTrimForTransition(leftId: string, rightId: string) {
    if (!composition) {
      return;
    }
    const track = composition.tracks.find(
      (item) => item.layers.some((layer) => layer.id === leftId) && item.layers.some((layer) => layer.id === rightId)
    );
    const left = track?.layers.find((layer) => layer.id === leftId);
    const right = track?.layers.find((layer) => layer.id === rightId);
    if (!left || !right || !right.transitionIn) {
      return;
    }
    const sides = resolveTransitionWindowSides({
      durationSeconds: effectiveTransitionDuration(right.transitionIn.durationSeconds, right.durationSeconds),
      incoming: { type: right.type, sourceInSeconds: right.sourceInSeconds, speed: right.speed },
      outgoing: { type: left.type, sourceInSeconds: left.sourceInSeconds, speed: left.speed, durationSeconds: left.durationSeconds },
      outgoingAssetDurationSeconds: left.assetId ? assets.find((asset) => asset.id === left.assetId)?.durationSeconds : undefined,
      alignment: right.transitionIn.alignment
    });
    // T4: fix BOTH sides in one undo step. Tail shortfall → shorten the outgoing out-point + ripple
    // (unchanged). Head shortfall (only reachable with a MANUAL alignment — auto caps pre-roll by the
    // head handle) → advance the incoming clip's source in-point so real media exists before the cut.
    let next = composition;
    const doneParts: string[] = [];
    if (sides.tailRepeatedSeconds > 1 / 240) {
      const trimmed = trimOutgoingForTransition(next, leftId, rightId, sides.tailRepeatedSeconds);
      if (trimmed) {
        next = trimmed;
        doneParts.push(`trimmed ${sides.tailRepeatedSeconds.toFixed(2)}s from the outgoing clip`);
      }
    }
    if (sides.headRepeatedSeconds > 1 / 240) {
      const advanced = advanceIncomingSourceForTransition(next, rightId, sides.headRepeatedSeconds, {
        assetDurationSeconds: right.assetId ? assets.find((asset) => asset.id === right.assetId)?.durationSeconds : undefined
      });
      if (advanced) {
        next = advanced;
        doneParts.push(`advanced the incoming clip's in-point ${sides.headRepeatedSeconds.toFixed(2)}s`);
      }
    }
    if (next === composition) {
      setNotice("Transition already has enough media");
      return;
    }
    void updateComposition(next);
    setNotice(`${doneParts.join(" + ").replace(/^./, (c) => c.toUpperCase())} — transition now plays real media`);
  }

  /**
   * Add a `volume` effect (and, for a fade, a gain envelope on its `gain` param). Reuses an
   * existing volume effect on the layer so we never stack duplicates. A fade replaces any prior
   * gain envelope on that effect (in/out are alternative envelopes in this first pass).
   */
  function handleAddAudioEffect(fade?: "in" | "out" | undefined) {
    if (!selectedLayer) {
      setNotice("Select a timeline element first");
      focusInspector();
      return;
    }
    const existing = selectedLayer.effects.find((effect) => effect.type === "volume");
    const effect = existing ?? createTimelineEffect("volume");
    const effectId = effect.id;
    const end = selectedLayer.durationSeconds;
    const fadeDur = Math.min(0.6, Math.max(0.1, end / 2));
    const gainKey = (timeSeconds: number, value: number): TimelineKeyframeV2 => ({
      id: mintKeyframeId(`${effectId}_gain_${Math.round(timeSeconds * 1000)}`),
      target: { scope: "effect", effectId, property: "gain" },
      timeSeconds: Math.max(0, timeSeconds),
      value,
      interpolation: "easeInOut",
      temporal: {}
    });
    const fadeKeyframes: TimelineKeyframeV2[] =
      fade === "in"
        ? [gainKey(0, 0), gainKey(fadeDur, 100)]
        : fade === "out"
          ? [gainKey(Math.max(0, end - fadeDur), 100), gainKey(end, 0)]
          : [];

    void updateLayer(selectedLayer.id, (layer) => {
      const hasEffect = layer.effects.some((candidate) => candidate.id === effectId);
      const effects = hasEffect ? layer.effects : [...layer.effects, effect];
      const animations = fade
        ? [
            ...(layer.animations ?? []).filter(
              (kf) => !(kf.target.scope === "effect" && kf.target.effectId === effectId && kf.target.property === "gain")
            ),
            ...fadeKeyframes
          ]
        : (layer.animations ?? []);
      return { ...layer, effects, animations };
    });
    focusInspector();
    setNotice(fade ? "Audio fade added" : "Volume added");
  }

  function handleApplyLayerToolEffect(toolSlug: string) {
    if (!selectedLayer) {
      setNotice("Select a timeline element first");
      return;
    }
    const tool = getToolCapability(toolSlug);
    const asset = selectedLayer.assetId ? resolvedAssets.find((item) => item.id === selectedLayer.assetId) : undefined;
    if (!tool || !asset) {
      setNotice("Select a clip with media to apply this tool");
      return;
    }
    setActiveLayerToolEffect({ tool, layer: selectedLayer, asset });
  }

  /** Resolve a paused AI tool step (called by the tool modal's Apply/Close). */
  function resolveToolStep(result: ToolStepResult) {
    const resolve = toolStepResolverRef.current;
    if (resolve) {
      toolStepResolverRef.current = null;
      resolve(result);
    }
  }

  /**
   * AI executor entry point: open a tool modal for a `tool` plan step and return
   * a promise that resolves when the user applies or cancels. This is what makes
   * a `requiresInput` step (e.g. confirm tracking points) genuinely pause the
   * plan until the user is done.
   */
  function openToolForAi(step: PlanStep): Promise<ToolStepResult> {
    const tool = step.toolSlug ? getToolCapability(step.toolSlug) : undefined;
    if (!tool || !composition) {
      return Promise.resolve({ applied: false, detail: "Tool unavailable here" });
    }
    // Resolve which clip this edits: an explicit layerId the planner set ("clip 4"), else the
    // selected clip, else the clip under the playhead. Ambiguous/none → ask, never guess wrong.
    const explicitLayerId = (step.params as { layerId?: string } | undefined)?.layerId;
    const resolved = resolveTargetLayer(composition, {
      selection: selectedLayerIds,
      nowSeconds: currentTimeRef.current,
      explicitLayerId
    });
    if (!resolved.layerId || resolved.reason === "ambiguous" || resolved.reason === "none") {
      return Promise.resolve({
        applied: false,
        detail: "Which clip? Click a clip or move the playhead over it, then retry."
      });
    }
    const candidate = layers.find((layer) => layer.id === resolved.layerId);
    const asset = candidate?.assetId ? resolvedAssets.find((item) => item.id === candidate.assetId) : undefined;
    if (!candidate || !asset) {
      return Promise.resolve({ applied: false, detail: "That clip has no media for this tool. Select a video or image clip, then retry." });
    }
    setSelectedLayerIds([candidate.id]);
    return new Promise<ToolStepResult>((resolve) => {
      toolStepResolverRef.current = resolve;
      setActiveLayerToolEffect({ tool, layer: candidate, asset });
    });
  }

  async function preview() {
    if (!project) {
      return;
    }
    setBusy("preview");
    try {
      const updated = await generatePreview(project.id);
      setProject(updated);
      const job = updated.renderJobs?.find((item) => item.type === "preview" && (item.status === "queued" || item.status === "processing"));
      setNotice(job ? "Preview 0% - waiting to start" : "Preview ready");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Preview failed");
    } finally {
      setBusy(null);
    }
  }

  async function renderFinal() {
    if (!project) {
      return;
    }
    setBusy("export");
    setNotice("Preparing your project for export…");
    try {
      // Gate: never call the worker on a local-only project or with localblob/blob media.
      // This uploads assets, remaps ids, creates the server project and saves the graph.
      const { projectId: serverId } = await ensureExportReady(project.id);

      // Adopt the server id if the project was promoted.
      if (serverId !== project.id) {
        const promoted = await getProject(serverId);
        setProject(promoted);
        try {
          const newPath = window.location.pathname.replace(project.id, serverId);
          window.history.replaceState(window.history.state, "", newPath);
        } catch {
          /* route swap is best-effort */
        }
      }

      setRelinkNeeds(null);
      const updated = await exportFinal(serverId);
      setProject(updated);
      const job = updated.renderJobs?.find((item) => item.type === "final" && (item.status === "queued" || item.status === "processing"));
      setNotice(job ? "Export 0% - waiting to start" : updated.finalUrl ? "Export ready" : "Export requested");
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        setNotice("Sign in to export.");
        navigate(`/login?from=${encodeURIComponent(window.location.pathname)}`);
      } else if (error instanceof RelinkRequiredError) {
        setRelinkNeeds(error.assets);
        setNotice("Sync required before export.");
      } else if (error instanceof SyncRequiredError) {
        setNotice("Sync required before export.");
      } else {
        setNotice(error instanceof Error ? error.message : "Export failed");
      }
    } finally {
      setBusy(null);
    }
  }

  async function cancelRender() {
    if (!project || !activeRenderJob) {
      return;
    }
    setNotice("Cancelling export…");
    try {
      await cancelJob(activeRenderJob.id);
      // Drop the job from local state immediately so the Export button frees up without
      // waiting for the next poll; the server is now the source of truth for its status.
      setProject((current) =>
        current
          ? { ...current, renderJobs: (current.renderJobs ?? []).filter((job) => job.id !== activeRenderJob.id) }
          : current
      );
      setNotice("Export cancelled");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not cancel export");
    }
  }

  async function retrySync() {
    if (!project) {
      return;
    }
    setNotice("Syncing…");
    await checkNow();
    await promoteProject(project.id);
  }

  async function exportOnDevice(fps: number, format: ExportFormat) {
    if (!project || !composition) {
      return;
    }
    setExportDialogOpen(false);
    const controller = new AbortController();
    localExportAbortRef.current = controller;
    setLocalExport({ progress: 0, label: "Starting…" });
    // Exports own the machine: close the background gate so proxy builds/thumbnails/waveforms
    // never contend with the encode (reopened in finally).
    setBackgroundGate("exporting", true);
    try {
      const blob = await exportLocally({
        composition,
        compositions: graph?.compositions,
        urlForAsset: (id) => resolvedAssets.find((asset) => asset.id === id)?.fileUrl,
        format,
        fps,
        transitionManifests: importedPluginLibrary.transitions,
        lookManifests: importedPluginLibrary.looks,
        signal: controller.signal,
        onProgress: (progress, label) => setLocalExport({ progress, label })
      });
      const ext = format === "webm" ? "webm" : "mp4";
      await saveExportedFile(blob, `${project.title || "kimera"}.${ext}`);
      setNotice("Exported on this device");
    } catch (error) {
      if (!(error instanceof Error && error.name === "Aborted")) {
        setNotice(error instanceof Error ? error.message : "Local export failed");
      }
    } finally {
      setBackgroundGate("exporting", false);
      setLocalExport(null);
      localExportAbortRef.current = null;
    }
  }

  function openIsolatedDeviceExport(fps: number, format: ExportFormat) {
    if (!project) {
      return;
    }
    setExportDialogOpen(false);
    const handoffKey = `kimera.localExportHandoff.${project.id}.${Date.now()}`;
    let handoffWritten = false;
    try {
      localStorage.setItem(handoffKey, JSON.stringify({ project, assets: resolvedAssets, createdAt: Date.now() }));
      handoffWritten = true;
    } catch {
      /* fallback route can still load from local/API project stores */
    }
    const params = new URLSearchParams({
      projectId: project.id,
      fps: String(fps),
      format
    });
    if (handoffWritten) {
      params.set("handoff", handoffKey);
    }
    const url = `/editor/__local-export?${params.toString()}`;
    const opened = window.open(url, "_blank");
    if (!opened) {
      setNotice("Popup blocked. Allow popups for Kimera, then export again.");
      return;
    }
    try {
      opened.opener = null;
    } catch {
      /* best-effort */
    }
    setNotice("Export opened in a separate tab");
  }

  async function downloadRenderManifest() {
    if (!project) {
      return;
    }

    setBusy("manifest");
    try {
      const manifest = await getRenderManifest(project.id, "final");
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.id}-final-manifest.json`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Manifest exported");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Manifest export failed");
    } finally {
      setBusy(null);
    }
  }

  function exportFcpxml() {
    if (!project || !composition) {
      setNotice("Open a timeline before exporting FCPXML");
      return;
    }
    try {
      const { xml, report } = exportCompositionToFcpxml(composition, resolvedAssets);
      downloadBlobFile(new Blob([xml], { type: "application/xml" }), `${safeFileStem(project.title)}.fcpxml`);
      const unsupportedText = report.unsupported.length
        ? ` · ${report.unsupported.length} item${report.unsupported.length === 1 ? "" : "s"} lossy (see console)`
        : "";
      if (report.unsupported.length) {
        console.warn("[fcpxml export] unsupported constructs", report.unsupported);
      }
      setNotice(`FCPXML exported${unsupportedText}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "FCPXML export failed");
    }
  }

  function goToStart() {
    setEditorCurrentTime(0);
    setIsPlaying(false);
  }

  function goToEnd() {
    if (!composition) return;
    setEditorCurrentTime(composition.durationSeconds);
    setIsPlaying(false);
  }

  function getLivePlaybackTime() {
    if (!composition) return currentTimeRef.current;
    const started = playbackStartRef.current;
    if (!started) {
      return Math.max(0, Math.min(composition.durationSeconds, currentTimeRef.current));
    }
    return Math.max(
      0,
      Math.min(composition.durationSeconds, started.timeSeconds + (performance.now() - started.clockMs) / 1000)
    );
  }

  function pausePlaybackAtLiveClock() {
    const stopped = getLivePlaybackTime();
    currentTimeRef.current = stopped;
    playbackStartRef.current = null;
    setPlaybackClock(stopped);
    setColdPlaybackSuspended(false);
    flushColdPlaybackNotify(); // pause — settle cold panels exactly on the stop frame
    setPlaybackStart(null);
    setIsPlaying(false);
  }

  function togglePlayback() {
    stopShuttle();
    if (isPlayingRef.current) {
      pausePlaybackAtLiveClock();
      return;
    }
    setIsPlaying(true);
  }

  function stepFrame(direction: -1 | 1, frames = 1) {
    if (!composition) return;
    stopShuttle();
    setEditorCurrentTime(Math.max(0, Math.min(composition.durationSeconds, currentTimeRef.current + (direction * frames) / composition.fps)));
  }

  // --- JKL shuttle -----------------------------------------------------------
  // J/L drive the playhead through the SEEK/render path (a rAF loop stepping
  // `setEditorCurrentTime`), not the playback engine: the engine's wall-clock anchor is
  // implicitly rate-1 and forward-only, while the seek path already renders any t (it's what
  // scrubbing uses), which is the only way to get reverse play from `<video>`-backed sources.
  // Trade-off (v1): shuttle is silent (no audio) and frame pacing is seek-bound. L from a stop
  // starts NORMAL engine playback (1x with audio); a second L (or L during playback) switches
  // to a 2x shuttle, doubling per press up to 4x. J mirrors that in reverse from the start
  // (reverse has no engine path). K stops either mode.
  function stopShuttle() {
    const shuttle = shuttleRef.current;
    if (shuttle) {
      cancelAnimationFrame(shuttle.raf);
      shuttleRef.current = null;
      setShuttleRate(null);
    }
  }

  function startShuttle(direction: -1 | 1) {
    if (!composition) return;
    const existing = shuttleRef.current;
    if (existing && Math.sign(existing.rate) === direction) {
      existing.rate = direction * Math.min(4, Math.abs(existing.rate) * 2);
      setShuttleRate(existing.rate);
      return;
    }
    stopShuttle();
    let rate: number = direction;
    if (isPlayingRef.current) {
      pausePlaybackAtLiveClock();
      if (direction === 1) rate = 2; // L during normal playback = jump straight to 2x
    }
    const state = { rate, raf: 0, lastMs: performance.now() };
    shuttleRef.current = state;
    setShuttleRate(state.rate);
    const tick = () => {
      if (shuttleRef.current !== state || !compositionRef.current) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - state.lastMs) / 1000); // clamp jank spikes so the playhead never teleports
      state.lastMs = now;
      const duration = compositionRef.current.durationSeconds;
      const next = Math.max(0, Math.min(duration, currentTimeRef.current + state.rate * dt));
      setEditorCurrentTime(next);
      if ((state.rate < 0 && next <= 0) || (state.rate > 0 && next >= duration)) {
        stopShuttle();
        return;
      }
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  }

  /** Up/down-arrow edit-point navigation: jump the playhead to the previous/next cut. */
  function jumpToEditPoint(direction: -1 | 1) {
    if (!composition) return;
    stopShuttle();
    const points = collectEditPoints(composition);
    const epsilon = 0.5 / composition.fps; // half a frame so a playhead ON a cut moves past it
    const time = currentTimeRef.current;
    const target =
      direction === 1 ? points.find((point) => point > time + epsilon) : [...points].reverse().find((point) => point < time - epsilon);
    if (target !== undefined) {
      setEditorCurrentTime(Math.max(0, Math.min(composition.durationSeconds, target)));
    }
  }

  /**
   * Q/W ripple trim to the playhead ("head" trims the clip start up to the playhead, "tail"
   * from the playhead to the clip end), on the selected clips under the playhead — or, with
   * nothing selected, the first clip under it. Ripple closes the gap on that clip's own track
   * (same per-track semantics as ripple delete).
   */
  async function handleRippleTrimAtPlayhead(side: "head" | "tail") {
    if (!composition) return;
    stopShuttle();
    const time = currentTimeRef.current;
    const containing = flattenTimelineLayers(composition).filter(
      (layer) =>
        isLayerEditable(layer.id) &&
        time > layer.startSeconds + 0.0001 &&
        time < layer.startSeconds + layer.durationSeconds - 0.0001
    );
    if (!containing.length) return;
    const selected = containing.filter((layer) => selectedLayerIds.includes(layer.id));
    const targets = selected.length ? selected : [containing[0]!];
    let next = composition;
    for (const layer of targets) {
      next = rippleTrimLayer(next, layer.id, time, side);
    }
    await updateComposition(next);
    if (side === "head") {
      // Premiere behavior: after trimming the head, the playhead lands on the new edit point.
      const first = targets.reduce((min, layer) => Math.min(min, layer.startSeconds), Number.POSITIVE_INFINITY);
      if (Number.isFinite(first)) setEditorCurrentTime(first);
    }
  }

  function setEditorCurrentTime(timeSeconds: number) {
    // Quantize the playhead to the frame grid (Premiere semantics — frames are all that can
    // render); same-frame scrub moves dedupe for free via the clock store's own equality check.
    // Clamp to [0, duration] here so the playhead can never overshoot the composition (the old
    // clamp effect keyed on `currentTime` state is gone with the state).
    const fps = compositionRef.current?.fps || 30;
    const duration = compositionRef.current?.durationSeconds ?? timeSeconds;
    const quantized = Math.max(0, Math.min(duration, Math.round(timeSeconds * fps) / fps));
    currentTimeRef.current = quantized;
    if (isPlaying) {
      const started = { clockMs: performance.now(), timeSeconds: quantized };
      playbackStartRef.current = started;
      setPlaybackStart(started);
    }
    // The clock store drives everything: hot leaves (preview via clockDriven, timeline playhead via
    // imperative subscription, timecode) update instantly, and it ALSO schedules the throttled cold
    // notify (≤120ms) that refreshes the <ColdTime> panels (inspector/scopes/mixer). EditorPage
    // itself does not re-render on a seek at all — the whole point of dropping `currentTime` state.
    setPlaybackClock(quantized);
  }

  function expandLayerSelection(layerIds: string[]) {
    const requested = new Set(layerIds);
    const linkedGroups = new Set(
      layers.filter((layer) => requested.has(layer.id) && layer.linkedGroupId).map((layer) => layer.linkedGroupId as string)
    );
    return layers
      .filter((layer) => requested.has(layer.id) || (layer.linkedGroupId ? linkedGroups.has(layer.linkedGroupId) : false))
      .map((layer) => layer.id);
  }

  /**
   * SELECTION RENDER DIET: selection is EditorPage root state, so a plain clip click used to flush a
   * synchronous full-tree render (~350ms EditorPage + ~335ms VideoPreview in dev) INSIDE the
   * pointerdown — the browser could not even paint the highlight until it finished, which is why
   * "selecting clips feels very heavy" (2026-07-04 soak). All interactive selection changes now
   * commit through a `startTransition`, so the click handler returns immediately and the heavy
   * render runs as an interruptible non-urgent update AFTER the click frame paints. The instant
   * visual highlight comes from TimelineStrip's imperative `is-selected` class write at pointerdown;
   * React reconciles to the same classes when the transition lands. The identity bail keeps the
   * previous array when the selection is unchanged so no `[selectedLayerIds]`-keyed memo (VideoPreview
   * above all) invalidates for a no-op select.
   */
  function commitLayerSelection(update: (current: string[]) => string[]) {
    startTransition(() => {
      setSelectedLayerIds((current) => {
        const next = update(current);
        return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
      });
    });
  }

  function selectLayer(layerId?: string, mode: LayerSelectMode = "replace") {
    if (!layerId) {
      clearLayerSelection();
      return;
    }

    if (mode === "replace") {
      selectionAnchorRef.current = layerId;
      commitLayerSelection(() => expandLayerSelection([layerId]));
      return;
    }

    if (mode === "toggle") {
      selectionAnchorRef.current = layerId;
      commitLayerSelection((current) => {
        const next = new Set(current);
        if (next.has(layerId)) {
          next.delete(layerId);
        } else {
          next.add(layerId);
        }
        return expandLayerSelection([...next]);
      });
      return;
    }

    const rangeIds = getSelectionRangeIds(layerId);
    if (mode === "add-range") {
      commitLayerSelection((current) => expandLayerSelection([...new Set([...current, ...rangeIds])]));
      return;
    }

    commitLayerSelection(() => expandLayerSelection(rangeIds));
  }

  function selectLayers(layerIds: string[], mode: LayerCollectionSelectMode = "replace") {
    if (mode === "replace") {
      selectionAnchorRef.current = layerIds[layerIds.length - 1] ?? null;
      commitLayerSelection(() => expandLayerSelection(layerIds));
      return;
    }

    if (mode === "add") {
      selectionAnchorRef.current = layerIds[layerIds.length - 1] ?? selectionAnchorRef.current;
      commitLayerSelection((current) => expandLayerSelection([...new Set([...current, ...layerIds])]));
      return;
    }

    selectionAnchorRef.current = layerIds[layerIds.length - 1] ?? selectionAnchorRef.current;
    commitLayerSelection((current) => {
      const next = new Set(current);
      for (const layerId of layerIds) {
        if (next.has(layerId)) {
          next.delete(layerId);
        } else {
          next.add(layerId);
        }
      }
      return expandLayerSelection([...next]);
    });
  }

  function clearLayerSelection() {
    selectionAnchorRef.current = null;
    commitLayerSelection(() => []);
  }

  function getSelectionRangeIds(targetLayerId: string) {
    if (!composition) {
      return [targetLayerId];
    }

    const orderedIds = composition.tracks.flatMap((track) => track.layers).map((layer) => layer.id);
    const targetIndex = orderedIds.indexOf(targetLayerId);
    if (targetIndex < 0) {
      return [targetLayerId];
    }

    const anchorId = selectionAnchorRef.current;
    const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1;
    if (anchorIndex < 0) {
      selectionAnchorRef.current = targetLayerId;
      return [targetLayerId];
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return orderedIds.slice(start, end + 1);
  }

  function focusAssetUse(assetId: string, timelineLayers: TimelineLayer[]) {
    const layer = timelineLayers.find((item) => item.assetId === assetId);
    if (!layer) {
      return;
    }
    setSelectedLayerIds(expandLayerSelection([layer.id]));
    // Through the seek path (not raw setCurrentTime) so the ref + clock store move with it —
    // a raw state write here left the clock-driven preview/playhead behind.
    setEditorCurrentTime(layer.startSeconds);
    focusInspector();
  }

  function startHorizontalResize(event: ReactPointerEvent<HTMLDivElement>) {
    // Measure .editor-layout (not .editor-main): in expanded mode .editor-main is
    // display:contents and has no box, which would zero the rect and lock the handle.
    const frame = event.currentTarget.closest(".editor-layout");
    if (!(frame instanceof HTMLElement)) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = frame.getBoundingClientRect();
    const bounds = getEditorPaneResizeBounds(rect.width).left;
    const move = (moveEvent: PointerEvent) => {
      setLeftPaneWidth(Math.round(clamp(moveEvent.clientX - rect.left, bounds.min, bounds.max)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function startRightPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const frame = event.currentTarget.closest(".editor-layout");
    if (!(frame instanceof HTMLElement)) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = frame.getBoundingClientRect();
    const bounds = getEditorPaneResizeBounds(rect.width).right;
    const move = (moveEvent: PointerEvent) => {
      // Drag left = wider inspector; measure from the layout's right edge.
      setRightPaneWidth(Math.round(clamp(rect.right - moveEvent.clientX, bounds.min, bounds.max)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function startVerticalResize(event: ReactPointerEvent<HTMLDivElement>) {
    const frame = event.currentTarget.closest(".editor-layout");
    if (!(frame instanceof HTMLElement)) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = frame.getBoundingClientRect();
    const bounds = getEditorPaneResizeBounds(rect.width).timeline;
    const move = (moveEvent: PointerEvent) => {
      setTimelineHeight(Math.round(clamp(rect.bottom - moveEvent.clientY, bounds.min, bounds.max)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function startSourceProgramResize(event: ReactPointerEvent<HTMLDivElement>) {
    const frame = event.currentTarget.closest(".viewer-monitors");
    if (!(frame instanceof HTMLElement)) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = frame.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      setSourceMonitorSplit(clamp((moveEvent.clientX - rect.left) / rect.width, 0.2, 0.8));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  // Identity-stable wrappers for the memo'd VideoPreview's function props (see the memo comparator
  // in VideoPreview.tsx). VideoPreview is CLOCK-DRIVEN, so its `currentTime` prop is redundant — the
  // memo skips the cold-commit re-render. But that only holds if its other props keep identity across
  // the commit; these useStableHandler wraps give the callbacks a fixed identity while always
  // dispatching to the latest closure (captured state stays fresh). Mask commits read the LIVE
  // playhead (`currentTimeRef`) rather than the cold state — a strict improvement over the old inline
  // closure that captured the 120ms-stale `currentTime`.
  const stablePreviewSaveFreezeFrame = useStableHandler(() => void handleSaveFreezeFrame());
  const stablePreviewSelectLayer = useStableHandler((layerId?: string | undefined) => selectLayer(layerId));
  const stablePreviewMoveLayer = useStableHandler(handlePreviewMoveLayer);
  const stablePreviewMovePositionKeyframe = useStableHandler(handlePreviewMovePositionKeyframe);
  const stablePreviewMoveSpatialHandle = useStableHandler(handlePreviewMoveSpatialHandle);
  const stablePreviewResizeShapeLayer = useStableHandler(handlePreviewResizeShapeLayer);
  const stablePreviewResizeFrameLayer = useStableHandler(handlePreviewResizeFrameLayer);
  const stablePreviewContentTransformLayer = useStableHandler(handlePreviewContentTransformLayer);
  const stableReplaceLayerAsset = useStableHandler(handleReplaceLayerAsset);
  const stablePreviewRotateLayer = useStableHandler(handlePreviewRotateLayer);
  const stablePreviewScaleLayer = useStableHandler(handlePreviewScaleLayer);
  const stablePreviewCropLayer = useStableHandler(handlePreviewCropLayer);
  const stablePreviewToggleShowMasks = useStableHandler(() => setShowMasks((value) => !value));
  const stablePreviewMaskScalar = useStableHandler(handlePreviewMaskScalar);
  const stablePreviewUpdateLayerMasks = useStableHandler((layerId: string, updater: (masks: Mask[]) => Mask[]) =>
    void updateLayer(layerId, (current) =>
      activeMaskEffectId
        ? {
            ...current,
            effects: current.effects.map((effect) =>
              effect.id === activeMaskEffectId ? { ...effect, masks: updater(effect.masks ?? []) } : effect
            )
          }
        : { ...current, masks: updater(current.masks ?? []) }
    )
  );
  // ---- memo'd TimelineStrip props ----------------------------------------------------------
  // TimelineStrip is memo'd (see its export comment): it must skip re-renders caused by unrelated
  // EditorPage state (toasts, modals, inspector-only edits). Its ~50 callback props get frozen
  // identities here (grouped useStableHandlers — same doctrine as the AssetBin/VideoPreview
  // stable* blocks); `markers` is memoized because normalizeTimelineMarkers returns a fresh array.
  const timelineMarkers = useMemo(
    () => normalizeTimelineMarkers(composition?.settings?.timeline.markers),
    [composition?.settings?.timeline.markers]
  );
  const timelineHandlers = useStableHandlers({
    onChangeCurrentTime: setEditorCurrentTime,
    onChangeTrackHeight: (height: number) => setTimelineTrackHeight(clamp(height, 18, 76)),
    onUndo: () => {
      void undo();
    },
    onRedo: () => {
      void redo();
    },
    onClearSelection: clearLayerSelection,
    onDeleteTrack: handleDeleteTrack,
    onReorderTrack: (trackId: string, targetTrackId: string, placement: "before" | "after") => {
      void handleReorderTrack(trackId, targetTrackId, placement);
    },
    onDeleteLayer: handleDeleteLayer,
    onDeleteKeyframe: (layerId: string, keyframeId: string) => {
      void handleDeleteKeyframe(layerId, keyframeId);
      setNotice("Keyframe deleted");
    },
    onAddLayer: handleAddLayer,
    onAddTrack: handleAddTrack,
    onDropAsset: (assetId: string, trackId: string, dropStartSeconds: number, replaceLayerId?: string | undefined, sourceDrag?: SourceDragPayload | undefined) =>
      void handleDropAsset(assetId, trackId, dropStartSeconds, replaceLayerId, sourceDrag?.mode ?? "auto", sourceDrag),
    onDropTimelineEffect: (effectType: TimelineEffect["type"], layerId: string) => {
      void updateLayer(layerId, (layer) => ({
        ...layer,
        effects: [...layer.effects, createTimelineEffect(effectType)]
      }));
      selectLayer(layerId);
      focusInspector();
      setNotice("Effect added");
    },
    onLinkSelectedLayers: handleLinkSelectedLayers,
    onDeleteSelectedLayers: () => {
      void handleDeleteLayers(selectedLayerIds);
    },
    onDuplicateSelectedLayers: () => {
      void handleDuplicateLayers(selectedLayerIds);
    },
    onMoveLayer: handleMoveLayer,
    onMoveKeyframe: (layerId: string, keyframeId: string, timeSeconds: number) => {
      void handleMoveKeyframe(layerId, keyframeId, timeSeconds);
      setNotice("Keyframe moved");
    },
    onSetTransition: handleSetTransition,
    onRemoveTransition: handleRemoveTransition,
    onSetResponsiveTime: (layerId: string, value: { introSeconds: number; outroSeconds: number }) =>
      void handleSetResponsiveTime(layerId, value),
    onAddCrossDissolve: handleAddCrossDissolve,
    onSetCrossDissolve: handleSetCrossDissolve,
    onRemoveCrossDissolve: handleRemoveCrossDissolve,
    onTrimForTransition: handleTrimForTransition,
    onResizeLayer: handleResizeLayer,
    onSelectLayer: selectLayer,
    onSelectLayers: selectLayers,
    onToggleTrack: handleToggleTrack,
    onUnlinkLayer: handleUnlinkLayer,
    onUnlinkSelectedLayers: handleUnlinkSelectedLayers,
    onNestSelection: () => {
      void handleNestSelection();
    },
    onUnnestClip: (layerId: string) => {
      void handleUnnestClip(layerId);
    },
    onOpenNestedClip: handleOpenNestedClip,
    onDropComposition: (compositionId: string, trackId: string, startSeconds: number) => {
      void handleInsertCompositionClip(compositionId, trackId, startSeconds);
    },
    onChangeToolMode: setTimelineTool,
    onToggleSnap: () => setSnapEnabled((value) => !value),
    onToggleMagnetic: () => setMagneticEnabled((value) => !value),
    onSplitLayerAt: (layerId: string, atSeconds: number) => {
      void handleSplitLayerAt(layerId, atSeconds);
    },
    onSplitAtPlayhead: () => {
      void handleSplitAtPlayhead();
    },
    onNotice: setNotice,
    onRippleDeleteLayer: (layerId: string) => {
      void handleRippleDeleteLayer(layerId);
    },
    onDuplicateLayer: (layerId: string) => {
      void handleDuplicateLayer(layerId);
    },
    onToggleMarkerAtPlayhead: handleToggleMarkerAtPlayhead,
    onRemoveMarker: handleRemoveMarker,
    onUpdateMarker: handleUpdateMarker,
    onRemoveClipMarker: handleRemoveClipMarker,
    onUpdateClipMarker: handleUpdateClipMarker,
    onSetInPoint: handleSetInPoint,
    onSetOutPoint: handleSetOutPoint,
    onClearInPoint: handleClearInPoint,
    onClearOutPoint: handleClearOutPoint,
    onClearInOutPoints: handleClearInOutPoints,
    onRegenerateProxyCache: handleRegenerateProxyCache,
    onToggleLivePlayback: setLivePlaybackMode,
    onReplaceLayerAsset: handleReplaceLayerAsset,
    onSlipLayer: handleSlipLayer,
    // Event bus, NOT state: per-pointermove slip updates must re-render only the viewer overlay
    // (SlipTwoUpOverlay subscribes), never the EditorPage tree.
    onSlipPreview: (preview: { layerId: string; sourceInSeconds: number } | null) => {
      window.dispatchEvent(new CustomEvent("lumio:slip-preview", { detail: preview }));
    },
    onToggleLayersDisabled: () => {
      void handleToggleLayersDisabled();
    },
    onRollEdit: (leftLayerId: string, rightLayerId: string, deltaSeconds: number) => void handleRollEdit(leftLayerId, rightLayerId, deltaSeconds),
    onSlideLayer: (layerId: string, deltaSeconds: number) => void handleSlideLayer(layerId, deltaSeconds),
    onPreviewVolume: handlePreviewLayer,
    onSetLayerLabel: (layerId: string, label: string | null) => void updateLayer(layerId, (layer) => ({ ...layer, label: label ?? undefined }))
  });

  // Same doctrine for the memo'd LayerInspector (and the memo'd InspectorHosts inside it): frozen
  // callback identities dispatching to the latest closure. Handlers that used to close over
  // `inspectorLayer` inside the JSX guard now guard themselves — the wrapper can fire from a
  // commit where no layer is inspected.
  const inspectorHandlers = useStableHandlers({
    onAssignAsset: handleAssignAsset,
    onAttachTrack: (trackId: string) => {
      if (inspectorLayer) handleAttachSavedTrack(trackId, inspectorLayer.id);
    },
    onDeleteAsset: handleDeleteAsset,
    onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => {
      if (!inspectorLayer) return;
      // Locked layers are read-only in the inspector too (§4 full lock): canvas handles already
      // bail on `layer.locked`; this is the property-panel chokepoint that every registered panel
      // (Transform, Effects, blend, …) commits through. Unlock stays available via the stack row
      // and the inspector's lock banner, both of which write through onChangeLayer (unguarded).
      // Multiselect: broadcast the SAME change to every selected clip (each against its own value),
      // not just the primary the inspector is showing — skipping any that are locked (like align).
      if (multiSelectPrimaryLayer && multiSelectPrimaryLayer.id === inspectorLayer.id) {
        const editable = selectedLayerIds.filter((id) => isLayerEditable(id));
        if (!editable.length) return;
        void updateLayers(editable, updater);
        return;
      }
      if (!isLayerEditable(inspectorLayer.id)) return;
      void updateLayer(inspectorLayer.id, updater);
    },
    // GRAPH EDITOR writes are SINGLE-LAYER by design — never the multiselect broadcast above.
    // The graph editor's draft commit (`useDraftLayer.commitDraft`) applies `onChange(() => next)`
    // where `next` is the drafted PRIMARY layer object; broadcasting that clones the primary
    // (assetId, source, effects — everything) onto every selected clip. 2026-07-16 data-loss report:
    // "all selected clips got identical sources".
    onGraphChange: (updater: (layer: TimelineLayer) => TimelineLayer) => {
      if (!inspectorLayer) return;
      if (!isLayerEditable(inspectorLayer.id)) return;
      void updateLayer(inspectorLayer.id, updater);
    },
    onChangeSpeed: handleChangeLayerSpeed,
    onEditTrack: (trackId: string) => setTrackModalState({ editingTrackId: trackId }),
    onOpenTrackModal: () => {
      if (!mainTrackableAsset) {
        setNotice("Add a video or image clip to the timeline first");
        return;
      }
      setTrackModalState({});
    },
    onRemoveTrack: handleRemoveTrack,
    onSeek: setEditorCurrentTime,
    onUploadAsset: handleUploadAsset,
    onSelectMask: (maskId: string | null) => {
      setActiveMaskEffectId(null);
      setActiveMaskId(maskId);
    },
    onSelectEffectMask: (effectId: string, maskId: string | null) => {
      setActiveMaskEffectId(effectId);
      setActiveMaskId(maskId);
    },
    onChangeMaskTool: changeMaskTool,
    // Graphics tab layer stack: select / edit layers OTHER than the inspected one.
    // Mode-aware so the stack mirrors the timeline's click/shift/ctrl selection exactly.
    onSelectLayer: (layerId: string, mode: LayerSelectMode = "replace") => selectLayer(layerId, mode),
    onChangeLayer: (layerId: string, updater: (layer: TimelineLayer) => TimelineLayer) => {
      void updateLayer(layerId, updater);
    },
    // Graphics tab align/distribute: apply per-layer targets to many layers in ONE history entry.
    onChangeLayers: (layerIds: string[], updater: (layer: TimelineLayer) => TimelineLayer) => {
      void updateLayers(layerIds, updater);
    },
    // Graphics tab stack ops — dispatch the SAME operations the timeline uses (stack owns no state).
    onDuplicateLayer: (layerId: string) => void handleDuplicateLayer(layerId),
    onDeleteLayer: (layerId: string) => void handleDeleteLayer(layerId),
    // Selection-aware variants: when the stack acts on a multi-selection, duplicate/delete them all in ONE undo.
    onDuplicateLayers: (layerIds: string[]) => void handleDuplicateLayers(layerIds),
    onDeleteLayers: (layerIds: string[]) => void handleDeleteLayers(layerIds),
    onGroupLayers: () => void handleNestSelection(),
    onUngroupLayer: (layerId: string) => void handleUnnestClip(layerId),
    onReorderLayer: (layerId: string, targetLayerId: string, place: "front-of" | "behind") =>
      void handleReorderLayerWithinTrack(layerId, targetLayerId, place),
    // Text tab — reusable Text Styles (§2).
    onSaveTextStyle: () => void handleSaveTextStyle(),
    onApplyTextStyle: (style: TextStyle) => void handleApplyTextStyle(style),
    onUpdateTextStyle: (styleId: string) => void handleUpdateTextStyle(styleId),
    onRenameTextStyle: (styleId: string, name: string) => void handleRenameTextStyle(styleId, name),
    onDeleteTextStyle: (styleId: string) => void handleDeleteTextStyle(styleId)
  });

  const stablePreviewCommitMaskPoints = useStableHandler((layerId: string, maskId: string, points: MaskPoint[]) =>
    void updateLayer(layerId, (current) =>
      activeMaskEffectId
        ? {
            ...current,
            effects: current.effects.map((effect) =>
              effect.id === activeMaskEffectId
                ? { ...effect, masks: (effect.masks ?? []).map((mask) => (mask.id === maskId ? { ...mask, points } : mask)) }
                : effect
            )
          }
        : recordMaskPoints(current, maskId, Math.max(0, currentTimeRef.current - current.startSeconds), points)
    )
  );

  // Pen tool on a PEN SHAPE layer (2026-07-17): the drawn outline becomes the layer's OWN geometry —
  // shapePath (0..100 in the drawn bounding box), box size (style.width/height % of comp) and
  // position, all in one write/undo step. Before this a pen shape only ever showed its canned
  // default polygon ("pen tool not working for drawing shapes").
  const stablePreviewCommitShapePath = useStableHandler(
    (layerId: string, patch: { shapePath: MaskPoint[]; widthPercent: number; heightPercent: number; xPercent: number; yPercent: number }) =>
      void updateLayer(layerId, (current) => ({
        ...current,
        shapeKind: "pen",
        shapePath: patch.shapePath,
        widthPercent: Number(patch.widthPercent.toFixed(2)),
        heightPercent: Number(patch.heightPercent.toFixed(2)),
        transform: {
          ...current.transform,
          position: { x: Number(patch.xPercent.toFixed(2)), y: Number(patch.yPercent.toFixed(2)) }
        }
      }))
  );

  // AI dock props doctrine: AiChatPanel is memo'd, so every callback prop must be identity-stable
  // (same useStableHandlers pattern as timelineHandlers/inspectorHandlers). Each wrapper dispatches
  // to the latest closure; the token props stay the only intentional change-signals.
  const aiAssetUrlById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.fileUrl])), [assets]);
  const aiPanelHandlers = useStableHandlers({
    resolveAssetUrl: (assetId: string) => aiAssetUrlById.get(assetId),
    // The dock only renders under the `… && composition` guard below, so composition is present
    // whenever the panel can call this (the assertion mirrors the old inline closure's narrowing).
    getContext: () => ({ composition: composition!, selection: selectedLayerIds, nowSeconds: currentTimeRef.current }),
    commitComposition: (after: TimelineComposition) => updateComposition(after),
    openTool: (step: Parameters<typeof openToolForAi>[0]) => openToolForAi(step),
    onUndo: () => {
      void undo();
    },
    onClose: () => setAiPanelOpen(false),
    onOpenGenerate: (prefill?: GenerateStudioPrefill) => {
      setGenerateStudioPrefill(prefill);
      setGenerateStudioOpen(true);
    },
    onAddAssetToTimeline: (asset: SourceAsset) => void stableAddAssetToTimeline(asset, "auto")
  });

  /**
   * Editor Command Plane (v1) — the dispatcher behind the AI brain's tier-0 command rules
   * ("pan mode", "pause", "select clip 3"). Non-destructive view/transport state only; every
   * branch reuses the SAME handlers the keyboard/buttons use, so a voice command can never do
   * something a keypress couldn't. Stable identity (AI panel props doctrine).
   */
  const runEditorCommand = useStableHandler((id: EditorCommandId, rawParams: unknown): EditorCommandResult => {
    const validation = validateEditorCommand(id, rawParams);
    if (!validation.ok) {
      return { ok: false, say: "That command didn't parse cleanly — try rephrasing." };
    }
    switch (id) {
      case "setTool": {
        const { tool } = rawParams as EditorCommandParams<"setTool">;
        setTimelineTool(tool);
        return { ok: true, say: "" };
      }
      case "transport": {
        const { op } = rawParams as EditorCommandParams<"transport">;
        if (op === "play") {
          stopShuttle();
          if (!isPlayingRef.current) setIsPlaying(true);
        } else if (op === "pause" || op === "stop") {
          stopShuttle();
          pausePlaybackAtLiveClock();
        } else if (op === "toggle") {
          togglePlayback();
        } else if (op === "shuttleForward") {
          startShuttle(1);
        } else {
          startShuttle(-1);
        }
        return { ok: true, say: "" };
      }
      case "seek": {
        const params = rawParams as EditorCommandParams<"seek">;
        if (params.toSeconds !== undefined) {
          setEditorCurrentTime(params.toSeconds);
        } else if (params.deltaSeconds !== undefined) {
          setEditorCurrentTime(currentTimeRef.current + params.deltaSeconds);
        } else if (params.frames !== undefined) {
          stepFrame(params.frames >= 0 ? 1 : -1, Math.abs(params.frames));
        } else if (params.target === "start") {
          goToStart();
        } else if (params.target === "end") {
          goToEnd();
        } else if (params.target === "nextCut" || params.target === "prevCut") {
          jumpToEditPoint(params.target === "nextCut" ? 1 : -1);
        } else if (params.target === "nextMarker" || params.target === "prevMarker") {
          const forward = params.target === "nextMarker";
          const now = currentTimeRef.current;
          const times = timelineMarkers.map((marker) => marker.timeSeconds).sort((a, b) => a - b);
          const found = forward ? times.find((time) => time > now + 0.001) : [...times].reverse().find((time) => time < now - 0.001);
          if (found === undefined) {
            return { ok: false, say: forward ? "No marker ahead of the playhead." : "No marker behind the playhead." };
          }
          setEditorCurrentTime(found);
        }
        return { ok: true, say: "" };
      }
      case "selectClip": {
        const params = rawParams as EditorCommandParams<"selectClip">;
        if (params.clear || !params.layerId) {
          setSelectedLayerIds([]);
        } else {
          setSelectedLayerIds(expandLayerSelection([params.layerId]));
        }
        return { ok: true, say: "" };
      }
      case "setPreviewQuality": {
        const { quality } = rawParams as EditorCommandParams<"setPreviewQuality">;
        // Mirrors the ¼/½/1/A buttons exactly — the adaptive flag is a DUAL source of truth
        // (React state + adaptive-quality module singleton); both must move together.
        if (quality === "auto") {
          setPreviewQuality("balanced");
          setAdaptiveQualityOn(true);
          setAdaptiveResOn(true);
        } else {
          setPreviewQuality(quality === "quarter" ? "performance" : quality === "half" ? "balanced" : "quality");
          setAdaptiveQualityOn(false);
          setAdaptiveResOn(false);
        }
        return { ok: true, say: "" };
      }
      case "setSnapping": {
        const params = rawParams as EditorCommandParams<"setSnapping">;
        if (params.on !== undefined) {
          setSnapEnabled(params.on);
        } else {
          setSnapEnabled((value) => !value);
        }
        return { ok: true, say: "" };
      }
      case "editorUndoRedo": {
        const { op } = rawParams as EditorCommandParams<"editorUndoRedo">;
        if (op === "undo") {
          if (undoStackRef.current.length === 0) {
            return { ok: false, say: "Nothing to undo." };
          }
          void undo();
        } else {
          if (redoStackRef.current.length === 0) {
            return { ok: false, say: "Nothing to redo." };
          }
          void redo();
        }
        return { ok: true, say: "" };
      }
      case "openExport": {
        // Same gate + setup as the on-device Export button / Ctrl+M.
        if (!localExportSupported || localExport || !composition) {
          return { ok: false, say: "Local export isn't available right now." };
        }
        setExportFps(null);
        setExportFormat("mp4");
        setExportDialogOpen(true);
        return { ok: true, say: "" };
      }
      case "openPanel": {
        const params = rawParams as EditorCommandParams<"openPanel">;
        const op = params.op ?? "open";
        if (params.panel === "inspector") {
          if (op === "toggle") {
            toggleInspectorFromTopbar();
          } else if (responsiveLayout.usesOverlayPanels) {
            setActiveResponsiveOverlay(op === "open" ? "inspector" : null);
          } else {
            setInspectorCollapsed(op !== "open");
          }
          return { ok: true, say: "" };
        }
        // Left browse tabs — same open/close semantics as the topbar toggles.
        const tab = params.panel;
        if (op === "toggle") {
          toggleLeftPanelTab(tab);
        } else if (op === "open") {
          setPanelTab(tab);
          if (responsiveLayout.usesOverlayPanels) setActiveResponsiveOverlay("assets");
          else setPanelCollapsed(false);
        } else if (isLeftPanelTabActive(tab)) {
          if (responsiveLayout.usesOverlayPanels) setActiveResponsiveOverlay(null);
          else setPanelCollapsed(true);
        }
        return { ok: true, say: "" };
      }
    }
  });

  if (!project || !graph || !composition) {
    return (
      <div className="page">
        <EmptyState title="Opening editor" body="Preparing the project graph." />
      </div>
    );
  }

  return (
    <AutoKeyframeContext.Provider value={autoKeyframe}>
    <div
      ref={editorPageRef}
      className={`editor-page${aiPanelOpen ? " is-ai-open" : ""}${topbarMenuOpen ? " is-topbar-menu-open" : ""}`}
      data-editor-mode={responsiveLayout.mode}
      data-editor-density={responsiveLayout.density}
      data-kimera-theme={editorTheme}
    >
      <div className="editor-topbar" data-overflow={responsiveLayout.usesTopbarOverflow ? "menu" : "inline"}>
        <div className="topbar-left">
          <Link to="/" className="editor-brand">
            Kimera
          </Link>
          <div className="topbar-panel-toggles" role="toolbar" aria-label="Panels">
            <button
              type="button"
              className={`topbar-toggle${isLeftPanelTabActive("assets") ? " is-active" : ""}`}
              aria-pressed={isLeftPanelTabActive("assets")}
              onClick={() => toggleLeftPanelTab("assets")}
              title={`Media Pool (${altKeyLabel}+1)`}
              aria-keyshortcuts={`${altKeyLabel}+1`}
            >
              <FolderOpen size={14} />
              <span>Media</span>
            </button>
            <button
              type="button"
              className={`topbar-toggle${isLeftPanelTabActive("effects") ? " is-active" : ""}`}
              aria-pressed={isLeftPanelTabActive("effects")}
              onClick={() => toggleLeftPanelTab("effects")}
              title={`Effects (${altKeyLabel}+2)`}
              aria-keyshortcuts={`${altKeyLabel}+2`}
            >
              <SlidersHorizontal size={14} />
              <span>Effects</span>
            </button>
            <button
              type="button"
              className={`topbar-toggle${isLeftPanelTabActive("color") ? " is-active" : ""}`}
              aria-pressed={isLeftPanelTabActive("color")}
              onClick={() => toggleLeftPanelTab("color")}
              title={`Color (${altKeyLabel}+3)`}
              aria-keyshortcuts={`${altKeyLabel}+3`}
            >
              <Palette size={14} />
              <span>Color</span>
            </button>
            <button
              type="button"
              className={`topbar-toggle is-icon${isLeftPanelTabActive("settings") ? " is-active" : ""}`}
              aria-pressed={isLeftPanelTabActive("settings")}
              onClick={() => toggleLeftPanelTab("settings")}
              title="Project settings"
              aria-label="Project settings"
            >
              <Settings size={14} />
            </button>
          </div>
          <Button
            className={`editor-ai-topbar-button topbar-toggle${aiVoiceActive ? " is-voice-live" : ""}`}
            variant={aiPanelOpen || aiVoiceActive ? "primary" : "secondary"}
            icon={<Sparkles size={16} />}
            onClick={() => setAiPanelOpen((open) => !open)}
            aria-pressed={aiPanelOpen}
            title={
              aiVoiceActive
                ? `AI is live — listening hands-free (${altKeyLabel}+L to stop). Click to ${aiPanelOpen ? "hide" : "show"} the chat.`
                : `${aiPanelOpen ? "Hide" : "Show"} AI assistant (${shortcutModifierLabel}+/)`
            }
            aria-keyshortcuts={`${shortcutModifierLabel}+/`}
          >
            {aiVoiceActive ? (
              <>
                AI <span className="ai-live-dot" aria-hidden="true" /> live
              </>
            ) : (
              "AI"
            )}
          </Button>
        </div>
        <div className="topbar-center">
          {/* Lifecycle chip: only for non-ready states (Draft) — readiness lives on the right SyncBadge.
              Neutral tone reserves green exclusively for that live "Export ready" signal. */}
          {project.status && !isReadyProjectStatus(project.status) ? (
            <Badge tone="muted">{formatProjectStatus(project.status)}</Badge>
          ) : null}
          <h1 className="topbar-project-title">{project.title}</h1>
          <span className="topbar-timecode">
            <PlayheadTimeReadout fallback={currentTimeRef.current} />
          </span>
        </div>
        <div className="topbar-right">
          {/* Single status slot: render progress while a job runs, otherwise the one save/sync badge. */}
          <div className="editor-status">
            {activeRenderJob ? <AiActivityIndicator label={renderNotice} /> : <SyncBadge projectId={project?.id} onRetry={retrySync} />}
          </div>
          <CreditBadge value={creditEstimate} />
          {/* Document actions — icon-only with tooltips to keep the bar compact. */}
          <input
            ref={templatePackageInputRef}
            type="file"
            accept="application/json,.json,.kimera-template,.kimera,.edl,.fcpxml,.xml,.prproj"
            className="effect-import-input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              void importTimelineOrTemplateFile(file);
              event.currentTarget.value = "";
            }}
          />
          <div className={`editor-actions-overflow${topbarMenuOpen ? " is-open" : ""}`}>
            {responsiveLayout.usesTopbarOverflow ? (
              <Button
                className="icon-only editor-actions-overflow-trigger"
                variant="secondary"
                icon={<MoreVertical size={16} />}
                onClick={() => setTopbarMenuOpen((open) => !open)}
                aria-label="More editor actions"
                aria-expanded={topbarMenuOpen}
                title="More editor actions"
              />
            ) : null}
            <div className="editor-actions-secondary">
          <Button
            className="icon-only"
            variant="secondary"
            icon={<LayoutTemplate size={16} />}
            disabled={busy === "template" || !composition}
            onClick={() => setTemplateModalOpen(true)}
            aria-label="Save as template"
            title="Save as template"
          />
          <Button
            className="icon-only"
            variant="secondary"
            icon={<Download size={16} />}
            disabled={busy === "template-package" || busy === "timeline-import"}
            onClick={() => templatePackageInputRef.current?.click()}
            aria-label="Import timeline or template"
            title="Import timeline or template"
          />
          <Button
            className="icon-only"
            variant="secondary"
            icon={<Upload size={16} />}
            disabled={busy === "template-package" || !composition}
            onClick={(event) => exportTimelineTemplatePackage(event)}
            aria-label="Export template package"
            title="Export .kimera package with embedded media (Shift+click: lightweight .kimera-template.json)"
          />
          <Button
            className="icon-only"
            variant="secondary"
            icon={<Film size={16} />}
            disabled={busy === "manifest"}
            onClick={downloadRenderManifest}
            aria-label="Download render manifest"
            title="Download render manifest"
          />
          <Button
            className="icon-only"
            variant="secondary"
            icon={<FileCode size={16} />}
            disabled={!composition}
            onClick={exportFcpxml}
            aria-label="Export FCPXML"
            title="Export FCPXML (for Premiere/Resolve/Final Cut)"
          />
          <Button
            className="icon-only"
            variant="secondary"
            icon={<Eye size={16} />}
            disabled={busy === "preview" || Boolean(activeRenderJob)}
            onClick={preview}
            aria-label={activeRenderJob?.type === "preview" ? "Previewing…" : "Preview render"}
            title="Preview render"
          />
          <Button
            className="icon-only"
            variant="secondary"
            icon={viewerFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            onClick={toggleViewerFullscreen}
            aria-label={viewerFullscreen ? "Exit fullscreen" : "Fullscreen (F11)"}
            title={viewerFullscreen ? "Exit fullscreen" : "Fullscreen window (like F11)"}
          />
            </div>
          </div>
          <span className="editor-actions-divider" aria-hidden="true" />
          {localExportSupported ? (
            <Button
              className="icon-only editor-local-export-button"
              variant="secondary"
              icon={<MonitorDown size={16} />}
              disabled={Boolean(localExport) || !composition}
              onClick={() => {
                setExportFps(null);
                setExportFormat("mp4");
                setExportDialogOpen(true);
              }}
              aria-label={localExport ? "Exporting on this device…" : "Export on this device"}
              title="Render on this device — choose frame rate & format, no upload"
            />
          ) : null}
          <Button className="editor-final-export-button" icon={<Download size={16} />} disabled={busy === "export" || Boolean(activeRenderJob)} onClick={renderFinal}>
            {activeRenderJob?.type === "final" ? "Exporting" : "Export"}
          </Button>
          {activeRenderJob ? (
            <Button className="icon-only" variant="secondary" onClick={cancelRender} icon={<X size={16} />} aria-label="Cancel render" title="Cancel the in-progress render" />
          ) : null}
          {finalDownloadUrl && !activeRenderJob ? (
            <a className="editor-output-link" href={finalDownloadUrl} target="_blank" rel="noreferrer">
              Download
            </a>
          ) : null}
          <span className="editor-actions-divider" aria-hidden="true" />
          <div className="topbar-theme-picker">
            <button
              type="button"
              className={`topbar-toggle${themeMenu ? " is-active" : ""}`}
              aria-pressed={Boolean(themeMenu)}
              aria-expanded={Boolean(themeMenu)}
              onClick={(event) => {
                if (themeMenu) {
                  setThemeMenu(null);
                  return;
                }
                // Anchor to the trigger; menu is 176px wide and right-aligned to the button.
                const rect = event.currentTarget.getBoundingClientRect();
                setThemeMenu({
                  left: Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184)),
                  top: rect.bottom + 4
                });
              }}
              title="Theme"
            >
              <Droplet size={14} style={{ color: EDITOR_THEMES.find((theme) => theme.id === editorTheme)?.swatch }} />
              <span>Theme</span>
            </button>
            {themeMenu
              ? createPortal(
                  <div className="topbar-theme-menu" role="menu" aria-label="Accent theme" style={{ left: themeMenu.left, top: themeMenu.top }}>
                    {EDITOR_THEMES.map((theme) => (
                      <button
                        key={theme.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={editorTheme === theme.id}
                        className={`topbar-theme-option${editorTheme === theme.id ? " is-active" : ""}`}
                        onClick={() => {
                          setEditorTheme(theme.id);
                          setThemeMenu(null);
                        }}
                      >
                        <span className="topbar-theme-swatch" style={{ background: theme.swatch }} aria-hidden="true" />
                        {theme.label}
                      </button>
                    ))}
                  </div>,
                  // Portal into .editor-page (NOT body): fixed coords escape the topbar's clipping
                  // while the menu keeps the [data-kimera-theme] accent variable scope.
                  editorPageRef.current ?? document.body
                )
              : null}
          </div>
          <button
            type="button"
            className={`topbar-toggle${isInspectorOpenFromTopbar ? " is-active" : ""}`}
            aria-pressed={isInspectorOpenFromTopbar}
            onClick={toggleInspectorFromTopbar}
            title={`Inspector (${altKeyLabel}+4)`}
            aria-keyshortcuts={`${altKeyLabel}+4`}
          >
            {isInspectorOpenFromTopbar ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            <span>Inspector</span>
          </button>
        </div>
      </div>
      {/* Transient action feedback — module-store leaf, so toasts don't re-render EditorPage. */}
      <NoticeToast />

      {/* Ambiguous transition target — several clips under the playhead; ask which one. */}
      {transitionChoice ? (
        <div className="transition-choice-backdrop" onClick={() => setTransitionChoice(null)}>
          <div className="transition-choice-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Apply transition to…</h3>
            <p>Transitions are applied to a cut between two touching clips. Pick which cut to use.</p>
            <div className="transition-choice-list">
              {transitionChoice.candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="transition-choice-item"
                  onClick={() => {
                    applyTransitionToClip(candidate.id, transitionChoice.spec);
                    setTransitionChoice(null);
                  }}
                >
                  <strong>{candidate.name}</strong>
                  <span>{describeTransitionCutForClip(composition, candidate.id)}</span>
                </button>
              ))}
            </div>
            <button type="button" className="transition-choice-cancel" onClick={() => setTransitionChoice(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div
        className={`editor-layout${panelExpanded ? " is-left-expanded" : ""}${inspectorFullHeight ? " is-right-expanded" : ""}${panelExpanded || inspectorFullHeight ? " is-any-expanded" : ""}${inspectorCollapsed ? " is-inspector-collapsed" : ""}${panelCollapsed ? " is-left-collapsed" : ""}`}
        data-editor-mode={responsiveLayout.mode}
        data-editor-density={responsiveLayout.density}
        data-overlay={activeResponsiveOverlay ?? "none"}
        style={responsiveLayout.cssVars}
      >
        <div className="editor-main" style={responsiveLayout.cssVars}>
          {panelCollapsed && activeResponsiveOverlay !== "assets" ? null : (
          <aside className={`studio-panel scroll-performance-pane${activeResponsiveOverlay === "assets" ? " is-responsive-overlay-open" : ""}${isResponsiveOverlayExpanded("assets") ? " is-responsive-overlay-expanded" : ""}`} ref={studioPanelRef}>
            <div className="studio-tabs">
              {responsiveLayout.usesOverlayPanels ? (
                <div className="tabbar" role="tablist" aria-label="Editor panel">
                  <button className={panelTab === "assets" ? "is-active" : ""} type="button" onClick={() => setPanelTab("assets")}>
                    Assets
                  </button>
                  <button className={panelTab === "effects" ? "is-active" : ""} type="button" onClick={() => setPanelTab("effects")}>
                    Effects
                  </button>
                  <button className={panelTab === "color" ? "is-active" : ""} type="button" onClick={() => setPanelTab("color")}>
                    Color
                  </button>
                  <button
                    className={`tabbar-icon-button ${isResponsiveOverlayExpanded("assets") ? "is-active" : ""}`}
                    type="button"
                    title={isResponsiveOverlayExpanded("assets") ? "Restore panel height" : "Expand panel — full height"}
                    aria-label={isResponsiveOverlayExpanded("assets") ? "Restore panel height" : "Expand panel to full height"}
                    aria-pressed={isResponsiveOverlayExpanded("assets")}
                    onClick={() => toggleResponsiveOverlayExpansion("assets")}
                  >
                    {isResponsiveOverlayExpanded("assets") ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  </button>
                  <button
                    className={`tabbar-icon-button ${panelTab === "settings" ? "is-active" : ""}`}
                    type="button"
                    title="Project settings"
                    aria-label="Project settings"
                    onClick={() => setPanelTab("settings")}
                  >
                    <Settings size={15} />
                  </button>
                  <button
                    className="tabbar-icon-button"
                    type="button"
                    title="Collapse panel"
                    aria-label="Collapse panel"
                    onClick={() => setActiveResponsiveOverlay(null)}
                  >
                    <PanelLeftClose size={15} />
                  </button>
                </div>
              ) : (
                <div className="studio-panel-head">
                  <span className="studio-panel-title">
                    {panelTab === "assets" ? "Media Pool" : panelTab === "effects" ? "Effects" : panelTab === "color" ? "Color" : "Project Settings"}
                  </span>
                  <div className="studio-panel-head-actions">
                    {panelTab === "assets" && pro ? (
                      <button
                        type="button"
                        className="studio-panel-cloud-sync"
                        title={
                          cloudPendingLocalCount > 0
                            ? `Upload ${cloudPendingLocalCount} local asset${cloudPendingLocalCount === 1 ? "" : "s"} to the cloud`
                            : "All assets are already in the cloud"
                        }
                        aria-label="Sync all local assets to the cloud"
                        disabled={busy === "assets-cloud-sync-all" || cloudPendingLocalCount === 0}
                        onClick={() => stableSyncAllToCloud()}
                      >
                        <CloudUpload size={13} className={busy === "assets-cloud-sync-all" ? "asset-cloud-spin" : ""} />
                        <span>
                          {busy === "assets-cloud-sync-all"
                            ? "Syncing…"
                            : cloudPendingLocalCount > 0
                              ? `Sync ${cloudPendingLocalCount}`
                              : "Synced"}
                        </span>
                      </button>
                    ) : null}
                    <button
                      className={`tabbar-icon-button${panelExpanded ? " is-active" : ""}`}
                      type="button"
                      title={`${panelExpanded ? "Restore left panel height" : "Expand left panel — full height, timeline under the viewer"} (${altKeyLabel}+E)`}
                      aria-label={panelExpanded ? "Restore left panel height" : "Expand left panel to full height"}
                      aria-keyshortcuts={`${altKeyLabel}+E`}
                      aria-pressed={panelExpanded}
                      onClick={() => setPanelExpanded((value) => !value)}
                    >
                      {panelExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                  </div>
                </div>
              )}

              {/* Assets stays MOUNTED across tab switches — remounting rebuilt the whole panel
                  (bin tree, thumbnails, selection state) at ~300–550ms per switch back (dev,
                  2026-07-04 capture). Hidden via display:none, which generates no box, so the
                  visible tab's grid rows are unaffected; the :has(.asset-bin) footer-pin rules in
                  global.css are scoped to the VISIBLE case via .panel-tab-hidden. */}
              <div className={`panel-tab-content${panelTab === "assets" ? "" : " panel-tab-hidden"}`}>
                <AssetBin
                  assets={assets}
                  currentProjectId={project?.id}
                  currentUserId={project?.userId}
                  onApplyTemplate={stableApplyTemplate}
                  selectedAssetId={selectedLayer?.assetId}
                  usedCounts={assetUseCounts}
                  replaceActive={assetPickerForLayerId !== null}
                  onAssignAsset={stableAssignAsset}
                  onAddAssetToTimeline={stableAddAssetToTimeline}
                  onAddGraphic={stableAddGraphic}
                  onApplyFrame={stableApplyFrame}
                  onPickReplacement={stablePickReplacement}
                  onCancelReplace={stableCancelReplace}
                  onDeleteAsset={stableDeleteAsset}
                  onFocusAssetUse={stableFocusAssetUse}
                  onUploadAsset={stableUploadAsset}
                  onImportFile={stableImportFile}
                  onImportedAsset={stableRegisterAsset}
                  onMoveAssetFolder={stableMoveAssetFolder}
                  onSetAssetLabel={stableSetAssetLabel}
                  onUploadToCloud={pro ? stableUploadToCloud : undefined}
                  onRemoveFromCloud={stableRemoveFromCloud}
                  onRefreshFromCloud={stableRefreshFromCloud}
                  onPinOffline={stablePinOffline}
                  customFolders={graph.mediaManifest?.customFolders}
                  onChangeCustomFolders={stableChangeCustomFolders}
                  onOpenSourceMonitor={responsiveLayout.usesOverlayPanels ? undefined : stableOpenSourceMonitor}
                  timelines={timelinesTabData}
                  onOpenTimeline={stableOpenTimeline}
                  onInsertTimelineAtPlayhead={stableInsertTimelineAtPlayhead}
                  onRenameTimeline={stableRenameTimeline}
                  onDuplicateTimeline={stableDuplicateTimeline}
                  onDeleteTimeline={stableDeleteTimeline}
                  onCreateTimeline={stableCreateTimeline}
                />
              </div>
              {panelTab === "effects" ? (
                <div className="panel-tab-content">
                  <Suspense fallback={<div className="empty-mini">Loading effects…</div>}>
                    <EffectGraphPanel
                      effects={graph.effects}
                      selectedLayerType={selectedLayer?.type}
                      sampleFrames={transitionSampleFrames}
                      importedEffects={importedPluginLibrary.effects}
                      importedLooks={importedPluginLibrary.looks}
                      importedTransitions={importedPluginLibrary.transitions}
                      onAddTimelineEffect={handleAddTimelineEffect}
                      onApplyEffectManifest={handleApplyEffectManifest}
                      onImportEffectManifest={handleImportEffectManifest}
                      onRemoveEffectManifest={handleRemoveEffectManifest}
                      onImportLookManifest={handleImportLookManifest}
                      onRemoveLookManifest={handleRemoveLookManifest}
                      onImportTransitionManifest={handleImportTransitionManifest}
                      onRemoveTransitionManifest={handleRemoveTransitionManifest}
                      onApplyToolEffect={handleApplyLayerToolEffect}
                      onApplyPreset={handleApplyPreset}
                      onApplyLook={handleApplyLook}
                      onAddTransition={handleAddTransition}
                      onAddAudioEffect={handleAddAudioEffect}
                      onRemove={handleRemoveEffect}
                    />
                  </Suspense>
                  {busy && busy !== "preview" && busy !== "export" ? (
                    <Badge tone="lime">{busy.startsWith("asset-delete") ? "Deleting asset" : busy === "asset-upload" ? "Uploading asset" : `Adding ${busy}`}</Badge>
                  ) : null}
                </div>
              ) : panelTab === "settings" ? (
                <div className="panel-tab-content">
                  <ProjectSettingsPanel composition={composition} onChange={updateCompositionSettings} />
                </div>
              ) : panelTab === "color" ? (
                <div className="panel-tab-content">
                  {inspectorLayer && (inspectorLayer.type === "video" || inspectorLayer.type === "image" || inspectorLayer.type === "adjustment") ? (
                    <>
                      <div className="scopes-toggle-bar">
                        <button
                          className={`scopes-toggle-btn${scopesOpen ? " is-active" : ""}`}
                          type="button"
                          onClick={() => setScopesOpen((v) => !v)}
                          title={scopesOpen ? "Hide color scopes" : "Show color scopes"}
                        >
                          <SlidersHorizontal size={13} />
                          Scopes
                        </button>
                      </div>
                      {(() => {
                        // Source color-space notice: HDR/wide-gamut/log downcast (amber) or "Assumed Rec.709"
                        // (info). Detected Rec.709 SDR sources produce no warnings → nothing shown.
                        if (inspectorLayer.type !== "video" && inspectorLayer.type !== "image") return null;
                        const asset = inspectorLayer.assetId ? assets.find((a) => a.id === inspectorLayer.assetId) : undefined;
                        const warnings = sourceColorWarnings(asset?.color);
                        if (warnings.length === 0) return null;
                        const worst = warnings.find((w) => w.severity === "warning") ?? warnings[0]!;
                        return (
                          <div className={`source-color-notice${worst.severity === "warning" ? " is-warning" : ""}`} title={colorWarningsLabel(warnings)}>
                            {worst.message}
                          </div>
                        );
                      })()}
                      <ColdTime>
                        {(currentTime) => (
                          <>
                            {scopesOpen && (
                              <ColorScopes
                                containerRef={previewFrameRef}
                                sampleSource={sampleScopeFrame}
                                tick={Math.round(currentTime * 30)}
                                isPlaying={isPlaying}
                              />
                            )}
                            <LumetriPanel
                              layer={inspectorLayer}
                              currentTime={currentTime}
                              onChange={(updater) => updateLayer(inspectorLayer.id, updater)}
                              onSeek={setEditorCurrentTime}
                            />
                          </>
                        )}
                      </ColdTime>
                    </>
                  ) : (
                    <div className="empty-mini">
                      <SlidersHorizontal size={16} />
                      Select a video, image, or adjustment layer
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </aside>
          )}

          <div className="pane-resizer pane-resizer-vertical" role="separator" aria-orientation="vertical" onPointerDown={startHorizontalResize} />

          <section className={`editor-viewer${dualMonitors ? " is-dual" : ""}`} ref={viewerSectionRef}>
            {showSourceMonitor && !dualMonitors ? (
              <div className="viewer-monitor-tabs" role="tablist" aria-label="Monitor">
                <button
                  type="button"
                  role="tab"
                  className={activeMonitor === "source" ? "is-active" : ""}
                  aria-selected={activeMonitor === "source"}
                  onClick={() => setActiveMonitor("source")}
                >
                  Source
                </button>
                <button
                  type="button"
                  role="tab"
                  className={activeMonitor === "program" ? "is-active" : ""}
                  aria-selected={activeMonitor === "program"}
                  onClick={() => setActiveMonitor("program")}
                >
                  Program
                </button>
              </div>
            ) : null}
            <div
              className="viewer-monitors"
              style={dualMonitors ? { gridTemplateColumns: `minmax(0, ${sourceMonitorSplit}fr) 8px minmax(0, ${1 - sourceMonitorSplit}fr)` } : undefined}
            >
            {showSourceMonitor && (dualMonitors || activeMonitor === "source") ? (
              <SourceMonitor
                asset={sourceMonitorAsset!}
                inSeconds={sourceInSeconds}
                outSeconds={sourceOutSeconds}
                onSetIn={setSourceInSeconds}
                onSetOut={setSourceOutSeconds}
                onClearMarks={() => {
                  setSourceInSeconds(null);
                  setSourceOutSeconds(null);
                }}
                onClose={handleCloseSourceMonitor}
                onEdit={(op, srcIn, srcOut, mode) => void handleSourceMonitorEdit(op, srcIn, srcOut, mode)}
                onLoadAssetId={(assetId) => {
                  const dropped = resolvedAssets.find((item) => item.id === assetId);
                  if (dropped && (dropped.fileType.startsWith("video/") || dropped.fileType.startsWith("audio/"))) {
                    handleOpenInSourceMonitor(dropped);
                  }
                }}
              />
            ) : null}
            {dualMonitors ? (
              <div
                className="pane-resizer pane-resizer-vertical monitor-split-resizer"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startSourceProgramResize}
              />
            ) : null}
            <div
              className="program-monitor"
              hidden={showSourceMonitor && !dualMonitors && activeMonitor === "source"}
              onDragOver={(event) => {
                // A source-monitor drag dropped on the program viewer = INSERT at the playhead,
                // respecting the marked In/Out range + dragged V/A mode.
                if (event.dataTransfer.types.includes("application/x-kimera-source-drag")) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }
              }}
              onDrop={(event) => {
                const raw = event.dataTransfer.getData("application/x-kimera-source-drag");
                if (!raw) return;
                event.preventDefault();
                try {
                  const payload = JSON.parse(raw) as SourceDragPayload;
                  // Insert, NOT overwrite — a drop must never silently delete clips under the
                  // playhead (user report 2026-07-05); explicit Overwrite stays on the "." button.
                  void handleSourceMonitorEdit("insert", payload.sourceInSeconds, payload.sourceInSeconds + payload.durationSeconds, payload.mode);
                } catch {
                  /* malformed payload — ignore the drop */
                }
              }}
            >
            <VideoPreview
              graph={graph}
              composition={composition}
              currentTime={currentTimeRef.current}
              isPlaying={isPlaying}
              clockDriven
              previewQuality={previewQuality}
              viewMode={responsiveLayout.usesPhoneShell && timelineTool !== "hand" ? "fit" : viewMode}
              manualScale={manualScale}
              viewerPanMode={responsiveLayout.usesPhoneShell && timelineTool === "hand"}
              rotationSnapEnabled={responsiveLayout.usesPhoneShell && snapEnabled}
              assets={assets}
              selectedLayerId={selectedLayer?.id}
              frameRef={previewFrameRef}
              onFitScale={setFitScale}
              onZoomTo={zoomTo}
              onSaveFreezeFrame={stablePreviewSaveFreezeFrame}
              onMoveLayer={stablePreviewMoveLayer}
              onMovePositionKeyframe={stablePreviewMovePositionKeyframe}
              onMoveSpatialHandle={stablePreviewMoveSpatialHandle}
              onResizeShapeLayer={stablePreviewResizeShapeLayer}
              onResizeFrameLayer={stablePreviewResizeFrameLayer}
              onContentTransformLayer={stablePreviewContentTransformLayer}
              onRequestFillFrame={stableReplaceLayerAsset}
              onRotateLayer={stablePreviewRotateLayer}
              onScaleLayer={stablePreviewScaleLayer}
              onCropLayer={stablePreviewCropLayer}
              resolveProxyPlayback={resolveProxyPlayback}
              proxyCaptureRef={proxyCaptureRef}
              onPreviewFrameRendered={handlePreviewFrameRendered}
              onSelectLayer={stablePreviewSelectLayer}
              sourceAsset={project.sourceAsset}
              maskTool={maskTool}
              onChangeMaskTool={changeMaskTool}
              activeMaskId={activeMaskId ?? undefined}
              onSelectMask={setActiveMaskId}
              showMasks={showMasks}
              onToggleShowMasks={stablePreviewToggleShowMasks}
              maskEffectId={activeMaskEffectId}
              onPreviewMaskScalar={stablePreviewMaskScalar}
              onUpdateLayerMasks={stablePreviewUpdateLayerMasks}
              onCommitMaskPoints={stablePreviewCommitMaskPoints}
              onCommitShapePath={stablePreviewCommitShapePath}
            />
            {shuttleRate !== null && (
              <div className="viewer-shuttle-badge" aria-live="polite">
                {shuttleRate < 0 ? "◀◀" : "▶▶"} {Math.abs(shuttleRate)}×
              </div>
            )}
            <SlipTwoUpOverlay resolve={resolveSlipPreviewMedia} />
            {/* One CENTERED cluster (user request 2026-07-03 — the old left/center/right islands read
                as disconnected): readout · quality · transport · zoom, grouped around the transport. */}
            <div className="viewer-controls" aria-label="Viewer controls">
              <PlayheadTimeReadout fallback={currentTimeRef.current} />
              {/* Radio group: exactly ONE of ¼/½/1/A is selected. A manual pick is absolute (Auto off);
                  A hands resolution control to adaptive quality (balanced base, drops/recovers on load). */}
              <div className="preview-quality-control" aria-label="Playback resolution">
                {(["quality", "balanced", "performance"] as const).map((quality) => (
                  <button
                    className={!adaptiveResOn && previewQuality === quality ? "is-active" : ""}
                    key={quality}
                    type="button"
                    title={
                      quality === "quality"
                        ? "Full quality — plays ORIGINAL media (proxies bypassed), fixed resolution, turns Auto off"
                        : `${previewQualityLabel(quality)} playback resolution (proxy media — fixed, turns Auto off)`
                    }
                    onClick={() => {
                      setPreviewQuality(quality);
                      if (adaptiveResOn) {
                        setAdaptiveQualityOn(false);
                        setAdaptiveResOn(false);
                      }
                    }}
                  >
                    {quality === "performance" ? "¼" : quality === "balanced" ? "½" : "1"}
                  </button>
                ))}
                <button
                  className={adaptiveResOn ? "is-active" : ""}
                  type="button"
                  title="Auto: Kimera adjusts playback resolution while playing — drops it when frames are dropped, recovers when smooth. Pick ¼/½/1 for a fixed resolution instead."
                  onClick={() => {
                    if (adaptiveResOn) return; // radio semantics: deselect by picking a manual res
                    setPreviewQuality("balanced");
                    setAdaptiveQualityOn(true);
                    setAdaptiveResOn(true);
                  }}
                >
                  A
                </button>
              </div>
              <div className="viewer-transport-control" aria-label="Transport controls">
                <button type="button" title="Start (Home)" onClick={goToStart}>
                  <SkipBack size={16} />
                </button>
                <button type="button" title="Previous frame (←)" onClick={() => stepFrame(-1)}>
                  <StepBack size={16} />
                </button>
                <button type="button" title={isPlaying ? "Pause (Space)" : "Play (Space)"} onClick={togglePlayback}>
                  {isPlaying ? <Pause size={17} /> : <Play size={17} />}
                </button>
                <button type="button" title="Next frame (→)" onClick={() => stepFrame(1)}>
                  <StepForward size={16} />
                </button>
                <button type="button" title="End (End)" onClick={goToEnd}>
                  <SkipForward size={16} />
                </button>
              </div>
              <button
                type="button"
                className={`viewer-autokey-toggle${autoKeyframe ? " is-active" : ""}`}
                aria-pressed={autoKeyframe}
                title={
                  autoKeyframe
                    ? "Auto-keyframe ON — changing any value adds a keyframe at the playhead. Click to turn off."
                    : "Auto-keyframe OFF — changes edit the base value. Click to turn on."
                }
                onClick={() => setAutoKeyframe((on) => !on)}
              >
                <Diamond size={15} />
              </button>
              <button
                type="button"
                className={`viewer-autokey-toggle${bottomWorkspaceOpen ? " is-active" : ""}`}
                aria-pressed={bottomWorkspaceOpen}
                title={bottomWorkspaceOpen ? "Close graph editor (Shift+G)" : "Graph editor — animation curves (Shift+G)"}
                onClick={() => setBottomWorkspaceOpen((open) => !open)}
              >
                <Spline size={15} />
              </button>
              {/* Zoom: preset dropdown + Fit only — the old range slider ate ~120px of this row and
                  duplicated ctrl+wheel (user request 2026-07-05). Percentages are ACTUAL-SIZE zoom
                  (100% = 1 comp pixel per screen pixel), so the fit% option shows what fits. */}
              <label className="viewer-zoom-control" title="Viewer zoom">
                  <ThemedSelect
                    className="zoom-preset-select"
                    ariaLabel="Viewer zoom presets"
                    menuMinWidth={72}
                    menuPlacement="top"
                    value={viewMode === "fit" ? `fit:${Math.round(fitScale * 100)}` : String(manualScale)}
                  options={[
                    ...(viewMode === "fit" ? [{ value: `fit:${Math.round(fitScale * 100)}`, label: `${Math.round(fitScale * 100)}%` }] : []),
                    ...[0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((scale) => ({ value: String(scale), label: `${Math.round(scale * 100)}%` })),
                    ...(viewMode === "manual" && ![0.25, 0.5, 0.75, 1, 1.5, 2, 4].some((s) => Math.abs(manualScale - s) < 0.005)
                      ? [{ value: String(manualScale), label: `${Math.round(manualScale * 100)}%` }]
                      : [])
                  ]}
                  onChange={(next) => {
                    if (!next.startsWith("fit:")) zoomTo(Number(next));
                  }}
                />
                <button
                  type="button"
                  className={`zoom-fit-button${viewMode === "fit" ? " is-active" : ""}`}
                  title="Fit the composition to the viewer"
                  onClick={() => setViewMode("fit")}
                >
                  Fit
                </button>
              </label>
            </div>
            </div>
            </div>
          </section>

          <div className="pane-resizer pane-resizer-vertical pane-resizer-right" role="separator" aria-orientation="vertical" onPointerDown={startRightPaneResize} />

          {inspectorCollapsed && activeResponsiveOverlay !== "inspector" ? null : (
          <aside className={`editor-inspector scroll-performance-pane${activeResponsiveOverlay === "inspector" ? " is-responsive-overlay-open" : ""}${isResponsiveOverlayExpanded("inspector") ? " is-responsive-overlay-expanded" : ""}`} aria-label="Inspector">
            <div className="inspector-head">
              {/* One header row (density pass 2026-07-12): the clip chip IS the title — the old
                  "Inspector" h2 + chip + repeated .inspector-subtitle stack cost three rows. */}
              {inspectorLayer ? (
                <span className="inspector-head-badge" title={inspectorLayer.name || inspectorLayer.type}>
                  <Badge tone="muted">
                    <span className="inspector-layer-chip">
                      {inspectorLayer.type === "video" ? <Film size={11} />
                        : inspectorLayer.type === "image" ? <ImageIcon size={11} />
                        : inspectorLayer.type === "audio" ? <Music size={11} />
                        : inspectorLayer.type === "text" ? <Type size={11} />
                        : inspectorLayer.type === "shape" ? <Square size={11} />
                        : <SlidersHorizontal size={11} />}
                      <span className="inspector-layer-chip-name">{inspectorLayer.name || inspectorLayer.type.toUpperCase()}</span>
                    </span>
                  </Badge>
                </span>
              ) : (
                <h2>Inspector</h2>
              )}
              <div className="inspector-head-actions">
                {inspectorLayer ? (
                  <button
                    type="button"
                    title="Reset all controls"
                    aria-label="Reset all controls"
                    onClick={() =>
                      multiSelectPrimaryLayer && multiSelectPrimaryLayer.id === inspectorLayer.id
                        ? updateLayers(selectedLayerIds, resetLayerControls)
                        : updateLayer(inspectorLayer.id, resetLayerControls)
                    }
                  >
                    <RotateCcw size={14} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={responsiveLayout.usesPhoneShell ? (isResponsiveOverlayExpanded("inspector") ? "is-active" : "") : inspectorExpanded ? "is-active" : ""}
                  title={`${inspectorExpanded ? "Restore inspector height" : "Expand inspector — full height"} (${altKeyLabel}+R)`}
                  aria-label={inspectorExpanded ? "Restore inspector height" : "Expand inspector to full height"}
                  aria-keyshortcuts={`${altKeyLabel}+R`}
                  aria-pressed={responsiveLayout.usesPhoneShell ? isResponsiveOverlayExpanded("inspector") : inspectorExpanded}
                  onClick={() => {
                    if (responsiveLayout.usesPhoneShell) toggleResponsiveOverlayExpansion("inspector");
                    else setInspectorExpanded((value) => !value);
                  }}
                >
                  {(responsiveLayout.usesPhoneShell ? isResponsiveOverlayExpanded("inspector") : inspectorExpanded) ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
              </div>
            </div>
            {inspectorLayer ? (
              <>
                {multiSelectPrimaryLayer ? (
                  <div className="inspector-persisted-hint">
                    <Diamond size={13} /> Editing {selectedLayerIds.length} clips — changes apply to all
                  </div>
                ) : !selectedLayer ? (
                  <div className="inspector-persisted-hint">
                    <Eye size={13} /> Showing last selected
                  </div>
                ) : null}
                <ColdTime>
                  {(currentTime) => (
                <LayerInspector
                  {...inspectorHandlers}
                  assets={assets}
                  palette={imagePalette}
                  hideAssetBin
                  layer={inspectorLayer}
                  composition={composition}
                  currentTime={currentTime}
                  tracks={trackLibrary}
                  activeMaskId={activeMaskId ?? undefined}
                  autoKeyframe={autoKeyframe}
                  selectedLayerIds={selectedLayerIds}
                  primaryLayerId={multiSelectPrimaryLayer?.id ?? inspectorLayer.id}
                  nestedCompositions={graph?.compositions}
                  textStyles={graph?.textStyles}
                />
                  )}
                </ColdTime>
                {/* Template-slot marking lives BELOW the properties (density pass 2026-07-12) —
                    it's a save-as-template concern, not a per-edit control. */}
                <TemplateSlotControl layer={inspectorLayer} onChange={inspectorHandlers.onChange} />
              </>
            ) : selectedLayerIds.length > 1 ? (
              <div className="empty-mini">
                <Diamond size={16} />
                {selectedLayerIds.length} clips selected
                <small>Select one clip to edit its properties.</small>
              </div>
            ) : (
              <div className="empty-mini">
                <Eye size={16} />
                Select a clip to edit its properties
              </div>
            )}
          </aside>
          )}
        </div>

        <div className="pane-resizer pane-resizer-horizontal" role="separator" aria-orientation="horizontal" onPointerDown={startVerticalResize} />

        {/* Flex row: [scrolling timeline dock | audio meters]. The wrapper takes the dock's grid cell;
            the dock itself stays the untouched scroll container TimelineStrip's auto-follow depends on,
            and the meters get REAL reserved space outside the scroll area (no overlap, no click-block). */}
        {/* Column stack so the bottom workspace (graph editor drawer) borrows track space
            while the dock row above keeps its untouched scroll/auto-follow behavior. */}
        <div className="timeline-stack">
        <div className="timeline-dock-row">
        <section className="editor-timeline-dock">
          {nestPath.length > 0 ? (
            <div className="timeline-nest-breadcrumb">
              {nestPath.map((entry, index) => (
                <Fragment key={entry.id}>
                  <button type="button" onClick={() => handleReturnToBreadcrumb(entry)}>
                    {index === 0 ? <ChevronLeft size={13} /> : null} {entry.name}
                  </button>
                  <span>/</span>
                </Fragment>
              ))}
              <span className="timeline-nest-breadcrumb-current">{composition.name}</span>
            </div>
          ) : null}
          {/* All callback props arrive pre-stabilized via the timelineHandlers useStableHandlers
              block (see above the early return) so the memo'd strip only re-renders on real data
              changes: composition edits, selection, tool/zoom, and the cold playhead commit. */}
          <TimelineStrip
            {...timelineHandlers}
            assets={resolvedAssets}
            composition={composition}
            currentTime={currentTimeRef.current}
            isPlaying={isPlaying}
            layerMaxDurations={layerMaxDurations}
            playbackStart={playbackStart}
            selectedLayerId={selectedLayer?.id}
            selectedLayerIds={selectedLayerIds}
            trackHeight={timelineTrackHeight}
            canUndo={historyVersion >= 0 && undoStackRef.current.length > 0}
            canRedo={historyVersion >= 0 && redoStackRef.current.length > 0}
            toolMode={timelineTool}
            snapEnabled={snapEnabled}
            magneticEnabled={magneticEnabled}
            markers={timelineMarkers}
            inPointSeconds={composition.settings?.timeline.inPointSeconds ?? undefined}
            outPointSeconds={composition.settings?.timeline.outPointSeconds ?? undefined}
            proxyCacheSegments={proxyCacheSegments}
            proxyCacheStatus={proxyCacheStatus ?? undefined}
            livePlaybackMode={livePlaybackMode}
          />
        </section>
        {/* Track mixer (faders/pan/mute/solo) + Premiere-style master meters — flex siblings of the
            dock, so they never overlap it. Meters: imperative canvas + audio-thread analysis. */}
        {responsiveLayout.showDedicatedMixer ? (
          <ColdTime>
            {(currentTime) => (
              <AudioMixerPanel
                composition={composition}
                currentTime={currentTime}
                onChangeTrackAudio={handleChangeTrackAudio}
                onToggleTrackKeyframe={(trackId, property) => void handleToggleTrackAudioKeyframe(trackId, property)}
                onClearTrackKeyframes={(trackId, property) => void handleClearTrackAudioKeyframes(trackId, property)}
                onSeek={setEditorCurrentTime}
                onToggleTrack={(trackId, patch) => void handleToggleTrack(trackId, patch)}
                onAutoDuck={handleAutoDuck}
              />
            )}
          </ColdTime>
        ) : null}
        {responsiveLayout.showDedicatedAudio ? <TimelineAudioMeters isPlaying={isPlaying} /> : null}
        </div>
        {bottomWorkspaceOpen ? (
          <ColdTime>
            {(currentTime) => (
              <BottomWorkspace
                layer={inspectorLayer ?? null}
                onChange={inspectorHandlers.onGraphChange}
                currentTime={currentTime}
                onSeek={setEditorCurrentTime}
                fps={composition.fps}
                focusTargetKey={graphFocusTargetKey}
                ghostLayers={graphGhostLayers}
                onClose={() => setBottomWorkspaceOpen(false)}
              />
            )}
          </ColdTime>
        ) : null}
        </div>
      </div>
      {responsiveLayout.usesOverlayPanels && activeResponsiveOverlay ? (
        <button type="button" className="editor-responsive-backdrop" aria-label="Close panel" onClick={() => setActiveResponsiveOverlay(null)} />
      ) : null}
      {responsiveLayout.usesOverlayPanels && activeResponsiveOverlay === "audio" ? (
        <aside className={`editor-responsive-sheet editor-responsive-audio-sheet${isResponsiveOverlayExpanded("audio") ? " is-responsive-overlay-expanded" : ""}`} aria-label="Audio mixer">
          <div className="editor-responsive-sheet-head">
            <strong>Audio</strong>
            <div className="editor-responsive-sheet-head-actions">
              {responsiveLayout.usesPhoneShell ? (
                <button
                  type="button"
                  className={isResponsiveOverlayExpanded("audio") ? "is-active" : ""}
                  aria-label={isResponsiveOverlayExpanded("audio") ? "Use half-height audio panel" : "Use full-height audio panel"}
                  aria-pressed={isResponsiveOverlayExpanded("audio")}
                  title={isResponsiveOverlayExpanded("audio") ? "Use half-height panel" : "Use full-height panel"}
                  onClick={() => toggleResponsiveOverlayExpansion("audio")}
                >
                  {isResponsiveOverlayExpanded("audio") ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
              ) : null}
              <button type="button" aria-label="Close audio" onClick={() => setActiveResponsiveOverlay(null)}>
                <X size={16} />
              </button>
            </div>
          </div>
          <ColdTime>
            {(currentTime) => (
              <AudioMixerPanel
                composition={composition}
                currentTime={currentTime}
                forceOpen={responsiveLayout.usesOverlayPanels}
                onChangeTrackAudio={handleChangeTrackAudio}
                onToggleTrackKeyframe={(trackId, property) => void handleToggleTrackAudioKeyframe(trackId, property)}
                onClearTrackKeyframes={(trackId, property) => void handleClearTrackAudioKeyframes(trackId, property)}
                onSeek={setEditorCurrentTime}
                onToggleTrack={(trackId, patch) => void handleToggleTrack(trackId, patch)}
                onAutoDuck={handleAutoDuck}
              />
            )}
          </ColdTime>
          <TimelineAudioMeters isPlaying={isPlaying} />
        </aside>
      ) : null}
      {responsiveLayout.usesOverlayPanels ? (
        <nav className="editor-mobile-rail" aria-label="Mobile editor panels">
          <button
            type="button"
            className={activeResponsiveOverlay === "assets" ? "is-active" : ""}
            onClick={() => {
              setPanelTab("assets");
              setPanelCollapsed(false);
              setActiveResponsiveOverlay(activeResponsiveOverlay === "assets" ? null : "assets");
            }}
          >
            <Image size={16} />
            Assets
          </button>
          <button
            type="button"
            className={activeResponsiveOverlay === "inspector" ? "is-active" : ""}
            disabled={!inspectorLayer}
            onClick={() => {
              setInspectorCollapsed(false);
              setActiveResponsiveOverlay(activeResponsiveOverlay === "inspector" ? null : "inspector");
            }}
          >
            <SlidersHorizontal size={16} />
            Inspector
          </button>
          <button type="button" className={activeResponsiveOverlay === "audio" ? "is-active" : ""} onClick={() => setActiveResponsiveOverlay(activeResponsiveOverlay === "audio" ? null : "audio")}>
            <Music size={16} />
            Audio
          </button>
          <button type="button" className={aiPanelOpen ? "is-active" : ""} title={`Toggle AI assistant (${shortcutModifierLabel}+/)`} aria-keyshortcuts={`${shortcutModifierLabel}+/`} onClick={() => { setActiveResponsiveOverlay(null); setAiPanelOpen((open) => !open); }}>
            <Sparkles size={16} />
            AI
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveResponsiveOverlay(null);
              if (localExportSupported) {
                setExportFps(null);
                setExportFormat("mp4");
                setExportDialogOpen(true);
              } else {
                void renderFinal();
              }
            }}
          >
            <Download size={16} />
            Export
          </button>
        </nav>
      ) : null}
      {(aiPanelOpen || aiVoiceWanted || aiVoiceActive || aiWakeArmed) && composition ? (
        <aside
          className={`ai-dock${isResponsiveOverlayExpanded("ai") ? " is-responsive-overlay-expanded" : ""}${aiPanelOpen ? "" : " is-voice-only"}`}
          aria-label="AI"
        >
          {responsiveLayout.usesPhoneShell ? (
            <button
              type="button"
              className={`editor-responsive-floating-expand${isResponsiveOverlayExpanded("ai") ? " is-active" : ""}`}
              aria-label={isResponsiveOverlayExpanded("ai") ? "Use half-height AI panel" : "Use full-height AI panel"}
              aria-pressed={isResponsiveOverlayExpanded("ai")}
              title={isResponsiveOverlayExpanded("ai") ? "Use half-height panel" : "Use full-height panel"}
              onClick={() => toggleResponsiveOverlayExpansion("ai")}
            >
              {isResponsiveOverlayExpanded("ai") ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          ) : null}
          <Suspense fallback={null}>
          <AiChatPanel
            focusToken={aiFocusToken}
            micToggleToken={aiMicToggleToken}
            voiceToggleToken={aiVoiceToggleToken}
            onVoiceSessionChange={handleVoiceSessionChange}
            onWakeWordChange={handleWakeWordChange}
            resolveAssetUrl={aiPanelHandlers.resolveAssetUrl}
            getContext={aiPanelHandlers.getContext}
            commitComposition={aiPanelHandlers.commitComposition}
            openTool={aiPanelHandlers.openTool}
            onUndo={aiPanelHandlers.onUndo}
            runEditorCommand={runEditorCommand}
            onClose={aiPanelHandlers.onClose}
            onOpenGenerate={aiPanelHandlers.onOpenGenerate}
            onAddAssetToTimeline={aiPanelHandlers.onAddAssetToTimeline}
            {...(projectId ? { projectId } : {})}
          />
          </Suspense>
        </aside>
      ) : null}
      {generateStudioOpen ? (
        <Suspense fallback={null}>
          <GenerateStudio
            open={generateStudioOpen}
            onClose={() => setGenerateStudioOpen(false)}
            onAssetCreated={registerAsset}
            onAddToTimeline={(asset) => void stableAddAssetToTimeline(asset, "auto")}
            {...(projectId ? { projectId } : {})}
            {...(generateStudioPrefill ? { initial: generateStudioPrefill } : {})}
          />
        </Suspense>
      ) : null}
      {activeLayerToolEffect && composition && activeLayerToolEffect.tool.slug === "smart-3d-follow-text" ? (
        <Suspense fallback={null}>
          <SmartFollowTextEffectModal
            tool={activeLayerToolEffect.tool}
            asset={activeLayerToolEffect.asset}
            composition={composition}
            onApplied={(nextComposition, savedTracks) => {
              void applySmartFollowTextResult(nextComposition, savedTracks);
              setActiveLayerToolEffect(undefined);
              resolveToolStep({ applied: true, composition: nextComposition, detail: "Applied" });
            }}
            onClose={() => {
              setActiveLayerToolEffect(undefined);
              resolveToolStep({ applied: false, detail: "Cancelled" });
            }}
          />
        </Suspense>
      ) : activeLayerToolEffect && composition ? (
        <Suspense fallback={null}>
          <ToolEffectRunnerModal
            tool={activeLayerToolEffect.tool}
            layer={activeLayerToolEffect.layer}
            asset={activeLayerToolEffect.asset}
            composition={composition}
            editableFields={graph?.editableFields}
            onApplied={(nextComposition, editableFieldsPatch) => {
              void applyToolEffectResult(nextComposition, editableFieldsPatch);
              setActiveLayerToolEffect(undefined);
              setNotice("Effect applied");
              resolveToolStep({ applied: true, composition: nextComposition, detail: "Applied" });
            }}
            onClose={() => {
              setActiveLayerToolEffect(undefined);
              resolveToolStep({ applied: false, detail: "Cancelled" });
            }}
          />
        </Suspense>
      ) : null}
      {trackModalState && mainTrackableAsset && composition ? (
        <Suspense fallback={null}>
          <TrackWorkspaceModal
            asset={mainTrackableAsset}
            composition={composition}
            existingTrack={trackModalState.editingTrackId ? trackLibrary.find((item) => item.id === trackModalState.editingTrackId) : undefined}
            onClose={() => setTrackModalState(undefined)}
            onSave={handleSaveTracks}
          />
        </Suspense>
      ) : null}
      {templateModalOpen ? (
        <SaveTemplateModal
          defaultName={project?.title ? `${project.title} Template` : "My Template"}
          saving={busy === "template"}
          onClose={() => setTemplateModalOpen(false)}
          onSave={handleSaveAsTemplate}
        />
      ) : null}
      <PasteAttributesModal
        open={pasteAttributesModalOpen}
        targetCount={selectedLayerIdsRef.current.filter((id) => isLayerEditable(id)).length}
        onClose={() => setPasteAttributesModalOpen(false)}
        onApply={(groups) => {
          if (!composition) return;
          const editable = selectedLayerIdsRef.current.filter((id) => isLayerEditable(id));
          if (!editable.length) return;
          void updateComposition(pasteLayerAttributes(composition, editable, groups)).then(() => {
            setNotice(`Attributes pasted onto ${editable.length} clip${editable.length === 1 ? "" : "s"}`);
          });
        }}
      />
      <ExternalTimelineImportModal
        imported={pendingExternalTimelineImport}
        mode={externalTimelineImportMode}
        applying={busy === "timeline-import"}
        onModeChange={setExternalTimelineImportMode}
        onApply={() => void applyPendingExternalTimelineImport(externalTimelineImportMode)}
        onSelectSequence={reparseExternalTimelineWithSequence}
        onClose={() => {
          setPendingExternalTimelineImport(null);
          setPendingExternalTimelineSource(null);
        }}
      />
      <RelinkMediaModal
        open={relinkNeeds !== null}
        assets={relinkNeeds ?? []}
        onClose={() => setRelinkNeeds(null)}
        onResolved={() => {
          setRelinkNeeds(null);
          void renderFinal();
        }}
      />
      {/* Close (X) keeps the checkpoint and re-offers next open; only Discard deletes it. */}
      {recoveryOffer ? (
        <Modal title="Restore unsaved changes?" open onClose={() => setRecoveryOffer(null)}>
          <div className="export-settings">
            <p className="local-export-hint">
              This project has edits from {new Date(recoveryOffer.savedAt).toLocaleString()} that were not
              saved before the last session ended. Restore them? (Restoring is undoable.)
            </p>
            <div className="export-settings-actions">
              <Button variant="secondary" onClick={discardRecoveryOffer}>
                Discard
              </Button>
              <Button onClick={() => void restoreRecoveryOffer()}>Restore</Button>
            </div>
          </div>
        </Modal>
      ) : null}
      {exportDialogOpen && composition
        ? (() => {
            const projFps = composition.fps || 30;
            const choices = Array.from(new Set([projFps, 23.976, 24, 25, 29.97, 30, 50, 60])).sort((a, b) => a - b);
            const fmtFps = (f: number) => (f % 1 === 0 ? String(f) : f.toFixed(3));
            // Composition-wide color warning: any video/image source with detected/assumed HDR, wide-gamut,
            // or log color that this Rec.709 SDR milestone can't master exactly. Exact WebGL grading is never
            // blocked on this — surfaced as an informational warning per the plan ("warn, don't block").
            const usedAssetIds = new Set(
              composition.tracks.flatMap((track) =>
                track.layers
                  .filter((layer) => (layer.type === "video" || layer.type === "image") && layer.assetId)
                  .map((layer) => layer.assetId!)
              )
            );
            const compositionColorWarnings = Array.from(usedAssetIds)
              .flatMap((assetId) => sourceColorWarnings(assets.find((a) => a.id === assetId)?.color))
              .filter((w) => w.severity === "warning");
            const worstCompositionColorWarning = compositionColorWarnings[0];
            const fpsGroups: ThemedSelectGroup<string>[] = [
              {
                label: "Frame rate",
                options: choices.map((f) => ({ value: String(f), label: `${fmtFps(f)} fps${f === projFps ? " · project" : ""}` }))
              }
            ];
            const formatGroups: ThemedSelectGroup<ExportFormat>[] = [
              { label: "Format", options: [{ value: "mp4", label: "MP4 (H.264)" }, { value: "webm", label: "WebM (VP9)" }] }
            ];
            return (
              <Modal title="Export on this device" open onClose={() => setExportDialogOpen(false)}>
                <div className="export-settings">
                  <label className="export-settings-row">
                    <span>Frame rate</span>
                    <ThemedSelect ariaLabel="Export frame rate" value={String(exportFps ?? projFps)} groups={fpsGroups} onChange={(v) => setExportFps(Number(v))} />
                  </label>
                  <label className="export-settings-row">
                    <span>Format</span>
                    <ThemedSelect ariaLabel="Export format" value={exportFormat} groups={formatGroups} onChange={setExportFormat} />
                  </label>
                  {worstCompositionColorWarning ? (
                    <div className="export-color-warning" title={colorWarningsLabel(compositionColorWarnings)}>
                      {worstCompositionColorWarning.message} Export proceeds as Rec.709 SDR.
                    </div>
                  ) : null}
                  <p className="local-export-hint">Renders on this device (in a background worker). Nothing is uploaded.</p>
                  <div className="export-settings-actions">
                    <Button variant="secondary" onClick={() => setExportDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button variant="secondary" onClick={() => openIsolatedDeviceExport(exportFps ?? projFps, exportFormat)}>
                      Separate tab
                    </Button>
                    <Button icon={<MonitorDown size={16} />} onClick={() => exportOnDevice(exportFps ?? projFps, exportFormat)}>
                      Export
                    </Button>
                  </div>
                </div>
              </Modal>
            );
          })()
        : null}
      {localExport ? (
        <Modal title="Exporting on this device" open onClose={() => localExportAbortRef.current?.abort()}>
          <div className="local-export-progress">
            <div className="local-export-bar">
              <span style={{ width: `${Math.round(localExport.progress * 100)}%` }} />
            </div>
            <p className="local-export-label">{localExport.label}</p>
            <p className="local-export-hint">Rendering on this device in a background worker. Keep this tab open.</p>
            <Button variant="secondary" onClick={() => localExportAbortRef.current?.abort()}>
              Cancel
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
    </AutoKeyframeContext.Provider>
  );
}

function ExternalTimelineImportModal({
  imported,
  mode,
  applying,
  onModeChange,
  onApply,
  onSelectSequence,
  onClose
}: {
  imported: ImportedExternalTimeline | null;
  mode: ExternalTimelineImportMode;
  applying: boolean;
  onModeChange: (mode: ExternalTimelineImportMode) => void;
  onApply: () => void;
  onSelectSequence?: ((sequenceId: string) => void) | undefined;
  onClose: () => void;
}) {
  if (!imported) {
    return null;
  }
  const report = imported.report;
  const sections: Array<{ title: string; items: TimelineImportReportItem[]; empty: string }> = [
    { title: "Imported", items: report.imported, empty: "No clips imported." },
    { title: "Mapped", items: report.mapped, empty: "No external features needed mapping." },
    { title: "Skipped", items: report.skipped, empty: "Nothing skipped." },
    { title: "Unsupported", items: report.unsupported, empty: "No unsupported items detected." }
  ];

  return (
    <Modal title="Review Timeline Import" open className="timeline-import-modal" onClose={onClose}>
      <div className="timeline-import-summary">
        <div>
          <span>Format</span>
          <strong>{report.format.toUpperCase()}</strong>
        </div>
        <div>
          <span>Timeline</span>
          <strong>{report.title}</strong>
        </div>
        <div>
          <span>Clips</span>
          <strong>{report.counts.clips}</strong>
        </div>
        <div>
          <span>Size</span>
          <strong>
            {report.width}x{report.height} · {report.fps.toFixed(report.fps % 1 === 0 ? 0 : 2)} fps
          </strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>{report.durationSeconds.toFixed(2)}s</strong>
        </div>
        <div>
          <span>Relink</span>
          <strong>{report.counts.placeholders} placeholder{report.counts.placeholders === 1 ? "" : "s"}</strong>
        </div>
      </div>
      {report.availableSequences?.length ? (
        <label className="timeline-import-sequence-picker">
          <span>Sequence ({report.availableSequences.length} found)</span>
          <select
            value={report.availableSequences.find((s) => s.selected)?.id ?? ""}
            disabled={applying || !onSelectSequence}
            onChange={(event) => onSelectSequence?.(event.target.value)}
          >
            {report.availableSequences.map((seq) => (
              <option key={seq.id} value={seq.id}>
                {seq.name} ({seq.clipCount} clip{seq.clipCount === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="timeline-import-mode" role="group" aria-label="Timeline import mode">
        <button type="button" className={mode === "append" ? "is-active" : ""} aria-pressed={mode === "append"} onClick={() => onModeChange("append")} disabled={applying}>
          Append to current
        </button>
        <button type="button" className={mode === "replace" ? "is-active" : ""} aria-pressed={mode === "replace"} onClick={() => onModeChange("replace")} disabled={applying}>
          New timeline
        </button>
      </div>
      <div className="timeline-import-report">
        {sections.map((section) => (
          <section key={section.title}>
            <header>
              <h3>{section.title}</h3>
              <Badge tone={section.title === "Unsupported" && section.items.length ? "danger" : "muted"}>
                {section.items.length}
              </Badge>
            </header>
            <div className="timeline-import-report-list">
              {section.items.length ? (
                section.items.slice(0, 8).map((item, index) => (
                  <p key={`${item.code}-${item.sourceId ?? index}`}>
                    <strong>{item.code}</strong>
                    <span>{item.message}</span>
                  </p>
                ))
              ) : (
                <p className="timeline-import-empty">{section.empty}</p>
              )}
              {section.items.length > 8 ? <p className="timeline-import-empty">+{section.items.length - 8} more in the saved import report.</p> : null}
            </div>
          </section>
        ))}
      </div>
      <div className="timeline-import-actions">
        <Button variant="secondary" onClick={onClose} disabled={applying}>
          Cancel
        </Button>
        <Button icon={<Upload size={16} />} onClick={onApply} disabled={applying}>
          {applying ? "Importing..." : mode === "append" ? "Append to project" : "Create timeline"}
        </Button>
      </div>
    </Modal>
  );
}

function appendTimelineComposition(
  current: TimelineComposition,
  imported: TimelineComposition,
  projectId: string
): { composition: TimelineComposition; offsetSeconds: number } {
  const offsetSeconds = Math.round(compositionEndSeconds(current) * 1000) / 1000;
  const importToken = `timeline_import_${Date.now().toString(36)}`;
  const linkedGroupIds = new Map<string, string>();
  const remapLinkedGroupId = (id: string | undefined) => {
    if (!id) return undefined;
    const existing = linkedGroupIds.get(id);
    if (existing) return existing;
    const next = `${importToken}_${sanitizeTimelineImportId(id)}`;
    linkedGroupIds.set(id, next);
    return next;
  };
  const importedTracks = imported.tracks.map((track, trackIndex) => {
    const newTrackId = `${projectId}_${importToken}_${track.type}_${trackIndex + 1}`;
    return {
      ...track,
      id: newTrackId,
      name: `Imported ${track.name}`,
      layers: track.layers.map((layer, layerIndex) => {
        const newLayerId = `${newTrackId}_${sanitizeTimelineImportId(layer.id)}_${layerIndex + 1}`;
        return {
          ...layer,
          id: newLayerId,
          trackId: newTrackId,
          startSeconds: Math.round((layer.startSeconds + offsetSeconds) * 1000) / 1000,
          linkedGroupId: remapLinkedGroupId(layer.linkedGroupId),
          slot: layer.slot
            ? {
                ...layer.slot,
                key: `${importToken}_${sanitizeTimelineImportId(layer.slot.key)}`
              }
            : undefined
        };
      })
    };
  });
  const durationSeconds = Math.max(
    current.durationSeconds,
    offsetSeconds + imported.durationSeconds,
    ...importedTracks.flatMap((track) => track.layers.map((layer) => layer.startSeconds + layer.durationSeconds))
  );
  const currentVisualTracks = current.tracks.filter((track) => track.type !== "audio");
  const currentAudioTracks = current.tracks.filter((track) => track.type === "audio");
  const importedVisualTracks = importedTracks.filter((track) => track.type !== "audio");
  const importedAudioTracks = importedTracks.filter((track) => track.type === "audio");
  return {
    offsetSeconds,
    composition: {
      ...current,
      durationSeconds,
      tracks: [...importedVisualTracks, ...currentVisualTracks, ...currentAudioTracks, ...importedAudioTracks],
      settings: current.settings
        ? {
            ...current.settings,
            timeline: {
              ...current.settings.timeline,
              baseDurationSeconds: Math.max(current.settings.timeline.baseDurationSeconds, durationSeconds)
            }
          }
        : current.settings
    }
  };
}

function compositionEndSeconds(composition: TimelineComposition): number {
  return Math.max(0, composition.durationSeconds, ...flattenTimelineLayers(composition).map((layer) => layer.startSeconds + layer.durationSeconds));
}

function sanitizeTimelineImportId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "item"
  );
}

function readTimelineImportReports(value: unknown): ImportedExternalTimeline["report"][] {
  return Array.isArray(value) ? value.filter((item): item is ImportedExternalTimeline["report"] => Boolean(item && typeof item === "object")) : [];
}

async function readExternalTimelineFileText(file: File): Promise<string> {
  if (!file.name.toLowerCase().endsWith(".prproj")) {
    return file.text();
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) {
    return new TextDecoder().decode(bytes);
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress .prproj files. Export Final Cut Pro XML from Premiere and import the .xml file instead.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function TemplateSlotControl({ layer, onChange }: { layer: TimelineLayer; onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void }) {
  const defaultKind: "media" | "text" | "color" =
    layer.type === "video" || layer.type === "image" || layer.type === "audio" ? "media" : layer.type === "text" ? "text" : "color";
  const slot = layer.slot;

  return (
    <div className="template-slot-control">
      <label className="template-slot-toggle">
        <input
          type="checkbox"
          checked={Boolean(slot)}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              slot: event.target.checked
                ? { key: slot?.key ?? `${defaultKind}_${current.id.slice(-6)}`, label: slot?.label ?? current.name, kind: slot?.kind ?? defaultKind, replaceable: true }
                : undefined
            }))
          }
        />
        <span>Template slot</span>
        <small>Mark this clip as user-replaceable when saved as a template.</small>
      </label>
      {slot ? (
        <label className="template-slot-label">
          <span>Slot label</span>
          <input
            value={slot.label}
            onChange={(event) => onChange((current) => (current.slot ? { ...current, slot: { ...current.slot, label: event.target.value } } : current))}
          />
        </label>
      ) : null}
    </div>
  );
}

function SaveTemplateModal({
  defaultName,
  saving,
  onClose,
  onSave
}: {
  defaultName: string;
  saving: boolean;
  onClose: () => void;
  onSave: (input: { name: string; category: string; description: string }) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [category, setCategory] = useState("Custom");
  const [description, setDescription] = useState("");

  return (
    <div className="timeline-context-backdrop" onClick={onClose}>
      <div className="save-template-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h3>Save as Template</h3>
          <p>Your composition, effects and slots become a reusable template anyone can start from.</p>
        </header>
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Template name" />
        </label>
        <label>
          <span>Category</span>
          <input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="e.g. Captions, Promo" />
        </label>
        <label>
          <span>Description</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this template for?" rows={3} />
        </label>
        <div className="save-template-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => onSave({ name: name.trim() || defaultName, category: category.trim(), description: description.trim() })} disabled={saving || name.trim().length < 2}>
            {saving ? "Saving…" : "Save template"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Monotonic tail for layer ids: `layer_${Date.now()}_${index}` alone COLLIDES when two layers are
// minted in the same millisecond from the same composition snapshot (same index) — the collision
// rendered fine and then the dedupe healer fired on the next edit ("trim deleted my clip",
// 2026-07-04). The counter makes every id unique within a session; the timestamp keeps them unique
// across sessions.
let layerIdTail = 0;

function createEditorLayer(
  type: TimelineLayerType,
  track: TimelineTrack,
  composition: TimelineComposition,
  index: number,
  startAtSeconds?: number,
  shapeOptions?: ShapeAddOptions
): TimelineLayer {
  const id = `layer_${Date.now()}_${index}_${(layerIdTail += 1)}`;
  const defaultDuration = type === "shape" ? 2 : type === "adjustment" ? 3 : 3;
  const startSeconds =
    startAtSeconds === undefined
      ? Math.min(1, Math.max(0, composition.durationSeconds - defaultDuration))
      : clamp(startAtSeconds, 0, Math.max(0, composition.durationSeconds - 0.2));
  const durationSeconds =
    type === "audio"
      ? composition.durationSeconds
      : Math.min(defaultDuration, Math.max(0.2, composition.durationSeconds - startSeconds));
  const base: TimelineLayer = {
    id,
    trackId: track.id,
    type,
    name: `${labelForLayer(type)} ${index}`,
    startSeconds,
    durationSeconds,
    fit: type === "image" || type === "video" ? defaultMediaFit(type) : undefined,
    transform: {
      position: { x: 50, y: type === "text" ? 62 : 50 },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    effects: [],
    keyframes: []
  };

  if (type === "adjustment") {
    return {
      ...base,
      name: `Adjustment clip ${index}`,
      transform: {
        position: { x: 50, y: 50 },
        scale: 1,
        rotation: 0,
        opacity: 100
      }
    };
  }

  if (type === "text") {
    return {
      ...base,
      text: "Text",
      fontFamily: renderSafeFonts[0].family,
      fontSize: 72,
      textAlign: "center",
      textWidthPercent: 0,
      color: "#FFFFFF",
      strokeWidth: 0
    };
  }

  if (type === "shape") {
    return {
      ...base,
      name: `${shapeOptions?.name ?? "Shape"} ${index}`,
      ...defaultShapeStyle,
      ...(shapeOptions
        ? {
            shapeKind: shapeOptions.shapeKind,
            widthPercent: shapeOptions.widthPercent,
            heightPercent: shapeOptions.heightPercent,
            borderRadius: shapeOptions.borderRadius
            // Pen shapes start with NO shapePath (renders nothing): handleAddLayer arms the viewer
            // pen tool so the user draws the outline, which commits the real geometry. Seeding the
            // old default blob here made "add pen" look like it inserted an ellipse.
          }
        : { shapeKind: defaultShapeStyle.shapeKind }),
      durationSeconds: Math.min(2, composition.durationSeconds),
      transform: {
        position: { x: 50, y: 50 },
        scale: 1,
        rotation: 0,
        opacity: 82
      }
    };
  }

  return base;
}

function labelForLayer(type: TimelineLayerType) {
  if (type === "text") return "Text";
  if (type === "audio") return "Audio";
  if (type === "video") return "Video";
  if (type === "image") return "Image";
  if (type === "adjustment") return "Adjustment";
  return "Shape";
}

function findLatestRenderJob(jobs: RenderJob[], type: RenderJob["type"]) {
  return [...jobs]
    .filter((job) => job.type === type)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

function mergeImportedPluginLibraries(a: ImportedPluginLibrary, b: ImportedPluginLibrary): ImportedPluginLibrary {
  const effects = new Map(a.effects.map((item) => [item.id, item]));
  const looks = new Map(a.looks.map((item) => [item.id, item]));
  const transitions = new Map(a.transitions.map((item) => [item.id, item]));
  for (const item of b.effects) effects.set(item.id, item);
  for (const item of b.looks) looks.set(item.id, item);
  for (const item of b.transitions) transitions.set(item.id, item);
  return effects.size || looks.size || transitions.size
    ? { effects: [...effects.values()], looks: [...looks.values()], transitions: [...transitions.values()] }
    : EMPTY_IMPORTED_PLUGIN_LIBRARY;
}

// The center title badge shows the persistent project LIFECYCLE status (draft/…). Readiness is
// already surfaced live by the right-hand SyncBadge ("Export ready"), so we hide the center badge
// for any ready/exported status to avoid the duplicate-"export ready" look (user 2026-07-07) — the
// center badge then has one clear job: flag a work-in-progress Draft.
const READY_PROJECT_STATUSES = new Set(["export_ready", "exported", "published", "rendered", "complete", "completed", "ready"]);

function isReadyProjectStatus(status: string): boolean {
  return READY_PROJECT_STATUSES.has(status.trim().toLowerCase());
}

function formatProjectStatus(status: string): string {
  return status.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function getRenderNotice(activeJob: RenderJob | undefined, latestFinalJob: RenderJob | undefined, fallback: string) {
  if (activeJob?.type === "final") {
    if (activeJob.status === "queued") {
      const queuedForMs = Date.now() - new Date(activeJob.createdAt).getTime();
      return queuedForMs > 15000 ? "Export 0% - waiting for renderer" : "Export 0% - waiting to start";
    }

    return `Export ${activeJob.progress}%`;
  }

  if (activeJob?.type === "preview") {
    return activeJob.status === "queued" ? "Preview 0% - waiting to start" : `Preview ${activeJob.progress}%`;
  }

  if (latestFinalJob?.status === "failed") {
    return latestFinalJob.errorMessage ? `Export failed: ${latestFinalJob.errorMessage}` : "Export failed";
  }

  if (latestFinalJob?.status === "completed") {
    return "Export ready";
  }

  return fallback;
}

function buildLayerMaxDurations(composition: TimelineComposition, assets: SourceAsset[], compositions?: Record<string, TimelineComposition> | undefined) {
  return flattenTimelineLayers(composition).reduce<Record<string, number>>((durations, layer) => {
    durations[layer.id] = getLayerMaxDuration(layer, assets, composition.durationSeconds, compositions);
    return durations;
  }, {});
}

function normalizeCompositionDuration(composition: TimelineComposition): TimelineComposition {
  const settings = getCompositionSettings(composition);
  const contentEndSeconds = Math.max(
    settings.timeline.baseDurationSeconds,
    ...flattenTimelineLayers(composition).map((layer) => layer.startSeconds + layer.durationSeconds)
  );
  const contentOnlyEndSeconds = Math.max(0.2, ...flattenTimelineLayers(composition).map((layer) => layer.startSeconds + layer.durationSeconds));
  const growPadding = settings.timeline.autoGrow && contentOnlyEndSeconds > settings.timeline.baseDurationSeconds ? settings.timeline.tailPaddingSeconds : 0;
  const durationSeconds = Math.max(0.2, contentEndSeconds + growPadding);
  const nextSettings: TimelineCompositionSettings = {
    ...settings,
    timeline: {
      ...settings.timeline,
      baseDurationSeconds: settings.timeline.baseDurationSeconds
    }
  };
  return {
    ...composition,
    settings: nextSettings,
    durationSeconds
  };
}

const compositionViewportPresets: Array<{
  id: TimelineCompositionSettings["viewport"]["preset"];
  label: string;
  width: number;
  height: number;
  fps: number;
}> = [
  { id: "vertical_1080x1920", label: "Reel 9:16", width: 1080, height: 1920, fps: 30 },
  { id: "landscape_1920x1080", label: "HD 16:9", width: 1920, height: 1080, fps: 30 },
  { id: "square_1080", label: "Square", width: 1080, height: 1080, fps: 30 },
  { id: "youtube_4k", label: "4K 16:9", width: 3840, height: 2160, fps: 30 }
];

function getCompositionSettings(composition: TimelineComposition): TimelineCompositionSettings {
  return {
    viewport: {
      preset: composition.settings?.viewport.preset ?? detectViewportPreset(composition.width, composition.height),
      width: composition.settings?.viewport.width ?? composition.width,
      height: composition.settings?.viewport.height ?? composition.height,
      fps: composition.settings?.viewport.fps ?? composition.fps,
      backgroundColor: composition.settings?.viewport.backgroundColor ?? composition.backgroundColor,
      resizeBehavior: composition.settings?.viewport.resizeBehavior ?? "keep-layout"
    },
    timeline: {
      baseDurationSeconds: composition.settings?.timeline.baseDurationSeconds ?? composition.durationSeconds,
      autoGrow: composition.settings?.timeline.autoGrow ?? true,
      tailPaddingSeconds: composition.settings?.timeline.tailPaddingSeconds ?? 1,
      snapSeconds: composition.settings?.timeline.snapSeconds ?? 0.1,
      timeDisplay: composition.settings?.timeline.timeDisplay ?? "seconds",
      markers: composition.settings?.timeline.markers ?? [],
      inPointSeconds: composition.settings?.timeline.inPointSeconds ?? undefined,
      outPointSeconds: composition.settings?.timeline.outPointSeconds ?? undefined
    }
  };
}

function applyCompositionSettings(composition: TimelineComposition, settings: TimelineCompositionSettings): TimelineComposition {
  return normalizeCompositionDuration({
    ...composition,
    width: clamp(Math.round(settings.viewport.width), 320, 7680),
    height: clamp(Math.round(settings.viewport.height), 320, 7680),
    fps: clamp(Math.round(settings.viewport.fps), 1, 120),
    backgroundColor: settings.viewport.backgroundColor,
    durationSeconds: Math.max(0.2, settings.timeline.baseDurationSeconds),
    settings
  });
}

function detectViewportPreset(width: number, height: number): TimelineCompositionSettings["viewport"]["preset"] {
  return compositionViewportPresets.find((preset) => preset.width === width && preset.height === height)?.id ?? "custom";
}

function moveLayerAndLinkedCompanions(
  composition: TimelineComposition,
  layerId: string,
  startSeconds: number,
  deltaSeconds: number
): TimelineComposition {
  const layer = flattenTimelineLayers(composition).find((item) => item.id === layerId);
  return {
    ...composition,
    tracks: composition.tracks.map((track) => ({
      ...track,
      layers: track.layers.map((item) => {
        if (item.id === layerId) {
          return { ...item, startSeconds };
        }
        if (layer?.linkedGroupId && item.linkedGroupId === layer.linkedGroupId) {
          return {
            ...item,
            startSeconds: Math.max(0, item.startSeconds + deltaSeconds)
          };
        }
        return item;
      })
    }))
  };
}

// Junction transition model (isJunctionTransitionKind / findLeftNeighbor / findRightNeighbor /
// findTransitionCutForClip / applyJunctionTransition / removeJunctionTransition /
// DEFAULT_CROSS_DISSOLVE_SECONDS) now lives in @kimera-by-aelivion/shared
// (timeline-actions/actions/transition.ts) so the editor UI and the AI action surface
// (setJunctionTransition / removeJunctionTransition actions) mutate the cut through one code path.

function describeTransitionCutForClip(composition: TimelineComposition | null | undefined, clipId: string): string {
  if (!composition) {
    return "No cut available";
  }
  const target = findTransitionCutForClip(composition, clipId);
  if (!target) {
    return "No touching clip";
  }
  return target.side === "right"
    ? `Right cut: ${target.left.name} -> ${target.right.name}`
    : `Left cut: ${target.left.name} -> ${target.right.name}`;
}

function getLayerMaxDuration(
  layer: TimelineLayer,
  assets: SourceAsset[],
  compositionDuration: number,
  compositions?: Record<string, TimelineComposition> | undefined
) {
  if ((layer.type === "video" || layer.type === "audio") && layer.assetId) {
    const asset = assets.find((item) => item.id === layer.assetId);
    if (asset?.durationSeconds) {
      // Rate stretch: a clip playing at 2x consumes media twice as fast, so its max
      // TIMELINE duration is the asset duration divided by speed.
      return Math.max(0.05, Math.max(0.2, asset.durationSeconds) / Math.abs(getLayerSpeed(layer)));
    }
  }

  // Compound clip: max timeline duration is its nested sequence's length, divided by speed —
  // same rate-stretch rule as a real asset (NESTING.md "Duration is not live": a clip trimmed
  // past the nest's end simply can't grow further; it doesn't extend/shrink the nest).
  if (layer.nestedCompositionId) {
    const nestedDuration = getNestedSourceDurationSeconds(layer, compositions);
    if (nestedDuration) {
      return Math.max(0.05, nestedDuration / Math.abs(getLayerSpeed(layer)));
    }
  }

  // Unbounded layers (text/shape/image/graphic/adjustment — no intrinsic media length): generous
  // headroom past the comp's CURRENT end instead of pinning to it (nesting handles fix,
  // 2026-07-17). Pinning to `compositionDuration` froze these clips inside a group — a grouped
  // sequence is exactly content-sized, so "max = comp length" meant "max = what you already have".
  // Finite (not Infinity) because TimelineStrip folds this into its interaction extent.
  return compositionDuration + 300;
}

function addCompanionAudioLayer(
  composition: TimelineComposition,
  asset: SourceAsset,
  visualLayer: Pick<TimelineLayer, "id" | "startSeconds" | "durationSeconds">,
  index: number,
  sourceInSeconds?: number | undefined
) {
  if (!asset.fileType.startsWith("video/") || assetHasAudioStream(asset) === false) {
    return composition;
  }

  const existingAudio = flattenTimelineLayers(composition).find(
    (layer) => layer.type === "audio" && layer.assetId === asset.id && Math.abs(layer.startSeconds - visualLayer.startSeconds) < 0.01
  );
  if (existingAudio) {
    return composition;
  }

  // The companion id is DETERMINISTIC (`<videoLayerId>_audio`), so re-assigning a different asset
  // to a video layer that already has a companion must UPDATE that companion in place — the old
  // assetId-based guard above misses that case and a second layer with the same id was added
  // (React duplicate-key spam + undefined reconciliation, 2026-07-04 report).
  const companionId = `${visualLayer.id}_audio`;
  if (flattenTimelineLayers(composition).some((layer) => layer.id === companionId)) {
    const linkedGroupId = `link_${asset.id}_${visualLayer.id}`;
    return {
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((layer) =>
          layer.id === companionId
            ? {
                ...layer,
                assetId: asset.id,
                linkedGroupId,
                name: `${asset.fileName} audio`,
                startSeconds: visualLayer.startSeconds,
                durationSeconds: Math.max(0.2, Math.min(asset.durationSeconds, visualLayer.durationSeconds)),
                // New media starts from its head; keep an existing trim only for the same asset.
                sourceInSeconds: sourceInSeconds ?? (layer.assetId === asset.id ? layer.sourceInSeconds : undefined)
              }
            : layer.id === visualLayer.id
              ? { ...layer, linkedGroupId }
              : layer
        )
      }))
    };
  }

  // Smart placement: the BOTTOM-most audio track that is vacant over the companion's time span
  // (audio stacks downward, mirroring video stacking up) — not blindly the first audio track,
  // which overlapped existing audio. All occupied → fabricate a fresh track; the auto-vacancy
  // normalizer in updateComposition then re-pads the bottom edge.
  const companionDurationSeconds = Math.max(0.2, Math.min(asset.durationSeconds, visualLayer.durationSeconds));
  const companionEndSeconds = visualLayer.startSeconds + companionDurationSeconds;
  const isVacantOverSpan = (track: TimelineTrack) =>
    track.layers.every(
      (layer) =>
        layer.startSeconds + layer.durationSeconds <= visualLayer.startSeconds + 0.001 || layer.startSeconds >= companionEndSeconds - 0.001
    );
  const audioTrack = [...composition.tracks.filter((track) => track.type === "audio")].reverse().find(isVacantOverSpan);
  const resolvedAudioTrack =
    audioTrack ??
    ({
      id: `track_${Date.now()}_audio`,
      type: "audio",
      name: `Audio ${composition.tracks.filter((track) => track.type === "audio").length + 1}`,
      layers: []
    } satisfies TimelineTrack);
  const audioLayer = createEditorLayer("audio", resolvedAudioTrack, composition, index);
  const linkedGroupId = `link_${asset.id}_${visualLayer.id}`;
  const companionLayer: TimelineLayer = {
    ...audioLayer,
    id: `${visualLayer.id}_audio`,
    assetId: asset.id,
    linkedGroupId,
    name: `${asset.fileName} audio`,
    startSeconds: visualLayer.startSeconds,
    durationSeconds: Math.max(0.2, Math.min(asset.durationSeconds, visualLayer.durationSeconds)),
    sourceInSeconds
  };

  if (audioTrack) {
    return {
      ...composition,
      tracks: composition.tracks.map((track) =>
        track.id === audioTrack.id
          ? {
              ...track,
              layers: [...track.layers, companionLayer]
            }
          : track.layers.some((layer) => layer.id === visualLayer.id)
            ? {
                ...track,
                layers: track.layers.map((layer) => (layer.id === visualLayer.id ? { ...layer, linkedGroupId } : layer))
              }
          : track
      )
    };
  }

  return {
    ...composition,
    tracks: [
      ...composition.tracks.map((track) =>
        track.layers.some((layer) => layer.id === visualLayer.id)
          ? {
              ...track,
              layers: track.layers.map((layer) => (layer.id === visualLayer.id ? { ...layer, linkedGroupId } : layer))
            }
          : track
      ),
      {
        ...resolvedAudioTrack,
        layers: [companionLayer]
      }
    ]
  };
}

function getAssetUseCounts(layers: TimelineLayer[]) {
  return layers.reduce<Record<string, number>>((counts, layer) => {
    if (layer.assetId) {
      counts[layer.assetId] = (counts[layer.assetId] ?? 0) + 1;
    }
    return counts;
  }, {});
}

type AssetAddMode = "auto" | "video" | "audio" | "both";
type MediaMetadata = { durationSeconds: number; width: number; height: number; hasAudio?: boolean | undefined; color?: SourceColorMetadata | undefined; rotationDegrees?: 0 | 90 | 180 | 270 | undefined };

/** Rewrites `layer.assetId` through a package→created-asset id map (this composition's own tracks only). */
function remapCompositionAssetIds(composition: TimelineComposition, idMap: Map<string, string>): TimelineComposition {
  if (idMap.size === 0) return composition;
  const remapLayer = (layer: TimelineLayer): TimelineLayer =>
    layer.assetId && idMap.has(layer.assetId) ? { ...layer, assetId: idMap.get(layer.assetId) } : layer;
  return {
    ...composition,
    tracks: composition.tracks.map((track) => ({ ...track, layers: track.layers.map(remapLayer) }))
  };
}

function findCompatibleTrackId(composition: TimelineComposition, asset: SourceAsset, mode: AssetAddMode = "auto") {
  const wantsAudio = mode === "audio" || (mode === "auto" && asset.fileType.startsWith("audio/"));
  return (
    composition.tracks.find((track) => (wantsAudio ? track.type === "audio" : track.type !== "audio"))?.id ??
    composition.tracks[0]?.id ??
    ""
  );
}

function shouldCreateCompanionAudio(asset: SourceAsset, mode: AssetAddMode): boolean {
  if (!asset.fileType.startsWith("video/")) return false;
  const hasAudio = assetHasAudioStream(asset);
  if (mode === "both") return hasAudio !== false;
  if (mode === "auto") return hasAudio === true;
  return false;
}

function readMediaMetadata(file: File): Promise<MediaMetadata> {
  if (file.type.startsWith("video/")) {
    return new Promise<MediaMetadata>((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      const done = (duration: number) => {
        URL.revokeObjectURL(url);
        // Probe audio + source color space in parallel (both off the render loop). Color is best-effort:
        // MP4 `colr` box → detected; anything else → left undefined so the asset assumes Rec.709.
        void Promise.all([
          detectVideoFileHasAudio(file),
          detectSourceMetadataFromFile(file).catch(() => ({ color: null, rotationDegrees: 0 as const })),
          // Container `duration` metadata routinely OVERSHOOTS the decodable sample table (a frame to
          // ~1s). A clip authored to that length freezes on its last frame for the overshoot — every
          // beyond-EOF getFrame clamps to the final sample (confirmed: 0.72s tail freeze). Clamp to the
          // true sample-table end when we can demux it; null (non-MP4/parse fail) keeps metadata.
          probeDecodableEndSeconds(file).catch(() => null)
        ]).then(([hasAudio, meta, decodableEnd]) => {
          const metaDuration = Number.isFinite(duration) && duration > 0 ? duration : 12;
          const usableDuration =
            decodableEnd !== null && decodableEnd > 0.2 && decodableEnd < metaDuration
              ? decodableEnd
              : metaDuration;
          resolve({
            durationSeconds: clamp(usableDuration, 0.2, 7200),
            width: Math.max(320, video.videoWidth || 1080),
            height: Math.max(320, video.videoHeight || 1920),
            ...(hasAudio !== undefined ? { hasAudio } : {}),
            ...(meta.color ? { color: meta.color } : {}),
            ...(meta.rotationDegrees ? { rotationDegrees: meta.rotationDegrees } : {})
          });
        });
      };
      video.onloadedmetadata = () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          done(video.duration);
          return;
        }
        // Some MP4/WebM report duration=Infinity from metadata alone; seeking to the end forces the
        // browser to compute the true duration (then `durationchange`/`timeupdate` fires with it).
        const onDuration = () => {
          if (Number.isFinite(video.duration) && video.duration > 0) {
            video.removeEventListener("durationchange", onDuration);
            video.removeEventListener("timeupdate", onDuration);
            done(video.duration);
          }
        };
        video.addEventListener("durationchange", onDuration);
        video.addEventListener("timeupdate", onDuration);
        try {
          video.currentTime = 1e101; // overshoot → browser clamps to real end and reports duration
        } catch {
          done(12);
        }
      };
      video.onerror = () => done(12);
      video.src = url;
    });
  }

  if (file.type.startsWith("image/")) {
    return new Promise<MediaMetadata>((resolve) => {
      const url = URL.createObjectURL(file);
      const image = new window.Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve({
          durationSeconds: 3,
          width: Math.max(320, image.naturalWidth || 1080),
          height: Math.max(320, image.naturalHeight || 1920),
          hasAudio: false
        });
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ durationSeconds: 3, width: 1080, height: 1920, hasAudio: false });
      };
      image.src = url;
    });
  }

  if (file.type.startsWith("audio/")) {
    return new Promise<MediaMetadata>((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve({
          durationSeconds: clamp(Number.isFinite(audio.duration) ? audio.duration : 12, 0.2, 7200),
          width: 1080,
          height: 1920,
          hasAudio: true
        });
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ durationSeconds: 12, width: 1080, height: 1920, hasAudio: true });
      };
      audio.src = url;
    });
  }

  return Promise.resolve({ durationSeconds: 12, width: 1080, height: 1920 });
}

async function detectVideoFileHasAudio(file: File): Promise<boolean | undefined> {
  const name = file.name.toLowerCase();
  const mp4Like =
    file.type === "video/mp4" ||
    file.type === "video/quicktime" ||
    file.type === "video/x-m4v" ||
    /\.(mp4|m4v|mov)$/i.test(name);
  if (!mp4Like) {
    return undefined;
  }

  try {
    const [{ createFile }, buffer] = await Promise.all([import("mp4box"), file.arrayBuffer()]);
    const mp4 = createFile();
    const ready = new Promise<boolean>((resolve, reject) => {
      mp4.onError = (error) => reject(new Error(error));
      mp4.onReady = (info) => {
        const audioTracks = info.audioTracks ?? [];
        const tracks = info.tracks ?? [];
        resolve(
          audioTracks.length > 0 ||
            tracks.some((track) => {
              const codec = track.codec?.toLowerCase() ?? "";
              return Boolean(track.audio) || codec.startsWith("mp4a") || codec.startsWith("ac-") || codec.startsWith("ec-") || codec.startsWith("opus");
            })
        );
      };
    });
    const view = buffer as ArrayBuffer & { fileStart: number };
    view.fileStart = 0;
    mp4.appendBuffer(view);
    mp4.flush();
    return await Promise.race([ready, new Promise<undefined>((resolve) => window.setTimeout(() => resolve(undefined), 2000))]);
  } catch {
    return undefined;
  }
}

function ProjectSettingsPanel({
  composition,
  onChange
}: {
  composition: TimelineComposition;
  onChange: (updater: (settings: TimelineCompositionSettings) => TimelineCompositionSettings) => void;
}) {
  const settings = getCompositionSettings(composition);
  const contentEndSeconds = Math.max(0, ...flattenTimelineLayers(composition).map((layer) => layer.startSeconds + layer.durationSeconds));
  const setViewportPreset = (presetId: TimelineCompositionSettings["viewport"]["preset"]) => {
    const preset = compositionViewportPresets.find((item) => item.id === presetId);
    onChange((current) => ({
      ...current,
      viewport: {
        ...current.viewport,
        preset: presetId,
        width: preset?.width ?? current.viewport.width,
        height: preset?.height ?? current.viewport.height,
        fps: preset?.fps ?? current.viewport.fps
      }
    }));
  };

  return (
    <div className="project-settings-panel">
      <div className="panel-heading">
        <div>
          <h2>Project Settings</h2>
          <span>{composition.width}x{composition.height} · {composition.fps}fps</span>
        </div>
      </div>

      <section className="settings-section">
        <div className="settings-section-heading">
          <strong>Canvas</strong>
          <span>{settings.viewport.preset === "custom" ? "Custom" : compositionViewportPresets.find((preset) => preset.id === settings.viewport.preset)?.label}</span>
        </div>
        <div className="settings-preset-grid">
          {compositionViewportPresets.map((preset) => (
            <button
              className={settings.viewport.preset === preset.id ? "is-active" : ""}
              key={preset.id}
              type="button"
              onClick={() => setViewportPreset(preset.id)}
            >
              <strong>{preset.label}</strong>
              <span>{preset.width}x{preset.height}</span>
            </button>
          ))}
        </div>
        <div className="settings-grid settings-grid-2">
          <SettingsNumberField
            label="Width"
            min={320}
            max={7680}
            step={1}
            value={settings.viewport.width}
            onChange={(value) =>
              onChange((current) => ({
                ...current,
                viewport: { ...current.viewport, preset: "custom", width: value }
              }))
            }
          />
          <SettingsNumberField
            label="Height"
            min={320}
            max={7680}
            step={1}
            value={settings.viewport.height}
            onChange={(value) =>
              onChange((current) => ({
                ...current,
                viewport: { ...current.viewport, preset: "custom", height: value }
              }))
            }
          />
          <div className="settings-field">
            <span>FPS</span>
            <ThemedSelect
              ariaLabel="FPS"
              value={String(settings.viewport.fps)}
              options={[...new Set([24, 30, 60, settings.viewport.fps])]
                .sort((a, b) => a - b)
                .map((fps) => ({ value: String(fps), label: String(fps) }))}
              onChange={(fps) =>
                onChange((current) => ({
                  ...current,
                  viewport: { ...current.viewport, fps: Number(fps) }
                }))
              }
            />
          </div>
          <label className="settings-field">
            <span>Background</span>
            <div className="settings-color-row">
              <input
                type="color"
                value={settings.viewport.backgroundColor}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    viewport: { ...current.viewport, backgroundColor: event.target.value }
                  }))
                }
              />
              <code>{settings.viewport.backgroundColor}</code>
            </div>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <strong>Timeline</strong>
          <span>{composition.durationSeconds.toFixed(1)}s visible</span>
        </div>
        <div className="settings-grid settings-grid-2">
          <SettingsNumberField
            label="Start length"
            min={1}
            max={7200}
            step={0.5}
            value={settings.timeline.baseDurationSeconds}
            suffix="s"
            onChange={(value) =>
              onChange((current) => ({
                ...current,
                timeline: { ...current.timeline, baseDurationSeconds: value }
              }))
            }
          />
          <SettingsNumberField
            label="Tail padding"
            min={0}
            max={30}
            step={0.5}
            value={settings.timeline.tailPaddingSeconds}
            suffix="s"
            onChange={(value) =>
              onChange((current) => ({
                ...current,
                timeline: { ...current.timeline, tailPaddingSeconds: value }
              }))
            }
          />
          <SettingsNumberField
            label="Snap"
            min={0.01}
            max={1}
            step={0.01}
            value={settings.timeline.snapSeconds}
            suffix="s"
            onChange={(value) =>
              onChange((current) => ({
                ...current,
                timeline: { ...current.timeline, snapSeconds: value }
              }))
            }
          />
          <label className="settings-toggle">
            <input
              checked={settings.timeline.autoGrow}
              type="checkbox"
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  timeline: { ...current.timeline, autoGrow: event.target.checked }
                }))
              }
            />
            <span>
              Auto grow
              <small>Content ends at {contentEndSeconds.toFixed(1)}s</small>
            </span>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <strong>Resize Behavior</strong>
          <span>{settings.viewport.resizeBehavior === "keep-layout" ? "Keep layout" : "Scale visuals"}</span>
        </div>
        <div className="settings-segmented">
          {(["keep-layout", "scale-visuals"] as const).map((mode) => (
            <button
              className={settings.viewport.resizeBehavior === mode ? "is-active" : ""}
              key={mode}
              type="button"
              onClick={() =>
                onChange((current) => ({
                  ...current,
                  viewport: { ...current.viewport, resizeBehavior: mode }
                }))
              }
            >
              {mode === "keep-layout" ? "Keep" : "Scale"}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingsNumberField({
  label,
  max,
  min,
  onChange,
  step,
  suffix,
  value
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  suffix?: string | undefined;
  value: number;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <div className="settings-number-row">
        <ScrubNumberInput
          max={max}
          min={min}
          step={step}
          value={Number.isInteger(value) ? value : Number(value.toFixed(2))}
          onScrubChange={(next) => onChange(clamp(next, min, max))}
          onChange={(event) => onChange(clamp(Number(event.target.value), min, max))}
        />
        {suffix ? <small>{suffix}</small> : null}
      </div>
    </label>
  );
}

type AssetSourceTab = "local" | "ai" | "search" | "brand" | "templates" | "used" | "timelines";
type AssetTypeFilter = "all" | "video" | "image" | "audio" | "graphics";
type FolderAssetTab = Extract<AssetSourceTab, "local" | "brand" | "ai" | "search">;
type AssetBinFolder = {
  path: string;
  label: string;
  depth: number;
  assetCount: number;
  childCount: number;
};

/** Upload metadata so a tab can tag what it creates (e.g. Brand uploads). */
type AssetUploadOptions = { source?: AssetSource; folder?: string };

function isTimelineOrTemplateImportFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return isExternalTimelineFile(file.name) || lower.endsWith(".json") || lower.endsWith(".kimera-template");
}

function assetKind(asset: SourceAsset): "video" | "image" | "audio" | "graphic" | "file" {
  if (asset.fileType.startsWith("image/")) {
    return asset.fileType.includes("svg") ? "graphic" : "image";
  }
  if (asset.fileType.startsWith("audio/")) return "audio";
  if (asset.fileType.startsWith("video/")) return "video";
  // File-explorer bin (2026-07-17): non-media imports (.cube LUTs, JSON, docs…) are generic files —
  // browsable/downloadable/organizable, never placeable on the timeline. Empty fileType (legacy
  // records default) stays "video" for compatibility.
  return asset.fileType ? "file" : "video";
}

function assetSourceOf(asset: SourceAsset): AssetSource {
  return asset.source ?? "local";
}

const ASSET_SOURCE_BADGE: Record<AssetSource, string> = {
  local: "Local",
  ai: "AI",
  pexels: "Stock",
  unsplash: "Unsplash",
  graphic: "Graphic",
  "timeline-generated": "Generated",
  brand: "Brand"
};

function matchesAssetTab(asset: SourceAsset, tab: AssetSourceTab, used: boolean): boolean {
  const source = assetSourceOf(asset);
  switch (tab) {
    case "local":
      // Graphics are project-scoped rasterized image media (like uploads), so they live in Local for reuse.
      // Imported stock ALSO lives here (2026-07-17): Local is the project's MEDIA POOL, with stock
      // mounted under its own "stock" bin at the root — the same folder tree the Search subpanel
      // browses, so both surfaces show one consistent structure.
      return source === "local" || source === "graphic" || source === "pexels" || source === "unsplash";
    case "ai":
      return source === "ai" || source === "timeline-generated";
    case "brand":
      return source === "brand";
    case "search":
      // Search itself is query-driven (ephemeral results, not filtered via this function); this case only
      // matters for previously-imported stock assets encountered elsewhere (e.g. "Used" lookups).
      return source === "pexels" || source === "unsplash";
    case "used":
      return used;
    case "templates":
      // Templates are a distinct data type (TemplateDefinition, not SourceAsset) rendered in its own
      // dedicated branch below — never matched here.
      return false;
    default:
      return true;
  }
}

function matchesTypeFilter(asset: SourceAsset, typeFilter: AssetTypeFilter): boolean {
  if (typeFilter === "all") return true;
  const kind = assetKind(asset);
  if (typeFilter === "graphics") return kind === "graphic";
  return kind === typeFilter;
}

function isFolderAssetTab(tab: AssetSourceTab): tab is FolderAssetTab {
  return tab === "local" || tab === "brand" || tab === "ai" || tab === "search";
}

function defaultAssetFolder(tab: FolderAssetTab): string {
  // Imported stock refs already persist under "stock/…" paths (stock.routes writes
  // `stock/pexels/<type>`), so the Search tab's folder tree roots there.
  return tab === "search" ? "stock" : tab;
}

function assetFolderLabel(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

function normalizeAssetFolder(folder: string | null | undefined): string {
  return (folder ?? "").split("/").map((part) => part.trim()).filter(Boolean).join("/");
}

function parentAssetFolder(folder: string): string {
  const parts = normalizeAssetFolder(folder).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function isAssetFolderDescendant(folder: string, parent: string): boolean {
  const normalizedFolder = normalizeAssetFolder(folder);
  const normalizedParent = normalizeAssetFolder(parent);
  return Boolean(normalizedParent) && normalizedFolder.startsWith(`${normalizedParent}/`);
}

function directChildAssetFolder(folder: string, parent: string): string | null {
  const normalizedFolder = normalizeAssetFolder(folder);
  const normalizedParent = normalizeAssetFolder(parent);
  if (!normalizedFolder || normalizedFolder === normalizedParent) return null;
  const remainder = normalizedParent ? normalizedFolder.slice(normalizedParent.length + 1) : normalizedFolder;
  const child = remainder.split("/").filter(Boolean)[0];
  return child ? (normalizedParent ? `${normalizedParent}/${child}` : child) : null;
}

function sanitizeAssetFolderName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 48);
}

function formatAssetMeta(asset: SourceAsset): string {
  const parts: string[] = [];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (assetKind(asset) !== "image" && asset.durationSeconds) parts.push(`${Math.round(asset.durationSeconds)}s`);
  return parts.join(" · ");
}

const ASSET_TABS: { id: AssetSourceTab; label: string; icon: ReactNode }[] = [
  { id: "search", label: "Search", icon: <Search size={13} /> },
  { id: "local", label: "Local", icon: <FolderClosedIcon /> },
  { id: "ai", label: "AI", icon: <Sparkles size={13} /> },
  { id: "brand", label: "Brand", icon: <Palette size={13} /> },
  { id: "used", label: "Used", icon: <Layers size={13} /> },
  // Timelines tab (nesting Block 3, restructured): shown only when the host passes timeline data
  // (the inspector's replacement picker doesn't — a timeline can't replace a clip's asset).
  { id: "timelines", label: "Timelines", icon: <Clapperboard size={13} /> }
];

function FolderClosedIcon() {
  return <Film size={13} />;
}

type AssetKind = ReturnType<typeof assetKind>;

/** Small icon standing in for the asset type (replaces the old "Video"/"Audio" text badge). */
/**
 * Save an asset's media to the user's device. Fetch-to-blob (not a plain <a href>) so it works
 * for every source the bin can hold: local object URLs, the API's http storage URLs, and cloud
 * URLs — all download with the asset's real file name instead of navigating.
 */
async function downloadAssetFile(asset: SourceAsset): Promise<void> {
  try {
    const response = await fetch(asset.fileUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`fetch failed (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = asset.originalName ?? asset.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    console.warn("[assets] download failed:", error);
    // Last resort: open the raw URL — the browser may still offer to save it.
    window.open(asset.fileUrl, "_blank", "noopener");
  }
}

function assetTypeIcon(kind: AssetKind): ReactNode {
  switch (kind) {
    case "video":
      return <Film size={11} />;
    case "audio":
      return <Music size={11} />;
    case "graphic":
      return <Palette size={11} />;
    case "file":
      return <FileText size={11} />;
    default:
      return <Image size={11} />;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

type StockQuality = "highest" | "4k" | "1080p" | "720p" | "sd";

const STOCK_ORIENTATION_GROUPS: ThemedSelectGroup<StockOrientation>[] = [
  {
    label: "Orientation",
    options: [
      { value: "all", label: "Any orientation" },
      { value: "horizontal", label: "Horizontal" },
      { value: "vertical", label: "Vertical" },
      { value: "square", label: "Square" }
    ]
  }
];

const STOCK_QUALITY_GROUPS: ThemedSelectGroup<StockQuality>[] = [
  {
    label: "Quality",
    options: [
      { value: "highest", label: "Highest" },
      { value: "4k", label: "4K" },
      { value: "1080p", label: "1080p" },
      { value: "720p", label: "720p" },
      { value: "sd", label: "SD" }
    ]
  }
];

/** Choose which downloadable variant to import for the user's quality preference. */
function pickStockVariant(result: StockResult, quality: StockQuality): StockVariant | undefined {
  const variants = result.variants;
  if (!variants || variants.length === 0) return undefined;
  if (quality === "highest") return variants[0];
  const target = quality === "4k" ? 2160 : quality === "1080p" ? 1080 : quality === "720p" ? 720 : 480;
  const longEdge = (variant: StockVariant) => Math.max(variant.width ?? 0, variant.height ?? 0);
  return [...variants].sort((a, b) => Math.abs(longEdge(a) - target) - Math.abs(longEdge(b) - target))[0];
}

/**
 * The footage layer of an asset card. Fills the card and carries the asset's *true* aspect ratio
 * (from known dims, else measured on load) so the masonry grid keeps each clip's real shape.
 * Video tiles play muted/looped on hover (Pexels-style); only the hovered card's video plays.
 */
/**
 * Inline bin rename (file-explorer gesture, replaces the window.prompt dialog): autofocus +
 * select-all, Enter/blur commits, Escape cancels. All pointer/key events stop at the input so the
 * host tile's open/drag handlers never fire mid-rename.
 */
function FolderRenameInput({ path, onCommit, onCancel }: { path: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(assetFolderLabel(path));
  const committed = useRef(false);
  const commit = (name: string) => {
    if (committed.current) return;
    committed.current = true;
    onCommit(name);
  };
  return (
    <input
      className="asset-folder-rename"
      value={value}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") commit(value);
        if (event.key === "Escape") {
          committed.current = true;
          onCancel();
        }
      }}
      onBlur={() => commit(value)}
    />
  );
}

function AssetCardMedia({ asset, kind }: { asset: SourceAsset; kind: AssetKind }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const measured = useRef(Boolean(asset.width && asset.height));
  const [ratio, setRatio] = useState<number>(
    asset.width && asset.height ? asset.width / asset.height : kind === "video" ? 16 / 9 : 1
  );
  // Dead-source surface (URL-first stock, M3): a provider/cloud URL that no longer serves bytes
  // shows an explicit badge instead of a silently-empty tile ("Pin offline"/refresh can then fix it).
  const [sourceBroken, setSourceBroken] = useState(false);
  const brokenBadge = sourceBroken ? (
    <span className="asset-chip-offline" title="The source URL didn't respond — try Refresh from cloud / re-import">
      Source offline
    </span>
  ) : null;
  const style = { "--asset-ar": ratio } as CSSProperties;

  if (kind === "audio") {
    return (
      <div className="asset-card-media asset-card-media-audio">
        <Music size={20} />
      </div>
    );
  }

  if (kind === "file") {
    // Generic (non-media) file tile — file-explorer bin. Extension chip stands in for a preview.
    const ext = ((asset.originalName ?? asset.fileName).split(".").pop() ?? "file").toUpperCase().slice(0, 6);
    return (
      <div className="asset-card-media asset-card-media-file">
        <FileText size={20} />
        <span className="asset-file-ext">{ext}</span>
      </div>
    );
  }

  if (kind === "image" || kind === "graphic") {
    // `||`, not `??`: an EMPTY-STRING url must fall through too — React warns that src="" makes the
    // browser re-download the whole page, and a record can carry thumbnailUrl/fileUrl as "".
    const imgSrc = asset.thumbnailUrl || asset.fileUrl;
    return (
      <div className="asset-card-media" style={style}>
        {imgSrc ? (
          <img
            src={imgSrc}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setSourceBroken(true)}
            onLoad={(event) => {
              setSourceBroken(false);
              if (measured.current) return;
              const el = event.currentTarget;
              if (el.naturalWidth && el.naturalHeight) {
                measured.current = true;
                setRatio(el.naturalWidth / el.naturalHeight);
              }
            }}
          />
        ) : null}
        {brokenBadge}
      </div>
    );
  }

  const videoSrc = asset.proxyUrl || asset.previewUrl || asset.fileUrl;
  // Show a STILL by default — never mount a <video> per card. A live <video preload="metadata"> on every
  // card fired a metadata fetch + decoder for every video asset the moment the bin opened, flooding the
  // browser's ~6 connections (starving playback AND the thumbnail extractor). The poster comes from the
  // server thumbnail when present, else a ONE-shot, throttled+cached first-frame extraction (useVideoPoster,
  // max 2 concurrent). A real <video> mounts only while hovered, for the live preview.
  const extractedPoster = useVideoPoster(asset.thumbnailUrl ? undefined : videoSrc, 0);
  const posterSrc = asset.thumbnailUrl || extractedPoster || undefined;
  const [hovering, setHovering] = useState(false);
  // Premiere-style hover scrub: pointer X maps to source time (still only ONE <video>, mounted on
  // hover). No autoplay — the video stays paused on its poster frame until the pointer moves and
  // scrubs it; hovering without moving just shows the still.
  const [scrubFrac, setScrubFrac] = useState<number | null>(null);
  return (
    <div
      className="asset-card-media"
      style={style}
      onMouseEnter={() => {
        if (prefersReducedMotion()) return;
        setHovering(true);
      }}
      onMouseLeave={() => {
        setHovering(false);
        setScrubFrac(null);
      }}
      onPointerMove={(event) => {
        const video = videoRef.current;
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        if (!video.paused) video.pause();
        // Seeks coalesce in the browser; scrubbing a long asset stays one decode at a time.
        video.currentTime = frac * video.duration;
        setScrubFrac(frac);
      }}
    >
      {hovering && videoSrc ? (
        <video
          ref={videoRef}
          src={videoSrc}
          {...(posterSrc ? { poster: posterSrc } : {})}
          muted
          loop
          playsInline
          preload="auto"
          onLoadedMetadata={(event) => {
            if (measured.current) return;
            const el = event.currentTarget;
            if (el.videoWidth && el.videoHeight) {
              measured.current = true;
              setRatio(el.videoWidth / el.videoHeight);
            }
          }}
        />
      ) : posterSrc ? (
        <img src={posterSrc} alt="" loading="lazy" decoding="async" onError={() => setSourceBroken(true)} onLoad={() => setSourceBroken(false)} />
      ) : (
        <div className="asset-card-media-video-fallback">
          <Film size={20} />
        </div>
      )}
      {hovering && scrubFrac !== null ? (
        <span className="asset-scrub-line" style={{ left: `${scrubFrac * 100}%` }} aria-hidden="true" />
      ) : null}
      {brokenBadge}
    </div>
  );
}

/**
 * Stock result thumbnail. Shows a still (poster) — no hover-autoplay; `preload="none"` so hovering
 * never triggers a network fetch either. The video element stays mounted (unplayed) only so playback
 * works once the user actually opens the asset viewer.
 */
function StockCardMedia({ result }: { result: StockResult }) {
  const ratio = result.width && result.height ? result.width / result.height : result.type === "video" ? 16 / 9 : 1;
  const style = { "--asset-ar": ratio } as CSSProperties;

  if (result.type === "video" && result.previewUrl) {
    return (
      <div className="asset-card-media" style={style}>
        <video src={result.previewUrl} {...(result.thumbnailUrl ? { poster: result.thumbnailUrl } : {})} muted loop playsInline preload="none" />
      </div>
    );
  }

  return (
    <div className="asset-card-media" style={style}>
      {/* Some stock providers return an empty thumbnail URL — an <img src=""> re-requests the page. */}
      {result.thumbnailUrl ? <img src={result.thumbnailUrl} alt="" loading="lazy" /> : null}
    </div>
  );
}

/** Data bundle for the media pool's Timelines TAB (memoized at the call site — AssetBin is memo'd).
 *  `instances` = how many compound clips across the WHOLE project reference the comp; 0 on a
 *  non-root comp renders an "Unused" badge (a sequence survives its last clip by design — Premiere
 *  project-panel semantics — but it must be LEGIBLE that it's not on any timeline). */
type TimelinesTabData = {
  entries: { comp: TimelineComposition; instances: number }[];
  rootId: string;
  activeId: string;
};

/**
 * Timelines TAB of the media pool (NESTING_MATURITY.md Block 3; restructured 2026-07-17 from a
 * stacked section — it was eating vertical space above the bin). Now a first-class source tab in
 * the Local/AI/Brand/Used row, Premiere project-panel style: zero cost when another tab is active,
 * full panel height (scrollable) when open. Double-click opens; drag onto a video track inserts a
 * compound clip (cycle-guarded at the drop handler); context menu covers open/place/rename/
 * duplicate/delete.
 */
function TimelinesPanel({
  compositions,
  rootId,
  activeId,
  onOpen,
  onInsertAtPlayhead,
  onRename,
  onDuplicate,
  onDelete,
  onCreate
}: {
  compositions: TimelinesTabData["entries"];
  rootId: string;
  activeId: string;
  onOpen: (compositionId: string) => void;
  onInsertAtPlayhead: (compositionId: string) => void;
  onRename: (compositionId: string, name: string) => void;
  onDuplicate: (compositionId: string) => void;
  onDelete: (compositionId: string) => void;
  onCreate: () => void;
}) {
  const [menu, setMenu] = useState<{ id: string; top: number; left: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuComp = menu ? compositions.find((entry) => entry.comp.id === menu.id)?.comp : undefined;
  const formatLength = (seconds: number) => {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };
  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue);
    }
    setRenamingId(null);
  };
  return (
    <div className="timelines-panel timelines-tab">
      <div className="timelines-panel-header">
        <span className="timelines-panel-title">
          <Layers size={13} />
          <span>Timelines</span>
          <span className="timelines-panel-count">{compositions.length}</span>
        </span>
        <button type="button" className="timelines-panel-add" title="New timeline" onClick={onCreate}>
          <Plus size={13} />
          <span>New</span>
        </button>
      </div>
      <div className="timelines-list">
        {compositions.map(({ comp, instances }) => {
            const isRoot = comp.id === rootId;
            const isActive = comp.id === activeId;
            return (
              <div
                key={comp.id}
                className={`timelines-row${isActive ? " is-active" : ""}`}
                draggable={renamingId !== comp.id}
                onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-kimera-composition", comp.id);
                  event.dataTransfer.setData("text/plain", comp.name);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onDoubleClick={() => {
                  if (renamingId !== comp.id) onOpen(comp.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    id: comp.id,
                    left: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
                    top: Math.max(8, Math.min(event.clientY, window.innerHeight - 180))
                  });
                }}
                title="Double-click to open · drag to the timeline to place"
              >
                <Film size={13} />
                {renamingId === comp.id ? (
                  <input
                    className="timelines-row-rename"
                    value={renameValue}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") commitRename();
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <span className="timelines-row-name">{comp.name}</span>
                )}
                {isRoot ? <span className="timelines-row-badge">Main</span> : null}
                {!isRoot && instances === 0 ? (
                  <span className="timelines-row-badge is-unused" title="Not placed on any timeline — drag it in, or Delete it from the ⋮ menu">
                    Unused
                  </span>
                ) : null}
                {!isRoot && instances > 1 ? <span className="timelines-row-badge is-count">{instances}×</span> : null}
                <span className="timelines-row-length">{formatLength(comp.durationSeconds)}</span>
                <button
                  type="button"
                  className="timelines-row-menu"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ id: comp.id, left: Math.max(8, rect.right - 176), top: rect.bottom + 4 });
                  }}
                >
                  <MoreVertical size={12} />
                </button>
              </div>
            );
          })}
      </div>
      {menu && menuComp
        ? createPortal(
            <>
              <div className="timelines-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }} />
              <div className="timelines-menu" style={{ top: menu.top, left: menu.left }}>
                <button type="button" onClick={() => { setMenu(null); onOpen(menuComp.id); }}>Open</button>
                <button type="button" disabled={menuComp.id === activeId} onClick={() => { setMenu(null); onInsertAtPlayhead(menuComp.id); }}>
                  Place at playhead
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    setRenamingId(menuComp.id);
                    setRenameValue(menuComp.name);
                  }}
                >
                  Rename
                </button>
                <button type="button" onClick={() => { setMenu(null); onDuplicate(menuComp.id); }}>Duplicate</button>
                <button type="button" className="is-danger" disabled={menuComp.id === rootId || menuComp.id === activeId} onClick={() => { setMenu(null); onDelete(menuComp.id); }}>
                  Delete
                </button>
              </div>
            </>,
            document.body
          )
        : null}
    </div>
  );
}

/**
 * Memo'd panel: at ~180–240ms per render on low-end (2026-07-04 __rfRenderCost capture) the asset
 * bin was the single biggest waste in every unrelated EditorPage render — playhead cold commits,
 * selection changes, inspector edits. Its function props MUST stay identity-stable (the
 * `useStableHandler` wrappers at the call site); its data props are state or memoized values.
 */
const AssetBin = memo(AssetBinImpl);

function AssetBinImpl({
  assets: rawAssets,
  currentProjectId,
  currentUserId,
  onApplyTemplate,
  selectedAssetId,
  usedCounts = {},
  replaceActive = false,
  clickAssigns = false,
  onAssignAsset,
  onAddAssetToTimeline,
  onAddGraphic,
  onApplyFrame,
  onPickReplacement,
  onCancelReplace,
  onDeleteAsset,
  onFocusAssetUse,
  onUploadAsset,
  onImportFile,
  onImportedAsset,
  onMoveAssetFolder,
  onSetAssetLabel,
  onUploadToCloud,
  onRemoveFromCloud,
  onRefreshFromCloud,
  onPinOffline,
  customFolders,
  onChangeCustomFolders,
  onOpenSourceMonitor,
  timelines,
  onOpenTimeline,
  onInsertTimelineAtPlayhead,
  onRenameTimeline,
  onDuplicateTimeline,
  onDeleteTimeline,
  onCreateTimeline
}: {
  assets: SourceAsset[];
  /** Scopes the Local bin to this project: assets owned by a DIFFERENT project are hidden; user-level library
   *  assets (no owner) and this project's own uploads stay. Omit to show everything (legacy behavior). */
  currentProjectId?: string | undefined;
  /** Owner of the open project — distinguishes "my saved templates" (deletable here) from curated ones. */
  currentUserId?: string | undefined;
  /** Applies a template's composition into the currently open project (append). Templates tab only. */
  onApplyTemplate?: (template: TemplateDefinition) => void;
  selectedAssetId?: string | undefined;
  usedCounts?: Record<string, number>;
  replaceActive?: boolean;
  /** True only in the inspector's picker, where clicking an asset is EXPLICITLY "use this". */
  clickAssigns?: boolean;
  onAssignAsset: (asset: SourceAsset) => void;
  onAddAssetToTimeline?: (asset: SourceAsset, mode?: AssetAddMode) => void;
  onAddGraphic?: (graphic: LayerGraphic, name: string) => void;
  /** Frames (Phase 1): apply the picked frame to the selected image/video clip. */
  onApplyFrame?: (def: FrameDefinition) => void;
  onPickReplacement?: (asset: SourceAsset) => void;
  onCancelReplace?: () => void;
  onDeleteAsset?: ((asset: SourceAsset) => void) | undefined;
  onFocusAssetUse?: (assetId: string) => void;
  onUploadAsset: (file: File | null, options?: AssetUploadOptions) => void | Promise<void>;
  onImportFile?: ((file: File) => void | Promise<void>) | undefined;
  onImportedAsset?: (asset: SourceAsset) => void;
  onMoveAssetFolder?: (asset: SourceAsset, folder: string | null) => void | Promise<void>;
  onSetAssetLabel?: (asset: SourceAsset, label: string | null) => void | Promise<void>;
  onUploadToCloud?: ((asset: SourceAsset) => void) | undefined;
  /** Remove an asset's cloud copy (pulls bytes back to device first, then deletes the server/R2 copy). */
  onRemoveFromCloud?: ((asset: SourceAsset) => void) | undefined;
  /** Re-download this asset's bytes from its cloud/provider copy, replacing the on-device blob
   *  (corruption repair — plans/media-cloud-architecture.md M2). Shown when a cloud copy exists. */
  onRefreshFromCloud?: ((asset: SourceAsset) => void) | undefined;
  /** Stock URL-first (M3): download a provider-referenced asset's bytes into the on-device cache so
   *  it keeps working offline / if the provider URL dies. */
  onPinOffline?: ((asset: SourceAsset) => void) | undefined;
  /** Per-project user-created folder paths (from the project media manifest — M0). Replaces the
   *  legacy GLOBAL localStorage list that leaked one project's folders into every other project. */
  customFolders?: string[] | undefined;
  onChangeCustomFolders?: ((next: string[]) => void) | undefined;
  /** Video/audio double-click target when the dual-monitor source viewer is available (desktop
      widths only — see showSourceMonitor in EditorPage). Undefined on tablet/phone, where
      double-click keeps opening the AssetViewerModal below. */
  onOpenSourceMonitor?: ((asset: SourceAsset) => void) | undefined;
  /** Timelines tab data (nesting Block 3). Absent → the tab is hidden (e.g. the inspector picker). */
  timelines?: TimelinesTabData | undefined;
  onOpenTimeline?: ((compositionId: string) => void) | undefined;
  onInsertTimelineAtPlayhead?: ((compositionId: string) => void) | undefined;
  onRenameTimeline?: ((compositionId: string, name: string) => void) | undefined;
  onDuplicateTimeline?: ((compositionId: string) => void) | undefined;
  onDeleteTimeline?: ((compositionId: string) => void) | undefined;
  onCreateTimeline?: (() => void) | undefined;
}) {
  useRenderCost("AssetBin");
  // Project-scoped bin: drop uploads owned by another project (the "pile" fix). Library assets (ownerProjectId
  // null — brand/ai/stock) and this project's own uploads pass through. Mirrors GET /assets scope=project.
  // ALSO: DISPLAY-level dedupe of paired cloud copies — a server asset recorded as some local asset's
  // cloud twin is represented by its local tile. This must stay display-only: dropping paired server
  // records from the DATA (listAssets) broke clip resolution for graphs saved with server ids
  // ("Missing video asset", 2026-07-14).
  const assets = useMemo(() => {
    // Stock refs are user-level library rows — scope them to THIS project via the link mirror
    // (imported here) or actual timeline use, or every project's Stock bin would show the whole
    // account's stock history (the same "pile" bug the ownerProjectId filter fixed for uploads).
    const linkedIds = currentProjectId ? new Set(getLinkedAssetIdsForProject(currentProjectId)) : null;
    const scoped = currentProjectId
      ? rawAssets.filter((a) => {
          if (a.ownerProjectId && a.ownerProjectId !== currentProjectId) return false;
          if (linkedIds && (a.source === "pexels" || a.source === "unsplash")) {
            return linkedIds.has(a.id) || Boolean(usedCounts[a.id]);
          }
          return true;
        })
      : rawAssets;
    const paired = new Set(Object.values(getAssetPromotionMap()));
    return paired.size ? scoped.filter((a) => !paired.has(a.id)) : scoped;
  }, [rawAssets, currentProjectId, usedCounts]);
  const handleTileActivate = (asset: SourceAsset) => {
    if (replaceActive) {
      onPickReplacement?.(asset);
      return;
    }
    // Premiere semantics: in the main bin a single click only SELECTS. Auto-assigning here was a
    // silent composition edit per stray click — inspector repopulated with the new clip's effect
    // panels, proxy spans dirtied + regenerated, full re-render cascade (user cut it 2026-07-04:
    // "costing us for no real gain"). Explicit assignment paths remain: drag-to-timeline, the
    // hover "+", replace mode above, and the inspector's picker (clickAssigns).
    if (clickAssigns) onAssignAsset(asset);
  };
  const [query, setQuery] = useState("");
  const [sourceTab, setSourceTab] = useState<AssetSourceTab>(() =>
    readStoredChoice("kimera_asset_tab", "local", ["local", "ai", "search", "brand", "used", "timelines"] as const)
  );
  const [filter, setFilter] = useState<AssetTypeFilter>(() =>
    readStoredChoice("kimera_asset_filter", "all", ["all", "video", "image", "audio", "graphics"] as const)
  );
  const [view, setView] = useState<"tiles" | "list">(() => readStoredChoice("kimera_asset_view", "tiles", ["tiles", "list"] as const));
  const [size, setSize] = useState<"small" | "medium" | "large">(() =>
    readStoredChoice("kimera_asset_size", "medium", ["small", "medium", "large"] as const)
  );
  // Active folder per tab, remembered PER PROJECT (the old global keys carried one project's
  // navigation — and worse, its custom folder list — into every other project, 2026-07-17 report).
  const folderKeySuffix = currentProjectId ? `:${currentProjectId}` : "";
  const readActiveFolders = useCallback(
    (): Record<FolderAssetTab, string> => ({
      local: localStorage.getItem(`kimera_asset_folder_local${folderKeySuffix}`) || defaultAssetFolder("local"),
      brand: localStorage.getItem(`kimera_asset_folder_brand${folderKeySuffix}`) || defaultAssetFolder("brand"),
      ai: localStorage.getItem(`kimera_asset_folder_ai${folderKeySuffix}`) || defaultAssetFolder("ai"),
      search: localStorage.getItem(`kimera_asset_folder_search${folderKeySuffix}`) || defaultAssetFolder("search")
    }),
    [folderKeySuffix]
  );
  const [activeAssetFolders, setActiveAssetFolders] = useState<Record<FolderAssetTab, string>>(readActiveFolders);
  // The project loads async — re-read the per-project navigation once its id is known/changes.
  useEffect(() => {
    setActiveAssetFolders(readActiveFolders());
  }, [readActiveFolders]);
  // User-created folder paths now live in the PROJECT MEDIA MANIFEST (graph.mediaManifest — synced
  // with the project, so cloud keeps the same folder structure). This component only proposes the
  // next list; the parent persists it through the graph save path.
  const customAssetFolders = useMemo(() => customFolders ?? [], [customFolders]);
  const setCustomAssetFolders = useCallback(
    (updater: string[] | ((current: string[]) => string[])) => {
      const next = typeof updater === "function" ? updater(customAssetFolders) : updater;
      if (next.length === customAssetFolders.length && next.every((item, i) => customAssetFolders[i] === item)) return;
      onChangeCustomFolders?.(next);
    },
    [customAssetFolders, onChangeCustomFolders]
  );
  // Per-asset context menu. Anchored at FIXED viewport coordinates (cursor / ⋮ button), NOT inside
  // the tile: the grid is a CSS multi-column layout, where an absolutely-positioned menu inside a
  // tile paints across neighbouring tiles/columns and gets clipped by the scroll container — the
  // menu visually landed on the wrong clip.
  // `left` XOR `right`: a right-click anchors the menu's LEFT edge at the cursor; the ⋮ button
  // anchors the menu's RIGHT edge to the button (the menu is content-sized, so left-edge math from
  // an assumed width visibly drifts — right-edge alignment is exact regardless of menu width).
  const [assetMenu, setAssetMenu] = useState<{ id: string; top: number; left?: number; right?: number } | null>(null);
  // Folder (bin) context menu + inline rename — the file-explorer folder UX (2026-07-17).
  const [folderMenu, setFolderMenu] = useState<{ path: string; top: number; left: number } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const clampMenuTop = (y: number) => Math.max(8, Math.min(y, window.innerHeight - 324));
  const openAssetMenuAtCursor = (assetId: string, clientX: number, clientY: number) => {
    setAssetMenu({ id: assetId, left: Math.max(8, Math.min(clientX, window.innerWidth - 252)), top: clampMenuTop(clientY) });
  };
  const openAssetMenuAtTrigger = (assetId: string, trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect();
    setAssetMenu({ id: assetId, right: Math.max(8, window.innerWidth - rect.right), top: clampMenuTop(rect.bottom + 4) });
  };
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);

  // --- Unified Search state (Stock: photos/videos; Graphics: bundled + Iconify) ---
  // No provider identity in the UI — `stockType` doubles as the type chip (photos/videos/graphics).
  const [stockType, setStockType] = useState<"image" | "video" | "graphics" | "frames" | "templates">("image");
  const [stockOrientation, setStockOrientation] = useState<StockOrientation>(() =>
    readStoredChoice("kimera_stock_orientation", "all", ["all", "horizontal", "vertical", "square"] as const)
  );
  const [stockQuality, setStockQuality] = useState<StockQuality>(() =>
    readStoredChoice("kimera_stock_quality", "highest", ["highest", "4k", "1080p", "720p", "sd"] as const)
  );
  const [stockStatus, setStockStatus] = useState<{ configured: boolean } | null>(null);
  const [stockResults, setStockResults] = useState<StockResult[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockPage, setStockPage] = useState(1);
  const [stockHasMore, setStockHasMore] = useState(false);
  const [stockLoadingMore, setStockLoadingMore] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  // Stock/graphics import failures (CDN 502s etc.) used to vanish into the console — show them in-panel.
  const [stockImportError, setStockImportError] = useState<string | null>(null);
  // Graphics: bundled pack is instant/offline (filtered client-side); Iconify results are fetched.
  const graphicsBundled = useMemo(() => searchBundledGraphics(query), [query]);
  const [graphicsIconify, setGraphicsIconify] = useState<IconifyGraphicResult[]>([]);
  const [graphicsLoading, setGraphicsLoading] = useState(false);
  // "Show more" for the Iconify grid: each click raises the fetch limit (the API has no offset paging).
  const [graphicsLimit, setGraphicsLimit] = useState(GRAPHICS_PAGE_SIZE);
  const [graphicsHasMore, setGraphicsHasMore] = useState(false);
  // Canva-style "magic recommendations": after a graphic is added, surface related icons below the grid.
  const [graphicsRecommend, setGraphicsRecommend] = useState<{ keyword: string; results: IconifyGraphicResult[] } | null>(null);
  // Saved graphic presets (EGP round-trip) + external .svg file import.
  const savedGraphics = useSyncExternalStore(subscribeGraphicPresets, listGraphicPresets, listGraphicPresets);
  const svgFileInputRef = useRef<HTMLInputElement | null>(null);
  // Asset viewer modal — opened by double-clicking a library asset or a stock result.
  const [viewerTarget, setViewerTarget] = useState<AssetViewerTarget | null>(null);

  // --- Templates gallery (curated + own) ---
  const [templatesList, setTemplatesList] = useState<TemplateDefinition[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null);

  const folderTab = isFolderAssetTab(sourceTab) ? sourceTab : null;
  const folderRoot = folderTab ? defaultAssetFolder(folderTab) : "";
  const activeFolder = folderTab ? activeAssetFolders[folderTab] || folderRoot : "";
  const folderTabLabel = sourceTab === "brand" ? "Brand" : sourceTab === "ai" ? "AI" : sourceTab === "search" ? "Stock" : "Local";
  const currentFolderLabel = folderTab ? (activeFolder === folderRoot ? `${folderTabLabel} project` : assetFolderLabel(activeFolder)) : "";
  const folderCrumbs = useMemo(() => {
    if (!folderTab) return [];
    // Root-aware: inside Local, the shared stock tree is a MOUNT — its crumbs read
    // Local › Stock › pexels › …, and the primary root crumb always leads home.
    const inStockMount = folderTab === "local" && (activeFolder === "stock" || activeFolder.startsWith("stock/"));
    const activeRoot = inStockMount ? "stock" : folderRoot;
    const crumbs = [{ path: folderRoot, label: folderTabLabel }];
    if (inStockMount) crumbs.push({ path: "stock", label: "Stock" });
    const parts = activeFolder.slice(activeRoot.length).split("/").filter(Boolean);
    let path = activeRoot;
    for (const part of parts) {
      path = `${path}/${part}`;
      crumbs.push({ path, label: part });
    }
    return crumbs;
  }, [activeFolder, folderRoot, folderTab, folderTabLabel]);
  // Folder-tree roots this tab browses. Local mounts the shared `stock/` tree beside its own root
  // (one tree, two surfaces — the Search subpanel roots at `stock` directly), so downloaded stock
  // is reachable from the project's media pool without duplicating any state.
  const folderRootsForTab = useMemo<string[]>(
    () => (folderTab === "local" ? [folderRoot, "stock"] : folderTab ? [folderRoot] : []),
    [folderTab, folderRoot]
  );
  const folderOptions = useMemo<AssetBinFolder[]>(() => {
    if (!folderTab) return [];
    const folders = new Set<string>();
    const underARoot = (folder: string) => folderRootsForTab.some((root) => folder === root || folder.startsWith(`${root}/`));
    // Materialize the folder AND every ancestor up to (excluding) its root — derived asset folders
    // like "stock/pexels/video" need their intermediate bins to exist as navigable tiles (they were
    // invisible before: only exact paths were added, so parent-match filtering skipped them).
    const addWithAncestors = (folder: string) => {
      if (!folder || !underARoot(folder) || folderRootsForTab.includes(folder)) return;
      let path = folder;
      while (path && !folderRootsForTab.includes(path)) {
        folders.add(path);
        path = parentAssetFolder(path) || "";
      }
    };
    for (const asset of assets) {
      if (!matchesAssetTab(asset, folderTab, Boolean(usedCounts[asset.id]))) continue;
      addWithAncestors(normalizeAssetFolder(asset.folder));
    }
    for (const folder of customAssetFolders) {
      addWithAncestors(normalizeAssetFolder(folder));
    }
    // The Stock MOUNT itself: shows in Local's root only when the project actually has stock
    // content (any stock asset or a user-created stock bin).
    if (folderTab === "local" && [...folders].some((folder) => folder === "stock" || folder.startsWith("stock/"))) {
      folders.add("stock");
    }
    return Array.from(folders)
      .sort((a, b) => a.localeCompare(b))
      .map((folder) => ({
        path: folder,
        label: folder === "stock" ? "Stock" : assetFolderLabel(folder),
        depth: Math.max(0, folder.split("/").length - folderRoot.split("/").length),
        assetCount: assets.filter((asset) => normalizeAssetFolder(asset.folder) === folder && matchesAssetTab(asset, folderTab, Boolean(usedCounts[asset.id]))).length,
        childCount: Array.from(folders).filter((candidate) => parentAssetFolder(candidate) === folder).length
      }));
  }, [assets, customAssetFolders, folderRoot, folderRootsForTab, folderTab, usedCounts]);

  const queryText = query.trim().toLowerCase();
  // Children of a folder, including the Stock MOUNT at Local's root (its literal parent is "" —
  // the mount grafts the shared stock tree into the local root).
  const childFoldersOf = useCallback(
    (parent: string) =>
      folderOptions.filter(
        (entry) =>
          (parentAssetFolder(entry.path) === parent && !folderRootsForTab.includes(entry.path)) ||
          (folderTab === "local" && parent === folderRoot && entry.path === "stock")
      ),
    [folderOptions, folderRoot, folderRootsForTab, folderTab]
  );
  const visibleFolders = useMemo(() => {
    if (!folderTab || queryText) return [];
    return childFoldersOf(activeFolder);
  }, [activeFolder, childFoldersOf, folderTab, queryText]);
  const filteredAssets = assets.filter((asset) => {
    const assetFolder = normalizeAssetFolder(asset.folder) || (folderTab ? folderRoot : "");
    const inActiveFolder = !folderTab || (queryText ? isAssetFolderDescendant(assetFolder, activeFolder) || assetFolder === activeFolder : assetFolder === activeFolder);
    return (
      inActiveFolder &&
      matchesAssetTab(asset, sourceTab, Boolean(usedCounts[asset.id])) &&
      matchesTypeFilter(asset, filter) &&
      (asset.originalName ?? asset.fileName).toLowerCase().includes(queryText)
    );
  });

  // Premiere-style list-view sorting (2026-07-04): click a column header to sort, click again to
  // flip direction. Persisted like every other bin preference. Tiles view keeps library order.
  const [sortKey, setSortKey] = useState<"name" | "type" | "duration" | "dimensions" | "used">(() =>
    readStoredChoice("kimera_asset_sort", "name", ["name", "type", "duration", "dimensions", "used"] as const)
  );
  const [sortDir, setSortDir] = useState<1 | -1>(() => (localStorage.getItem("kimera_asset_sort_dir") === "-1" ? -1 : 1));
  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => {
        const next = dir === 1 ? -1 : 1;
        localStorage.setItem("kimera_asset_sort_dir", String(next));
        return next as 1 | -1;
      });
      return;
    }
    setSortKey(key);
    setSortDir(1);
    localStorage.setItem("kimera_asset_sort", key);
    localStorage.setItem("kimera_asset_sort_dir", "1");
  };
  const compareAssets = (a: SourceAsset, b: SourceAsset): number => {
    const nameOf = (asset: SourceAsset) => (asset.originalName ?? asset.fileName).toLowerCase();
    const valueOf = (asset: SourceAsset): number | string => {
      switch (sortKey) {
        case "type":
          return assetKind(asset);
        case "duration":
          return asset.durationSeconds || 0;
        case "dimensions":
          return (asset.width || 0) * (asset.height || 0);
        case "used":
          return usedCounts[asset.id] ?? 0;
        default:
          return nameOf(asset);
      }
    };
    const va = valueOf(a);
    const vb = valueOf(b);
    const cmp = typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb) : Number(va) - Number(vb);
    return (cmp !== 0 ? cmp : nameOf(a).localeCompare(nameOf(b))) * sortDir;
  };
  const sortedAssets = useMemo(() => {
    return [...filteredAssets].sort(compareAssets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, query, sourceTab, filter, activeFolder, sortKey, sortDir, usedCounts]);

  // ── Premiere Project-panel behaviors (2026-07-04) ─────────────────────────
  // Inline bin tree (list view): expanded bins persist like every other bin preference.
  const [expandedBins, setExpandedBins] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("kimera_asset_expanded_bins") || "[]");
      return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem("kimera_asset_expanded_bins", JSON.stringify(expandedBins));
  }, [expandedBins]);
  const toggleBinExpanded = (path: string) =>
    setExpandedBins((current) => (current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]));

  // Multi-select: plain click keeps the existing activate behavior (assign/replace) and anchors the
  // selection; ctrl/cmd toggles; shift selects the visible range. Batch actions live in a bar above
  // the footer. Selection resets on tab/bin navigation, Escape clears it.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectionAnchorRef = useRef<string | null>(null);
  useEffect(() => {
    setSelectedIds([]);
    selectionAnchorRef.current = null;
  }, [sourceTab, activeFolder]);
  useEffect(() => {
    if (!selectedIds.length) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSelectedIds([]);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [selectedIds.length]);
  function handleAssetSelect(event: ReactMouseEvent<HTMLElement>, asset: SourceAsset, ordered: SourceAsset[]) {
    // Shift NEVER falls through to toggle/activate: with an anchor it ranges; without one (or when
    // the anchor left the visible list) it starts a selection at the clicked item.
    if (event.shiftKey) {
      event.preventDefault();
      const ids = ordered.map((entry) => entry.id);
      const anchorIndex = selectionAnchorRef.current ? ids.indexOf(selectionAnchorRef.current) : -1;
      const targetIndex = ids.indexOf(asset.id);
      if (anchorIndex !== -1 && targetIndex !== -1) {
        setSelectedIds(ids.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1));
      } else {
        selectionAnchorRef.current = asset.id;
        setSelectedIds([asset.id]);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      selectionAnchorRef.current = asset.id;
      setSelectedIds((current) => (current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id]));
      return;
    }
    selectionAnchorRef.current = asset.id;
    setSelectedIds([asset.id]);
    handleTileActivate(asset);
  }
  const selectedAssets = selectedIds.length ? assets.filter((asset) => selectedIds.includes(asset.id)) : [];

  // Shared empty state (tiles + list views).
  const assetEmptyState = (
    <div className="asset-empty-state">
      {sourceTab === "ai" ? (
        <Sparkles size={18} />
      ) : sourceTab === "brand" ? (
        <Palette size={18} />
      ) : sourceTab === "used" ? (
        <Layers size={18} />
      ) : (
        <Image size={18} />
      )}
      <strong>
        {sourceTab === "ai"
          ? "No AI or generated assets yet"
          : sourceTab === "brand"
            ? "No brand assets yet"
            : sourceTab === "used"
              ? "Nothing used yet"
              : "No media yet"}
      </strong>
      <span>
        {sourceTab === "ai"
          ? "Run an AI tool or save a freeze frame to populate this tab."
          : sourceTab === "brand"
            ? "Upload logos, watermarks or fonts for your brand kit."
            : sourceTab === "used"
              ? "Assets placed on the timeline show up here."
              : "Upload media to start building your library."}
      </span>
    </div>
  );

  useEffect(() => {
    localStorage.setItem("kimera_asset_tab", sourceTab);
  }, [sourceTab]);

  useEffect(() => {
    localStorage.setItem(`kimera_asset_folder_local${folderKeySuffix}`, activeAssetFolders.local);
    localStorage.setItem(`kimera_asset_folder_brand${folderKeySuffix}`, activeAssetFolders.brand);
    localStorage.setItem(`kimera_asset_folder_ai${folderKeySuffix}`, activeAssetFolders.ai);
    localStorage.setItem(`kimera_asset_folder_search${folderKeySuffix}`, activeAssetFolders.search);
  }, [activeAssetFolders, folderKeySuffix]);

  useEffect(() => {
    localStorage.setItem("kimera_asset_filter", filter);
  }, [filter]);

  useEffect(() => {
    localStorage.setItem("kimera_asset_view", view);
  }, [view]);

  useEffect(() => {
    localStorage.setItem("kimera_asset_size", size);
  }, [size]);

  useEffect(() => {
    localStorage.setItem("kimera_stock_orientation", stockOrientation);
  }, [stockOrientation]);

  useEffect(() => {
    localStorage.setItem("kimera_stock_quality", stockQuality);
  }, [stockQuality]);

  // Close the folder context menu when clicking elsewhere or pressing Escape.
  useEffect(() => {
    if (!folderMenu) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".asset-tile-menu")) return;
      setFolderMenu(null);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setFolderMenu(null);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [folderMenu]);

  // Close the per-card "More" menu when clicking elsewhere or pressing Escape.
  useEffect(() => {
    if (!assetMenu) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".asset-tile-menu") || target?.closest(".asset-more-button")) return;
      setAssetMenu(null);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setAssetMenu(null);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [assetMenu]);

  // Probe whether stock search is configured (once the Search tab is opened).
  useEffect(() => {
    if (sourceTab !== "search" || stockStatus) return;
    void getStockStatus().then(setStockStatus);
  }, [sourceTab, stockStatus]);

  // Fetch curated + own templates once the Search → Templates chip is opened.
  useEffect(() => {
    if (!(sourceTab === "search" && stockType === "templates") || templatesList.length) return;
    setTemplatesLoading(true);
    void listMyTemplates()
      .then(setTemplatesList)
      .finally(() => setTemplatesLoading(false));
  }, [sourceTab, stockType, templatesList.length]);

  // Debounced stock search (page 1) against the active type / orientation. Graphics has its own effect below.
  useEffect(() => {
    if (sourceTab !== "search" || (stockType !== "image" && stockType !== "video")) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setStockResults([]);
      setStockLoading(false);
      setStockHasMore(false);
      setStockPage(1);
      return;
    }
    setStockLoading(true);
    const handle = window.setTimeout(() => {
      void searchStock(trimmed, stockType, 1, stockOrientation)
        .then((data) => {
          setStockResults(data.results);
          setStockHasMore(data.results.length >= STOCK_PAGE_SIZE);
          setStockPage(1);
        })
        .catch(() => {
          setStockResults([]);
          setStockHasMore(false);
        })
        .finally(() => setStockLoading(false));
    }, 350);
    return () => window.clearTimeout(handle);
  }, [sourceTab, query, stockType, stockOrientation]);

  // Debounced Iconify search (Graphics chip). The bundled pack (graphicsBundled) is filtered client-side
  // and needs no fetch; this only covers the searchable icon set, and fails soft to [] (see graphics-search.ts).
  useEffect(() => {
    if (sourceTab !== "search" || stockType !== "graphics") return;
    const trimmed = query.trim();
    if (!trimmed) {
      setGraphicsIconify([]);
      setGraphicsLoading(false);
      setGraphicsHasMore(false);
      return;
    }
    setGraphicsLoading(true);
    const handle = window.setTimeout(() => {
      void searchIconifyGraphics(trimmed, graphicsLimit)
        .then((results) => {
          setGraphicsIconify(results);
          // Iconify caps a query's total hits; if we got a full page back there is likely more to fetch.
          setGraphicsHasMore(results.length >= graphicsLimit);
        })
        .finally(() => setGraphicsLoading(false));
    }, 350);
    return () => window.clearTimeout(handle);
  }, [sourceTab, stockType, query, graphicsLimit]);

  // Reset the Graphics "Show more" limit whenever the query changes, so a new search starts at page one.
  useEffect(() => {
    setGraphicsLimit(GRAPHICS_PAGE_SIZE);
  }, [query]);

  async function handleLoadMoreStock() {
    if (stockType !== "image" && stockType !== "video") return;
    const trimmed = query.trim();
    if (!trimmed || stockLoadingMore) return;
    const nextPage = stockPage + 1;
    setStockLoadingMore(true);
    try {
      const data = await searchStock(trimmed, stockType, nextPage, stockOrientation);
      setStockResults((prev) => {
        const seen = new Set(prev.map((item) => `${item.provider}_${item.externalId}`));
        const fresh = data.results.filter((item) => !seen.has(`${item.provider}_${item.externalId}`));
        return [...prev, ...fresh];
      });
      setStockPage(nextPage);
      setStockHasMore(data.results.length >= STOCK_PAGE_SIZE);
    } catch {
      setStockHasMore(false);
    } finally {
      setStockLoadingMore(false);
    }
  }

  async function handleImportStock(result: StockResult, variant?: StockVariant) {
    setImportingId(result.externalId);
    setStockImportError(null);
    try {
      const asset = await importStock(result, variant ?? pickStockVariant(result, stockQuality), currentProjectId);
      onImportedAsset?.(asset);
      // Import = provider reference (URL-first) + AN ON-DEVICE COPY: kick the local download in the
      // background so "downloaded" stock genuinely lives on this machine (local-first, no server
      // bytes). If the fetch fails (offline/CORS), the reference still streams — nothing breaks.
      void onPinOffline?.(asset);
      // If the viewer was importing this result, close it once it lands in the library.
      setViewerTarget((current) => (current?.kind === "stock" && current.result.externalId === result.externalId ? null : current));
    } catch (error) {
      setStockImportError(error instanceof Error ? error.message : "Stock import failed — please try again.");
    } finally {
      setImportingId(null);
    }
  }

  /** Add a Graphics-chip pick (bundled shape or Iconify icon) as an editable VECTOR layer — Canva-style: one
   *  click places it, recolorable in the inspector afterwards. `sourceColor` is the pack's baked fill (bundled)
   *  so it normalizes to `currentColor`. When none is passed (Iconify), the SVG's own paints decide:
   *  exactly one baked color → treat it as the source color (Fill recolor then works exactly like the
   *  bundled pack — previously a silent no-op); several → store them as a palette (per-color editing). */
  function handleImportGraphic(id: string, name: string, svg: string, sourceColor?: string) {
    setStockImportError(null);
    try {
      let effectiveSource = sourceColor;
      let palette: string[] = [];
      if (!effectiveSource) {
        palette = extractSvgPalette(svg);
        if (palette.length === 1) {
          effectiveSource = palette[0];
          palette = [];
        }
      }
      const graphic = normalizeGraphicSvg(svg, effectiveSource);
      if (palette.length > 1) graphic.palette = palette.map((from) => ({ from, to: from }));
      onAddGraphic?.(graphic, name);
      // Canva-style "magic recommendations": pull related icons keyed off the graphic's name so the strip
      // below the grid fills with on-theme alternatives to keep building. Fails soft (offline/CSP → []).
      const keyword = graphicRecommendKeyword(name);
      if (keyword) {
        void searchIconifyGraphics(keyword, GRAPHICS_PAGE_SIZE).then((results) => {
          setGraphicsRecommend({ keyword, results: results.filter((r) => r.iconId !== id.replace(/^iconify_/, "")) });
        });
      }
    } catch (error) {
      setStockImportError(error instanceof Error ? error.message : "Could not add graphic — please try again.");
    }
  }

  /** Import external .svg files from disk as editable vector graphic layers — the identical
   *  normalize/palette path a Graphics-chip pick takes, so external files stay recolorable. */
  function handleImportSvgFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith(".svg") && file.type !== "image/svg+xml") continue;
      const name = file.name.replace(/\.svg$/i, "") || "Graphic";
      void file.text().then((svg) => {
        if (svg.includes("<svg")) handleImportGraphic(`file_${name}`, name, svg);
        else setStockImportError(`"${file.name}" doesn't look like an SVG file.`);
      });
    }
  }

  /** Apply a template into the currently open project. Always additive (append) — never destroys
   *  existing timeline content, so no confirmation prompt is needed regardless of template kind. */
  async function handleApplyTemplateClick(template: TemplateDefinition) {
    if (!onApplyTemplate) return;
    setApplyingTemplateId(template.id);
    try {
      onApplyTemplate(template);
    } finally {
      setApplyingTemplateId(null);
    }
  }

  async function handleDeleteTemplateClick(template: TemplateDefinition) {
    if (!window.confirm(`Delete template "${template.name}"? This can't be undone.`)) return;
    try {
      await deleteTemplate(template.id);
      setTemplatesList((current) => current.filter((item) => item.id !== template.id));
    } catch (error) {
      setStockImportError(error instanceof Error ? error.message : "Could not delete template.");
    }
  }

  const stockConfigured = stockStatus ? stockStatus.configured : true;
  // Search-tab folders organize imported stock refs, but uploads never target that tab (showUpload
  // gates to Local/Brand) — so it maps to no upload source.
  const uploadSource: AssetUploadOptions | undefined =
    folderTab && folderTab !== "search" ? { source: folderTab, folder: activeFolder || folderRoot } : undefined;
  const showUpload = sourceTab === "local" || sourceTab === "brand";
  const canDropFiles = showUpload;
  // File-explorer bin: no accept restriction — media plays, timeline/template files import, and
  // anything else (.cube, docs…) becomes a generic file asset. Undefined = the OS picker shows all.
  const uploadAccept = undefined;
  const showDropPrompt = showUpload && filteredAssets.length === 0;

  function selectAssetFolder(folder: string) {
    if (!folderTab) return;
    setActiveAssetFolders((current) => ({ ...current, [folderTab]: folder }));
  }

  /**
   * File-explorer folder UX (2026-07-17, replaces the window.prompt dialog): "New bin" creates a
   * uniquely-named folder immediately and drops it straight into INLINE RENAME (the OS-explorer
   * gesture). Rename/move/delete live on the folder context menu.
   */
  function createAssetFolder(parentPath?: string) {
    if (!folderTab) return;
    const parent = normalizeAssetFolder(parentPath ?? (activeFolder || folderRoot)) || folderRoot;
    const existing = new Set(folderOptions.map((entry) => entry.path));
    let name = "New bin";
    for (let i = 2; existing.has(`${parent}/${name}`); i += 1) name = `New bin ${i}`;
    const folder = `${parent}/${name}`;
    setCustomAssetFolders((current) => (current.includes(folder) ? current : [...current, folder]));
    // Make the new bin visible where it landed (tiles view shows the ACTIVE folder's children).
    if (parent !== activeFolder) selectAssetFolder(parent);
    setExpandedBins((current) => (parent !== folderRoot && !current.includes(parent) ? [...current, parent] : current));
    setRenamingFolder(folder);
  }

  /** Rename a bin: remaps the subtree (assets' folder paths, custom entries, navigation, expansion). */
  function applyRenameFolder(sourcePath: string, rawName: string) {
    setRenamingFolder(null);
    if (!folderTab) return;
    const source = normalizeAssetFolder(sourcePath);
    const name = sanitizeAssetFolderName(rawName);
    if (!source || source === folderRoot || !name || name === assetFolderLabel(source)) return;
    const parent = parentAssetFolder(source) || folderRoot;
    const nextPath = `${parent}/${name}`;
    if (nextPath === source) return;
    if (folderOptions.some((entry) => entry.path === nextPath)) return; // name taken — keep the old one
    for (const asset of assets) {
      const assetFolder = normalizeAssetFolder(asset.folder);
      if (assetFolder === source || isAssetFolderDescendant(assetFolder, source)) {
        void onMoveAssetFolder?.(asset, nextPath + assetFolder.slice(source.length));
      }
    }
    setCustomAssetFolders((current) => {
      const moved = current.map((entry) => {
        const normalized = normalizeAssetFolder(entry);
        return normalized === source || isAssetFolderDescendant(normalized, source) ? nextPath + normalized.slice(source.length) : entry;
      });
      return moved.includes(nextPath) ? moved : [...moved, nextPath];
    });
    setActiveAssetFolders((current) => {
      const active = current[folderTab] || folderRoot;
      return active === source || isAssetFolderDescendant(active, source)
        ? { ...current, [folderTab]: nextPath + active.slice(source.length) }
        : current;
    });
    setExpandedBins((current) =>
      current.map((path) => (path === source || isAssetFolderDescendant(path, source) ? nextPath + path.slice(source.length) : path))
    );
  }

  /** Delete a bin. NON-destructive to media: contained assets move to the parent bin. */
  function deleteAssetFolder(path: string) {
    if (!folderTab) return;
    const source = normalizeAssetFolder(path);
    if (!source || source === folderRoot) return;
    const parent = parentAssetFolder(source) || folderRoot;
    for (const asset of assets) {
      const assetFolder = normalizeAssetFolder(asset.folder);
      if (assetFolder === source || isAssetFolderDescendant(assetFolder, source)) {
        void onMoveAssetFolder?.(asset, parent);
      }
    }
    setCustomAssetFolders((current) =>
      current.filter((entry) => {
        const normalized = normalizeAssetFolder(entry);
        return normalized !== source && !isAssetFolderDescendant(normalized, source);
      })
    );
    setActiveAssetFolders((current) => {
      const active = current[folderTab] || folderRoot;
      return active === source || isAssetFolderDescendant(active, source) ? { ...current, [folderTab]: parent } : current;
    });
    setExpandedBins((current) => current.filter((entry) => entry !== source && !isAssetFolderDescendant(entry, source)));
  }

  function assetByDragEvent(event: ReactDragEvent<HTMLElement>): SourceAsset | null {
    const assetId = event.dataTransfer.getData("application/x-kimera-asset");
    return assetId ? assets.find((asset) => asset.id === assetId) ?? null : null;
  }

  function canMoveAssetToFolder(asset: SourceAsset | null, folder: string): asset is SourceAsset {
    return Boolean(asset && folderTab && matchesAssetTab(asset, folderTab, Boolean(usedCounts[asset.id])) && normalizeAssetFolder(asset.folder) !== folder);
  }

  function handleAssetFolderDragOver(event: ReactDragEvent<HTMLElement>, folder: string) {
    if (!folderTab) return;
    const types = event.dataTransfer.types;
    if (!types.includes("application/x-kimera-asset") && !types.includes("application/x-kimera-asset-folder")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleAssetFolderDrop(event: ReactDragEvent<HTMLElement>, folder: string) {
    const draggedFolder = event.dataTransfer.getData("application/x-kimera-asset-folder");
    if (draggedFolder) {
      event.preventDefault();
      event.stopPropagation();
      moveFolderIntoFolder(draggedFolder, folder);
      return;
    }
    const asset = assetByDragEvent(event);
    if (!canMoveAssetToFolder(asset, folder)) return;
    event.preventDefault();
    event.stopPropagation();
    void onMoveAssetFolder?.(asset, folder);
  }

  // Bins nest by drag-and-drop like assets do: dropping bin A onto bin B re-parents A (and its
  // whole subtree) under B. Assets carry the persisted state (folder strings), so the move is
  // per-asset PATCHes plus a rename of any empty custom bins; guards refuse self/descendant drops.
  function moveFolderIntoFolder(sourcePath: string, targetPath: string) {
    if (!folderTab) return;
    const source = normalizeAssetFolder(sourcePath);
    const target = normalizeAssetFolder(targetPath) || folderRoot;
    if (!source || source === folderRoot) return;
    if (target === source || isAssetFolderDescendant(target, source)) return;
    if (parentAssetFolder(source) === target) return;
    const name = source.split("/").pop() ?? "";
    const nextPath = `${target}/${name}`;
    if (nextPath === source) return;
    for (const asset of assets) {
      const assetFolder = normalizeAssetFolder(asset.folder);
      if (assetFolder === source || isAssetFolderDescendant(assetFolder, source)) {
        void onMoveAssetFolder?.(asset, nextPath + assetFolder.slice(source.length));
      }
    }
    setCustomAssetFolders((current) => {
      const moved = current.map((entry) => {
        const normalized = normalizeAssetFolder(entry);
        return normalized === source || isAssetFolderDescendant(normalized, source) ? nextPath + normalized.slice(source.length) : entry;
      });
      return moved.includes(nextPath) ? moved : [...moved, nextPath];
    });
    // Follow the move if the user is currently inside the moved subtree.
    setActiveAssetFolders((current) => {
      const active = current[folderTab] || folderRoot;
      if (active === source || isAssetFolderDescendant(active, source)) {
        return { ...current, [folderTab]: nextPath + active.slice(source.length) };
      }
      return current;
    });
    // Reveal where it landed in the list tree.
    setExpandedBins((current) => (target !== folderRoot && !current.includes(target) ? [...current, target] : current));
  }

  async function processUploadFiles(files: FileList | File[] | { file: File; folder?: string }[]) {
    const raw: (File | { file: File; folder?: string })[] = Array.isArray(files) ? files : Array.from(files);
    const entries: { file: File; folder?: string }[] = raw.map((item) => (item instanceof File ? { file: item } : item));
    if (!entries.length) return;
    for (const { file, folder } of entries) {
      if (isTimelineOrTemplateImportFile(file) && onImportFile) {
        await onImportFile(file);
      } else if (isTimelineOrTemplateImportFile(file)) {
        continue;
      } else {
        // File-explorer bin (2026-07-17): ANY file type imports — media becomes playable assets,
        // everything else (.cube LUTs, JSON, docs…) a generic "file" asset that lives in the bin.
        await onUploadAsset(file, folder ? { ...uploadSource, folder } : uploadSource);
      }
    }
  }

  /**
   * Folder drop (file-explorer bin): a dropped DIRECTORY imports recursively, recreating its
   * subfolder structure as bin folders under the current location. Uses the webkitGetAsEntry
   * traversal API (the only cross-browser way to read dropped directories).
   */
  async function collectDroppedEntries(items: DataTransferItemList): Promise<{ file: File; folder?: string }[] | null> {
    type FsEntry = {
      isFile: boolean;
      isDirectory: boolean;
      name: string;
      file: (ok: (file: File) => void, err: (e: unknown) => void) => void;
      createReader: () => { readEntries: (ok: (entries: FsEntry[]) => void, err: (e: unknown) => void) => void };
    };
    const roots: FsEntry[] = [];
    for (const item of Array.from(items)) {
      const entry = (item as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
      if (entry) roots.push(entry);
    }
    if (!roots.length || !roots.some((entry) => entry.isDirectory)) return null; // plain files → default path
    const base = activeFolder || folderRoot;
    const out: { file: File; folder?: string }[] = [];
    const newFolders = new Set<string>();
    const walk = async (entry: FsEntry, dir: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)));
        if (file) out.push({ file, ...(dir ? { folder: dir } : {}) });
        return;
      }
      if (!entry.isDirectory) return;
      const next = `${dir || base}/${sanitizeAssetFolderName(entry.name) || entry.name}`;
      newFolders.add(next);
      const reader = entry.createReader();
      // readEntries returns results in batches; loop until an empty batch.
      for (;;) {
        const batch = await new Promise<FsEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (!batch.length) break;
        for (const child of batch) await walk(child, next);
      }
    };
    for (const entry of roots) await walk(entry, "");
    if (newFolders.size) {
      setCustomAssetFolders((current) => [...new Set([...current, ...newFolders])]);
    }
    return out;
  }

  function handleAssetBinDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!canDropFiles || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  }

  function handleAssetBinDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!canDropFiles || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }

  function handleAssetBinDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!canDropFiles || !event.dataTransfer.types.includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDropActive(false);
    }
  }

  function handleAssetBinDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!canDropFiles || !event.dataTransfer.files.length) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    // Directory drops import recursively (folder structure → bin folders); plain files keep the
    // fast path. The traversal must read items BEFORE any await (the DataTransfer goes stale).
    const items = event.dataTransfer.items;
    const files = event.dataTransfer.files;
    void (async () => {
      const traversed = items?.length ? await collectDroppedEntries(items) : null;
      await processUploadFiles(traversed ?? files);
    })();
  }

  // List view rows, flattened from the bin tree (expanded bins inline their children, Premiere
  // Project-panel style). Search flattens to plain results; non-folder tabs have no bins.
  type AssetListNode = { kind: "bin"; folder: AssetBinFolder; depth: number } | { kind: "asset"; asset: SourceAsset; depth: number };
  const listNodes: AssetListNode[] = [];
  if (view === "list" && sourceTab !== "search") {
    if (folderTab && !queryText) {
      const assetsOf = (folderPath: string) =>
        assets
          .filter((asset) => {
            const assetFolder = normalizeAssetFolder(asset.folder) || folderRoot;
            return (
              assetFolder === folderPath &&
              matchesAssetTab(asset, folderTab, Boolean(usedCounts[asset.id])) &&
              matchesTypeFilter(asset, filter)
            );
          })
          .sort(compareAssets);
      const walk = (folderPath: string, depth: number) => {
        for (const bin of childFoldersOf(folderPath)) {
          listNodes.push({ kind: "bin", folder: bin, depth });
          if (expandedBins.includes(bin.path)) walk(bin.path, depth + 1);
        }
        for (const asset of assetsOf(folderPath)) listNodes.push({ kind: "asset", asset, depth });
      };
      walk(activeFolder, 0);
    } else {
      for (const asset of sortedAssets) listNodes.push({ kind: "asset", asset, depth: 0 });
    }
  }
  const listOrderedAssets = listNodes.flatMap((node) => (node.kind === "asset" ? [node.asset] : []));

  // View + size controls — shared by the library tabs and the Stock tab.
  const viewControls = (
    <div className="asset-icon-row" aria-label="Asset view">
      <button className={view === "tiles" ? "is-active" : ""} type="button" title="Tile view" onClick={() => setView("tiles")}>
        <Grid2X2 size={14} />
      </button>
      <button className={view === "list" ? "is-active" : ""} type="button" title="List view" onClick={() => setView("list")}>
        <LayoutList size={14} />
      </button>
      <button className={size === "small" ? "is-active" : ""} type="button" title="Small tiles" onClick={() => setSize("small")}>
        S
      </button>
      <button className={size === "medium" ? "is-active" : ""} type="button" title="Medium tiles" onClick={() => setSize("medium")}>
        M
      </button>
      <button className={size === "large" ? "is-active" : ""} type="button" title="Large tiles" onClick={() => setSize("large")}>
        L
      </button>
    </div>
  );
  const assetPanelFooter =
    sourceTab === "search" ? (
      <div className="asset-control-strip" aria-label="Asset panel controls">
        <div className="asset-control-left">{viewControls}</div>
      </div>
    ) : (
      <div className="asset-control-strip" aria-label="Asset panel controls">
        <div className="asset-control-left">
          <div className="asset-icon-row" aria-label="Asset filters">
            {(["all", "video", "image", "audio", "graphics"] as const).map((typeFilter) => (
              <button
                key={typeFilter}
                className={filter === typeFilter ? "is-active" : ""}
                type="button"
                title={typeFilter}
                onClick={() => setFilter(typeFilter)}
              >
                {typeFilter === "all" ? (
                  "All"
                ) : typeFilter === "video" ? (
                  <Film size={14} />
                ) : typeFilter === "image" ? (
                  <Image size={14} />
                ) : typeFilter === "audio" ? (
                  <Music size={14} />
                ) : (
                  <Palette size={14} />
                )}
              </button>
            ))}
          </div>
          {viewControls}
        </div>
        <div className="asset-control-actions">
          {folderTab ? (
            <button type="button" className="asset-toolbar-button" title="New bin" onClick={() => createAssetFolder()}>
              <FolderPlus size={14} />
            </button>
          ) : null}
          {showUpload ? (
            <label className="asset-upload-button" title={sourceTab === "brand" ? "Upload brand asset" : "Upload media"}>
              <input
                accept={uploadAccept}
                multiple
                type="file"
                onChange={(event) => {
                  void processUploadFiles(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                }}
              />
              <Upload size={14} />
            </label>
          ) : null}
        </div>
      </div>
    );

  const binTabs = (
    <div className="asset-bin-tabs" role="tablist" aria-label="Asset library">
      {ASSET_TABS.filter((tab) => !(clickAssigns && tab.id === "templates") && !(tab.id === "timelines" && !timelines)).map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={sourceTab === tab.id}
          className={sourceTab === tab.id ? "is-active" : ""}
          onClick={() => {
            setSourceTab(tab.id);
            setQuery("");
          }}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );

  // Timelines TAB (nesting Block 3, restructured 2026-07-17): a first-class source tab — zero
  // vertical cost when inactive, the whole panel (scrollable) when active. A persisted "timelines"
  // tab in a host with no timeline data (inspector picker) falls through to the normal bin.
  if (sourceTab === "timelines" && timelines) {
    return (
      <div className="asset-bin asset-bin-timelines-tab">
        {binTabs}
        <TimelinesPanel
          compositions={timelines.entries}
          rootId={timelines.rootId}
          activeId={timelines.activeId}
          onOpen={onOpenTimeline ?? (() => {})}
          onInsertAtPlayhead={onInsertTimelineAtPlayhead ?? (() => {})}
          onRename={onRenameTimeline ?? (() => {})}
          onDuplicate={onDuplicateTimeline ?? (() => {})}
          onDelete={onDeleteTimeline ?? (() => {})}
          onCreate={onCreateTimeline ?? (() => {})}
        />
      </div>
    );
  }

  return (
    <div
      className={`asset-bin asset-bin-${view} asset-bin-${size} ${replaceActive ? "is-replace-mode" : ""} ${dropActive ? "is-drop-active" : ""}`}
      onDragEnter={handleAssetBinDragEnter}
      onDragOver={handleAssetBinDragOver}
      onDragLeave={handleAssetBinDragLeave}
      onDrop={handleAssetBinDrop}
    >
      {binTabs}
      {replaceActive ? (
        <div className="asset-replace-banner">
          <span>Pick an asset to replace the selected clip</span>
          <button type="button" onClick={() => onCancelReplace?.()}>
            Cancel
          </button>
        </div>
      ) : null}
      {sourceTab === "search" ? (
        <div className="asset-stock-controls">
          {/* Type chips — no provider identity shown anywhere; Photos/Videos hit stock search, Graphics
              merges the offline bundled pack with searchable Iconify icons. */}
          <div className="asset-subtabs" role="tablist" aria-label="Search type">
            {(["image", "video", "graphics", "frames", "templates"] as const).map((kind) => (
              <button key={kind} type="button" className={stockType === kind ? "is-active" : ""} onClick={() => setStockType(kind)}>
                {kind === "image" ? "Photos" : kind === "video" ? "Videos" : kind === "graphics" ? "Graphics" : kind === "frames" ? "Frames" : "Templates"}
              </button>
            ))}
          </div>
          <div className="asset-search">
            <Search size={13} />
            <input
              placeholder={stockType === "graphics" ? "Search graphics…" : "Search stock…"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {stockType !== "graphics" && stockType !== "frames" ? (
            <div className="asset-stock-filters">
              <div className="asset-stock-filter">
                <ThemedSelect ariaLabel="Orientation" value={stockOrientation} groups={STOCK_ORIENTATION_GROUPS} onChange={setStockOrientation} />
              </div>
              <div className="asset-stock-filter">
                <ThemedSelect ariaLabel="Import quality" value={stockQuality} groups={STOCK_QUALITY_GROUPS} onChange={setStockQuality} />
              </div>
            </div>
          ) : null}
          {/* Browsing imported stock (no provider query): folder navigation, same as the library tabs (M0). */}
          {!query.trim() && folderTab === "search" ? (
            <div className="asset-folder-path" aria-label="Stock bin path">
              {folderCrumbs.map((crumb, index) => (
                <Fragment key={crumb.path}>
                  {index > 0 ? <ChevronRight size={12} aria-hidden="true" /> : null}
                  <button
                    type="button"
                    className={crumb.path === activeFolder ? "is-active" : ""}
                    onClick={() => selectAssetFolder(crumb.path)}
                    onDragOver={(event) => handleAssetFolderDragOver(event, crumb.path)}
                    onDrop={(event) => handleAssetFolderDrop(event, crumb.path)}
                  >
                    {index === 0 ? <FolderOpen size={13} /> : null}
                    <span>{crumb.label}</span>
                  </button>
                </Fragment>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="asset-bin-controls">
          {folderTab ? (
            <div className="asset-folder-path" aria-label={`${sourceTab === "brand" ? "Brand" : "Local"} bin path`}>
              {folderCrumbs.map((crumb, index) => (
                <Fragment key={crumb.path}>
                  {index > 0 ? <ChevronRight size={12} aria-hidden="true" /> : null}
                  <button
                    type="button"
                    className={crumb.path === activeFolder ? "is-active" : ""}
                    onClick={() => selectAssetFolder(crumb.path)}
                    onDragOver={(event) => handleAssetFolderDragOver(event, crumb.path)}
                    onDrop={(event) => handleAssetFolderDrop(event, crumb.path)}
                  >
                    {index === 0 ? <FolderOpen size={13} /> : null}
                    <span>{crumb.label}</span>
                  </button>
                </Fragment>
              ))}
            </div>
          ) : null}
          <div className="asset-bin-controls-top">
            <div className="asset-search">
              <Search size={13} />
              <input
                placeholder={folderTab ? `Search ${currentFolderLabel}` : "Search assets"}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          {showDropPrompt ? (
            <div className="asset-drop-zone" aria-hidden="true">
              <Upload size={14} />
              <span>{onImportFile ? "Drop media, Premiere/XML, or template files here" : "Drop media files here"}</span>
            </div>
          ) : null}
        </div>
      )}
      <div className="asset-content-scroll">
        {sourceTab === "search" && stockImportError ? (
          <div className="stock-import-error" role="alert">
            {stockImportError}
            <button type="button" title="Dismiss" onClick={() => setStockImportError(null)}>
              ×
            </button>
          </div>
        ) : null}
        {sourceTab === "search" && stockType === "frames" ? (
          <div className="asset-grid frames-grid">
            <div className="frames-grid-hint">Select an image or video clip, then pick a frame to shape it. Adjust it in the inspector's Effects tab.</div>
            {builtInFrames.map((def) => {
              const d = frameOutlinePathD(makeLayerFrame(def));
              return (
                <div
                  key={def.id}
                  className="asset-tile asset-stock-tile frame-tile"
                  role="button"
                  tabIndex={0}
                  title={`${def.name} — apply to the selected clip`}
                  onClick={() => onApplyFrame?.(def)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") onApplyFrame?.(def);
                  }}
                >
                  <div className="asset-graphic-preview frame-tile-preview">
                    <svg viewBox="0 0 1 1" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                      <path d={d} />
                    </svg>
                  </div>
                  <div className="asset-card-hover">
                    <div className="asset-card-info">
                      <strong>{def.name}</strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {sourceTab === "search" && stockType === "graphics" ? (
          <div className="asset-grid">
            <input
              ref={svgFileInputRef}
              type="file"
              accept=".svg,image/svg+xml"
              multiple
              style={{ display: "none" }}
              onChange={(event) => {
                handleImportSvgFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div
              className="asset-tile asset-stock-tile asset-import-tile"
              role="button"
              tabIndex={0}
              title="Import .svg files from disk as editable vector graphics"
              onClick={() => svgFileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") svgFileInputRef.current?.click();
              }}
            >
              <div className="asset-graphic-preview asset-import-preview">
                <Upload size={18} />
                <span>Import SVG</span>
              </div>
            </div>
            {savedGraphics.map((preset) => (
              <div className="asset-tile asset-stock-tile" key={preset.id} title={`${preset.name} (saved)`} role="button" tabIndex={0}>
                <div className="asset-graphic-preview">
                  <img src={graphicToDataUrl(preset.graphic)} alt={preset.name} loading="lazy" />
                </div>
                <div className="asset-card-hover">
                  <div className="asset-card-info">
                    <strong>{preset.name}</strong>
                  </div>
                  <div className="asset-card-actions">
                    <button
                      type="button"
                      className="asset-more-button"
                      title="Add to timeline"
                      onClick={() => onAddGraphic?.({ ...preset.graphic, palette: preset.graphic.palette?.map((slot) => ({ ...slot })) }, preset.name)}
                    >
                      <Plus size={14} />
                    </button>
                    <button type="button" className="asset-more-button" title="Delete saved graphic" onClick={() => deleteGraphicPreset(preset.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {graphicsLoading ? <div className="empty-mini">Searching graphics…</div> : null}
            {graphicsBundled.map((graphic) => (
              <div
                className="asset-tile asset-stock-tile"
                key={`bundled_${graphic.id}`}
                title={graphic.name}
                role="button"
                tabIndex={0}
              >
                <div className="asset-graphic-preview" dangerouslySetInnerHTML={{ __html: graphic.svg }} />
                <div className="asset-card-hover">
                  <div className="asset-card-info">
                    <strong>{graphic.name}</strong>
                  </div>
                  <div className="asset-card-actions">
                    <button
                      type="button"
                      className="asset-more-button"
                      aria-busy={importingId === `bundled_${graphic.id}`}
                      disabled={importingId === `bundled_${graphic.id}`}
                      title="Add to timeline"
                      onClick={() => handleImportGraphic(`bundled_${graphic.id}`, graphic.name, graphic.svg, DEFAULT_GRAPHIC_FILL)}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {graphicsIconify.map((icon) => (
              <div className="asset-tile asset-stock-tile" key={`iconify_${icon.iconId}`} title={icon.name} role="button" tabIndex={0}>
                <div className="asset-graphic-preview">
                  <img src={`https://api.iconify.design/${icon.iconId}.svg`} alt={icon.name} loading="lazy" />
                </div>
                <div className="asset-card-hover">
                  <div className="asset-card-info">
                    <strong>{icon.name}</strong>
                  </div>
                  <div className="asset-card-actions">
                    <button
                      type="button"
                      className="asset-more-button"
                      aria-busy={importingId === `iconify_${icon.iconId}`}
                      disabled={importingId === `iconify_${icon.iconId}`}
                      title="Add to timeline"
                      onClick={() =>
                        void fetchIconifySvg(icon.iconId).then((svg) => {
                          if (svg) void handleImportGraphic(`iconify_${icon.iconId}`, icon.name, svg);
                        })
                      }
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {!graphicsLoading && !graphicsBundled.length && !graphicsIconify.length ? (
              <div className="empty-mini">No graphics found</div>
            ) : null}
            {graphicsHasMore && !graphicsLoading ? (
              <div className="asset-load-more">
                <button type="button" onClick={() => setGraphicsLimit((limit) => limit + GRAPHICS_PAGE_SIZE)}>
                  Show more
                </button>
              </div>
            ) : null}
            {graphicsRecommend && graphicsRecommend.results.length ? (
              <div className="asset-recommend">
                <div className="asset-recommend-head">
                  <Sparkles size={13} />
                  <span>More like “{graphicsRecommend.keyword}”</span>
                  <button type="button" title="Dismiss recommendations" onClick={() => setGraphicsRecommend(null)}>
                    ×
                  </button>
                </div>
                <div className="asset-recommend-grid">
                  {graphicsRecommend.results.slice(0, 12).map((icon) => (
                    <button
                      type="button"
                      className="asset-recommend-tile"
                      key={`rec_${icon.iconId}`}
                      title={`Add ${icon.name}`}
                      aria-busy={importingId === `iconify_${icon.iconId}`}
                      disabled={importingId === `iconify_${icon.iconId}`}
                      onClick={() =>
                        void fetchIconifySvg(icon.iconId).then((svg) => {
                          if (svg) void handleImportGraphic(`iconify_${icon.iconId}`, icon.name, svg);
                        })
                      }
                    >
                      <img src={`https://api.iconify.design/${icon.iconId}.svg`} alt={icon.name} loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : sourceTab === "search" && stockType !== "templates" && !stockConfigured ? (
          <div className="asset-empty-state">
            <Globe size={18} />
            <strong>Stock search not connected</strong>
            <span>Add PEXELS_API_KEY to your .env to search and import stock {stockType === "image" ? "photos" : "videos"}.</span>
          </div>
        ) : sourceTab === "search" && stockType !== "templates" && query.trim() ? (
          <div className="asset-grid">
          {stockLoading ? (
            <div className="empty-mini">Searching…</div>
          ) : stockResults.length ? (
            stockResults.map((result) => (
              <div
                className="asset-tile asset-stock-tile"
                key={`${result.provider}_${result.externalId}`}
                title={result.author ?? "Stock"}
                role="button"
                tabIndex={0}
                onDoubleClick={() => setViewerTarget({ kind: "stock", result })}
              >
                <StockCardMedia result={result} />
                <span className="asset-type-chip" title={result.type}>
                  {result.type === "video" ? <Film size={11} /> : <Image size={11} />}
                </span>
                {result.width && result.height ? (
                  <span className="asset-chip asset-chip-duration">{result.width}×{result.height}</span>
                ) : null}
                <div className="asset-card-hover">
                  <div className="asset-card-info">
                    <strong>{result.author ?? "Stock"}</strong>
                    {result.width && result.height ? <small>{result.width}×{result.height}</small> : null}
                  </div>
                  <div className="asset-card-actions">
                    <button
                      type="button"
                      className="asset-more-button"
                      aria-busy={importingId === result.externalId}
                      disabled={importingId === result.externalId}
                      title={importingId === result.externalId ? "Importing…" : "Import to library"}
                      onClick={() => void handleImportStock(result)}
                    >
                      <Download size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-mini">No {stockType === "image" ? "photos" : "videos"} found</div>
          )}
          {stockResults.length && stockHasMore ? (
            <div className="asset-load-more">
              <button type="button" disabled={stockLoadingMore} onClick={() => void handleLoadMoreStock()}>
                {stockLoadingMore ? "Loading…" : "Show more"}
              </button>
            </div>
          ) : null}
          </div>
        ) : sourceTab === "search" && stockType === "templates" ? (
          <div className="asset-grid">
            {templatesLoading ? <div className="empty-mini">Loading templates…</div> : null}
            {templatesList
              .filter((template) => !queryText || template.name.toLowerCase().includes(queryText) || template.category.toLowerCase().includes(queryText))
              .map((template) => {
                const isMine = Boolean(currentUserId && template.userId === currentUserId);
                return (
                  <div className="asset-tile asset-stock-tile" key={template.id} title={template.description} role="button" tabIndex={0}>
                    <div className="asset-card-media">
                      <img src={template.thumbnailUrl} alt={template.name} loading="lazy" />
                    </div>
                    <span className="asset-chip asset-chip-duration">{template.category}</span>
                    <div className="asset-card-hover">
                      <div className="asset-card-info">
                        <strong>{template.name}</strong>
                        <small>{isMine ? "My template" : "Curated"}</small>
                      </div>
                      <div className="asset-card-actions">
                        {isMine ? (
                          <button type="button" className="asset-more-button" title="Delete template" onClick={() => void handleDeleteTemplateClick(template)}>
                            <Trash2 size={14} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="asset-more-button"
                          aria-busy={applyingTemplateId === template.id}
                          disabled={applyingTemplateId === template.id}
                          title="Add to timeline"
                          onClick={() => void handleApplyTemplateClick(template)}
                        >
                          <Download size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            {!templatesLoading && !templatesList.length ? <div className="empty-mini">No templates yet — save one from the topbar</div> : null}
          </div>
        ) : view === "list" ? (
          // Premiere-style Project-panel LIST view (2026-07-04): real columns with sortable headers,
          // dense rows, cheap thumbnails (thumbnailUrl only — no per-row decoders), drag-to-bin on
          // folder rows, drag-to-timeline on asset rows. Tiles view below is unchanged.
          <div className="asset-list" role="table" aria-label="Assets">
            {listNodes.length ? (
              <>
                <div className="asset-list-head" role="row">
                  {(
                    [
                      ["name", "Name"],
                      ["type", "Type"],
                      ["duration", "Duration"],
                      ["dimensions", "Size"],
                      ["used", "Used"]
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="columnheader"
                      className={sortKey === key ? "is-sorted" : ""}
                      title={`Sort by ${label.toLowerCase()}`}
                      onClick={() => toggleSort(key)}
                    >
                      {label}
                      {sortKey === key ? <span className="asset-sort-arrow">{sortDir === 1 ? "▲" : "▼"}</span> : null}
                    </button>
                  ))}
                  <span aria-hidden="true" />
                </div>
                {listNodes.map((node) => {
                  if (node.kind === "bin") {
                    const folder = node.folder;
                    const expanded = expandedBins.includes(folder.path);
                    return (
                      <div
                        key={`bin_${folder.path}`}
                        role="row"
                        tabIndex={0}
                        className="asset-list-row asset-list-folder"
                        style={{ "--asset-indent": `${node.depth * 16}px` } as CSSProperties}
                        title={`${folder.path} — click to expand, double-click to open, drag onto a bin to nest`}
                        draggable
                        onClick={() => toggleBinExpanded(folder.path)}
                        onDoubleClick={() => selectAssetFolder(folder.path)}
                        onKeyDown={(event) => {
                          if (renamingFolder === folder.path) return;
                          if (event.key === "Enter") toggleBinExpanded(folder.path);
                          if (event.key === "F2") setRenamingFolder(folder.path);
                          if (event.key === "Delete") deleteAssetFolder(folder.path);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setFolderMenu({ path: folder.path, left: Math.max(8, Math.min(event.clientX, window.innerWidth - 252)), top: clampMenuTop(event.clientY) });
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("application/x-kimera-asset-folder", folder.path);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(event) => handleAssetFolderDragOver(event, folder.path)}
                        onDrop={(event) => handleAssetFolderDrop(event, folder.path)}
                      >
                        <span className="asset-list-thumb">
                          {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                        </span>
                        <span className="asset-list-name">
                          <span className={`asset-list-twisty ${expanded ? "is-open" : ""}`} aria-hidden="true">
                            <ChevronRight size={12} />
                          </span>
                          {renamingFolder === folder.path ? (
                            <FolderRenameInput
                              path={folder.path}
                              onCommit={(name) => applyRenameFolder(folder.path, name)}
                              onCancel={() => setRenamingFolder(null)}
                            />
                          ) : (
                            <strong>{folder.label}</strong>
                          )}
                        </span>
                        <span className="asset-list-cell">Bin</span>
                        <span className="asset-list-cell">—</span>
                        <span className="asset-list-cell">
                          {folder.assetCount + folder.childCount ? `${folder.assetCount} it. · ${folder.childCount} bins` : "empty"}
                        </span>
                        <span className="asset-list-cell">—</span>
                        <span className="asset-list-actions" />
                      </div>
                    );
                  }
                  const asset = node.asset;
                  const kind = assetKind(asset);
                  const used = usedCounts[asset.id] ?? 0;
                  const labelName = assetLabelOf(asset);
                  const isSelected = selectedIds.includes(asset.id) || selectedAssetId === asset.id;
                  const assetFolder = normalizeAssetFolder(asset.folder) || (folderTab ? folderRoot : "");
                  const moveTargets = folderTab
                    ? [
                        { path: folderRoot, label: sourceTab === "brand" ? "Brand root" : "Local root" },
                        ...folderOptions.map((folder) => ({ path: folder.path, label: folder.path.slice(folderRoot.length + 1) || folder.label }))
                      ].filter((folder) => folder.path !== assetFolder)
                    : [];
                  const durationLabel =
                    (kind === "video" || kind === "audio") && asset.durationSeconds ? `${Math.round(asset.durationSeconds)}s` : "—";
                  const dims = asset.width && asset.height ? `${asset.width}×${asset.height}` : "—";
                  return (
                    <div
                      key={asset.id}
                      role="row"
                      tabIndex={0}
                      className={`asset-list-row asset-list-${kind} ${isSelected ? "is-selected" : ""}`}
                      style={
                        {
                          // Pure depth indent: root files sit flush with root bins; only children
                          // of an expanded bin step inward (one step per nesting level).
                          "--asset-indent": `${node.depth * 16}px`,
                          // Every asset wears a label (explicit or type default) — Premiere-style.
                          "--asset-label": ASSET_LABEL_COLORS[labelName ?? defaultAssetLabelOf(asset)]
                        } as CSSProperties
                      }
                      draggable
                      title={asset.originalName ?? asset.fileName}
                      onClick={(event) => handleAssetSelect(event, asset, listOrderedAssets)}
                      onDoubleClick={() => {
                        if (replaceActive) { onPickReplacement?.(asset); return; }
                        const timeBased = asset.fileType.startsWith("video/") || asset.fileType.startsWith("audio/");
                        if (timeBased && onOpenSourceMonitor) { onOpenSourceMonitor(asset); return; }
                        setViewerTarget({ kind: "asset", asset });
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openAssetMenuAtCursor(asset.id, event.clientX, event.clientY);
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/x-kimera-asset", asset.id);
                        event.dataTransfer.effectAllowed = "copyMove";
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          handleTileActivate(asset);
                        }
                      }}
                    >
                      <span className="asset-list-thumb">
                        {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" draggable={false} /> : assetTypeIcon(kind)}
                      </span>
                      <span className="asset-list-name">
                        <strong>{asset.originalName ?? asset.fileName}</strong>
                      </span>
                      <span className="asset-list-cell asset-list-kind">{kind}</span>
                      <span className="asset-list-cell">{durationLabel}</span>
                      <span className="asset-list-cell">{dims}</span>
                      <span className="asset-list-cell asset-list-used">
                        {used ? (
                          <button
                            type="button"
                            title={`${used} use${used === 1 ? "" : "s"} — find on the timeline`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onFocusAssetUse?.(asset.id);
                            }}
                          >
                            {used}
                          </button>
                        ) : (
                          "—"
                        )}
                      </span>
                      <span className="asset-list-actions">
                        <button
                          type="button"
                          title={replaceActive ? "Replace clip asset" : "Add to timeline"}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (replaceActive) onPickReplacement?.(asset);
                            else onAddAssetToTimeline?.(asset, "auto");
                          }}
                        >
                          <Plus size={13} />
                        </button>
                        <button
                          className="asset-more-button"
                          type="button"
                          title="More"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (assetMenu?.id === asset.id) {
                              setAssetMenu(null);
                            } else {
                              openAssetMenuAtTrigger(asset.id, event.currentTarget);
                            }
                          }}
                        >
                          <MoreVertical size={13} />
                        </button>
                      </span>
                      {/* Portaled into .editor-page (ThemedSelect pattern): escapes the panel's
                          transform/backdrop-filter containing blocks so fixed coords are viewport-
                          true, while keeping the [data-kimera-theme] accent variable scope. */}
                      {assetMenu?.id === asset.id ? createPortal(
                        <div
                          className="asset-tile-menu asset-list-menu"
                          role="menu"
                          style={{ top: assetMenu.top, ...(assetMenu.left !== undefined ? { left: assetMenu.left } : { right: assetMenu.right }) }}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {onSetAssetLabel ? (
                            <div className="asset-label-swatches" role="group" aria-label="Color label">
                              {Object.entries(ASSET_LABEL_COLORS).map(([name, color]) => (
                                <button
                                  key={name}
                                  type="button"
                                  className={labelName === name ? "is-active" : ""}
                                  style={{ background: color }}
                                  title={`Label: ${name}`}
                                  onClick={() => {
                                    setAssetMenu(null);
                                    void onSetAssetLabel(asset, labelName === name ? null : name);
                                  }}
                                />
                              ))}
                            </div>
                          ) : null}
                          <button type="button" onClick={() => { setAssetMenu(null); setViewerTarget({ kind: "asset", asset }); }}>
                            <Eye size={13} /> Preview
                          </button>
                          <button type="button" onClick={() => { setAssetMenu(null); void downloadAssetFile(asset); }}>
                            <Download size={13} /> Download
                          </button>
                          {moveTargets.length ? (
                            <>
                              <span className="asset-tile-menu-label">Move to bin</span>
                              {moveTargets.map((folder) => (
                                <button
                                  key={folder.path}
                                  type="button"
                                  onClick={() => {
                                    setAssetMenu(null);
                                    void onMoveAssetFolder?.(asset, folder.path);
                                  }}
                                >
                                  <Move size={13} /> {folder.label}
                                </button>
                              ))}
                            </>
                          ) : null}
                          {onDeleteAsset ? (
                            <button type="button" className="is-danger" onClick={() => { setAssetMenu(null); onDeleteAsset(asset); }}>
                              <Trash2 size={13} /> Delete
                            </button>
                          ) : null}
                        </div>,
                        document.querySelector(".editor-page") ?? document.body
                      ) : null}
                    </div>
                  );
                })}
              </>
            ) : (
              assetEmptyState
            )}
          </div>
        ) : (
          <div className="asset-grid">
          {visibleFolders.length || filteredAssets.length ? (
            <>
              {visibleFolders.map((folder) => (
                <div
                  key={folder.path}
                  role="button"
                  tabIndex={0}
                  className="asset-tile asset-bin-folder"
                  title={`${folder.path} — open, right-click for actions, drag onto a bin to nest`}
                  draggable={renamingFolder !== folder.path}
                  onClick={() => {
                    if (renamingFolder !== folder.path) selectAssetFolder(folder.path);
                  }}
                  onKeyDown={(event) => {
                    if (renamingFolder === folder.path) return;
                    if (event.key === "Enter") selectAssetFolder(folder.path);
                    if (event.key === "F2") setRenamingFolder(folder.path);
                    if (event.key === "Delete") deleteAssetFolder(folder.path);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setFolderMenu({ path: folder.path, left: Math.max(8, Math.min(event.clientX, window.innerWidth - 252)), top: clampMenuTop(event.clientY) });
                  }}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-kimera-asset-folder", folder.path);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => handleAssetFolderDragOver(event, folder.path)}
                  onDrop={(event) => handleAssetFolderDrop(event, folder.path)}
                >
                  <span className="asset-folder-thumb">
                    <Folder size={22} />
                  </span>
                  <span className="asset-folder-row-main">
                    {renamingFolder === folder.path ? (
                      <FolderRenameInput
                        path={folder.path}
                        onCommit={(name) => applyRenameFolder(folder.path, name)}
                        onCancel={() => setRenamingFolder(null)}
                      />
                    ) : (
                      <strong>{folder.label}</strong>
                    )}
                    <small>
                      {folder.assetCount + folder.childCount
                        ? `${folder.assetCount} asset${folder.assetCount === 1 ? "" : "s"} · ${folder.childCount} bin${folder.childCount === 1 ? "" : "s"}`
                        : "Empty bin"}
                    </small>
                  </span>
                </div>
              ))}
              {filteredAssets.map((asset) => {
              const source = assetSourceOf(asset);
              const kind = assetKind(asset);
              const labelName = assetLabelOf(asset);
              const meta = formatAssetMeta(asset);
              // No cloud copy recorded yet (a synced local asset has cloudUrl → not local-only).
              const isLocalOnly = !asset.cloudUrl && (asset.fileUrl.startsWith("localblob:") || asset.id.startsWith("asset_local_"));
              const used = usedCounts[asset.id] ?? 0;
              const hasAudio = assetHasAudioStream(asset);
              const assetFolder = normalizeAssetFolder(asset.folder) || (folderTab ? folderRoot : "");
              const moveTargets = folderTab
                ? [
                    { path: folderRoot, label: sourceTab === "brand" ? "Brand root" : "Local root" },
                    ...folderOptions.map((folder) => ({ path: folder.path, label: folder.path.slice(folderRoot.length + 1) || folder.label }))
                  ].filter((folder) => folder.path !== assetFolder)
                : [];
              const durationLabel =
                (kind === "video" || kind === "audio") && asset.durationSeconds ? `${Math.round(asset.durationSeconds)}s` : null;
              return (
                <div
                  className={`asset-tile asset-tile-${kind} ${selectedIds.includes(asset.id) || selectedAssetId === asset.id ? "is-selected" : ""}`}
                  style={{ "--asset-label": ASSET_LABEL_COLORS[labelName ?? defaultAssetLabelOf(asset)] } as CSSProperties}
                  draggable
                  key={asset.id}
                  role="button"
                  tabIndex={0}
                  onClick={(event) => handleAssetSelect(event, asset, filteredAssets)}
                  onDoubleClick={() => {
                        if (replaceActive) { onPickReplacement?.(asset); return; }
                        const timeBased = asset.fileType.startsWith("video/") || asset.fileType.startsWith("audio/");
                        if (timeBased && onOpenSourceMonitor) { onOpenSourceMonitor(asset); return; }
                        setViewerTarget({ kind: "asset", asset });
                      }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openAssetMenuAtCursor(asset.id, event.clientX, event.clientY);
                  }}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-kimera-asset", asset.id);
                    event.dataTransfer.effectAllowed = "copyMove";
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleTileActivate(asset);
                    }
                  }}
                  title={asset.originalName ?? asset.fileName}
                >
                  <AssetCardMedia asset={asset} kind={kind} />
                  {/* The type chip reads as a button (users click the "camera") — make it one: preview the asset. */}
                  <button
                    type="button"
                    className="asset-type-chip"
                    title={`Preview ${kind}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setViewerTarget({ kind: "asset", asset });
                    }}
                  >
                    {assetTypeIcon(kind)}
                  </button>
                  <span className={`asset-badge asset-badge-source asset-badge-${source}`} title={ASSET_SOURCE_BADGE[source]}>
                    {ASSET_SOURCE_BADGE[source]}
                  </span>
                  {durationLabel ? <span className="asset-chip asset-chip-duration">{durationLabel}</span> : null}
                  {asset.cloudUrl ? (
                    <span className="asset-chip asset-chip-cloud" title="Synced to cloud">
                      <Cloud size={10} />
                    </span>
                  ) : null}
                  {used ? (
                    <button
                      type="button"
                      className="asset-chip asset-chip-used"
                      title={`${used === 1 ? "Used once" : `${used} uses`} — click to find on the timeline`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFocusAssetUse?.(asset.id);
                      }}
                    >
                      {used}
                    </button>
                  ) : null}
                  <div className="asset-card-hover">
                    <div className="asset-card-info">
                      <strong>{asset.originalName ?? asset.fileName}</strong>
                      {meta ? <small>{meta}</small> : null}
                    </div>
                    <div className="asset-card-actions">
                      {kind === "video" ? (
                        <>
                          <button type="button" title={replaceActive ? "Replace clip asset" : "Add video only"} onClick={(event) => { event.stopPropagation(); replaceActive ? onPickReplacement?.(asset) : onAddAssetToTimeline?.(asset, "video"); }}>
                            <Film size={14} />
                          </button>
                          <button type="button" disabled={!replaceActive && hasAudio === false} title={replaceActive ? "Replace clip asset" : hasAudio === false ? "No audio stream found" : "Add audio only"} onClick={(event) => { event.stopPropagation(); replaceActive ? onPickReplacement?.(asset) : onAddAssetToTimeline?.(asset, "audio"); }}>
                            <Music size={14} />
                          </button>
                          <button type="button" disabled={!replaceActive && hasAudio === false} title={replaceActive ? "Replace clip asset" : hasAudio === false ? "No audio stream found" : "Add linked video + audio"} onClick={(event) => { event.stopPropagation(); replaceActive ? onPickReplacement?.(asset) : onAddAssetToTimeline?.(asset, "both"); }}>
                            <Layers size={14} />
                          </button>
                        </>
                      ) : kind === "file" ? null : (
                        <button type="button" title={replaceActive ? "Replace clip asset" : "Add to timeline"} onClick={(event) => { event.stopPropagation(); replaceActive ? onPickReplacement?.(asset) : onAddAssetToTimeline?.(asset, "auto"); }}>
                          <Plus size={15} />
                        </button>
                      )}
                      <button
                        className="asset-more-button"
                        type="button"
                        title="More"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (assetMenu?.id === asset.id) {
                            setAssetMenu(null);
                          } else {
                            openAssetMenuAtTrigger(asset.id, event.currentTarget);
                          }
                        }}
                      >
                        <MoreVertical size={14} />
                      </button>
                    </div>
                  </div>
                  {/* Portaled into .editor-page (ThemedSelect pattern): escapes the panel's
                      transform/backdrop-filter containing blocks so fixed coords are viewport-
                      true, while keeping the [data-kimera-theme] accent variable scope. */}
                  {assetMenu?.id === asset.id ? createPortal(
                    <div
                      className="asset-tile-menu"
                      role="menu"
                      style={{ top: assetMenu.top, ...(assetMenu.left !== undefined ? { left: assetMenu.left } : { right: assetMenu.right }) }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {onSetAssetLabel ? (
                        <div className="asset-label-swatches" role="group" aria-label="Color label">
                          {Object.entries(ASSET_LABEL_COLORS).map(([name, color]) => (
                            <button
                              key={name}
                              type="button"
                              className={labelName === name ? "is-active" : ""}
                              style={{ background: color }}
                              title={`Label: ${name}`}
                              onClick={() => {
                                setAssetMenu(null);
                                void onSetAssetLabel(asset, labelName === name ? null : name);
                              }}
                            />
                          ))}
                        </div>
                      ) : null}
                      {onUploadToCloud && isLocalOnly ? (
                        <button type="button" onClick={() => { setAssetMenu(null); onUploadToCloud(asset); }}>
                          <CloudUpload size={13} /> Upload to cloud
                        </button>
                      ) : asset.cloudUrl && !isLocalOnly ? (
                        <>
                          <span className="asset-tile-menu-note">
                            <Cloud size={13} /> In cloud
                          </span>
                          {onRemoveFromCloud ? (
                            <button type="button" onClick={() => { setAssetMenu(null); onRemoveFromCloud(asset); }}>
                              <CloudOff size={13} /> Remove from cloud
                            </button>
                          ) : null}
                        </>
                      ) : null}
                      {/* Corruption repair: replace the on-device bytes from the recorded cloud/provider copy. */}
                      {onRefreshFromCloud && (asset.cloudUrl || (!isLocalOnly && /^https?:/.test(asset.fileUrl))) ? (
                        <button type="button" onClick={() => { setAssetMenu(null); onRefreshFromCloud(asset); }}>
                          <RefreshCw size={13} /> Refresh from cloud
                        </button>
                      ) : null}
                      {/* URL-first stock (M3): the record streams from the provider — pin the bytes on-device. */}
                      {onPinOffline && (source === "pexels" || source === "unsplash") ? (
                        <button type="button" onClick={() => { setAssetMenu(null); onPinOffline(asset); }}>
                          <Download size={13} /> Pin offline
                        </button>
                      ) : null}
                      <button type="button" onClick={() => { setAssetMenu(null); void downloadAssetFile(asset); }}>
                        <Download size={13} /> Download
                      </button>
                      {moveTargets.length ? (
                        <>
                          <span className="asset-tile-menu-label">Move to bin</span>
                          {moveTargets.map((folder) => (
                            <button
                              key={folder.path}
                              type="button"
                              onClick={() => {
                                setAssetMenu(null);
                                void onMoveAssetFolder?.(asset, folder.path);
                              }}
                            >
                              <Move size={13} /> {folder.label}
                            </button>
                          ))}
                        </>
                      ) : null}
                      {onDeleteAsset ? (
                        <button type="button" className="is-danger" onClick={() => { setAssetMenu(null); onDeleteAsset(asset); }}>
                          <Trash2 size={13} /> Delete
                        </button>
                      ) : null}
                    </div>,
                    document.querySelector(".editor-page") ?? document.body
                  ) : null}
                </div>
              );
            })}
            </>
          ) : (
            assetEmptyState
          )}
          </div>
        )}
      </div>
      {selectedAssets.length > 1 ? (
        <div className="asset-batch-bar" role="toolbar" aria-label="Selected assets">
          <span className="asset-batch-count">{selectedAssets.length} selected</span>
          {onSetAssetLabel ? (
            <div className="asset-label-swatches" role="group" aria-label="Label selected">
              {Object.entries(ASSET_LABEL_COLORS).map(([name, color]) => (
                <button
                  key={name}
                  type="button"
                  style={{ background: color }}
                  title={`Label all: ${name}`}
                  onClick={() => {
                    // Sequential on purpose: each call is a read-modify-write of the asset store.
                    void (async () => {
                      for (const asset of selectedAssets) await onSetAssetLabel(asset, name);
                    })();
                  }}
                />
              ))}
              <button
                type="button"
                className="asset-label-clear"
                title="Clear label"
                onClick={() => {
                  void (async () => {
                    for (const asset of selectedAssets) await onSetAssetLabel(asset, null);
                  })();
                }}
              >
                ×
              </button>
            </div>
          ) : null}
          {folderTab && onMoveAssetFolder ? (
            <select
              className="asset-batch-move"
              value=""
              aria-label="Move selected to bin"
              onChange={(event) => {
                const target = event.currentTarget.value;
                if (!target) return;
                void (async () => {
                  for (const asset of selectedAssets) await onMoveAssetFolder(asset, target);
                })();
                setSelectedIds([]);
              }}
            >
              <option value="">Move to bin…</option>
              <option value={folderRoot}>{sourceTab === "brand" ? "Brand root" : "Local root"}</option>
              {folderOptions.map((folder) => (
                <option key={folder.path} value={folder.path}>
                  {folder.path.slice(folderRoot.length + 1) || folder.label}
                </option>
              ))}
            </select>
          ) : null}
          {onDeleteAsset ? (
            <button
              type="button"
              className="asset-batch-delete"
              title="Delete selected assets"
              onClick={() => {
                if (!window.confirm(`Delete ${selectedAssets.length} assets? Clips using them are removed from the timeline.`)) return;
                for (const asset of selectedAssets) onDeleteAsset(asset);
                setSelectedIds([]);
              }}
            >
              <Trash2 size={13} /> Delete
            </button>
          ) : null}
          <button type="button" className="asset-batch-clear" title="Clear selection (Esc)" onClick={() => setSelectedIds([])}>
            Clear
          </button>
        </div>
      ) : null}
      {assetPanelFooter}
      {/* Folder (bin) context menu — file-explorer actions. Fixed-position portal, same pattern as
          the asset menu (a menu inside the multi-column grid paints across columns and clips). */}
      {folderMenu
        ? createPortal(
            (() => {
              const menuPath = folderMenu.path;
              const menuParent = parentAssetFolder(menuPath) || folderRoot;
              const folderMoveTargets = [
                { path: folderRoot, label: `${folderTabLabel} root` },
                ...folderOptions.map((entry) => ({ path: entry.path, label: entry.path.slice(folderRoot.length + 1) || entry.label }))
              ].filter(
                (target) =>
                  target.path !== menuPath &&
                  target.path !== menuParent &&
                  !isAssetFolderDescendant(target.path, menuPath)
              );
              return (
                <div className="asset-tile-menu asset-folder-menu" style={{ position: "fixed", left: folderMenu.left, top: folderMenu.top }}>
                  <button type="button" onClick={() => { setFolderMenu(null); selectAssetFolder(menuPath); }}>
                    <FolderOpen size={13} /> Open
                  </button>
                  <button type="button" onClick={() => { setFolderMenu(null); createAssetFolder(menuPath); }}>
                    <FolderPlus size={13} /> New bin inside
                  </button>
                  <button type="button" onClick={() => { setFolderMenu(null); setRenamingFolder(menuPath); }}>
                    <PenLine size={13} /> Rename
                  </button>
                  {folderMoveTargets.length ? (
                    <>
                      <span className="asset-tile-menu-label">Move to</span>
                      {folderMoveTargets.map((target) => (
                        <button
                          key={target.path}
                          type="button"
                          onClick={() => {
                            setFolderMenu(null);
                            moveFolderIntoFolder(menuPath, target.path);
                          }}
                        >
                          <Move size={13} /> {target.label}
                        </button>
                      ))}
                    </>
                  ) : null}
                  <button type="button" className="is-danger" onClick={() => { setFolderMenu(null); deleteAssetFolder(menuPath); }}>
                    <Trash2 size={13} /> Delete bin (assets move up)
                  </button>
                </div>
              );
            })(),
            document.querySelector(".editor-page") ?? document.body
          )
        : null}
      <AssetViewerModal
        target={viewerTarget}
        importing={Boolean(importingId)}
        onClose={() => setViewerTarget(null)}
        onAddToTimeline={onAddAssetToTimeline}
        onImport={(result, variant) => void handleImportStock(result, variant)}
        onUploadToCloud={onUploadToCloud}
        onRemoveFromCloud={onRemoveFromCloud}
        onDelete={onDeleteAsset}
      />
    </div>
  );
}


// Hoisted panelIds for the InspectorHosts below — fresh array literals would defeat their memo.
const TRANSFORM_PANEL_IDS = ["transform"];
const CONTENT_PANEL_IDS = ["content"];
const MASK_PANEL_IDS = ["mask"];
const TEXT_WARP_PANEL_IDS = ["text.warp"];
const GRAPHIC_PANEL_IDS = ["graphic"];

/**
 * memo(): rides <ColdTime>, whose render-prop re-runs on every EditorPage render. All callbacks
 * arrive via the identity-stable inspectorHandlers block; data props are state/memoized, so
 * unrelated editor renders (toasts already bypass React entirely, modals, asset churn) skip the
 * whole inspector column. Still re-renders when it must: layer/composition edits, selection, and
 * the cold playhead commit while playing (currentTime prop).
 */
const LayerInspector = memo(LayerInspectorImpl);

function LayerInspectorImpl({
  assets,
  palette,
  hideAssetBin = false,
  layer,
  composition,
  currentTime,
  tracks,
  onAssignAsset,
  onAttachTrack,
  onDeleteAsset,
  onUploadAsset,
  onEditTrack,
  onOpenTrackModal,
  onRemoveTrack,
  onSeek,
  onChange,
  onChangeSpeed,
  activeMaskId,
  onSelectMask,
  onChangeMaskTool,
  onSelectEffectMask,
  onSelectLayer,
  onChangeLayer,
  onChangeLayers,
  onDuplicateLayer,
  onDeleteLayer,
  onDuplicateLayers,
  onDeleteLayers,
  onGroupLayers,
  onUngroupLayer,
  onReorderLayer,
  nestedCompositions,
  selectedLayerIds,
  primaryLayerId,
  textStyles,
  onSaveTextStyle,
  onApplyTextStyle,
  onUpdateTextStyle,
  onRenameTextStyle,
  onDeleteTextStyle,
  autoKeyframe
}: {
  assets: SourceAsset[];
  palette: string[];
  hideAssetBin?: boolean;
  layer: TimelineLayer;
  composition: TimelineComposition;
  currentTime: number;
  autoKeyframe?: boolean | undefined;
  tracks: SavedTrack[];
  onAssignAsset: (asset: SourceAsset) => void;
  onAttachTrack: (trackId: string) => void;
  onDeleteAsset?: ((asset: SourceAsset) => void) | undefined;
  onUploadAsset: (file: File | null) => void;
  onEditTrack: (trackId: string) => void;
  onOpenTrackModal: () => void;
  onRemoveTrack: (trackId: string) => void;
  onSeek: (timeSeconds: number) => void;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  /** Rate stretch: composition-level speed change (duration re-derives; linked companions follow). */
  onChangeSpeed?: ((layerId: string, speed: number) => void) | undefined;
  activeMaskId?: string | undefined;
  onSelectMask?: ((maskId: string | null) => void) | undefined;
  onChangeMaskTool?: ((tool: MaskTool) => void) | undefined;
  onSelectEffectMask?: ((effectId: string, maskId: string | null) => void) | undefined;
  /** Graphics tab (layer stack): select / edit a layer OTHER than the inspected one. */
  onSelectLayer?: ((layerId: string, mode?: LayerSelectMode) => void) | undefined;
  onChangeLayer?: ((layerId: string, updater: (layer: TimelineLayer) => TimelineLayer) => void) | undefined;
  /** Graphics tab align/distribute: batch-apply per-layer targets in one history entry. */
  onChangeLayers?: ((layerIds: string[], updater: (layer: TimelineLayer) => TimelineLayer) => void) | undefined;
  /** Graphics tab stack ops — same operations the timeline dispatches. */
  onDuplicateLayer?: ((layerId: string) => void) | undefined;
  onDeleteLayer?: ((layerId: string) => void) | undefined;
  /** Selection-aware stack ops — duplicate/delete an entire multi-selection in one history entry. */
  onDuplicateLayers?: ((layerIds: string[]) => void) | undefined;
  onDeleteLayers?: ((layerIds: string[]) => void) | undefined;
  onGroupLayers?: (() => void) | undefined;
  onUngroupLayer?: ((layerId: string) => void) | undefined;
  /** Graphics stack drag-reorder — change a layer's Z among same-track siblings. */
  onReorderLayer?: ((layerId: string, targetLayerId: string, place: "front-of" | "behind") => void) | undefined;
  /** graph.compositions — lets the Graphics stack render nested compositions (groups) hierarchically. */
  nestedCompositions?: Record<string, TimelineComposition> | undefined;
  /** Full editor selection (shared with the timeline) — drives multi-select align/distribute. */
  selectedLayerIds?: string[] | undefined;
  /** The layer whose controls the inspector is editing (multiSelectPrimaryLayer). */
  primaryLayerId?: string | undefined;
  /** Text tab — saved reusable Text Styles (§2) + their save/apply/update/rename/delete ops. */
  textStyles?: TextStyle[] | undefined;
  onSaveTextStyle?: (() => void) | undefined;
  onApplyTextStyle?: ((style: TextStyle) => void) | undefined;
  onUpdateTextStyle?: ((styleId: string) => void) | undefined;
  onRenameTextStyle?: ((styleId: string, name: string) => void) | undefined;
  onDeleteTextStyle?: ((styleId: string) => void) | undefined;
}) {
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);
  const [dragEffectId, setDragEffectId] = useState<string | null>(null);
  const [dragOverEffectId, setDragOverEffectId] = useState<string | null>(null);
  // Stable {width,height} for the mask InspectorHost — an inline literal would defeat its memo.
  const compositionSize = useMemo(
    () => ({ width: composition.width, height: composition.height }),
    [composition.width, composition.height]
  );

  // Graphics tab align/distribute participants: the selected layer OBJECTS (shared
  // editor selection), resolved against the composition. Falls back to the inspected
  // layer so a single selection still aligns. Kept as objects (not ids) so the panel
  // can compute geometry without re-walking the tree.
  const graphicsSelectedLayers = useMemo(() => {
    const ids = new Set(selectedLayerIds ?? []);
    if (!ids.size) return [layer];
    const all = composition.tracks.flatMap((track) => track.layers);
    const picked = all.filter((item) => ids.has(item.id));
    return picked.length ? picked : [layer];
  }, [selectedLayerIds, composition, layer]);

  // Resolve-style top-level tabs (2026-07-12): Video/Text/Shape | Audio | Effects | Color.
  // Remembered per layer type so switching clips keeps you on the tab you were working in.
  const [inspectorTab, setInspectorTab] = useState<InspectorTabId>(() => rememberedInspectorTab(layer.type));
  useEffect(() => {
    setInspectorTab(rememberedInspectorTab(layer.type));
  }, [layer.type]);
  const selectInspectorTab = (tab: InspectorTabId) => {
    rememberInspectorTab(layer.type, tab);
    setInspectorTab(tab);
  };
  // Video and Audio are both the "clip" tab — the blocks inside self-gate on layer.type.
  const isClipTab = inspectorTab === "video" || inspectorTab === "audio";

  // The Typewriter preset lives as textRevealProgress keyframes (layer.animations), not in
  // layer.effects — surface it in the Effects subtab as its own card so its speed is editable
  // where the user applied it from.
  const typewriterActive = layer.type === "text" && getStyleKeyframes(layer, "textRevealProgress").length > 0;

  return (
    // Dim/block the property body while locked — EXCEPT on the Graphics tab, whose layer stack is a
    // multi-layer manager (you must still be able to select/unlock other layers there).
    <div className={`inspector-panel${layer.locked && inspectorTab !== "graphics" ? " is-locked" : ""}`}>
      {!hideAssetBin && (layer.type === "video" || layer.type === "image") ? (
        <AssetBin assets={assets} selectedAssetId={layer.assetId} clickAssigns onAssignAsset={onAssignAsset} onDeleteAsset={onDeleteAsset} onUploadAsset={onUploadAsset} />
      ) : null}

      <InspectorTabs layerType={layer.type} active={inspectorTab} onChange={selectInspectorTab} />

      {layer.locked ? (
        // §4 full lock: every property edit below is a no-op while locked (canvas handles bail too).
        // Unlock writes through onChangeLayer, which bypasses the locked-onChange guard.
        <div className="inspector-lock-banner">
          <Lock size={13} />
          <span>Layer locked — properties are read-only.</span>
          <button
            type="button"
            onClick={() => onChangeLayer?.(layer.id, (item) => ({ ...item, locked: false }))}
          >
            Unlock
          </button>
        </div>
      ) : null}

      {isClipTab ? (
        <>
      {layer.type === "text" ? (
        <>
        <TextGraphicControls
          layer={layer}
          palette={palette}
          onChange={onChange}
          styleKf={makeStyleKeyframeTools(layer, currentTime, onChange, onSeek, autoKeyframe)}
          currentTime={currentTime}
          onSeek={onSeek}
        />
        {onSaveTextStyle && onApplyTextStyle && onUpdateTextStyle && onRenameTextStyle && onDeleteTextStyle ? (
          <TextStylesSection
            styles={textStyles ?? []}
            onSave={onSaveTextStyle}
            onApply={onApplyTextStyle}
            onUpdate={onUpdateTextStyle}
            onRename={onRenameTextStyle}
            onDelete={onDeleteTextStyle}
          />
        ) : null}
        </>
      ) : null}
      {layer.type === "shape" ? <ShapeGraphicControls layer={layer} palette={palette} onChange={onChange} /> : null}

      <InspectorHost
        layer={layer}
        onChange={onChange}
        panelIds={TRANSFORM_PANEL_IDS}
        currentTime={currentTime}
        onSeek={onSeek}
        autoKeyframe={autoKeyframe}
      />

      {layer.type === "video" || layer.type === "image" ? (
        <InspectorHost layer={layer} onChange={onChange} panelIds={CONTENT_PANEL_IDS} currentTime={currentTime} onSeek={onSeek} autoKeyframe={autoKeyframe} />
      ) : null}

      {onChangeSpeed && (layer.type === "video" || layer.type === "audio") && layer.assetId ? (
        <InspectorSection title="Speed" icon={<ChevronsRight size={13} />} count={0} defaultOpen={false}>
          <ClipSpeedControl layer={layer} layerTime={layerTime} onChange={onChange} onChangeSpeed={onChangeSpeed} onSeek={onSeek} />
        </InspectorSection>
      ) : null}

      {layer.type === "video" || layer.type === "image" || layer.type === "text" || layer.type === "shape" ? (
        <InspectorHost
          layer={layer}
          onChange={onChange}
          panelIds={MASK_PANEL_IDS}
          currentTime={currentTime}
          onSeek={onSeek}
          composition={compositionSize}
          activeMaskId={activeMaskId}
          onSelectMask={onSelectMask}
          onChangeMaskTool={onChangeMaskTool}
          trackLibrary={tracks}
          autoKeyframe={autoKeyframe}
        />
      ) : null}

      <InspectorSection title="Track" icon={<Move size={13} />} count={tracks.length} defaultOpen={false}>
        <AttachTrackPanel layer={layer} tracks={tracks} onAttach={onAttachTrack} onEditTrack={onEditTrack} onOpenTrackModal={onOpenTrackModal} onRemoveTrack={onRemoveTrack} />
      </InspectorSection>
        </>
      ) : null}

      {inspectorTab === "effects" ? (
      <InspectorSection title="Effects" icon={<SlidersHorizontal size={13} />} count={layer.effects.length + (typewriterActive ? 1 : 0) + (layer.frame ? 1 : 0)}>
      <EffectPresetRow layer={layer} onChange={onChange} />
      <div className="effect-controls">
        {layer.frame ? <FrameEffectCard layer={layer} comp={{ width: composition.width, height: composition.height }} onChange={onChange} /> : null}
        {typewriterActive ? <TypewriterEffectCard layer={layer} onChange={onChange} /> : null}
        {layer.effects.length ? (
          layer.effects.map((effect, index) => (
            <div
              key={effect.id}
              className={`effect-drag-row${dragOverEffectId === effect.id && dragEffectId !== effect.id ? " is-drag-over" : ""}${dragEffectId === effect.id ? " is-dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragEffectId && dragEffectId !== effect.id) setDragOverEffectId(effect.id);
              }}
              onDragLeave={() => setDragOverEffectId(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragEffectId && dragEffectId !== effect.id) {
                  const toIndex = index;
                  onChange((item) => {
                    const effects = [...item.effects];
                    const fromIndex = effects.findIndex((candidate) => candidate.id === dragEffectId);
                    if (fromIndex === -1) return item;
                    const removed = effects.splice(fromIndex, 1);
                    const dragged = removed[0];
                    if (!dragged) return item;
                    effects.splice(toIndex, 0, dragged);
                    return { ...item, effects };
                  });
                }
                setDragEffectId(null);
                setDragOverEffectId(null);
              }}
              onDragEnd={() => {
                setDragEffectId(null);
                setDragOverEffectId(null);
              }}
            >
              <span
                className="effect-drag-handle"
                title="Drag to reorder"
                draggable
                onDragStart={(e) => {
                  setDragEffectId(effect.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDragEffectId(null);
                  setDragOverEffectId(null);
                }}
              >
                <GripVertical size={13} />
              </span>
              <TimelineEffectControl
                effect={effect}
                layer={layer}
                layerTime={layerTime}
                palette={palette}
                composition={composition ? { width: composition.width, height: composition.height } : undefined}
                activeMaskId={activeMaskId}
                onSelectEffectMask={onSelectEffectMask}
                onChangeMaskTool={onChangeMaskTool}
                onChangeLayer={onChange}
                onSeek={onSeek}
                trackLibrary={tracks}
                onDelete={() =>
                  onChange((item) => {
                    // Per-item effect resolution (broadcast safety) + strip the effect's keyframes in
                    // the same write: leftovers with a dead effectId are invisible to the evaluator
                    // and the inspector — the "keyframes stopped responding" report.
                    const target =
                      item.effects.find((candidate) => candidate.id === effect.id) ?? item.effects.find((candidate) => candidate.type === effect.type);
                    if (!target) return item;
                    return {
                      ...item,
                      effects: item.effects.filter((candidate) => candidate.id !== target.id),
                      animations: (item.animations ?? []).filter((kf) => !(kf.target.scope === "effect" && kf.target.effectId === target.id))
                    };
                  })
                }
                onUpdate={(update) =>
                  onChange((item) => {
                    // Per-item effect resolution (broadcast safety, matches onDelete above): apply the
                    // change to EACH selected clip's OWN effect instance, not the primary's object,
                    // otherwise every other selected clip silently gets the primary's id/params (Mix
                    // slider, enable toggle, reset, non-numeric params multi-select gap).
                    const target =
                      item.effects.find((candidate) => candidate.id === effect.id) ?? item.effects.find((candidate) => candidate.type === effect.type);
                    if (!target) return item;
                    return {
                      ...item,
                      effects: item.effects.map((candidate) => (candidate.id === target.id ? update(target) : candidate))
                    };
                  })
                }
              />
            </div>
          ))
        ) : typewriterActive || layer.frame ? null : (
          <div className="empty-mini">
            <Eye size={16} />
            No layer effects yet
          </div>
        )}
      </div>
      </InspectorSection>
      ) : null}

      {inspectorTab === "graphics" ? (
        <>
          <GraphicsStackPanel
            composition={composition}
            nestedCompositions={nestedCompositions}
            currentTime={currentTime}
            selectedLayerIds={selectedLayerIds ?? [layer.id]}
            primaryLayerId={primaryLayerId ?? layer.id}
            onSelectLayer={onSelectLayer}
            onChangeLayer={onChangeLayer}
            onDuplicateLayer={onDuplicateLayer}
            onDeleteLayer={onDeleteLayer}
            onDuplicateLayers={onDuplicateLayers}
            onDeleteLayers={onDeleteLayers}
            onGroup={onGroupLayers}
            onUngroup={onUngroupLayer}
            onReorderLayer={onReorderLayer}
          />
          <GraphicsAlignPanel
            layer={layer}
            selectedLayers={graphicsSelectedLayers}
            composition={compositionSize}
            currentTime={currentTime}
            autoKeyframe={autoKeyframe}
            onChange={onChange}
            onChangeLayers={onChangeLayers}
          />
          <GraphicsPinPanel
            layer={layer}
            selectedLayers={graphicsSelectedLayers}
            onChange={onChange}
            onChangeLayers={onChangeLayers}
          />
          {layer.graphic ? (
            <InspectorHost layer={layer} onChange={onChange} panelIds={GRAPHIC_PANEL_IDS} currentTime={currentTime} onSeek={onSeek} autoKeyframe={autoKeyframe} />
          ) : null}
        </>
      ) : null}

      {inspectorTab === "color" ? (
        // Color sub-tab (user request 2026-07-16, reversing the 2026-07-12 "left panel only" call):
        // the SAME LumetriPanel component the left panel renders — one color implementation, two
        // entry points, so edits from either surface land on the identical effect stack.
        <LumetriPanel layer={layer} currentTime={currentTime} onChange={onChange} onSeek={onSeek} />
      ) : null}
    </div>
  );
}

/**
 * The project's reusable "Track Library": every saved tracking result (point
 * placement, quality, retrack/fix-marker corrections, Clean & smooth - all done in
 * the TrackWorkspaceModal, which reuses the full Smart 3D Follow Text workspace in
 * trackOnly mode) lives here, independent of any one layer, and can
 * be attached to *any* selected layer (text, shape, image, video) any number of
 * times - this is what makes tracking a true reusable effect instead of a one-shot
 * action a single tool consumes once.
 */
/**
 * Rate-stretch control (Speed inspector section). Preset chips + a percent field; commits go
 * through the composition-level handler so duration re-derives and linked companions follow.
 */
function ClipSpeedControl({
  layer,
  layerTime,
  onChange,
  onChangeSpeed,
  onSeek
}: {
  layer: TimelineLayer;
  /** Playhead in layer-local seconds (for placing ramp points). */
  layerTime: number;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  onChangeSpeed: (layerId: string, speed: number) => void;
  onSeek?: ((seconds: number) => void) | undefined;
}) {
  const speed = getLayerSpeed(layer);
  const ramp = getSpeedRamp(layer);
  const [draft, setDraft] = useState(() => String(Math.round(speed * 100)));
  useEffect(() => {
    setDraft(String(Math.round(speed * 100)));
  }, [speed, layer.id]);
  const commit = (value: number) => {
    // S2: negative = reverse (clip plays backward); only 0 is rejected.
    if (Number.isFinite(value) && value !== 0) onChangeSpeed(layer.id, value);
  };
  const reversed = speed < 0;
  // Ramp points write straight onto layer.speedKeyframes (clip duration is NOT re-derived — a
  // ramp reads more/less source into the same timeline span, Premiere time-remap semantics).
  // R5: the dedupe-by-time + resort write rule lives in the shared upsertSpeedRampPoint/
  // removeSpeedRampPoint helpers so this stays in lockstep with any other surface that edits a ramp.
  const upsertRampPoint = (timeSeconds: number, value: number) => {
    onChange((current) => ({ ...current, speedKeyframes: upsertSpeedRampPoint(current, timeSeconds, value) }));
  };
  const removeRampPoint = (timeSeconds: number) => {
    onChange((current) => ({ ...current, speedKeyframes: removeSpeedRampPoint(current, timeSeconds) }));
  };
  // R5 duration readout: how much source media this clip's speed/ramp consumes over its own span.
  const sourceSecondsConsumed = layerSourceSecondsConsumed(layer);
  return (
    <div className="clip-speed-control">
      <div className="clip-speed-presets">
        {[0.25, 0.5, 1, 1.5, 2, 4].map((preset) => (
          <button
            key={preset}
            type="button"
            className={`button button-ghost${!ramp && Math.abs(speed - preset) < 0.005 ? " is-active" : ""}`}
            onClick={() => commit(preset)}
          >
            {preset * 100}%
          </button>
        ))}
        {/* S2: Reverse toggle — flips the sign, keeps the magnitude (Premiere's "Reverse Speed"). */}
        <button
          type="button"
          className={`button button-ghost${reversed ? " is-active" : ""}`}
          title="Play the clip backward at the same speed"
          onClick={() => commit(-speed)}
        >
          ⇤ Reverse
        </button>
      </div>
      <label className="clip-speed-field">
        Speed
        <ScrubNumberInput
          min={-1600}
          max={1600}
          step={5}
          value={draft}
          onScrubChange={(next) => {
            setDraft(String(next));
            commit(next / 100);
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(Number(draft) / 100)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") commit(Number(draft) / 100);
          }}
        />
        %
      </label>
      <small className="clip-speed-note">Duration follows speed; audio pitch shifts (varispeed).</small>
      <small className="clip-speed-note">
        Plays {Math.abs(sourceSecondsConsumed).toFixed(2)}s of source over {layer.durationSeconds.toFixed(2)}s
        {reversed || sourceSecondsConsumed < 0 ? " (backward)" : ""}.
      </small>
      {reversed || sourceSecondsConsumed < 0 ? (
        <small className="clip-speed-note">Reversed: preview steps frame-by-frame and is silent; export plays true reversed video + audio.</small>
      ) : null}
      <div className="clip-speed-ramp">
        <div className="clip-speed-ramp-head">
          <span>Speed ramp</span>
          {/* Standard keyframe affordance on ramp points (user request 2026-07-12): diamond
              adds/removes a point at the playhead, arrows hop between points. */}
          <KeyframeButtons
            label="Speed ramp"
            active={ramp?.some((point) => Math.abs(point.timeSeconds - layerTime) <= keyframeTimeTolerance) ?? false}
            hasAny={(ramp?.length ?? 0) > 0}
            hasNext={ramp?.some((point) => point.timeSeconds > layerTime + keyframeTimeTolerance) ?? false}
            hasPrevious={ramp?.some((point) => point.timeSeconds < layerTime - keyframeTimeTolerance) ?? false}
            onToggle={() => {
              const existing = ramp?.find((point) => Math.abs(point.timeSeconds - layerTime) <= keyframeTimeTolerance);
              if (existing) removeRampPoint(existing.timeSeconds);
              else upsertRampPoint(Number(layerTime.toFixed(2)), getLayerSpeedAt(layer, layerTime));
            }}
            onNext={() => {
              const next = ramp?.filter((point) => point.timeSeconds > layerTime + keyframeTimeTolerance).sort((a, b) => a.timeSeconds - b.timeSeconds)[0];
              if (next) onSeek?.(layer.startSeconds + next.timeSeconds);
            }}
            onPrevious={() => {
              const previous = ramp?.filter((point) => point.timeSeconds < layerTime - keyframeTimeTolerance).sort((a, b) => b.timeSeconds - a.timeSeconds)[0];
              if (previous) onSeek?.(layer.startSeconds + previous.timeSeconds);
            }}
            onClearAll={() => onChange((current) => ({ ...current, speedKeyframes: undefined }))}
          />
          <button
            type="button"
            className="button button-ghost"
            title="Add a ramp point at the playhead (current rate; edit the % after)"
            onClick={() => upsertRampPoint(Number(layerTime.toFixed(2)), getLayerSpeedAt(layer, layerTime))}
          >
            + Point at playhead
          </button>
        </div>
        {ramp ? (
          <>
            <div className="clip-speed-ramp-points">
              {ramp.map((point) => (
                <span className="clip-speed-ramp-point" key={point.timeSeconds}>
                  {point.timeSeconds.toFixed(2)}s
                  <ScrubNumberInput
                    min={5}
                    max={1600}
                    step={5}
                    defaultValue={Math.round(point.value * 100)}
                    onScrubChange={(next) => upsertRampPoint(point.timeSeconds, next / 100)}
                    onBlur={(event) => {
                      const value = Number(event.target.value) / 100;
                      if (Number.isFinite(value) && value > 0) upsertRampPoint(point.timeSeconds, value);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                    }}
                  />
                  %
                  <button type="button" title="Remove ramp point" onClick={() => removeRampPoint(point.timeSeconds)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <small className="clip-speed-note">
              Rate ramps linearly between points (overrides the constant speed). Clip length stays — the ramp reads
              more or less source into the same span.
            </small>
          </>
        ) : (
          <small className="clip-speed-note">No ramp — the clip plays at the constant speed above.</small>
        )}
      </div>
    </div>
  );
}

function AttachTrackPanel({
  layer,
  tracks,
  onAttach,
  onEditTrack,
  onOpenTrackModal,
  onRemoveTrack
}: {
  layer: TimelineLayer;
  tracks: SavedTrack[];
  onAttach: (trackId: string) => void;
  onEditTrack: (trackId: string) => void;
  onOpenTrackModal: () => void;
  onRemoveTrack: (trackId: string) => void;
}) {
  return (
    <div className="attach-track-panel">
      <p>Track a point on the main clip once, save it, then attach its motion to this (or any other) layer.</p>

      {tracks.length ? (
        <div className="track-library-list">
          {tracks.map((track) => {
            const isAttached = (layer.animations ?? []).some((keyframe) => keyframe.id.startsWith(`${layer.id}_track_${track.id}_`));
            return (
              <div className={`track-library-row${isAttached ? " is-attached" : ""}`} key={track.id}>
                <div className="track-library-row-info">
                  <strong>{track.label}</strong>
                  <small>
                    {track.trackingPath.points.length} pts · {Math.round(averageTrackConfidence(track.trackingPath) * 100)}% confidence
                  </small>
                </div>
                <div className="track-library-row-actions">
                  <Button variant={isAttached ? "secondary" : "primary"} onClick={() => onAttach(track.id)}>
                    {isAttached ? "Re-attach" : `Attach to "${layer.name}"`}
                  </Button>
                  <button title="Edit / retrack" type="button" onClick={() => onEditTrack(track.id)}>
                    <RotateCcw size={14} />
                  </button>
                  <button title="Remove from library" type="button" onClick={() => onRemoveTrack(track.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <Button icon={<Play size={15} />} variant="secondary" onClick={onOpenTrackModal}>
        Track a new point...
      </Button>
    </div>
  );
}

/**
 * Keyframe wiring for text-STYLE numeric rows (font size, tracking, line height, stroke width,
 * background padding/radius, shadow) — evaluated by getCompositionTextStyle's `style.*` tracks in
 * every renderer (2026-07-12). `scale` maps a display unit to the stored unit (padding shows ×100).
 */
interface StyleKeyframeTools {
  value: (property: string, base: number, scale?: number) => number;
  change: (property: string, value: number, scale?: number) => void;
  keyframe: (property: string, currentValue: number, scale?: number) => {
    active: boolean;
    hasAny: boolean;
    hasNext: boolean;
    hasPrevious: boolean;
    interpolation: KeyframeInterpolation | undefined;
    onChangeInterpolation: (interpolation: KeyframeInterpolation) => void;
    onClearAll: () => void;
    onToggle: () => void;
    onNext: () => void;
    onPrevious: () => void;
  };
}

function makeStyleKeyframeTools(
  layer: TimelineLayer,
  currentTime: number,
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void,
  onSeek?: ((seconds: number) => void) | undefined,
  autoKeyframe?: boolean | undefined
): StyleKeyframeTools {
  const layerTime = Math.max(0, Math.min(currentTime - layer.startSeconds, layer.durationSeconds));
  return {
    value: (property, base, scale = 1) => styleValueAt(layer, property, layerTime, base / scale) * scale,
    change: (property, value, scale = 1) =>
      onChange((item) => applyStyleValueAtTime(item, property, layerTime, value / scale, { autoKeyframe })),
    keyframe: (property, currentValue, scale = 1) => {
      const activeKeyframe = getActiveStyleKeyframe(layer, property, layerTime);
      return {
        active: Boolean(activeKeyframe),
        hasAny: getStyleKeyframes(layer, property).length > 0,
        hasNext: Boolean(findStyleKeyframe(layer, property, layerTime, 1)),
        hasPrevious: Boolean(findStyleKeyframe(layer, property, layerTime, -1)),
        interpolation: activeKeyframe?.interpolation,
        onChangeInterpolation: (interpolation: KeyframeInterpolation) =>
          onChange((item) => setStyleKeyframeInterpolation(item, property, layerTime, interpolation)),
        onClearAll: () => onChange((item) => clearStyleKeyframes(item, property)),
        onToggle: () => onChange((item) => toggleStyleKeyframe(item, property, layerTime, currentValue / scale)),
        onNext: () => {
          const next = findStyleKeyframe(layer, property, layerTime, 1);
          if (next) onSeek?.(layer.startSeconds + next.timeSeconds);
        },
        onPrevious: () => {
          const previous = findStyleKeyframe(layer, property, layerTime, -1);
          if (previous) onSeek?.(layer.startSeconds + previous.timeSeconds);
        }
      };
    }
  };
}

/** The source-text keyframe governing `layerTime` (hold semantics: last at/before, else first). */
function governingSourceTextKeyframe(keys: SourceTextKeyframe[], layerTime: number): SourceTextKeyframe | null {
  if (!keys.length) return null;
  const ordered = [...keys].sort((a, b) => a.timeSeconds - b.timeSeconds);
  let active = ordered[0]!;
  for (const key of ordered) {
    if (key.timeSeconds <= layerTime + keyframeTimeTolerance) active = key;
    else break;
  }
  return active;
}

function TextGraphicControls({
  layer,
  palette,
  onChange,
  styleKf,
  currentTime = 0,
  onSeek
}: {
  layer: TimelineLayer;
  palette: string[];
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  styleKf?: StyleKeyframeTools | undefined;
  currentTime?: number | undefined;
  onSeek?: ((seconds: number) => void) | undefined;
}) {
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);
  // SOURCE TEXT keyframes (Premiere-style, hold): the editor shows/edits the runs governing the
  // playhead; the renderers resolve the same entry via getVisibleTextRuns, so what you see while
  // scrubbing is exactly what renders. Keyframing progressively longer text = manual typewriter.
  const sourceKeys = layer.sourceTextKeyframes ?? [];
  const governing = governingSourceTextKeyframe(sourceKeys, layerTime);
  const keyAtPlayhead = sourceKeys.find((key) => Math.abs(key.timeSeconds - layerTime) <= keyframeTimeTolerance) ?? null;
  const displayedRuns = sourceKeys.length ? governing?.runs ?? [{ text: "" }] : getCompositionTextRuns(layer);
  const nextKeyTime = [...sourceKeys].sort((a, b) => a.timeSeconds - b.timeSeconds).find((key) => key.timeSeconds > layerTime + keyframeTimeTolerance)?.timeSeconds;
  const previousKeyTime = [...sourceKeys]
    .sort((a, b) => b.timeSeconds - a.timeSeconds)
    .find((key) => key.timeSeconds < layerTime - keyframeTimeTolerance)?.timeSeconds;

  function commitText(runs: TextRun[] | undefined, plainText: string) {
    onChange((item) => {
      const keys = item.sourceTextKeyframes ?? [];
      if (keys.length) {
        const target = governingSourceTextKeyframe(keys, layerTime);
        if (target) {
          return {
            ...item,
            text: plainText,
            sourceTextKeyframes: keys.map((key) => (key.id === target.id ? { ...key, runs: runs ?? [{ text: plainText }] } : key))
          };
        }
      }
      return { ...item, text: plainText, textRuns: runs };
    });
  }

  return (
    <>
      <InspectorSection icon={<Type size={15} />} title="Text">
        <div className="control-field">
          <span>
            <Type size={14} />
            Content
            {/* Source-text keyframes: diamond captures the CURRENT text at the playhead (hold).
                Keyframe progressively longer text for a hand-authored typewriter/word reveal. */}
            <KeyframeButtons
              label="Source text"
              active={Boolean(keyAtPlayhead)}
              hasAny={sourceKeys.length > 0}
              hasNext={nextKeyTime !== undefined}
              hasPrevious={previousKeyTime !== undefined}
              onToggle={() =>
                onChange((item) => {
                  const keys = item.sourceTextKeyframes ?? [];
                  const existing = keys.find((key) => Math.abs(key.timeSeconds - layerTime) <= keyframeTimeTolerance);
                  if (existing) {
                    const remaining = keys.filter((key) => key.id !== existing.id);
                    return { ...item, sourceTextKeyframes: remaining.length ? remaining : undefined };
                  }
                  const captured: SourceTextKeyframe = {
                    id: `stk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                    timeSeconds: layerTime,
                    runs: displayedRuns.map((run) => ({ ...run }))
                  };
                  return { ...item, sourceTextKeyframes: [...keys, captured].sort((a, b) => a.timeSeconds - b.timeSeconds) };
                })
              }
              onNext={() => {
                if (nextKeyTime !== undefined) onSeek?.(layer.startSeconds + nextKeyTime);
              }}
              onPrevious={() => {
                if (previousKeyTime !== undefined) onSeek?.(layer.startSeconds + previousKeyTime);
              }}
              onClearAll={() => onChange((item) => ({ ...item, sourceTextKeyframes: undefined }))}
            />
          </span>
          {/* Rich text: authors the TextRun[] model all three renderers already consume — select
              a word, style it (bold/italic/color/highlight/size/font), and preview + export follow. */}
          <RichTextEditor
            layerId={layer.id}
            runs={displayedRuns}
            palette={palette}
            onCommit={commitText}
          />
          {sourceKeys.length ? (
            <small className="rich-text-kf-hint">
              Source text is keyframed — you're editing the text at {governing ? `${governing.timeSeconds.toFixed(2)}s` : "the start"}.
            </small>
          ) : null}
        </div>
        <div className="graphic-controls">
          <div className="icon-control-row">
            <FontControl value={layer.fontFamily ?? renderSafeFonts[0].family} onReset={() => onChange((item) => ({ ...item, fontFamily: defaultTextStyle.fontFamily }))} onChange={(value) => onChange((item) => ({ ...item, fontFamily: value }))} />
            <NumberControl icon={<CaseSensitive size={14} />} label="Font size" keyframe={styleKf?.keyframe("style.fontSize", styleKf.value("style.fontSize", layer.fontSize ?? defaultTextStyle.fontSize))} value={styleKf?.value("style.fontSize", layer.fontSize ?? defaultTextStyle.fontSize) ?? layer.fontSize ?? defaultTextStyle.fontSize} min={1} max={1000} step={1} onReset={() => onChange((item) => ({ ...item, fontSize: defaultTextStyle.fontSize }))} onChange={(value) => (styleKf ? styleKf.change("style.fontSize", value) : onChange((item) => ({ ...item, fontSize: value })))} />
          </div>
          <div className="icon-control-row">
            <ToggleControl icon={<Bold size={15} />} label="Bold" active={(layer.fontWeight ?? defaultTextStyle.fontWeight) >= 700} onChange={(active) => onChange((item) => ({ ...item, fontWeight: active ? 900 : 400 }))} />
            <ToggleControl icon={<Italic size={15} />} label="Italic" active={layer.italic ?? false} onChange={(active) => onChange((item) => ({ ...item, italic: active }))} />
            <AlignmentControl value={layer.textAlign ?? "center"} onChange={(value) => onChange((item) => ({ ...item, textAlign: value }))} />
          </div>
          <div className="icon-control-row">
            <NumberControl icon={<MoveHorizontal size={14} />} label="Letter spacing" keyframe={styleKf?.keyframe("style.letterSpacing", styleKf.value("style.letterSpacing", layer.letterSpacing ?? 0))} value={styleKf?.value("style.letterSpacing", layer.letterSpacing ?? 0) ?? layer.letterSpacing ?? 0} min={-50} max={200} step={0.5} onReset={() => onChange((item) => ({ ...item, letterSpacing: defaultTextStyle.letterSpacing }))} onChange={(value) => (styleKf ? styleKf.change("style.letterSpacing", value) : onChange((item) => ({ ...item, letterSpacing: value })))} />
            <NumberControl icon={<MoveVertical size={14} />} label="Line height" keyframe={styleKf?.keyframe("style.lineHeight", styleKf.value("style.lineHeight", layer.lineHeight ?? defaultTextStyle.lineHeight))} value={styleKf?.value("style.lineHeight", layer.lineHeight ?? defaultTextStyle.lineHeight) ?? layer.lineHeight ?? defaultTextStyle.lineHeight} min={0} max={5} step={0.05} onReset={() => onChange((item) => ({ ...item, lineHeight: defaultTextStyle.lineHeight }))} onChange={(value) => (styleKf ? styleKf.change("style.lineHeight", value) : onChange((item) => ({ ...item, lineHeight: value })))} />
            <NumberControl icon={<MoveHorizontal size={14} />} label="Text box width" keyframe={styleKf?.keyframe("style.textWidthPercent", styleKf.value("style.textWidthPercent", layer.textWidthPercent ?? 0))} value={styleKf?.value("style.textWidthPercent", layer.textWidthPercent ?? 0) ?? layer.textWidthPercent ?? 0} min={0} max={100} step={1} onReset={() => onChange((item) => ({ ...item, textWidthPercent: defaultTextStyle.textWidthPercent }))} onChange={(value) => (styleKf ? styleKf.change("style.textWidthPercent", value) : onChange((item) => ({ ...item, textWidthPercent: value })))} />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection icon={<PaintBucket size={15} />} title="Fill & stroke">
        <div className="graphic-controls">
          <div className="icon-control-row">
            <ColorControl icon={<PaintBucket size={14} />} label="Fill color" palette={palette} value={layer.color ?? "#ffffff"} onReset={() => onChange((item) => ({ ...item, color: defaultTextStyle.color }))} onChange={(value) => onChange((item) => ({ ...item, color: value }))} />
            <ColorControl icon={<PenLine size={14} />} label="Stroke color" palette={palette} value={layer.strokeColor ?? "#161618"} onReset={() => onChange((item) => ({ ...item, strokeColor: defaultTextStyle.strokeColor }))} onChange={(value) => onChange((item) => ({ ...item, strokeColor: value }))} />
            <NumberControl icon={<PenLine size={14} />} label="Stroke width" keyframe={styleKf?.keyframe("style.strokeWidth", styleKf.value("style.strokeWidth", layer.strokeWidth ?? 0))} value={styleKf?.value("style.strokeWidth", layer.strokeWidth ?? 0) ?? layer.strokeWidth ?? 0} min={0} max={200} step={1} onReset={() => onChange((item) => ({ ...item, strokeWidth: defaultTextStyle.strokeWidth }))} onChange={(value) => (styleKf ? styleKf.change("style.strokeWidth", value) : onChange((item) => ({ ...item, strokeWidth: value })))} />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection icon={<Square size={15} />} title="Background">
        <BackgroundControls layer={layer} palette={palette} onChange={onChange} styleKf={styleKf} />
      </InspectorSection>

      <InspectorSection icon={<Spline size={15} />} title="Warp">
        <InspectorHost layer={layer} onChange={onChange} panelIds={TEXT_WARP_PANEL_IDS} currentTime={currentTime} onSeek={onSeek} />
      </InspectorSection>

      <InspectorSection icon={<Sparkles size={15} />} title="Shadow">
        <div className="graphic-controls">
          <ShadowControls layer={layer} palette={palette} onChange={onChange} styleKf={styleKf} />
        </div>
      </InspectorSection>
    </>
  );
}

function ShapeGraphicControls({
  layer,
  palette,
  onChange
}: {
  layer: TimelineLayer;
  palette: string[];
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
}) {
  return (
    <>
      <InspectorSection icon={<Square size={15} />} title="Size & shape">
        <div className="graphic-controls">
          <label className="number-row-select">
            <span>Shape</span>
            <ThemedSelect<ShapeKind>
              value={(layer.shapeKind ?? defaultShapeStyle.shapeKind) as ShapeKind}
              options={shapeKindOptions}
              ariaLabel="Shape type"
              menuMinWidth={190}
              onChange={(value) =>
                onChange((item) => ({
                  ...item,
                  shapeKind: value,
                  ...(value === "pen" && !item.shapePath ? { shapePath: defaultShapePathPoints(item.id) } : {})
                }))
              }
            />
          </label>
          <div className="icon-control-row">
            <NumberControl icon={<MoveHorizontal size={14} />} label="Width" value={layer.widthPercent ?? 44} min={2} max={400} step={1} onReset={() => onChange((item) => ({ ...item, widthPercent: defaultShapeStyle.widthPercent }))} onChange={(value) => onChange((item) => ({ ...item, widthPercent: value }))} />
            <NumberControl icon={<MoveVertical size={14} />} label="Height" value={layer.heightPercent ?? 18} min={2} max={400} step={1} onReset={() => onChange((item) => ({ ...item, heightPercent: defaultShapeStyle.heightPercent }))} onChange={(value) => onChange((item) => ({ ...item, heightPercent: value }))} />
            <NumberControl icon={<Radius size={14} />} label="Radius" value={layer.borderRadius ?? 22} min={0} max={500} step={1} onReset={() => onChange((item) => ({ ...item, borderRadius: defaultShapeStyle.borderRadius }))} onChange={(value) => onChange((item) => ({ ...item, borderRadius: value }))} />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection icon={<PaintBucket size={15} />} title="Fill & stroke">
        <div className="graphic-controls">
          <div className="icon-control-row">
            <ColorControl icon={<PaintBucket size={14} />} label="Fill color" palette={palette} value={layer.color ?? "#4D9FFF"} onReset={() => onChange((item) => ({ ...item, color: defaultShapeStyle.color }))} onChange={(value) => onChange((item) => ({ ...item, color: value }))} />
            <ColorControl icon={<PenLine size={14} />} label="Stroke color" palette={palette} value={layer.strokeColor ?? "#ffffff"} onReset={() => onChange((item) => ({ ...item, strokeColor: defaultShapeStyle.strokeColor }))} onChange={(value) => onChange((item) => ({ ...item, strokeColor: value }))} />
            <NumberControl icon={<PenLine size={14} />} label="Stroke width" value={layer.strokeWidth ?? 0} min={0} max={250} step={1} onReset={() => onChange((item) => ({ ...item, strokeWidth: defaultShapeStyle.strokeWidth }))} onChange={(value) => onChange((item) => ({ ...item, strokeWidth: value }))} />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection icon={<Sparkles size={15} />} title="Shadow">
        <div className="graphic-controls">
          <ShadowControls layer={layer} palette={palette} onChange={onChange} />
        </div>
      </InspectorSection>
    </>
  );
}

function ToggleControl({ icon, label, active, onChange }: { icon: ReactNode; label: string; active: boolean; onChange: (active: boolean) => void }) {
  return (
    <button
      type="button"
      className={`inspector-toggle ${active ? "is-active" : ""}`}
      aria-pressed={active}
      title={label}
      onClick={() => onChange(!active)}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function BackgroundControls({
  layer,
  palette,
  onChange,
  styleKf
}: {
  layer: TimelineLayer;
  palette: string[];
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  styleKf?: StyleKeyframeTools | undefined;
}) {
  const background = parseBackgroundColor(layer.backgroundColor, "#08090d");
  // Padding/radius rows display the em value ×100 — the keyframe track stores the raw em.
  const paddingBase = Math.round((layer.backgroundPaddingEm ?? defaultTextStyle.backgroundPaddingEm) * 100);
  const radiusBase = Math.round((layer.backgroundRadiusEm ?? defaultTextStyle.backgroundRadiusEm) * 100);
  return (
    <div className="graphic-controls">
      <div className="icon-control-row">
        <ColorControl
          icon={<Square size={14} />}
          label="Background"
          palette={palette}
          value={background.hex}
          onReset={() => onChange((item) => ({ ...item, backgroundColor: defaultTextStyle.backgroundColor }))}
          onChange={(value) => onChange((item) => ({ ...item, backgroundColor: buildBackgroundColor(value, background.alphaPercent) }))}
        />
        <NumberControl
          icon={<Eye size={14} />}
          label="Opacity"
          value={background.alphaPercent}
          min={0}
          max={100}
          step={1}
          onReset={() => onChange((item) => ({ ...item, backgroundColor: defaultTextStyle.backgroundColor }))}
          onChange={(value) => onChange((item) => ({ ...item, backgroundColor: buildBackgroundColor(background.hex, value) }))}
        />
      </div>
      <div className="icon-control-row">
        <NumberControl
          icon={<Maximize2 size={14} />}
          label="Padding"
          keyframe={styleKf?.keyframe("style.backgroundPaddingEm", styleKf.value("style.backgroundPaddingEm", paddingBase, 100), 100)}
          value={styleKf?.value("style.backgroundPaddingEm", paddingBase, 100) ?? paddingBase}
          min={0}
          max={100}
          step={1}
          onReset={() => onChange((item) => ({ ...item, backgroundPaddingEm: defaultTextStyle.backgroundPaddingEm }))}
          onChange={(value) => (styleKf ? styleKf.change("style.backgroundPaddingEm", value, 100) : onChange((item) => ({ ...item, backgroundPaddingEm: value / 100 })))}
        />
        <NumberControl
          icon={<Radius size={14} />}
          label="Corner radius"
          keyframe={styleKf?.keyframe("style.backgroundRadiusEm", styleKf.value("style.backgroundRadiusEm", radiusBase, 100), 100)}
          value={styleKf?.value("style.backgroundRadiusEm", radiusBase, 100) ?? radiusBase}
          min={0}
          max={200}
          step={1}
          onReset={() => onChange((item) => ({ ...item, backgroundRadiusEm: defaultTextStyle.backgroundRadiusEm }))}
          onChange={(value) => (styleKf ? styleKf.change("style.backgroundRadiusEm", value, 100) : onChange((item) => ({ ...item, backgroundRadiusEm: value / 100 })))}
        />
      </div>
    </div>
  );
}

/** rgb 0..1 -> "#rrggbb", matching the shared `plugin-effect-adapter.ts` storage convention. */
function rgbToHexDisplay(rgb: number[]): string {
  const toHex = (c: number) =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(rgb[0] ?? 0)}${toHex(rgb[1] ?? 0)}${toHex(rgb[2] ?? 0)}`;
}

/**
 * Builds the inspector's per-manifest param list for a `pluginShader` effect from its registered
 * fragment definition — reuses the existing number/color(vec3)/boolean control branches (no new
 * control types). `vec2` params have no matching control yet and are skipped.
 */
function buildPluginShaderParamDefinitions(effect: TimelineEffect): TimelineEffectParamDefinition[] {
  const manifestId = effect.params?.[SHADER_MANIFEST_ID_PARAM_KEY];
  const def = typeof manifestId === "string" ? getFragmentEffect(manifestId) : undefined;
  if (!def) return [];
  const out: TimelineEffectParamDefinition[] = [];
  for (const p of def.params) {
    if (p.type === "bool") {
      out.push({ key: p.name, label: p.label ?? p.name, type: "boolean", defaultValue: Boolean(p.default) });
    } else if (p.type === "vec3") {
      const rgb = Array.isArray(p.default) ? (p.default as number[]) : [0, 0, 0];
      out.push({ key: p.name, label: p.label ?? p.name, type: "color", defaultValue: rgbToHexDisplay(rgb) });
    } else if (p.type === "float") {
      out.push({
        key: p.name,
        label: p.label ?? p.name,
        type: "number",
        min: p.min ?? 0,
        max: p.max ?? 1,
        step: p.step ?? 0.01,
        defaultValue: typeof p.default === "number" ? p.default : 0,
        keyframeable: true
      });
    }
  }
  return out;
}

/**
 * Typewriter as an Effects-subtab card. The preset is not a TimelineEffect — it writes
 * `textRevealProgress` keyframes into `layer.animations` — so the effect list alone would never
 * show it. Speed = "Reveal duration (s)": rescales the reveal keys proportionally so the curve
 * shape survives; the same keys are the "Typewriter reveal" lane in the graph editor.
 */
function TypewriterEffectCard({
  layer,
  onChange
}: {
  layer: TimelineLayer;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
}) {
  const revealKeyframes = getStyleKeyframes(layer, "textRevealProgress");
  if (!revealKeyframes.length) return null;
  const revealDuration = Math.max(...revealKeyframes.map((kf) => kf.timeSeconds));
  return (
    <div className="effect-control-card">
      <div className="effect-control-header">
        <strong>Typewriter</strong>
        <button
          aria-label="Delete effect"
          type="button"
          onClick={() =>
            onChange((item) => {
              const animations = (item.animations ?? []).filter(
                (kf) => !(kf.target.scope === "layer" && kf.target.property === "textRevealProgress")
              );
              return { ...item, animations: animations.length ? animations : undefined };
            })
          }
        >
          <Trash2 size={14} />
        </button>
      </div>
      <NumberControl
        icon={<Sparkles size={14} />}
        label="Reveal duration (s)"
        value={Number(revealDuration.toFixed(2))}
        min={0.1}
        max={Math.max(0.1, layer.durationSeconds)}
        step={0.1}
        onChange={(value) =>
          onChange((item) => {
            const keys = getStyleKeyframes(item, "textRevealProgress");
            const currentEnd = Math.max(0.0001, ...keys.map((kf) => kf.timeSeconds));
            const scale = Math.max(0.1, Math.min(value, item.durationSeconds)) / currentEnd;
            return {
              ...item,
              animations: (item.animations ?? []).map((kf) =>
                kf.target.scope === "layer" && kf.target.property === "textRevealProgress"
                  ? { ...kf, timeSeconds: Math.min(item.durationSeconds, kf.timeSeconds * scale) }
                  : kf
              )
            };
          })
        }
      />
      <p className="rich-text-kf-hint">Curve editable as “Typewriter reveal” in the graph editor (Shift+G).</p>
    </div>
  );
}

function TimelineEffectControl({
  effect,
  layer,
  layerTime,
  palette,
  composition,
  activeMaskId,
  onChangeLayer,
  onUpdate,
  onDelete,
  onSelectEffectMask,
  onChangeMaskTool,
  onSeek,
  trackLibrary
}: {
  effect: TimelineEffect;
  layer: TimelineLayer;
  layerTime: number;
  palette: string[];
  composition?: { width: number; height: number } | undefined;
  activeMaskId?: string | undefined;
  onChangeLayer: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  onUpdate: (update: (target: TimelineEffect) => TimelineEffect) => void;
  onDelete: () => void;
  onSelectEffectMask?: ((effectId: string, maskId: string | null) => void) | undefined;
  onChangeMaskTool?: ((tool: MaskTool) => void) | undefined;
  onSeek?: ((seconds: number) => void) | undefined;
  trackLibrary?: SavedTrack[] | undefined;
}) {
  const normalizedEffect = normalizeTimelineEffect(effect);
  const definition = getTimelineEffectDefinition(normalizedEffect.type);
  // "Custom Shader" (pluginShader) params are dynamic per-manifest — the static registry entry declares
  // params: [], so build the inspector's param list from the fragment def the effect points at.
  const pluginShaderParams: TimelineEffectParamDefinition[] =
    normalizedEffect.type === "pluginShader" ? buildPluginShaderParamDefinitions(normalizedEffect) : [];
  const inspectorParams = normalizedEffect.type === "pluginShader" ? pluginShaderParams : definition?.params ?? [];
  const resetEffect = () => {
    onUpdate((target) => ({ ...createTimelineEffect(normalizedEffect.type), id: target.id }));
  };

  const updateParam = (
    param: TimelineEffectParamDefinition,
    value: string | number | boolean,
    extraParams?: Record<string, string | number | boolean>
  ) => {
    onUpdate((target) => ({
      ...target,
      params: {
        ...(target.params ?? {}),
        [param.key]: value,
        ...(extraParams ?? {})
      }
    }));
  };

  return (
    <div className={`effect-control-card ${normalizedEffect.enabled ? "" : "is-disabled"}`}>
      <div className="effect-control-header">
        <button
          aria-label={normalizedEffect.enabled ? "Disable effect" : "Enable effect"}
          className={normalizedEffect.enabled ? "is-active" : ""}
          type="button"
          onClick={() => {
            const nextEnabled = !normalizedEffect.enabled;
            onUpdate((target) => ({ ...target, enabled: nextEnabled }));
          }}
        >
          <Eye size={14} />
        </button>
        <strong>{normalizedEffect.name}</strong>
        <button aria-label="Reset effect" type="button" onClick={resetEffect}>
          <RotateCcw size={14} />
        </button>
        <button aria-label="Delete effect" type="button" onClick={onDelete}>
          <Trash2 size={14} />
        </button>
      </div>
      <EffectSliderControl
        label="Mix"
        max={100}
        min={0}
        step={1}
        value={normalizedEffect.intensity}
        onReset={() => resetEffect()}
        onChange={(value) => onUpdate((target) => ({ ...target, intensity: value }))}
      />
      {normalizedEffect.params && Object.keys(normalizedEffect.params).length ? (
        <div className="effect-param-grid">
          {inspectorParams.map((param) => (
            <EffectParamControl
              effect={normalizedEffect}
              key={param.key}
              layer={layer}
              layerTime={layerTime}
              palette={palette}
              param={param}
              onChangeLayer={onChangeLayer}
              onChange={(value, extraParams) => updateParam(param, value, extraParams)}
              onSeek={onSeek}
            />
          ))}
        </div>
      ) : null}
      {(layer.type === "video" || layer.type === "image" || layer.type === "text" || layer.type === "shape") &&
      (normalizedEffect.type === "blur" || COLOR_EFFECT_TYPES.has(normalizedEffect.type)) &&
      composition &&
      onSelectEffectMask &&
      onChangeMaskTool ? (
        <EffectMaskControls
          effect={normalizedEffect}
          layer={layer}
          composition={composition}
          activeMaskId={activeMaskId}
          layerTime={layerTime}
          trackLibrary={trackLibrary}
          onChangeMasks={(updater) => onUpdate((target) => ({ ...target, masks: updater(target.masks ?? []) }))}
          onChangeLayer={onChangeLayer}
          onEditInPreview={(maskId) => onSelectEffectMask(normalizedEffect.id, maskId)}
          onChangeMaskTool={onChangeMaskTool}
          onSeek={onSeek}
        />
      ) : null}
    </div>
  );
}

function EffectParamControl({
  effect,
  layer,
  layerTime,
  param,
  palette,
  onChangeLayer,
  onChange,
  onSeek
}: {
  effect: TimelineEffect;
  layer: TimelineLayer;
  layerTime: number;
  param: TimelineEffectParamDefinition;
  palette: string[];
  onChangeLayer: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  onChange: (value: string | number | boolean, extraParams?: Record<string, string | number | boolean>) => void;
  onSeek?: ((seconds: number) => void) | undefined;
}) {
  const value = effect.params?.[param.key] ?? param.defaultValue;
  const autoKeyframe = useAutoKeyframe();

  // BROADCAST SAFETY: `onChangeLayer` may fan the updater out to every selected clip. Other clips
  // can carry a DIFFERENT effect instance id and sit at a different timeline position, so the
  // effect id, local time, and evaluated value must all be resolved per `item` INSIDE the updater.
  // Capturing this component's `effect.id`/`layerTime`/`animatedValue` wrote the primary's value
  // under the primary's effect id onto every clip — wrong values and orphaned keyframes
  // (2026-07-16 report).
  const absoluteTimeSeconds = layer.startSeconds + layerTime;
  const resolveItemEffect = (item: TimelineLayer): { effectId: string; timeSeconds: number } | null => {
    const itemEffect = item.effects.find((candidate) => candidate.id === effect.id) ?? item.effects.find((candidate) => candidate.type === effect.type);
    if (!itemEffect) return null;
    return { effectId: itemEffect.id, timeSeconds: clamp(absoluteTimeSeconds - item.startSeconds, 0, item.durationSeconds) };
  };

  if (param.type === "number") {
    const baseValue = typeof value === "number" ? value : Number(param.defaultValue);
    const animatedValue = evaluateTimelineEffectParam({
      animations: layer.animations,
      baseValue,
      effectId: effect.id,
      paramKey: param.key,
      timeSeconds: layerTime
    });
    const activeKeyframe = getActiveEffectParamKeyframe(layer, effect.id, param.key, layerTime);
    const nextKeyframe = param.keyframeable ? findEffectParamKeyframe(layer, effect.id, param.key, layerTime, 1) : undefined;
    const previousKeyframe = param.keyframeable ? findEffectParamKeyframe(layer, effect.id, param.key, layerTime, -1) : undefined;
    return (
      <EffectSliderControl
        keyframe={
          param.keyframeable
            ? {
                active: Boolean(activeKeyframe),
                hasAny: getEffectParamKeyframes(layer, effect.id, param.key).length > 0,
                hasNext: Boolean(nextKeyframe),
                hasPrevious: Boolean(previousKeyframe),
                interpolation: activeKeyframe?.interpolation,
                onChangeInterpolation: (interpolation) =>
                  onChangeLayer((item) => {
                    const resolved = resolveItemEffect(item);
                    return resolved ? setEffectParamInterpolation(item, resolved.effectId, param.key, resolved.timeSeconds, interpolation) : item;
                  }),
                onClearAll: () =>
                  onChangeLayer((item) => {
                    const resolved = resolveItemEffect(item);
                    return resolved ? clearEffectParamKeyframes(item, resolved.effectId, param.key) : item;
                  }),
                onNext: () => {
                  if (nextKeyframe) onSeek?.(layer.startSeconds + nextKeyframe.timeSeconds);
                },
                onPrevious: () => {
                  if (previousKeyframe) onSeek?.(layer.startSeconds + previousKeyframe.timeSeconds);
                },
                onToggle: () =>
                  onChangeLayer((item) => {
                    const resolved = resolveItemEffect(item);
                    if (!resolved) return item;
                    const itemEffect = item.effects.find((candidate) => candidate.id === resolved.effectId);
                    const itemRaw = itemEffect?.params?.[param.key];
                    const itemBase = typeof itemRaw === "number" ? itemRaw : Number(param.defaultValue);
                    const itemValue = evaluateTimelineEffectParam({
                      animations: item.animations,
                      baseValue: itemBase,
                      effectId: resolved.effectId,
                      paramKey: param.key,
                      timeSeconds: resolved.timeSeconds
                    });
                    return toggleEffectParamKeyframe(item, resolved.effectId, param.key, resolved.timeSeconds, itemValue);
                  })
              }
            : undefined
        }
        label={param.unit ? `${param.label} ${param.unit}` : param.label}
        max={param.max}
        min={param.min}
        tone={effectSliderTone(param.key)}
        step={param.step}
        value={animatedValue}
        onReset={() =>
          onChangeLayer((item) => {
            const resolved = resolveItemEffect(item);
            return resolved ? updateEffectParamAtTime(item, resolved.effectId, param.key, resolved.timeSeconds, param.defaultValue) : item;
          })
        }
        onChange={(nextValue) =>
          onChangeLayer((item) => {
            const resolved = resolveItemEffect(item);
            return resolved ? applyEffectParamValueAtTime(item, resolved.effectId, param.key, resolved.timeSeconds, nextValue, { autoKeyframe }) : item;
          })
        }
      />
    );
  }

  if (param.type === "color") {
    return (
      <ColorControl
        icon={<PaintBucket size={14} />}
        label={param.label}
        palette={palette}
        value={typeof value === "string" ? value : param.defaultValue}
        onReset={() => onChange(param.defaultValue)}
        onChange={onChange}
      />
    );
  }

  if (param.type === "boolean") {
    return (
      <label className="effect-toggle-control" title={param.label}>
        <span>{param.label}</span>
        <input checked={Boolean(value)} type="checkbox" onChange={(event) => onChange(event.target.checked)} />
      </label>
    );
  }

  if (param.type === "curve") {
    return (
      <div className="effect-curve-control">
        <CurveEditor value={typeof value === "string" ? value : param.defaultValue} onChange={onChange} />
      </div>
    );
  }

  if (param.type === "wheels") {
    return (
      <div className="effect-curve-control">
        <ColorWheels value={typeof value === "string" ? value : param.defaultValue} onChange={onChange} />
      </div>
    );
  }

  if (param.type === "hueCurves") {
    return (
      <div className="effect-curve-control">
        <HueSatCurves value={typeof value === "string" ? value : param.defaultValue} onChange={onChange} />
      </div>
    );
  }

  if (param.type === "secondary") {
    return (
      <div className="effect-curve-control">
        <HslSecondary value={typeof value === "string" ? value : param.defaultValue} onChange={onChange} />
      </div>
    );
  }

  if (param.type === "look") {
    return (
      <label className="effect-select-control" title={param.label}>
        <span>{param.label}</span>
        <ThemedSelect
          ariaLabel={param.label}
          value={typeof value === "string" ? value : param.defaultValue}
          options={param.options.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(next) => onChange(next)}
        />
      </label>
    );
  }

  if (param.type === "lut") {
    const lutLabel =
      typeof effect.params?.lutName === "string" && effect.params.lutName.trim()
        ? effect.params.lutName
        : effect.name !== "LUT"
          ? effect.name
          : undefined;
    return (
      <div className="effect-lut-control">
        <LutFileImport
          label={lutLabel}
          value={typeof value === "string" ? value : param.defaultValue}
          onChange={(next, name) => onChange(next, name !== undefined ? { lutName: name } : undefined)}
        />
      </div>
    );
  }

  return (
    <label className="effect-select-control" title={param.label}>
      <span>{param.label}</span>
      <ThemedSelect
        ariaLabel={param.label}
        value={typeof value === "string" ? value : param.defaultValue}
        options={param.options.map((option) => ({ value: option.value, label: option.label }))}
        onChange={(next) => onChange(next)}
      />
    </label>
  );
}

function AlignmentControl({
  value,
  onChange
}: {
  value: NonNullable<TimelineLayer["textAlign"]>;
  onChange: (value: NonNullable<TimelineLayer["textAlign"]>) => void;
}) {
  return (
    <div className="alignment-control" aria-label="Text alignment">
      {[
        { value: "left", icon: <AlignLeft size={15} />, label: "Align left" },
        { value: "center", icon: <AlignCenter size={15} />, label: "Align center" },
        { value: "right", icon: <AlignRight size={15} />, label: "Align right" }
      ].map((item) => (
        <button
          aria-label={item.label}
          className={value === item.value ? "is-active" : ""}
          key={item.value}
          title={item.label}
          type="button"
          onClick={() => onChange(item.value as NonNullable<TimelineLayer["textAlign"]>)}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}

function ShadowControls({
  layer,
  palette,
  onChange,
  styleKf
}: {
  layer: TimelineLayer;
  palette: string[];
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  styleKf?: StyleKeyframeTools | undefined;
}) {
  const defaults = layer.type === "shape" ? defaultShapeStyle : defaultTextStyle;
  return (
    <div className="icon-control-row">
      <ColorControl icon={<Sparkles size={14} />} label="Shadow color" palette={palette} value={layer.shadowColor ?? "#000000"} onReset={() => onChange((item) => ({ ...item, shadowColor: defaults.shadowColor }))} onChange={(value) => onChange((item) => ({ ...item, shadowColor: value }))} />
      <NumberControl icon={<Sparkles size={14} />} label="Shadow blur" keyframe={styleKf?.keyframe("style.shadowBlur", styleKf.value("style.shadowBlur", layer.shadowBlur ?? 0))} value={styleKf?.value("style.shadowBlur", layer.shadowBlur ?? 0) ?? layer.shadowBlur ?? 0} min={0} max={500} step={1} onReset={() => onChange((item) => setShadowEnabled({ ...item, shadowBlur: defaults.shadowBlur }, defaults.shadowBlur > 0))} onChange={(value) => {
        if (styleKf) {
          styleKf.change("style.shadowBlur", value);
          if (value > 0) onChange((item) => setShadowEnabled(item, true));
        } else {
          onChange((item) => setShadowEnabled({ ...item, shadowBlur: value }, value > 0));
        }
      }} />
      <NumberControl icon={<MoveHorizontal size={14} />} label="Shadow X" keyframe={styleKf?.keyframe("style.shadowOffsetX", styleKf.value("style.shadowOffsetX", layer.shadowOffsetX ?? 0))} value={styleKf?.value("style.shadowOffsetX", layer.shadowOffsetX ?? 0) ?? layer.shadowOffsetX ?? 0} min={-500} max={500} step={1} onReset={() => onChange((item) => ({ ...item, shadowOffsetX: defaults.shadowOffsetX }))} onChange={(value) => (styleKf ? styleKf.change("style.shadowOffsetX", value) : onChange((item) => ({ ...item, shadowOffsetX: value })))} />
      <NumberControl icon={<MoveVertical size={14} />} label="Shadow Y" keyframe={styleKf?.keyframe("style.shadowOffsetY", styleKf.value("style.shadowOffsetY", layer.shadowOffsetY ?? 0))} value={styleKf?.value("style.shadowOffsetY", layer.shadowOffsetY ?? 0) ?? layer.shadowOffsetY ?? 0} min={-500} max={500} step={1} onReset={() => onChange((item) => ({ ...item, shadowOffsetY: defaults.shadowOffsetY }))} onChange={(value) => (styleKf ? styleKf.change("style.shadowOffsetY", value) : onChange((item) => ({ ...item, shadowOffsetY: value })))} />
    </div>
  );
}

function setShadowEnabled(layer: TimelineLayer, enabled: boolean): TimelineLayer {
  const existing = layer.effects.find((effect) => effect.type === "shadow");
  if (existing) {
    return {
      ...layer,
      effects: layer.effects.map((effect) => (effect.id === existing.id ? { ...effect, enabled, intensity: enabled ? Math.max(effect.intensity, 40) : effect.intensity } : effect))
    };
  }

  if (!enabled) {
    return layer;
  }

  return {
    ...layer,
    effects: [
      ...layer.effects,
      {
        id: `${layer.id}_shadow`,
        type: "shadow",
        name: "Shadow",
        enabled: true,
        intensity: 45
      }
    ]
  };
}

function resetLayerControls(layer: TimelineLayer): TimelineLayer {
  const base = {
    ...layer,
    transform: {
      ...layer.transform,
      position: { x: 50, y: defaultPositionY(layer.type) },
      scale: 1,
      rotation: 0,
      opacity: defaultOpacity(layer.type)
    },
    keyframes: [],
    animations: []
  };

  if (layer.type === "text") {
    return setShadowEnabled({ ...base, ...defaultTextStyle }, defaultTextStyle.shadowBlur > 0);
  }

  if (layer.type === "shape") {
    return setShadowEnabled({ ...base, ...defaultShapeStyle }, defaultShapeStyle.shadowBlur > 0);
  }

  return base;
}

function defaultPositionY(type: TimelineLayer["type"]) {
  return type === "text" ? 62 : 50;
}

function defaultOpacity(type: TimelineLayer["type"]) {
  return type === "shape" ? 82 : 100;
}

function FontControl({ value, onReset, onChange }: { value: string; onReset?: (() => void) | undefined; onChange: (value: string) => void }) {
  return (
    <label className="font-control" title="Font family">
      <span aria-hidden="true">
        <span className="control-icon">
          <Type size={14} />
        </span>
        {onReset ? <ResetButton onReset={onReset} /> : null}
      </span>
      <ThemedSelect
        ariaLabel="Font family"
        value={value}
        options={renderSafeFonts.map((font) => ({ value: font.family, label: font.label }))}
        onChange={(next) => onChange(next)}
      />
    </label>
  );
}

const EDITOR_THEME_IDS = ["blue", "warm", "grey", "red", "green", "orange", "neon"] as const;
type EditorThemeId = (typeof EDITOR_THEME_IDS)[number];
const EDITOR_THEMES: Array<{ id: EditorThemeId; label: string; swatch: string }> = [
  { id: "blue", label: "Ocean Blue", swatch: "#4f9cff" },
  { id: "warm", label: "Warm Amber", swatch: "#e0a458" },
  { id: "grey", label: "Neutral Graphite", swatch: "#9aa4b2" },
  { id: "red", label: "Ember Red", swatch: "#e06672" },
  { id: "green", label: "Bamboo Green", swatch: "#6fbf8b" },
  { id: "orange", label: "Sunset Orange", swatch: "#e0893c" },
  { id: "neon", label: "Neon Green", swatch: "#4cf07a" }
];

function readStoredNumber(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readStoredChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const value = localStorage.getItem(key);
  return value && allowed.some((item) => item === value) ? (value as T) : fallback;
}

function previewQualityLabel(quality: "performance" | "balanced" | "quality") {
  // Premiere-style playback RESOLUTION (downscales the render surface while playing, Full when paused).
  if (quality === "performance") return "Quarter";
  if (quality === "balanced") return "Half";
  return "Full";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function snap(value: number, step: number) {
  return Math.round(value / step) * step;
}

function roundEditorNumber(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeRotation(value: number) {
  const normalized = ((value + 180) % 360) - 180;
  return normalized < -180 ? normalized + 360 : normalized;
}
