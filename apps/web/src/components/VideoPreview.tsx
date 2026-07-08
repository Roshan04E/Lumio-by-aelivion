import {
  Fragment,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import { Activity, Camera, Check, ChevronLeft, ChevronRight, Circle, Columns2, Eye, Grid3x3, Hexagon, Maximize, MousePointer2, PenTool, Ratio, Square, SunMoon } from "lucide-react";
import {
  buildColorFilterDefs,
  buildMaskDefsSvg,
  buildWarpedTextPathSvg,
  createBoxMask,
  createMask,
  getCompositionTransform,
  getCompositionContentTransform,
  graphicToDataUrl,
  maskShapeToPathD,
  resolveMaskAtTime,
  withAutoTangents,
  type Mask,
  type MaskPoint,
  getCompositionColorFilter,
  getCompositionColorPipeline,
  getCompositionMediaEffects,
  getMaskedEffectOverlays,
  getCompositionObjectFit,
  isTrackEnabled,
  expandEffectRegionMasks,
  expandNestedCompositions,
  buildRegionBlurCloneAliases,
  isWebgl2ColorSupported,
  getCompositionMediaStyle,
  getOverlayMaskWrapperStyle,
  getCompositionShapeStyle,
  getCompositionTextRunStyle,
  getCompositionTextStyle,
  getCompositionTransition,
  getCompositionVolume,
  getLayerSpeed,
  getLayerSpeedAt,
  getTrackAudioGainAt,
  hasSpeedRamp,
  layerSourceTimeSeconds,
  resolveAudioFxChain,
  getTrackPanAt,
  getVisibleTextRuns,
  evaluateTimelineTransform,
  findTransitionPairs,
  getActiveTransition,
  getLayerAnimations,
  hasTextWarp,
  normalizeTextWarp,
  setGlContextBudget,
  setGlGovernorEnabled,
  COLOR_EFFECT_TYPES,
  colorWarningsLabel,
  type NestedGroupSpec,
  type ProjectGraph,
  type SourceAsset,
  type TimelineComposition,
  type TimelineKeyframeV2,
  type TimelineLayer,
  type TimelineTrack,
  type TransitionSpec
} from "@lumio-by-aelivion/shared";
import { MaskedVideoLayer } from "./MaskedVideoLayer";
import { TransitionOverlay } from "./TransitionLayer";
import { ColorEngineBoundary } from "./ColorEngineBoundary";
import { WebglColorView } from "./WebglColorView";
import { WebglVideoOverlay } from "./WebglVideoOverlay";
import { WebglMediaLayer, requestLiveReprime } from "./WebglMediaLayer";
import { ProxyPlaybackLayer, type ProxyPlaybackHit } from "./ProxyPlaybackLayer";
import { getVideoPoster, useVideoPoster } from "../lib/videoThumbnails";
import { getGlGovernorEnabled, getRegionPassesEnabled, getSingleCtxPreviewEnabled, useSceneCompositor, useWebglColorEngine, useWebglRenderer } from "../color/render-engine";
import type { SceneMediaSink, ScenePreviewMediaSource } from "./scene-media-source";

// Apply the preview WebGL context-governor flag once per session (read from ?glGovernor / localStorage /
// VITE_GL_GOVERNOR). Enforcement is default-off; telemetry is unaffected. Module scope so it's set before any
// MediaWebGLRenderer allocation, matching how the other render-engine flags are read once per session.
setGlGovernorEnabled(getGlGovernorEnabled());
// Realistic preview budget (the shared default 3/4 exists for the unit test's pinned scenarios):
// a real multi-track timeline holds 8–11 live per-layer grade contexts, and the 2026-07-03 soak hit
// GL ctx 15 — one clip from Chromium's ~16 force-loss (which kills the OLDEST context, possibly the
// scene compositor → whole GPU preview drops to DOM). Target 8 pauses background cache generation
// early; hard cap 12 lets the governor (when enabled) reclaim IDLE contexts (stale preloads,
// scrolled-past clips) with real headroom before the browser acts. Live layers are never evicted —
// they're touched every frame.
setGlContextBudget(8, 12);
import { getLivePlaybackTime, getPlaybackClock, usePlaybackClock } from "../playback/playback-clock";
import { useRenderCost } from "../lib/perfDiagnostics";
import { AUDIO_MASTER_GATE_S, getAudioClockEnabled, isAudioClockMaster, registerAudioClockSource } from "../playback/audio-clock";
import { getPreviewAudioContext, getPreviewMasterBusInput } from "../playback/preview-audio-bus";
import { createAudioFxNode, ensureAudioFxWorklet, updateAudioFxNode } from "../playback/audio-fx-worklet";
import { getPreviewQualityProfile } from "../editor/performance/previewQuality";
import { notePlaybackActive, noteRenderScale } from "../editor/performance/frame-stats";
import { ensureAdaptiveQualityStarted, getAdaptiveScaleCap, subscribeAdaptiveScaleCap } from "../editor/performance/adaptive-quality";
import { PreviewStatsOverlay } from "./PreviewStatsOverlay";
import { ScenePreviewCanvas, type SceneViewerCaptureHandle } from "./ScenePreviewCanvas";

/** Mask drawing/editing tools (mirrors the registry `MaskTool`). */
type MaskTool = "select" | "rectangle" | "ellipse" | "pen" | "polygon";

/**
 * Target node for editing overlays (selection box, motion path) to portal into. It sits OUTSIDE the
 * frame-crop wrapper, so handles stay visible past the canvas edge (Premiere-style). Falls back to
 * inline rendering when null, so behaviour is never worse than before.
 */
const OverlayPortalContext = createContext<HTMLElement | null>(null);

// WebGL2 support is stable for the session — probe once (creating a canvas per render is wasteful).
let cachedWebgl2Support: boolean | null = null;
function webgl2Supported(): boolean {
  if (cachedWebgl2Support === null) cachedWebgl2Support = isWebgl2ColorSupported();
  return cachedWebgl2Support;
}

// ── Playback-tick render stabilization (Playback Jank Patch 1) ────────────────────────────────────
// During playback VideoPreview re-renders on every clock tick (usePlaybackClock). The active-set arrays
// below only change at clip/transition boundaries, but rebuilding them yields a NEW array identity each
// tick, which invalidated every downstream `useMemo` keyed on them AND re-rendered every layer subtree —
// the allocation churn behind the periodic GC freeze. `useStableList` returns the PREVIOUS array instance
// when the freshly-built one is structurally identical (same length + per-element `eq`), so identity stays
// stable between real changes and the whole downstream memo cascade collapses. It never returns stale
// data: any real content change flows through a new layer/composition object identity, which `eq` detects.
function useStableList<T>(next: T[], eq: (a: T, b: T) => boolean): T[] {
  const ref = useRef<T[]>(next);
  const prev = ref.current;
  if (prev !== next && prev.length === next.length && prev.every((item, index) => eq(item, next[index]!))) {
    return prev;
  }
  ref.current = next;
  return next;
}

type VisualLayerEntry = { layer: TimelineLayer; trackIndex: number; layerIndex: number };
const eqVisualEntry = (a: VisualLayerEntry, b: VisualLayerEntry): boolean =>
  a.layer === b.layer && a.trackIndex === b.trackIndex && a.layerIndex === b.layerIndex;

type AudioLayerEntry = { layer: TimelineLayer; trackIndex: number; track: TimelineTrack };
const eqAudioEntry = (a: AudioLayerEntry, b: AudioLayerEntry): boolean =>
  a.layer === b.layer && a.track === b.track && a.trackIndex === b.trackIndex;

type TransitionPairEntry = {
  outgoingId: string;
  incomingId: string;
  spec: TransitionSpec;
  startSeconds: number;
  incomingDurationSeconds: number;
  fromFit: "cover" | "contain" | "fill";
  toFit: "cover" | "contain" | "fill";
};
const eqTransitionPair = (a: TransitionPairEntry, b: TransitionPairEntry): boolean =>
  a.outgoingId === b.outgoingId &&
  a.incomingId === b.incomingId &&
  a.spec === b.spec &&
  a.startSeconds === b.startSeconds &&
  a.incomingDurationSeconds === b.incomingDurationSeconds &&
  a.fromFit === b.fromFit &&
  a.toFit === b.toFit;

// Dev-only, opt-in render instrumentation for the playback-jank investigation. Enable with
// `?debugRenders=1` or localStorage["lumio_debug_renders"]="1"; counts accumulate on
// `window.__rfRenderCounts` (inspect in the console). Off by default and never logs → no prod noise.
let renderDebugFlag: boolean | null = null;
function renderDebugEnabled(): boolean {
  if (renderDebugFlag === null) {
    try {
      renderDebugFlag =
        new URLSearchParams(window.location.search).get("debugRenders") === "1" ||
        window.localStorage?.getItem("lumio_debug_renders") === "1";
    } catch {
      renderDebugFlag = false;
    }
  }
  return renderDebugFlag;
}
function bumpRenderCount(name: string): void {
  if (!renderDebugEnabled()) return;
  const w = window as unknown as { __rfRenderCounts?: Record<string, number> };
  const counts = (w.__rfRenderCounts ??= {});
  counts[name] = (counts[name] ?? 0) + 1;
}

// How far ahead of a clip's start we mount its <video> (hidden) so it can fetch/decode/seek to its
// first frame before the cut. The element then persists into the active list (same DOM node), so the
// reveal is instant. ~1.2s gives slower-decoding sources time without keeping more than the next clip
// mounted.
const PRELOAD_LOOKAHEAD_SECONDS = 1.2;

// --- Composition guides (preview overlay grids) ----------------------------------
type GridMode =
  | "off"
  | "thirds"
  | "phi"
  | "golden-spiral"
  | "golden-spiral-fh"
  | "golden-spiral-fv"
  | "golden-spiral-fhv"
  | "diagonal"
  | "cross"
  | "grid";

const GRID_OPTIONS: { value: GridMode; label: string }[] = [
  { value: "off", label: "None" },
  { value: "thirds", label: "Rule of Thirds" },
  { value: "phi", label: "Golden Ratio (Phi)" },
  { value: "golden-spiral", label: "Golden Spiral" },
  { value: "diagonal", label: "Diagonals" },
  { value: "cross", label: "Center Cross" },
  { value: "grid", label: "Fine Grid" }
];

// Golden-spiral orientation flips — shown as a compact row only while a spiral is active.
const SPIRAL_ORIENTATIONS: { value: GridMode; label: string }[] = [
  { value: "golden-spiral", label: "↘" },
  { value: "golden-spiral-fh", label: "↙" },
  { value: "golden-spiral-fv", label: "↗" },
  { value: "golden-spiral-fhv", label: "↖" }
];

/**
 * Canonical golden / Fibonacci spiral overlay — the one photographers actually use.
 *
 * A real golden spiral only exists inside a φ:1 golden rectangle, so we DON'T stretch a
 * spiral across an arbitrary frame (that warps the arcs). Instead we fit a true golden
 * rectangle inside the frame (contain — by height for ≥φ frames like 16:9, leaving side
 * margins; by width for narrower frames), then build the spiral by the classic square
 * subdivision: peel a square off the short side, draw a quarter-circle arc, repeat
 * (squares alternate left → top → right → bottom). Arcs stay circular because the box is
 * exactly φ:1. We also emit the golden-rectangle border + square divisions so it reads as
 * a pro composition grid, and `flipX`/`flipY` give the four orientations (the curl/"eye"
 * lands in a different corner) so it can be placed over the subject.
 */
function buildGoldenSpiral(
  width: number,
  height: number,
  flipX = false,
  flipY = false,
  rotate = false
): { spiral: string; lines: Array<[number, number, number, number]> } {
  const PHI = 1.61803398875;
  // Fit a true golden rectangle inside the frame (contain), centered. When rotated the
  // long axis runs vertically (portrait golden rect) instead of horizontally.
  let boxW: number;
  let boxH: number;
  if (!rotate) {
    boxW = height * PHI;
    boxH = height;
    if (boxW > width) {
      boxW = width;
      boxH = width / PHI;
    }
  } else {
    boxH = width * PHI;
    boxW = width;
    if (boxH > height) {
      boxH = height;
      boxW = height / PHI;
    }
  }
  const offX = (width - boxW) / 2;
  const offY = (height - boxH) / 2;
  // Map unit golden rect [0,φ]×[0,1] (long × short) → fitted box, honoring rotation +
  // orientation flips. Without rotation the long axis is horizontal; with it, vertical.
  const map = (ux: number, uy: number): [number, number] => {
    const fx = rotate ? uy : ux / PHI;
    const fy = rotate ? ux / PHI : uy;
    let x = offX + fx * boxW;
    let y = offY + fy * boxH;
    if (flipX) x = width - x;
    if (flipY) y = height - y;
    return [x, y];
  };

  let left = 0;
  let top = 0;
  let right = PHI;
  let bottom = 1;
  const points: Array<[number, number]> = [];
  const segs: Array<[number, number, number, number]> = [
    // Golden-rectangle border.
    [0, 0, PHI, 0],
    [PHI, 0, PHI, 1],
    [PHI, 1, 0, 1],
    [0, 1, 0, 0]
  ];
  const perArc = 24;
  for (let i = 0; i < 12; i += 1) {
    const w = right - left;
    const h = bottom - top;
    const s = Math.min(w, h);
    if (s < 1e-4) break;
    let cx: number;
    let cy: number;
    let a0: number;
    let a1: number;
    const dir = i % 4;
    if (dir === 0) {
      cx = left + s;
      cy = bottom;
      a0 = Math.PI;
      a1 = 1.5 * Math.PI;
      segs.push([left + s, top, left + s, bottom]);
      left += s;
    } else if (dir === 1) {
      cx = left;
      cy = top + s;
      a0 = 1.5 * Math.PI;
      a1 = 2 * Math.PI;
      segs.push([left, top + s, right, top + s]);
      top += s;
    } else if (dir === 2) {
      cx = right - s;
      cy = top;
      a0 = 0;
      a1 = 0.5 * Math.PI;
      segs.push([right - s, top, right - s, bottom]);
      right -= s;
    } else {
      cx = right;
      cy = bottom - s;
      a0 = 0.5 * Math.PI;
      a1 = Math.PI;
      segs.push([left, bottom - s, right, bottom - s]);
      bottom -= s;
    }
    for (let k = 0; k <= perArc; k += 1) {
      const a = a0 + (a1 - a0) * (k / perArc);
      points.push([cx + s * Math.cos(a), cy + s * Math.sin(a)]);
    }
  }
  const spiral = points
    .map((p, i) => {
      const [x, y] = map(p[0], p[1]);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  const lines = segs.map(([x1, y1, x2, y2]) => {
    const [ax, ay] = map(x1, y1);
    const [bx, by] = map(x2, y2);
    return [ax, ay, bx, by] as [number, number, number, number];
  });
  return { spiral, lines };
}

/** Non-interactive composition guide overlay drawn in composition pixel space. */
function PreviewGuides({ mode, width, height, rotate = false }: { mode: GridMode; width: number; height: number; rotate?: boolean }) {
  if (mode === "off") return null;
  const w = width;
  const h = height;
  const lines: Array<[number, number, number, number]> = [];
  const isSpiral = mode.startsWith("golden-spiral");
  switch (mode) {
    case "thirds":
      lines.push([w / 3, 0, w / 3, h], [(2 * w) / 3, 0, (2 * w) / 3, h], [0, h / 3, w, h / 3], [0, (2 * h) / 3, w, (2 * h) / 3]);
      break;
    case "phi": {
      const a = 0.382;
      const b = 0.618;
      lines.push([w * a, 0, w * a, h], [w * b, 0, w * b, h], [0, h * a, w, h * a], [0, h * b, w, h * b]);
      break;
    }
    case "cross":
      lines.push([w / 2, 0, w / 2, h], [0, h / 2, w, h / 2]);
      break;
    case "diagonal":
      lines.push([0, 0, w, h], [w, 0, 0, h], [0, h / 2, w / 2, 0], [w / 2, 0, w, h / 2]);
      break;
    case "grid": {
      const cols = 8;
      const rows = Math.max(2, Math.round(cols * (h / w)));
      for (let i = 1; i < cols; i += 1) lines.push([(w * i) / cols, 0, (w * i) / cols, h]);
      for (let i = 1; i < rows; i += 1) lines.push([0, (h * i) / rows, w, (h * i) / rows]);
      break;
    }
    default:
      break;
  }
  const spiral = isSpiral
    ? buildGoldenSpiral(
        w,
        h,
        mode === "golden-spiral-fh" || mode === "golden-spiral-fhv",
        mode === "golden-spiral-fv" || mode === "golden-spiral-fhv",
        rotate
      )
    : null;

  return (
    <svg className="preview-guides" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {spiral ? (
        <>
          {spiral.lines.map(([x1, y1, x2, y2], i) => (
            <line key={`s${i}`} className="guide-sub" x1={x1} y1={y1} x2={x2} y2={y2} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={spiral.spiral} fill="none" vectorEffect="non-scaling-stroke" />
        </>
      ) : (
        lines.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} vectorEffect="non-scaling-stroke" />
        ))
      )}
    </svg>
  );
}

function VideoPreviewImpl({
  graph,
  composition,
  currentTime: currentTimeProp,
  isPlaying,
  clockDriven = false,
  previewQuality,
  viewMode,
  manualScale,
  viewerPanMode = false,
  rotationSnapEnabled = false,
  assets,
  selectedLayerId,
  frameRef,
  onFitScale,
  onZoomTo,
  onSaveFreezeFrame,
  onSelectLayer,
  onMoveLayer,
  onMovePositionKeyframe,
  onMoveSpatialHandle,
  onResizeShapeLayer,
  onRotateLayer,
  onScaleLayer,
  onCropLayer,
  sourceAsset,
  maskTool = "select",
  onChangeMaskTool,
  activeMaskId,
  onSelectMask,
  showMasks = true,
  onToggleShowMasks,
  onUpdateLayerMasks,
  onCommitMaskPoints,
  onPreviewMaskScalar,
  maskEffectId,
  onPreviewFrameRendered,
  resolveProxyPlayback,
  proxyCaptureRef
}: {
  graph: ProjectGraph;
  composition: TimelineComposition;
  currentTime: number;
  isPlaying: boolean;
  /**
   * When true, the playhead time ALWAYS comes from the clock store — paused seeks/scrubs included —
   * so the host page never has to re-render to feed a new `currentTime` prop (EditorPage pushes
   * every seek into the clock). Leave false for hosts that pass a fixed/local time and never push
   * the clock (PreviewFixturePage, SmartFollowTextToolPanel).
   */
  clockDriven?: boolean | undefined;
  previewQuality: "performance" | "balanced" | "quality";
  /** "fit" auto-scales the comp to the viewer (re-fits on resize); "manual" uses `manualScale` (1:1). */
  viewMode: "fit" | "manual";
  /** Manual zoom as a comp-px→screen-px scale (1 = 100% actual pixels). Used only in "manual" mode. */
  manualScale: number;
  /** When true, primary touch/drag gestures pan/zoom the viewer canvas instead of editing selected layers. */
  viewerPanMode?: boolean | undefined;
  /** When true, rotate gestures snap to common production angles. */
  rotationSnapEnabled?: boolean | undefined;
  assets: SourceAsset[];
  selectedLayerId?: string | undefined;
  /** Optional ref forwarded to the phone-frame element so callers can sample its content (e.g. color scopes). */
  frameRef?: React.Ref<HTMLDivElement> | undefined;
  /** Reports the computed fit scale (comp→viewer) so the toolbar can show the % in fit mode. NO feedback
   *  loop: fit is measured from the stable viewport box, never from the (zoom-scaled) comp. */
  onFitScale?: ((scale: number) => void) | undefined;
  /** Ctrl/⌘-wheel zoom → switch to manual at this absolute scale. */
  onZoomTo?: ((scale: number) => void) | undefined;
  onSaveFreezeFrame?: (() => void) | undefined;
  onSelectLayer: (layerId?: string | undefined) => void;
  onMoveLayer?: ((layerId: string, position: { x: number; y: number }, commit: boolean) => void) | undefined;
  onMovePositionKeyframe?: ((layerId: string, timeSeconds: number, position: { x: number; y: number }, commit: boolean) => void) | undefined;
  onMoveSpatialHandle?:
    | ((layerId: string, timeSeconds: number, handle: "in" | "out", tangent: { x: number; y: number }, linked: boolean, commit: boolean) => void)
    | undefined;
  onResizeShapeLayer?: ((layerId: string, size: { widthPercent: number; heightPercent: number }, commit: boolean) => void) | undefined;
  onRotateLayer?: ((layerId: string, rotation: number, commit: boolean) => void) | undefined;
  onScaleLayer?: ((layerId: string, scale: number, commit: boolean) => void) | undefined;
  onCropLayer?: ((layerId: string, edge: "top" | "right" | "bottom" | "left", value: number, commit: boolean) => void) | undefined;
  sourceAsset?: SourceAsset | null | undefined;
  /** Active mask draw/edit tool. */
  maskTool?: MaskTool | undefined;
  onChangeMaskTool?: ((tool: MaskTool) => void) | undefined;
  /** Mask currently being edited in the overlay. */
  activeMaskId?: string | undefined;
  onSelectMask?: ((maskId: string | null) => void) | undefined;
  /** Whether mask outlines/handles are shown. */
  showMasks?: boolean | undefined;
  onToggleShowMasks?: (() => void) | undefined;
  /** Update a layer's masks (preview drawing/editing — add/delete masks). */
  onUpdateLayerMasks?: ((layerId: string, updater: (masks: Mask[]) => Mask[]) => void) | undefined;
  /** Commit edited outline points for one mask (path-keyframe-aware in EditorPage). */
  onCommitMaskPoints?: ((layerId: string, maskId: string, points: MaskPoint[]) => void) | undefined;
  /** Live feather/opacity from the on-canvas widget; commit=false while dragging, true on release. */
  onPreviewMaskScalar?: ((layerId: string, maskId: string, patch: { feather?: number; opacity?: number }, commit: boolean) => void) | undefined;
  /** When set, the overlay edits this effect's region masks instead of the layer's clip masks (Phase 3). */
  maskEffectId?: string | null | undefined;
  /** Called after the GPU scene preview successfully renders a playback frame. */
  onPreviewFrameRendered?: ((timeSeconds: number, renderScale: number) => void) | undefined;
  /** Resolve a ready flattened-proxy for a timeline time, for smooth native-video playback substitution. */
  resolveProxyPlayback?: ((timeSeconds: number) => ProxyPlaybackHit | undefined) | undefined;
  /** Viewer-capture handle for background proxy generation (forwarded to ScenePreviewCanvas). */
  proxyCaptureRef?: React.MutableRefObject<SceneViewerCaptureHandle | null> | undefined;
}) {
  // During playback the playhead time comes from the high-frequency clock store (so the preview
  // animates smoothly without re-rendering the whole editor every tick — see playback-clock.ts);
  // when paused/scrubbing it's the `currentTime` prop. Everything below reads this single `currentTime`.
  bumpRenderCount("VideoPreview");
  useRenderCost("VideoPreview");
  const currentTime = usePlaybackClock(currentTimeProp, clockDriven || isPlaying);
  const phoneFrameRef = useRef<HTMLDivElement | null>(null);
  // Merge internal ref with optional external frameRef prop (for color scopes).
  const mergedPhoneFrameRef = useCallback(
    (node: HTMLDivElement | null) => {
      phoneFrameRef.current = node;
      if (typeof frameRef === "function") {
        frameRef(node);
      } else if (frameRef && typeof frameRef === "object") {
        (frameRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [frameRef]
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Preview creator tools (local toggles).
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [gridMode, setGridMode] = useState<GridMode>("off");
  const [gridMenuOpen, setGridMenuOpen] = useState(false);
  const gridMenuRef = useRef<HTMLDivElement | null>(null);
  const gridMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [gridMenuRect, setGridMenuRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  // Collapse the floating tool bar to a single chevron to free up viewer room.
  const [toolsCollapsed, setToolsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("lumio_preview_tools_collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [spiralRotate, setSpiralRotate] = useState(false);

  const repositionGridMenu = useCallback(() => {
    const trigger = gridMenuButtonRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const width = Math.min(212, Math.max(176, window.innerWidth - viewportPadding * 2));
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(180, Math.min(360, (openAbove ? spaceAbove : spaceBelow) - 6));
    const left = Math.max(viewportPadding, Math.min(rect.right - width, window.innerWidth - width - viewportPadding));
    const top = openAbove ? Math.max(viewportPadding, rect.top - maxHeight - 6) : Math.min(window.innerHeight - viewportPadding, rect.bottom + 6);
    setGridMenuRect({ top, left, width, maxHeight });
  }, []);

  // Close the composition-guides popover on outside click / Escape.
  useLayoutEffect(() => {
    if (gridMenuOpen) repositionGridMenu();
  }, [gridMenuOpen, repositionGridMenu]);

  useEffect(() => {
    if (!gridMenuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (gridMenuRef.current?.contains(target) || gridMenuButtonRef.current?.contains(target)) {
        return;
      }
      {
        setGridMenuOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setGridMenuOpen(false);
    }
    function handleReflow() {
      repositionGridMenu();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleReflow, true);
    window.addEventListener("resize", handleReflow);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleReflow, true);
      window.removeEventListener("resize", handleReflow);
    };
  }, [gridMenuOpen, repositionGridMenu]);
  const [previewBg, setPreviewBg] = useState<"default" | "dark" | "light" | "checker">("default");
  const [compareBefore, setCompareBefore] = useState(false);
  const isPortrait = composition.height >= composition.width;
  function toggleFullscreen() {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen().catch(() => undefined);
  }
  const panRef = useRef<{ pointerId: number; clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const viewportPointersRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const pinchRef = useRef<{ startDistance: number; startScale: number } | null>(null);
  // ONE display scale (comp px → screen px). In "fit" mode it tracks the computed fit; in "manual" it is
  // `manualScale`. Replaces the old nested compositionScale × viewer-zoom (which scaled as zoom² and fed
  // the fit loop). Fit is measured from the stable viewport box, so changing the scale never re-fits.
  const [displayScale, setDisplayScale] = useState(1);
  const displayScaleRef = useRef(displayScale);
  displayScaleRef.current = displayScale;
  const fitScaleRef = useRef(1);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const manualScaleRef = useRef(manualScale);
  manualScaleRef.current = manualScale;
  const onFitScaleRef = useRef(onFitScale);
  onFitScaleRef.current = onFitScale;
  const onZoomToRef = useRef(onZoomTo);
  onZoomToRef.current = onZoomTo;
  // Pending cursor-anchored zoom: captured on a ctrl/⌘-wheel, applied in a layout effect after the new
  // scale lands so the comp point under the cursor stays under the cursor (Premiere/Photoshop feel).
  const pendingZoomRef = useRef<{ ratio: number; cx: number; cy: number; scrollLeft: number; scrollTop: number } | null>(null);
  // Unclipped layer that editing overlays (selection box, motion path) portal into, so their handles show
  // past the canvas edge (the comp content is still cropped by .preview-comp-clip).
  const [overlayLayer, setOverlayLayer] = useState<HTMLDivElement | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const shouldRenderRichEffects = previewQuality !== "performance";
  // Premiere-style playback resolution: downscale the scene render backing WHILE PLAYING (Full/Half/Quarter
  // = 1/0.5/0.25 from the previewQuality profile), Full (1) when paused/scrubbing → crisp stills, fast
  // playback. Only the scene compositor honors it (the DOM path is being retired by Method 3).
  // The ADAPTIVE cap (adaptive-quality.ts) can lower — never raise — the profile scale while playback is
  // dropping frames, stepping through the same tested ladder (1/0.5/0.25). Kill switch: ?adaptiveQuality=0.
  const adaptiveScaleCap = useSyncExternalStore(subscribeAdaptiveScaleCap, getAdaptiveScaleCap, getAdaptiveScaleCap);
  const playbackRenderScale = isPlaying ? Math.min(getPreviewQualityProfile(previewQuality).resolutionScale, adaptiveScaleCap) : 1;
  // Frame-stats bookkeeping (measurement only): start the adaptive controller once, mark play/pause
  // boundaries (resets the sample window), and report the scale actually applied for the Stats HUD.
  useEffect(() => {
    ensureAdaptiveQualityStarted();
  }, []);
  useEffect(() => {
    notePlaybackActive(isPlaying);
    return () => notePlaybackActive(false);
  }, [isPlaying]);
  useEffect(() => {
    noteRenderScale(playbackRenderScale);
  }, [playbackRenderScale]);
  const hasTracking = shouldRenderRichEffects && graph.effects.some((effect) => effect.type === "SMART_3D_FOLLOW_TEXT");
  const hasBehindText = shouldRenderRichEffects && graph.effects.some((effect) => effect.type === "TEXT_BEHIND_PERSON");
  const resolvedAssets = useMemo(() => {
    if (!sourceAsset || assets.some((asset) => asset.id === sourceAsset.id)) {
      return assets;
    }

    return [sourceAsset, ...assets];
  }, [assets, sourceAsset]);
  // Nested sequences (NESTING.md Phase C — imported prproj nests today, native compounds later) expand
  // FIRST: each `nestedCompositionId` clip becomes derived child layers in parent coordinates (namespaced
  // `__nest_` ids), with the compound clip itself REMOVED from its track — region-mask expansion then runs
  // on those children like any other layer. Order matters and must match export/manifest exactly (Tasks
  // 4/5) or preview and export would composite different layer sets. Returns the SAME `composition`
  // reference when there's nothing to expand, so `expandedTracks`'s memo below is unaffected for the
  // (overwhelmingly common) non-nested case.
  const nestExpansion = useMemo(() => expandNestedCompositions(composition, graph.compositions), [composition, graph.compositions]);
  // Region color/glow masks expand into base + duplicate layers at render time (duplicate = the masked effect
  // applied globally, clipped to the region). Render-only; the editor state keeps the original single layer.
  const expandedTracks = useMemo(() => expandEffectRegionMasks(nestExpansion.composition).tracks, [nestExpansion]);
  // The REAL (un-expanded) layer ids. expandEffectRegionMasks adds render-only `__rfx_` clone layers for
  // region color/blur masks; those clones must be pixels-only — NOT selectable/draggable — or clicking the
  // clip in the preview selects a phantom id (deselecting the real clip) and the drag drives a render-only
  // layer. Only ids in this set are interactive; clones fall through to the real base layer beneath.
  const realLayerIds = useMemo(
    () => new Set(composition.tracks.flatMap((track) => track.layers.map((layer) => layer.id))),
    [composition]
  );
  const activeVisualLayerEntriesRaw = useMemo(
    () =>
      expandedTracks
        .flatMap((track, trackIndex) =>
          track.layers.map((layer, layerIndex) => ({
            layer,
            trackIndex,
            layerIndex
          }))
        )
        .filter(({ layer, trackIndex }) => {
          const track = composition.tracks[trackIndex];
          if (!track || !isTrackEnabled(track, composition.tracks) || layer.muted || layer.type === "audio") {
            return false;
          }
          // Active in its own span, OR rendering into the post-roll of the next clip's transition (so
          // the outgoing clip shows under the incoming's reveal — held at its out-point frame).
          return isLayerActive(layer, currentTime) || (track ? isOutgoingInPostroll(layer, track, currentTime) : false);
        })
        .sort((a, b) => {
          if (a.trackIndex !== b.trackIndex) {
            return b.trackIndex - a.trackIndex;
          }

          return a.layerIndex - b.layerIndex;
        }),
    [expandedTracks, composition, currentTime]
  );
  // Stabilize identity between clip boundaries so the downstream memo cascade + layer subtrees don't
  // rebuild every playback tick. renderVisualLayerEntries/renderedLayerEntries/sceneLayers/etc. are all
  // memoized on this, so stabilizing the source collapses the whole cascade (Playback Jank Patch 1).
  const activeVisualLayerEntries = useStableList(activeVisualLayerEntriesRaw, eqVisualEntry);
  const renderVisualLayerEntries = useMemo(
    () =>
      activeVisualLayerEntries
        .filter(({ layer }) => layer.type !== "adjustment")
        .map((entry) => ({
          ...entry,
          layer: applyActiveAdjustmentEffects(entry.layer, entry.trackIndex, activeVisualLayerEntries)
        })),
    [activeVisualLayerEntries]
  );
  // Mount the next video clip's <video> a moment before its cut so it has time
  // to seek to the right source frame in the background - avoids the visible
  // black/stale frame flash that a fresh seek-on-mount causes right at a cut.
  // Built from the RAW composition (un-expanded), i.e. REAL clips only — region-mask `__rfx_` blur clones are
  // NOT preloaded here because they no longer mount their own decoder (they share the base's graded canvas via
  // `sceneSharedMediaClones`), so preloading the base seeks the clone's frame for free + saves a GL context.
  const pendingVideoLayerEntriesRaw = useMemo(
    () =>
      composition.tracks
        .flatMap((track, trackIndex) => track.layers.map((layer, layerIndex) => ({ layer, trackIndex, layerIndex })))
        .filter(({ layer, trackIndex }) => {
          const track = composition.tracks[trackIndex];
          if (!track || !isTrackEnabled(track, composition.tracks) || layer.muted || layer.type !== "video" || isLayerActive(layer, currentTime)) {
            return false;
          }
          return currentTime + PRELOAD_LOOKAHEAD_SECONDS >= layer.startSeconds && currentTime < layer.startSeconds;
        }),
    [composition, currentTime]
  );
  const pendingVideoLayerEntries = useStableList(pendingVideoLayerEntriesRaw, eqVisualEntry);
  // ONE render list: active visual layers + the pre-rolled next video clips, deduped by id and sorted
  // by the same stable z-order. Rendering both from a single keyed array means a clip that crosses its
  // start (pending → active) keeps the SAME React element + DOM <video> — already decoded and seeked —
  // instead of being unmounted and recreated. That remount was the black flash at every cut and the
  // cross-dissolve "blackout" for video (the incoming clip was reloading as it faded in).
  const renderedLayerEntries = useMemo(() => {
    const seen = new Set<string>();
    const combined: Array<{ layer: TimelineLayer; trackIndex: number; layerIndex: number; pending: boolean }> = [];
    for (const entry of renderVisualLayerEntries) {
      seen.add(entry.layer.id);
      combined.push({ layer: entry.layer, trackIndex: entry.trackIndex, layerIndex: entry.layerIndex, pending: false });
    }
    for (const entry of pendingVideoLayerEntries) {
      if (seen.has(entry.layer.id)) {
        continue;
      }
      combined.push({
        layer: applyActiveAdjustmentEffects(entry.layer, entry.trackIndex, activeVisualLayerEntries),
        trackIndex: entry.trackIndex,
        layerIndex: entry.layerIndex,
        pending: true
      });
    }
    return combined.sort((a, b) => (a.trackIndex !== b.trackIndex ? b.trackIndex - a.trackIndex : a.layerIndex - b.layerIndex));
  }, [renderVisualLayerEntries, pendingVideoLayerEntries, activeVisualLayerEntries]);
  const activeAudioLayerEntriesRaw = useMemo(
    () =>
      composition.tracks
        .flatMap((track, trackIndex) => track.layers.map((layer) => ({ layer, trackIndex, track })))
        .filter(({ layer, track }) => isTrackEnabled(track, composition.tracks) && !layer.muted && layer.type === "audio" && isLayerActive(layer, currentTime)),
    [composition, currentTime]
  );
  const activeAudioLayerEntries = useStableList(activeAudioLayerEntriesRaw, eqAudioEntry);

  // Every shader-transition kind the composition uses (deduped + sorted for referential stability
  // via the join key). ScenePreviewCanvas pre-warms these programs during idle so the first frame
  // of a cut never pays a shader-compile stall. Non-shader kinds resolve to nothing downstream.
  const prewarmTransitionKey = useMemo(
    () =>
      [...new Set(
        composition.tracks.flatMap((track) => track.layers.flatMap((layer) => (layer.transitionIn?.kind ? [layer.transitionIn.kind] : [])))
      )]
        .sort()
        .join(","),
    [composition]
  );
  const prewarmTransitionIds = useMemo(
    () => (prewarmTransitionKey ? prewarmTransitionKey.split(",") : []),
    [prewarmTransitionKey]
  );

  // The selected visual layer is the mask-editing target. Clip + region masks apply to media AND text/shape
  // (text/shape clip masks render via getOverlayMaskWrapperStyle in every path since Phase 4.1c). Read it from
  // the ORIGINAL composition, not `renderedLayerEntries`: region effects expand into render-only clones (the
  // base clone keeps this id but has the region effects stripped), so editing must use the un-expanded layer
  // to still see `effect.masks` (region masks) — otherwise the region mask is invisible/uneditable.
  const maskActiveLayer = selectedLayerId
    ? composition.tracks
        .flatMap((track) => track.layers)
        .find(
          (layer) =>
            layer.id === selectedLayerId &&
            (layer.type === "video" || layer.type === "image" || layer.type === "text" || layer.type === "shape")
        )
    : undefined;
  // The mask collection the overlay edits: a blur effect's region masks (Phase 3) or the clip masks.
  const maskEditMasks: Mask[] = maskActiveLayer
    ? maskEffectId
      ? maskActiveLayer.effects.find((effect) => effect.id === maskEffectId)?.masks ?? []
      : maskActiveLayer.masks ?? []
    : [];

  // Unified GPU transition engine: each rendered same-track clip pair joined by a (registry) junction
  // transition that is currently ACTIVE. The two clips keep rendering through their WebglMediaLayer (which
  // reports its graded canvas into gradedCanvasesRef); a TransitionOverlay mixes them in one GPU pass.
  const gradedCanvasesRef = useRef<Record<string, HTMLCanvasElement | null>>({});
  // ScenePreviewCanvas hands us its `requestDraw` here so a media re-grade (e.g. an opacity/grade edit
  // while PAUSED) re-arms a recomposite — otherwise the new graded frame only lands via the settle
  // window and the paused viewer can show a stale frame after an edit.
  const sceneRedrawRef = useRef<(() => void) | null>(null);
  // Single-context GPU-first preview (Phase 5, `lumio.singleCtxPreview`): media layers publish a raw
  // frame-source descriptor here (keyed by layer id) instead of grading into `gradedCanvasesRef`;
  // ScenePreviewCanvas grades them in-context. The per-layer sinks are cached (stable identity) so
  // toggling other props never re-registers a descriptor. Flag read once (doesn't change mid-session).
  const singleCtxPreview = useMemo(() => getSingleCtxPreviewEnabled(), []);
  const sceneMediaSourcesRef = useRef<Record<string, ScenePreviewMediaSource | null>>({});
  const sceneMediaSinksRef = useRef(new Map<string, SceneMediaSink>());
  const getSceneMediaSink = useCallback((layerId: string): SceneMediaSink => {
    let sink = sceneMediaSinksRef.current.get(layerId);
    if (!sink) {
      sink = {
        register: (source) => {
          if (source) sceneMediaSourcesRef.current[layerId] = source;
          else delete sceneMediaSourcesRef.current[layerId];
        },
        // A new raw frame landed — re-arm the scene recomposite (the analog of onGradedFrame → sceneRedrawRef).
        onFrame: () => sceneRedrawRef.current?.(),
      };
      sceneMediaSinksRef.current.set(layerId, sink);
    }
    return sink;
  }, []);
  const transitionPairsRaw = useMemo(() => {
    const layers = renderedLayerEntries.map((entry) => entry.layer);
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const out: {
      outgoingId: string;
      incomingId: string;
      spec: TransitionSpec;
      startSeconds: number;
      incomingDurationSeconds: number;
      fromFit: "cover" | "contain" | "fill";
      toFit: "cover" | "contain" | "fill";
    }[] = [];
    for (const pair of findTransitionPairs(layers)) {
      const incoming = byId.get(pair.incomingId);
      const outgoing = byId.get(pair.outgoingId);
      if (!incoming || !outgoing) continue;
      const active = getActiveTransition(pair.spec, { currentTimeSeconds: currentTime, startSeconds: incoming.startSeconds, clipDurationSeconds: incoming.durationSeconds });
      if (!active) continue;
      out.push({
        outgoingId: pair.outgoingId,
        incomingId: pair.incomingId,
        spec: pair.spec,
        startSeconds: incoming.startSeconds,
        incomingDurationSeconds: incoming.durationSeconds,
        fromFit: getCompositionObjectFit(outgoing) as "cover" | "contain" | "fill",
        toFit: getCompositionObjectFit(incoming) as "cover" | "contain" | "fill",
      });
    }
    return out;
  }, [renderedLayerEntries, currentTime]);
  const transitionPairs = useStableList(transitionPairsRaw, eqTransitionPair);
  // Source clips (report graded frames) and the incoming clip (hidden — the overlay shows the mix on top;
  // the outgoing stays visible as a fallback until both graded canvases are ready).
  const transitionSourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const pair of transitionPairs) {
      ids.add(pair.outgoingId);
      ids.add(pair.incomingId);
    }
    return ids;
  }, [transitionPairs]);
  const transitionHiddenIds = useMemo(() => {
    const ids = new Set<string>();
    for (const pair of transitionPairs) ids.add(pair.incomingId);
    return ids;
  }, [transitionPairs]);
  // Anchor each overlay to whichever of its two source clips appears LAST in the render order, so the
  // overlay sits just above the transitioning clips' track in the DOM but below any higher-track layers.
  const overlaysByAnchorId = useMemo(() => {
    const indexById = new Map(renderedLayerEntries.map((entry, index) => [entry.layer.id, index]));
    const map = new Map<string, typeof transitionPairs>();
    for (const pair of transitionPairs) {
      const outIdx = indexById.get(pair.outgoingId) ?? -1;
      const inIdx = indexById.get(pair.incomingId) ?? -1;
      const anchorId = outIdx >= inIdx ? pair.outgoingId : pair.incomingId;
      const list = map.get(anchorId) ?? [];
      list.push(pair);
      map.set(anchorId, list);
    }
    return map;
  }, [transitionPairs, renderedLayerEntries]);
  const hasRealMedia = renderVisualLayerEntries.some(({ layer }) => Boolean(resolveLayerUrl(layer, resolvedAssets, sourceAsset)));

  // Single GPU compositor (Method 3) — gated by the `compositor=scene` flag + WebGL2 support. Media + text/
  // shape (incl. 3D tilt, clip masks, color grade, blur/glow) and junction transitions all composite into one
  // GPU canvas (Phases 1–4.2); only editing handles stay DOM. The ONLY fallback to the shipped DOM path is a
  // runtime GL failure (`sceneFailed`), so turning the flag on can never hard-regress a comp.
  const [sceneFailed, setSceneFailed] = useState(false);
  const sceneMediaIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { layer } of renderedLayerEntries) {
      if (layer.type === "video" || layer.type === "image") ids.add(layer.id);
    }
    return ids;
  }, [renderedLayerEntries]);
  // Text/shape layers the scene pass rasterizes (so their DOM visual is hidden; handles stay).
  const sceneOverlayIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { layer } of renderedLayerEntries) {
      if (layer.type === "text" || layer.type === "shape") ids.add(layer.id);
    }
    return ids;
  }, [renderedLayerEntries]);
  // Region-blur clone id → base layer id. `expandEffectRegionMasks` clones a region-masked VIDEO/IMAGE into
  // [base, clone]; when the clone adds ONLY blur over its base (the common "blur a region/face" case) its
  // decoded+graded media source is IDENTICAL to the base's — blur is a GPU compositor PASS here, not baked
  // into the grade — so in scene mode the clone need NOT mount its own <video> decoder + MediaWebGLRenderer
  // GL context. It reads the base's graded canvas (mediaSourceAlias) and the compositor applies blur + the
  // region mask on top. This halves media GL contexts for region blur (the "too many active WebGL contexts"
  // eviction that was losing the scene compositor's OWN context → the lost-context spam + stale/weak blur)
  // AND keeps the clone perfectly time-synced to the base (no second decoder to drift). A clone that adds a
  // COLOR grade over its base genuinely needs a different graded canvas, so it is NOT aliased (keeps its decoder).
  // Blur-only region clones share the base's graded canvas (no second decoder/context). SHARED with the local
  // export (buildRegionBlurCloneAliases) so the proxy the export renders matches this preview exactly — the
  // export aliasing the same clones is what keeps the masked blur in the generated proxy.
  const sceneSharedMediaClones = useMemo(
    () => buildRegionBlurCloneAliases(renderedLayerEntries.map((entry) => entry.layer)),
    [renderedLayerEntries]
  );
  // Region-effect PASS model (R2): the scene path reads NO clone canvas at all — blur passes gaussian the
  // layer's running nest image and color passes grade it in-compositor — so in scene mode no `__rfx_` clone
  // (blur OR color) needs its own <video> decoder / MediaWebGLRenderer context. That extends the blur-alias
  // decoder saving to region COLOR effects. Query/localStorage flags don't change mid-session → read once.
  const regionPassesOn = useMemo(() => getRegionPassesEnabled(), []);
  // Scene mode is ENABLED whenever the flag is on, WebGL2 is supported, and the GPU path hasn't errored at
  // runtime. We deliberately do NOT gate on "has a visual layer under the playhead": the ScenePreviewCanvas
  // stays mounted even over an empty gap so it owns the background EVERY frame (clearing to
  // composition.backgroundColor) — no mount/unmount toggle as clips enter/leave → no background flash at
  // gaps / cuts / before the first clip (the prior `visualCount > 0` gate caused the "black just before a
  // clip" flash). Per-layer fallbacks are gone (Phase 4.1c/d); only a runtime GL failure reverts to DOM.
  const sceneEnabled = useMemo(
    () => !sceneFailed && useSceneCompositor(webgl2Supported()),
    [sceneFailed]
  );
  const sceneLayers = useMemo(
    () =>
      renderedLayerEntries
        .filter(
          ({ layer, pending }) =>
            // Skip PRELOAD (pending) clips: a video mounted ~PRELOAD_LOOKAHEAD_SECONDS before its cut is
            // seeked to its first frame but NOT active yet. In DOM mode it's CSS-hidden; the scene path
            // must likewise not composite it (it reads the graded canvas directly), or the clip's still
            // frame paints before the playhead reaches it. It still mounts + grades into gradedRef while
            // pending, so when it goes active its canvas is ready → no black flash, just no early paint.
            !pending &&
            (sceneMediaIds.has(layer.id) || sceneOverlayIds.has(layer.id))
            // Phase 4.2: the two clips of an active transition STAY in the list so ScenePreviewCanvas can
            // place the mix at the incoming clip's z-slot (it skips the outgoing + emits the two-texture
            // mix instead of the incoming's normal draw). The DOM TransitionOverlay is suppressed in scene
            // mode (below), so there's no double-render.
        )
        .map(({ layer }) => layer),
    [renderedLayerEntries, sceneMediaIds, sceneOverlayIds]
  );
  // Honest degradation signal: a color grade is EXACT when it renders through WebGL (the scene
  // compositor, the unified media renderer, or the legacy WebGL color engine). If none of those is
  // active, the DOM/SVG filter path applies only an sRGB approximation of the managed Rec.709-linear
  // grade (and drops HSL/LUT stages entirely) → badge the preview so the user knows it isn't exact.
  const colorGradeExact =
    sceneEnabled || useWebglRenderer(webgl2Supported()) || useWebglColorEngine(webgl2Supported());
  const hasActiveColorGrade = useMemo(
    () =>
      renderedLayerEntries.some(({ layer }) => {
        const effects = (layer as { effects?: Array<{ type?: unknown; enabled?: unknown }> }).effects;
        return Array.isArray(effects) && effects.some((e) => e && e.enabled !== false && COLOR_EFFECT_TYPES.has(String(e.type)));
      }),
    [renderedLayerEntries]
  );
  const colorPreviewDegraded = hasActiveColorGrade && !colorGradeExact;
  // The media layers ScenePreviewCanvas applies opacity LIVE for (so they skip baking opacity into the
  // grade). Transition-active clips are EXCLUDED: their graded canvases feed the two-texture mix, which —
  // like the DOM overlay / Remotion / export — consumes BAKED-opacity canvases, so they keep bakeOpacity.
  const sceneLayerIds = useMemo(
    () => new Set(sceneLayers.filter((layer) => !transitionSourceIds.has(layer.id)).map((layer) => layer.id)),
    [sceneLayers, transitionSourceIds]
  );

  // Pre-warm first-frame posters for the opening video clips (those near t=0, which have no preload
  // runway) so the very first frame shows a still instead of black before it decodes. Later clips warm
  // when they mount (active or ~1.2s pending), and posters are cached per url@in-point.
  useEffect(() => {
    for (const track of composition.tracks) {
      for (const layer of track.layers) {
        if (layer.type !== "video" || layer.startSeconds > PRELOAD_LOOKAHEAD_SECONDS) {
          continue;
        }
        const url = resolveLayerUrl(layer, resolvedAssets, sourceAsset);
        if (url) {
          void getVideoPoster(url, layer.sourceInSeconds ?? 0);
        }
      }
    }
  }, [composition, resolvedAssets, sourceAsset]);

  // Compute the single display scale. Fit is measured from the STABLE viewport box (border-box via
  // getBoundingClientRect − padding, which does NOT change when the comp is scaled or a scrollbar
  // toggles), and the scale is applied via a transform on the comp — so applying the scale never
  // resizes anything the observer watches → no feedback loop (the old design measured the zoom-scaled
  // frame, giving the zoom² 2-cycle / 10% runaway). We observe only the viewport + editor-viewer
  // (their boxes change only on real panel resizes), never the scaled comp/frame.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const recomputeFit = () => {
      const rect = viewport.getBoundingClientRect();
      const style = window.getComputedStyle(viewport);
      const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const padY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const availW = rect.width - padX;
      const availH = rect.height - padY;
      if (availW <= 0 || availH <= 0 || composition.width <= 0 || composition.height <= 0) return;
      const fit = Math.min(availW / composition.width, availH / composition.height);
      if (!Number.isFinite(fit) || fit <= 0) return;
      fitScaleRef.current = fit;
      onFitScaleRef.current?.(fit);
      if (viewModeRef.current === "fit") setDisplayScale(fit);
    };

    recomputeFit();
    const observer = new ResizeObserver(recomputeFit);
    observer.observe(viewport);
    const editorViewer = viewport.closest(".editor-viewer");
    if (editorViewer) observer.observe(editorViewer);
    return () => observer.disconnect();
  }, [composition.width, composition.height]);

  // Apply the chosen mode/scale (a fresh "fit" uses the latest measured fit).
  useEffect(() => {
    setDisplayScale(viewMode === "fit" ? fitScaleRef.current : manualScale);
  }, [viewMode, manualScale]);

  // Cursor-anchored zoom: after the new scale lands (frame resized), re-scroll so the comp point that
  // was under the cursor stays under it. `newScroll = (oldScroll + cursorOffset) * ratio − cursorOffset`.
  // Runs pre-paint (no flicker); only acts when a ctrl/⌘-wheel set `pendingZoomRef`.
  useLayoutEffect(() => {
    const anchor = pendingZoomRef.current;
    if (!anchor) return;
    pendingZoomRef.current = null;
    const vp = viewportRef.current;
    if (!vp) return;
    vp.scrollLeft = (anchor.scrollLeft + anchor.cx) * anchor.ratio - anchor.cx;
    vp.scrollTop = (anchor.scrollTop + anchor.cy) * anchor.ratio - anchor.cy;
  }, [displayScale]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const viewportElement = viewport;

    function handleNativeWheel(event: WheelEvent) {
      event.preventDefault();
      event.stopPropagation();

      if (event.ctrlKey || event.metaKey) {
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        const old = displayScaleRef.current;
        const next = clamp(old * factor, 0.05, 8);
        if (next === old) return;
        // Capture the cursor anchor (relative to the viewport) + current scroll, so the layout effect
        // can re-scroll to keep the point under the cursor fixed once the new scale renders.
        const rect = viewportElement.getBoundingClientRect();
        pendingZoomRef.current = {
          ratio: next / old,
          cx: event.clientX - rect.left,
          cy: event.clientY - rect.top,
          scrollLeft: viewportElement.scrollLeft,
          scrollTop: viewportElement.scrollTop,
        };
        onZoomToRef.current?.(next);
        return;
      }

      if (event.shiftKey) {
        viewportElement.scrollLeft += event.deltaY + event.deltaX;
        return;
      }

      viewportElement.scrollLeft += event.deltaX;
      viewportElement.scrollTop += event.deltaY;
    }

    viewportElement.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => viewportElement.removeEventListener("wheel", handleNativeWheel);
  }, []);

  function startViewportPan(event: ReactPointerEvent<HTMLDivElement>) {
    const primaryViewerPan = viewerPanMode && event.button === 0;
    const middleMousePan = !viewerPanMode && event.button === 1;
    if (!primaryViewerPan && !middleMousePan) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (viewerPanMode) {
      viewportPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      const points = [...viewportPointersRef.current.values()];
      if (points.length >= 2) {
        const a = points[0]!;
        const b = points[1]!;
        panRef.current = null;
        pinchRef.current = {
          startDistance: Math.max(1, distance(a.clientX, a.clientY, b.clientX, b.clientY)),
          startScale: displayScaleRef.current
        };
        setIsPanning(true);
        return;
      }
    }
    panRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop
    };
    setIsPanning(true);
  }

  function updateViewportPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (viewerPanMode && viewportPointersRef.current.has(event.pointerId)) {
      viewportPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      const points = [...viewportPointersRef.current.values()];
      const pinch = pinchRef.current;
      const viewport = viewportRef.current;
      if (pinch && points.length >= 2 && viewport) {
        const a = points[0]!;
        const b = points[1]!;
        const nextDistance = Math.max(1, distance(a.clientX, a.clientY, b.clientX, b.clientY));
        const nextScale = clamp(pinch.startScale * (nextDistance / pinch.startDistance), 0.05, 8);
        const oldScale = Math.max(0.001, displayScaleRef.current);
        const rect = viewport.getBoundingClientRect();
        pendingZoomRef.current = {
          ratio: nextScale / oldScale,
          cx: (a.clientX + b.clientX) / 2 - rect.left,
          cy: (a.clientY + b.clientY) / 2 - rect.top,
          scrollLeft: viewport.scrollLeft,
          scrollTop: viewport.scrollTop
        };
        event.preventDefault();
        event.stopPropagation();
        onZoomToRef.current?.(nextScale);
        return;
      }
    }

    const pan = panRef.current;
    const viewport = viewportRef.current;
    if (!pan || !viewport || event.pointerId !== pan.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
    viewport.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
  }

  function finishViewportPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (viewerPanMode) {
      viewportPointersRef.current.delete(event.pointerId);
      pinchRef.current = null;
      const viewport = viewportRef.current;
      const remaining = [...viewportPointersRef.current.entries()][0];
      if (remaining && viewport) {
        const [pointerId, point] = remaining;
        panRef.current = {
          pointerId,
          clientX: point.clientX,
          clientY: point.clientY,
          scrollLeft: viewport.scrollLeft,
          scrollTop: viewport.scrollTop
        };
        return;
      }
    }

    const pan = panRef.current;
    if (!pan || event.pointerId !== pan.pointerId) {
      if (viewerPanMode) {
        panRef.current = null;
        setIsPanning(false);
      }
      return;
    }

    panRef.current = null;
    setIsPanning(false);
  }

  function deselectFromEmptyPreviewClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (viewerPanMode) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    // Mask-overlay clicks/drags (selecting a mask, dragging its outline/points) bubble a trailing `click`
    // whose target is an SVG mask element — they must NOT deselect the clip (that would close the inspector
    // mid-edit). The overlay's own pointerdown stops propagation, but the click is separate, so spare it here.
    if (
      target.closest(
        ".preview-text-layer, .preview-shape-layer, .preview-media, .preview-missing-layer, .preview-selection-box, .preview-mask-overlay"
      )
    ) {
      return;
    }

    onSelectLayer(undefined);
  }

  return (
    <div className={`preview-stage preview-quality-${previewQuality} ${viewerPanMode ? "is-viewer-pan-mode" : ""}`} ref={stageRef}>
      {showStats ? <PreviewStatsOverlay /> : null}
      {colorPreviewDegraded ? (
        <div className="preview-color-degraded" role="status">
          {colorWarningsLabel([{ code: "advanced-stage-fallback", severity: "warning", message: "" }])}
        </div>
      ) : null}
      <div className={`preview-tools ${toolsCollapsed ? "is-collapsed" : ""}`} aria-label="Preview tools">
        <button
          type="button"
          className="preview-tools-toggle"
          title={toolsCollapsed ? "Show preview tools" : "Hide preview tools"}
          aria-label={toolsCollapsed ? "Show preview tools" : "Hide preview tools"}
          aria-expanded={!toolsCollapsed}
          onClick={() => {
            setToolsCollapsed((v) => {
              const next = !v;
              try {
                localStorage.setItem("lumio_preview_tools_collapsed", next ? "1" : "0");
              } catch {
                /* ignore storage failures */
              }
              if (next) setGridMenuOpen(false);
              return next;
            });
          }}
        >
          {toolsCollapsed ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
        </button>
        {toolsCollapsed ? null : (
          <>
        <button type="button" className={showSafeArea ? "is-active" : ""} title="Safe areas (title + caption zone)" onClick={() => setShowSafeArea((v) => !v)}>
          <Ratio size={15} />
        </button>
        <div className="preview-tool-menu">
          <button
            ref={gridMenuButtonRef}
            type="button"
            className={gridMode !== "off" ? "is-active" : ""}
            title="Composition guides"
            aria-haspopup="menu"
            aria-expanded={gridMenuOpen}
            onClick={() => setGridMenuOpen((v) => !v)}
          >
            <Grid3x3 size={15} />
          </button>
          {gridMenuOpen && gridMenuRect ? createPortal(
            <div
              className="preview-tool-popover"
              role="menu"
              ref={gridMenuRef}
              style={{ top: gridMenuRect.top, left: gridMenuRect.left, width: gridMenuRect.width, maxHeight: gridMenuRect.maxHeight }}
            >
              {GRID_OPTIONS.map((option) => {
                const active =
                  option.value === "golden-spiral"
                    ? gridMode.startsWith("golden-spiral")
                    : gridMode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={active ? "is-active" : ""}
                    onClick={() => {
                      setGridMode(option.value);
                      if (option.value !== "golden-spiral") setGridMenuOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {active ? <Check size={14} /> : null}
                  </button>
                );
              })}
              {gridMode.startsWith("golden-spiral") ? (
                <>
                  <div className="preview-tool-popover-flip">
                    <span>Corner</span>
                    <div>
                      {SPIRAL_ORIENTATIONS.map((orientation) => (
                        <button
                          key={orientation.value}
                          type="button"
                          className={gridMode === orientation.value ? "is-active" : ""}
                          title={`Spiral ${orientation.label}`}
                          onClick={() => setGridMode(orientation.value)}
                        >
                          {orientation.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="preview-tool-popover-flip">
                    <span>Rotate</span>
                    <div>
                      <button
                        type="button"
                        className={spiralRotate ? "is-active" : ""}
                        title="Rotate the golden rectangle 90° (portrait orientation)"
                        onClick={() => setSpiralRotate((v) => !v)}
                      >
                        90°
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
            </div>,
            document.body
          ) : null}
        </div>
        <button type="button" className={previewBg !== "default" ? "is-active" : ""} title={`Background: ${previewBg}`} onClick={() => setPreviewBg((v) => (v === "default" ? "dark" : v === "dark" ? "light" : v === "light" ? "checker" : "default"))}>
          <SunMoon size={15} />
        </button>
        <button type="button" className={compareBefore ? "is-active" : ""} title="Before / after (bypass color grade)" onClick={() => setCompareBefore((v) => !v)}>
          <Columns2 size={15} />
        </button>
        {onSaveFreezeFrame ? (
          <button type="button" title="Save freeze frame of the selected clip" onClick={() => onSaveFreezeFrame()}>
            <Camera size={15} />
          </button>
        ) : null}
        <button type="button" title="Fullscreen" onClick={toggleFullscreen}>
          <Maximize size={15} />
        </button>
        <button type="button" className={showStats ? "is-active" : ""} title="Playback stats (FPS / dropped frames / render scale)" onClick={() => setShowStats((v) => !v)}>
          <Activity size={15} />
        </button>
        <span className="preview-tools-divider" aria-hidden="true" />
        <button
          type="button"
          className={maskTool === "select" ? "is-active" : ""}
          title="Mask: select / edit (V)"
          onClick={() => onChangeMaskTool?.("select")}
        >
          <MousePointer2 size={15} />
        </button>
        <button
          type="button"
          className={maskTool === "rectangle" ? "is-active" : ""}
          title="Mask: draw rectangle"
          onClick={() => onChangeMaskTool?.("rectangle")}
        >
          <Square size={15} />
        </button>
        <button
          type="button"
          className={maskTool === "ellipse" ? "is-active" : ""}
          title="Mask: draw ellipse"
          onClick={() => onChangeMaskTool?.("ellipse")}
        >
          <Circle size={15} />
        </button>
        <button
          type="button"
          className={maskTool === "polygon" ? "is-active" : ""}
          title="Mask: polygon (click corners, Enter / click first point to close)"
          onClick={() => onChangeMaskTool?.("polygon")}
        >
          <Hexagon size={15} />
        </button>
        <button
          type="button"
          className={maskTool === "pen" ? "is-active" : ""}
          title="Mask: pen / Bezier (click corner, drag for curve, Alt toggles smooth)"
          onClick={() => onChangeMaskTool?.("pen")}
        >
          <PenTool size={15} />
        </button>
        <button
          type="button"
          className={showMasks ? "is-active" : ""}
          title={showMasks ? "Hide mask overlay" : "Show mask overlay"}
          onClick={() => onToggleShowMasks?.()}
        >
          <Eye size={15} />
        </button>
          </>
        )}
      </div>
      {compareBefore ? <div className="preview-compare-badge">Before</div> : null}
      {activeAudioLayerEntries.map(({ layer, track }) => (
        <AudioPreviewLayer
          assets={resolvedAssets}
          currentTime={currentTime}
          isPlaying={isPlaying}
          key={layer.id}
          layer={layer}
          sourceAsset={sourceAsset}
          trackGain={getTrackAudioGainAt(track, currentTime)}
          trackPan={getTrackPanAt(track, currentTime)}
        />
      ))}
      <div
        className={`preview-viewport ${isPanning ? "is-panning" : ""} ${viewerPanMode ? "is-viewer-pan-mode" : ""}`}
        ref={viewportRef}
        onPointerCancel={finishViewportPan}
        onPointerDown={startViewportPan}
        onPointerMove={updateViewportPan}
        onPointerUp={finishViewportPan}
        onClick={deselectFromEmptyPreviewClick}
      >
        <div className="preview-canvas">
          {/* The frame is sized EXPLICITLY to the displayed comp box (comp × displayScale). This is the
              single source of scale — no CSS --viewer-zoom, no nested compositionScale. When the box
              exceeds the viewport (zoomed in past fit) the viewport scrolls/pans. */}
          <div
            className={`phone-frame preview-bg-${previewBg}`}
            ref={mergedPhoneFrameRef}
            style={{
              "--comp-aspect": composition.width / composition.height,
              width: Math.max(1, composition.width * displayScale),
              height: Math.max(1, composition.height * displayScale),
            } as CSSProperties}
          >
            <div
              className="preview-composition-space"
              style={
                {
                  width: composition.width,
                  height: composition.height,
                  transform: `translate3d(-50%, -50%, 0) scale(${displayScale})`
                } as CSSProperties
              }
            >
              <OverlayPortalContext.Provider value={overlayLayer}>
              {/* Frame-cropped content lives in this inner clip; editing overlays (mask/feather handles,
                  selection box, motion path) render OUTSIDE it so their handles stay visible past the edge. */}
              <div className="preview-comp-clip">
              <ColorFilterDefs
                layers={renderedLayerEntries.map((entry) => entry.layer)}
                currentTime={currentTime}
              />
              <MaskDefsAll
                layers={renderedLayerEntries.map((entry) => entry.layer)}
                width={composition.width}
                height={composition.height}
                currentTime={currentTime}
              />
              {/* DOM empty-frame only in DOM mode — in scene mode the always-mounted ScenePreviewCanvas
                  owns the empty/gap background (clears to composition.backgroundColor), so no toggle/flash. */}
              {!sceneEnabled && renderVisualLayerEntries.length === 0 ? <div className="preview-empty-frame" aria-hidden="true" /> : null}
              {sceneEnabled ? (
                <ScenePreviewCanvas
                  layers={sceneLayers}
                  width={composition.width}
                  height={composition.height}
                  backgroundColor={composition.backgroundColor || "#000000"}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  gradedRef={gradedCanvasesRef}
                  onFailure={() => setSceneFailed(true)}
                  redrawRef={sceneRedrawRef}
                  renderScale={playbackRenderScale}
                  transitions={transitionPairs}
                  onFrameRendered={(timeSeconds) => onPreviewFrameRendered?.(timeSeconds, playbackRenderScale)}
                  mediaSourceAlias={sceneSharedMediaClones}
                  nestedGroups={nestExpansion.groups}
                  captureRef={proxyCaptureRef}
                  prewarmTransitionIds={prewarmTransitionIds}
                  singleCtxMedia={sceneEnabled && singleCtxPreview}
                  mediaSourcesRef={sceneMediaSourcesRef}
                />
              ) : null}
              {resolveProxyPlayback ? (
                <ProxyPlaybackLayer
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  resolveProxyPlayback={resolveProxyPlayback}
                  // Coverage exiting into a live region: the layers under the overlay decoded
                  // unobserved and may have silently wedged — re-prime them before/at the reveal so
                  // the uncovered picture is live, not frozen (2026-07-06 build freeze).
                  onCoverageEnding={requestLiveReprime}
                  onCoverageEnd={requestLiveReprime}
                />
              ) : null}
              {renderedLayerEntries.map(({ layer, pending }) => (
                // A shared region-blur clone reads the base's graded canvas in scene mode — don't mount its
                // own <video> decoder + GL context (kills the "too many WebGL contexts" eviction). With the
                // pass model on, NO clone needs a mount (blur/color passes work off the running nest image);
                // a runtime scene failure flips sceneEnabled → clones mount again for the DOM path.
                sceneEnabled && (sceneSharedMediaClones.has(layer.id) || (regionPassesOn && layer.id.includes("__rfx_"))) ? null : (
                <Fragment key={layer.id}>
                  <PreviewLayer
                    currentTime={currentTime}
                    isPlaying={isPlaying}
                    layer={layer}
                    pending={pending}
                    onMoveLayer={onMoveLayer}
                    onMovePositionKeyframe={onMovePositionKeyframe}
                    onMoveSpatialHandle={onMoveSpatialHandle}
                    onResizeShapeLayer={onResizeShapeLayer}
                    onRotateLayer={onRotateLayer}
                    onScaleLayer={onScaleLayer}
                    onCropLayer={onCropLayer}
                    onSelectLayer={onSelectLayer}
                    frameAspect={composition.width / composition.height}
                    rotationSnapEnabled={rotationSnapEnabled}
                    selected={!viewerPanMode && !pending && selectedLayerId === layer.id}
                    interactive={!viewerPanMode && realLayerIds.has(layer.id)}
                    assets={resolvedAssets}
                    sourceAsset={sourceAsset}
                    // DOM-transition hide (visibility:hidden) is for the DOM path's incoming clip only;
                    // scene-composited media is hidden via opacity:0 (sceneComposited) so it stays clickable.
                    hideForTransition={transitionHiddenIds.has(layer.id)}
                    sceneComposited={sceneEnabled && sceneMediaIds.has(layer.id)}
                    hideVisual={sceneEnabled && sceneOverlayIds.has(layer.id)}
                    // Scene-composited media: don't bake opacity into the grade — ScenePreviewCanvas
                    // applies it LIVE at composite (no stale opacity on seek/pause). DOM + transition-active
                    // clips (drawn by the DOM overlay) still bake — hence `sceneLayerIds`, not sceneMediaIds.
                    bakeOpacity={!sceneLayerIds.has(layer.id)}
                    bypassColor={compareBefore}
                    // Single-ctx preview: media publishes a raw frame to the sink instead of grading into a
                    // canvas — so onGradedFrame is suppressed for those layers (the sink drives recomposite).
                    onGradedFrame={
                      !(sceneEnabled && singleCtxPreview && sceneMediaIds.has(layer.id)) &&
                      (transitionSourceIds.has(layer.id) || (sceneEnabled && sceneMediaIds.has(layer.id)))
                        ? (canvas) => {
                            gradedCanvasesRef.current[layer.id] = canvas;
                            // A fresh graded frame landed — re-arm the scene recomposite so a paused edit
                            // (opacity/grade/etc., re-graded by WebglMediaLayer) shows immediately, not just
                            // via the settle window. Cheap (sets a timestamp ref); harmless while playing.
                            sceneRedrawRef.current?.();
                          }
                        : undefined
                    }
                    sceneMediaSink={
                      sceneEnabled && singleCtxPreview && sceneMediaIds.has(layer.id)
                        ? getSceneMediaSink(layer.id)
                        : undefined
                    }
                  />
                  {/* DOM transition overlay — suppressed in scene mode (Phase 4.2): the scene pass mixes
                      the junction in-canvas via ScenePreviewCanvas's TransitionCompositor, so a DOM overlay
                      on top would double-render. The DOM path keeps using it. */}
                  {(sceneEnabled ? [] : (overlaysByAnchorId.get(layer.id) ?? [])).map((pair) => (
                    <TransitionOverlay
                      key={`${pair.outgoingId}->${pair.incomingId}`}
                      spec={pair.spec}
                      startSeconds={pair.startSeconds}
                      clipDurationSeconds={pair.incomingDurationSeconds}
                      currentTime={currentTime}
                      isPlaying={isPlaying}
                      width={composition.width}
                      height={composition.height}
                      fromId={pair.outgoingId}
                      toId={pair.incomingId}
                      fromFit={pair.fromFit}
                      toFit={pair.toFit}
                      gradedRef={gradedCanvasesRef}
                    />
                  ))}
                </Fragment>
              )
              ))}
              {hasBehindText ? <div className="behind-text">FORGE</div> : null}
              {hasTracking ? (
                <div className="tracking-layer">
                  <span />
                  <span />
                  <span />
                  <strong>3D FOLLOW</strong>
                </div>
              ) : null}
              <PreviewGuides mode={gridMode} rotate={spiralRotate} width={composition.width} height={composition.height} />
              {showSafeArea ? (
                <div className="preview-overlay preview-safe-area" aria-hidden="true">
                  <div className="safe-title" />
                  <div className="safe-action" />
                  {isPortrait ? <div className="safe-caption" /> : null}
                </div>
              ) : null}
              </div>
              {!viewerPanMode && showMasks && maskActiveLayer && isLayerActive(maskActiveLayer, currentTime) ? (
                <MaskEditorOverlay
                  layer={maskActiveLayer}
                  masks={maskEditMasks}
                  currentTime={currentTime}
                  width={composition.width}
                  height={composition.height}
                  scale={displayScale}
                  tool={maskTool}
                  activeMaskId={activeMaskId}
                  onSelectMask={onSelectMask}
                  onChangeMaskTool={onChangeMaskTool}
                  onUpdateLayerMasks={onUpdateLayerMasks}
                  onCommitMaskPoints={onCommitMaskPoints}
                  onPreviewMaskScalar={onPreviewMaskScalar}
                />
              ) : null}
              {/* Portal target for selection/motion overlays — sibling of the clip, so it isn't cropped. */}
              <div ref={setOverlayLayer} className="preview-overlay-layer" aria-hidden="true" />
              </OverlayPortalContext.Provider>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type VideoPreviewProps = Parameters<typeof VideoPreviewImpl>[0];

/**
 * VideoPreview is CLOCK-DRIVEN in the editor (`clockDriven`): its playhead time comes from the
 * playback-clock store via `usePlaybackClock`, which EditorPage pushes on EVERY seek/scrub tick
 * synchronously. So the `currentTime` PROP is redundant there — the store already keeps the preview
 * live. This comparator skips a re-render when only `currentTime` changed (the 120ms cold-commit
 * mirror), killing the single biggest per-seek render (~220ms: the whole preview + every PreviewLayer
 * re-rendering for a time value it already has). Every OTHER prop still forces a re-render via
 * Object.is — real edits, selection, assets, masks all flow through untouched. When NOT clockDriven
 * (PreviewFixturePage / SmartFollowTextToolPanel pass a fixed prop time) currentTime is compared
 * normally, so those hosts keep prop-driven behavior. All function props are identity-stabilized at
 * the EditorPage call site (useStableHandler), so they don't spuriously break this.
 */
function areVideoPreviewPropsEqual(prev: VideoPreviewProps, next: VideoPreviewProps): boolean {
  const prevKeys = Object.keys(prev) as (keyof VideoPreviewProps)[];
  const nextKeys = Object.keys(next) as (keyof VideoPreviewProps)[];
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of nextKeys) {
    if (key === "currentTime" && next.clockDriven) continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  return true;
}

export const VideoPreview = memo(VideoPreviewImpl, areVideoPreviewPropsEqual);

type PreviewLayerProps = {
  currentTime: number;
  isPlaying: boolean;
  layer: TimelineLayer;
  selected: boolean;
  /** False for render-only region-mask clones (`__rfx_` ids): pixels only, no select/drag, pointer-transparent
   *  so clicks fall through to the real base layer. Defaults true for normal layers. */
  interactive?: boolean;
  /** This clip is the incoming side of an active GPU transition — hide it; the overlay shows the mix. */
  hideForTransition?: boolean;
  /** Scene compositor renders this text/shape layer in the GPU pass — hide its DOM visual, keep handles. */
  hideVisual?: boolean;
  /** Scene compositor draws this MEDIA clip — hide the DOM canvas via opacity:0 but keep it click-selectable. */
  sceneComposited?: boolean;
  /** Before/after compare: skip the color grade so the original (ungraded) frame shows. */
  bypassColor?: boolean;
  /** Report the graded canvas so the transition overlay can sample it as a from/to texture. */
  onGradedFrame?: ((canvas: HTMLCanvasElement) => void) | undefined;
  /** Single-ctx preview (Phase 5): publish this media layer's raw frame source to the scene compositor
   *  (no own GL context); set only for scene-composited media when `lumio.singleCtxPreview` is on. */
  sceneMediaSink?: SceneMediaSink | undefined;
  /** False for scene-composited media → opacity is applied LIVE at composite, not baked (no seek staleness). */
  bakeOpacity?: boolean | undefined;
  // True while this layer is mounted ahead of its start time purely to let its
  // <video> seek to the right source frame in the background, so the cut to it
  // doesn't show a black/stale frame. Invisible and non-interactive until active.
  pending?: boolean;
  assets: SourceAsset[];
  sourceAsset?: SourceAsset | null | undefined;
  onMoveLayer?: ((layerId: string, position: { x: number; y: number }, commit: boolean) => void) | undefined;
  onMovePositionKeyframe?: ((layerId: string, timeSeconds: number, position: { x: number; y: number }, commit: boolean) => void) | undefined;
  onMoveSpatialHandle?:
    | ((layerId: string, timeSeconds: number, handle: "in" | "out", tangent: { x: number; y: number }, linked: boolean, commit: boolean) => void)
    | undefined;
  onResizeShapeLayer?: ((layerId: string, size: { widthPercent: number; heightPercent: number }, commit: boolean) => void) | undefined;
  onRotateLayer?: ((layerId: string, rotation: number, commit: boolean) => void) | undefined;
  onScaleLayer?: ((layerId: string, scale: number, commit: boolean) => void) | undefined;
  onCropLayer?: ((layerId: string, edge: "top" | "right" | "bottom" | "left", value: number, commit: boolean) => void) | undefined;
  /** Composition frame aspect (w/h) — lets a `contain` media layer's selection box hug the source's natural
   *  rect (adaptive handles) instead of framing the whole canvas. */
  frameAspect?: number | undefined;
  onSelectLayer: (layerId: string) => void;
  rotationSnapEnabled?: boolean | undefined;
};

type PreviewTransformHud = {
  mode: "rotate" | "scale" | "size";
  primary: string;
  secondary?: string | undefined;
  snapped?: boolean | undefined;
};

/**
 * Skip re-rendering a layer subtree on a pure playback tick when its pixels come from the imperative
 * scene draw loop, NOT its DOM (Playback Jank Patch 1). Only a scene-rasterized text/shape overlay
 * (`hideVisual`) qualifies: its visible output is the GPU scene raster (evaluated at LIVE time inside
 * buildSceneDraws), its DOM is opacity:0, and — because we require `!selected` — no selection handles
 * need to track it. Media is deliberately NOT skipped: a keyframed color grade flows through its
 * `pipeline` prop, so it must re-render each tick. Paused scrubbing, DOM-mode animation, and selected
 * layers all fall through to a full compare → byte-identical behavior to before.
 */
function arePreviewLayerPropsEqual(prev: PreviewLayerProps, next: PreviewLayerProps): boolean {
  const keys = Object.keys(next) as (keyof PreviewLayerProps)[];
  if (keys.length !== Object.keys(prev).length) return false;
  const canIgnoreTime = next.isPlaying && !next.selected && Boolean(next.hideVisual);
  for (const key of keys) {
    // onGradedFrame is a fresh closure each render but captures only stable refs + layer.id, so its
    // identity is not meaningful — compare by presence (guards a future text-layer onGradedFrame too).
    if (key === "onGradedFrame") {
      if (Boolean(prev.onGradedFrame) !== Boolean(next.onGradedFrame)) return false;
      continue;
    }
    // sceneMediaSink is a per-layer cached (stable) object — but guard by presence anyway so toggling
    // single-ctx mode on/off flips the render path (compare identity is meaningless here).
    if (key === "sceneMediaSink") {
      if (Boolean(prev.sceneMediaSink) !== Boolean(next.sceneMediaSink)) return false;
      continue;
    }
    if (key === "currentTime" && canIgnoreTime) continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  return true;
}

const PreviewLayer = memo(function PreviewLayer({
  currentTime,
  isPlaying,
  layer,
  selected,
  interactive = true,
  pending = false,
  assets,
  sourceAsset,
  onMoveLayer,
  onMovePositionKeyframe,
  onMoveSpatialHandle,
  onResizeShapeLayer,
  onRotateLayer,
  onScaleLayer,
  onCropLayer,
  onSelectLayer,
  frameAspect,
  rotationSnapEnabled = false,
  hideForTransition = false,
  hideVisual = false,
  sceneComposited = false,
  bypassColor = false,
  onGradedFrame,
  sceneMediaSink,
  bakeOpacity = true
}: PreviewLayerProps) {
  bumpRenderCount("PreviewLayer");
  const warpTextSvg = useWarpedTextSvg(layer, currentTime);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Unified WebGL render path (rendererMode=webgl). If the shared MediaWebGLRenderer
  // fails to init at runtime, flip this and fall back to the legacy SVG-filter DOM path.
  const [webglMediaFailed, setWebglMediaFailed] = useState(false);
  const useWebglMedia = useWebglRenderer(webgl2Supported()) && !webglMediaFailed;
  const dragRef = useRef<{
    layerId: string;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    surfaceWidth: number;
    surfaceHeight: number;
    moved: boolean;
  } | null>(null);
  const resizeRef = useRef<{
    layerId: string;
    pointerId: number;
    centerClientX: number;
    centerClientY: number;
    startDistance: number;
    startScale: number;
    startWidthPercent: number;
    startHeightPercent: number;
    surfaceWidth: number;
    surfaceHeight: number;
    moved: boolean;
  } | null>(null);
  // Edge-handle crop drag. Frame px extents (bounds × evaluated scale) let a pixel drag become a
  // content.crop fraction; startRotationRad de-rotates the pointer delta into the clip's own axes.
  const cropRef = useRef<{
    layerId: string;
    pointerId: number;
    edge: "top" | "right" | "bottom" | "left";
    startClientX: number;
    startClientY: number;
    startValue: number;
    frameWpx: number;
    frameHpx: number;
    startRotationRad: number;
    moved: boolean;
  } | null>(null);
  const rotateRef = useRef<{
    layerId: string;
    pointerId: number;
    centerClientX: number;
    centerClientY: number;
    startAngle: number;
    startRotation: number;
    moved: boolean;
  } | null>(null);
  const pathPointDragRef = useRef<{
    layerId: string;
    pointerId: number;
    timeSeconds: number;
    surfaceWidth: number;
    surfaceHeight: number;
  } | null>(null);
  const spatialHandleDragRef = useRef<{
    handle: "in" | "out";
    layerId: string;
    pointerId: number;
    surfaceWidth: number;
    surfaceHeight: number;
    timeSeconds: number;
  } | null>(null);
  const asset = resolveLayerAsset(layer, assets, sourceAsset);
  const mediaUrl = resolvePlaybackUrl(asset);
  // Adaptive selection box: a `contain` media layer paints its source at natural aspect (letterboxed inside
  // the frame), so the selection box + handles should hug that rect — not the whole canvas. We measure the
  // source's TRUE intrinsic aspect from the decoded image (asset.width/height metadata is often wrong or
  // missing for generated graphics), falling back to the stored dims. undefined for cover/fill/text/shape.
  const [measuredAspect, setMeasuredAspect] = useState<number | undefined>(undefined);
  useEffect(() => {
    setMeasuredAspect(undefined);
    if (!mediaUrl || layer.type !== "image") return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive && img.naturalWidth > 0 && img.naturalHeight > 0) setMeasuredAspect(img.naturalWidth / img.naturalHeight);
    };
    img.src = mediaUrl;
    return () => {
      alive = false;
      img.onload = null;
    };
  }, [mediaUrl, layer.type]);
  const metadataAspect = asset && asset.width && asset.height ? asset.width / asset.height : undefined;
  const sourceAspect = measuredAspect ?? metadataAspect;
  const contentBoxOverride = contentBoxSizeOverride(layer, sourceAspect, frameAspect);
  const isVideo = layer.type === "video" && Boolean(mediaUrl) && (asset?.fileType.startsWith("video/") ?? true);
  // First-frame still at the clip's in-point — held over the canvas/video until the real frame
  // decodes so the viewer never shows black (start, cut, or seek). Captured once, cached.
  const videoPoster = useVideoPoster(isVideo ? mediaUrl : undefined, layer.sourceInSeconds ?? 0);
  // A pending layer is only mounted to pre-seek; it must never actually play.
  const effectivePlaying = isPlaying && !pending;
  const [transformHud, setTransformHud] = useState<PreviewTransformHud | null>(null);
  const transformHudTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (transformHudTimerRef.current !== null) {
        window.clearTimeout(transformHudTimerRef.current);
      }
    };
  }, []);

  function showTransformHud(nextHud: PreviewTransformHud, hold = false) {
    if (transformHudTimerRef.current !== null) {
      window.clearTimeout(transformHudTimerRef.current);
      transformHudTimerRef.current = null;
    }
    setTransformHud(nextHud);
    if (hold) {
      transformHudTimerRef.current = window.setTimeout(() => {
        transformHudTimerRef.current = null;
        setTransformHud(null);
      }, 900);
    }
  }

  function startPreviewDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!onMoveLayer || event.button !== 0 || layer.locked) {
      return;
    }

    const surface = event.currentTarget.closest(".preview-composition-space");
    if (!(surface instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectLayer(layer.id);
    const bounds = surface.getBoundingClientRect();
    dragRef.current = {
      layerId: layer.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: layer.transform.position.x,
      startY: layer.transform.position.y,
      surfaceWidth: bounds.width,
      surfaceHeight: bounds.height,
      moved: false
    };
    if (layer.type === "shape") {
      showTransformHud(sizeHud(layer.widthPercent ?? 44, layer.heightPercent ?? 18));
    } else {
      showTransformHud(scaleHud(layer.transform.scale));
    }
  }

  function updatePreviewDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || !onMoveLayer || event.pointerId !== drag.pointerId) {
      return;
    }

    event.preventDefault();
    const nextPosition = positionFromDrag(event, drag);
    drag.moved = drag.moved || Math.abs(event.clientX - drag.startClientX) > 2 || Math.abs(event.clientY - drag.startClientY) > 2;
    onMoveLayer(drag.layerId, nextPosition, false);
  }

  function finishPreviewDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || !onMoveLayer || event.pointerId !== drag.pointerId) {
      return;
    }

    event.preventDefault();
    const nextPosition = positionFromDrag(event, drag);
    dragRef.current = null;
    onMoveLayer(drag.layerId, nextPosition, true);
  }

  function handlePreviewClick(event: ReactMouseEvent<HTMLElement>) {
    const drag = dragRef.current;
    const resize = resizeRef.current;
    if (drag?.moved || resize?.moved) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    onSelectLayer(layer.id);
  }

  function startPreviewResize(event: ReactPointerEvent<HTMLSpanElement>) {
    // Edge handles (N/E/S/W) crop media; corner handles (NW/NE/SW/SE) scale. Shapes/text have no source to
    // crop, so all of their handles keep scaling/resizing. The edge is encoded in the handle's className.
    const cropEdge = mediaCropEdgeFromHandle(event.currentTarget);
    if (cropEdge && onCropLayer && (layer.type === "video" || layer.type === "image")) {
      startPreviewCrop(event, cropEdge);
      return;
    }
    if ((!onScaleLayer && !onResizeShapeLayer) || event.button !== 0 || layer.locked) {
      return;
    }

    const surface = event.currentTarget.closest(".preview-composition-space");
    if (!(surface instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectLayer(layer.id);
    const bounds = surface.getBoundingClientRect();
    const centerClientX = bounds.left + (layer.transform.position.x / 100) * bounds.width;
    const centerClientY = bounds.top + (layer.transform.position.y / 100) * bounds.height;
    resizeRef.current = {
      layerId: layer.id,
      pointerId: event.pointerId,
      centerClientX,
      centerClientY,
      startDistance: Math.max(12, distance(event.clientX, event.clientY, centerClientX, centerClientY)),
      startScale: layer.transform.scale,
      startWidthPercent: layer.widthPercent ?? 44,
      startHeightPercent: layer.heightPercent ?? 18,
      surfaceWidth: bounds.width,
      surfaceHeight: bounds.height,
      moved: false
    };
  }

  function updatePreviewResize(event: ReactPointerEvent<HTMLSpanElement>) {
    if (cropRef.current) {
      updatePreviewCrop(event);
      return;
    }
    const resize = resizeRef.current;
    if (!resize || event.pointerId !== resize.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (layer.type === "shape" && onResizeShapeLayer) {
      const nextSize = shapeSizeFromResize(event, resize);
      resize.moved = resize.moved || Math.abs(nextSize.widthPercent - resize.startWidthPercent) > 0.2 || Math.abs(nextSize.heightPercent - resize.startHeightPercent) > 0.2;
      showTransformHud(sizeHud(nextSize.widthPercent, nextSize.heightPercent));
      onResizeShapeLayer(resize.layerId, nextSize, false);
      return;
    }

    if (onScaleLayer) {
      const nextScale = scaleFromResize(event, resize);
      resize.moved = resize.moved || Math.abs(nextScale - resize.startScale) > 0.01;
      showTransformHud(scaleHud(nextScale));
      onScaleLayer(resize.layerId, nextScale, false);
    }
  }

  function finishPreviewResize(event: ReactPointerEvent<HTMLSpanElement>) {
    if (cropRef.current) {
      finishPreviewCrop(event);
      return;
    }
    const resize = resizeRef.current;
    if (!resize || event.pointerId !== resize.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = null;
    if (layer.type === "shape" && onResizeShapeLayer) {
      const nextSize = shapeSizeFromResize(event, resize);
      showTransformHud(sizeHud(nextSize.widthPercent, nextSize.heightPercent), true);
      onResizeShapeLayer(resize.layerId, nextSize, true);
      return;
    }

    if (onScaleLayer) {
      const nextScale = scaleFromResize(event, resize);
      showTransformHud(scaleHud(nextScale), true);
      onScaleLayer(resize.layerId, nextScale, true);
    }
  }

  function startPreviewCrop(event: ReactPointerEvent<HTMLSpanElement>, edge: "top" | "right" | "bottom" | "left") {
    if (!onCropLayer || event.button !== 0 || layer.locked) {
      return;
    }
    const surface = event.currentTarget.closest(".preview-composition-space");
    if (!(surface instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectLayer(layer.id);
    const bounds = surface.getBoundingClientRect();
    const evaluated = getCompositionTransform(layer, { currentTimeSeconds: currentTime });
    const crop = getCompositionContentTransform(layer, { currentTimeSeconds: currentTime }).crop;
    cropRef.current = {
      layerId: layer.id,
      pointerId: event.pointerId,
      edge,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startValue: crop[edge],
      frameWpx: Math.max(1, bounds.width * evaluated.scale),
      frameHpx: Math.max(1, bounds.height * evaluated.scale),
      startRotationRad: (evaluated.rotation * Math.PI) / 180,
      moved: false
    };
  }

  function cropValueFromDrag(event: ReactPointerEvent<HTMLSpanElement>, crop: NonNullable<typeof cropRef.current>): number {
    // De-rotate the screen-space pointer delta into the clip's local axes, then convert to a frame fraction.
    const dxScreen = event.clientX - crop.startClientX;
    const dyScreen = event.clientY - crop.startClientY;
    const cos = Math.cos(-crop.startRotationRad);
    const sin = Math.sin(-crop.startRotationRad);
    const dxLocal = dxScreen * cos - dyScreen * sin;
    const dyLocal = dxScreen * sin + dyScreen * cos;
    // Dragging an edge toward the clip center adds crop on that edge (trims it).
    const delta =
      crop.edge === "left" ? dxLocal / crop.frameWpx
      : crop.edge === "right" ? -dxLocal / crop.frameWpx
      : crop.edge === "top" ? dyLocal / crop.frameHpx
      : -dyLocal / crop.frameHpx;
    return Math.max(0, Math.min(0.95, crop.startValue + delta));
  }

  function updatePreviewCrop(event: ReactPointerEvent<HTMLSpanElement>) {
    const crop = cropRef.current;
    if (!crop || !onCropLayer || event.pointerId !== crop.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const nextValue = cropValueFromDrag(event, crop);
    crop.moved = crop.moved || Math.abs(nextValue - crop.startValue) > 0.002;
    showTransformHud(cropHud(crop.edge, nextValue));
    onCropLayer(crop.layerId, crop.edge, nextValue, false);
  }

  function finishPreviewCrop(event: ReactPointerEvent<HTMLSpanElement>) {
    const crop = cropRef.current;
    if (!crop || !onCropLayer || event.pointerId !== crop.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    cropRef.current = null;
    const nextValue = cropValueFromDrag(event, crop);
    showTransformHud(cropHud(crop.edge, nextValue), true);
    onCropLayer(crop.layerId, crop.edge, nextValue, true);
  }

  function startPreviewRotate(event: ReactPointerEvent<HTMLSpanElement>) {
    if (!onRotateLayer || event.button !== 0 || layer.locked) {
      return;
    }

    const surface = event.currentTarget.closest(".preview-composition-space");
    if (!(surface instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectLayer(layer.id);
    const bounds = surface.getBoundingClientRect();
    const centerClientX = bounds.left + (layer.transform.position.x / 100) * bounds.width;
    const centerClientY = bounds.top + (layer.transform.position.y / 100) * bounds.height;
    rotateRef.current = {
      layerId: layer.id,
      pointerId: event.pointerId,
      centerClientX,
      centerClientY,
      startAngle: angleDegrees(event.clientX, event.clientY, centerClientX, centerClientY),
      startRotation: layer.transform.rotation,
      moved: false
    };
    showTransformHud(rotationHud(layer.transform.rotation, false));
  }

  function updatePreviewRotate(event: ReactPointerEvent<HTMLSpanElement>) {
    const rotate = rotateRef.current;
    if (!rotate || !onRotateLayer || event.pointerId !== rotate.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const nextRotation = rotationFromPointerWithSnap(event, rotate, rotationSnapEnabled);
    rotate.moved = rotate.moved || Math.abs(nextRotation.value - rotate.startRotation) > 1;
    showTransformHud(rotationHud(nextRotation.value, nextRotation.snapped));
    onRotateLayer(rotate.layerId, nextRotation.value, false);
  }

  function finishPreviewRotate(event: ReactPointerEvent<HTMLSpanElement>) {
    const rotate = rotateRef.current;
    if (!rotate || !onRotateLayer || event.pointerId !== rotate.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const nextRotation = rotationFromPointerWithSnap(event, rotate, rotationSnapEnabled);
    rotateRef.current = null;
    showTransformHud(rotationHud(nextRotation.value, nextRotation.snapped), true);
    onRotateLayer(rotate.layerId, nextRotation.value, true);
  }

  function startMotionPathPointDrag(event: ReactPointerEvent<SVGCircleElement>, timeSeconds: number) {
    if (!onMovePositionKeyframe || event.button !== 0 || layer.locked) {
      return;
    }

    const surface = event.currentTarget.closest(".preview-composition-space");
    if (!(surface instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectLayer(layer.id);
    const bounds = surface.getBoundingClientRect();
    pathPointDragRef.current = {
      layerId: layer.id,
      pointerId: event.pointerId,
      timeSeconds,
      surfaceWidth: bounds.width,
      surfaceHeight: bounds.height
    };
  }

  function updateMotionPathPointDrag(event: ReactPointerEvent<SVGCircleElement>) {
    const drag = pathPointDragRef.current;
    if (!drag || !onMovePositionKeyframe || drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onMovePositionKeyframe(drag.layerId, drag.timeSeconds, positionFromSurfacePoint(event, drag), false);
  }

  function finishMotionPathPointDrag(event: ReactPointerEvent<SVGCircleElement>) {
    const drag = pathPointDragRef.current;
    if (!drag || !onMovePositionKeyframe || drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onMovePositionKeyframe(drag.layerId, drag.timeSeconds, positionFromSurfacePoint(event, drag), true);
    pathPointDragRef.current = null;
  }

  function startSpatialHandleDrag(event: ReactPointerEvent<SVGCircleElement>, timeSeconds: number, handle: "in" | "out") {
    if (!onMoveSpatialHandle || event.button !== 0 || layer.locked) {
      return;
    }

    const surface = event.currentTarget.closest(".preview-composition-space");
    if (!(surface instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectLayer(layer.id);
    const bounds = surface.getBoundingClientRect();
    spatialHandleDragRef.current = {
      handle,
      layerId: layer.id,
      pointerId: event.pointerId,
      surfaceWidth: bounds.width,
      surfaceHeight: bounds.height,
      timeSeconds
    };
  }

  function updateSpatialHandleDrag(event: ReactPointerEvent<SVGCircleElement>) {
    const drag = spatialHandleDragRef.current;
    if (!drag || !onMoveSpatialHandle || drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onMoveSpatialHandle(drag.layerId, drag.timeSeconds, drag.handle, tangentFromSurfacePoint(event, drag, positionAtLayerTime(layer, drag.timeSeconds)), !event.altKey, false);
  }

  function finishSpatialHandleDrag(event: ReactPointerEvent<SVGCircleElement>) {
    const drag = spatialHandleDragRef.current;
    if (!drag || !onMoveSpatialHandle || drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onMoveSpatialHandle(drag.layerId, drag.timeSeconds, drag.handle, tangentFromSurfacePoint(event, drag, positionAtLayerTime(layer, drag.timeSeconds)), !event.altKey, true);
    spatialHandleDragRef.current = null;
  }

  // Render-only region clones are pointer-transparent (no handlers + pointerEvents:none below) so clicks fall
  // through to the real base layer; only real layers get the select/drag handlers.
  const dragHandlers = interactive
    ? {
        onClick: handlePreviewClick,
        onPointerCancel: finishPreviewDrag,
        onPointerDown: startPreviewDrag,
        onPointerMove: updatePreviewDrag,
        onPointerUp: finishPreviewDrag
      }
    : undefined;

  // Speed-ramp "tangent": the matte/WC sync paths map time LINEARLY (sourceIn + local × speed).
  // For ramped clips pass per-tick effective values so that linear map equals the exact integral
  // AT the current time — those components' contract stays unchanged, and their 0.08s resync
  // threshold absorbs the within-tick curvature. Null for constant-speed clips (path untouched).
  const rampTangent = (() => {
    if (!hasSpeedRamp(layer)) return null;
    const local = Math.max(0, currentTime - layer.startSeconds);
    const speed = getLayerSpeedAt(layer, local);
    return { speed, sourceIn: layerSourceTimeSeconds(layer, local) - local * speed };
  })();

  function syncVideoTime(video: HTMLVideoElement) {
    // Source-aware: offset into the source media so trimmed/split clips play the correct source frame.
    // The clamp is the asset's available media (not just the clip's visible span) so that during a
    // transition post-roll the outgoing clip can play a little past its out-point into its tail handle
    // (held at the last real frame when there's no spare media) — exactly like a pro editor's handles.
    // Speed-aware (rate stretch + ramps): timeline→source through the shared mapper — for ramped
    // clips the exact closed-form integral, for constant speed the same product as before.
    const speed = getLayerSpeedAt(layer, Math.max(0, currentTime - layer.startSeconds));
    const sourceIn = layer.sourceInSeconds ?? 0;
    const rawSource = layerSourceTimeSeconds(layer, Math.max(0, currentTime - layer.startSeconds)) - sourceIn;
    const maxSource = asset?.durationSeconds != null ? Math.max(0, asset.durationSeconds - sourceIn - 0.05) : rawSource;
    const nextTime = sourceIn + Math.max(0, Math.min(maxSource, rawSource));
    if (Number.isFinite(nextTime) && Math.abs(video.currentTime - nextTime) > 0.08 * Math.max(1, speed)) {
      video.currentTime = nextTime;
    }
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo) {
      return;
    }

    // Rate stretch: the element free-runs at the clip speed while playing. preservesPitch=false
    // (varispeed) matches the export mixer's AudioBufferSourceNode behavior.
    video.playbackRate = getLayerSpeed(layer);
    if ("preservesPitch" in video) {
      (video as HTMLVideoElement & { preservesPitch: boolean }).preservesPitch = false;
    }
    if (effectivePlaying) {
      syncVideoTime(video);
      void video.play().catch(() => undefined);
      return;
    }

    video.pause();
    syncVideoTime(video);
  }, [effectivePlaying, isVideo, layer.id, layer.speed, mediaUrl]);

  // Speed ramp: the element can't free-run a VARYING rate — follow the ramp per tick (instantaneous
  // rate + the integral resync in syncVideoTime keeps it frame-honest within the 0.08s threshold).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo || !hasSpeedRamp(layer)) {
      return;
    }
    video.playbackRate = getLayerSpeedAt(layer, Math.max(0, currentTime - layer.startSeconds));
    if (effectivePlaying) {
      syncVideoTime(video);
    }
  }, [currentTime, effectivePlaying, isVideo, layer, mediaUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo || effectivePlaying) {
      return;
    }

    syncVideoTime(video);
  }, [currentTime, effectivePlaying, isVideo, layer.startSeconds, mediaUrl]);

  // MID-PLAY JUMP resync. While playing, nothing seeked the element on a ruler jump — the 500ms
  // drift corrector below eventually snapped it, so after a backward jump the picture kept playing
  // from the PRE-jump position for up to half a second ("catching up", 2026-07-04 soak). Seek
  // immediately on JUMP-scale drift only (>1s): ordinary decode drift stays with the gentle
  // 0.15s/500ms corrector, so this can never seek-storm during normal playback.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo || !effectivePlaying) {
      return;
    }
    const speed = getLayerSpeedAt(layer, Math.max(0, currentTime - layer.startSeconds));
    const sourceIn = layer.sourceInSeconds ?? 0;
    const rawSource = layerSourceTimeSeconds(layer, Math.max(0, currentTime - layer.startSeconds)) - sourceIn;
    const maxSource = asset?.durationSeconds != null ? Math.max(0, asset.durationSeconds - sourceIn - 0.05) : rawSource;
    const expected = sourceIn + Math.max(0, Math.min(maxSource, rawSource));
    if (Number.isFinite(expected) && Math.abs(video.currentTime - expected) > 1 * Math.max(1, speed)) {
      video.currentTime = expected;
    }
  }, [currentTime, effectivePlaying, isVideo, layer, mediaUrl, asset?.durationSeconds]);

  // Playback drift correction for the VIDEO element — the exact mirror of the audio corrector
  // below (see "NON-master playback drift correction"): while playing, a play()-start latency or a
  // decode hiccup left the element permanently offset from the clock because NOTHING re-synced it
  // until pause (the paused-only sync above) — so pausing visibly "jumped" the frame to the true
  // time (2026-07-03 report: boat positions differ between live playback and the paused frame at
  // the same ruler position). Coarse threshold + infrequent tick = no seek storms; ramped clips
  // are excluded (their per-tick effect above already resyncs through the exact integral).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo || !effectivePlaying || hasSpeedRamp(layer)) {
      return;
    }
    const interval = window.setInterval(() => {
      if (video.paused || video.seeking || video.readyState < 2) return;
      const local = Math.max(0, Math.min(layer.durationSeconds, getPlaybackClock() - layer.startSeconds));
      const speed = getLayerSpeedAt(layer, local);
      const sourceIn = layer.sourceInSeconds ?? 0;
      const rawSource = layerSourceTimeSeconds(layer, local) - sourceIn;
      const maxSource = asset?.durationSeconds != null ? Math.max(0, asset.durationSeconds - sourceIn - 0.05) : rawSource;
      const expected = sourceIn + Math.max(0, Math.min(maxSource, rawSource));
      if (Number.isFinite(expected) && Math.abs(video.currentTime - expected) > 0.15 * Math.max(1, speed)) {
        video.currentTime = expected;
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [effectivePlaying, isVideo, layer, mediaUrl, asset?.durationSeconds]);

  if (layer.type === "text") {
    const style = getCompositionTextStyle(layer, { currentTimeSeconds: currentTime });
    const visibleRuns = getVisibleTextRuns(layer, currentTime);
    // Warp renders as a vector <path> overlay (opentype outline + envelope mesh). The
    // HTML runs stay for box sizing/selection but go invisible once the warp is ready;
    // while it loads (or if the font isn't hosted) the plain text shows instead.
    const warpReady = warpTextSvg != null;
    // Clip mask (text): the comp-px mask must live on a comp-sized, transform-less wrapper (text is
    // content-sized) so it aligns + stays comp-fixed like the GPU scene path. `null` when unmasked → no
    // wrapper, byte-identical to before. The inner button re-enables pointer events (wrapper is none).
    const textMaskWrapper = getOverlayMaskWrapperStyle(layer);
    const textButton = (
      <button
        className={`preview-text-layer ${selected ? "is-selected" : ""}`}
        type="button"
        {...dragHandlers}
        style={{
          ...(style as CSSProperties),
          ...(hideVisual ? { opacity: 0 } : null),
          ...(textMaskWrapper ? { pointerEvents: "auto" } : null),
          // Render-only clones stay pointer-transparent (overrides the mask-wrapper's auto) so clicks reach
          // the real base layer beneath.
          ...(interactive ? null : { pointerEvents: "none" })
        }}
      >
        {visibleRuns.map((run, index) => (
          <span
            key={`${layer.id}_run_${index}`}
            style={{ ...(getCompositionTextRunStyle(run, style) as CSSProperties), visibility: warpReady ? "hidden" : undefined }}
          >
            {run.text}
          </span>
        ))}
        {warpReady ? (
          // Force visibility so the warp shows even though the (sibling) runs are hidden — but when
          // the layer is GPU-composited (`hideVisual`, scene path), the scene raster already draws the
          // warp; keep this DOM overlay hidden too or it double-renders on top of the GPU warp.
          <span
            aria-hidden="true"
            style={{ position: "absolute", inset: 0, visibility: hideVisual ? "hidden" : "visible" }}
            dangerouslySetInnerHTML={{ __html: warpTextSvg }}
          />
        ) : null}
      </button>
    );

    return (
      <>
        {textMaskWrapper ? <div style={textMaskWrapper as CSSProperties}>{textButton}</div> : textButton}
        {selected ? (
          <PreviewSelectionOverlay
            layer={layer}
            style={style as CSSProperties}
            currentTime={currentTime}
            transformHud={transformHud}
            text={layer.text}
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
            boxOverride={contentBoxOverride}
          />
        ) : null}
        {selected ? (
          <MotionPathOverlay
            currentTime={currentTime}
            layer={layer}
            onPointPointerCancel={finishMotionPathPointDrag}
            onPointPointerDown={startMotionPathPointDrag}
            onPointPointerMove={updateMotionPathPointDrag}
            onPointPointerUp={finishMotionPathPointDrag}
            onSpatialHandlePointerCancel={finishSpatialHandleDrag}
            onSpatialHandlePointerDown={startSpatialHandleDrag}
            onSpatialHandlePointerMove={updateSpatialHandleDrag}
            onSpatialHandlePointerUp={finishSpatialHandleDrag}
          />
        ) : null}
      </>
    );
  }

  if (layer.type === "shape") {
    const style = getCompositionShapeStyle(layer, { currentTimeSeconds: currentTime });
    // Clip mask (shape): comp-space wrapper, same as text (see above). `null` when unmasked.
    const shapeMaskWrapper = getOverlayMaskWrapperStyle(layer);
    const shapeButton = (
      <button
        className={`preview-shape-layer ${selected ? "is-selected" : ""}`}
        type="button"
        {...dragHandlers}
        // Scene mode: the GPU raster draws the shape, so hide the DOM visual — but with `opacity:0`,
        // NOT `visibility:hidden`, so the element still receives pointer events (drag/select on canvas).
        style={{
          ...(style as CSSProperties),
          ...(hideVisual ? { opacity: 0 } : null),
          ...(shapeMaskWrapper ? { pointerEvents: "auto" } : null),
          // Render-only clones stay pointer-transparent so clicks reach the real base layer beneath.
          ...(interactive ? null : { pointerEvents: "none" })
        }}
      />
    );

    return (
      <>
        {shapeMaskWrapper ? <div style={shapeMaskWrapper as CSSProperties}>{shapeButton}</div> : shapeButton}
        {selected ? (
          <PreviewSelectionOverlay
            layer={layer}
            style={style as CSSProperties}
            currentTime={currentTime}
            transformHud={transformHud}
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
            boxOverride={contentBoxOverride}
          />
        ) : null}
        {selected ? (
          <MotionPathOverlay
            currentTime={currentTime}
            layer={layer}
            onPointPointerCancel={finishMotionPathPointDrag}
            onPointPointerDown={startMotionPathPointDrag}
            onPointPointerMove={updateMotionPathPointDrag}
            onPointPointerUp={finishMotionPathPointDrag}
            onSpatialHandlePointerCancel={finishSpatialHandleDrag}
            onSpatialHandlePointerDown={startSpatialHandleDrag}
            onSpatialHandlePointerMove={updateSpatialHandleDrag}
            onSpatialHandlePointerUp={finishSpatialHandleDrag}
          />
        ) : null}
      </>
    );
  }

  if (isVideo && mediaUrl) {
    const baseStyle = getCompositionMediaStyle(layer, { currentTimeSeconds: currentTime }) as CSSProperties;
    // Pre-rolled but not yet on-screen: keep it invisible and click-through until active. Render-only clones
    // (!interactive) stay click-through too so the real base layer beneath gets the pointer.
    const style: CSSProperties = pending
      ? { ...baseStyle, opacity: 0, pointerEvents: "none" }
      : interactive
        ? baseStyle
        : { ...baseStyle, pointerEvents: "none" };
    const effectiveDragHandlers = pending ? undefined : dragHandlers;
    const isSelectedVisible = selected && !pending;
    const videoColorPipeline = bypassColor ? null : getCompositionColorPipeline(layer, { currentTimeSeconds: currentTime });
    const videoMediaEffects = getCompositionMediaEffects(layer, { currentTimeSeconds: currentTime });
    const videoTransition = getCompositionTransition(layer, { currentTimeSeconds: currentTime });

    // Unified WebGL path (rendererMode=webgl): one shader does color grade + matte + opacity,
    // identical to the Remotion export. Replaces both <MaskedVideoLayer> and the
    // <WebglVideoOverlay>-over-<video> pair. The source <video> is forwarded via videoRef so
    // the existing play/pause/seek effects keep controlling it.
    if (useWebglMedia) {
      // skipColorFilter: the grade lives in the shader, never as an SVG filter on the source.
      const webglStyle = getCompositionMediaStyle(layer, {
        currentTimeSeconds: currentTime,
        skipColorFilter: true
      }) as CSSProperties;
      // Pending clips are hidden via WebglMediaLayer's `hidden` prop (CSS visibility), NOT by zeroing
      // opacity here — a shader draw at opacity 0 leaves a transparent buffer that flickers at the reveal.
      // Drawing at the real opacity keeps the buffer reveal-ready.
      const webglLayerStyle: CSSProperties = webglStyle;
      return (
        <>
          <WebglMediaLayer
            mediaType="video"
            className={`preview-media ${isSelectedVisible ? "is-selected" : ""}`}
            key={mediaUrl}
            src={mediaUrl}
            // Full-res settle frame on pause: the ORIGINAL bytes, same preference order as the
            // freeze-frame invariant (fileUrl ?? previewUrl — never proxyUrl). When proxy playback is
            // off (fixed full quality) mediaUrl already IS this URL and the layer no-ops it.
            fullResSrc={asset?.fileUrl ?? asset?.previewUrl}
            // ORIGINAL bytes (no ingest proxy yet, or fixed full quality) must use the native
            // element decoder: the WC preview pool is for keyframe-dense proxies — a sparse-GOP
            // camera original freezes it (2026-07-06). Flips to WC automatically when the proxy
            // lands (mediaUrl becomes proxyUrl → new key/src remounts the layer).
            preferNativeDecode={mediaUrl !== (asset as (typeof asset & { proxyUrl?: string }) | undefined)?.proxyUrl}
            matte={layer.matte}
            pipeline={videoColorPipeline}
            mediaEffects={videoMediaEffects}
            currentTime={currentTime}
            isPlaying={effectivePlaying}
            layerStartSeconds={layer.startSeconds}
            sourceInSeconds={rampTangent ? rampTangent.sourceIn : layer.sourceInSeconds}
            speedFactor={rampTangent ? rampTangent.speed : getLayerSpeed(layer)}
            onLoadedMetadata={(event) => syncVideoTime(event.currentTarget)}
            dragHandlers={effectiveDragHandlers}
            onWebglFailed={() => setWebglMediaFailed(true)}
            poster={videoPoster ?? undefined}
            hidden={pending || (hideForTransition && !sceneComposited)}
            interactiveHidden={sceneComposited && !pending}
            // Scene-composited media carries no per-clip reveal (junctions fold in-compositor) — null it for
            // both the own-canvas onGradedFrame path AND the single-ctx sink path.
            transition={onGradedFrame || sceneMediaSink ? null : videoTransition}
            onGradedFrame={onGradedFrame}
            sceneMediaSink={sceneMediaSink}
            bakeOpacity={bakeOpacity}
            ref={videoRef}
            style={webglLayerStyle}
          />
          {pending || sceneComposited ? null : <EffectMaskOverlays layer={layer} currentTime={currentTime} style={webglLayerStyle} />}
          {isSelectedVisible ? (
            <PreviewSelectionOverlay
              layer={layer}
              style={webglLayerStyle}
              currentTime={currentTime}
              transformHud={transformHud}
              onResizePointerCancel={finishPreviewResize}
              onResizePointerDown={startPreviewResize}
              onResizePointerMove={updatePreviewResize}
              onResizePointerUp={finishPreviewResize}
              onRotatePointerCancel={finishPreviewRotate}
              onRotatePointerDown={startPreviewRotate}
              onRotatePointerMove={updatePreviewRotate}
              onRotatePointerUp={finishPreviewRotate}
              boxOverride={contentBoxOverride}
            />
          ) : null}
          {isSelectedVisible ? (
            <MotionPathOverlay
              currentTime={currentTime}
              layer={layer}
              onPointPointerCancel={finishMotionPathPointDrag}
              onPointPointerDown={startMotionPathPointDrag}
              onPointPointerMove={updateMotionPathPointDrag}
              onPointPointerUp={finishMotionPathPointDrag}
              onSpatialHandlePointerCancel={finishSpatialHandleDrag}
              onSpatialHandlePointerDown={startSpatialHandleDrag}
              onSpatialHandlePointerMove={updateSpatialHandleDrag}
              onSpatialHandlePointerUp={finishSpatialHandleDrag}
            />
          ) : null}
        </>
      );
    }

    // Legacy DOM path (rendererMode=legacy or WebGL init failed). Overlay a graded canvas
    // over the plain video (not the matte path). The video keeps all its logic and is the
    // pixel source; on WebGL failure the SVG-graded video shows through.
    const useWebglVideo = useWebglColorEngine(webgl2Supported()) && videoColorPipeline !== null && !layer.matte?.uri && !pending;

    return (
      <>
        {layer.matte?.uri ? (
          <MaskedVideoLayer
            className={`preview-media ${isSelectedVisible ? "is-selected" : ""}`}
            currentTime={currentTime}
            dragHandlers={effectiveDragHandlers}
            isPlaying={effectivePlaying}
            key={mediaUrl}
            layerStartSeconds={layer.startSeconds}
            sourceInSeconds={rampTangent ? rampTangent.sourceIn : layer.sourceInSeconds}
            speedFactor={rampTangent ? rampTangent.speed : getLayerSpeed(layer)}
            matte={layer.matte}
            mediaUrl={mediaUrl}
            onLoadedMetadata={(event) => syncVideoTime(event.currentTarget)}
            ref={videoRef}
            style={style}
          />
        ) : (
          <video
            className={`preview-media ${isSelectedVisible ? "is-selected" : ""}`}
            key={mediaUrl}
            muted
            {...effectiveDragHandlers}
            aria-hidden={pending}
            onLoadedMetadata={(event) => syncVideoTime(event.currentTarget)}
            poster={videoPoster ?? resolvePosterUrl(asset)}
            playsInline
            preload="auto"
            ref={videoRef}
            src={mediaUrl}
            style={style}
          />
        )}
        {useWebglVideo && videoColorPipeline ? (
          <ColorEngineBoundary>
            <WebglVideoOverlay
              className="preview-media"
              videoRef={videoRef}
              pipeline={videoColorPipeline}
              playing={effectivePlaying}
              currentTime={currentTime}
              style={style}
            />
          </ColorEngineBoundary>
        ) : null}
        {pending || sceneComposited ? null : <EffectMaskOverlays layer={layer} currentTime={currentTime} style={style} />}
        {isSelectedVisible ? (
          <PreviewSelectionOverlay
            layer={layer}
            style={style}
            currentTime={currentTime}
            transformHud={transformHud}
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
            boxOverride={contentBoxOverride}
          />
        ) : null}
        {isSelectedVisible ? (
          <MotionPathOverlay
            currentTime={currentTime}
            layer={layer}
            onPointPointerCancel={finishMotionPathPointDrag}
            onPointPointerDown={startMotionPathPointDrag}
            onPointPointerMove={updateMotionPathPointDrag}
            onPointPointerUp={finishMotionPathPointDrag}
            onSpatialHandlePointerCancel={finishSpatialHandleDrag}
            onSpatialHandlePointerDown={startSpatialHandleDrag}
            onSpatialHandlePointerMove={updateSpatialHandleDrag}
            onSpatialHandlePointerUp={finishSpatialHandleDrag}
          />
        ) : null}
      </>
    );
  }

  if (layer.type === "video" && !mediaUrl) {
    const missingStyle = getCompositionMediaStyle(layer, { currentTimeSeconds: currentTime }) as CSSProperties;
    return (
      <>
        <button
          className={`preview-missing-layer ${selected ? "is-selected" : ""}`}
          type="button"
          {...dragHandlers}
          style={missingStyle}
        >
          Missing video asset
        </button>
        {selected ? (
          <PreviewSelectionOverlay
            layer={layer}
            style={missingStyle}
            currentTime={currentTime}
            transformHud={transformHud}
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
            boxOverride={contentBoxOverride}
          />
        ) : null}
        {selected ? (
          <MotionPathOverlay
            currentTime={currentTime}
            layer={layer}
            onPointPointerCancel={finishMotionPathPointDrag}
            onPointPointerDown={startMotionPathPointDrag}
            onPointPointerMove={updateMotionPathPointDrag}
            onPointPointerUp={finishMotionPathPointDrag}
            onSpatialHandlePointerCancel={finishSpatialHandleDrag}
            onSpatialHandlePointerDown={startSpatialHandleDrag}
            onSpatialHandlePointerMove={updateSpatialHandleDrag}
            onSpatialHandlePointerUp={finishSpatialHandleDrag}
          />
        ) : null}
      </>
    );
  }

  const imageStyleBase = getCompositionMediaStyle(layer, { currentTimeSeconds: currentTime }) as CSSProperties;
  // Render-only clones (!interactive) stay click-through so the real base layer beneath gets the pointer.
  const imageStyle: CSSProperties = interactive ? imageStyleBase : { ...imageStyleBase, pointerEvents: "none" };
  const imageColorPipeline = bypassColor ? null : getCompositionColorPipeline(layer, { currentTimeSeconds: currentTime });
  const imageMediaEffects = getCompositionMediaEffects(layer, { currentTimeSeconds: currentTime });
  const imageTransition = getCompositionTransition(layer, { currentTimeSeconds: currentTime });

  // Unified WebGL path (rendererMode=webgl): the canvas is the visible output and carries the
  // grade in-shader — identical to the Remotion export. The hidden <img> is only a decode source.
  if (useWebglMedia && mediaUrl) {
    const webglImageStyle = getCompositionMediaStyle(layer, {
      currentTimeSeconds: currentTime,
      skipColorFilter: true
    }) as CSSProperties;
    return (
      <>
        <WebglMediaLayer
          mediaType="image"
          className={`preview-media ${selected ? "is-selected" : ""}`}
          src={mediaUrl}
          // Still-proxy size tier (P2): static transform/content zoom only — animated scale
          // spikes are rare on stills and degrade to softness, never breakage.
          stillZoomFactor={Math.max(layer.transform?.scale ?? 1, layer.content?.scale ?? 1)}
          pipeline={imageColorPipeline}
          mediaEffects={imageMediaEffects}
          transition={onGradedFrame || sceneMediaSink ? null : imageTransition}
          onGradedFrame={onGradedFrame}
          sceneMediaSink={sceneMediaSink}
          bakeOpacity={bakeOpacity}
          hidden={hideForTransition && !sceneComposited}
          interactiveHidden={sceneComposited && !pending}
          dragHandlers={dragHandlers}
          onWebglFailed={() => setWebglMediaFailed(true)}
          style={webglImageStyle}
        />
        {pending || sceneComposited ? null : <EffectMaskOverlays layer={layer} currentTime={currentTime} style={webglImageStyle} />}
        {selected ? (
          <PreviewSelectionOverlay
            layer={layer}
            style={webglImageStyle}
            currentTime={currentTime}
            transformHud={transformHud}
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
            boxOverride={contentBoxOverride}
          />
        ) : null}
        {selected ? (
          <MotionPathOverlay
            currentTime={currentTime}
            layer={layer}
            onPointPointerCancel={finishMotionPathPointDrag}
            onPointPointerDown={startMotionPathPointDrag}
            onPointPointerMove={updateMotionPathPointDrag}
            onPointPointerUp={finishMotionPathPointDrag}
            onSpatialHandlePointerCancel={finishSpatialHandleDrag}
            onSpatialHandlePointerDown={startSpatialHandleDrag}
            onSpatialHandlePointerMove={updateSpatialHandleDrag}
            onSpatialHandlePointerUp={finishSpatialHandleDrag}
          />
        ) : null}
      </>
    );
  }

  // Legacy DOM path (rendererMode=legacy or WebGL init failed). WebGL color overlay only when
  // the layer is actually graded.
  const useWebglColor = useWebglColorEngine(webgl2Supported()) && imageColorPipeline !== null && Boolean(mediaUrl);

  return (
    <>
      <img
        className={`preview-media ${selected ? "is-selected" : ""}`}
        src={mediaUrl ?? ""}
        alt=""
        {...dragHandlers}
        style={imageStyle}
      />
      {useWebglColor && imageColorPipeline ? (
        <ColorEngineBoundary>
          <WebglColorView src={mediaUrl ?? ""} pipeline={imageColorPipeline} style={imageStyle} />
        </ColorEngineBoundary>
      ) : null}
      {pending || sceneComposited ? null : <EffectMaskOverlays layer={layer} currentTime={currentTime} style={imageStyle} />}
      {selected ? (
        <PreviewSelectionOverlay
          layer={layer}
          style={imageStyle}
          currentTime={currentTime}
          transformHud={transformHud}
          onResizePointerCancel={finishPreviewResize}
          onResizePointerDown={startPreviewResize}
          onResizePointerMove={updatePreviewResize}
          onResizePointerUp={finishPreviewResize}
          onRotatePointerCancel={finishPreviewRotate}
          onRotatePointerDown={startPreviewRotate}
          onRotatePointerMove={updatePreviewRotate}
          onRotatePointerUp={finishPreviewRotate}
          boxOverride={contentBoxOverride}
        />
      ) : null}
      {selected ? (
        <MotionPathOverlay
          currentTime={currentTime}
          layer={layer}
          onPointPointerCancel={finishMotionPathPointDrag}
          onPointPointerDown={startMotionPathPointDrag}
          onPointPointerMove={updateMotionPathPointDrag}
          onPointPointerUp={finishMotionPathPointDrag}
            onSpatialHandlePointerCancel={finishSpatialHandleDrag}
            onSpatialHandlePointerDown={startSpatialHandleDrag}
            onSpatialHandlePointerMove={updateSpatialHandleDrag}
            onSpatialHandlePointerUp={finishSpatialHandleDrag}
          />
      ) : null}
    </>
  );
}, arePreviewLayerPropsEqual);

// Memoized (default shallow compare) so a VideoPreview re-render that DIDN'T change this layer's props
// skips the audio subtree. `currentTime` changes every tick and drives per-tick volume/fade automation
// (the gain effect below), so the shallow compare intentionally still re-renders during playback —
// reconciling one <audio> element is cheap, and moving volume off the render path is out of scope here.
const AudioPreviewLayer = memo(function AudioPreviewLayer({
  assets,
  currentTime,
  isPlaying,
  layer,
  sourceAsset,
  trackGain = 1,
  trackPan = 0
}: {
  assets: SourceAsset[];
  currentTime: number;
  isPlaying: boolean;
  layer: TimelineLayer;
  sourceAsset?: SourceAsset | null | undefined;
  /** Track mixer fader gain (0..2, 1 = unity) — multiplies the clip's own volume. */
  trackGain?: number | undefined;
  /** Track stereo pan (−1..1, 0 = center). */
  trackPan?: number | undefined;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Route the element through a Web Audio GainNode so the gain matches the export exactly — the raw
  // element.volume is clamped to 0..1, but the mixer/Remotion (and this graph) can boost past 100%.
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const panNodeRef = useRef<StereoPannerNode | null>(null);
  const fxNodeRef = useRef<AudioWorkletNode | null>(null);
  const asset = resolveLayerAsset(layer, assets, sourceAsset);
  const mediaUrl = resolvePlaybackUrl(asset);

  // Clip audio FX chain (EQ/compressor/gate/limiter) — same resolver the exports use. Keyed by
  // value so the wiring effect below only reacts to REAL param/order changes, not layer identity.
  const fxChain = resolveAudioFxChain(layer);
  const fxChainKey = fxChain.length ? JSON.stringify(fxChain) : "";

  // Source-aware + speed-aware: local timeline time maps to source time via
  // sourceIn + local * speed (the same contract as video / the export mixer).
  // (sourceInSeconds was previously ignored here — trimmed audio clips played
  // from 0 in preview but from the trim point in export. Fixed 2026-07-03.)
  const speed = getLayerSpeed(layer);
  const sourceIn = layer.sourceInSeconds ?? 0;

  function syncAudioTime(audio: HTMLAudioElement) {
    const local = Math.max(0, Math.min(layer.durationSeconds, currentTime - layer.startSeconds));
    // Ramp-aware: the shared mapper is the exact integral for ramped clips, sourceIn + local×speed otherwise.
    const nextTime = layerSourceTimeSeconds(layer, local);
    if (Number.isFinite(nextTime) && Math.abs(audio.currentTime - nextTime) > 0.08 * Math.max(1, getLayerSpeedAt(layer, local))) {
      audio.currentTime = nextTime;
    }
  }

  // Wire element → GainNode → destination exactly once. createMediaElementSource can only run once
  // per element, so a ref guards it; the same URLs the export mixer reads are CORS-enabled, so the
  // graph isn't silenced. Falls back to element.volume when Web Audio is unavailable.
  useEffect(() => {
    const audio = audioRef.current;
    const ctx = getPreviewAudioContext();
    if (!audio || !ctx || sourceNodeRef.current) {
      return;
    }
    try {
      const source = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      // Through the unity master bus (preview-audio-bus.ts) instead of destination directly —
      // audibly identical, and gives the timeline audio meters one mix point to observe.
      // A StereoPannerNode between gain and the bus carries the TRACK pan (unity/center by
      // default — byte-identical to the old graph when the mixer is untouched).
      const pan = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;
      if (pan) {
        source.connect(gain).connect(pan).connect(getPreviewMasterBusInput(ctx));
      } else {
        source.connect(gain).connect(getPreviewMasterBusInput(ctx));
      }
      sourceNodeRef.current = source;
      gainNodeRef.current = gain;
      panNodeRef.current = pan;
    } catch {
      // Already connected or unsupported — element.volume path covers it.
    }
  }, [mediaUrl]);

  // Track mixer pan follows the composition live.
  useEffect(() => {
    if (panNodeRef.current) {
      panNodeRef.current.pan.value = Math.min(1, Math.max(-1, trackPan));
    }
  }, [trackPan]);

  // Clip audio FX: lazily insert an AudioWorkletNode running the SHARED export DSP between the
  // media source and the gain node (pre-fader insert — the same chain position both exports use).
  // Clips without FX never create the node (zero cost); once created it stays and follows edits
  // via postMessage (an empty chain is a passthrough). Worklet unavailable → preview skips FX,
  // exports still apply them (documented fallback, same shape as the element.volume fallback).
  useEffect(() => {
    const ctx = getPreviewAudioContext();
    if (!ctx) return;
    if (fxNodeRef.current) {
      updateAudioFxNode(fxNodeRef.current, fxChain);
      return;
    }
    if (!fxChainKey) return;
    let cancelled = false;
    void ensureAudioFxWorklet(ctx).then((ok) => {
      // The graph may not be wired yet (the media-source effect runs async of this one) or the
      // layer may have unmounted/changed — bail; the next chain change retries.
      const source = sourceNodeRef.current;
      const gain = gainNodeRef.current;
      if (!ok || cancelled || !source || !gain || fxNodeRef.current) return;
      try {
        const node = createAudioFxNode(ctx, resolveAudioFxChain(layer));
        source.disconnect();
        source.connect(node);
        node.connect(gain);
        fxNodeRef.current = node;
      } catch {
        // Insert failed mid-flight — leave the direct source → gain wiring untouched.
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fxChainKey IS the chain's value identity
  }, [fxChainKey, mediaUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl) {
      return;
    }

    // Rate stretch: element playbackRate follows the clip speed. preservesPitch stays
    // false for parity with the export mixer (AudioBufferSourceNode.playbackRate is
    // varispeed — pitch shifts with speed), like Premiere with "Maintain Audio Pitch" off.
    audio.playbackRate = speed;
    if ("preservesPitch" in audio) {
      (audio as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = false;
    }
    if (isPlaying) {
      void getPreviewAudioContext()?.resume();
      syncAudioTime(audio);
      void audio.play().catch(() => undefined);
      return;
    }

    audio.pause();
    syncAudioTime(audio);
  }, [isPlaying, layer.id, mediaUrl, speed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl || isPlaying) {
      return;
    }
    syncAudioTime(audio);
  }, [currentTime, isPlaying, layer.startSeconds, mediaUrl]);

  // Speed ramp: follow the varying rate per tick (elements can't free-run a curve); syncAudioTime's
  // integral resync bounds the drift.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl || !hasSpeedRamp(layer)) {
      return;
    }
    audio.playbackRate = getLayerSpeedAt(layer, Math.max(0, currentTime - layer.startSeconds));
    if (isPlaying) {
      syncAudioTime(audio);
    }
  }, [currentTime, isPlaying, layer, mediaUrl]);

  // ── Audio-master clock (audio-clock.ts) ─────────────────────────────────
  // While playing, this element is a candidate MASTER for the playback clock: its currentTime maps back
  // to timeline time (same mapping syncAudioTime uses, inverted). read() returns null whenever the
  // element isn't authoritative — paused/seeking/ended/underbuffered — so a stalling clip can never
  // drag the clock; the registry then falls back to another audible clip or pure wall time.
  useEffect(() => {
    const audio = audioRef.current;
    // Ramped clips never take the master-clock role: read() must invert time→source, and the
    // ramp's inverse integral isn't worth the cost — another audible clip or wall time drives.
    if (!audio || !mediaUrl || !isPlaying || !getAudioClockEnabled() || hasSpeedRamp(layer)) {
      return;
    }
    // ADVANCEMENT gate state: a master must have actually MOVED since this registration. During
    // play() startup latency the element reports paused=false while its currentTime sits frozen at
    // the seek position — that's WITHIN the distance gate right after play starts, so it got
    // elected reporting its (stale) start position and the hard resync yanked the playhead back by
    // the startup latency ("playhead runs ~0.5–1s then jumps back to the start", user report
    // 2026-07-03, second occurrence — the distance gate alone only stopped LATE elections).
    // `lastMovedAtMs === 0` = never advanced since registration → never authoritative. Once moving,
    // brief flat reads are tolerated (audio currentTime advances in coarse browser-dependent steps).
    let lastSeenCt = audio.currentTime;
    let lastMovedAtMs = 0;
    return registerAudioClockSource({
      layerId: layer.id,
      startSeconds: layer.startSeconds,
      read: () => {
        if (audio.paused || audio.seeking || audio.ended || audio.readyState < 2) return null;
        const now = performance.now();
        if (audio.currentTime !== lastSeenCt) {
          lastSeenCt = audio.currentTime;
          lastMovedAtMs = now;
        }
        if (lastMovedAtMs === 0 || now - lastMovedAtMs > 350) return null; // cold-starting or stalled
        // Inverse of syncAudioTime: source time back to timeline time (speed/sourceIn-aware).
        const mapped = layer.startSeconds + (audio.currentTime - sourceIn) / speed;
        // Cold-start/stall authority gate (AUDIO_MASTER_GATE_S): a just-started element lags the
        // clock by its play() latency — reporting that as master time yanked playback backward.
        // Not authoritative yet → the non-master corrector below seeks it onto the clock instead.
        // Compared against the LIVE playhead (the committed store clock trails it by up to one
        // commit interval right after play starts, which weakened this gate).
        if (Math.abs(mapped - getLivePlaybackTime()) > AUDIO_MASTER_GATE_S) return null;
        return mapped;
      },
    });
  }, [isPlaying, layer.id, layer.startSeconds, mediaUrl, sourceIn, speed]);

  // NON-master playback drift correction. Before the audio clock, audio elements free-ran with NO
  // correction during playback (the paused-only sync above), so a start-latency offset persisted for
  // the whole clip. The master is never corrected — it DEFINES time; every other audible element is
  // nudged back onto the clock when it strays past 0.15s (coarse + infrequent, so no seek storms).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl || !isPlaying || !getAudioClockEnabled()) {
      return;
    }
    const interval = window.setInterval(() => {
      if (isAudioClockMaster(layer.id) || audio.paused || audio.seeking || audio.readyState < 2) return;
      const local = Math.max(0, Math.min(layer.durationSeconds, getPlaybackClock() - layer.startSeconds));
      const expected = layerSourceTimeSeconds(layer, local);
      if (Number.isFinite(expected) && Math.abs(audio.currentTime - expected) > 0.15 * Math.max(1, getLayerSpeedAt(layer, local))) {
        audio.currentTime = expected;
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [isPlaying, layer.durationSeconds, layer.id, layer.startSeconds, mediaUrl, sourceIn, speed]);

  // Volume / fade tracked against currentTime so it updates during scrub + playback. The GainNode
  // takes the full 0..2 range (exact parity); the element.volume fallback clamps to 0..1.
  useEffect(() => {
    // Clip volume (keyframable) × track mixer fader — same product the export mixer applies.
    const gain = Math.max(0, getCompositionVolume(layer, { currentTimeSeconds: currentTime })) * Math.max(0, trackGain);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = gain;
      return;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.volume = Math.min(1, gain);
    }
  }, [currentTime, layer, trackGain]);

  if (!mediaUrl) {
    return null;
  }

  return <audio aria-hidden="true" crossOrigin="anonymous" preload="auto" ref={audioRef} src={mediaUrl} />;
});

/** Exported for the viewer-capture proxy generator (same adjustment-merge as the live viewer). */
export function applyActiveAdjustmentEffects(
  layer: TimelineLayer,
  trackIndex: number,
  activeLayerEntries: Array<{ layer: TimelineLayer; trackIndex: number; layerIndex: number }>
): TimelineLayer {
  const adjustmentEffects = activeLayerEntries
    .filter((entry) => entry.layer.type === "adjustment" && entry.trackIndex < trackIndex)
    .flatMap((entry) => entry.layer.effects);

  if (!adjustmentEffects.length) {
    return layer;
  }

  return {
    ...layer,
    effects: [...layer.effects, ...adjustmentEffects]
  };
}

function MotionPathOverlay({
  currentTime,
  layer,
  onPointPointerCancel,
  onPointPointerDown,
  onPointPointerMove,
  onPointPointerUp,
  onSpatialHandlePointerCancel,
  onSpatialHandlePointerDown,
  onSpatialHandlePointerMove,
  onSpatialHandlePointerUp
}: {
  currentTime: number;
  layer: TimelineLayer;
  onPointPointerCancel: (event: ReactPointerEvent<SVGCircleElement>) => void;
  onPointPointerDown: (event: ReactPointerEvent<SVGCircleElement>, timeSeconds: number) => void;
  onPointPointerMove: (event: ReactPointerEvent<SVGCircleElement>) => void;
  onPointPointerUp: (event: ReactPointerEvent<SVGCircleElement>) => void;
  onSpatialHandlePointerCancel: (event: ReactPointerEvent<SVGCircleElement>) => void;
  onSpatialHandlePointerDown: (event: ReactPointerEvent<SVGCircleElement>, timeSeconds: number, handle: "in" | "out") => void;
  onSpatialHandlePointerMove: (event: ReactPointerEvent<SVGCircleElement>) => void;
  onSpatialHandlePointerUp: (event: ReactPointerEvent<SVGCircleElement>) => void;
}) {
  const portalTarget = useContext(OverlayPortalContext);
  const keyframeTimes = getPositionKeyframeTimes(layer);
  if (keyframeTimes.length < 1) {
    return null;
  }

  const start = Math.max(0, Math.min(...keyframeTimes));
  const end = Math.min(layer.durationSeconds, Math.max(...keyframeTimes));
  const sampleCount = Math.max(2, Math.min(96, Math.round((end - start) * 12)));
  const samples =
    keyframeTimes.length > 1
      ? Array.from({ length: sampleCount }, (_, index) => positionAtLayerTime(layer, start + ((end - start) * index) / Math.max(1, sampleCount - 1)))
      : [positionAtLayerTime(layer, keyframeTimes[0]!)];
  const points = samples.map((point) => `${point.x},${point.y}`).join(" ");
  const currentPosition = positionAtLayerTime(layer, clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds));

  const node = (
    <svg className="preview-motion-path" viewBox="0 0 100 100" preserveAspectRatio="none">
      {keyframeTimes.length > 1 ? <polyline className="preview-motion-path-line" points={points} /> : null}
      <circle className="preview-motion-path-current" cx={currentPosition.x} cy={currentPosition.y} r="1.3" vectorEffect="non-scaling-stroke" />
      {keyframeTimes.map((timeSeconds, index) => {
        const point = positionAtLayerTime(layer, timeSeconds);
        const handles = spatialHandlesAtTime(layer, timeSeconds) ?? defaultSpatialHandlesAtTime(layer, timeSeconds, keyframeTimes);
        return (
          <g key={`${timeSeconds}_${index}`}>
            {(["in", "out"] as const).map((handle) => {
              const tangent = handles?.[handle === "in" ? "inTangent" : "outTangent"];
              if (!tangent) {
                return null;
              }
              const handlePoint = { x: point.x + tangent.x, y: point.y + tangent.y };
              return (
                <g className="preview-motion-spatial-handle" key={handle}>
                  <line x1={point.x} x2={handlePoint.x} y1={point.y} y2={handlePoint.y} vectorEffect="non-scaling-stroke" />
                  <circle
                    cx={handlePoint.x}
                    cy={handlePoint.y}
                    r="1.3"
                    vectorEffect="non-scaling-stroke"
                    onPointerCancel={onSpatialHandlePointerCancel}
                    onPointerDown={(event) => onSpatialHandlePointerDown(event, timeSeconds, handle)}
                    onPointerMove={onSpatialHandlePointerMove}
                    onPointerUp={onSpatialHandlePointerUp}
                  />
                </g>
              );
            })}
            <circle
              aria-label={`Position keyframe ${index + 1}`}
              className="preview-motion-path-point"
              cx={point.x}
              cy={point.y}
              r="1.8"
              tabIndex={0}
              vectorEffect="non-scaling-stroke"
              onPointerCancel={onPointPointerCancel}
              onPointerDown={(event) => onPointPointerDown(event, timeSeconds)}
              onPointerMove={onPointPointerMove}
              onPointerUp={onPointPointerUp}
            />
          </g>
        );
      })}
    </svg>
  );
  return portalTarget ? createPortal(node, portalTarget) : node;
}

function getPositionKeyframeTimes(layer: TimelineLayer) {
  const times = getLayerAnimations(layer)
    .filter(
      (keyframe): keyframe is TimelineKeyframeV2 =>
        keyframe.target.scope === "layer" &&
        (keyframe.target.property === "transform.position.x" || keyframe.target.property === "transform.position.y")
    )
    .map((keyframe) => keyframe.timeSeconds);
  return [...new Set(times.map((time) => Math.round(time * 1000) / 1000))].sort((a, b) => a - b);
}

function positionAtLayerTime(layer: TimelineLayer, timeSeconds: number) {
  const transform = evaluateTimelineTransform({
    transform: layer.transform,
    startSeconds: layer.startSeconds,
    keyframes: layer.keyframes,
    animations: layer.animations,
    timeSeconds: layer.startSeconds + timeSeconds
  });
  return transform.position;
}

function spatialHandlesAtTime(layer: TimelineLayer, timeSeconds: number) {
  return getLayerAnimations(layer).find(
    (keyframe) =>
      keyframe.target.scope === "layer" &&
      keyframe.target.property === "transform.position.x" &&
      Math.abs(keyframe.timeSeconds - timeSeconds) < 0.001
  )?.spatial;
}

function defaultSpatialHandlesAtTime(layer: TimelineLayer, timeSeconds: number, keyframeTimes: number[]) {
  const index = keyframeTimes.findIndex((time) => Math.abs(time - timeSeconds) < 0.001);
  const point = positionAtLayerTime(layer, timeSeconds);
  const previousTime = index > 0 ? keyframeTimes[index - 1] : undefined;
  const nextTime = index >= 0 && index < keyframeTimes.length - 1 ? keyframeTimes[index + 1] : undefined;
  return {
    interpolation: "bezier" as const,
    inTangent:
      previousTime === undefined
        ? undefined
        : {
            x: (positionAtLayerTime(layer, previousTime).x - point.x) * 0.33,
            y: (positionAtLayerTime(layer, previousTime).y - point.y) * 0.33
          },
    outTangent:
      nextTime === undefined
        ? undefined
        : {
            x: (positionAtLayerTime(layer, nextTime).x - point.x) * 0.33,
            y: (positionAtLayerTime(layer, nextTime).y - point.y) * 0.33
          },
    linked: true
  };
}

function PreviewSelectionOverlay({
  layer,
  style,
  text,
  currentTime,
  transformHud,
  onResizePointerCancel,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  onRotatePointerCancel,
  onRotatePointerDown,
  onRotatePointerMove,
  onRotatePointerUp,
  boxOverride
}: {
  layer: TimelineLayer;
  style: CSSProperties;
  text?: string | undefined;
  currentTime: number;
  transformHud?: PreviewTransformHud | null | undefined;
  onResizePointerCancel: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizePointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizePointerUp: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onRotatePointerCancel: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onRotatePointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onRotatePointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onRotatePointerUp: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  /** Shrinks the box to a `contain` media layer's natural rect so handles hug the source (adaptive). */
  boxOverride?: { width: string; height: string } | undefined;
}) {
  // Counter the box's scale so the handles stay a constant on-screen size. Use the KEYFRAME-EVALUATED
  // scale (the exact value compositionTransformCss bakes into the box transform), not the raw base
  // `layer.transform.scale` — otherwise a scale keyframe / entrance animation / scrubbed value makes the
  // counter miss and the handles scale with the clip.
  const evaluatedScale = getCompositionTransform(layer, { currentTimeSeconds: currentTime }).scale;
  const overlayStyle = {
    ...selectionOverlayStyle(style),
    // Adaptive box: override the full-frame width/height with the contain source rect (centered by the same
    // translate(-50%,-50%) the media uses), so the selection box hugs the visible image.
    ...(boxOverride ?? {}),
    "--handle-inverse-scale": 1 / Math.max(0.1, evaluatedScale)
  } as CSSProperties;

  const portalTarget = useContext(OverlayPortalContext);
  const node = (
    <div className={`preview-selection-box preview-selection-box-${layer.type}`} style={overlayStyle}>
      {text ? <span className="preview-selection-measure">{text}</span> : null}
      {transformHud ? (
        <span className={`preview-transform-hud preview-transform-hud-${transformHud.mode} ${transformHud.snapped ? "is-snapped" : ""}`}>
          <strong>{transformHud.primary}</strong>
          {transformHud.secondary ? <small>{transformHud.secondary}</small> : null}
        </span>
      ) : null}
      <span className="preview-resize-handles" aria-hidden="true">
      <span
        className="preview-rotate-handle"
        onPointerCancel={onRotatePointerCancel}
        onPointerDown={onRotatePointerDown}
        onPointerMove={onRotatePointerMove}
        onPointerUp={onRotatePointerUp}
      />
      {/* Corners + edge midpoints. Corner handles (nw/ne/sw/se) scale uniformly from center; edge handles
          (n/e/s/w) crop the media (trim that edge via content.crop) — see startPreviewResize's routing.
          Text/shape have no source to crop, so their edges resize like the corners. */}
      {(["nw", "ne", "sw", "se", "n", "e", "s", "w"] as const).map((handle) => (
        <span
          className={`preview-resize-handle preview-resize-handle-${handle}`}
          key={handle}
          onPointerCancel={onResizePointerCancel}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
        />
      ))}
      </span>
    </div>
  );
  // Portal out of the frame-crop so handles show past the canvas edge; inline fallback when no target.
  return portalTarget ? createPortal(node, portalTarget) : node;
}

/**
 * Phase 3 color system — injects the shared SVG color-filter `<defs>` for every
 * visible layer, referenced by each layer's `filter: url(#lumio-color-…)`. Same
 * shared generator + inline-SVG pattern the text-warp overlay uses, so the web
 * preview and the Remotion export stay pixel-aligned. Recomputed per frame
 * (currentTime) so keyframed color params animate.
 */
function ColorFilterDefs({ layers, currentTime }: { layers: TimelineLayer[]; currentTime: number }) {
  const markup = buildColorFilterDefs(layers.map((layer) => getCompositionColorFilter(layer, { currentTimeSeconds: currentTime })?.svg));
  if (!markup) {
    return null;
  }
  return <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />;
}

/**
 * Injects every layer's vector-mask SVG `<defs>` (referenced by each layer style's `mask: url(#…)`).
 * Same shared builder the Remotion export uses, so the editor cutout and the exported cutout match.
 */
/**
 * Effect-level (region) masks in the preview: a masked blur effect renders as a `backdrop-filter` overlay
 * clipped to its mask, blurring only that region of the clip behind it (single-copy, no media duplication).
 * The overlay mirrors the media element's box (left/top/width/height/transform) so it sits exactly on top.
 * Mirrors `MaskedEffectOverlays` in the Remotion renderer for export parity.
 *
 * MUST NOT render for `pending` (preloaded) or scene-composited layers. Active layers are EXPANDED
 * (region effects live on `__rfx_` clones / scene passes, so this returns [] for them), but pending
 * preload entries come from the RAW composition with `effect.masks` intact — and a backdrop-filter
 * blurs whatever is BENEATH the overlay in the DOM, i.e. the preview showing the PREVIOUS clip. That
 * was the "region effect applies ~1.2s (the preload lookahead) before its clip" leak. Callers gate on
 * `pending || sceneComposited`.
 */
function EffectMaskOverlays({ layer, currentTime, style }: { layer: TimelineLayer; currentTime: number; style: CSSProperties }) {
  const overlays = getMaskedEffectOverlays(layer, { currentTimeSeconds: currentTime });
  if (!overlays.length) return null;
  const layout: CSSProperties = {
    position: "absolute",
    left: style.left,
    top: style.top,
    width: style.width,
    height: style.height,
    transform: style.transform,
    transformOrigin: style.transformOrigin,
    pointerEvents: "none"
  };
  return (
    <>
      {overlays.map((overlay) => (
        <div
          key={overlay.effectId}
          aria-hidden="true"
          style={{
            ...layout,
            backdropFilter: overlay.backdropFilter,
            WebkitBackdropFilter: overlay.backdropFilter,
            ...(overlay.maskCss as CSSProperties)
          }}
        />
      ))}
    </>
  );
}

function MaskDefsAll({ layers, width, height, currentTime }: { layers: TimelineLayer[]; width: number; height: number; currentTime: number }) {
  const markup = layers.map((layer) => buildMaskDefsSvg(layer, { width, height, currentTimeSeconds: currentTime })).join("");
  if (!markup) {
    return null;
  }
  return <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />;
}

type MaskAffine = Mask["transform"];

/** Forward map a layer-local point through a mask's own transform (scale → rotate → translate about
 *  the outline centre), matching `maskTransformAttr` in shared so overlay handles sit on the rendered mask. */
function applyMaskTransform(p: { x: number; y: number }, t: MaskAffine, c: { x: number; y: number }): { x: number; y: number } {
  const sx = c.x + (p.x - c.x) * (t.scaleX || 1);
  const sy = c.y + (p.y - c.y) * (t.scaleY || 1);
  const r = ((t.rotation || 0) * Math.PI) / 180;
  const co = Math.cos(r);
  const si = Math.sin(r);
  const rx = c.x + (sx - c.x) * co - (sy - c.y) * si;
  const ry = c.y + (sx - c.x) * si + (sy - c.y) * co;
  return { x: rx + t.x, y: ry + t.y };
}

/** Inverse of {@link applyMaskTransform}: screen-derived local point → editable (pre-transform) point. */
function unapplyMaskTransform(p: { x: number; y: number }, t: MaskAffine, c: { x: number; y: number }): { x: number; y: number } {
  const tx = p.x - t.x;
  const ty = p.y - t.y;
  const r = ((t.rotation || 0) * Math.PI) / 180;
  const co = Math.cos(r);
  const si = Math.sin(r);
  const rx = c.x + (tx - c.x) * co + (ty - c.y) * si;
  const ry = c.y - (tx - c.x) * si + (ty - c.y) * co;
  return { x: c.x + (rx - c.x) / (t.scaleX || 1), y: c.y + (ry - c.y) / (t.scaleY || 1) };
}

function pointsCenter(points: { x: number; y: number }[]): { x: number; y: number } {
  if (!points.length) return { x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Mask drawing/editing overlay (Phase 2). Renders over the composition space in comp-pixel coordinates.
 * Mask points live in the layer's local space and are shown via the layer transform + the mask's own
 * transform, so the on-screen outline tracks both the clip and any mask-transform keyframes. Tools:
 * Rectangle/Ellipse drag to create; Polygon/Pen click to place points (Pen drag for Bezier handles,
 * Enter / click first point to close, Esc cancel, Backspace removes the last point); Select drags points,
 * Bezier tangent handles, or the whole mask, double-click a point to delete or an edge to insert, Alt-click
 * a point to toggle smooth. Geometry edits commit through `onCommitMaskPoints` (path-keyframe-aware).
 */
function MaskEditorOverlay({
  layer,
  masks: propMasks,
  currentTime,
  width,
  height,
  scale,
  tool,
  activeMaskId,
  onSelectMask,
  onChangeMaskTool,
  onUpdateLayerMasks,
  onCommitMaskPoints,
  onPreviewMaskScalar
}: {
  layer: TimelineLayer;
  masks: Mask[];
  currentTime: number;
  width: number;
  height: number;
  scale: number;
  tool: MaskTool;
  activeMaskId?: string | undefined;
  onSelectMask?: ((maskId: string | null) => void) | undefined;
  onChangeMaskTool?: ((tool: MaskTool) => void) | undefined;
  onUpdateLayerMasks?: ((layerId: string, updater: (masks: Mask[]) => Mask[]) => void) | undefined;
  onCommitMaskPoints?: ((layerId: string, maskId: string, points: MaskPoint[]) => void) | undefined;
  onPreviewMaskScalar?: ((layerId: string, maskId: string, patch: { feather?: number; opacity?: number }, commit: boolean) => void) | undefined;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [live, setLive] = useState<{ id: string; points: MaskPoint[] } | null>(null);
  const [penDraft, setPenDraft] = useState<MaskPoint[] | null>(null);
  const [activePointId, setActivePointId] = useState<string | null>(null);
  const dragRef = useRef<
    | { kind: "draw" }
    | { kind: "pen"; index: number }
    | { kind: "point"; maskId: string; pointId: string; origin: { x: number; y: number }; t: MaskAffine; center: { x: number; y: number } }
    | { kind: "move"; maskId: string; startLocal: { x: number; y: number }; origPoints: MaskPoint[]; t: MaskAffine; center: { x: number; y: number } }
    | {
        kind: "tangent";
        maskId: string;
        pointId: string;
        handle: "in" | "out";
        mirror: boolean;
        /** True when started by Alt-dragging a point (pull-out); a no-move release toggles smooth instead. */
        pullOut?: boolean;
        t: MaskAffine;
        center: { x: number; y: number };
      }
    // On-canvas scalar widget: drag along the edge-normal `n` from `anchor` (comp space) to set feather/opacity.
    | { kind: "feather" | "opacity"; maskId: string; anchor: { x: number; y: number }; n: { x: number; y: number }; s: number }
    | null
  >(null);

  const localTime = Math.max(0, currentTime - layer.startSeconds);
  const transform = getCompositionTransform(layer, { currentTimeSeconds: currentTime });
  // Text/shape clip masks are authored + rendered in COMP space (the scene matte, local export, and the DOM
  // getOverlayMaskWrapperStyle wrapper all apply the mask comp-fixed, never the layer transform). Media masks
  // ride the layer transform (the media element is comp-sized + transformed). So drop the layer transform here
  // for overlay layers, or a scaled/positioned text would divide the drawn shape toward center (mask lands on
  // the glyphs, not where drawn). For media local≈comp so this matches the existing behavior.
  const overlayType = layer.type === "text" || layer.type === "shape";
  const cx = overlayType ? width / 2 : (transform.x / 100) * width;
  const cy = overlayType ? height / 2 : (transform.y / 100) * height;
  const s = overlayType ? 1 : transform.scale || 1;
  const rad = overlayType ? 0 : ((transform.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // layer-local (0..W,0..H) → comp space (layer transform only)
  function toComp(p: { x: number; y: number }) {
    const lx = (p.x - width / 2) * s;
    const ly = (p.y - height / 2) * s;
    return { x: cx + (lx * cos - ly * sin), y: cy + (lx * sin + ly * cos) };
  }
  // comp space → layer-local
  function toLocal(p: { x: number; y: number }) {
    const vx = p.x - cx;
    const vy = p.y - cy;
    const ux = (vx * cos + vy * sin) / s;
    const uy = (-vx * sin + vy * cos) / s;
    return { x: ux + width / 2, y: uy + height / 2 };
  }
  function clientToComp(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height
    };
  }
  function clientToLocal(event: { clientX: number; clientY: number }) {
    return toLocal(clientToComp(event));
  }

  const masks = propMasks;
  const handleR = 5 / Math.max(0.05, scale);
  const strokeW = 1.5 / Math.max(0.05, scale);
  // on-screen px ≈ comp px * scale; comp px ≈ local px * s — used for the pen close threshold.
  const closeLocalDist = 11 / (Math.max(0.01, s) * Math.max(0.05, scale));

  function commitLive() {
    if (live) {
      onCommitMaskPoints?.(layer.id, live.id, live.points);
    }
    setLive(null);
  }

  // Resolve a mask's geometry at the playhead (path keyframes + own transform) for display + editing.
  function resolved(mask: Mask) {
    return resolveMaskAtTime(mask, layer.animations, localTime);
  }

  function displayPointsFor(mask: Mask): { points: MaskPoint[]; t: MaskAffine; center: { x: number; y: number } } {
    const r = resolved(mask);
    const points = live && live.id === mask.id ? live.points : r.points;
    return { points, t: r.transform, center: pointsCenter(points) };
  }

  // --- create tools (rect / ellipse drag) --------------------------------------------------------

  function onBackgroundPointerDown(event: ReactPointerEvent) {
    if (tool === "select") return;
    event.preventDefault();
    if (tool === "rectangle" || tool === "ellipse") {
      (event.target as Element).setPointerCapture?.(event.pointerId);
      dragRef.current = { kind: "draw" };
      const p = clientToComp(event);
      setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      return;
    }
    // pen / polygon: place a point (or close near the first one).
    const local = clientToLocal(event);
    setPenDraft((prev) => {
      const current = prev ?? [];
      if (current.length >= 2) {
        const first = current[0]!;
        if (Math.hypot(local.x - first.x, local.y - first.y) <= closeLocalDist) {
          window.setTimeout(() => finalizePen(current), 0);
          return prev;
        }
      }
      const point: MaskPoint = { id: `mp_${Date.now()}_${current.length}`, x: local.x, y: local.y };
      if (tool === "pen") {
        (event.target as Element).setPointerCapture?.(event.pointerId);
        dragRef.current = { kind: "pen", index: current.length };
      }
      return [...current, point];
    });
  }

  function finalizePen(pts: MaskPoint[]) {
    if (pts.length >= 3) {
      const shape = tool === "pen" ? "bezier" : "polygon";
      const mask = createMask(shape, pts.map((pt) => ({ ...pt })), `${tool === "pen" ? "Pen" : "Polygon"} ${masks.length + 1}`);
      onUpdateLayerMasks?.(layer.id, (currentMasks) => [...currentMasks, mask]);
      onSelectMask?.(mask.id);
      onChangeMaskTool?.("select");
    }
    setPenDraft(null);
  }

  // --- select tool: point / tangent / whole-mask editing -----------------------------------------

  function startPointDrag(event: ReactPointerEvent, mask: Mask, pointId: string) {
    if (tool !== "select") return;
    event.preventDefault();
    event.stopPropagation();
    onSelectMask?.(mask.id);
    setActivePointId(pointId);
    const info = displayPointsFor(mask);

    if (event.altKey) {
      // Alt-drag a point pulls out its Bezier handles (AE/Premiere pen gesture). A no-move release is
      // handled in onPointerUp as a plain Alt-click → togglePointSmooth (corner⇄smooth).
      (event.target as Element).setPointerCapture?.(event.pointerId);
      setLive({ id: mask.id, points: info.points.map((pt) => ({ ...pt })) });
      dragRef.current = { kind: "tangent", maskId: mask.id, pointId, handle: "out", mirror: true, pullOut: true, t: info.t, center: info.center };
      return;
    }
    if (event.detail >= 2) {
      deletePoint(mask, pointId, info);
      return;
    }
    (event.target as Element).setPointerCapture?.(event.pointerId);
    setLive({ id: mask.id, points: info.points.map((pt) => ({ ...pt })) });
    const origin = info.points.find((pt) => pt.id === pointId) ?? { x: 0, y: 0 };
    dragRef.current = { kind: "point", maskId: mask.id, pointId, origin: { x: origin.x, y: origin.y }, t: info.t, center: info.center };
  }

  function startTangentDrag(event: ReactPointerEvent, mask: Mask, pointId: string, handle: "in" | "out") {
    if (tool !== "select") return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const info = displayPointsFor(mask);
    // Handles are linked (symmetric) or broken (independent), persisted per-point via `lockedTangents`.
    // Alt-drag TOGGLES that state, so breaking a point sticks and you can then edit each handle with
    // ordinary drags; Alt-drag again to re-link. A normal drag honours whatever the point already is.
    const point = info.points.find((pt) => pt.id === pointId);
    const currentlyLinked = point?.lockedTangents !== false;
    const nextLinked = event.altKey ? !currentlyLinked : currentlyLinked;
    onSelectMask?.(mask.id);
    setActivePointId(pointId);
    setLive({
      id: mask.id,
      points: info.points.map((pt) => (pt.id === pointId ? { ...pt, lockedTangents: nextLinked } : { ...pt }))
    });
    dragRef.current = { kind: "tangent", maskId: mask.id, pointId, handle, mirror: nextLinked, t: info.t, center: info.center };
  }

  // On-canvas feather/opacity widget: drag the square (feather) / circle (opacity) along the edge-normal `n`
  // away from the mask to increase the value (AE-style mask-feather handle). Anchor & normal are captured at
  // mouse-down from the rendered widget; the layer scale `sLocal` converts feather (local px) ↔ comp px.
  function startScalarDrag(
    event: ReactPointerEvent,
    maskId: string,
    which: "feather" | "opacity",
    anchor: { x: number; y: number },
    n: { x: number; y: number },
    sLocal: number
  ) {
    if (tool !== "select") return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    onSelectMask?.(maskId);
    dragRef.current = { kind: which, maskId, anchor, n, s: sLocal };
  }

  // Project the pointer onto the widget normal and map to a feather/opacity value.
  function computeScalarPatch(
    drag: { kind: "feather" | "opacity"; anchor: { x: number; y: number }; n: { x: number; y: number }; s: number },
    event: ReactPointerEvent
  ): { feather?: number; opacity?: number } {
    const p = clientToComp(event);
    const proj = (p.x - drag.anchor.x) * drag.n.x + (p.y - drag.anchor.y) * drag.n.y;
    const u = 1 / Math.max(0.05, scale);
    if (drag.kind === "opacity") {
      return { opacity: Math.max(0, Math.min(100, ((proj - 16 * u) / (70 * u)) * 100)) };
    }
    return { feather: Math.max(0, Math.min(500, (proj - 100 * u) / (drag.s || 1))) };
  }

  function startMaskMove(event: ReactPointerEvent, mask: Mask) {
    if (tool !== "select") return;
    event.preventDefault();
    event.stopPropagation();
    if (activeMaskId !== mask.id) {
      onSelectMask?.(mask.id);
      return;
    }
    if (event.detail >= 2) {
      // double-click an edge inserts a point.
      insertPointOnEdge(mask, clientToComp(event));
      return;
    }
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const info = displayPointsFor(mask);
    setLive({ id: mask.id, points: info.points.map((pt) => ({ ...pt })) });
    dragRef.current = {
      kind: "move",
      maskId: mask.id,
      startLocal: unapplyMaskTransform(clientToLocal(event), info.t, info.center),
      origPoints: info.points.map((pt) => ({ ...pt })),
      t: info.t,
      center: info.center
    };
  }

  function togglePointSmooth(mask: Mask, pointId: string, info: { points: MaskPoint[]; center: { x: number; y: number } }) {
    const n = info.points.length;
    const index = info.points.findIndex((pt) => pt.id === pointId);
    if (index < 0) return;
    const point = info.points[index]!;
    const nextPoints = info.points.map((pt) => ({ ...pt }));
    if (point.inTangent || point.outTangent) {
      nextPoints[index] = { id: point.id, x: point.x, y: point.y }; // strip tangents (→ corner)
    } else {
      const prev = info.points[(index - 1 + n) % n]!;
      const next = info.points[(index + 1) % n]!;
      const dx = (next.x - prev.x) * 0.33;
      const dy = (next.y - prev.y) * 0.33;
      nextPoints[index] = { ...point, inTangent: { x: -dx, y: -dy }, outTangent: { x: dx, y: dy }, lockedTangents: true };
    }
    onUpdateLayerMasks?.(layer.id, (currentMasks) =>
      currentMasks.map((m) => (m.id === mask.id ? { ...m, shape: "bezier", points: nextPoints } : m))
    );
  }

  function deletePoint(mask: Mask, pointId: string, info: { points: MaskPoint[] }) {
    if (info.points.length <= 3) return;
    const nextPoints = info.points.filter((pt) => pt.id !== pointId);
    onCommitMaskPoints?.(layer.id, mask.id, nextPoints);
    setActivePointId(null);
  }

  function insertPointOnEdge(mask: Mask, compClick: { x: number; y: number }) {
    const info = displayPointsFor(mask);
    const screenPts = info.points.map((pt) => toComp(applyMaskTransform(pt, info.t, info.center)));
    const n = screenPts.length;
    let best = { index: -1, dist: Infinity, t: 0 };
    for (let i = 0; i < n; i += 1) {
      const a = screenPts[i]!;
      const b = screenPts[(i + 1) % n]!;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby || 1;
      const tt = Math.max(0, Math.min(1, ((compClick.x - a.x) * abx + (compClick.y - a.y) * aby) / lenSq));
      const px = a.x + abx * tt;
      const py = a.y + aby * tt;
      const dist = Math.hypot(compClick.x - px, compClick.y - py);
      if (dist < best.dist) best = { index: i, dist, t: tt };
    }
    if (best.index < 0) return;
    const a = info.points[best.index]!;
    const b = info.points[(best.index + 1) % n]!;
    const inserted: MaskPoint = { id: `mp_${Date.now()}_ins`, x: a.x + (b.x - a.x) * best.t, y: a.y + (b.y - a.y) * best.t };
    const nextPoints = [...info.points];
    nextPoints.splice(best.index + 1, 0, inserted);
    onCommitMaskPoints?.(layer.id, mask.id, nextPoints);
  }

  // --- shared pointer move/up --------------------------------------------------------------------

  function onPointerMove(event: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "draw") {
      const p = clientToComp(event);
      const square = event.shiftKey; // Shift → constrain to a square box (ellipse → circle, rect → square)
      setDraft((prev) => {
        if (!prev) return prev;
        if (!square) return { ...prev, x1: p.x, y1: p.y };
        const size = Math.max(Math.abs(p.x - prev.x0), Math.abs(p.y - prev.y0));
        return { ...prev, x1: prev.x0 + Math.sign(p.x - prev.x0 || 1) * size, y1: prev.y0 + Math.sign(p.y - prev.y0 || 1) * size };
      });
      return;
    }
    if (drag.kind === "pen") {
      const local = clientToLocal(event);
      setPenDraft((prev) => {
        if (!prev) return prev;
        const next = prev.map((pt) => ({ ...pt }));
        const point = next[drag.index];
        if (point) {
          const out = { x: local.x - point.x, y: local.y - point.y };
          point.outTangent = out;
          point.inTangent = { x: -out.x, y: -out.y };
          point.lockedTangents = true;
        }
        return next;
      });
      return;
    }
    if (drag.kind === "feather" || drag.kind === "opacity") {
      onPreviewMaskScalar?.(layer.id, drag.maskId, computeScalarPatch(drag, event), false);
      return;
    }
    if (drag.kind !== "point" && drag.kind !== "move" && drag.kind !== "tangent") return;
    const editable = unapplyMaskTransform(clientToLocal(event), drag.t, drag.center);
    if (drag.kind === "point") {
      // Shift → constrain the point to a horizontal/vertical move from where it started.
      let px = editable.x;
      let py = editable.y;
      if (event.shiftKey) {
        if (Math.abs(editable.x - drag.origin.x) >= Math.abs(editable.y - drag.origin.y)) py = drag.origin.y;
        else px = drag.origin.x;
      }
      setLive((prev) =>
        prev ? { ...prev, points: prev.points.map((pt) => (pt.id === drag.pointId ? { ...pt, x: px, y: py } : pt)) } : prev
      );
    } else if (drag.kind === "move") {
      let dx = editable.x - drag.startLocal.x;
      let dy = editable.y - drag.startLocal.y;
      if (event.shiftKey) {
        // Shift → lock the whole-mask move to the dominant axis.
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      setLive((prev) => (prev ? { ...prev, points: drag.origPoints.map((pt) => ({ ...pt, x: pt.x + dx, y: pt.y + dy })) } : prev));
    } else if (drag.kind === "tangent") {
      setLive((prev) =>
        prev
          ? {
              ...prev,
              points: prev.points.map((pt) => {
                if (pt.id !== drag.pointId) return pt;
                let vec = { x: editable.x - pt.x, y: editable.y - pt.y };
                if (event.shiftKey) {
                  // Shift → snap the handle to 45° increments.
                  const len = Math.hypot(vec.x, vec.y);
                  const ang = Math.round(Math.atan2(vec.y, vec.x) / (Math.PI / 4)) * (Math.PI / 4);
                  vec = { x: Math.cos(ang) * len, y: Math.sin(ang) * len };
                }
                const primary = drag.handle === "out" ? { outTangent: vec } : { inTangent: vec };
                const mirror = drag.mirror
                  ? drag.handle === "out"
                    ? { inTangent: { x: -vec.x, y: -vec.y } }
                    : { outTangent: { x: -vec.x, y: -vec.y } }
                  : {};
                return { ...pt, ...primary, ...mirror };
              })
            }
          : prev
      );
    }
  }

  function onPointerUp(event: ReactPointerEvent) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "feather" || drag.kind === "opacity") {
      onPreviewMaskScalar?.(layer.id, drag.maskId, computeScalarPatch(drag, event), true);
      return;
    }
    if (drag.kind === "draw") {
      const box = draft;
      setDraft(null);
      if (box && Math.abs(box.x1 - box.x0) > 4 && Math.abs(box.y1 - box.y0) > 4 && (tool === "rectangle" || tool === "ellipse")) {
        const a = toLocal({ x: box.x0, y: box.y0 });
        const b = toLocal({ x: box.x1, y: box.y1 });
        const mask = createBoxMask(tool, a.x, a.y, b.x, b.y, masks.length + 1);
        onUpdateLayerMasks?.(layer.id, (currentMasks) => [...currentMasks, mask]);
        onSelectMask?.(mask.id);
        onChangeMaskTool?.("select");
      }
      return;
    }
    if (drag.kind === "pen") return; // point finalized; keep drawing
    if (drag.kind === "tangent" && drag.pullOut) {
      // No meaningful drag → treat as a plain Alt-click: toggle this point corner⇄smooth.
      const livePoint = live?.points.find((pt) => pt.id === drag.pointId);
      const mag = livePoint?.outTangent ? Math.hypot(livePoint.outTangent.x, livePoint.outTangent.y) : 0;
      if (mag < 2) {
        setLive(null);
        const mask = masks.find((m) => m.id === drag.maskId);
        if (mask) togglePointSmooth(mask, drag.pointId, displayPointsFor(mask));
        return;
      }
      // Real pull-out: ensure a curvable shape so the handles render, then commit the tangents.
      const mask = masks.find((m) => m.id === drag.maskId);
      if (mask && mask.shape !== "bezier" && mask.shape !== "polygon") {
        onUpdateLayerMasks?.(layer.id, (currentMasks) =>
          currentMasks.map((m) => (m.id === drag.maskId ? { ...m, shape: "bezier" } : m))
        );
      }
      commitLive();
      return;
    }
    commitLive();
    void event;
  }

  // Pen keyboard: Enter closes, Esc cancels, Backspace removes the last point. Capture + stop so the
  // editor's global Delete/Backspace (layer delete) doesn't fire mid-draw.
  useEffect(() => {
    if (!penDraft) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
        finalizePen(penDraft ?? []);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPenDraft(null);
      } else if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPenDraft((prev) => {
          if (!prev) return prev;
          const next = prev.slice(0, -1);
          return next.length ? next : null;
        });
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [penDraft, tool, masks.length]);

  // Cancel an in-progress pen draft whenever the tool switches away (e.g. Esc → select in EditorPage).
  useEffect(() => {
    if (tool !== "pen" && tool !== "polygon") setPenDraft(null);
  }, [tool]);

  const draftPath = (() => {
    if (!draft) return "";
    const x = Math.min(draft.x0, draft.x1);
    const y = Math.min(draft.y0, draft.y1);
    const w = Math.abs(draft.x1 - draft.x0);
    const h = Math.abs(draft.y1 - draft.y0);
    if (tool === "ellipse") {
      const rx = w / 2;
      const ry = h / 2;
      const ecx = x + rx;
      const ecy = y + ry;
      return `M ${ecx - rx} ${ecy} A ${rx} ${ry} 0 1 0 ${ecx + rx} ${ecy} A ${rx} ${ry} 0 1 0 ${ecx - rx} ${ecy} Z`;
    }
    return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  })();

  // In-progress pen path (open polyline / Bezier in comp space).
  const penPath = (() => {
    if (!penDraft || penDraft.length === 0) return "";
    const first = toComp(penDraft[0]!);
    let d = `M ${first.x} ${first.y}`;
    for (let i = 1; i < penDraft.length; i += 1) {
      const prev = penDraft[i - 1]!;
      const cur = penDraft[i]!;
      const p = toComp(cur);
      if (prev.outTangent || cur.inTangent) {
        const c1 = toComp({ x: prev.x + (prev.outTangent?.x ?? 0), y: prev.y + (prev.outTangent?.y ?? 0) });
        const c2 = toComp({ x: cur.x + (cur.inTangent?.x ?? 0), y: cur.y + (cur.inTangent?.y ?? 0) });
        d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p.x} ${p.y}`;
      } else {
        d += ` L ${p.x} ${p.y}`;
      }
    }
    return d;
  })();

  return (
    <svg
      ref={svgRef}
      className="preview-mask-overlay"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {tool !== "select" ? (
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="transparent"
          style={{ pointerEvents: "auto", cursor: "crosshair" }}
          onPointerDown={onBackgroundPointerDown}
        />
      ) : null}

      {masks.map((mask) => {
        const info = displayPointsFor(mask);
        if (info.points.length < 2) return null;
        const screenPts = info.points.map((pt) => toComp(applyMaskTransform(pt, info.t, info.center)));
        const compMask: Mask = { ...mask, points: info.points.map((pt, i) => ({ ...pt, x: screenPts[i]!.x, y: screenPts[i]!.y })) };
        // tangents are relative; forward them through both transforms by mapping point+tangent then subtracting.
        const compPoints: MaskPoint[] = info.points.map((pt, i) => {
          const base = screenPts[i]!;
          const next: MaskPoint = { id: pt.id, x: base.x, y: base.y };
          if (pt.inTangent) {
            const h = toComp(applyMaskTransform({ x: pt.x + pt.inTangent.x, y: pt.y + pt.inTangent.y }, info.t, info.center));
            next.inTangent = { x: h.x - base.x, y: h.y - base.y };
          }
          if (pt.outTangent) {
            const h = toComp(applyMaskTransform({ x: pt.x + pt.outTangent.x, y: pt.y + pt.outTangent.y }, info.t, info.center));
            next.outTangent = { x: h.x - base.x, y: h.y - base.y };
          }
          return next;
        });
        const d = maskShapeToPathD({ ...compMask, points: compPoints });
        const isActive = mask.id === activeMaskId;
        // Select tool: the ACTIVE mask is draggable by its whole interior (transparent fill hit area) to move
        // it; inactive masks hit-test the stroke (click to select). So when a mask is NOT being edited, clicks
        // inside it fall through to the layer (drag the text/clip); selecting the mask makes its interior drag
        // the mask. While a draw tool is active, masks don't capture pointers so drawing over them still works.
        const interactive = tool === "select";
        return (
          <g key={mask.id} className={isActive ? "mask-outline is-active" : "mask-outline"}>
            <path
              d={d}
              fill={isActive && interactive ? "transparent" : "none"}
              strokeWidth={strokeW}
              style={{ pointerEvents: interactive ? (isActive ? "all" : "stroke") : "none", cursor: isActive ? "move" : "pointer" }}
              onPointerDown={(event) => startMaskMove(event, mask)}
            />
            {isActive ? (
              <>
                {compPoints.map((pt) => (
                  <g key={pt.id}>
                    {pt.inTangent ? (
                      <>
                        <line className="mask-tangent-line" x1={pt.x} y1={pt.y} x2={pt.x + pt.inTangent.x} y2={pt.y + pt.inTangent.y} strokeWidth={strokeW * 0.7} />
                        <circle
                          className="mask-tangent"
                          cx={pt.x + pt.inTangent.x}
                          cy={pt.y + pt.inTangent.y}
                          r={handleR * 0.8}
                          style={{ pointerEvents: "auto", cursor: "grab" }}
                          onPointerDown={(event) => startTangentDrag(event, mask, pt.id, "in")}
                        />
                      </>
                    ) : null}
                    {pt.outTangent ? (
                      <>
                        <line className="mask-tangent-line" x1={pt.x} y1={pt.y} x2={pt.x + pt.outTangent.x} y2={pt.y + pt.outTangent.y} strokeWidth={strokeW * 0.7} />
                        <circle
                          className="mask-tangent"
                          cx={pt.x + pt.outTangent.x}
                          cy={pt.y + pt.outTangent.y}
                          r={handleR * 0.8}
                          style={{ pointerEvents: "auto", cursor: "grab" }}
                          onPointerDown={(event) => startTangentDrag(event, mask, pt.id, "out")}
                        />
                      </>
                    ) : null}
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={handleR}
                      className={activePointId === pt.id ? "mask-point is-selected" : "mask-point"}
                      style={{ pointerEvents: "auto", cursor: "grab" }}
                      onPointerDown={(event) => startPointDrag(event, mask, pt.id)}
                    />
                  </g>
                ))}
                {(() => {
                  // Feather (square) + opacity (circle) widget on a guide off the mask's top edge. Values are
                  // live from the mask (the widget commits transiently while dragging) so nub + clip update together.
                  const r = resolveMaskAtTime(mask, layer.animations, localTime);
                  const featherVal = r.feather;
                  const opacityVal = r.opacity;
                  const anchor = screenPts.reduce((a, b) => (b.y < a.y ? b : a), screenPts[0]!);
                  const cx2 = screenPts.reduce((sum, p) => sum + p.x, 0) / screenPts.length;
                  const cy2 = screenPts.reduce((sum, p) => sum + p.y, 0) / screenPts.length;
                  let nx = anchor.x - cx2;
                  let ny = anchor.y - cy2;
                  const nl = Math.hypot(nx, ny) || 1;
                  nx = nl > 0.001 ? nx / nl : 0;
                  ny = nl > 0.001 ? ny / nl : -1;
                  const u = 1 / Math.max(0.05, scale);
                  const opDist = 16 * u + (opacityVal / 100) * 70 * u;
                  const feDist = 100 * u + featherVal * s;
                  const opPos = { x: anchor.x + nx * opDist, y: anchor.y + ny * opDist };
                  const fePos = { x: anchor.x + nx * feDist, y: anchor.y + ny * feDist };
                  const sq = handleR * 1.9;
                  // Dashed outline offset outward from each point along its edge-normal by the feather amount,
                  // so it follows the mask shape and grows as you drag the feather handle.
                  let featherOutline = "";
                  if (featherVal > 0 && compPoints.length >= 2) {
                    const off = featherVal * s;
                    const m = compPoints.length;
                    const offPts = compPoints.map((pt, i) => {
                      const prev = compPoints[(i - 1 + m) % m]!;
                      const nxt = compPoints[(i + 1) % m]!;
                      const perp = (ax: number, ay: number, bx: number, by: number) => {
                        const dx = bx - ax;
                        const dy = by - ay;
                        const l = Math.hypot(dx, dy) || 1;
                        return { x: dy / l, y: -dx / l };
                      };
                      const p1 = perp(prev.x, prev.y, pt.x, pt.y);
                      const p2 = perp(pt.x, pt.y, nxt.x, nxt.y);
                      let mxv = p1.x + p2.x;
                      let myv = p1.y + p2.y;
                      const ml = Math.hypot(mxv, myv) || 1;
                      mxv /= ml;
                      myv /= ml;
                      if (mxv * (pt.x - cx2) + myv * (pt.y - cy2) < 0) {
                        mxv = -mxv;
                        myv = -myv;
                      }
                      return { x: pt.x + mxv * off, y: pt.y + myv * off };
                    });
                    featherOutline = `M ${offPts[0]!.x} ${offPts[0]!.y}` + offPts.slice(1).map((p) => ` L ${p.x} ${p.y}`).join("") + " Z";
                  }
                  return (
                    <g className="mask-scalar-widget">
                      {featherOutline ? (
                        <path className="mask-feather-outline" d={featherOutline} fill="none" strokeWidth={strokeW} />
                      ) : null}
                      <line className="mask-tangent-line" x1={anchor.x} y1={anchor.y} x2={fePos.x} y2={fePos.y} strokeWidth={strokeW * 0.7} />
                      <circle
                        className="mask-scalar-opacity"
                        cx={opPos.x}
                        cy={opPos.y}
                        r={handleR}
                        style={{ pointerEvents: "auto", cursor: "grab" }}
                        onPointerDown={(event) => startScalarDrag(event, mask.id, "opacity", anchor, { x: nx, y: ny }, s)}
                      >
                        <title>Opacity {Math.round(opacityVal)}% — drag</title>
                      </circle>
                      <rect
                        className="mask-scalar-feather"
                        x={fePos.x - sq / 2}
                        y={fePos.y - sq / 2}
                        width={sq}
                        height={sq}
                        style={{ pointerEvents: "auto", cursor: "grab" }}
                        onPointerDown={(event) => startScalarDrag(event, mask.id, "feather", anchor, { x: nx, y: ny }, s)}
                      >
                        <title>Feather {Math.round(featherVal)}px — drag out/in</title>
                      </rect>
                    </g>
                  );
                })()}
              </>
            ) : null}
          </g>
        );
      })}

      {draftPath ? <path className="mask-draft" d={draftPath} strokeWidth={strokeW} /> : null}
      {penPath ? (
        <g className="mask-pen-draft">
          <path className="mask-draft" d={penPath} strokeWidth={strokeW} fill="none" />
          {penDraft!.map((pt, i) => {
            const c = toComp(pt);
            return <circle key={pt.id} cx={c.x} cy={c.y} r={handleR} className={i === 0 ? "mask-point is-first" : "mask-point"} />;
          })}
        </g>
      ) : null}
    </svg>
  );
}

function selectionOverlayStyle(style: CSSProperties): CSSProperties {
  // The overlay copies only the clip's GEOMETRY (position / size / transform). Strip every appearance
  // property so the selection box + handles render as plain UI chrome — in particular `mixBlendMode`
  // and `opacity`, or a clip's blend mode / fade would also blend/fade the handles.
  const {
    background: _background,
    backgroundColor: _backgroundColor,
    boxShadow: _boxShadow,
    color: _color,
    filter: _filter,
    mixBlendMode: _mixBlendMode,
    opacity: _opacity,
    textShadow: _textShadow,
    WebkitTextStroke: _webkitTextStroke,
    ...layoutStyle
  } = style;

  return layoutStyle;
}

function positionFromDrag(
  event: ReactPointerEvent<HTMLElement>,
  drag: {
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    surfaceWidth: number;
    surfaceHeight: number;
  }
) {
  return {
    x: clamp(drag.startX + ((event.clientX - drag.startClientX) / drag.surfaceWidth) * 100, -50, 150),
    y: clamp(drag.startY + ((event.clientY - drag.startClientY) / drag.surfaceHeight) * 100, -50, 150)
  };
}

function positionFromSurfacePoint(
  event: ReactPointerEvent<SVGCircleElement>,
  surface: {
    surfaceWidth: number;
    surfaceHeight: number;
  }
) {
  const compositionSpace = event.currentTarget.closest(".preview-composition-space");
  const bounds = compositionSpace instanceof HTMLElement ? compositionSpace.getBoundingClientRect() : undefined;
  if (!bounds) {
    return { x: 50, y: 50 };
  }

  return {
    x: clamp(((event.clientX - bounds.left) / surface.surfaceWidth) * 100, -50, 150),
    y: clamp(((event.clientY - bounds.top) / surface.surfaceHeight) * 100, -50, 150)
  };
}

function tangentFromSurfacePoint(
  event: ReactPointerEvent<SVGCircleElement>,
  surface: {
    surfaceWidth: number;
    surfaceHeight: number;
  },
  origin: { x: number; y: number }
) {
  const point = positionFromSurfacePoint(event, surface);
  return {
    x: clamp(point.x - origin.x, -120, 120),
    y: clamp(point.y - origin.y, -120, 120)
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distance(x1: number, y1: number, x2: number, y2: number) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function scaleFromResize(
  event: ReactPointerEvent<HTMLElement>,
  resize: {
    centerClientX: number;
    centerClientY: number;
    startDistance: number;
    startScale: number;
  }
) {
  const nextDistance = distance(event.clientX, event.clientY, resize.centerClientX, resize.centerClientY);
  // Floor only — no upper cap (Premiere-style free scaling); handlePreviewScaleLayer keeps the floor too.
  return Math.max(0.01, resize.startScale * (nextDistance / resize.startDistance));
}

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

function scaleHud(scale: number): PreviewTransformHud {
  return {
    mode: "scale",
    primary: `Scale ${formatPercent(scale * 100)}`
  };
}

function sizeHud(widthPercent: number, heightPercent: number): PreviewTransformHud {
  return {
    mode: "size",
    primary: `Size ${formatPercent(widthPercent)}`,
    secondary: `H ${formatPercent(heightPercent)}`
  };
}

/** Selection-box size override (as CSS width/height %) for a `contain` media layer, so its handles hug the
 *  source's natural rect inside the frame. Returns undefined when the box should stay full-frame (cover/fill,
 *  non-media, unknown aspect, or the source already fills the frame). */
function contentBoxSizeOverride(
  layer: TimelineLayer,
  sourceAspect: number | undefined,
  frameAspect: number | undefined
): { width: string; height: string } | undefined {
  if (layer.type !== "image" && layer.type !== "video") return undefined;
  if (getCompositionObjectFit(layer) !== "contain") return undefined;
  if (!sourceAspect || !frameAspect || sourceAspect <= 0 || frameAspect <= 0) return undefined;
  let w = 1;
  let h = 1;
  if (sourceAspect > frameAspect) {
    h = frameAspect / sourceAspect; // source wider than frame → full width, letterboxed height
  } else {
    w = sourceAspect / frameAspect; // source taller/narrower → full height, pillarboxed width
  }
  if (w >= 0.999 && h >= 0.999) return undefined;
  return { width: `${(w * 100).toFixed(4)}%`, height: `${(h * 100).toFixed(4)}%` };
}

/** Map an edge resize handle (by its `preview-resize-handle-<n|e|s|w>` class) to the crop edge it trims.
 *  Corner handles (nw/ne/sw/se) return null so they keep driving scale. */
function mediaCropEdgeFromHandle(el: Element): "top" | "right" | "bottom" | "left" | null {
  if (el.classList.contains("preview-resize-handle-n")) return "top";
  if (el.classList.contains("preview-resize-handle-s")) return "bottom";
  if (el.classList.contains("preview-resize-handle-e")) return "right";
  if (el.classList.contains("preview-resize-handle-w")) return "left";
  return null;
}

function cropHud(edge: "top" | "right" | "bottom" | "left", value: number): PreviewTransformHud {
  return {
    mode: "size",
    primary: `Crop ${edge[0]!.toUpperCase()}${edge.slice(1)}`,
    secondary: formatPercent(value * 100)
  };
}

function normalizeDegrees(value: number) {
  let next = value % 360;
  if (next <= -180) next += 360;
  if (next > 180) next -= 360;
  return next;
}

function rotationHud(rotation: number, snapped: boolean): PreviewTransformHud {
  return {
    mode: "rotate",
    primary: `Rotate ${Math.round(normalizeDegrees(rotation))}°`,
    secondary: snapped ? "Snap" : undefined,
    snapped
  };
}

function shapeSizeFromResize(
  event: ReactPointerEvent<HTMLElement>,
  resize: {
    centerClientX: number;
    centerClientY: number;
    startWidthPercent: number;
    startHeightPercent: number;
    surfaceWidth: number;
    surfaceHeight: number;
  }
) {
  return {
    widthPercent: clamp((Math.abs(event.clientX - resize.centerClientX) / resize.surfaceWidth) * 200, 2, 200),
    heightPercent: clamp((Math.abs(event.clientY - resize.centerClientY) / resize.surfaceHeight) * 200, 2, 200)
  };
}

function angleDegrees(x: number, y: number, centerX: number, centerY: number) {
  return (Math.atan2(y - centerY, x - centerX) * 180) / Math.PI;
}

function rotationFromPointer(
  event: ReactPointerEvent<HTMLElement>,
  rotate: {
    centerClientX: number;
    centerClientY: number;
    startAngle: number;
    startRotation: number;
  }
) {
  return rotate.startRotation + angleDegrees(event.clientX, event.clientY, rotate.centerClientX, rotate.centerClientY) - rotate.startAngle;
}

const ROTATION_SNAP_ANGLES = [-180, -135, -120, -90, -60, -45, 0, 45, 60, 90, 120, 135, 180] as const;
const ROTATION_SNAP_TOLERANCE_DEGREES = 4;

function snapRotation(rotation: number) {
  const normalized = normalizeDegrees(rotation);
  let best = normalized;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const angle of ROTATION_SNAP_ANGLES) {
    const delta = Math.abs(normalizeDegrees(normalized - angle));
    if (delta < bestDelta) {
      best = angle;
      bestDelta = delta;
    }
  }
  return bestDelta <= ROTATION_SNAP_TOLERANCE_DEGREES ? { value: best, snapped: true } : { value: rotation, snapped: false };
}

function rotationFromPointerWithSnap(
  event: ReactPointerEvent<HTMLElement>,
  rotate: {
    centerClientX: number;
    centerClientY: number;
    startAngle: number;
    startRotation: number;
  },
  snapEnabled: boolean
) {
  const raw = rotationFromPointer(event, rotate);
  return snapEnabled ? snapRotation(raw) : { value: raw, snapped: false };
}

/** Exported for the viewer-capture proxy generator, which must mirror the viewer's activity rules exactly. */
export function isLayerActive(layer: TimelineLayer, currentTime: number) {
  return currentTime >= layer.startSeconds && currentTime <= layer.startSeconds + layer.durationSeconds;
}

/**
 * True when `layer` is the OUTGOING side of a junction transition that is currently playing — i.e. the
 * next same-track clip starts at this clip's end and carries a `transitionIn`, and the playhead is in
 * that transition's window `[cut, cut+D]`. The clip then keeps rendering (held at its out-point frame —
 * the "repeated frames" a pro editor shows when a clip has no spare handle) under the incoming reveal,
 * without its timeline length ever changing.
 */
export function isOutgoingInPostroll(layer: TimelineLayer, track: TimelineTrack, currentTime: number): boolean {
  if (layer.type === "audio") {
    return false;
  }
  const end = layer.startSeconds + layer.durationSeconds;
  if (currentTime <= end) {
    return false;
  }
  for (const other of track.layers) {
    if (other.id === layer.id || !other.transitionIn) {
      continue;
    }
    // Post-roll matches the clamped transition window (never past the incoming clip it reveals).
    const window = Math.min(other.transitionIn.durationSeconds, other.durationSeconds);
    if (Math.abs(other.startSeconds - end) < 0.05 && currentTime <= end + window) {
      return true;
    }
  }
  return false;
}

function resolveLayerUrl(layer: TimelineLayer | undefined, assets: SourceAsset[], sourceAsset: SourceAsset | null | undefined) {
  return resolvePlaybackUrl(resolveLayerAsset(layer, assets, sourceAsset));
}

/** Synthetic in-memory image asset for a vector graphic layer — its fileUrl is the recolored SVG data URL, so
 *  the layer needs no persisted SourceAsset. Rebuilt each call (cheap); the data URL is stable per svg+fill so
 *  the image/texture cache still hits across renders. */
function graphicLayerAsset(layer: TimelineLayer): SourceAsset {
  const graphic = layer.graphic!;
  return {
    id: `graphic_${layer.id}`,
    userId: "local",
    fileName: `${layer.name || "graphic"}.svg`,
    fileType: "image/svg+xml",
    fileUrl: graphicToDataUrl(graphic),
    durationSeconds: layer.durationSeconds || 5,
    width: graphic.naturalWidth ?? 100,
    height: graphic.naturalHeight ?? 100,
    status: "ready",
    createdAt: layer.id,
    source: "graphic"
  } as SourceAsset;
}

function resolveLayerAsset(layer: TimelineLayer | undefined, assets: SourceAsset[], sourceAsset: SourceAsset | null | undefined) {
  if (!layer) {
    return undefined;
  }

  // Vector graphic layers are self-contained (no SourceAsset): synthesize an image asset whose fileUrl is the
  // recolored SVG data URL, so every asset-driven preview path (grade → scene → compositor) works unchanged.
  if (layer.graphic) {
    return graphicLayerAsset(layer);
  }

  const assignedAsset = layer.assetId ? assets.find((asset) => asset.id === layer.assetId) : undefined;
  const asset = assignedAsset ?? sourceAsset;
  if (!asset) {
    return undefined;
  }

  if (layer.type === "image" && !asset.fileType.startsWith("image/")) {
    return undefined;
  }

  if (layer.type === "audio" && !asset.fileType.startsWith("audio/") && !asset.fileType.startsWith("video/")) {
    return undefined;
  }

  if (layer.type === "video" || layer.type === "image") {
    return asset;
  }

  if (layer.type === "audio") {
    return asset;
  }

  return undefined;
}

// FULL-QUALITY PLAYBACK (pro toggle, 2026-07-05): the transport's "1" resolution preset also
// bypasses the ingest proxies — playing AND paused frames come from the ORIGINAL media. ½/¼/Auto
// keep the proxy substitution (the low-end smoothness path). Module-level flag set by EditorPage
// from the quality control; the accompanying setState re-renders the tree so every layer
// re-resolves its src when it flips.
let ingestProxyPlaybackEnabled = true;
export function setIngestProxyPlaybackEnabled(enabled: boolean): void {
  ingestProxyPlaybackEnabled = enabled;
}

function resolvePlaybackUrl(asset: SourceAsset | undefined) {
  if (!asset) {
    return undefined;
  }

  const previewAsset = asset as SourceAsset & { proxyUrl?: string | undefined; previewUrl?: string | undefined };
  if (!ingestProxyPlaybackEnabled) {
    return asset.fileUrl ?? previewAsset.previewUrl ?? previewAsset.proxyUrl;
  }
  return previewAsset.proxyUrl ?? previewAsset.previewUrl ?? asset.fileUrl;
}

function resolvePosterUrl(asset: SourceAsset | undefined) {
  const previewAsset = asset as (SourceAsset & { posterUrl?: string | undefined }) | undefined;
  return previewAsset?.posterUrl;
}

/**
 * Builds the warped-text vector overlay (opentype.js outline + envelope mesh) for a
 * text layer. Async because the font binary may need fetching; returns null while
 * loading or when the font isn't hosted, so the caller falls back to plain text.
 */
function useWarpedTextSvg(layer: TimelineLayer, currentTime: number): string | null {
  const isText = layer.type === "text";
  const warpActive = isText && hasTextWarp(layer.textWarp);
  const style = isText ? getCompositionTextStyle(layer, { currentTimeSeconds: currentTime }) : null;
  const runs = isText ? getVisibleTextRuns(layer, currentTime) : [];
  const warpKey = warpActive
    ? JSON.stringify([
        normalizeTextWarp(layer.textWarp),
        runs.map((run) => [run.text, run.color ?? "", run.fontSizeMultiplier ?? 1]),
        style?.fontSize,
        style?.fontFamily,
        style?.fontWeight,
        style?.color,
        style?.textAlign,
        style?.WebkitTextStroke
      ])
    : "";
  const latest = useRef<{ warp: typeof layer.textWarp; runs: typeof runs; style: typeof style }>({
    warp: layer.textWarp,
    runs,
    style
  });
  latest.current = { warp: layer.textWarp, runs, style };
  const [warpSvg, setWarpSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!warpActive) {
      setWarpSvg(null);
      return;
    }
    let cancelled = false;
    const { warp, runs: latestRuns, style: latestStyle } = latest.current;
    void buildWarpedTextPathSvg(warp, latestRuns, latestStyle ?? {}).then((markup) => {
      if (!cancelled) setWarpSvg(markup ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [warpActive, warpKey]);

  return warpActive ? warpSvg : null;
}
