import { Fragment, lazy, memo, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Download,
  Eye,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Cloud,
  CloudUpload,
  Diamond,
  Droplet,
  FileCode,
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
  Radius,
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
  buildLumioPackageZipAsync,
  buildTimelineTemplatePackage,
  buildTemplateGraphFromProject,
  exportCompositionToFcpxml,
  isLumioPackageZipBytes,
  parseLumioPackageZipAsync,
  buildTransitionKeyframes,
  COLOR_EFFECT_TYPES,
  getTransition,
  TRANSITION_MARKER,
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
  rippleDeleteLayer,
  rippleTrimLayer,
  rollEditAtCut,
  slideLayer,
  trimLayerEdgeTo,
  trimLayerKeyframesTo,
  collectEditPoints,
  copyLayerAttributes,
  hasClipboardAttributes,
  pasteLayerAttributes,
  duplicateLayer,
  copyLayerToClipboard,
  getLayerSpeed,
  getLayerSpeedAt,
  getSpeedRamp,
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
  createDefaultMask,
  type AssetSource,
  type ImportedExternalTimeline,
  type Mask,
  type ProjectGraph,
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
} from "@lumio-by-aelivion/shared";
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
import { ThemedSelect, type ThemedSelectGroup } from "../editor/inspector/controls/ThemedSelect";
import { InspectorHost } from "../editor/inspector/InspectorHost";
import { AutoKeyframeContext } from "../editor/inspector/autoKeyframeContext";
import type { MaskTool } from "../editor/registry/inspector";
import { recordMaskPoints } from "../editor/inspector/maskKeyframeUtils";
import { EffectMaskControls } from "../editor/inspector/EffectMaskControls";
import { InspectorSection } from "../editor/inspector/InspectorSection";
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
  applyTransformValueAtTime,
  clearEffectParamKeyframes,
  findEffectParamKeyframeTime,
  getActiveEffectParamKeyframe,
  getEffectParamKeyframes,
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
  linkAssetToProject,
  listAssets,
  listMyTemplates,
  listPluginPackages,
  searchStock,
  STOCK_PAGE_SIZE,
  updateAssetFolder,
  updateAssetTags,
  AuthRequiredError,
  type ProjectRecord
} from "../lib/api";
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
  instantiateTemplateComposition,
  normalizeGraphicSvg,
  DEFAULT_GRAPHIC_FILL,
  type BundledGraphic,
  type LayerGraphic,
  type TemplateDefinition
} from "@lumio-by-aelivion/shared";
import { getVideoPoster, useVideoPoster } from "../lib/videoThumbnails";
import { ASSET_LABEL_COLORS, assetLabelOf, defaultAssetLabelOf, tagsWithAssetLabel } from "../lib/assetLabels";
import { assetHasAudioStream } from "../lib/assetAudio";
import { getAssetBlobStore } from "../lib/asset-blob-store";
import { useRenderCost } from "../lib/perfDiagnostics";
import { useStableHandler, useStableHandlers } from "../lib/useStableHandler";
import { NoticeToast, getNotice, setNotice } from "../lib/noticeStore";
import {
  checkNow,
  ensureExportReady,
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
import { detectSourceColorFromFile } from "../export/source-color";
import { Modal } from "../components/Modal";
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
      window.localStorage?.getItem("lumio_debug_gl") === "1" ||
      window.localStorage?.getItem("lumio_debug_proxy") === "1"
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
      .replace(/^-+|-+$/g, "") || "lumio-template"
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
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  // Fully collapse the Inspector to a slim rail — reclaims its width (handy when the AI
  // dock is open and the viewer gets cramped).
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
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
  // Remember the last single-selected layer so the Controls tab keeps showing
  // its controls after the user deselects (better UX than collapsing to empty).
  const [lastInspectedLayerId, setLastInspectedLayerId] = useState<string | null>(null);
  // When set, the asset bin is in "pick a replacement" mode for this layer; tile
  // clicks swap the clip's asset instead of adding a new layer.
  const [assetPickerForLayerId, setAssetPickerForLayerId] = useState<string | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
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
  const [generateStudioOpen, setGenerateStudioOpen] = useState(false);
  const [generateStudioPrefill, setGenerateStudioPrefill] = useState<GenerateStudioPrefill | undefined>(undefined);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackStart, setPlaybackStart] = useState<{ clockMs: number; timeSeconds: number } | null>(null);
  // Transport "A" (Auto) toggle: ON = adaptive quality may drop playback res below the chosen
  // profile under load; OFF = the manual ¼/½/1 choice is absolute (strong-GPU users).
  const [adaptiveResOn, setAdaptiveResOn] = useState(() => isAdaptiveQualityOn());
  const [previewQuality, setPreviewQuality] = useState<"performance" | "balanced" | "quality">(() =>
    readStoredChoice("lumio_preview_quality", "balanced", ["performance", "balanced", "quality"] as const)
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
  const [livePlaybackMode, setLivePlaybackMode] = useState(
    () => readStoredChoice("lumio_live_playback", "off", ["on", "off"] as const) === "on"
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
  const [leftPaneWidth, setLeftPaneWidth] = useState(() => readStoredNumber("lumio_editor_left_width", EDITOR_RESPONSIVE_LAYOUT.panes.left.preferred));
  const [rightPaneWidth, setRightPaneWidth] = useState(() => readStoredNumber("lumio_editor_right_width", EDITOR_RESPONSIVE_LAYOUT.panes.right.preferred));
  const [timelineHeight, setTimelineHeight] = useState(() => readStoredNumber("lumio_editor_timeline_height", EDITOR_RESPONSIVE_LAYOUT.panes.timeline.preferred));
  const [timelineTrackHeight, setTimelineTrackHeight] = useState(() => readStoredNumber("lumio_editor_track_height", 44));
  // Fraction (0-1) of .viewer-monitors width given to the source monitor in dual-monitor mode.
  const [sourceMonitorSplit, setSourceMonitorSplit] = useState(() => readStoredNumber("lumio_editor_source_split", 0.5));
  const responsiveLayout = useEditorResponsiveLayout(editorPageRef, { leftPaneWidth, rightPaneWidth, timelineHeight });
  const [activeResponsiveOverlay, setActiveResponsiveOverlay] = useState<EditorOverlayPanel>(null);
  const [expandedResponsiveOverlays, setExpandedResponsiveOverlays] = useState<Set<NonNullable<EditorOverlayPanel>>>(() => new Set());
  const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
  const [editorTheme, setEditorTheme] = useState<EditorThemeId>(() =>
    readStoredChoice("lumio_editor_theme", "blue", EDITOR_THEME_IDS)
  );
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [timelineTool, setTimelineTool] = useState<TimelineToolMode>("select");
  const [snapEnabled, setSnapEnabled] = useState(() => readStoredChoice("lumio_timeline_snap", "on", ["on", "off"] as const) === "on");
  // Viewer scaling (Premiere-style): "fit" auto-scales the comp to the viewer (re-fits on panel resize);
  // "manual" uses `manualScale` (1:1 — 1.0 = 100% actual pixels). `fitScale` is reported up from the
  // preview (measured from the stable viewer box, no feedback) purely so the toolbar can show the % in
  // fit mode. Single scale end-to-end — no width/height fit modes, no zoom² coupling.
  const [viewMode, setViewMode] = useState<"fit" | "manual">(() =>
    readStoredChoice("lumio_viewer_view_mode", "fit", ["fit", "manual"] as const)
  );
  const [manualScale, setManualScale] = useState(() => readStoredNumber("lumio_viewer_manual_scale", 1));
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
    localStorage.setItem("lumio_viewer_view_mode", viewMode);
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
        const loaded = await getProject(resolvedId);
        if (cancelled) return;
        setProject(loaded);
        if (!loaded.id.startsWith("project_local_")) {
          markServerProjectSynced(loaded.id);
        }
        void offerCrashRecovery(loaded);
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
    void loadProject(0);
    // Strip any persisted session-scoped proxy object URL (defensive — proxyUrl should never be
    // saved, but a stale `blob:` here would black out every clip using that asset).
    listAssets().then((list) =>
      setAssets(list.map((asset) => (asset.proxyUrl?.startsWith("blob:") ? { ...asset, proxyUrl: undefined } : asset)))
    );
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
  const stableOpenSourceMonitor = useStableHandler(handleOpenInSourceMonitor);
  const layerMaxDurations = useMemo(
    () => (composition ? buildLayerMaxDurations(composition, resolvedAssets) : {}),
    [composition, resolvedAssets]
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
  // The layer whose controls the Controls tab shows: the current single selection,
  // or — when nothing is selected — the last one inspected (kept alive so controls
  // stay put after deselecting). Falls back to empty if that layer is gone.
  const inspectorLayer =
    selectedLayer ?? (selectedLayerIds.length === 0 ? layers.find((layer) => layer.id === lastInspectedLayerId) : undefined);
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
    localStorage.setItem("lumio_preview_quality", previewQuality);
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
    localStorage.setItem("lumio_live_playback", livePlaybackMode ? "on" : "off");
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
        void updateComposition(pasteLayerAttributes(composition, editable)).then(() => {
          setNotice(`Attributes pasted onto ${editable.length} clip${editable.length === 1 ? "" : "s"}`);
        });
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
          const mask = createDefaultMask("rectangle", composition.width, composition.height, (layer.masks?.length ?? 0) + 1);
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

  useEffect(() => {
    localStorage.setItem("lumio_editor_left_width", String(leftPaneWidth));
  }, [leftPaneWidth]);

  useEffect(() => {
    localStorage.setItem("lumio_editor_right_width", String(rightPaneWidth));
  }, [rightPaneWidth]);

  useEffect(() => {
    localStorage.setItem("lumio_editor_timeline_height", String(timelineHeight));
  }, [timelineHeight]);

  useEffect(() => {
    localStorage.setItem("lumio_editor_source_split", String(sourceMonitorSplit));
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
    localStorage.setItem("lumio_editor_theme", editorTheme);
  }, [editorTheme]);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".topbar-theme-picker")) return;
      setThemeMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThemeMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [themeMenuOpen]);

  useEffect(() => {
    localStorage.setItem("lumio_timeline_snap", snapEnabled ? "on" : "off");
  }, [snapEnabled]);

  useEffect(() => {
    localStorage.setItem("lumio_editor_track_height", String(timelineTrackHeight));
  }, [timelineTrackHeight]);

  useEffect(() => {
    if (selectedLayerId) {
      setLastInspectedLayerId(selectedLayerId);
    }
  }, [selectedLayerId]);

  useEffect(() => {
    localStorage.setItem("lumio_viewer_manual_scale", String(manualScale));
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

    // Local-first: update in-memory + on-device immediately, then sync to the server in
    // the background (debounced). The SyncBadge surfaces Saved locally → Syncing → Synced.
    // Functional update so a stale closure can't overwrite a newer edit committed in between.
    setProject((current) => (current ? { ...current, projectGraph: nextGraph, durationSeconds: nextDuration } : current));
    scheduleGraphSave(project.id, nextGraph, nextDuration);
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

    const normalizedComposition = normalizeCompositionDuration(nextComposition);
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

  function updateCompositionSettings(updater: (settings: TimelineCompositionSettings) => TimelineCompositionSettings) {
    if (!composition) {
      return;
    }

    const settings = updater(getCompositionSettings(composition));
    const nextComposition = applyCompositionSettings(composition, settings);
    void updateComposition(nextComposition);
  }

  async function updateLayer(layerId: string, updater: (layer: TimelineLayer) => TimelineLayer) {
    if (!composition) {
      return;
    }

    await updateComposition(updateTimelineLayer(composition, layerId, updater));
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
    const updater = (layer: TimelineLayer): TimelineLayer => ({
      ...layer,
      transform: {
        ...layer.transform,
        position: {
          x: roundEditorNumber(position.x),
          y: roundEditorNumber(position.y)
        }
      }
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
      widthPercent: roundEditorNumber(clamp(size.widthPercent, 2, 200)),
      heightPercent: roundEditorNumber(clamp(size.heightPercent, 2, 200))
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
    targetTrackByLayerId?: Record<string, string> | undefined
  ) {
    if (!composition) {
      return;
    }

    const layer = layers.find((item) => item.id === layerId);
    if (layer && movedLayerIds?.length && movedLayerIds.length > 1) {
      const movedSet = new Set(movedLayerIds);
      const deltaSeconds = startSeconds - layer.startSeconds;
      const trackById = new Map(composition.tracks.map((item) => [item.id, item]));
      const movedUpdates = new Map<string, TimelineLayer>();
      for (const item of layers) {
        if (!movedSet.has(item.id) || item.locked) {
          continue;
        }

        const sourceTrack = trackById.get(item.trackId);
        if (sourceTrack?.locked) {
          continue;
        }

        const targetTrackId = targetTrackByLayerId?.[item.id] ?? item.trackId;
        const targetTrack = trackById.get(targetTrackId);
        const targetMatchesLayerKind = targetTrack ? (targetTrack.type === "audio") === (item.type === "audio") : false;
        const nextTrackId = targetTrack && !targetTrack.locked && targetMatchesLayerKind ? targetTrack.id : item.trackId;
        movedUpdates.set(item.id, {
          ...item,
          startSeconds: Math.max(0, item.startSeconds + deltaSeconds),
          trackId: nextTrackId
        });
      }

      await updateComposition({
        ...composition,
        tracks: composition.tracks.map((track) => {
          const existing = track.layers.flatMap((item) => {
            const moved = movedUpdates.get(item.id);
            if (!moved) {
              return [item];
            }
            return moved.trackId === track.id ? [moved] : [];
          });
          const incoming = Array.from(movedUpdates.values()).filter(
            (item) => item.trackId === track.id && !track.layers.some((layerItem) => layerItem.id === item.id)
          );
          return {
            ...track,
            layers: [...existing, ...incoming]
          };
        })
      });
      return;
    }

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

  async function handleResizeLayer(layerId: string, startSeconds: number, durationSeconds: number) {
    if (!composition) {
      return;
    }

    // Minimum clip length is a single frame — applies to every layer type.
    const minDur = 1 / Math.max(1, Math.round(composition.fps) || 30);

    await updateLayer(layerId, (layer) => {
      const mediaDuration = getLayerMaxDuration(layer, resolvedAssets, composition.durationSeconds);
      const isSourceBound = (layer.type === "video" || layer.type === "audio") && Boolean(layer.assetId);

      if (!isSourceBound) {
        // Non-source media (text/shape/image): no source in-point to track.
        const oldEnd = layer.startSeconds + layer.durationSeconds;
        const nextStart = startSeconds < layer.startSeconds && durationSeconds > mediaDuration ? Math.max(0, oldEnd - mediaDuration) : startSeconds;
        const nextDur = clamp(durationSeconds, minDur, mediaDuration);
        return { ...layer, startSeconds: nextStart, durationSeconds: nextDur, ...trimLayerKeyframesTo(layer, nextStart, nextDur) };
      }

      // Source-aware trim. Moving the start edge reveals/hides source: the
      // in-point shifts by the same delta the start moved. Trimming the end
      // edge leaves the start (and in-point) untouched.
      const oldSourceIn = layer.sourceInSeconds ?? 0;
      const startDelta = startSeconds - layer.startSeconds;
      let nextStart = startSeconds;
      let nextDuration = durationSeconds;
      let nextSourceIn = oldSourceIn + startDelta;

      if (nextSourceIn < 0) {
        // Can't reveal source before frame 0 — cap how far the start can move left.
        nextStart = layer.startSeconds - oldSourceIn;
        nextDuration = layer.durationSeconds + oldSourceIn;
        nextSourceIn = 0;
      }

      const maxDurationFromIn = Math.max(minDur, mediaDuration - nextSourceIn);
      nextDuration = clamp(nextDuration, minDur, maxDurationFromIn);

      const finalStart = Math.max(0, nextStart);
      return {
        ...layer,
        startSeconds: finalStart,
        durationSeconds: nextDuration,
        sourceInSeconds: nextSourceIn,
        // Shared trim conventions (timeline-ops): head trims rebase/drop animation data with the
        // content, tail trims drop keyframes past the new end. The drag path previously skipped
        // this, leaving keyframes floating beyond the trimmed clip (user report 2026-07-03).
        ...trimLayerKeyframesTo(layer, finalStart, nextDuration)
      };
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
    // Split every selected clip the playhead actually passes through.
    const time = currentTimeRef.current;
    const splittable = flattenTimelineLayers(composition).filter(
      (layer) =>
        selectedLayerIds.includes(layer.id) &&
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
    const maxDuration = getLayerMaxDuration(layer, resolvedAssets, composition.durationSeconds);
    const clamped = clamp(Number(sourceInSeconds.toFixed(3)), 0, Math.max(0, (maxDuration - layer.durationSeconds) * speed));
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
    const newSpeed = clamp(Number(requestedSpeed.toFixed(3)), 0.05, 16);
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
    const sourceSpan = layer.durationSeconds * oldSpeed;
    let newDuration = Math.max(frameSeconds, sourceSpan / newSpeed);
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
    // Default = ".lumio" ZIP with embedded media (self-contained, no relink warnings on import).
    // Shift+click = the lightweight bare ".lumio-template.json" (no media, git-friendly).
    if (!event?.shiftKey) {
      void exportTimelineTemplatePackageZip();
      return;
    }
    try {
      const pkg = buildTimelineTemplatePackage({
        projectId: project.id,
        title: `${project.title} Template`,
        description: `Lumio template package exported from ${project.title}.`,
        graph,
        composition,
        assets: resolvedAssets
      });
      downloadJsonFile(timelineTemplatePackageToJson(pkg), `${safeFileStem(project.title)}.lumio-template.json`);
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
    setNotice("Building .lumio package (embedding media)…");
    try {
      const pkg = buildTimelineTemplatePackage({
        projectId: project.id,
        title: `${project.title} Template`,
        description: `Lumio template package exported from ${project.title}.`,
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
      const zip = await buildLumioPackageZipAsync({ pkg, assets: embeddedAssets });
      downloadBlobFile(new Blob([zip.slice()], { type: "application/zip" }), `${safeFileStem(project.title)}.lumio`);
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

    if (file.name.toLowerCase().endsWith(".lumio")) {
      await importLumioPackageZip(file);
      return;
    }
    // Non-".lumio"-named files still get sniffed for the ZIP magic (a renamed/downloaded package),
    // matching how the JSON branch below already sniffs content rather than trusting the extension.
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (isLumioPackageZipBytes(head)) {
      await importLumioPackageZip(file);
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
   * Import a ".lumio" ZIP package: unzip, create a real local `SourceAsset` per embedded asset (via the
   * normal `createAsset` — local OPFS-first with an opt-in server fallback, same as any drag-drop upload),
   * then remap `layer.assetId` from the package's original ids to the freshly created ones so the applied
   * composition points at real, present media instead of relink-by-name placeholders.
   */
  async function importLumioPackageZip(file: File) {
    if (!project) return;
    setBusy("template-package");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { pkg, assetBytes } = await parseLumioPackageZipAsync(bytes);
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
            folder: `local/${kind}`,
            originalName: assetRef.fileName,
            sizeBytes: embedded.byteLength
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
        console.warn("[templates] .lumio import warnings", warnings);
      }
      setNotice(
        warnings[0]
          ? `Imported "${pkg.manifest.name}" · ${idMap.size} embedded asset(s) · ${warnings[0]}`
          : `Imported "${pkg.manifest.name}" with ${idMap.size} embedded asset(s)`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : ".lumio package import failed");
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

  async function handleUploadAsset(file: File | null, options?: { source?: AssetSource; folder?: string }) {
    if (!file) {
      return;
    }

    setBusy("asset-upload");
    const metadata = await readMediaMetadata(file);
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "video";
    const source = options?.source ?? "local";
    const asset = await createAsset({
      file,
      ...metadata,
      source,
      folder: options?.folder ?? `${source === "brand" ? "brand" : "local"}/${kind}`,
      originalName: file.name,
      sizeBytes: file.size
    });
    setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
    setBusy(null);
  }

  /** Add a library asset that was created elsewhere (stock import, generated, AI). */
  function registerAsset(asset: SourceAsset) {
    setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
  }

  /**
   * Push a browser-local asset to server storage so the cloud render worker can fetch it
   * (the worker can only read HTTP URLs). Uploads the bytes, then remaps any timeline clips
   * + the project's source asset from the local id to the new server id.
   */
  async function handleUploadAssetToCloud(asset: SourceAsset) {
    setBusy(`asset-cloud-${asset.id}`);
    try {
      const response = await fetch(asset.fileUrl, { cache: "no-store" });
      const blob = await response.blob();
      const file = new File([blob], asset.fileName, { type: asset.fileType || blob.type });
      const serverAsset = await createAsset({
        file,
        fileName: asset.fileName,
        fileType: asset.fileType,
        durationSeconds: asset.durationSeconds,
        width: asset.width,
        height: asset.height,
        source: asset.source ?? "local",
        folder: asset.folder,
        originalName: asset.originalName ?? asset.fileName
      });
      if (composition && graph && serverAsset.id !== asset.id) {
        const nextTracks = composition.tracks.map((track) => ({
          ...track,
          layers: track.layers.map((layer) => (layer.assetId === asset.id ? { ...layer, assetId: serverAsset.id } : layer))
        }));
        await updateGraph({
          ...graph,
          sourceAssetId: graph.sourceAssetId === asset.id ? serverAsset.id : graph.sourceAssetId,
          composition: { ...composition, tracks: nextTracks },
          version: graph.version + 1
        });
      }
      setAssets((current) => [serverAsset, ...current.filter((item) => item.id !== asset.id && item.id !== serverAsset.id)]);
      setNotice("Uploaded to cloud");
    } catch {
      setNotice("Cloud upload failed");
    } finally {
      setBusy(null);
    }
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
                fit: assetLayerType === "image" || assetLayerType === "video" ? (layer.fit ?? defaultMediaFit(assetLayerType)) : undefined
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
      const fade = Math.min(durationSeconds, layer.durationSeconds / 2);
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
   * passes the dropped kind. The same handler re-applies on a kind/param change.
   */
  function handleAddCrossDissolve(leftId: string, rightId: string, spec?: TransitionSpec) {
    if (!composition) {
      return;
    }
    const applied = spec ?? { kind: "crossDissolve" as const, durationSeconds: DEFAULT_CROSS_DISSOLVE_SECONDS };
    void updateComposition(applyJunctionTransition(composition, leftId, rightId, applied));
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
      id: `kf_${Date.now()}_${effectId}_gain_${Math.round(timeSeconds * 1000)}`,
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
      await saveExportedFile(blob, `${project.title || "lumio"}.${ext}`);
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
    const handoffKey = `lumio.localExportHandoff.${project.id}.${Date.now()}`;
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
      setNotice("Popup blocked. Allow popups for Lumio, then export again.");
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
    onMoveLayer: handleMoveLayer,
    onMoveKeyframe: (layerId: string, keyframeId: string, timeSeconds: number) => {
      void handleMoveKeyframe(layerId, keyframeId, timeSeconds);
      setNotice("Keyframe moved");
    },
    onSetTransition: handleSetTransition,
    onRemoveTransition: handleRemoveTransition,
    onAddCrossDissolve: handleAddCrossDissolve,
    onSetCrossDissolve: handleSetCrossDissolve,
    onRemoveCrossDissolve: handleRemoveCrossDissolve,
    onResizeLayer: handleResizeLayer,
    onSelectLayer: selectLayer,
    onSelectLayers: selectLayers,
    onToggleTrack: handleToggleTrack,
    onUnlinkLayer: handleUnlinkLayer,
    onUnlinkSelectedLayers: handleUnlinkSelectedLayers,
    onChangeToolMode: setTimelineTool,
    onToggleSnap: () => setSnapEnabled((value) => !value),
    onSplitLayerAt: (layerId: string, atSeconds: number) => {
      void handleSplitLayerAt(layerId, atSeconds);
    },
    onSplitAtPlayhead: () => {
      void handleSplitAtPlayhead();
    },
    onRippleDeleteLayer: (layerId: string) => {
      void handleRippleDeleteLayer(layerId);
    },
    onDuplicateLayer: (layerId: string) => {
      void handleDuplicateLayer(layerId);
    },
    onToggleMarkerAtPlayhead: handleToggleMarkerAtPlayhead,
    onRemoveMarker: handleRemoveMarker,
    onUpdateMarker: handleUpdateMarker,
    onSetInPoint: handleSetInPoint,
    onSetOutPoint: handleSetOutPoint,
    onClearInPoint: handleClearInPoint,
    onClearOutPoint: handleClearOutPoint,
    onClearInOutPoints: handleClearInOutPoints,
    onRegenerateProxyCache: handleRegenerateProxyCache,
    onToggleLivePlayback: setLivePlaybackMode,
    onReplaceLayerAsset: handleReplaceLayerAsset,
    onSlipLayer: handleSlipLayer,
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
      if (inspectorLayer) void updateLayer(inspectorLayer.id, updater);
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
    onChangeMaskTool: changeMaskTool
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
      data-lumio-theme={editorTheme}
    >
      <div className="editor-topbar" data-overflow={responsiveLayout.usesTopbarOverflow ? "menu" : "inline"}>
        <div className="topbar-left">
          <Link to="/" className="editor-brand">
            Lumio
          </Link>
          <div className="topbar-panel-toggles" role="toolbar" aria-label="Panels">
            <button
              type="button"
              className={`topbar-toggle${isLeftPanelTabActive("assets") ? " is-active" : ""}`}
              aria-pressed={isLeftPanelTabActive("assets")}
              onClick={() => toggleLeftPanelTab("assets")}
              title="Media Pool"
            >
              <FolderOpen size={14} />
              <span>Media</span>
            </button>
            <button
              type="button"
              className={`topbar-toggle${isLeftPanelTabActive("effects") ? " is-active" : ""}`}
              aria-pressed={isLeftPanelTabActive("effects")}
              onClick={() => toggleLeftPanelTab("effects")}
              title="Effects"
            >
              <SlidersHorizontal size={14} />
              <span>Effects</span>
            </button>
            <button
              type="button"
              className={`topbar-toggle${isLeftPanelTabActive("color") ? " is-active" : ""}`}
              aria-pressed={isLeftPanelTabActive("color")}
              onClick={() => toggleLeftPanelTab("color")}
              title="Color"
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
            className="editor-ai-topbar-button topbar-toggle"
            variant={aiPanelOpen ? "primary" : "secondary"}
            icon={<Sparkles size={16} />}
            onClick={() => setAiPanelOpen((open) => !open)}
            aria-pressed={aiPanelOpen}
            title={`${aiPanelOpen ? "Hide" : "Show"} AI assistant (${shortcutModifierLabel}+/)`}
            aria-keyshortcuts={`${shortcutModifierLabel}+/`}
          >
            AI
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
            accept="application/json,.json,.lumio-template,.lumio,.edl,.fcpxml,.xml,.prproj"
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
            title="Export .lumio package with embedded media (Shift+click: lightweight .lumio-template.json)"
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
              className={`topbar-toggle${themeMenuOpen ? " is-active" : ""}`}
              aria-pressed={themeMenuOpen}
              aria-expanded={themeMenuOpen}
              onClick={() => setThemeMenuOpen((open) => !open)}
              title="Theme"
            >
              <Droplet size={14} style={{ color: EDITOR_THEMES.find((theme) => theme.id === editorTheme)?.swatch }} />
              <span>Theme</span>
            </button>
            {themeMenuOpen ? (
              <div className="topbar-theme-menu" role="menu" aria-label="Accent theme">
                {EDITOR_THEMES.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={editorTheme === theme.id}
                    className={`topbar-theme-option${editorTheme === theme.id ? " is-active" : ""}`}
                    onClick={() => {
                      setEditorTheme(theme.id);
                      setThemeMenuOpen(false);
                    }}
                  >
                    <span className="topbar-theme-swatch" style={{ background: theme.swatch }} aria-hidden="true" />
                    {theme.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={`topbar-toggle${isInspectorOpenFromTopbar ? " is-active" : ""}`}
            aria-pressed={isInspectorOpenFromTopbar}
            onClick={toggleInspectorFromTopbar}
            title="Inspector"
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
        className={`editor-layout${panelExpanded ? " is-left-expanded" : ""}${inspectorExpanded ? " is-right-expanded" : ""}${panelExpanded || inspectorExpanded ? " is-any-expanded" : ""}${inspectorCollapsed ? " is-inspector-collapsed" : ""}${panelCollapsed ? " is-left-collapsed" : ""}`}
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
                    <button
                      className={`tabbar-icon-button${panelExpanded ? " is-active" : ""}`}
                      type="button"
                      title={panelExpanded ? "Restore left panel height" : "Expand left panel — full height, timeline under the viewer"}
                      aria-label={panelExpanded ? "Restore left panel height" : "Expand left panel to full height"}
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
                  onPickReplacement={stablePickReplacement}
                  onCancelReplace={stableCancelReplace}
                  onDeleteAsset={stableDeleteAsset}
                  onFocusAssetUse={stableFocusAssetUse}
                  onUploadAsset={stableUploadAsset}
                  onImportFile={stableImportFile}
                  onImportedAsset={stableRegisterAsset}
                  onMoveAssetFolder={stableMoveAssetFolder}
                  onSetAssetLabel={stableSetAssetLabel}
                  onUploadToCloud={stableUploadToCloud}
                  onOpenSourceMonitor={responsiveLayout.usesOverlayPanels ? undefined : stableOpenSourceMonitor}
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
                if (event.dataTransfer.types.includes("application/x-lumio-source-drag")) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }
              }}
              onDrop={(event) => {
                const raw = event.dataTransfer.getData("application/x-lumio-source-drag");
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
            />
            {shuttleRate !== null && (
              <div className="viewer-shuttle-badge" aria-live="polite">
                {shuttleRate < 0 ? "◀◀" : "▶▶"} {Math.abs(shuttleRate)}×
              </div>
            )}
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
                  title="Auto: Lumio adjusts playback resolution while playing — drops it when frames are dropped, recovers when smooth. Pick ¼/½/1 for a fixed resolution instead."
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
              <h2>Inspector</h2>
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
              ) : null}
              <div className="inspector-head-actions">
                {inspectorLayer ? (
                  <button
                    type="button"
                    title="Reset all controls"
                    aria-label="Reset all controls"
                    onClick={() => updateLayer(inspectorLayer.id, resetLayerControls)}
                  >
                    <RotateCcw size={14} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={responsiveLayout.usesPhoneShell ? (isResponsiveOverlayExpanded("inspector") ? "is-active" : "") : inspectorExpanded ? "is-active" : ""}
                  title={inspectorExpanded ? "Restore inspector height" : "Expand inspector — full height"}
                  aria-label={inspectorExpanded ? "Restore inspector height" : "Expand inspector to full height"}
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
                <span className="inspector-subtitle" title={inspectorLayer.name}>
                  {inspectorLayer.name}
                </span>
                {!selectedLayer ? (
                  <div className="inspector-persisted-hint">
                    <Eye size={13} /> Showing last selected
                  </div>
                ) : null}
                <TemplateSlotControl layer={inspectorLayer} onChange={inspectorHandlers.onChange} />
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
                />
                  )}
                </ColdTime>
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
        <div className="timeline-dock-row">
        <section className="editor-timeline-dock">
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
      {aiPanelOpen && composition ? (
        <aside className={`ai-dock${isResponsiveOverlayExpanded("ai") ? " is-responsive-overlay-expanded" : ""}`} aria-label="AI">
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
            getContext={() => ({ composition, selection: selectedLayerIds, nowSeconds: currentTimeRef.current })}
            commitComposition={(after) => updateComposition(after)}
            openTool={openToolForAi}
            onUndo={() => undo()}
            onClose={() => setAiPanelOpen(false)}
            onOpenGenerate={(prefill) => {
              setGenerateStudioPrefill(prefill);
              setGenerateStudioOpen(true);
            }}
            onAddAssetToTimeline={(asset) => void stableAddAssetToTimeline(asset, "auto")}
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
            onApplied={(nextComposition) => {
              void updateComposition(nextComposition);
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
            borderRadius: shapeOptions.borderRadius,
            ...(shapeOptions.shapeKind === "pen" ? { shapePath: defaultShapePathPoints(id) } : {})
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

function buildLayerMaxDurations(composition: TimelineComposition, assets: SourceAsset[]) {
  return flattenTimelineLayers(composition).reduce<Record<string, number>>((durations, layer) => {
    durations[layer.id] = getLayerMaxDuration(layer, assets, composition.durationSeconds);
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

const DEFAULT_CROSS_DISSOLVE_SECONDS = 0.5;
const OVERLAY_TRACK_ID = "track_transitions";
const DIP_MARKER = `${TRANSITION_MARKER}dip`;

/** A junction transition kind is anything the GPU transition engine registers (excludes edge fades). */
function isJunctionTransitionKind(kind: TransitionKind): boolean {
  return getTransition(kind) !== undefined;
}

function dipLayerId(leftId: string, rightId: string): string {
  return `${leftId}__dip__${rightId}`;
}

/** The clip immediately before `rightId` on the same track that touches/overlaps its start, or null. */
function findLeftNeighbor(composition: TimelineComposition, rightId: string): TimelineLayer | null {
  const track = composition.tracks.find((item) => item.layers.some((layer) => layer.id === rightId));
  const right = track?.layers.find((layer) => layer.id === rightId);
  if (!track || !right) {
    return null;
  }
  const epsilon = 1 / (Math.round(composition.fps) || 30) + 1e-3;
  let best: TimelineLayer | null = null;
  for (const layer of track.layers) {
    if (layer.id === rightId || layer.startSeconds >= right.startSeconds) {
      continue;
    }
    // Touching or overlapping the cut, and the nearest such clip to the left.
    if (layer.startSeconds + layer.durationSeconds >= right.startSeconds - epsilon) {
      if (!best || layer.startSeconds > best.startSeconds) {
        best = layer;
      }
    }
  }
  return best;
}

/** The clip immediately after `leftId` on the same track that touches/overlaps its end, or null. */
function findRightNeighbor(composition: TimelineComposition, leftId: string): TimelineLayer | null {
  const track = composition.tracks.find((item) => item.layers.some((layer) => layer.id === leftId));
  const left = track?.layers.find((layer) => layer.id === leftId);
  if (!track || !left) {
    return null;
  }
  const epsilon = 1 / (Math.round(composition.fps) || 30) + 1e-3;
  const cut = left.startSeconds + left.durationSeconds;
  let best: TimelineLayer | null = null;
  for (const layer of track.layers) {
    if (layer.id === leftId || layer.startSeconds <= left.startSeconds) {
      continue;
    }
    if (layer.startSeconds <= cut + epsilon) {
      if (!best || layer.startSeconds < best.startSeconds) {
        best = layer;
      }
    }
  }
  return best;
}

function findTransitionCutForClip(
  composition: TimelineComposition,
  clipId: string
): { left: TimelineLayer; right: TimelineLayer; side: "left" | "right" } | null {
  const clip = flattenTimelineLayers(composition).find((layer) => layer.id === clipId);
  if (!clip || clip.type === "audio") {
    return null;
  }
  const right = findRightNeighbor(composition, clipId);
  if (right) {
    return { left: clip, right, side: "right" };
  }
  const left = findLeftNeighbor(composition, clipId);
  if (left) {
    return { left, right: clip, side: "left" };
  }
  return null;
}

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

/**
 * Apply (or replace) a junction transition between two touching same-track clips — the professional,
 * handle-based model: a transition is **pure metadata** on the cut. NOTHING on the timeline moves or
 * changes length. The transition spans `[cut, cut+D]` (cut = incoming start): the incoming clip reveals
 * in (opacity for dissolve, transform keyframes for slide/zoom, or the shader spec for wipe/iris/dip),
 * while the renderers render the OUTGOING clip into that same window from its source handle (clamped to
 * the asset → real handle frames, or a held/repeated frame when the clip has no spare media — exactly
 * like Premiere). The `transitionIn` spec on the incoming clip is the single source of truth; resizing
 * only rewrites its `durationSeconds`, so clip lengths/positions never change.
 */
function applyJunctionTransition(
  composition: TimelineComposition,
  leftId: string,
  rightId: string,
  spec: TransitionSpec
): TimelineComposition {
  if (!isJunctionTransitionKind(spec.kind)) {
    return composition;
  }
  const track = composition.tracks.find(
    (item) => item.layers.some((layer) => layer.id === leftId) && item.layers.some((layer) => layer.id === rightId)
  );
  const left = track?.layers.find((layer) => layer.id === leftId);
  const right = track?.layers.find((layer) => layer.id === rightId);
  if (!track || !left || !right) {
    return composition;
  }
  const frameStep = 1 / (Math.round(composition.fps) || 30);
  // The window can't exceed either clip (so the reveal + the outgoing post-roll stay within the cut).
  const duration = Math.max(frameStep, Math.min(spec.durationSeconds, left.durationSeconds, right.durationSeconds));
  const appliedSpec: TransitionSpec = { ...spec, durationSeconds: duration };
  return {
    ...composition,
    tracks: composition.tracks.map((item) => {
      if (item.id !== track.id) {
        return item;
      }
      return {
        ...item,
        layers: item.layers.map((layer) => {
          // Outgoing clip is untouched (no extend) — only clear any stale fade-out keyframes.
          if (layer.id === leftId) {
            const cleaned = (layer.animations ?? []).filter((kf) => !kf.id.includes(`${TRANSITION_MARKER}out`));
            return cleaned.length === (layer.animations?.length ?? 0) ? layer : { ...layer, animations: cleaned };
          }
          // Incoming clip carries the spec. The unified GPU engine drives the entire reveal from the
          // spec + time (no per-clip keyframes), so strip any stale `_transition_` keyframes from the
          // legacy keyframe path so they can't double-apply once the window ends.
          if (layer.id === rightId) {
            const cleaned = (layer.animations ?? []).filter((kf) => !kf.id.includes(TRANSITION_MARKER));
            return { ...layer, transitionIn: appliedSpec, animations: cleaned };
          }
          return layer;
        })
      };
    })
  };
}

/**
 * Remove a junction transition: clear the incoming clip's spec + reveal keyframes and any stale fade-out
 * on the outgoing clip. Metadata-only — no clip length/position changes. Also cleans up any legacy
 * shape-based dip overlay layer/track from the earlier implementation.
 */
function removeJunctionTransition(composition: TimelineComposition, leftId: string, rightId: string): TimelineComposition {
  const track = composition.tracks.find(
    (item) => item.layers.some((layer) => layer.id === leftId) && item.layers.some((layer) => layer.id === rightId)
  );
  if (!track) {
    return composition;
  }
  const legacyDipId = dipLayerId(leftId, rightId);
  const tracks = composition.tracks
    .map((item) => {
      if (item.id === track.id) {
        return {
          ...item,
          layers: item.layers.map((layer) => {
            if (layer.id === leftId) {
              return { ...layer, animations: (layer.animations ?? []).filter((kf) => !kf.id.includes(`${TRANSITION_MARKER}out`)) };
            }
            if (layer.id === rightId) {
              return {
                ...layer,
                transitionIn: undefined,
                animations: (layer.animations ?? []).filter((kf) => !kf.id.includes(`${TRANSITION_MARKER}in`))
              };
            }
            return layer;
          })
        };
      }
      // Legacy cleanup: drop any shape-based dip layer for this pair from the old overlay track.
      if (item.id === OVERLAY_TRACK_ID) {
        return { ...item, layers: item.layers.filter((layer) => layer.id !== legacyDipId) };
      }
      return item;
    })
    .filter((item) => item.id !== OVERLAY_TRACK_ID || item.layers.length > 0);

  return { ...composition, tracks };
}

function getLayerMaxDuration(layer: TimelineLayer, assets: SourceAsset[], compositionDuration: number) {
  if ((layer.type === "video" || layer.type === "audio") && layer.assetId) {
    const asset = assets.find((item) => item.id === layer.assetId);
    if (asset?.durationSeconds) {
      // Rate stretch: a clip playing at 2x consumes media twice as fast, so its max
      // TIMELINE duration is the asset duration divided by speed.
      return Math.max(0.05, Math.max(0.2, asset.durationSeconds) / getLayerSpeed(layer));
    }
  }

  return compositionDuration;
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

  const audioTrack = composition.tracks.find((track) => track.type === "audio");
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
type MediaMetadata = { durationSeconds: number; width: number; height: number; hasAudio?: boolean | undefined; color?: SourceColorMetadata | undefined };

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
        void Promise.all([detectVideoFileHasAudio(file), detectSourceColorFromFile(file).catch(() => null)]).then(
          ([hasAudio, color]) => resolve({
            // The REAL fractional duration — never rounded up. A too-long clip freezes on the last frame
            // for the overshoot; a finite-but-default 12s on a short clip is the worst case (a long freeze).
            durationSeconds: clamp(Number.isFinite(duration) && duration > 0 ? duration : 12, 0.2, 7200),
            width: Math.max(320, video.videoWidth || 1080),
            height: Math.max(320, video.videoHeight || 1920),
            ...(hasAudio !== undefined ? { hasAudio } : {}),
            ...(color ? { color } : {})
          })
        );
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

type AssetSourceTab = "local" | "ai" | "search" | "brand" | "templates" | "used";
type AssetTypeFilter = "all" | "video" | "image" | "audio" | "graphics";
type FolderAssetTab = Extract<AssetSourceTab, "local" | "brand" | "ai">;
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
  return isExternalTimelineFile(file.name) || lower.endsWith(".json") || lower.endsWith(".lumio-template");
}

function assetKind(asset: SourceAsset): "video" | "image" | "audio" | "graphic" {
  if (asset.fileType.startsWith("image/")) {
    return asset.fileType.includes("svg") ? "graphic" : "image";
  }
  if (asset.fileType.startsWith("audio/")) return "audio";
  return "video";
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
      return source === "local" || source === "graphic";
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
  return tab === "local" || tab === "brand" || tab === "ai";
}

function defaultAssetFolder(tab: FolderAssetTab): string {
  return tab;
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

function readStoredAssetFolders(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("lumio_asset_custom_folders") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
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
  { id: "templates", label: "Templates", icon: <LayoutTemplate size={13} /> },
  { id: "used", label: "Used", icon: <Layers size={13} /> }
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
function AssetCardMedia({ asset, kind }: { asset: SourceAsset; kind: AssetKind }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const measured = useRef(Boolean(asset.width && asset.height));
  const [ratio, setRatio] = useState<number>(
    asset.width && asset.height ? asset.width / asset.height : kind === "video" ? 16 / 9 : 1
  );
  const style = { "--asset-ar": ratio } as CSSProperties;

  if (kind === "audio") {
    return (
      <div className="asset-card-media asset-card-media-audio">
        <Music size={20} />
      </div>
    );
  }

  if (kind === "image" || kind === "graphic") {
    return (
      <div className="asset-card-media" style={style}>
        <img
          src={asset.thumbnailUrl ?? asset.fileUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={(event) => {
            if (measured.current) return;
            const el = event.currentTarget;
            if (el.naturalWidth && el.naturalHeight) {
              measured.current = true;
              setRatio(el.naturalWidth / el.naturalHeight);
            }
          }}
        />
      </div>
    );
  }

  const videoSrc = asset.proxyUrl ?? asset.previewUrl ?? asset.fileUrl;
  // Show a STILL by default — never mount a <video> per card. A live <video preload="metadata"> on every
  // card fired a metadata fetch + decoder for every video asset the moment the bin opened, flooding the
  // browser's ~6 connections (starving playback AND the thumbnail extractor). The poster comes from the
  // server thumbnail when present, else a ONE-shot, throttled+cached first-frame extraction (useVideoPoster,
  // max 2 concurrent). A real <video> mounts only while hovered, for the live preview.
  const extractedPoster = useVideoPoster(asset.thumbnailUrl ? undefined : videoSrc, 0);
  const posterSrc = asset.thumbnailUrl ?? extractedPoster ?? undefined;
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
      {hovering ? (
        <video
          ref={videoRef}
          src={videoSrc}
          poster={posterSrc}
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
        <img src={posterSrc} alt="" loading="lazy" decoding="async" />
      ) : (
        <div className="asset-card-media-video-fallback">
          <Film size={20} />
        </div>
      )}
      {hovering && scrubFrac !== null ? (
        <span className="asset-scrub-line" style={{ left: `${scrubFrac * 100}%` }} aria-hidden="true" />
      ) : null}
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
        <video src={result.previewUrl} poster={result.thumbnailUrl} muted loop playsInline preload="none" />
      </div>
    );
  }

  return (
    <div className="asset-card-media" style={style}>
      <img src={result.thumbnailUrl} alt="" loading="lazy" />
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
  onOpenSourceMonitor
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
  /** Video/audio double-click target when the dual-monitor source viewer is available (desktop
      widths only — see showSourceMonitor in EditorPage). Undefined on tablet/phone, where
      double-click keeps opening the AssetViewerModal below. */
  onOpenSourceMonitor?: ((asset: SourceAsset) => void) | undefined;
}) {
  useRenderCost("AssetBin");
  // Project-scoped bin: drop uploads owned by another project (the "pile" fix). Library assets (ownerProjectId
  // null — brand/ai/stock) and this project's own uploads pass through. Mirrors GET /assets scope=project.
  const assets = useMemo(
    () =>
      currentProjectId
        ? rawAssets.filter((a) => !a.ownerProjectId || a.ownerProjectId === currentProjectId)
        : rawAssets,
    [rawAssets, currentProjectId]
  );
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
    readStoredChoice("lumio_asset_tab", "local", ["local", "ai", "search", "brand", "used"] as const)
  );
  const [filter, setFilter] = useState<AssetTypeFilter>(() =>
    readStoredChoice("lumio_asset_filter", "all", ["all", "video", "image", "audio", "graphics"] as const)
  );
  const [view, setView] = useState<"tiles" | "list">(() => readStoredChoice("lumio_asset_view", "tiles", ["tiles", "list"] as const));
  const [size, setSize] = useState<"small" | "medium" | "large">(() =>
    readStoredChoice("lumio_asset_size", "medium", ["small", "medium", "large"] as const)
  );
  const [activeAssetFolders, setActiveAssetFolders] = useState<Record<FolderAssetTab, string>>(() => ({
    local: localStorage.getItem("lumio_asset_folder_local") || defaultAssetFolder("local"),
    brand: localStorage.getItem("lumio_asset_folder_brand") || defaultAssetFolder("brand"),
    ai: localStorage.getItem("lumio_asset_folder_ai") || defaultAssetFolder("ai")
  }));
  const [customAssetFolders, setCustomAssetFolders] = useState<string[]>(readStoredAssetFolders);
  const [menuAssetId, setMenuAssetId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);

  // --- Unified Search state (Stock: photos/videos; Graphics: bundled + Iconify) ---
  // No provider identity in the UI — `stockType` doubles as the type chip (photos/videos/graphics).
  const [stockType, setStockType] = useState<"image" | "video" | "graphics">("image");
  const [stockOrientation, setStockOrientation] = useState<StockOrientation>(() =>
    readStoredChoice("lumio_stock_orientation", "all", ["all", "horizontal", "vertical", "square"] as const)
  );
  const [stockQuality, setStockQuality] = useState<StockQuality>(() =>
    readStoredChoice("lumio_stock_quality", "highest", ["highest", "4k", "1080p", "720p", "sd"] as const)
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
  // Asset viewer modal — opened by double-clicking a library asset or a stock result.
  const [viewerTarget, setViewerTarget] = useState<AssetViewerTarget | null>(null);

  // --- Templates gallery (curated + own) ---
  const [templatesList, setTemplatesList] = useState<TemplateDefinition[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null);

  const folderTab = isFolderAssetTab(sourceTab) ? sourceTab : null;
  const folderRoot = folderTab ? defaultAssetFolder(folderTab) : "";
  const activeFolder = folderTab ? activeAssetFolders[folderTab] || folderRoot : "";
  const folderTabLabel = sourceTab === "brand" ? "Brand" : sourceTab === "ai" ? "AI" : "Local";
  const currentFolderLabel = folderTab ? (activeFolder === folderRoot ? `${folderTabLabel} project` : assetFolderLabel(activeFolder)) : "";
  const folderCrumbs = useMemo(() => {
    if (!folderTab) return [];
    const rootCrumb = { path: folderRoot, label: folderTabLabel };
    const parts = activeFolder.slice(folderRoot.length).split("/").filter(Boolean);
    let path = folderRoot;
    return [
      rootCrumb,
      ...parts.map((part) => {
        path = `${path}/${part}`;
        return { path, label: part };
      })
    ];
  }, [activeFolder, folderRoot, folderTab, sourceTab]);
  const folderOptions = useMemo<AssetBinFolder[]>(() => {
    if (!folderTab) return [];
    const prefix = `${folderRoot}/`;
    const folders = new Set<string>();
    for (const asset of assets) {
      if (!matchesAssetTab(asset, folderTab, Boolean(usedCounts[asset.id]))) continue;
      const folder = normalizeAssetFolder(asset.folder);
      if (folder && folder !== folderRoot && folder.startsWith(prefix)) folders.add(folder);
    }
    for (const folder of customAssetFolders) {
      const normalizedFolder = normalizeAssetFolder(folder);
      if (normalizedFolder !== folderRoot && normalizedFolder.startsWith(prefix)) folders.add(normalizedFolder);
    }
    return Array.from(folders)
      .sort((a, b) => a.localeCompare(b))
      .map((folder) => ({
        path: folder,
        label: assetFolderLabel(folder),
        depth: Math.max(0, folder.split("/").length - folderRoot.split("/").length),
        assetCount: assets.filter((asset) => normalizeAssetFolder(asset.folder) === folder && matchesAssetTab(asset, folderTab, Boolean(usedCounts[asset.id]))).length,
        childCount: Array.from(folders).filter((candidate) => parentAssetFolder(candidate) === folder).length
      }));
  }, [assets, customAssetFolders, folderRoot, folderTab, usedCounts]);

  const queryText = query.trim().toLowerCase();
  const visibleFolders = useMemo(() => {
    if (!folderTab || queryText) return [];
    return folderOptions.filter((folder) => parentAssetFolder(folder.path) === activeFolder);
  }, [activeFolder, folderOptions, folderTab, queryText]);
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
    readStoredChoice("lumio_asset_sort", "name", ["name", "type", "duration", "dimensions", "used"] as const)
  );
  const [sortDir, setSortDir] = useState<1 | -1>(() => (localStorage.getItem("lumio_asset_sort_dir") === "-1" ? -1 : 1));
  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => {
        const next = dir === 1 ? -1 : 1;
        localStorage.setItem("lumio_asset_sort_dir", String(next));
        return next as 1 | -1;
      });
      return;
    }
    setSortKey(key);
    setSortDir(1);
    localStorage.setItem("lumio_asset_sort", key);
    localStorage.setItem("lumio_asset_sort_dir", "1");
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
      const raw = JSON.parse(localStorage.getItem("lumio_asset_expanded_bins") || "[]");
      return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem("lumio_asset_expanded_bins", JSON.stringify(expandedBins));
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
    localStorage.setItem("lumio_asset_tab", sourceTab);
  }, [sourceTab]);

  useEffect(() => {
    localStorage.setItem("lumio_asset_folder_local", activeAssetFolders.local);
    localStorage.setItem("lumio_asset_folder_brand", activeAssetFolders.brand);
    localStorage.setItem("lumio_asset_folder_ai", activeAssetFolders.ai);
  }, [activeAssetFolders]);

  useEffect(() => {
    localStorage.setItem("lumio_asset_custom_folders", JSON.stringify(customAssetFolders));
  }, [customAssetFolders]);

  useEffect(() => {
    localStorage.setItem("lumio_asset_filter", filter);
  }, [filter]);

  useEffect(() => {
    localStorage.setItem("lumio_asset_view", view);
  }, [view]);

  useEffect(() => {
    localStorage.setItem("lumio_asset_size", size);
  }, [size]);

  useEffect(() => {
    localStorage.setItem("lumio_stock_orientation", stockOrientation);
  }, [stockOrientation]);

  useEffect(() => {
    localStorage.setItem("lumio_stock_quality", stockQuality);
  }, [stockQuality]);

  // Close the per-card "More" menu when clicking elsewhere or pressing Escape.
  useEffect(() => {
    if (!menuAssetId) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".asset-tile-menu") || target?.closest(".asset-more-button")) return;
      setMenuAssetId(null);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuAssetId(null);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuAssetId]);

  // Probe whether stock search is configured (once the Search tab is opened).
  useEffect(() => {
    if (sourceTab !== "search" || stockStatus) return;
    void getStockStatus().then(setStockStatus);
  }, [sourceTab, stockStatus]);

  // Fetch curated + own templates once the Templates tab is opened.
  useEffect(() => {
    if (sourceTab !== "templates" || templatesList.length) return;
    setTemplatesLoading(true);
    void listMyTemplates()
      .then(setTemplatesList)
      .finally(() => setTemplatesLoading(false));
  }, [sourceTab, templatesList.length]);

  // Debounced stock search (page 1) against the active type / orientation. Graphics has its own effect below.
  useEffect(() => {
    if (sourceTab !== "search" || stockType === "graphics") return;
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
    if (stockType === "graphics") return;
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
   *  so it normalizes to `currentColor`; Iconify mono icons already use `currentColor` (pass undefined). */
  function handleImportGraphic(id: string, name: string, svg: string, sourceColor?: string) {
    setStockImportError(null);
    try {
      const graphic = normalizeGraphicSvg(svg, sourceColor);
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
  const uploadSource: AssetUploadOptions | undefined = folderTab ? { source: folderTab, folder: activeFolder || folderRoot } : undefined;
  const showUpload = sourceTab === "local" || sourceTab === "brand";
  const canDropFiles = showUpload;
  const uploadAccept = onImportFile ? "video/*,image/*,audio/*,.json,.lumio-template,.edl,.fcpxml,.xml,.prproj" : "video/*,image/*,audio/*";
  const showDropPrompt = showUpload && filteredAssets.length === 0;

  function selectAssetFolder(folder: string) {
    if (!folderTab) return;
    setActiveAssetFolders((current) => ({ ...current, [folderTab]: folder }));
  }

  function createAssetFolder() {
    if (!folderTab) return;
    const rawName = window.prompt("Folder name");
    if (rawName == null) return;
    const name = sanitizeAssetFolderName(rawName);
    if (!name) return;
    const folder = `${activeFolder || folderRoot}/${name}`;
    setCustomAssetFolders((current) => (current.includes(folder) ? current : [...current, folder]));
    setActiveAssetFolders((current) => ({ ...current, [folderTab]: folder }));
  }

  function assetByDragEvent(event: ReactDragEvent<HTMLElement>): SourceAsset | null {
    const assetId = event.dataTransfer.getData("application/x-lumio-asset");
    return assetId ? assets.find((asset) => asset.id === assetId) ?? null : null;
  }

  function canMoveAssetToFolder(asset: SourceAsset | null, folder: string): asset is SourceAsset {
    return Boolean(asset && folderTab && matchesAssetTab(asset, folderTab, Boolean(usedCounts[asset.id])) && normalizeAssetFolder(asset.folder) !== folder);
  }

  function handleAssetFolderDragOver(event: ReactDragEvent<HTMLElement>, folder: string) {
    if (!folderTab) return;
    const types = event.dataTransfer.types;
    if (!types.includes("application/x-lumio-asset") && !types.includes("application/x-lumio-asset-folder")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleAssetFolderDrop(event: ReactDragEvent<HTMLElement>, folder: string) {
    const draggedFolder = event.dataTransfer.getData("application/x-lumio-asset-folder");
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

  async function processUploadFiles(files: FileList | File[]) {
    const fileList = Array.from(files);
    if (!fileList.length) return;
    for (const file of fileList) {
      if (isTimelineOrTemplateImportFile(file) && onImportFile) {
        await onImportFile(file);
      } else if (isTimelineOrTemplateImportFile(file)) {
        continue;
      } else {
        await onUploadAsset(file, uploadSource);
      }
    }
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
    void processUploadFiles(event.dataTransfer.files);
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
        for (const bin of folderOptions.filter((entry) => parentAssetFolder(entry.path) === folderPath)) {
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
    sourceTab === "search" || sourceTab === "templates" ? (
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
            <button type="button" className="asset-toolbar-button" title="New bin" onClick={createAssetFolder}>
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

  return (
    <div
      className={`asset-bin asset-bin-${view} asset-bin-${size} ${replaceActive ? "is-replace-mode" : ""} ${dropActive ? "is-drop-active" : ""}`}
      onDragEnter={handleAssetBinDragEnter}
      onDragOver={handleAssetBinDragOver}
      onDragLeave={handleAssetBinDragLeave}
      onDrop={handleAssetBinDrop}
    >
      <div className="asset-bin-tabs" role="tablist" aria-label="Asset library">
        {ASSET_TABS.filter((tab) => !(clickAssigns && tab.id === "templates")).map((tab) => (
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
            {(["image", "video", "graphics"] as const).map((kind) => (
              <button key={kind} type="button" className={stockType === kind ? "is-active" : ""} onClick={() => setStockType(kind)}>
                {kind === "image" ? "Photos" : kind === "video" ? "Videos" : "Graphics"}
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
          {stockType !== "graphics" ? (
            <div className="asset-stock-filters">
              <div className="asset-stock-filter">
                <ThemedSelect ariaLabel="Orientation" value={stockOrientation} groups={STOCK_ORIENTATION_GROUPS} onChange={setStockOrientation} />
              </div>
              <div className="asset-stock-filter">
                <ThemedSelect ariaLabel="Import quality" value={stockQuality} groups={STOCK_QUALITY_GROUPS} onChange={setStockQuality} />
              </div>
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
                placeholder={folderTab ? `Search ${currentFolderLabel}` : sourceTab === "templates" ? "Search templates" : "Search assets"}
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
        {sourceTab === "search" && stockType === "graphics" ? (
          <div className="asset-grid">
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
        ) : sourceTab === "search" && !stockConfigured ? (
          <div className="asset-empty-state">
            <Globe size={18} />
            <strong>Stock search not connected</strong>
            <span>Add PEXELS_API_KEY to your .env to search and import stock {stockType === "image" ? "photos" : "videos"}.</span>
          </div>
        ) : sourceTab === "search" && query.trim() ? (
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
        ) : sourceTab === "templates" ? (
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
                          if (event.key === "Enter") toggleBinExpanded(folder.path);
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("application/x-lumio-asset-folder", folder.path);
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
                          <strong>{folder.label}</strong>
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
                        setMenuAssetId(asset.id);
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/x-lumio-asset", asset.id);
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
                            setMenuAssetId((id) => (id === asset.id ? null : asset.id));
                          }}
                        >
                          <MoreVertical size={13} />
                        </button>
                      </span>
                      {menuAssetId === asset.id ? (
                        <div className="asset-tile-menu asset-list-menu" role="menu" onClick={(event) => event.stopPropagation()}>
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
                                    setMenuAssetId(null);
                                    void onSetAssetLabel(asset, labelName === name ? null : name);
                                  }}
                                />
                              ))}
                            </div>
                          ) : null}
                          <button type="button" onClick={() => { setMenuAssetId(null); setViewerTarget({ kind: "asset", asset }); }}>
                            <Eye size={13} /> Preview
                          </button>
                          <button type="button" onClick={() => { setMenuAssetId(null); void downloadAssetFile(asset); }}>
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
                                    setMenuAssetId(null);
                                    void onMoveAssetFolder?.(asset, folder.path);
                                  }}
                                >
                                  <Move size={13} /> {folder.label}
                                </button>
                              ))}
                            </>
                          ) : null}
                          {onDeleteAsset ? (
                            <button type="button" className="is-danger" onClick={() => { setMenuAssetId(null); onDeleteAsset(asset); }}>
                              <Trash2 size={13} /> Delete
                            </button>
                          ) : null}
                        </div>
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
                <button
                  key={folder.path}
                  type="button"
                  className="asset-tile asset-bin-folder"
                  title={`${folder.path} — drag onto a bin to nest`}
                  draggable
                  onClick={() => selectAssetFolder(folder.path)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-lumio-asset-folder", folder.path);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => handleAssetFolderDragOver(event, folder.path)}
                  onDrop={(event) => handleAssetFolderDrop(event, folder.path)}
                >
                  <span className="asset-folder-thumb">
                    <Folder size={22} />
                  </span>
                  <span className="asset-folder-row-main">
                    <strong>{folder.label}</strong>
                    <small>
                      {folder.assetCount + folder.childCount
                        ? `${folder.assetCount} asset${folder.assetCount === 1 ? "" : "s"} · ${folder.childCount} bin${folder.childCount === 1 ? "" : "s"}`
                        : "Empty bin"}
                    </small>
                  </span>
                </button>
              ))}
              {filteredAssets.map((asset) => {
              const source = assetSourceOf(asset);
              const kind = assetKind(asset);
              const labelName = assetLabelOf(asset);
              const meta = formatAssetMeta(asset);
              const isLocalOnly = asset.fileUrl.startsWith("localblob:") || (!asset.cloudUrl && asset.id.startsWith("asset_local_"));
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
                    setMenuAssetId(asset.id);
                  }}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-lumio-asset", asset.id);
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
                      ) : (
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
                          setMenuAssetId((id) => (id === asset.id ? null : asset.id));
                        }}
                      >
                        <MoreVertical size={14} />
                      </button>
                    </div>
                  </div>
                  {menuAssetId === asset.id ? (
                    <div className="asset-tile-menu" role="menu" onClick={(event) => event.stopPropagation()}>
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
                                setMenuAssetId(null);
                                void onSetAssetLabel(asset, labelName === name ? null : name);
                              }}
                            />
                          ))}
                        </div>
                      ) : null}
                      {onUploadToCloud && isLocalOnly ? (
                        <button type="button" onClick={() => { setMenuAssetId(null); onUploadToCloud(asset); }}>
                          <CloudUpload size={13} /> Upload to cloud
                        </button>
                      ) : asset.cloudUrl ? (
                        <span className="asset-tile-menu-note">
                          <Cloud size={13} /> In cloud
                        </span>
                      ) : null}
                      <button type="button" onClick={() => { setMenuAssetId(null); void downloadAssetFile(asset); }}>
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
                                setMenuAssetId(null);
                                void onMoveAssetFolder?.(asset, folder.path);
                              }}
                            >
                              <Move size={13} /> {folder.label}
                            </button>
                          ))}
                        </>
                      ) : null}
                      {onDeleteAsset ? (
                        <button type="button" className="is-danger" onClick={() => { setMenuAssetId(null); onDeleteAsset(asset); }}>
                          <Trash2 size={13} /> Delete
                        </button>
                      ) : null}
                    </div>
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
      <AssetViewerModal
        target={viewerTarget}
        importing={Boolean(importingId)}
        onClose={() => setViewerTarget(null)}
        onAddToTimeline={onAddAssetToTimeline}
        onImport={(result, variant) => void handleImportStock(result, variant)}
        onUploadToCloud={onUploadToCloud}
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
}) {
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);
  const [dragEffectId, setDragEffectId] = useState<string | null>(null);
  const [dragOverEffectId, setDragOverEffectId] = useState<string | null>(null);
  // Stable {width,height} for the mask InspectorHost — an inline literal would defeat its memo.
  const compositionSize = useMemo(
    () => ({ width: composition.width, height: composition.height }),
    [composition.width, composition.height]
  );

  return (
    <div className="inspector-panel">
      {!hideAssetBin && (layer.type === "video" || layer.type === "image") ? (
        <AssetBin assets={assets} selectedAssetId={layer.assetId} clickAssigns onAssignAsset={onAssignAsset} onDeleteAsset={onDeleteAsset} onUploadAsset={onUploadAsset} />
      ) : null}

      {layer.type === "text" ? <TextGraphicControls layer={layer} palette={palette} onChange={onChange} /> : null}
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
          <ClipSpeedControl layer={layer} layerTime={layerTime} onChange={onChange} onChangeSpeed={onChangeSpeed} />
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

      <InspectorSection title="Effects" icon={<SlidersHorizontal size={13} />} count={layer.effects.length}>
      <EffectPresetRow layer={layer} onChange={onChange} />
      <div className="effect-controls">
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
                onDelete={() => onChange((item) => ({ ...item, effects: item.effects.filter((candidate) => candidate.id !== effect.id) }))}
                onUpdate={(nextEffect) =>
                  onChange((item) => ({
                    ...item,
                    effects: item.effects.map((candidate) => (candidate.id === effect.id ? nextEffect : candidate))
                  }))
                }
              />
            </div>
          ))
        ) : (
          <div className="empty-mini">
            <Eye size={16} />
            No layer effects yet
          </div>
        )}
      </div>
      </InspectorSection>

      <InspectorSection title="Track" icon={<Move size={13} />} count={tracks.length} defaultOpen={false}>
        <AttachTrackPanel layer={layer} tracks={tracks} onAttach={onAttachTrack} onEditTrack={onEditTrack} onOpenTrackModal={onOpenTrackModal} onRemoveTrack={onRemoveTrack} />
      </InspectorSection>
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
  onChangeSpeed
}: {
  layer: TimelineLayer;
  /** Playhead in layer-local seconds (for placing ramp points). */
  layerTime: number;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  onChangeSpeed: (layerId: string, speed: number) => void;
}) {
  const speed = getLayerSpeed(layer);
  const ramp = getSpeedRamp(layer);
  const [draft, setDraft] = useState(() => String(Math.round(speed * 100)));
  useEffect(() => {
    setDraft(String(Math.round(speed * 100)));
  }, [speed, layer.id]);
  const commit = (value: number) => {
    if (Number.isFinite(value) && value > 0) onChangeSpeed(layer.id, value);
  };
  // Ramp points write straight onto layer.speedKeyframes (clip duration is NOT re-derived — a
  // ramp reads more/less source into the same timeline span, Premiere time-remap semantics).
  const upsertRampPoint = (timeSeconds: number, value: number) => {
    onChange((current) => {
      const points = (current.speedKeyframes ?? []).filter((kf) => Math.abs(kf.timeSeconds - timeSeconds) > 0.02);
      return { ...current, speedKeyframes: [...points, { timeSeconds, value }].sort((a, b) => a.timeSeconds - b.timeSeconds) };
    });
  };
  const removeRampPoint = (timeSeconds: number) => {
    onChange((current) => {
      const points = (current.speedKeyframes ?? []).filter((kf) => Math.abs(kf.timeSeconds - timeSeconds) > 1e-4);
      return { ...current, speedKeyframes: points.length ? points : undefined };
    });
  };
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
      </div>
      <label className="clip-speed-field">
        Speed
        <ScrubNumberInput
          min={5}
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
      <div className="clip-speed-ramp">
        <div className="clip-speed-ramp-head">
          <span>Speed ramp</span>
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

function TextGraphicControls({
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
      <InspectorSection icon={<Type size={15} />} title="Text">
        <label className="control-field">
          <span>
            <Type size={14} />
            Content
          </span>
          <textarea
            rows={3}
            value={layer.text ?? ""}
            onChange={(event) => onChange((item) => ({ ...item, text: event.target.value }))}
          />
        </label>
        <div className="graphic-controls">
          <div className="icon-control-row">
            <FontControl value={layer.fontFamily ?? renderSafeFonts[0].family} onReset={() => onChange((item) => ({ ...item, fontFamily: defaultTextStyle.fontFamily }))} onChange={(value) => onChange((item) => ({ ...item, fontFamily: value }))} />
            <NumberControl icon={<CaseSensitive size={14} />} label="Font size" value={layer.fontSize ?? defaultTextStyle.fontSize} min={10} max={260} step={1} onReset={() => onChange((item) => ({ ...item, fontSize: defaultTextStyle.fontSize }))} onChange={(value) => onChange((item) => ({ ...item, fontSize: value }))} />
          </div>
          <div className="icon-control-row">
            <ToggleControl icon={<Bold size={15} />} label="Bold" active={(layer.fontWeight ?? defaultTextStyle.fontWeight) >= 700} onChange={(active) => onChange((item) => ({ ...item, fontWeight: active ? 900 : 400 }))} />
            <ToggleControl icon={<Italic size={15} />} label="Italic" active={layer.italic ?? false} onChange={(active) => onChange((item) => ({ ...item, italic: active }))} />
            <AlignmentControl value={layer.textAlign ?? "center"} onChange={(value) => onChange((item) => ({ ...item, textAlign: value }))} />
          </div>
          <div className="icon-control-row">
            <NumberControl icon={<MoveHorizontal size={14} />} label="Letter spacing" value={layer.letterSpacing ?? 0} min={-10} max={40} step={0.5} onReset={() => onChange((item) => ({ ...item, letterSpacing: defaultTextStyle.letterSpacing }))} onChange={(value) => onChange((item) => ({ ...item, letterSpacing: value }))} />
            <NumberControl icon={<MoveVertical size={14} />} label="Line height" value={layer.lineHeight ?? defaultTextStyle.lineHeight} min={0.6} max={2.4} step={0.05} onReset={() => onChange((item) => ({ ...item, lineHeight: defaultTextStyle.lineHeight }))} onChange={(value) => onChange((item) => ({ ...item, lineHeight: value }))} />
            <NumberControl icon={<MoveHorizontal size={14} />} label="Text box width" value={layer.textWidthPercent ?? 0} min={0} max={100} step={1} onReset={() => onChange((item) => ({ ...item, textWidthPercent: defaultTextStyle.textWidthPercent }))} onChange={(value) => onChange((item) => ({ ...item, textWidthPercent: value }))} />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection icon={<PaintBucket size={15} />} title="Fill & stroke">
        <div className="graphic-controls">
          <div className="icon-control-row">
            <ColorControl icon={<PaintBucket size={14} />} label="Fill color" palette={palette} value={layer.color ?? "#ffffff"} onReset={() => onChange((item) => ({ ...item, color: defaultTextStyle.color }))} onChange={(value) => onChange((item) => ({ ...item, color: value }))} />
            <ColorControl icon={<PenLine size={14} />} label="Stroke color" palette={palette} value={layer.strokeColor ?? "#161618"} onReset={() => onChange((item) => ({ ...item, strokeColor: defaultTextStyle.strokeColor }))} onChange={(value) => onChange((item) => ({ ...item, strokeColor: value }))} />
            <NumberControl icon={<PenLine size={14} />} label="Stroke width" value={layer.strokeWidth ?? 0} min={0} max={24} step={1} onReset={() => onChange((item) => ({ ...item, strokeWidth: defaultTextStyle.strokeWidth }))} onChange={(value) => onChange((item) => ({ ...item, strokeWidth: value }))} />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection icon={<Square size={15} />} title="Background">
        <BackgroundControls layer={layer} palette={palette} onChange={onChange} />
      </InspectorSection>

      <InspectorSection icon={<Spline size={15} />} title="Warp">
        <InspectorHost layer={layer} onChange={onChange} panelIds={TEXT_WARP_PANEL_IDS} />
      </InspectorSection>

      <InspectorSection icon={<Sparkles size={15} />} title="Shadow">
        <div className="graphic-controls">
          <ShadowControls layer={layer} palette={palette} onChange={onChange} />
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
            <NumberControl icon={<MoveHorizontal size={14} />} label="Width" value={layer.widthPercent ?? 44} min={2} max={200} step={1} onReset={() => onChange((item) => ({ ...item, widthPercent: defaultShapeStyle.widthPercent }))} onChange={(value) => onChange((item) => ({ ...item, widthPercent: value }))} />
            <NumberControl icon={<MoveVertical size={14} />} label="Height" value={layer.heightPercent ?? 18} min={2} max={200} step={1} onReset={() => onChange((item) => ({ ...item, heightPercent: defaultShapeStyle.heightPercent }))} onChange={(value) => onChange((item) => ({ ...item, heightPercent: value }))} />
            <NumberControl icon={<Radius size={14} />} label="Radius" value={layer.borderRadius ?? 22} min={0} max={160} step={1} onReset={() => onChange((item) => ({ ...item, borderRadius: defaultShapeStyle.borderRadius }))} onChange={(value) => onChange((item) => ({ ...item, borderRadius: value }))} />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection icon={<PaintBucket size={15} />} title="Fill & stroke">
        <div className="graphic-controls">
          <div className="icon-control-row">
            <ColorControl icon={<PaintBucket size={14} />} label="Fill color" palette={palette} value={layer.color ?? "#4D9FFF"} onReset={() => onChange((item) => ({ ...item, color: defaultShapeStyle.color }))} onChange={(value) => onChange((item) => ({ ...item, color: value }))} />
            <ColorControl icon={<PenLine size={14} />} label="Stroke color" palette={palette} value={layer.strokeColor ?? "#ffffff"} onReset={() => onChange((item) => ({ ...item, strokeColor: defaultShapeStyle.strokeColor }))} onChange={(value) => onChange((item) => ({ ...item, strokeColor: value }))} />
            <NumberControl icon={<PenLine size={14} />} label="Stroke width" value={layer.strokeWidth ?? 0} min={0} max={32} step={1} onReset={() => onChange((item) => ({ ...item, strokeWidth: defaultShapeStyle.strokeWidth }))} onChange={(value) => onChange((item) => ({ ...item, strokeWidth: value }))} />
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
  onChange
}: {
  layer: TimelineLayer;
  palette: string[];
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
}) {
  const background = parseBackgroundColor(layer.backgroundColor, "#08090d");
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
          value={Math.round((layer.backgroundPaddingEm ?? defaultTextStyle.backgroundPaddingEm) * 100)}
          min={0}
          max={100}
          step={1}
          onReset={() => onChange((item) => ({ ...item, backgroundPaddingEm: defaultTextStyle.backgroundPaddingEm }))}
          onChange={(value) => onChange((item) => ({ ...item, backgroundPaddingEm: value / 100 }))}
        />
        <NumberControl
          icon={<Radius size={14} />}
          label="Corner radius"
          value={Math.round((layer.backgroundRadiusEm ?? defaultTextStyle.backgroundRadiusEm) * 100)}
          min={0}
          max={200}
          step={1}
          onReset={() => onChange((item) => ({ ...item, backgroundRadiusEm: defaultTextStyle.backgroundRadiusEm }))}
          onChange={(value) => onChange((item) => ({ ...item, backgroundRadiusEm: value / 100 }))}
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
  onUpdate: (effect: TimelineEffect) => void;
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
    const fresh = createTimelineEffect(normalizedEffect.type);
    onUpdate({ ...fresh, id: normalizedEffect.id });
  };

  const updateParam = (
    param: TimelineEffectParamDefinition,
    value: string | number | boolean,
    extraParams?: Record<string, string | number | boolean>
  ) => {
    onUpdate({
      ...normalizedEffect,
      params: {
        ...(normalizedEffect.params ?? {}),
        [param.key]: value,
        ...(extraParams ?? {})
      }
    });
  };

  return (
    <div className={`effect-control-card ${normalizedEffect.enabled ? "" : "is-disabled"}`}>
      <div className="effect-control-header">
        <button
          aria-label={normalizedEffect.enabled ? "Disable effect" : "Enable effect"}
          className={normalizedEffect.enabled ? "is-active" : ""}
          type="button"
          onClick={() => onUpdate({ ...normalizedEffect, enabled: !normalizedEffect.enabled })}
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
        onChange={(value) => onUpdate({ ...normalizedEffect, intensity: value })}
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
          onChangeMasks={(updater) => onUpdate({ ...normalizedEffect, masks: updater(normalizedEffect.masks ?? []) })}
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
    const nextKeyframeTime = param.keyframeable ? findEffectParamKeyframeTime(layer, effect.id, param.key, layerTime, 1) : undefined;
    const previousKeyframeTime = param.keyframeable ? findEffectParamKeyframeTime(layer, effect.id, param.key, layerTime, -1) : undefined;
    return (
      <EffectSliderControl
        keyframe={
          param.keyframeable
            ? {
                active: Boolean(activeKeyframe),
                hasAny: getEffectParamKeyframes(layer, effect.id, param.key).length > 0,
                hasNext: nextKeyframeTime !== undefined,
                hasPrevious: previousKeyframeTime !== undefined,
                interpolation: activeKeyframe?.interpolation,
                onChangeInterpolation: (interpolation) =>
                  onChangeLayer((item) => setEffectParamInterpolation(item, effect.id, param.key, layerTime, interpolation)),
                onClearAll: () => onChangeLayer((item) => clearEffectParamKeyframes(item, effect.id, param.key)),
                onNext: () => {
                  if (nextKeyframeTime !== undefined) onSeek?.(layer.startSeconds + nextKeyframeTime);
                },
                onPrevious: () => {
                  if (previousKeyframeTime !== undefined) onSeek?.(layer.startSeconds + previousKeyframeTime);
                },
                onToggle: () => onChangeLayer((item) => toggleEffectParamKeyframe(item, effect.id, param.key, layerTime, animatedValue))
              }
            : undefined
        }
        label={param.unit ? `${param.label} ${param.unit}` : param.label}
        max={param.max}
        min={param.min}
        tone={effectSliderTone(param.key)}
        step={param.step}
        value={animatedValue}
        onReset={() => onChangeLayer((item) => updateEffectParamAtTime(item, effect.id, param.key, layerTime, param.defaultValue))}
        onChange={(nextValue) => onChangeLayer((item) => applyEffectParamValueAtTime(item, effect.id, param.key, layerTime, nextValue, { autoKeyframe }))}
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
  onChange
}: {
  layer: TimelineLayer;
  palette: string[];
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
}) {
  const defaults = layer.type === "shape" ? defaultShapeStyle : defaultTextStyle;
  return (
    <div className="icon-control-row">
      <ColorControl icon={<Sparkles size={14} />} label="Shadow color" palette={palette} value={layer.shadowColor ?? "#000000"} onReset={() => onChange((item) => ({ ...item, shadowColor: defaults.shadowColor }))} onChange={(value) => onChange((item) => ({ ...item, shadowColor: value }))} />
      <NumberControl icon={<Sparkles size={14} />} label="Shadow blur" value={layer.shadowBlur ?? 0} min={0} max={80} step={1} onReset={() => onChange((item) => setShadowEnabled({ ...item, shadowBlur: defaults.shadowBlur }, defaults.shadowBlur > 0))} onChange={(value) => onChange((item) => setShadowEnabled({ ...item, shadowBlur: value }, value > 0))} />
      <NumberControl icon={<MoveHorizontal size={14} />} label="Shadow X" value={layer.shadowOffsetX ?? 0} min={-80} max={80} step={1} onReset={() => onChange((item) => ({ ...item, shadowOffsetX: defaults.shadowOffsetX }))} onChange={(value) => onChange((item) => ({ ...item, shadowOffsetX: value }))} />
      <NumberControl icon={<MoveVertical size={14} />} label="Shadow Y" value={layer.shadowOffsetY ?? 0} min={-80} max={80} step={1} onReset={() => onChange((item) => ({ ...item, shadowOffsetY: defaults.shadowOffsetY }))} onChange={(value) => onChange((item) => ({ ...item, shadowOffsetY: value }))} />
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
