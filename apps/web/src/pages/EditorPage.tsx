import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Download,
  Eye,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudUpload,
  Diamond,
  Film,
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
  buildTimelineTemplatePackage,
  buildTemplateGraphFromProject,
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
  getLayerAnimations,
  getTimelineEffectDefinition,
  getTimelineEffectsForLayer,
  normalizeTimelineEffect,
  renderSafeFonts,
  splitLayerAtTime,
  rippleDeleteLayer,
  duplicateLayer,
  copyLayerToClipboard,
  getToolCapability,
  hasClipboardLayer,
  pasteLayerFromClipboard,
  parseTimelineTemplatePackage,
  trackingPathToPositionKeyframes,
  timelineTemplatePackageToJson,
  updateTimelineLayer,
  createDefaultMask,
  type AssetSource,
  type Mask,
  type ProjectGraph,
  type PluginEffectManifest,
  type PluginLookManifest,
  type PluginTransitionManifest,
  type RenderJob,
  type SourceAsset,
  type StockOrientation,
  type StockResult,
  type StockVariant,
  type TextWarp,
  type TextWarpStyle,
  type TimelineComposition,
  type TimelineCompositionSettings,
  type TimelineEffect,
  type TimelineEffectParamDefinition,
  type KeyframeInterpolation,
  type TimelineKeyframeV2,
  type TimelineLayer,
  type TimelineLayerType,
  type TimelineToolMode,
  type TimelineTrack,
  type ToolCapabilityDefinition,
  type TrackingPathArtifactData,
  type TransitionKind,
  type TransitionSpec
} from "@lumio-by-aelivion/shared";
import { AiActivityIndicator } from "../components/AiActivityIndicator";
import { AiChatPanel } from "../components/ai/AiChatPanel";
import type { ToolStepResult } from "../ai/executor/PlanExecutor";
import type { PlanStep } from "../ai/types";
import { NumberControl } from "../editor/inspector/controls/NumberControl";
import { ThemedSelect, type ThemedSelectGroup } from "../editor/inspector/controls/ThemedSelect";
import { InspectorHost } from "../editor/inspector/InspectorHost";
import type { MaskTool } from "../editor/registry/inspector";
import { recordMaskPoints } from "../editor/inspector/maskKeyframeUtils";
import { EffectMaskControls } from "../editor/inspector/EffectMaskControls";
import { InspectorSection } from "../editor/inspector/InspectorSection";
import { seedBuiltinRegistries } from "../editor";
import { getPreviewQualityProfile } from "../editor/performance/previewQuality";
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
import type { ProxyPlaybackHit } from "../components/ProxyPlaybackLayer";
import {
  applyAnimationPreset,
  getActiveEffectParamKeyframe,
  setEffectParamInterpolation,
  toggleEffectParamKeyframe,
  updateEffectParamAtTime,
  updatePositionKeyframesAtTime,
  updatePositionSpatialHandleAtTime,
  type AnimationPresetId
} from "../editor/inspector/keyframeUtils";
import { Badge } from "../components/Badge";
import { ColorWheels } from "../components/ColorWheels";
import { CurveEditor } from "../components/CurveEditor";
import { EffectSliderControl } from "../components/EffectSliderControl";
import { effectSliderTone } from "../components/effectSliderTone";
import { HueSatCurves } from "../components/HueSatCurves";
import { HslSecondary } from "../components/HslSecondary";
import { LutFileImport } from "../components/LutFileImport";
import { ColorScopes } from "../components/ColorScopes";
import { LumetriPanel } from "../components/LumetriPanel";
import { Button } from "../components/Button";
import { ColorControl } from "../components/ColorControl";
import { CreditBadge } from "../components/CreditBadge";
import { EmptyState } from "../components/EmptyState";
import { ResetButton } from "../components/ResetButton";
import { TimelineStrip } from "../components/TimelineStrip";
import { VideoPreview } from "../components/VideoPreview";
import { getPlaybackClock, setPlaybackClock, usePlaybackClock } from "../playback/playback-clock";
import { averageTrackConfidence, type SavedTrack } from "../lib/trackLibrary";
import {
  createAsset,
  cancelJob,
  createTemplate,
  deleteAsset,
  exportFinal,
  generatePreview,
  getProject,
  getRenderManifest,
  getStockStatus,
  importStock,
  listAssets,
  listPluginPackages,
  searchStock,
  STOCK_PAGE_SIZE,
  AuthRequiredError,
  type ProjectRecord,
  type StockProvider
} from "../lib/api";
import { getVideoPoster, useVideoPoster } from "../lib/videoThumbnails";
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
import { SyncBadge } from "../components/SyncBadge";
import { RelinkMediaModal } from "../components/RelinkMediaModal";
import { canExportLocally, exportLocally, saveExportedFile } from "../export/local-export";
import type { ExportFormat } from "../export/video-encoder";
import { Modal } from "../components/Modal";
import { AssetViewerModal, type AssetViewerTarget } from "../components/AssetViewerModal";
import { buildBackgroundColor, parseBackgroundColor } from "../lib/colorBackground";
import { defaultColorPalette, extractPaletteFromAsset } from "../lib/colorPalette";
import { useWheelScrollPerformance } from "../lib/useWheelScrollPerformance";
import {
  EMPTY_IMPORTED_PLUGIN_LIBRARY,
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
  backgroundColor: "rgba(8, 9, 13, 0.14)",
  backgroundPaddingEm: 0.08,
  backgroundRadiusEm: 0.1,
  shadowColor: "#000000",
  shadowBlur: 19,
  shadowOffsetX: 0,
  shadowOffsetY: 7,
  textWarp: defaultTextWarp
};
const defaultShapeStyle = {
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

/**
 * Transport time readout. Subscribes to the high-frequency playback clock directly so the number
 * stays smooth during playback WITHOUT re-rendering `EditorPage` every tick (the whole point of the
 * clock store). Falls back to the passed `currentTime` when paused/scrubbing.
 */
function PlayheadTimeReadout({ currentTime, isPlaying }: { currentTime: number; isPlaying: boolean }) {
  const time = usePlaybackClock(currentTime, isPlaying);
  return <span>{time.toFixed(2)}s</span>;
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
type EditorHistorySnapshot = {
  durationSeconds: number;
  projectGraph: ProjectGraph;
};

export function EditorPage() {
  // Ensure editor registries (inspector panels, modules, AI commands) are
  // populated before the inspector renders. Idempotent — safe every render.
  seedBuiltinRegistries();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("Saved");
  // Set when export needs missing media bytes re-selected (relink flow).
  const [relinkNeeds, setRelinkNeeds] = useState<RelinkAssetNeed[] | null>(null);
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
  const [currentTime, setCurrentTime] = useState(0);
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
  // Remember the last single-selected layer so the Controls tab keeps showing
  // its controls after the user deselects (better UX than collapsing to empty).
  const [lastInspectedLayerId, setLastInspectedLayerId] = useState<string | null>(null);
  // When set, the asset bin is in "pick a replacement" mode for this layer; tile
  // clicks swap the clip's asset instead of adding a new layer.
  const [assetPickerForLayerId, setAssetPickerForLayerId] = useState<string | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const templatePackageInputRef = useRef<HTMLInputElement | null>(null);
  const [backendPluginLibrary, setBackendPluginLibrary] = useState<ImportedPluginLibrary>(EMPTY_IMPORTED_PLUGIN_LIBRARY);
  const [hiddenEffectManifestIds, setHiddenEffectManifestIds] = useState<Set<string>>(() => loadHiddenEffectManifestIds());
  const [hiddenLookManifestIds, setHiddenLookManifestIds] = useState<Set<string>>(() => loadHiddenLookManifestIds());
  const [hiddenTransitionManifestIds, setHiddenTransitionManifestIds] = useState<Set<string>>(() => loadHiddenTransitionManifestIds());
  const [activeLayerToolEffect, setActiveLayerToolEffect] = useState<
    { tool: ToolCapabilityDefinition; layer: TimelineLayer; asset: SourceAsset } | undefined
  >(undefined);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackStart, setPlaybackStart] = useState<{ clockMs: number; timeSeconds: number } | null>(null);
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
  const proxyBlobStoreRef = useRef<ProxyBlobStore | null>(null);
  const proxyGenAbortRef = useRef<AbortController | null>(null);
  const proxyGenRunningRef = useRef(false);
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
  const proxyGenActive = proxyGenSupported && !livePlaybackMode;
  // Bumped to (re)kick background generation when nothing else in the dep list changed — e.g. after a
  // manual In/Out regenerate, which marks spans dirty without altering the composition reference.
  const [proxyGenNonce, setProxyGenNonce] = useState(0);
  const [leftPaneWidth, setLeftPaneWidth] = useState(() => readStoredNumber("lumio_editor_left_width", 420));
  const [rightPaneWidth, setRightPaneWidth] = useState(() => readStoredNumber("lumio_editor_right_width", 340));
  const [timelineHeight, setTimelineHeight] = useState(() => readStoredNumber("lumio_editor_timeline_height", 270));
  const [timelineTrackHeight, setTimelineTrackHeight] = useState(() => readStoredNumber("lumio_editor_track_height", 44));
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
  const zoomTo = useCallback((scale: number) => {
    setManualScale(scale);
    setViewMode("manual");
  }, []);
  useEffect(() => {
    localStorage.setItem("lumio_viewer_view_mode", viewMode);
  }, [viewMode]);
  const [imagePalette, setImagePalette] = useState(defaultColorPalette);
  const [historyVersion, setHistoryVersion] = useState(0);
  const currentTimeRef = useRef(currentTime);
  const playbackStartRef = useRef<{ clockMs: number; timeSeconds: number } | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const undoStackRef = useRef<EditorHistorySnapshot[]>([]);
  const redoStackRef = useRef<EditorHistorySnapshot[]>([]);
  const studioPanelRef = useRef<HTMLElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const viewerSectionRef = useRef<HTMLElement | null>(null);
  const [viewerFullscreen, setViewerFullscreen] = useState(false);

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
    void loadProject(0);
    listAssets().then(setAssets);
    // Kick connectivity: promotes any pending local draft (incl. this one) when online.
    void checkNow();
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryVersion((value) => value + 1);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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
      ...hydrateTransitionManifests(importedPluginLibrary.transitions)
    ];
    if (warnings.length) {
      console.warn("[plugins] import warnings", warnings);
    }
  }, [importedPluginLibrary.looks, importedPluginLibrary.transitions]);
  const composition = useMemo(
    () => (project && graph ? ensureComposition(graph, { name: project.title, durationSeconds: project.durationSeconds }) : undefined),
    [graph, project]
  );
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
  const renderNotice = getRenderNotice(activeRenderJob, latestFinalJob, notice);
  const creditEstimate = useMemo(
    () => (project && graph ? estimateCreditsForEffects(graph.effects, project.durationSeconds) : 0),
    [graph, project]
  );

  useEffect(() => {
    if (composition && currentTime > composition.durationSeconds) {
      setCurrentTime(composition.durationSeconds);
    }
    // During playback the rAF loop owns `currentTimeRef` (updated every frame to the live clock);
    // don't clobber it here with the throttled React value.
    if (!isPlaying) {
      currentTimeRef.current = currentTime;
    }
  }, [composition, currentTime, isPlaying]);

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

  useEffect(() => {
    if (!isPlaying || !composition) {
      // Leaving playback: flush the precise live clock back into React state so the cold path
      // (inspector, scopes, clip-under-playhead) lands exactly where playback stopped, not on the
      // last throttled low-rate commit.
      if (playbackStartRef.current) {
        const stopped = getPlaybackClock();
        currentTimeRef.current = stopped;
        setCurrentTime(stopped);
      }
      playbackStartRef.current = null;
      setPlaybackStart(null);
      return;
    }

    const started = { clockMs: performance.now(), timeSeconds: currentTimeRef.current };
    playbackStartRef.current = started;
    setPlaybackStart(started);
    setPlaybackClock(started.timeSeconds);
    let frame = 0;
    let lastClockCommitMs = 0;
    // The clock store drives the hot leaves (preview/transport/scopes) at the quality cadence.
    // React `currentTime` re-renders the whole editor, so the playback loop does not mirror it
    // while playing; stop/seek/end paths flush the exact time back into React state.

    const tick = (clockMs: number) => {
      const started = playbackStartRef.current;
      if (!started) {
        return;
      }

      // Wall-clock playhead. Playback smoothness for the PICTURE comes from native media playback (the live
      // <video> frame loop and — over ready spans — the proxy <video> substitution overlay), both of which
      // present off the main thread and stay in sync with real time. Keeping this clock real-time is what
      // holds the proxy <video> aligned with the playhead; clamping it would make a native proxy race ahead
      // and re-seek. (The overlay/playhead may momentarily lag the picture during a main-thread stall.)
      const nextTime = started.timeSeconds + (clockMs - started.clockMs) / 1000;
      currentTimeRef.current = nextTime; // always live for handlers reading the ref
      if (nextTime >= composition.durationSeconds) {
        setPlaybackClock(composition.durationSeconds);
        setCurrentTime(composition.durationSeconds);
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

  const updateProxyCacheRuler = useCallback(
    (targetRange?: TimelineInterval | undefined) => {
      if (!composition) {
        setProxyCacheSegments([]);
        setProxyCacheStatus(null);
        return;
      }
      const controller = getPreviewCacheController();
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
    },
    [composition, getPreviewCacheController, importedPluginSignature, previewQuality, paintProxyCacheState]
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
    if (!composition || isPlayingRef.current) {
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
      while (!isPlayingRef.current) {
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
          const blob = await generateSpanProxy({
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
          await store.put(span.id, blob);
          const url = await store.getObjectUrl(span.id);
          if (url) {
            controller.store.markSpanReady({
              id: span.id,
              signature: activeState.signature,
              contentSignature: span.contentSignature,
              url,
              byteSize: blob.size
            });
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

  useEffect(() => {
    localStorage.setItem("lumio_live_playback", livePlaybackMode ? "on" : "off");
  }, [livePlaybackMode]);

  // Release proxy storage when switching projects.
  useEffect(() => {
    return () => {
      proxyGenAbortRef.current?.abort();
      void proxyBlobStoreRef.current?.clear();
    };
  }, [composition?.id]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return;
      }
      const wantsModifierShortcut = event.ctrlKey || event.metaKey;
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
      // Playback transport (matches the viewer buttons): Space play/pause, Home/End jump, ← → step one frame.
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
        stepFrame(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        stepFrame(1);
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composition, isPlaying, project]);

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

  // Mask shortcuts: V = select tool, Esc = back to select, M = add a rectangle mask to the selected
  // media clip. (Delete stays on the inspector button in Phase 1 to avoid clashing with clip-delete.)
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
      if (event.key === "m" || event.key === "M") {
        const layer = selectedLayer;
        if (layer && (layer.type === "video" || layer.type === "image") && composition) {
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
    const updater = (layer: TimelineLayer): TimelineLayer => ({
      ...layer,
      transform: {
        // No upper cap on scale (Premiere-style: tiny → huge is the user's call). A small positive
        // floor only, so the layer can't collapse to a zero-size, ungrabbable point.
        ...layer.transform,
        scale: roundEditorNumber(Math.max(0.01, scale))
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
    const updater = (layer: TimelineLayer): TimelineLayer => ({
      ...layer,
      transform: {
        ...layer.transform,
        rotation: roundEditorNumber(normalizeRotation(rotation))
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

  async function handleMoveLayer(layerId: string, startSeconds: number, trackId?: string | undefined, movedLayerIds?: string[] | undefined) {
    if (!composition) {
      return;
    }

    const layer = layers.find((item) => item.id === layerId);
    if (layer && movedLayerIds?.length && movedLayerIds.length > 1) {
      const movedSet = new Set(movedLayerIds);
      const deltaSeconds = startSeconds - layer.startSeconds;
      await updateComposition({
        ...composition,
        tracks: composition.tracks.map((track) => ({
          ...track,
          layers: track.layers.map((item) => {
            if (!movedSet.has(item.id) || track.locked || item.locked) {
              return item;
            }

            return {
              ...item,
              startSeconds: Math.max(0, item.startSeconds + deltaSeconds)
            };
          })
        }))
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
        return { ...layer, startSeconds: nextStart, durationSeconds: clamp(durationSeconds, minDur, mediaDuration) };
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

      return {
        ...layer,
        startSeconds: Math.max(0, nextStart),
        durationSeconds: nextDuration,
        sourceInSeconds: nextSourceIn
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
  function handleToggleMarkerAtPlayhead() {
    if (!composition) {
      return;
    }
    const time = Number(currentTimeRef.current.toFixed(3));
    updateCompositionSettings((settings) => {
      const existing = settings.timeline.markers ?? [];
      const nearby = existing.find((marker) => Math.abs(marker - time) < 0.05);
      const nextMarkers = nearby !== undefined ? existing.filter((marker) => marker !== nearby) : [...existing, time].sort((a, b) => a - b);
      return { ...settings, timeline: { ...settings.timeline, markers: nextMarkers } };
    });
  }

  function handleRemoveMarker(markerTime: number) {
    updateCompositionSettings((settings) => ({
      ...settings,
      timeline: { ...settings.timeline, markers: (settings.timeline.markers ?? []).filter((marker) => marker !== markerTime) }
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
    const maxDuration = getLayerMaxDuration(layer, resolvedAssets, composition.durationSeconds);
    const clamped = clamp(Number(sourceInSeconds.toFixed(3)), 0, Math.max(0, maxDuration - layer.durationSeconds));
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

  function exportTimelineTemplatePackage() {
    if (!project || !graph || !composition) {
      setNotice("Open a timeline before exporting a template package");
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

  async function importTimelineTemplatePackage(file: File | undefined) {
    if (!file || !project) {
      return;
    }

    setBusy("template-package");
    try {
      const raw = JSON.parse(await file.text()) as unknown;
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

  async function handleAddLayer(type: TimelineLayerType) {
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

    const layer = createEditorLayer(type, track, composition, layers.length + 1, currentTime);
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
      const response = await fetch(asset.fileUrl);
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
    const url = asset?.proxyUrl ?? asset?.previewUrl ?? asset?.fileUrl;
    if (!asset || !url) {
      setNotice("Could not read the clip's frame");
      return;
    }
    setBusy("freeze-frame");
    try {
      const sourceSeconds = (layer.sourceInSeconds ?? 0) + Math.max(0, currentTime - layer.startSeconds);
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

    const trackId = findCompatibleTrackId(composition, asset, mode);
    if (!trackId) {
      setNotice("No compatible track");
      return;
    }

    await handleDropAsset(asset.id, trackId, currentTime, undefined, mode);
  }

  async function handleDropAsset(
    assetId: string,
    trackId: string,
    startSeconds: number,
    replaceLayerId?: string | undefined,
    mode: AssetAddMode = "auto"
  ) {
    if (!composition) {
      return;
    }

    const asset = resolvedAssets.find((item) => item.id === assetId);
    const track = composition.tracks.find((item) => item.id === trackId);
    if (!asset || !track) {
      return;
    }

    const assetLayerType: TimelineLayerType = mode === "audio"
      ? "audio"
      : asset.fileType.startsWith("audio/")
      ? "audio"
      : asset.fileType.startsWith("image/")
        ? "image"
        : "video";
    const addCompanionAudio = mode === "both" || (mode === "auto" && asset.fileType.startsWith("video/"));
    const isAudioAsset = assetLayerType === "audio";
    if (isAudioAsset !== (track.type === "audio")) {
      return;
    }

    if (replaceLayerId) {
      const replacedLayer = layers.find((layer) => layer.id === replaceLayerId);
      const nextDuration =
        assetLayerType === "image"
          ? (replacedLayer?.durationSeconds ?? 3)
          : Math.max(0.2, asset.durationSeconds);
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
                // A swapped-in asset must not inherit the previous clip's source
                // in-point - reset to play the new asset from its start.
                sourceInSeconds: undefined,
                fit: assetLayerType === "image" || assetLayerType === "video" ? (layer.fit ?? "cover") : undefined
              }
            : layer
        )
      }));
      const nextComposition =
        addCompanionAudio && assetLayerType === "video"
          ? addCompanionAudioLayer(
              { ...composition, tracks: nextTracks },
              asset,
              {
                id: replaceLayerId,
                startSeconds: replacedLayer?.startSeconds ?? startSeconds,
                durationSeconds: nextDuration
              },
              layers.length + 1
            )
          : { ...composition, tracks: nextTracks };
      await updateComposition(nextComposition);
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
          : Math.max(0.2, asset.durationSeconds),
      fit: assetLayerType === "image" || assetLayerType === "video" ? "cover" : undefined
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
        ? addCompanionAudioLayer(compositionWithLayer, asset, nextLayer, layers.length + 2)
        : compositionWithLayer;

    setSelectedLayerIds(expandLayerSelection([nextLayer.id]));
    await updateComposition(nextComposition);
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
    const layer = applyLookToLayer(createEditorLayer("adjustment", track, composition, layers.length + 1, currentTime), lookName);
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
    return flattenTimelineLayers(composition).filter(
      (layer) =>
        (layer.type === "video" || layer.type === "image" || layer.type === "text" || layer.type === "shape") &&
        !layer.muted &&
        currentTime >= layer.startSeconds &&
        currentTime <= layer.startSeconds + layer.durationSeconds
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

  /** Resize a fade band on the timeline — rewrites just that direction's transition keyframes. */
  function handleSetTransition(layerId: string, kind: TransitionKind, durationSeconds: number) {
    if (kind !== "fadeIn" && kind !== "fadeOut" && kind !== "crossDissolve") {
      return;
    }
    void updateLayer(layerId, (layer) => ({
      ...layer,
      animations: buildTransitionKeyframes(layer, kind as "fadeIn" | "fadeOut" | "crossDissolve", durationSeconds)
    }));
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
    const candidate =
      selectedLayer?.assetId
        ? selectedLayer
        : layers.find((layer) => layer.assetId && (layer.type === "video" || layer.type === "image"));
    const asset = candidate?.assetId ? resolvedAssets.find((item) => item.id === candidate.assetId) : undefined;
    if (!candidate || !asset) {
      return Promise.resolve({ applied: false, detail: "Select a clip with media for this tool, then retry." });
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
    try {
      const blob = await exportLocally({
        composition,
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
    setCurrentTime(stopped);
    setPlaybackStart(null);
    setIsPlaying(false);
  }

  function togglePlayback() {
    if (isPlayingRef.current) {
      pausePlaybackAtLiveClock();
      return;
    }
    setIsPlaying(true);
  }

  function stepFrame(direction: -1 | 1) {
    if (!composition) return;
    setEditorCurrentTime(Math.max(0, Math.min(composition.durationSeconds, currentTimeRef.current + direction / composition.fps)));
  }

  function setEditorCurrentTime(timeSeconds: number) {
    currentTimeRef.current = timeSeconds;
    if (isPlaying) {
      const started = { clockMs: performance.now(), timeSeconds };
      playbackStartRef.current = started;
      setPlaybackStart(started);
    }
    setPlaybackClock(timeSeconds);
    setCurrentTime(timeSeconds);
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

  function selectLayer(layerId?: string, mode: LayerSelectMode = "replace") {
    if (!layerId) {
      clearLayerSelection();
      return;
    }

    if (mode === "replace") {
      selectionAnchorRef.current = layerId;
      setSelectedLayerIds(expandLayerSelection([layerId]));
      return;
    }

    if (mode === "toggle") {
      selectionAnchorRef.current = layerId;
      setSelectedLayerIds((current) => {
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
      setSelectedLayerIds((current) => expandLayerSelection([...new Set([...current, ...rangeIds])]));
      return;
    }

    setSelectedLayerIds(expandLayerSelection(rangeIds));
  }

  function selectLayers(layerIds: string[], mode: LayerCollectionSelectMode = "replace") {
    if (mode === "replace") {
      selectionAnchorRef.current = layerIds[layerIds.length - 1] ?? null;
      setSelectedLayerIds(expandLayerSelection(layerIds));
      return;
    }

    if (mode === "add") {
      selectionAnchorRef.current = layerIds[layerIds.length - 1] ?? selectionAnchorRef.current;
      setSelectedLayerIds((current) => expandLayerSelection([...new Set([...current, ...layerIds])]));
      return;
    }

    selectionAnchorRef.current = layerIds[layerIds.length - 1] ?? selectionAnchorRef.current;
    setSelectedLayerIds((current) => {
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
    setSelectedLayerIds([]);
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
    setCurrentTime(layer.startSeconds);
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
    const move = (moveEvent: PointerEvent) => {
      setLeftPaneWidth(Math.round(clamp(moveEvent.clientX - rect.left, 280, Math.min(620, rect.width - 360))));
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
    const move = (moveEvent: PointerEvent) => {
      // Drag left = wider inspector; measure from the layout's right edge.
      setRightPaneWidth(Math.round(clamp(rect.right - moveEvent.clientX, 300, Math.min(560, rect.width - 420))));
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
    const move = (moveEvent: PointerEvent) => {
      setTimelineHeight(Math.round(clamp(rect.bottom - moveEvent.clientY, 180, Math.min(520, rect.height - 260))));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  if (!project || !graph || !composition) {
    return (
      <div className="page">
        <EmptyState title="Opening editor" body="Preparing the project graph." />
      </div>
    );
  }

  return (
    <div className={`editor-page${aiPanelOpen ? " is-ai-open" : ""}`}>
      <div className="editor-topbar">
        <div className="editor-titlebar">
          <Link to="/" className="editor-brand">
            Lumio
          </Link>
          <Badge tone="lime">{project.status}</Badge>
          <h1>{project.title}</h1>
        </div>
        <div className="editor-actions">
          {/* Single status slot: render progress while a job runs, otherwise the one save/sync badge. */}
          <div className="editor-status">
            {activeRenderJob ? <AiActivityIndicator label={renderNotice} /> : <SyncBadge projectId={project?.id} onRetry={retrySync} />}
          </div>
          <CreditBadge value={creditEstimate} />
          <Button
            variant={aiPanelOpen ? "primary" : "secondary"}
            icon={<Sparkles size={16} />}
            onClick={() => setAiPanelOpen((open) => !open)}
            aria-pressed={aiPanelOpen}
          >
            AI
          </Button>
          <span className="editor-actions-divider" aria-hidden="true" />
          {/* Document actions — icon-only with tooltips to keep the bar compact. */}
          <input
            ref={templatePackageInputRef}
            type="file"
            accept="application/json,.json,.lumio-template"
            className="effect-import-input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              void importTimelineTemplatePackage(file);
              event.currentTarget.value = "";
            }}
          />
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
            disabled={busy === "template-package" || !composition}
            onClick={exportTimelineTemplatePackage}
            aria-label="Export template package"
            title="Export template package"
          />
          <Button
            className="icon-only"
            variant="secondary"
            icon={<Upload size={16} />}
            disabled={busy === "template-package"}
            onClick={() => templatePackageInputRef.current?.click()}
            aria-label="Import template package"
            title="Import template package"
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
          <span className="editor-actions-divider" aria-hidden="true" />
          {localExportSupported ? (
            <Button
              className="icon-only"
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
          <Button icon={<Download size={16} />} disabled={busy === "export" || Boolean(activeRenderJob)} onClick={renderFinal}>
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
        </div>
      </div>
      {/* Transient action feedback — save/sync state lives in the status badge, so filter those out. */}
      {notice && notice !== "Saved" && notice !== "Unsaved" ? (
        <div className="editor-toast" key={notice} role="status">
          {notice}
        </div>
      ) : null}

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
        style={{ "--timeline-height": `${timelineHeight}px`, "--left-pane-width": `${leftPaneWidth}px`, "--right-pane-width": `${rightPaneWidth}px` } as CSSProperties}
      >
        <div className="editor-main" style={{ "--left-pane-width": `${leftPaneWidth}px`, "--right-pane-width": `${rightPaneWidth}px` } as CSSProperties}>
          {panelCollapsed ? (
            <button
              type="button"
              className="studio-reopen"
              title="Show panel"
              aria-label="Show panel"
              onClick={() => setPanelCollapsed(false)}
            >
              <PanelLeftOpen size={16} />
              <span>Panel</span>
            </button>
          ) : (
          <aside className="studio-panel scroll-performance-pane" ref={studioPanelRef}>
            <div className="studio-tabs">
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
                  className={`tabbar-icon-button ${panelExpanded ? "is-active" : ""}`}
                  type="button"
                  title={panelExpanded ? "Restore left panel height" : "Expand left panel — full height, timeline under the viewer"}
                  aria-label={panelExpanded ? "Restore left panel height" : "Expand left panel to full height"}
                  aria-pressed={panelExpanded}
                  onClick={() => setPanelExpanded((value) => !value)}
                >
                  {panelExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
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
                  onClick={() => setPanelCollapsed(true)}
                >
                  <PanelLeftClose size={15} />
                </button>
              </div>

              {panelTab === "assets" ? (
                <div className="panel-tab-content">
                  <AssetBin
                    assets={assets}
                    selectedAssetId={selectedLayer?.assetId}
                    usedCounts={getAssetUseCounts(layers)}
                    replaceActive={assetPickerForLayerId !== null}
                    onAssignAsset={handleAssignAsset}
                    onAddAssetToTimeline={handleAddAssetToTimeline}
                    onPickReplacement={handlePickReplacement}
                    onCancelReplace={() => setAssetPickerForLayerId(null)}
                    onDeleteAsset={handleDeleteAsset}
                    onFocusAssetUse={(assetId) => focusAssetUse(assetId, layers)}
                    onUploadAsset={handleUploadAsset}
                    onImportedAsset={registerAsset}
                    onUploadToCloud={handleUploadAssetToCloud}
                  />
                </div>
              ) : panelTab === "effects" ? (
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
                      {scopesOpen && (
                        <ColorScopes containerRef={previewFrameRef} tick={Math.round(currentTime * 30)} />
                      )}
                      <LumetriPanel
                        layer={inspectorLayer}
                        currentTime={currentTime}
                        onChange={(updater) => updateLayer(inspectorLayer.id, updater)}
                      />
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

          <section className="editor-viewer" ref={viewerSectionRef}>
            <VideoPreview
              graph={graph}
              composition={composition}
              currentTime={currentTime}
              isPlaying={isPlaying}
              previewQuality={previewQuality}
              viewMode={viewMode}
              manualScale={manualScale}
              assets={assets}
              selectedLayerId={selectedLayer?.id}
              frameRef={previewFrameRef}
              onFitScale={setFitScale}
              onZoomTo={zoomTo}
              onSaveFreezeFrame={() => void handleSaveFreezeFrame()}
              onMoveLayer={handlePreviewMoveLayer}
              onMovePositionKeyframe={handlePreviewMovePositionKeyframe}
              onMoveSpatialHandle={handlePreviewMoveSpatialHandle}
              onResizeShapeLayer={handlePreviewResizeShapeLayer}
              onRotateLayer={handlePreviewRotateLayer}
              onScaleLayer={handlePreviewScaleLayer}
              resolveProxyPlayback={resolveProxyPlayback}
              onPreviewFrameRendered={handlePreviewFrameRendered}
              onSelectLayer={selectLayer}
              sourceAsset={project.sourceAsset}
              maskTool={maskTool}
              onChangeMaskTool={changeMaskTool}
              activeMaskId={activeMaskId ?? undefined}
              onSelectMask={setActiveMaskId}
              showMasks={showMasks}
              onToggleShowMasks={() => setShowMasks((value) => !value)}
              maskEffectId={activeMaskEffectId}
              onPreviewMaskScalar={handlePreviewMaskScalar}
              onUpdateLayerMasks={(layerId, updater) =>
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
              }
              onCommitMaskPoints={(layerId, maskId, points) =>
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
                    : recordMaskPoints(current, maskId, Math.max(0, currentTime - current.startSeconds), points)
                )
              }
            />
            <div className="viewer-controls" aria-label="Viewer controls">
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
              <PlayheadTimeReadout currentTime={currentTime} isPlaying={isPlaying} />
              <div className="preview-quality-control" aria-label="Playback resolution">
                {(["quality", "balanced", "performance"] as const).map((quality) => (
                  <button
                    className={previewQuality === quality ? "is-active" : ""}
                    key={quality}
                    type="button"
                    title={`${previewQualityLabel(quality)} playback resolution`}
                    onClick={() => setPreviewQuality(quality)}
                  >
                    {quality === "performance" ? "¼" : quality === "balanced" ? "½" : "1"}
                  </button>
                ))}
              </div>
              <label className="viewer-zoom-control" title="Viewer zoom">
                <input
                  type="range"
                  min={0.1}
                  max={8}
                  step={0.01}
                  value={viewMode === "fit" ? fitScale : manualScale}
                  onChange={(event) => zoomTo(Number(event.target.value))}
                />
                <small>{Math.round((viewMode === "fit" ? fitScale : manualScale) * 100)}%</small>
                <span className="zoom-preset-buttons" aria-label="Viewer zoom presets">
                  <button className={viewMode === "fit" ? "is-active" : ""} type="button" title="Fit to viewer (auto-tracks panel resizes)" onClick={() => setViewMode("fit")}>
                    Fit
                  </button>
                  {/* Percentages are actual pixels (100% = 1 comp px : 1 screen px), Premiere-style. */}
                  {[0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((scale) => (
                    <button
                      className={viewMode === "manual" && Math.abs(manualScale - scale) < 0.005 ? "is-active" : ""}
                      key={scale}
                      title={`${Math.round(scale * 100)}% (actual pixels)`}
                      type="button"
                      onClick={() => zoomTo(scale)}
                    >
                      {Math.round(scale * 100)}
                    </button>
                  ))}
                </span>
              </label>
            </div>
          </section>

          <div className="pane-resizer pane-resizer-vertical pane-resizer-right" role="separator" aria-orientation="vertical" onPointerDown={startRightPaneResize} />

          {inspectorCollapsed ? (
            <button
              type="button"
              className="inspector-reopen"
              title="Show Inspector"
              aria-label="Show Inspector"
              onClick={() => setInspectorCollapsed(false)}
            >
              <PanelRightOpen size={16} />
              <span>Inspector</span>
            </button>
          ) : (
          <aside className="editor-inspector scroll-performance-pane" aria-label="Inspector">
            <div className="inspector-head">
              <h2>Inspector</h2>
              {inspectorLayer ? (
                <span className="inspector-head-badge">
                  <Badge tone="muted">{inspectorLayer.type.toUpperCase()}</Badge>
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
                  className={inspectorExpanded ? "is-active" : ""}
                  title={inspectorExpanded ? "Restore inspector height" : "Expand inspector — full height"}
                  aria-label={inspectorExpanded ? "Restore inspector height" : "Expand inspector to full height"}
                  aria-pressed={inspectorExpanded}
                  onClick={() => setInspectorExpanded((value) => !value)}
                >
                  {inspectorExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
                <button
                  type="button"
                  title="Collapse Inspector"
                  aria-label="Collapse Inspector"
                  onClick={() => setInspectorCollapsed(true)}
                >
                  <PanelRightClose size={14} />
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
                <TemplateSlotControl layer={inspectorLayer} onChange={(updater) => updateLayer(inspectorLayer.id, updater)} />
                <LayerInspector
                  assets={assets}
                  palette={imagePalette}
                  hideAssetBin
                  layer={inspectorLayer}
                  composition={composition}
                  currentTime={currentTime}
                  tracks={trackLibrary}
                  onAssignAsset={handleAssignAsset}
                  onAttachTrack={(trackId) => handleAttachSavedTrack(trackId, inspectorLayer.id)}
                  onDeleteAsset={handleDeleteAsset}
                  onChange={(updater) => updateLayer(inspectorLayer.id, updater)}
                  onEditTrack={(trackId) => setTrackModalState({ editingTrackId: trackId })}
                  onOpenTrackModal={() => {
                    if (!mainTrackableAsset) {
                      setNotice("Add a video or image clip to the timeline first");
                      return;
                    }
                    setTrackModalState({});
                  }}
                  onRemoveTrack={handleRemoveTrack}
                  onSeek={setEditorCurrentTime}
                  onUploadAsset={handleUploadAsset}
                  activeMaskId={activeMaskId ?? undefined}
                  onSelectMask={(maskId) => {
                    setActiveMaskEffectId(null);
                    setActiveMaskId(maskId);
                  }}
                  onSelectEffectMask={(effectId, maskId) => {
                    setActiveMaskEffectId(effectId);
                    setActiveMaskId(maskId);
                  }}
                  onChangeMaskTool={changeMaskTool}
                />
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

        <section className="editor-timeline-dock">
          <TimelineStrip
            assets={resolvedAssets}
            composition={composition}
            currentTime={currentTime}
            isPlaying={isPlaying}
            layerMaxDurations={layerMaxDurations}
            playbackStart={playbackStart}
            selectedLayerId={selectedLayer?.id}
            selectedLayerIds={selectedLayerIds}
            trackHeight={timelineTrackHeight}
            onChangeCurrentTime={setEditorCurrentTime}
            onChangeTrackHeight={(height) => setTimelineTrackHeight(clamp(height, 18, 76))}
            canUndo={historyVersion >= 0 && undoStackRef.current.length > 0}
            canRedo={historyVersion >= 0 && redoStackRef.current.length > 0}
            onUndo={() => {
              void undo();
            }}
            onRedo={() => {
              void redo();
            }}
            onClearSelection={clearLayerSelection}
            onDeleteTrack={handleDeleteTrack}
            onDeleteLayer={handleDeleteLayer}
            onDeleteKeyframe={(layerId, keyframeId) => {
              void handleDeleteKeyframe(layerId, keyframeId);
              setNotice("Keyframe deleted");
            }}
            onAddLayer={handleAddLayer}
            onAddTrack={handleAddTrack}
            onDropAsset={handleDropAsset}
            onDropTimelineEffect={(effectType, layerId) => {
              void updateLayer(layerId, (layer) => ({
                ...layer,
                effects: [...layer.effects, createTimelineEffect(effectType)]
              }));
              selectLayer(layerId);
              focusInspector();
              setNotice("Effect added");
            }}
            onLinkSelectedLayers={handleLinkSelectedLayers}
            onDeleteSelectedLayers={() => {
              void handleDeleteLayers(selectedLayerIds);
            }}
            onMoveLayer={handleMoveLayer}
            onMoveKeyframe={(layerId, keyframeId, timeSeconds) => {
              void handleMoveKeyframe(layerId, keyframeId, timeSeconds);
              setNotice("Keyframe moved");
            }}
            onSetTransition={handleSetTransition}
            onRemoveTransition={handleRemoveTransition}
            onAddCrossDissolve={handleAddCrossDissolve}
            onSetCrossDissolve={handleSetCrossDissolve}
            onRemoveCrossDissolve={handleRemoveCrossDissolve}
            onResizeLayer={handleResizeLayer}
            onSelectLayer={selectLayer}
            onSelectLayers={selectLayers}
            onToggleTrack={handleToggleTrack}
            onUnlinkLayer={handleUnlinkLayer}
            onUnlinkSelectedLayers={handleUnlinkSelectedLayers}
            toolMode={timelineTool}
            onChangeToolMode={setTimelineTool}
            snapEnabled={snapEnabled}
            onToggleSnap={() => setSnapEnabled((value) => !value)}
            onSplitLayerAt={(layerId, atSeconds) => {
              void handleSplitLayerAt(layerId, atSeconds);
            }}
            onSplitAtPlayhead={() => {
              void handleSplitAtPlayhead();
            }}
            onRippleDeleteLayer={(layerId) => {
              void handleRippleDeleteLayer(layerId);
            }}
            onDuplicateLayer={(layerId) => {
              void handleDuplicateLayer(layerId);
            }}
            markers={composition.settings?.timeline.markers ?? []}
            onToggleMarkerAtPlayhead={handleToggleMarkerAtPlayhead}
            onRemoveMarker={handleRemoveMarker}
            inPointSeconds={composition.settings?.timeline.inPointSeconds ?? undefined}
            outPointSeconds={composition.settings?.timeline.outPointSeconds ?? undefined}
            onSetInPoint={handleSetInPoint}
            onSetOutPoint={handleSetOutPoint}
            onClearInPoint={handleClearInPoint}
            onClearOutPoint={handleClearOutPoint}
            onClearInOutPoints={handleClearInOutPoints}
            proxyCacheSegments={proxyCacheSegments}
            proxyCacheStatus={proxyCacheStatus ?? undefined}
            onRegenerateProxyCache={handleRegenerateProxyCache}
            livePlaybackMode={livePlaybackMode}
            onToggleLivePlayback={setLivePlaybackMode}
            onReplaceLayerAsset={handleReplaceLayerAsset}
            onSlipLayer={handleSlipLayer}
            onPreviewVolume={handlePreviewLayer}
          />
        </section>
      </div>
      {aiPanelOpen && composition ? (
        <aside className="ai-dock" aria-label="AI">
          <AiChatPanel
            getContext={() => ({ composition, selection: selectedLayerIds, nowSeconds: currentTime })}
            commitComposition={(after) => updateComposition(after)}
            openTool={openToolForAi}
            onUndo={() => undo()}
            onClose={() => setAiPanelOpen(false)}
            {...(projectId ? { projectId } : {})}
          />
        </aside>
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
      <RelinkMediaModal
        open={relinkNeeds !== null}
        assets={relinkNeeds ?? []}
        onClose={() => setRelinkNeeds(null)}
        onResolved={() => {
          setRelinkNeeds(null);
          void renderFinal();
        }}
      />
      {exportDialogOpen && composition
        ? (() => {
            const projFps = composition.fps || 30;
            const choices = Array.from(new Set([projFps, 23.976, 24, 25, 29.97, 30, 50, 60])).sort((a, b) => a - b);
            const fmtFps = (f: number) => (f % 1 === 0 ? String(f) : f.toFixed(3));
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
  );
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

function createEditorLayer(
  type: TimelineLayerType,
  track: TimelineTrack,
  composition: TimelineComposition,
  index: number,
  startAtSeconds?: number
): TimelineLayer {
  const id = `layer_${Date.now()}_${index}`;
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
    fit: type === "image" || type === "video" ? "cover" : undefined,
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
      ...defaultShapeStyle,
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
      return Math.max(0.2, asset.durationSeconds);
    }
  }

  return compositionDuration;
}

function addCompanionAudioLayer(
  composition: TimelineComposition,
  asset: SourceAsset,
  visualLayer: Pick<TimelineLayer, "id" | "startSeconds" | "durationSeconds">,
  index: number
) {
  if (!asset.fileType.startsWith("video/")) {
    return composition;
  }

  const existingAudio = flattenTimelineLayers(composition).find(
    (layer) => layer.type === "audio" && layer.assetId === asset.id && Math.abs(layer.startSeconds - visualLayer.startSeconds) < 0.01
  );
  if (existingAudio) {
    return composition;
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
    durationSeconds: Math.max(0.2, Math.min(asset.durationSeconds, visualLayer.durationSeconds))
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

function findCompatibleTrackId(composition: TimelineComposition, asset: SourceAsset, mode: AssetAddMode = "auto") {
  const wantsAudio = mode === "audio" || (mode === "auto" && asset.fileType.startsWith("audio/"));
  return (
    composition.tracks.find((track) => (wantsAudio ? track.type === "audio" : track.type !== "audio"))?.id ??
    composition.tracks[0]?.id ??
    ""
  );
}

function readMediaMetadata(file: File) {
  if (file.type.startsWith("video/")) {
    return new Promise<{ durationSeconds: number; width: number; height: number }>((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      const done = (duration: number) => {
        URL.revokeObjectURL(url);
        resolve({
          // The REAL fractional duration — never rounded up. A too-long clip freezes on the last frame
          // for the overshoot; a finite-but-default 12s on a short clip is the worst case (a long freeze).
          durationSeconds: clamp(Number.isFinite(duration) && duration > 0 ? duration : 12, 0.2, 7200),
          width: Math.max(320, video.videoWidth || 1080),
          height: Math.max(320, video.videoHeight || 1920)
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
    return new Promise<{ durationSeconds: number; width: number; height: number }>((resolve) => {
      const url = URL.createObjectURL(file);
      const image = new window.Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve({
          durationSeconds: 3,
          width: Math.max(320, image.naturalWidth || 1080),
          height: Math.max(320, image.naturalHeight || 1920)
        });
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ durationSeconds: 3, width: 1080, height: 1920 });
      };
      image.src = url;
    });
  }

  if (file.type.startsWith("audio/")) {
    return new Promise<{ durationSeconds: number; width: number; height: number }>((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve({
          durationSeconds: clamp(Number.isFinite(audio.duration) ? audio.duration : 12, 0.2, 7200),
          width: 1080,
          height: 1920
        });
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ durationSeconds: 12, width: 1080, height: 1920 });
      };
      audio.src = url;
    });
  }

  return Promise.resolve({ durationSeconds: 12, width: 1080, height: 1920 });
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
        <input
          max={max}
          min={min}
          step={step}
          type="number"
          value={Number.isInteger(value) ? value : Number(value.toFixed(2))}
          onChange={(event) => onChange(clamp(Number(event.target.value), min, max))}
        />
        {suffix ? <small>{suffix}</small> : null}
      </div>
    </label>
  );
}

type AssetSourceTab = "local" | "ai" | "stock" | "brand" | "used";
type AssetTypeFilter = "all" | "video" | "image" | "audio" | "graphics";

/** Upload metadata so a tab can tag what it creates (e.g. Brand uploads). */
type AssetUploadOptions = { source?: AssetSource; folder?: string };

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
  pexels: "Pexels",
  pixabay: "Pixabay",
  unsplash: "Unsplash",
  "timeline-generated": "Generated",
  brand: "Brand"
};

function matchesAssetTab(asset: SourceAsset, tab: AssetSourceTab, used: boolean): boolean {
  const source = assetSourceOf(asset);
  switch (tab) {
    case "local":
      return source === "local";
    case "ai":
      return source === "ai" || source === "timeline-generated";
    case "brand":
      return source === "brand";
    case "stock":
      return source === "pexels" || source === "pixabay" || source === "unsplash";
    case "used":
      return used;
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

function formatAssetMeta(asset: SourceAsset): string {
  const parts: string[] = [];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (assetKind(asset) !== "image" && asset.durationSeconds) parts.push(`${Math.round(asset.durationSeconds)}s`);
  return parts.join(" · ");
}

const ASSET_TABS: { id: AssetSourceTab; label: string; icon: ReactNode }[] = [
  { id: "local", label: "Local", icon: <FolderClosedIcon /> },
  { id: "ai", label: "AI", icon: <Sparkles size={13} /> },
  { id: "stock", label: "Stock", icon: <Globe size={13} /> },
  { id: "brand", label: "Brand", icon: <Palette size={13} /> },
  { id: "used", label: "Used", icon: <Layers size={13} /> }
];

function FolderClosedIcon() {
  return <Film size={13} />;
}

type AssetKind = ReturnType<typeof assetKind>;

/** Small icon standing in for the asset type (replaces the old "Video"/"Audio" text badge). */
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

const STOCK_TYPE_GROUPS: ThemedSelectGroup<"image" | "video">[] = [
  { label: "Type", options: [{ value: "image", label: "Photos" }, { value: "video", label: "Videos" }] }
];

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
  return (
    <div
      className="asset-card-media"
      style={style}
      onMouseEnter={() => {
        if (prefersReducedMotion()) return;
        setHovering(true);
      }}
      onMouseLeave={() => setHovering(false)}
    >
      {hovering ? (
        <video
          ref={videoRef}
          src={videoSrc}
          poster={posterSrc}
          muted
          loop
          autoPlay
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
    </div>
  );
}

/**
 * Stock result thumbnail. Videos hover-play a lightweight preview variant (preload="none" so we
 * only fetch bytes on hover), letting the user see the footage before importing.
 */
function StockCardMedia({ result }: { result: StockResult }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ratio = result.width && result.height ? result.width / result.height : result.type === "video" ? 16 / 9 : 1;
  const style = { "--asset-ar": ratio } as CSSProperties;

  if (result.type === "video" && result.previewUrl) {
    return (
      <div
        className="asset-card-media"
        style={style}
        onMouseEnter={() => {
          if (prefersReducedMotion()) return;
          void videoRef.current?.play().catch(() => {});
        }}
        onMouseLeave={() => {
          const video = videoRef.current;
          if (!video) return;
          video.pause();
          try {
            video.currentTime = 0;
          } catch {
            /* ignore seek errors before load */
          }
        }}
      >
        <video ref={videoRef} src={result.previewUrl} poster={result.thumbnailUrl} muted loop playsInline preload="none" />
      </div>
    );
  }

  return (
    <div className="asset-card-media" style={style}>
      <img src={result.thumbnailUrl} alt="" loading="lazy" />
    </div>
  );
}

function AssetBin({
  assets,
  selectedAssetId,
  usedCounts = {},
  replaceActive = false,
  onAssignAsset,
  onAddAssetToTimeline,
  onPickReplacement,
  onCancelReplace,
  onDeleteAsset,
  onFocusAssetUse,
  onUploadAsset,
  onImportedAsset,
  onUploadToCloud
}: {
  assets: SourceAsset[];
  selectedAssetId?: string | undefined;
  usedCounts?: Record<string, number>;
  replaceActive?: boolean;
  onAssignAsset: (asset: SourceAsset) => void;
  onAddAssetToTimeline?: (asset: SourceAsset, mode?: AssetAddMode) => void;
  onPickReplacement?: (asset: SourceAsset) => void;
  onCancelReplace?: () => void;
  onDeleteAsset?: ((asset: SourceAsset) => void) | undefined;
  onFocusAssetUse?: (assetId: string) => void;
  onUploadAsset: (file: File | null, options?: AssetUploadOptions) => void;
  onImportedAsset?: (asset: SourceAsset) => void;
  onUploadToCloud?: ((asset: SourceAsset) => void) | undefined;
}) {
  const handleTileActivate = (asset: SourceAsset) => {
    if (replaceActive) {
      onPickReplacement?.(asset);
      return;
    }
    onAssignAsset(asset);
  };
  const [query, setQuery] = useState("");
  const [sourceTab, setSourceTab] = useState<AssetSourceTab>(() =>
    readStoredChoice("lumio_asset_tab", "local", ["local", "ai", "stock", "brand", "used"] as const)
  );
  const [filter, setFilter] = useState<AssetTypeFilter>(() =>
    readStoredChoice("lumio_asset_filter", "all", ["all", "video", "image", "audio", "graphics"] as const)
  );
  const [view, setView] = useState<"tiles" | "list">(() => readStoredChoice("lumio_asset_view", "tiles", ["tiles", "list"] as const));
  const [size, setSize] = useState<"small" | "medium" | "large">(() =>
    readStoredChoice("lumio_asset_size", "medium", ["small", "medium", "large"] as const)
  );
  const [menuAssetId, setMenuAssetId] = useState<string | null>(null);

  // --- Stock state ---
  const [stockProvider, setStockProvider] = useState<StockProvider>("pexels");
  const [stockType, setStockType] = useState<"image" | "video">("image");
  const [stockOrientation, setStockOrientation] = useState<StockOrientation>(() =>
    readStoredChoice("lumio_stock_orientation", "all", ["all", "horizontal", "vertical", "square"] as const)
  );
  const [stockQuality, setStockQuality] = useState<StockQuality>(() =>
    readStoredChoice("lumio_stock_quality", "highest", ["highest", "4k", "1080p", "720p", "sd"] as const)
  );
  const [stockStatus, setStockStatus] = useState<Record<StockProvider, boolean> | null>(null);
  const [stockResults, setStockResults] = useState<StockResult[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockPage, setStockPage] = useState(1);
  const [stockHasMore, setStockHasMore] = useState(false);
  const [stockLoadingMore, setStockLoadingMore] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  // Asset viewer modal — opened by double-clicking a library asset or a stock result.
  const [viewerTarget, setViewerTarget] = useState<AssetViewerTarget | null>(null);

  const filteredAssets = assets.filter(
    (asset) =>
      matchesAssetTab(asset, sourceTab, Boolean(usedCounts[asset.id])) &&
      matchesTypeFilter(asset, filter) &&
      (asset.originalName ?? asset.fileName).toLowerCase().includes(query.trim().toLowerCase())
  );

  useEffect(() => {
    localStorage.setItem("lumio_asset_tab", sourceTab);
  }, [sourceTab]);

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

  // Probe which stock providers have keys configured (once the Stock tab is opened).
  useEffect(() => {
    if (sourceTab !== "stock" || stockStatus) return;
    void getStockStatus().then(setStockStatus);
  }, [sourceTab, stockStatus]);

  // Debounced stock search (page 1) against the active provider / type / orientation.
  useEffect(() => {
    if (sourceTab !== "stock") return;
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
      void searchStock(stockProvider, trimmed, stockType, 1, stockOrientation)
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
  }, [sourceTab, query, stockProvider, stockType, stockOrientation]);

  async function handleLoadMoreStock() {
    const trimmed = query.trim();
    if (!trimmed || stockLoadingMore) return;
    const nextPage = stockPage + 1;
    setStockLoadingMore(true);
    try {
      const data = await searchStock(stockProvider, trimmed, stockType, nextPage, stockOrientation);
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
    try {
      const asset = await importStock(result, variant ?? pickStockVariant(result, stockQuality));
      onImportedAsset?.(asset);
      // If the viewer was importing this result, close it once it lands in the library.
      setViewerTarget((current) => (current?.kind === "stock" && current.result.externalId === result.externalId ? null : current));
    } catch {
      /* surfaced by the caller's notice channel if needed */
    } finally {
      setImportingId(null);
    }
  }

  const stockConfigured = stockStatus ? stockStatus[stockProvider] : true;
  const uploadSource: AssetUploadOptions | undefined = sourceTab === "brand" ? { source: "brand", folder: "brand" } : undefined;
  const showUpload = sourceTab === "local" || sourceTab === "brand";

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

  return (
    <div className={`asset-bin asset-bin-${view} asset-bin-${size} ${replaceActive ? "is-replace-mode" : ""}`}>
      <div className="asset-bin-tabs" role="tablist" aria-label="Asset library">
        {ASSET_TABS.map((tab) => (
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
      {sourceTab === "stock" ? (
        <div className="asset-stock-controls">
          <div className="asset-subtabs" role="tablist" aria-label="Stock provider">
            {(["pexels", "pixabay"] as const).map((provider) => (
              <button
                key={provider}
                type="button"
                className={stockProvider === provider ? "is-active" : ""}
                onClick={() => setStockProvider(provider)}
              >
                {provider === "pexels" ? "Pexels" : "Pixabay"}
              </button>
            ))}
          </div>
          {/* Photos/Videos dropdown sits to the left of the search, Pexels-style. */}
          <div className="asset-search asset-search-with-type">
            <div className="asset-search-type">
              <ThemedSelect ariaLabel="Stock media type" value={stockType} groups={STOCK_TYPE_GROUPS} onChange={setStockType} />
            </div>
            <Search size={13} />
            <input placeholder={`Search ${stockProvider}…`} value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="asset-stock-filters">
            <div className="asset-stock-filter">
              <ThemedSelect ariaLabel="Orientation" value={stockOrientation} groups={STOCK_ORIENTATION_GROUPS} onChange={setStockOrientation} />
            </div>
            <div className="asset-stock-filter">
              <ThemedSelect ariaLabel="Import quality" value={stockQuality} groups={STOCK_QUALITY_GROUPS} onChange={setStockQuality} />
            </div>
            {viewControls}
          </div>
        </div>
      ) : (
        <div className="asset-bin-controls">
          <div className="asset-bin-controls-top">
            <div className="asset-search">
              <Search size={13} />
              <input placeholder="Search assets" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            {showUpload ? (
              <label className="asset-upload-button" title={sourceTab === "brand" ? "Upload brand asset" : "Upload media"}>
                <input
                  accept="video/*,image/*,audio/*"
                  type="file"
                  onChange={(event) => onUploadAsset(event.currentTarget.files?.[0] ?? null, uploadSource)}
                />
                <Download size={13} /> Upload
              </label>
            ) : null}
          </div>
          <div className="asset-control-strip">
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
        </div>
      )}
      {sourceTab === "stock" && !stockConfigured ? (
        <div className="asset-empty-state">
          <Globe size={18} />
          <strong>{stockProvider === "pexels" ? "Pexels" : "Pixabay"} not connected</strong>
          <span>
            Add {stockProvider === "pexels" ? "PEXELS_API_KEY" : "PIXABAY_API_KEY"} to your .env to search and import
            stock {stockType === "image" ? "photos" : "videos"}.
          </span>
        </div>
      ) : sourceTab === "stock" && query.trim() ? (
        <div className="asset-grid">
          {stockLoading ? (
            <div className="empty-mini">Searching {stockProvider}…</div>
          ) : stockResults.length ? (
            stockResults.map((result) => (
              <div
                className="asset-tile asset-stock-tile"
                key={`${result.provider}_${result.externalId}`}
                title={result.author ? `By ${result.author}` : result.provider}
                role="button"
                tabIndex={0}
                onDoubleClick={() => setViewerTarget({ kind: "stock", result })}
              >
                <StockCardMedia result={result} />
                <span className="asset-type-chip" title={result.type}>
                  {result.type === "video" ? <Film size={11} /> : <Image size={11} />}
                </span>
                <span className={`asset-badge asset-badge-source asset-badge-${result.provider}`} title={result.provider}>
                  {result.provider === "pexels" ? "Pexels" : "Pixabay"}
                </span>
                {result.width && result.height ? (
                  <span className="asset-chip asset-chip-duration">{result.width}×{result.height}</span>
                ) : null}
                <div className="asset-card-hover">
                  <div className="asset-card-info">
                    <strong>{result.author ?? result.provider}</strong>
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
      ) : (
        <div className="asset-grid">
          {filteredAssets.length ? (
            filteredAssets.map((asset) => {
              const source = assetSourceOf(asset);
              const kind = assetKind(asset);
              const meta = formatAssetMeta(asset);
              const isLocalOnly = asset.fileUrl.startsWith("localblob:") || (!asset.cloudUrl && asset.id.startsWith("asset_local_"));
              const used = usedCounts[asset.id] ?? 0;
              const durationLabel =
                (kind === "video" || kind === "audio") && asset.durationSeconds ? `${Math.round(asset.durationSeconds)}s` : null;
              return (
                <div
                  className={`asset-tile asset-tile-${kind} ${selectedAssetId === asset.id ? "is-selected" : ""}`}
                  draggable
                  key={asset.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleTileActivate(asset)}
                  onDoubleClick={() => (replaceActive ? onPickReplacement?.(asset) : setViewerTarget({ kind: "asset", asset }))}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-lumio-asset", asset.id);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleTileActivate(asset);
                    }
                  }}
                  title={asset.originalName ?? asset.fileName}
                >
                  <AssetCardMedia asset={asset} kind={kind} />
                  <span className="asset-type-chip" title={kind}>
                    {assetTypeIcon(kind)}
                  </span>
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
                          <button type="button" title="Add video only" onClick={(event) => { event.stopPropagation(); onAddAssetToTimeline?.(asset, "video"); }}>
                            <Film size={14} />
                          </button>
                          <button type="button" title="Add audio only" onClick={(event) => { event.stopPropagation(); onAddAssetToTimeline?.(asset, "audio"); }}>
                            <Music size={14} />
                          </button>
                          <button type="button" title="Add linked video + audio" onClick={(event) => { event.stopPropagation(); onAddAssetToTimeline?.(asset, "both"); }}>
                            <Layers size={14} />
                          </button>
                        </>
                      ) : (
                        <button type="button" title="Add to timeline" onClick={(event) => { event.stopPropagation(); onAddAssetToTimeline?.(asset, "auto"); }}>
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
                      {onUploadToCloud && isLocalOnly ? (
                        <button type="button" onClick={() => { setMenuAssetId(null); onUploadToCloud(asset); }}>
                          <CloudUpload size={13} /> Upload to cloud
                        </button>
                      ) : asset.cloudUrl ? (
                        <span className="asset-tile-menu-note">
                          <Cloud size={13} /> In cloud
                        </span>
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
            })
          ) : (
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
          )}
        </div>
      )}
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


function LayerInspector({
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
  activeMaskId,
  onSelectMask,
  onChangeMaskTool,
  onSelectEffectMask
}: {
  assets: SourceAsset[];
  palette: string[];
  hideAssetBin?: boolean;
  layer: TimelineLayer;
  composition: TimelineComposition;
  currentTime: number;
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
  activeMaskId?: string | undefined;
  onSelectMask?: ((maskId: string | null) => void) | undefined;
  onChangeMaskTool?: ((tool: MaskTool) => void) | undefined;
  onSelectEffectMask?: ((effectId: string, maskId: string | null) => void) | undefined;
}) {
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);
  const [dragEffectId, setDragEffectId] = useState<string | null>(null);
  const [dragOverEffectId, setDragOverEffectId] = useState<string | null>(null);

  return (
    <div className="inspector-panel">
      {!hideAssetBin && (layer.type === "video" || layer.type === "image") ? (
        <AssetBin assets={assets} selectedAssetId={layer.assetId} onAssignAsset={onAssignAsset} onDeleteAsset={onDeleteAsset} onUploadAsset={onUploadAsset} />
      ) : null}

      {layer.type === "text" ? <TextGraphicControls layer={layer} palette={palette} onChange={onChange} /> : null}
      {layer.type === "shape" ? <ShapeGraphicControls layer={layer} palette={palette} onChange={onChange} /> : null}

      <InspectorHost
        layer={layer}
        onChange={onChange}
        panelIds={["transform"]}
        currentTime={currentTime}
        onSeek={onSeek}
      />

      {layer.type === "video" || layer.type === "image" ? (
        <InspectorHost layer={layer} onChange={onChange} panelIds={["content"]} currentTime={currentTime} onSeek={onSeek} />
      ) : null}

      {layer.type === "video" || layer.type === "image" || layer.type === "text" || layer.type === "shape" ? (
        <InspectorHost
          layer={layer}
          onChange={onChange}
          panelIds={["mask"]}
          currentTime={currentTime}
          onSeek={onSeek}
          composition={{ width: composition.width, height: composition.height }}
          activeMaskId={activeMaskId}
          onSelectMask={onSelectMask}
          onChangeMaskTool={onChangeMaskTool}
          trackLibrary={tracks}
        />
      ) : null}

      <InspectorSection title="Effects" icon={<SlidersHorizontal size={13} />} count={layer.effects.length}>
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
        <InspectorHost layer={layer} onChange={onChange} panelIds={["text.warp"]} />
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
          {definition?.params.map((param) => (
            <EffectParamControl
              effect={normalizedEffect}
              key={param.key}
              layer={layer}
              layerTime={layerTime}
              palette={palette}
              param={param}
              onChangeLayer={onChangeLayer}
              onChange={(value, extraParams) => updateParam(param, value, extraParams)}
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
  onChange
}: {
  effect: TimelineEffect;
  layer: TimelineLayer;
  layerTime: number;
  param: TimelineEffectParamDefinition;
  palette: string[];
  onChangeLayer: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  onChange: (value: string | number | boolean, extraParams?: Record<string, string | number | boolean>) => void;
}) {
  const value = effect.params?.[param.key] ?? param.defaultValue;

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
    return (
      <EffectSliderControl
        keyframe={
          param.keyframeable
            ? {
                active: Boolean(activeKeyframe),
                interpolation: activeKeyframe?.interpolation,
                onChangeInterpolation: (interpolation) =>
                  onChangeLayer((item) => setEffectParamInterpolation(item, effect.id, param.key, layerTime, interpolation)),
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
        onChange={(nextValue) => onChangeLayer((item) => updateEffectParamAtTime(item, effect.id, param.key, layerTime, nextValue))}
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
