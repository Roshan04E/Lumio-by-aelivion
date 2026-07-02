import { Aperture, ChevronLeft, ChevronRight, ChevronsRight, Contrast, Copy, Diamond, Eye, EyeOff, Film, Flag, Hand, Image, Info, Keyboard, Link2, Lock, Magnet, Maximize2, MousePointer2, MoveHorizontal, Music, Redo2, RefreshCw, Scissors, Shapes, SlidersHorizontal, SplitSquareHorizontal, Trash2, Type, Undo2, Unlink2, Unlock, Volume2, VolumeX, X, Zap } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { computeSnapTargets, getCompositionVolume, getLayerAnimations, getTimelineEffectDefinition, getTransition, snapValue, TRANSITION_MARKER, type SourceAsset, type TimelineComposition, type TimelineEffectType, type TimelineKeyframeV2, type TimelineLayer, type TimelineLayerType, type TimelineToolMode, type TimelineTrack, type TransitionKind, type TransitionSpec } from "@lumio-by-aelivion/shared";
import { useAudioPeaksSlice } from "../lib/audioPeaks";
import {
  VOLUME_HANDLE_IN_DX,
  VOLUME_HANDLE_OUT_DX,
  VOLUME_MAX,
  VOLUME_UNITY,
  addVolumePoint,
  cycleVolumePointInterpolation,
  getVolumeBase,
  getVolumePoints,
  moveVolumePoint,
  removeVolumePoint,
  setVolumeBase,
  setVolumePointHandle,
  volumeInterpolationLabel
} from "../editor/audioVolume";
import { useVideoThumbnails } from "../lib/videoThumbnails";
import { useWheelScrollPerformance } from "../lib/useWheelScrollPerformance";
import { favouriteTransitionSpecs } from "../editor/effects/catalog";
import { loadFavourites } from "../editor/effects/favourites";
import type { PreviewCacheRulerSegment, ProxyCacheStatus } from "../editor/performance/renderCache";

type LayerSelectMode = "replace" | "toggle" | "range" | "add-range";
type LayerCollectionSelectMode = "replace" | "add" | "toggle";

type DragState = {
  layerId: string;
  lane: HTMLDivElement;
  pointerId: number;
  offsetSeconds: number;
  previewStartSeconds: number;
  previewTrackId: string;
  movedLayerIds: string[];
  baseStartByLayerId: Record<string, number>;
  previewStartByLayerId: Record<string, number>;
  snappedTo: number | null;
} | null;

type ResizeState = {
  edge: "start" | "end";
  layerId: string;
  lane: HTMLDivElement;
  pointerId: number;
  previewStartSeconds: number;
  previewDurationSeconds: number;
  snappedTo: number | null;
} | null;

type KeyframeDragState = {
  clip: HTMLDivElement;
  keyframeId: string;
  layerId: string;
  pointerId: number;
  previewTimeSeconds: number;
} | null;

type TransitionDragState = {
  clip: HTMLDivElement;
  layerId: string;
  side: "fadeIn" | "fadeOut";
  pointerId: number;
  previewDurationSeconds: number;
} | null;

// Cross-dissolve junction drag: the element straddles a cut between two same-track clips. Its right
// edge is anchored on the left clip's end (fixed); dragging adjusts the overlap duration `D`.
type CrossDragState = {
  leftLayerId: string;
  rightLayerId: string;
  lane: HTMLDivElement;
  pointerId: number;
  baseDurationSeconds: number;
  downLaneSeconds: number;
  previewDurationSeconds: number;
} | null;

/** A detected junction transition between two same-track clips. */
type TimelineJunction = {
  leftLayerId: string;
  rightLayerId: string;
  kind: TransitionKind;
  /** The cut between the two clips — the element is centred here so it straddles both, Premiere-style. */
  cutSeconds: number;
  startSeconds: number;
  durationSeconds: number;
};

/** Short label + lucide glyph for a junction transition kind (shown on the on-timeline element). */
function transitionGlyph(kind: TransitionKind) {
  switch (kind) {
    case "dip":
      return <Contrast size={11} />;
    case "slide":
      return <MoveHorizontal size={11} />;
    case "push":
      return <ChevronsRight size={11} />;
    case "zoom":
      return <Maximize2 size={11} />;
    case "wipe":
      return <ChevronRight size={11} />;
    case "iris":
      return <Aperture size={11} />;
    case "punchZoom":
    case "zoomBlur":
    case "spin":
      return <Maximize2 size={11} />;
    case "whipPan":
    case "blurSwipe":
    case "parallaxPush":
      return <MoveHorizontal size={11} />;
    case "lumaFade":
    case "flash":
    case "lightLeak":
      return <Contrast size={11} />;
    case "filmBurn":
      return <Film size={11} />;
    case "maskReveal":
      return <Diamond size={11} />;
    case "glitch":
    case "pixelate":
    case "shake":
      return <ChevronsRight size={11} />;
    default:
      return <X size={11} />;
  }
}

/**
 * The right-click "Add transition" submenu: the default Cross Dissolve plus whatever transitions the
 * user has starred as favourites in the Effects panel (read fresh each open). Durations are filled on apply.
 */
function contextTransitions(): Array<{ label: string; spec: Omit<TransitionSpec, "durationSeconds"> }> {
  return [
    { label: "Default cross dissolve", spec: { kind: "crossDissolve" } },
    ...favouriteTransitionSpecs(loadFavourites())
  ];
}

/**
 * The junction a right-clicked clip participates in: the (left, right) pair and whether a transition
 * already exists there. Detects both a not-yet-transitioned touching cut (for Add) and an existing
 * transition where this clip is the incoming or the outgoing (for Change / Clear, even when the
 * extend-the-tail overlap means the clips are no longer exactly touching).
 */
function findClipTransitionContext(
  track: TimelineTrack,
  layer: TimelineLayer
): { leftLayerId: string; rightLayerId: string; hasTransition: boolean } | null {
  if (track.type === "audio" || layer.type === "audio") {
    return null;
  }
  const layers = [...track.layers].sort((a, b) => a.startSeconds - b.startSeconds);
  const index = layers.findIndex((item) => item.id === layer.id);
  if (index < 0) {
    return null;
  }
  const prev = index > 0 ? layers[index - 1]! : null;
  const next = index < layers.length - 1 ? layers[index + 1]! : null;
  // Existing transition: this clip is the incoming (carries transitionIn), or the next clip is.
  if (layer.transitionIn && prev) {
    return { leftLayerId: prev.id, rightLayerId: layer.id, hasTransition: true };
  }
  if (next?.transitionIn) {
    return { leftLayerId: layer.id, rightLayerId: next.id, hasTransition: true };
  }
  // No transition yet: a touching cut on either side.
  const touches = (a: TimelineLayer, b: TimelineLayer) => Math.abs(b.startSeconds - (a.startSeconds + a.durationSeconds)) < 0.02;
  if (next && touches(layer, next)) {
    return { leftLayerId: layer.id, rightLayerId: next.id, hasTransition: false };
  }
  if (prev && touches(prev, layer)) {
    return { leftLayerId: prev.id, rightLayerId: layer.id, hasTransition: false };
  }
  return null;
}

function transitionLabel(kind: TransitionKind): string {
  return getTransition(kind)?.name ?? "Transition";
}

const shortcutCheatSheet: Array<{ keys: string; label: string }> = [
  { keys: "V", label: "Select tool" },
  { keys: "C", label: "Blade tool — click a clip to split" },
  { keys: "H", label: "Hand tool — drag to pan" },
  { keys: "S", label: "Split selected clips at playhead" },
  { keys: "⌘D", label: "Duplicate selected clip" },
  { keys: "⇧⌫", label: "Ripple delete selected clip" },
  { keys: "Delete", label: "Delete selected clip" },
  { keys: "N", label: "Toggle snapping" },
  { keys: "M", label: "Add/remove marker at playhead" },
  { keys: "I", label: "Set/clear in point at playhead" },
  { keys: "O", label: "Set/clear out point at playhead" },
  { keys: "\\", label: "Fit timeline to view" },
  { keys: "⌘Z", label: "Undo" },
  { keys: "⌘⇧Z", label: "Redo" },
  { keys: "⌘M", label: "Export on this device (local)" },
  { keys: "⌘⇧M", label: "Export to cloud" },
  { keys: "Space", label: "Play / pause" },
  { keys: "Home", label: "Jump to start" },
  { keys: "End", label: "Jump to end" },
  { keys: "←", label: "Previous frame" },
  { keys: "→", label: "Next frame" },
  { keys: "?", label: "Toggle this cheat sheet" }
];

export function TimelineStrip({
  composition,
  assets = [],
  currentTime,
  isPlaying,
  layerMaxDurations = {},
  playbackStart,
  selectedLayerId,
  selectedLayerIds = [],
  trackHeight,
  onChangeCurrentTime,
  onClearSelection,
  onSelectLayers,
  onSelectLayer,
  onLinkSelectedLayers,
  onDeleteSelectedLayers,
  onMoveLayer,
  onResizeLayer,
  onToggleTrack,
  onDeleteTrack,
  onDeleteLayer,
  onDeleteKeyframe,
  onUnlinkLayer,
  onUnlinkSelectedLayers,
  onAddLayer,
  onAddTrack,
  onDropAsset,
  onDropTimelineEffect,
  onMoveKeyframe,
  onSetTransition,
  onRemoveTransition,
  onAddCrossDissolve,
  onSetCrossDissolve,
  onRemoveCrossDissolve,
  onChangeTrackHeight,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  toolMode = "select",
  onChangeToolMode,
  snapEnabled = true,
  onToggleSnap,
  onSplitLayerAt,
  onSplitAtPlayhead,
  onRippleDeleteLayer,
  onDuplicateLayer,
  markers = [],
  onToggleMarkerAtPlayhead,
  onRemoveMarker,
  inPointSeconds,
  outPointSeconds,
  onSetInPoint,
  onSetOutPoint,
  onClearInPoint,
  onClearOutPoint,
  onClearInOutPoints,
  proxyCacheSegments = [],
  proxyCacheStatus,
  onRegenerateProxyCache,
  livePlaybackMode = false,
  onToggleLivePlayback,
  onReplaceLayerAsset,
  onSlipLayer,
  onPreviewVolume
}: {
  composition: TimelineComposition;
  assets?: SourceAsset[];
  currentTime: number;
  isPlaying: boolean;
  layerMaxDurations?: Record<string, number>;
  playbackStart?: { clockMs: number; timeSeconds: number } | null | undefined;
  selectedLayerId?: string | undefined;
  selectedLayerIds?: string[] | undefined;
  trackHeight: number;
  onChangeCurrentTime: (timeSeconds: number) => void;
  onClearSelection: () => void;
  onSelectLayers: (layerIds: string[], mode?: LayerCollectionSelectMode) => void;
  onSelectLayer: (layerId: string, mode?: LayerSelectMode) => void;
  onLinkSelectedLayers: () => void;
  onDeleteSelectedLayers?: (() => void) | undefined;
  onMoveLayer: (layerId: string, startSeconds: number, trackId?: string | undefined, movedLayerIds?: string[] | undefined) => void;
  onResizeLayer: (layerId: string, startSeconds: number, durationSeconds: number) => void;
  onToggleTrack: (trackId: string, patch: Partial<Pick<TimelineTrack, "locked" | "muted" | "solo">>) => void;
  onDeleteTrack: (trackId: string) => void;
  onDeleteLayer: (layerId: string) => void;
  onDeleteKeyframe: (layerId: string, keyframeId: string) => void;
  onUnlinkLayer?: (layerId: string) => void;
  onUnlinkSelectedLayers?: () => void;
  onAddLayer: (type: TimelineLayerType) => void;
  onAddTrack: (type: TimelineTrack["type"]) => void;
  onDropAsset: (assetId: string, trackId: string, startSeconds: number, replaceLayerId?: string | undefined) => void;
  onDropTimelineEffect: (effectType: TimelineEffectType, layerId: string) => void;
  onMoveKeyframe: (layerId: string, keyframeId: string, timeSeconds: number) => void;
  onSetTransition: (layerId: string, kind: TransitionKind, durationSeconds: number) => void;
  onRemoveTransition: (layerId: string, side: "fadeIn" | "fadeOut") => void;
  onAddCrossDissolve: (leftLayerId: string, rightLayerId: string, spec?: TransitionSpec) => void;
  onSetCrossDissolve: (leftLayerId: string, rightLayerId: string, durationSeconds: number) => void;
  onRemoveCrossDissolve: (leftLayerId: string, rightLayerId: string) => void;
  onChangeTrackHeight: (height: number) => void;
  canUndo?: boolean | undefined;
  canRedo?: boolean | undefined;
  onUndo?: (() => void) | undefined;
  onRedo?: (() => void) | undefined;
  toolMode?: TimelineToolMode | undefined;
  onChangeToolMode?: ((mode: TimelineToolMode) => void) | undefined;
  snapEnabled?: boolean | undefined;
  onToggleSnap?: (() => void) | undefined;
  onSplitLayerAt?: ((layerId: string, atSeconds: number) => void) | undefined;
  onSplitAtPlayhead?: (() => void) | undefined;
  onRippleDeleteLayer?: ((layerId: string) => void) | undefined;
  onDuplicateLayer?: ((layerId: string) => void) | undefined;
  markers?: number[] | undefined;
  onToggleMarkerAtPlayhead?: (() => void) | undefined;
  onRemoveMarker?: ((markerTime: number) => void) | undefined;
  inPointSeconds?: number | undefined;
  outPointSeconds?: number | undefined;
  onSetInPoint?: ((timeSeconds?: number) => void) | undefined;
  onSetOutPoint?: ((timeSeconds?: number) => void) | undefined;
  onClearInPoint?: (() => void) | undefined;
  onClearOutPoint?: (() => void) | undefined;
  onClearInOutPoints?: (() => void) | undefined;
  proxyCacheSegments?: PreviewCacheRulerSegment[] | undefined;
  proxyCacheStatus?: ProxyCacheStatus | undefined;
  onRegenerateProxyCache?: ((target: "all" | "inOut") => void) | undefined;
  livePlaybackMode?: boolean | undefined;
  onToggleLivePlayback?: ((next: boolean) => void) | undefined;
  onReplaceLayerAsset?: ((layerId: string) => void) | undefined;
  onSlipLayer?: ((layerId: string, sourceInSeconds: number) => void) | undefined;
  /** Transient/commit layer edit for the audio volume envelope (drag = transient, release = commit). */
  onPreviewVolume?: ((layerId: string, updater: (layer: TimelineLayer) => TimelineLayer, commit: boolean) => void) | undefined;
}) {
  const laneOffsetPx = trackHeight <= 30 ? 64 : 92;
  const interactionDurationSeconds = useMemo(() => {
    const maxPotentialEnd = Math.max(
      composition.durationSeconds,
      ...composition.tracks.flatMap((track) =>
        track.layers.map((layer) => layer.startSeconds + getLayerMaxDuration(layer, layerMaxDurations, composition.durationSeconds))
      )
    );
    return Math.max(composition.durationSeconds, maxPotentialEnd);
  }, [composition, layerMaxDurations]);
  const timelineDurationSeconds = composition.durationSeconds;
  const [pixelsPerSecond, setPixelsPerSecond] = useState(56);
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  const laneWidthPx = Math.max(560, Math.ceil(timelineDurationSeconds * pixelsPerSecond));
  const timelineWidthPx = laneOffsetPx + laneWidthPx;
  const rulerStepSeconds = getRulerStepSeconds(pixelsPerSecond);
  const rulerMarks = getRulerMarks(timelineDurationSeconds, rulerStepSeconds);
  const snapStepSeconds = clamp(composition.settings?.timeline.snapSeconds ?? 0.1, 0.01, 1);
  // Clips always land on exact frame boundaries (1/fps) so timeline edits are
  // frame-accurate. When zoomed in, a drag visibly moves frame by frame.
  const frameStepSeconds = 1 / clamp(Math.round(composition.fps) || 30, 1, 120);
  // Snap a time to clip edges / playhead / markers / 0 when snapping is on
  // (tolerance scales with zoom so it feels consistent), reporting which
  // target it hit so callers can draw a guide line. Off returns the raw value.
  function snapTimeWithTarget(value: number, excludeLayerId?: string | undefined): { value: number; snappedTo: number | null } {
    if (!snapEnabled) {
      return { value, snappedTo: null };
    }
    const targets = computeSnapTargets(composition, { excludeLayerId, playheadSeconds: currentTime, markers });
    const tolerance = 8 / pixelsPerSecond;
    return snapValue(value, targets, tolerance);
  }
  const editorRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const liveProxyBarRef = useRef<HTMLElement | null>(null);
  // Cached timeline geometry for the playback auto-follow, so the per-frame follow does NOT call
  // getBoundingClientRect (a forced synchronous layout). Refreshed on playback start + on resize/zoom
  // (ResizeObserver below), not every animation frame. `laneOffset` = lane origin in dock-content coords.
  const followGeomRef = useRef<{ laneOffset: number; laneWidth: number; clientWidth: number; maxScroll: number } | null>(null);
  const [drag, setDragState] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);
  const setDrag = useCallback((value: DragState | ((current: DragState) => DragState)) => {
    setDragState((current) => {
      const next = typeof value === "function" ? (value as (current: DragState) => DragState)(current) : value;
      dragRef.current = next;
      return next;
    });
  }, []);
  const [resize, setResizeState] = useState<ResizeState>(null);
  const resizeRef = useRef<ResizeState>(null);
  const setResize = useCallback((value: ResizeState | ((current: ResizeState) => ResizeState)) => {
    setResizeState((current) => {
      const next = typeof value === "function" ? (value as (current: ResizeState) => ResizeState)(current) : value;
      resizeRef.current = next;
      return next;
    });
  }, []);
  const [scrub, setScrub] = useState<{ pointerId: number; frame: HTMLDivElement } | null>(null);
  const panRef = useRef<{ pointerId: number; startClientX: number; startScrollLeft: number } | null>(null);
  const [marquee, setMarquee] = useState<{
    pointerId: number;
    frame: HTMLDivElement;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    append: boolean;
    toggle: boolean;
  } | null>(null);
  const [keyframeDrag, setKeyframeDragState] = useState<KeyframeDragState>(null);
  const keyframeDragRef = useRef<KeyframeDragState>(null);
  const setKeyframeDrag = useCallback((value: KeyframeDragState | ((current: KeyframeDragState) => KeyframeDragState)) => {
    setKeyframeDragState((current) => {
      const next = typeof value === "function" ? (value as (current: KeyframeDragState) => KeyframeDragState)(current) : value;
      keyframeDragRef.current = next;
      return next;
    });
  }, []);
  const [transitionDrag, setTransitionDragState] = useState<TransitionDragState>(null);
  const transitionDragRef = useRef<TransitionDragState>(null);
  const setTransitionDrag = useCallback((value: TransitionDragState | ((current: TransitionDragState) => TransitionDragState)) => {
    setTransitionDragState((current) => {
      const next = typeof value === "function" ? (value as (current: TransitionDragState) => TransitionDragState)(current) : value;
      transitionDragRef.current = next;
      return next;
    });
  }, []);
  const [crossDrag, setCrossDragState] = useState<CrossDragState>(null);
  const crossDragRef = useRef<CrossDragState>(null);
  const setCrossDrag = useCallback((value: CrossDragState | ((current: CrossDragState) => CrossDragState)) => {
    setCrossDragState((current) => {
      const next = typeof value === "function" ? (value as (current: CrossDragState) => CrossDragState)(current) : value;
      crossDragRef.current = next;
      return next;
    });
  }, []);
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null);
  const [effectDropTargetLayerId, setEffectDropTargetLayerId] = useState<string | null>(null);
  const [toolbarViewportWidth, setToolbarViewportWidth] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showProxyInfo, setShowProxyInfo] = useState(false);
  const [trackContextMenu, setTrackContextMenu] = useState<{ x: number; y: number; timeSeconds: number } | null>(null);
  const [clipContextMenu, setClipContextMenu] = useState<{ x: number; y: number; layerId: string; layerType: TimelineLayerType; linked: boolean; replaceable: boolean; slippable: boolean; crossPair: { leftLayerId: string; rightLayerId: string } | null; hasTransition: boolean } | null>(null);
  // The menu is measured after mount and clamped inside the viewport so it never spills off the
  // bottom/right edge (which was hiding its lower options). Hidden until positioned to avoid a jump.
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!clipContextMenu) {
      setContextMenuPos(null);
      return;
    }
    const el = contextMenuRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(clipContextMenu.x, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(clipContextMenu.y, window.innerHeight - rect.height - margin));
    setContextMenuPos({ left, top });
  }, [clipContextMenu]);
  // The clip currently in slip mode (double-click to enter). Horizontal drag over
  // it shifts the source in-point without moving the clip on the timeline.
  const [slipLayerId, setSlipLayerId] = useState<string | null>(null);
  const slipDragRef = useRef<{
    layerId: string;
    pointerId: number;
    startClientX: number;
    baseSourceInSeconds: number;
    maxSourceInSeconds: number;
    previewSourceInSeconds: number;
  } | null>(null);
  // Live source-offset preview shown on the slipping clip while dragging (commit
  // happens on pointer-up to avoid a composition write per frame).
  const [slipPreview, setSlipPreview] = useState<{ layerId: string; sourceInSeconds: number } | null>(null);
  const timebarRef = useRef<HTMLDivElement | null>(null);
  // The side "add tool" rail sits to the left of the whole timeline-editor column,
  // which also contains the timebar/toolbar + ruler above the tracks. Without this,
  // the rail's icons start flush with the top of the toolbar instead of the first
  // track row, looking detached from the timeline. Measured (not hardcoded) so it
  // stays correct if the toolbar ever wraps to a second line on a narrow viewport.
  const selectedLayerSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);
  const cancelDrag = useCallback(() => {
    setDrag(null);
    slipDragRef.current = null;
    setSlipPreview(null);
  }, [setDrag]);
  const cancelResize = useCallback(() => setResize(null), [setResize]);
  const cancelKeyframeDrag = useCallback(() => setKeyframeDrag(null), [setKeyframeDrag]);

  useWheelScrollPerformance(editorRef);

  useEffect(() => {
    pixelsPerSecondRef.current = pixelsPerSecond;
  }, [pixelsPerSecond]);

  useEffect(() => {
    const timelineEditor = editorRef.current;
    const timelineDock = timelineEditor?.closest(".editor-timeline-dock");
    if (!timelineEditor || !(timelineDock instanceof HTMLElement)) {
      return;
    }

    const updateToolbarWidth = () => setToolbarViewportWidth(Math.max(360, timelineDock.clientWidth - 66));
    const update = () => {
      updateToolbarWidth();
      measureFollowGeom();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(timelineDock);
    const lane = timelineEditor.querySelector(".timeline-lane");
    if (lane instanceof HTMLElement) observer.observe(lane); // lane width changes on zoom; re-measure
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measureFollowGeom reads live DOM via refs
  }, []);

  // Snapshot the dock/lane geometry the playback auto-follow needs, with ONE getBoundingClientRect pass
  // (vs two per animation frame). Called on resize/zoom (observer above) and at playback start.
  function measureFollowGeom() {
    const timelineEditor = editorRef.current;
    const timelineDock = timelineEditor?.closest(".editor-timeline-dock");
    const lane = timelineEditor?.querySelector(".timeline-lane");
    if (!timelineEditor || !(timelineDock instanceof HTMLElement) || !(lane instanceof HTMLElement)) {
      followGeomRef.current = null;
      return;
    }
    const dockRect = timelineDock.getBoundingClientRect();
    const laneRect = lane.getBoundingClientRect();
    followGeomRef.current = {
      laneOffset: laneRect.left - dockRect.left + timelineDock.scrollLeft,
      laneWidth: laneRect.width,
      clientWidth: timelineDock.clientWidth,
      maxScroll: Math.max(0, timelineDock.scrollWidth - timelineDock.clientWidth),
    };
  }

  useEffect(() => {
    const timelineEditor = editorRef.current;
    const timelineDock = timelineEditor?.closest(".editor-timeline-dock");
    if (!timelineEditor || !(timelineDock instanceof HTMLElement)) {
      return;
    }
    const editorElement: HTMLDivElement = timelineEditor;
    const dockElement: HTMLElement = timelineDock;

    function handleTimelineWheel(event: WheelEvent) {
      if (!event.shiftKey && !event.altKey) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (event.shiftKey && !event.altKey) {
        dockElement.scrollLeft += event.deltaY + event.deltaX;
        return;
      }

      const lane = editorElement.querySelector<HTMLElement>(".timeline-lane");
      if (!lane) {
        return;
      }

      const currentPixelsPerSecond = pixelsPerSecondRef.current;
      const delta = event.deltaY || event.deltaX;
      const zoomFactor = delta < 0 ? 1.12 : 1 / 1.12;
      const nextPixelsPerSecond = clamp(currentPixelsPerSecond * zoomFactor, 24, 480);
      if (Math.abs(nextPixelsPerSecond - currentPixelsPerSecond) < 0.01) {
        return;
      }

      const laneRect = lane.getBoundingClientRect();
      const pointerLaneX = clamp(event.clientX - laneRect.left, 0, laneRect.width);
      const pointerTime = (pointerLaneX / Math.max(1, laneRect.width)) * timelineDurationSeconds;
      const nextLaneWidthPx = Math.max(560, Math.ceil(timelineDurationSeconds * nextPixelsPerSecond));
      const nextPointerLaneX = (pointerTime / Math.max(0.001, timelineDurationSeconds)) * nextLaneWidthPx;

      pixelsPerSecondRef.current = nextPixelsPerSecond;
      setPixelsPerSecond(nextPixelsPerSecond);
      window.requestAnimationFrame(() => {
        dockElement.scrollLeft += nextPointerLaneX - pointerLaneX;
      });
    }

    editorElement.addEventListener("wheel", handleTimelineWheel, { passive: false });
    return () => editorElement.removeEventListener("wheel", handleTimelineWheel);
  }, [timelineDurationSeconds]);
  const layerPreview = useMemo<Record<string, { startSeconds?: number; durationSeconds?: number }>>(() => {
    if (drag) {
      return Object.fromEntries(
        drag.movedLayerIds.map((layerId) => [layerId, { startSeconds: drag.previewStartByLayerId[layerId] ?? 0 }])
      );
    }
    if (resize) {
      return {
        [resize.layerId]: {
          startSeconds: resize.previewStartSeconds,
          durationSeconds: resize.previewDurationSeconds
        }
      };
    }
    return {};
  }, [drag, resize]);
  const activeSnapSeconds = drag?.snappedTo ?? resize?.snappedTo ?? null;

  useEffect(() => {
    const playhead = playheadRef.current;
    if (!playhead || scrub || (isPlaying && playbackStart)) {
      return;
    }

    playhead.style.setProperty("--playhead-percent", playheadOffsetPercent(currentTime, timelineDurationSeconds));
    const liveProxyBar = liveProxyBarRef.current;
    if (liveProxyBar) {
      liveProxyBar.style.display = "none";
      liveProxyBar.style.setProperty("--proxy-start-percent", "0%");
      liveProxyBar.style.setProperty("--proxy-width-percent", "0%");
    }
  }, [currentTime, isPlaying, playbackStart, scrub, timelineDurationSeconds]);

  // Per-frame auto-follow scroll, using the CACHED geometry (no getBoundingClientRect, no forced
  // reflow). `scrollLeft` is read once by the caller before any writes (reads-before-writes), so this
  // never dirties layout mid-frame.
  //
  // CONTINUOUS PINNED FOLLOW (smooth, no stop-motion): the playhead drifts freely across the viewport
  // and only when it reaches PIN_FRAC (near the right edge) does the content start scrolling; from
  // there it stays pinned and the content scrolls in lockstep with the playhead, which moves smoothly
  // from the playback clock, so the scroll velocity == the playhead velocity (no catch-up bursts). The
  // previous version had a dead-zone (drift to 84%, ease back to 64%), which made the playhead oscillate
  // and the content lurch, creating the jumpy/stop-motion feel. Forward-only: while the playhead is left of the
  // pin, `desiredScroll <= scrollLeft`, so the view is left alone; at the timeline end the scroll clamps
  // to maxScroll and the playhead glides on to the right edge.
  const PIN_FRAC = 0.88;
  function followPlaybackPlayhead(timeSeconds: number, scrollLeft: number) {
    const timelineEditor = editorRef.current;
    const timelineDock = timelineEditor?.closest(".editor-timeline-dock");
    const geom = followGeomRef.current;
    if (!geom || !(timelineDock instanceof HTMLElement)) {
      return;
    }

    const frac = clamp(timeSeconds, 0, timelineDurationSeconds) / Math.max(0.001, timelineDurationSeconds);
    const playheadContentX = geom.laneOffset + frac * geom.laneWidth;
    const desiredScroll = clamp(playheadContentX - geom.clientWidth * PIN_FRAC, 0, geom.maxScroll);
    if (desiredScroll <= scrollLeft) {
      return; // playhead still left of the pin (or can't scroll further right), so don't move the view
    }
    timelineDock.scrollLeft = desiredScroll;
  }

  useEffect(() => {
    const playhead = playheadRef.current;
    if (!playhead || !isPlaying || !playbackStart || scrub) {
      return;
    }
    const timelineDock = editorRef.current?.closest(".editor-timeline-dock");
    const dock = timelineDock instanceof HTMLElement ? timelineDock : null;
    const liveProxyBar = liveProxyBarRef.current;

    measureFollowGeom(); // fresh snapshot for this playback run (zoom/resize during play re-measures via observer)
    const updateLiveProxyBar = (timeSeconds: number) => {
      if (!liveProxyBar) {
        return;
      }
      const start = clamp(playbackStart.timeSeconds, 0, timelineDurationSeconds);
      const end = clamp(timeSeconds, 0, timelineDurationSeconds);
      if (end <= start) {
        liveProxyBar.style.display = "none";
        return;
      }
      liveProxyBar.style.display = "block";
      liveProxyBar.style.setProperty("--proxy-start-percent", playheadOffsetPercent(start, timelineDurationSeconds));
      liveProxyBar.style.setProperty("--proxy-width-percent", `${((end - start) / Math.max(0.001, timelineDurationSeconds)) * 100}%`);
    };

    let frame = 0;
    const animate = (clockMs: number) => {
      // Reads BEFORE writes: read scrollLeft while layout is clean (last frame already painted), then
      // do all writes (scrollLeft via follow, then the playhead CSS var). No forced reflow per frame.
      const scrollLeft = dock?.scrollLeft ?? 0;
      const nextTime = clamp(playbackStart.timeSeconds + (clockMs - playbackStart.clockMs) / 1000, 0, composition.durationSeconds);
      if (dock) followPlaybackPlayhead(nextTime, scrollLeft);
      playhead.style.setProperty("--playhead-percent", playheadOffsetPercent(nextTime, timelineDurationSeconds));
      updateLiveProxyBar(nextTime);
      if (nextTime < composition.durationSeconds) {
        frame = window.requestAnimationFrame(animate);
      }
    };

    if (dock) followPlaybackPlayhead(playbackStart.timeSeconds, dock.scrollLeft);
    playhead.style.setProperty("--playhead-percent", playheadOffsetPercent(playbackStart.timeSeconds, timelineDurationSeconds));
    updateLiveProxyBar(playbackStart.timeSeconds);
    frame = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frame);
      if (liveProxyBar) {
        liveProxyBar.style.display = "none";
      }
    };
  }, [composition.durationSeconds, isPlaying, playbackStart, scrub, timelineDurationSeconds]);

  // Drag/resize handlers below are wrapped in useCallback and read live state
  // through refs (dragRef/resizeRef) rather than closing over the `drag`/`resize`
  // state directly. That keeps their identity stable across the many re-renders
  // a single drag gesture causes (composition/layerMaxDurations/etc. don't change
  // mid-gesture), which lets the memoized TimelineClip below skip re-rendering
  // every other clip on each pointer move instead of just the one being dragged.
  const startDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>, layer: TimelineLayer) => {
      const lane = event.currentTarget.parentElement;
      const track = composition.tracks.find((item) => item.id === layer.trackId);
      if (!(lane instanceof HTMLDivElement) || layer.locked || track?.locked) {
        return;
      }

      // Slip mode: drag shifts the source in-point, the clip stays put. Only for
      // time-based media (video/audio) with a backing asset.
      if (slipLayerId === layer.id && (layer.type === "video" || layer.type === "audio") && layer.assetId) {
        const maxDuration = getLayerMaxDuration(layer, layerMaxDurations, composition.durationSeconds);
        const maxSourceInSeconds = Math.max(0, maxDuration - layer.durationSeconds);
        event.currentTarget.setPointerCapture(event.pointerId);
        if (!selectedLayerSet.has(layer.id)) {
          onSelectLayer(layer.id, "replace");
        }
        slipDragRef.current = {
          layerId: layer.id,
          pointerId: event.pointerId,
          startClientX: event.clientX,
          baseSourceInSeconds: layer.sourceInSeconds ?? 0,
          maxSourceInSeconds,
          previewSourceInSeconds: layer.sourceInSeconds ?? 0
        };
        setSlipPreview({ layerId: layer.id, sourceInSeconds: layer.sourceInSeconds ?? 0 });
        return;
      }

      // Blade tool: clicking a clip splits it at the click point instead of dragging.
      if (toolMode === "blade") {
        const pointerSeconds = getLaneTime(event.clientX, lane, timelineDurationSeconds, interactionDurationSeconds, true);
        onSplitLayerAt?.(layer.id, pointerSeconds);
        return;
      }

      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        onSelectLayer(layer.id, resolveSelectMode(event));
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      if (!selectedLayerSet.has(layer.id)) {
        onSelectLayer(layer.id, "replace");
      }

      const layerById = new Map(composition.tracks.flatMap((timelineTrack) => timelineTrack.layers).map((item) => [item.id, item]));
      const selectedDragIds = selectedLayerSet.has(layer.id) && selectedLayerIds.length > 1 ? selectedLayerIds : [layer.id];
      const movableLayerIds = selectedDragIds.filter((layerId) => {
        const candidate = layerById.get(layerId);
        if (!candidate || candidate.locked) {
          return false;
        }

        const candidateTrack = composition.tracks.find((timelineTrack) => timelineTrack.id === candidate.trackId);
        return !candidateTrack?.locked;
      });
      if (!movableLayerIds.length) {
        return;
      }

      const baseStartByLayerId = Object.fromEntries(movableLayerIds.map((layerId) => [layerId, layerById.get(layerId)?.startSeconds ?? 0]));

      const pointerSeconds = getLaneTime(event.clientX, lane, timelineDurationSeconds, interactionDurationSeconds, true);
      setDrag({
        layerId: layer.id,
        lane,
        pointerId: event.pointerId,
        offsetSeconds: pointerSeconds - layer.startSeconds,
        movedLayerIds: movableLayerIds,
        baseStartByLayerId,
        previewStartByLayerId: baseStartByLayerId,
        previewStartSeconds: layer.startSeconds,
        previewTrackId: layer.trackId,
        snappedTo: null
      });
    },
    [composition, toolMode, slipLayerId, layerMaxDurations, selectedLayerSet, selectedLayerIds, onSelectLayer, onSplitLayerAt, timelineDurationSeconds, interactionDurationSeconds, setDrag]
  );

  const moveDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const slip = slipDragRef.current;
      if (slip && slip.pointerId === event.pointerId) {
        // Drag right reveals earlier source (negative offset), matching Premiere's slip.
        const deltaSeconds = -((event.clientX - slip.startClientX) / pixelsPerSecond);
        const nextSourceIn = clamp(snap(slip.baseSourceInSeconds + deltaSeconds, frameStepSeconds), 0, slip.maxSourceInSeconds);
        slip.previewSourceInSeconds = nextSourceIn;
        setSlipPreview({ layerId: slip.layerId, sourceInSeconds: nextSourceIn });
        return;
      }

      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      const layer = composition.tracks.flatMap((track) => track.layers).find((item) => item.id === drag.layerId);
      if (!layer) {
        return;
      }

      const pointerSeconds = getLaneTime(event.clientX, drag.lane, timelineDurationSeconds, interactionDurationSeconds, true);
      const maxDuration = getLayerMaxDuration(layer, layerMaxDurations, composition.durationSeconds);
      const maxStart = Math.max(0, interactionDurationSeconds - Math.min(layer.durationSeconds, maxDuration));
      const snapped = snapTimeWithTarget(pointerSeconds - drag.offsetSeconds, drag.layerId);
      // Snap to a clip edge/marker if one is in range, otherwise quantize to the
      // frame grid so the clip always lands on an exact frame.
      const nextStart = clamp(snapped.snappedTo !== null ? snapped.value : snap(snapped.value, frameStepSeconds), 0, maxStart);
      const deltaSeconds = nextStart - layer.startSeconds;
      const previewStartByLayerId = Object.fromEntries(
        drag.movedLayerIds.map((layerId) => {
          const candidate = composition.tracks.flatMap((track) => track.layers).find((item) => item.id === layerId);
          if (!candidate) {
            return [layerId, drag.baseStartByLayerId[layerId] ?? 0] as const;
          }
          const candidateMaxDuration = getLayerMaxDuration(candidate, layerMaxDurations, composition.durationSeconds);
          const candidateMaxStart = Math.max(0, interactionDurationSeconds - Math.min(candidate.durationSeconds, candidateMaxDuration));
          const baseStart = drag.baseStartByLayerId[layerId] ?? candidate.startSeconds;
          return [layerId, snap(clamp(baseStart + deltaSeconds, 0, candidateMaxStart), frameStepSeconds)] as const;
        })
      );
      setDrag({
        ...drag,
        previewStartSeconds: nextStart,
        previewStartByLayerId,
        previewTrackId: findTrackIdAtPoint(event.clientX, event.clientY) ?? drag.previewTrackId,
        snappedTo: snapped.snappedTo
      });
    },
    [composition, layerMaxDurations, timelineDurationSeconds, interactionDurationSeconds, frameStepSeconds, snapEnabled, currentTime, pixelsPerSecond, markers, setDrag]
  );

  const finishDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const slip = slipDragRef.current;
      if (slip && slip.pointerId === event.pointerId) {
        slipDragRef.current = null;
        setSlipPreview(null);
        if (slip.previewSourceInSeconds !== slip.baseSourceInSeconds) {
          onSlipLayer?.(slip.layerId, slip.previewSourceInSeconds);
        }
        return;
      }

      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      onMoveLayer(drag.layerId, drag.previewStartSeconds, drag.previewTrackId, drag.movedLayerIds.length > 1 ? drag.movedLayerIds : undefined);
      setDrag(null);
    },
    [onMoveLayer, onSlipLayer, setDrag]
  );

  // Nudge the selected clip exactly one frame left/right, frame-aligned and
  // clamped to 0. Mirrors the playhead's frame stepping for clip positioning.
  const nudgeSelectedLayerByFrame = useCallback(
    (direction: -1 | 1) => {
      if (!selectedLayerId) {
        return;
      }
      const layer = composition.tracks.flatMap((track) => track.layers).find((item) => item.id === selectedLayerId);
      if (!layer) {
        return;
      }
      const nextStart = Math.max(0, snap(layer.startSeconds + direction * frameStepSeconds, frameStepSeconds));
      if (nextStart !== layer.startSeconds) {
        onMoveLayer(layer.id, nextStart, layer.trackId);
      }
    },
    [composition, selectedLayerId, frameStepSeconds, onMoveLayer]
  );

  const startResize = useCallback(
    (event: PointerEvent<HTMLSpanElement>, layer: TimelineLayer, edge: "start" | "end") => {
      event.stopPropagation();
      const lane = event.currentTarget.closest(".timeline-lane");
      const track = composition.tracks.find((item) => item.id === layer.trackId);
      if (!(lane instanceof HTMLDivElement) || layer.locked || track?.locked) {
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      onSelectLayer(layer.id);
      setResize({
        edge,
        layerId: layer.id,
        lane,
        pointerId: event.pointerId,
        previewStartSeconds: layer.startSeconds,
        previewDurationSeconds: layer.durationSeconds,
        snappedTo: null
      });
    },
    [composition, onSelectLayer, setResize]
  );

  const moveResize = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }

      const layer = composition.tracks.flatMap((track) => track.layers).find((item) => item.id === resize.layerId);
      if (!layer) {
        return;
      }

      const rawSeconds = getLaneTime(event.clientX, resize.lane, timelineDurationSeconds, interactionDurationSeconds, true);
      const snapped = snapTimeWithTarget(rawSeconds, resize.layerId);
      const pointerSeconds = snapped.value;
      const maxDuration = getLayerMaxDuration(layer, layerMaxDurations, composition.durationSeconds);
      if (resize.edge === "start") {
        const maxStart = layer.startSeconds + layer.durationSeconds - frameStepSeconds;
        const minStart = Math.max(0, layer.startSeconds + layer.durationSeconds - maxDuration);
        const nextStart = clamp(pointerSeconds, minStart, maxStart);
        setResize({
          ...resize,
          previewStartSeconds: nextStart,
          previewDurationSeconds: layer.durationSeconds + (layer.startSeconds - nextStart),
          snappedTo: snapped.snappedTo
        });
        return;
      }

      setResize({
        ...resize,
        previewDurationSeconds: clamp(pointerSeconds - layer.startSeconds, frameStepSeconds, maxDuration),
        snappedTo: snapped.snappedTo
      });
    },
    [composition, layerMaxDurations, timelineDurationSeconds, interactionDurationSeconds, snapEnabled, currentTime, pixelsPerSecond, markers, setResize]
  );

  const finishResize = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }

      onResizeLayer(resize.layerId, resize.previewStartSeconds, resize.previewDurationSeconds);
      setResize(null);
    },
    [onResizeLayer, setResize]
  );

  function startScrub(event: PointerEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLElement && event.target.closest(".timeline-clip")) {
      return;
    }

    // Hand tool: drag anywhere to pan the timeline horizontally.
    if (toolMode === "hand" && event.button === 0) {
      event.currentTarget.setPointerCapture(event.pointerId);
      panRef.current = { pointerId: event.pointerId, startClientX: event.clientX, startScrollLeft: event.currentTarget.scrollLeft };
      return;
    }

    if (event.button === 0 && event.target instanceof HTMLElement && event.target.closest(".timeline-lane")) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setMarquee({
        pointerId: event.pointerId,
        frame: event.currentTarget,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        append: event.shiftKey,
        toggle: event.metaKey || event.ctrlKey
      });
      return;
    }

    // Ruler click / playhead drag: scrub the timeline and drop the clip selection.
    if (selectedLayerIds.length) {
      onClearSelection();
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrub({ pointerId: event.pointerId, frame: event.currentTarget });
    updateScrub(event, event.currentTarget);
  }

  function moveScrub(event: PointerEvent<HTMLDivElement>) {
    if (panRef.current && panRef.current.pointerId === event.pointerId) {
      event.currentTarget.scrollLeft = panRef.current.startScrollLeft - (event.clientX - panRef.current.startClientX);
      return;
    }

    if (marquee && marquee.pointerId === event.pointerId) {
      setMarquee({ ...marquee, currentX: event.clientX, currentY: event.clientY });
      return;
    }

    if (!scrub || scrub.pointerId !== event.pointerId) {
      return;
    }

    updateScrub(event, scrub.frame);
  }

  function finishScrub(event: PointerEvent<HTMLDivElement>) {
    if (panRef.current && panRef.current.pointerId === event.pointerId) {
      panRef.current = null;
      return;
    }

    if (marquee && marquee.pointerId === event.pointerId) {
      finishMarquee(event, { ...marquee, currentX: event.clientX, currentY: event.clientY });
      return;
    }

    if (!scrub || scrub.pointerId !== event.pointerId) {
      return;
    }

    updateScrub(event, scrub.frame);
    setScrub(null);
  }

  function finishMarquee(
    event: PointerEvent<HTMLDivElement>,
    selection: {
      pointerId: number;
      frame: HTMLDivElement;
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
      append: boolean;
      toggle: boolean;
    }
  ) {
    const moved = Math.hypot(selection.currentX - selection.startX, selection.currentY - selection.startY);
    if (moved < 5) {
      updateScrub(event, selection.frame);
      if (!selection.append && !selection.toggle) {
        onClearSelection();
      }
      setMarquee(null);
      return;
    }

    const box = getClientSelectionBox(selection);
    const selectedIds: string[] = [];
    selection.frame.querySelectorAll<HTMLElement>(".timeline-clip[data-layer-id]").forEach((clip) => {
      const rect = clip.getBoundingClientRect();
      const intersects = rect.left <= box.right && rect.right >= box.left && rect.top <= box.bottom && rect.bottom >= box.top;
      if (intersects && clip.dataset.layerId) {
        selectedIds.push(clip.dataset.layerId);
      }
    });

    if (selectedIds.length) {
      onSelectLayers(selectedIds, selection.toggle ? "toggle" : selection.append ? "add" : "replace");
    } else {
      if (!selection.append && !selection.toggle) {
        onClearSelection();
      }
    }
    setMarquee(null);
  }

  function updateScrub(event: PointerEvent, frame: HTMLDivElement) {
    const lane = frame.querySelector<HTMLDivElement>(".timeline-lane");
    if (!lane) {
      return;
    }

    const rect = lane.getBoundingClientRect();
    const nextTime = snap(clamp(((event.clientX - rect.left) / rect.width) * timelineDurationSeconds, 0, timelineDurationSeconds), snapStepSeconds);
    onChangeCurrentTime(nextTime);
  }

  const startKeyframeDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>, layer: TimelineLayer, keyframe: TimelineKeyframeV2) => {
      event.preventDefault();
      event.stopPropagation();
      const clip = event.currentTarget.closest(".timeline-clip");
      if (!(clip instanceof HTMLDivElement) || layer.locked) {
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      setSelectedKeyframeId(keyframe.id);
      onSelectLayer(layer.id);
      onChangeCurrentTime(layer.startSeconds + keyframe.timeSeconds);
      setKeyframeDrag({
        clip,
        keyframeId: keyframe.id,
        layerId: layer.id,
        pointerId: event.pointerId,
        previewTimeSeconds: keyframe.timeSeconds
      });
    },
    [onSelectLayer, onChangeCurrentTime, setKeyframeDrag]
  );

  const moveKeyframeDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const keyframeDrag = keyframeDragRef.current;
      if (!keyframeDrag || keyframeDrag.pointerId !== event.pointerId) {
        return;
      }

      const layer = composition.tracks.flatMap((track) => track.layers).find((item) => item.id === keyframeDrag.layerId);
      if (!layer) {
        return;
      }

      const nextTime = getClipLocalTime(event.clientX, keyframeDrag.clip, layer.durationSeconds);
      setKeyframeDrag({ ...keyframeDrag, previewTimeSeconds: nextTime });
      onChangeCurrentTime(layer.startSeconds + nextTime);
    },
    [composition, snapStepSeconds, onChangeCurrentTime, setKeyframeDrag]
  );

  const finishKeyframeDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const keyframeDrag = keyframeDragRef.current;
      if (!keyframeDrag || keyframeDrag.pointerId !== event.pointerId) {
        return;
      }

      onMoveKeyframe(keyframeDrag.layerId, keyframeDrag.keyframeId, keyframeDrag.previewTimeSeconds);
      setKeyframeDrag(null);
    },
    [onMoveKeyframe, setKeyframeDrag]
  );

  // Fade-band drag — mirrors the keyframe drag (clip-local time), commits on release so the
  // graph isn't mutated on every pointer move. The band shows a live width via `transitionDrag`.
  const startTransitionDrag = useCallback(
    (event: PointerEvent<HTMLSpanElement>, layer: TimelineLayer, side: "fadeIn" | "fadeOut") => {
      event.preventDefault();
      event.stopPropagation();
      const clip = event.currentTarget.closest(".timeline-clip");
      if (!(clip instanceof HTMLDivElement) || layer.locked) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      onSelectLayer(layer.id);
      const fades = getClipFades(layer);
      setTransitionDrag({
        clip,
        layerId: layer.id,
        side,
        pointerId: event.pointerId,
        previewDurationSeconds: side === "fadeIn" ? fades.fadeIn : fades.fadeOut
      });
    },
    [onSelectLayer, setTransitionDrag]
  );

  const moveTransitionDrag = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      const drag = transitionDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const layer = composition.tracks.flatMap((track) => track.layers).find((item) => item.id === drag.layerId);
      if (!layer) {
        return;
      }
      const localTime = getClipLocalTime(event.clientX, drag.clip, layer.durationSeconds);
      const raw = drag.side === "fadeIn" ? localTime : layer.durationSeconds - localTime;
      const next = clamp(raw, frameStepSeconds, layer.durationSeconds / 2);
      setTransitionDrag({ ...drag, previewDurationSeconds: next });
    },
    [composition, frameStepSeconds, setTransitionDrag]
  );

  const finishTransitionDrag = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      const drag = transitionDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      onSetTransition(drag.layerId, drag.side, drag.previewDurationSeconds);
      setTransitionDrag(null);
    },
    [onSetTransition, setTransitionDrag]
  );

  const cancelTransitionDrag = useCallback(() => setTransitionDrag(null), [setTransitionDrag]);

  // Cross-dissolve junction drag — the left clip's end stays anchored; the overlap duration `D`
  // shrinks as the pointer moves right (the left edge of the element follows). Commits on release.
  const startCrossDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>, junction: TimelineJunction) => {
      event.preventDefault();
      event.stopPropagation();
      const lane = event.currentTarget.closest(".timeline-lane");
      if (!(lane instanceof HTMLDivElement)) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      setCrossDrag({
        leftLayerId: junction.leftLayerId,
        rightLayerId: junction.rightLayerId,
        lane,
        pointerId: event.pointerId,
        baseDurationSeconds: junction.durationSeconds,
        downLaneSeconds: getLaneTime(event.clientX, lane, timelineDurationSeconds, interactionDurationSeconds, true),
        previewDurationSeconds: junction.durationSeconds
      });
    },
    [setCrossDrag, timelineDurationSeconds, interactionDurationSeconds]
  );

  const moveCrossDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const drag = crossDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const layers = composition.tracks.flatMap((track) => track.layers);
      const left = layers.find((item) => item.id === drag.leftLayerId);
      const right = layers.find((item) => item.id === drag.rightLayerId);
      if (!left || !right) {
        return;
      }
      const laneSeconds = getLaneTime(event.clientX, drag.lane, timelineDurationSeconds, interactionDurationSeconds, true);
      const delta = laneSeconds - drag.downLaneSeconds;
      const maxDuration = Math.min(left.durationSeconds, right.durationSeconds);
      const next = clamp(snap(drag.baseDurationSeconds - delta, frameStepSeconds), frameStepSeconds, maxDuration);
      setCrossDrag({ ...drag, previewDurationSeconds: next });
    },
    [composition, timelineDurationSeconds, interactionDurationSeconds, frameStepSeconds, setCrossDrag]
  );

  const finishCrossDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const drag = crossDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      if (drag.previewDurationSeconds !== drag.baseDurationSeconds) {
        onSetCrossDissolve(drag.leftLayerId, drag.rightLayerId, drag.previewDurationSeconds);
      }
      setCrossDrag(null);
    },
    [onSetCrossDissolve, setCrossDrag]
  );

  const cancelCrossDrag = useCallback(() => setCrossDrag(null), [setCrossDrag]);

  const fitZoom = useCallback(() => {
    const viewport = editorRef.current?.clientWidth ?? 0;
    const usable = Math.max(120, viewport - laneOffsetPx - 24);
    const content = Math.max(1, interactionDurationSeconds);
    const next = clamp(usable / content, 24, 480);
    pixelsPerSecondRef.current = next;
    setPixelsPerSecond(next);
  }, [laneOffsetPx, interactionDurationSeconds]);

  // Full keyboard shortcut map (Phase 4): tool modes, edit ops, snap/fit, markers,
  // and the "?" cheat sheet. Ignored while typing in a form field so shortcuts
  // don't hijack normal text entry elsewhere in the editor.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) {
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (key === "?") {
        event.preventDefault();
        setShowShortcuts((value) => !value);
        return;
      }
      if (key === "escape" && showShortcuts) {
        event.preventDefault();
        setShowShortcuts(false);
        return;
      }
      if (modifier && key === "d") {
        if (selectedLayerId) {
          event.preventDefault();
          onDuplicateLayer?.(selectedLayerId);
        }
        return;
      }
      if (modifier) {
        // Leave every other modifier combo (undo/redo, save, etc.) to other handlers.
        return;
      }
      if (event.shiftKey && (event.key === "Backspace" || event.key === "Delete")) {
        if (selectedLayerId) {
          event.preventDefault();
          onRippleDeleteLayer?.(selectedLayerId);
        }
        return;
      }
      switch (key) {
        case "v":
          event.preventDefault();
          onChangeToolMode?.("select");
          return;
        case "c":
          event.preventDefault();
          onChangeToolMode?.("blade");
          return;
        case "h":
          event.preventDefault();
          onChangeToolMode?.("hand");
          return;
        case "s":
          event.preventDefault();
          onSplitAtPlayhead?.();
          return;
        case "n":
          event.preventDefault();
          onToggleSnap?.();
          return;
        case "m":
          event.preventDefault();
          onToggleMarkerAtPlayhead?.();
          return;
        case "i":
          event.preventDefault();
          if (inPointSeconds != null) {
            onClearInPoint?.();
          } else {
            onSetInPoint?.();
          }
          return;
        case "o":
          event.preventDefault();
          if (outPointSeconds != null) {
            onClearOutPoint?.();
          } else {
            onSetOutPoint?.();
          }
          return;
        case "\\":
          event.preventDefault();
          fitZoom();
          return;
        default:
          return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedLayerId,
    onDuplicateLayer,
    onRippleDeleteLayer,
    onChangeToolMode,
    onSplitAtPlayhead,
    onToggleSnap,
    onToggleMarkerAtPlayhead,
    fitZoom,
    showShortcuts,
    inPointSeconds,
    outPointSeconds,
    onSetInPoint,
    onSetOutPoint,
    onClearInPoint,
    onClearOutPoint
  ]);

  function getClipLocalTime(clientX: number, clip: HTMLDivElement, durationSeconds: number) {
    const rect = clip.getBoundingClientRect();
    return snap(clamp(((clientX - rect.left) / Math.max(1, rect.width)) * durationSeconds, 0, durationSeconds), snapStepSeconds);
  }

  function findTrackIdAtPoint(x: number, y: number) {
    const element = document.elementFromPoint(x, y);
    const lane = element?.closest?.(".timeline-lane");
    return lane instanceof HTMLElement ? lane.dataset.trackId : undefined;
  }

  function getDropTime(event: DragEvent<HTMLDivElement>) {
    return snap(getLaneTime(event.clientX, event.currentTarget, timelineDurationSeconds, interactionDurationSeconds, true), snapStepSeconds);
  }

  // Right-click on the empty track/lane area (never on a clip - TimelineClip
  // stops propagation on its own onContextMenu) opens a menu for transport/range
  // actions scoped to the clicked time, mirroring Premiere's track-area context menu.
  function handleTracksContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLElement && (event.target.closest(".timeline-clip") || event.target.closest(".track-controls"))) {
      return;
    }
    const lane = event.currentTarget.querySelector<HTMLDivElement>(".timeline-lane");
    if (!lane) {
      return;
    }
    event.preventDefault();
    const rect = lane.getBoundingClientRect();
    const timeSeconds = snap(clamp(((event.clientX - rect.left) / rect.width) * timelineDurationSeconds, 0, timelineDurationSeconds), snapStepSeconds);
    setTrackContextMenu({ x: event.clientX, y: event.clientY, timeSeconds });
  }

  // Right-clicking a clip opens its own menu (Replace asset / Slip / etc.); the
  // clip stops propagation so the tracks-area menu never also fires.
  const handleClipContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, layer: TimelineLayer) => {
      event.preventDefault();
      const replaceable = layer.type === "video" || layer.type === "image" || layer.type === "audio";
      const slippable = (layer.type === "video" || layer.type === "audio") && Boolean(layer.assetId);
      const track = composition.tracks.find((item) => item.id === layer.trackId);
      const junction = track ? findClipTransitionContext(track, layer) : null;
      setTrackContextMenu(null);
      setClipContextMenu({
        x: event.clientX,
        y: event.clientY,
        layerId: layer.id,
        layerType: layer.type,
        linked: Boolean(layer.linkedGroupId),
        replaceable,
        slippable,
        crossPair: junction ? { leftLayerId: junction.leftLayerId, rightLayerId: junction.rightLayerId } : null,
        hasTransition: junction?.hasTransition ?? false
      });
    },
    [composition]
  );

  const enterSlipMode = useCallback(
    (layerId: string) => {
      setSlipLayerId(layerId);
      onSelectLayer(layerId, "replace");
    },
    [onSelectLayer]
  );

  // Leave slip mode on Escape so it's never a sticky surprise.
  useEffect(() => {
    if (!slipLayerId) {
      return;
    }
    function handleSlipEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSlipLayerId(null);
      }
    }
    window.addEventListener("keydown", handleSlipEscape);
    return () => window.removeEventListener("keydown", handleSlipEscape);
  }, [slipLayerId]);

  return (
    <div className="timeline-workspace">
      <div className="timeline-side-tools" aria-label="Timeline add tools">
        <button type="button" title="Add text" onClick={() => onAddLayer("text")}>
          <Type size={15} />
        </button>
        <button type="button" title="Add image" onClick={() => onAddLayer("image")}>
          <Image size={15} />
        </button>
        <button type="button" title="Add graphic" onClick={() => onAddLayer("shape")}>
          <Shapes size={15} />
        </button>
        <span />
        <button type="button" title="Add adjustment clip" onClick={() => onAddLayer("adjustment")}>
          <SlidersHorizontal size={15} />
        </button>
        <span />
        <button type="button" title="Add visual layer" onClick={() => onAddTrack("video")}>
          V+
        </button>
        <button type="button" title="Add audio layer" onClick={() => onAddTrack("audio")}>
          A+
        </button>
      </div>

      <div
        className={`timeline-editor scroll-performance-pane ${trackHeight <= 30 ? "is-xs-rows" : ""}`}
        aria-label="Timeline. Shift plus mouse wheel pans horizontally. Alt plus mouse wheel zooms horizontally."
        ref={editorRef}
        style={
          {
            "--timeline-track-count": composition.tracks.length,
            "--timeline-track-height": `${trackHeight}px`
          } as CSSProperties & Record<"--timeline-track-count", number> & Record<"--timeline-track-height", string>
        }
        onPointerDown={startScrub}
        onPointerMove={moveScrub}
        onPointerUp={finishScrub}
        onPointerCancel={() => {
          setScrub(null);
          setMarquee(null);
        }}
      >
        <div className="timeline-timebar" ref={timebarRef} style={toolbarViewportWidth ? { width: `${toolbarViewportWidth}px` } : undefined}>
          <span>{currentTime.toFixed(2)}s</span>
          <div className="timeline-toolbar" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="timeline-tool-group" role="group" aria-label="Preview proxies">
              <button
                type="button"
                className={livePlaybackMode ? "is-active" : ""}
                aria-pressed={livePlaybackMode}
                title={
                  livePlaybackMode
                    ? "Live playback ON — playing the live compositor, not preview proxies (no proxies are generated). Click to use proxies again."
                    : "Play live instead of preview proxies (stops proxy generation)"
                }
                onClick={() => onToggleLivePlayback?.(!livePlaybackMode)}
              >
                <Zap size={13} />
              </button>
              <button
                type="button"
                title="Regenerate all preview proxies"
                disabled={livePlaybackMode}
                onClick={() => onRegenerateProxyCache?.("all")}
              >
                <RefreshCw size={13} />
              </button>
              <button
                type="button"
                className="timeline-proxy-range-button"
                disabled={livePlaybackMode || inPointSeconds == null || outPointSeconds == null || inPointSeconds >= outPointSeconds}
                title={
                  livePlaybackMode
                    ? "Disabled while live playback is on"
                    : inPointSeconds != null && outPointSeconds != null && inPointSeconds < outPointSeconds
                      ? "Regenerate preview proxies for the In/Out range"
                      : "Set both In and Out points to regenerate only that range"
                }
                onClick={() => onRegenerateProxyCache?.("inOut")}
              >
                I/O
              </button>
              <button type="button" className={showProxyInfo ? "is-active" : ""} title="How preview proxies work" onClick={() => setShowProxyInfo(true)}>
                <Info size={13} />
              </button>
              {proxyCacheStatus && proxyCacheStatus.total > 0 ? (
                <span
                  className={`timeline-proxy-status${proxyCacheStatus.generating ? " is-generating" : ""}`}
                  title={
                    `Preview proxies: ${proxyCacheStatus.readyWithUrl}/${proxyCacheStatus.total} ready with media` +
                    (proxyCacheStatus.ready !== proxyCacheStatus.readyWithUrl ? ` | ${proxyCacheStatus.ready} marked ready` : "") +
                    (proxyCacheStatus.live > 0 ? ` | ${proxyCacheStatus.live} live-rendered` : "") +
                    (proxyCacheStatus.pending > 0 ? ` | ${proxyCacheStatus.pending} rendering` : "") +
                    (proxyCacheStatus.dirty > 0 ? ` | ${proxyCacheStatus.dirty} stale` : "") +
                    (proxyCacheStatus.failed > 0 ? ` | ${proxyCacheStatus.failed} failed` : "") +
                    ` | ${formatProxyBytes(proxyCacheStatus.byteSize)}`
                  }
                >
                  <span
                    className="timeline-proxy-status-bar"
                    style={{ "--proxy-ready-percent": `${Math.round(proxyCacheStatus.readyRatio * 100)}%` } as CSSProperties & Record<"--proxy-ready-percent", string>}
                  />
                  <span className="timeline-proxy-status-label">
                    {proxyCacheStatus.readyWithUrl}/{proxyCacheStatus.total}
                  </span>
                </span>
              ) : null}
            </div>

            <span className="timeline-toolbar-divider" />

            <div className="timeline-tool-group" role="group" aria-label="Tools">
              <button type="button" className={toolMode === "select" ? "is-active" : ""} title="Select tool (V)" onClick={() => onChangeToolMode?.("select")}>
                <MousePointer2 size={13} />
              </button>
              <button type="button" className={toolMode === "blade" ? "is-active" : ""} title="Blade — click a clip to split (C)" onClick={() => onChangeToolMode?.("blade")}>
                <Scissors size={13} />
              </button>
              <button type="button" className={toolMode === "hand" ? "is-active" : ""} title="Hand — drag to pan (H)" onClick={() => onChangeToolMode?.("hand")}>
                <Hand size={13} />
              </button>
            </div>

            <span className="timeline-toolbar-divider" />

            <div className="timeline-tool-group" role="group" aria-label="Edit">
              <button type="button" title="Nudge clip one frame left" disabled={!selectedLayerId} onClick={() => nudgeSelectedLayerByFrame(-1)}>
                <ChevronLeft size={13} />
              </button>
              <button type="button" title="Nudge clip one frame right" disabled={!selectedLayerId} onClick={() => nudgeSelectedLayerByFrame(1)}>
                <ChevronRight size={13} />
              </button>
              <button type="button" title="Split at playhead (S)" onClick={() => onSplitAtPlayhead?.()}>
                <SplitSquareHorizontal size={13} />
              </button>
              <button type="button" title="Duplicate clip (⌘D)" disabled={!selectedLayerId} onClick={() => selectedLayerId && onDuplicateLayer?.(selectedLayerId)}>
                <Copy size={13} />
              </button>
              <button type="button" title="Ripple delete — remove and close gap (⇧⌫)" disabled={!selectedLayerId} onClick={() => selectedLayerId && onRippleDeleteLayer?.(selectedLayerId)}>
                <Trash2 size={13} />
              </button>
              <button type="button" title="Link selected clips" onClick={onLinkSelectedLayers}>
                <Link2 size={13} />
              </button>
              <button type="button" title="Unlink selected clips" onClick={onUnlinkSelectedLayers}>
                <Unlink2 size={13} />
              </button>
            </div>

            {selectedLayerIds.length > 1 ? (
              <div className="timeline-bulk-bar" role="group" aria-label="Multi-selection actions">
                <span className="timeline-bulk-count">{selectedLayerIds.length} selected</span>
                <button type="button" title="Link selected clips" onClick={onLinkSelectedLayers}>
                  <Link2 size={13} />
                </button>
                <button
                  type="button"
                  className="timeline-bulk-delete"
                  title="Delete selected clips (⌫)"
                  onClick={() => onDeleteSelectedLayers?.()}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ) : null}

            <span className="timeline-toolbar-divider" />

            <div className="timeline-tool-group" role="group" aria-label="In/out points">
              <button
                type="button"
                className={`timeline-io-button ${inPointSeconds != null ? "is-active" : ""}`}
                title={inPointSeconds != null ? `Clear in point (I) — set at ${inPointSeconds.toFixed(2)}s` : "Set in point at playhead (I)"}
                onClick={() => (inPointSeconds != null ? onClearInPoint?.() : onSetInPoint?.())}
              >
                {inPointSeconds != null ? "Clear In" : "Set In"}
              </button>
              <button
                type="button"
                className={`timeline-io-button ${outPointSeconds != null ? "is-active" : ""}`}
                title={outPointSeconds != null ? `Clear out point (O) — set at ${outPointSeconds.toFixed(2)}s` : "Set out point at playhead (O)"}
                onClick={() => (outPointSeconds != null ? onClearOutPoint?.() : onSetOutPoint?.())}
              >
                {outPointSeconds != null ? "Clear Out" : "Set Out"}
              </button>
              {inPointSeconds != null || outPointSeconds != null ? (
                <button type="button" title="Clear in & out points" onClick={() => onClearInOutPoints?.()}>
                  <X size={13} />
                </button>
              ) : null}
            </div>

            <span className="timeline-toolbar-divider" />

            <div className="timeline-tool-group" role="group" aria-label="History">
              <button type="button" title="Undo (⌘Z)" disabled={!canUndo} onClick={onUndo}>
                <Undo2 size={13} />
              </button>
              <button type="button" title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={onRedo}>
                <Redo2 size={13} />
              </button>
            </div>

            <span className="timeline-toolbar-spacer" />

            <div className="timeline-tool-group" role="group" aria-label="View">
              <button type="button" className={snapEnabled ? "is-active" : ""} title="Snapping (N)" onClick={() => onToggleSnap?.()}>
                <Magnet size={13} />
              </button>
              <span className="timeline-toolbar-divider" />
              <span className="timeline-toolbar-label">Rows</span>
              <button type="button" className={trackHeight <= 30 ? "is-active" : ""} title="Compact tracks" onClick={() => onChangeTrackHeight(28)}>
                S
              </button>
              <button type="button" className={trackHeight > 30 && trackHeight <= 56 ? "is-active" : ""} title="Normal tracks" onClick={() => onChangeTrackHeight(44)}>
                M
              </button>
              <button type="button" className={trackHeight > 56 ? "is-active" : ""} title="Tall tracks" onClick={() => onChangeTrackHeight(68)}>
                L
              </button>
              <span className="timeline-toolbar-divider" />
              <button type="button" title="Fit timeline to view (\\)" onClick={fitZoom}>
                Fit
              </button>
              <button
                className="timeline-zoom-readout"
                type="button"
                title="Reset zoom to 100%. Alt + wheel zooms."
                onClick={() => {
                  pixelsPerSecondRef.current = 56;
                  setPixelsPerSecond(56);
                }}
              >
                {Math.round((pixelsPerSecond / 56) * 100)}%
              </button>
              <span className="timeline-toolbar-divider" />
              <button type="button" className={showShortcuts ? "is-active" : ""} title="Keyboard shortcuts (?)" onClick={() => setShowShortcuts((value) => !value)}>
                <Keyboard size={13} />
              </button>
            </div>
          </div>
        </div>
        <div
          className="timeline-ruler"
          style={{ minWidth: `${laneWidthPx}px` }}
          onDoubleClick={(event) => {
            if (event.target instanceof HTMLElement && event.target.closest(".timeline-ruler-marker")) {
              return;
            }
            onToggleMarkerAtPlayhead?.();
          }}
        >
          {proxyCacheSegments.length > 0 || isPlaying ? (
            <div className="timeline-proxy-cache-bar" aria-hidden="true">
              {proxyCacheSegments.map((segment) => (
                <i
                  className={`timeline-proxy-cache-segment is-${segment.status}`}
                  key={segment.id}
                  style={
                    {
                      "--proxy-start-percent": `${segment.startPercent}%`,
                      "--proxy-width-percent": `${segment.endPercent - segment.startPercent}%`
                    } as CSSProperties & Record<"--proxy-start-percent" | "--proxy-width-percent", string>
                  }
                  title={`Preview proxy ${segment.status} (${segment.reason})`}
                />
              ))}
              <i className="timeline-proxy-cache-live-range" ref={liveProxyBarRef} />
            </div>
          ) : null}
          {rulerMarks.map((mark) => (
            <span
              key={mark}
              style={{ "--ruler-mark-percent": playheadOffsetPercent(mark, composition.durationSeconds) } as CSSProperties & Record<"--ruler-mark-percent", string>}
            >
              {formatRulerTime(mark)}
            </span>
          ))}
          {markers.map((markerTime) => (
            <button
              className="timeline-ruler-marker"
              key={markerTime}
              title={`Marker at ${markerTime.toFixed(2)}s — click to seek, double-click to remove`}
              type="button"
              style={{ "--ruler-mark-percent": playheadOffsetPercent(markerTime, composition.durationSeconds) } as CSSProperties & Record<"--ruler-mark-percent", string>}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onChangeCurrentTime(markerTime);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onRemoveMarker?.(markerTime);
              }}
            >
              <Flag size={10} />
            </button>
          ))}
          {inPointSeconds != null || outPointSeconds != null ? (
            <div
              className="timeline-workarea-bar"
              style={
                {
                  "--workarea-start-percent": playheadOffsetPercent(inPointSeconds ?? 0, composition.durationSeconds),
                  "--workarea-end-percent": playheadOffsetPercent(outPointSeconds ?? composition.durationSeconds, composition.durationSeconds)
                } as CSSProperties & Record<"--workarea-start-percent" | "--workarea-end-percent", string>
              }
            />
          ) : null}
          {inPointSeconds != null ? (
            <button
              className="timeline-io-marker timeline-io-marker-in"
              title={`In point at ${inPointSeconds.toFixed(2)}s — click to seek, double-click to clear`}
              type="button"
              style={{ "--ruler-mark-percent": playheadOffsetPercent(inPointSeconds, composition.durationSeconds) } as CSSProperties & Record<"--ruler-mark-percent", string>}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onChangeCurrentTime(inPointSeconds);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onClearInPoint?.();
              }}
            />
          ) : null}
          {outPointSeconds != null ? (
            <button
              className="timeline-io-marker timeline-io-marker-out"
              title={`Out point at ${outPointSeconds.toFixed(2)}s — click to seek, double-click to clear`}
              type="button"
              style={{ "--ruler-mark-percent": playheadOffsetPercent(outPointSeconds, composition.durationSeconds) } as CSSProperties & Record<"--ruler-mark-percent", string>}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onChangeCurrentTime(outPointSeconds);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onClearOutPoint?.();
              }}
            />
          ) : null}
        </div>
        <div
          className="timeline-tracks"
          style={{ minWidth: `${timelineWidthPx}px` }}
          onContextMenu={(event) => handleTracksContextMenu(event)}
        >
          {inPointSeconds != null || outPointSeconds != null ? (
            <div className="timeline-workarea-overlay" aria-hidden="true">
              <div
                className="timeline-workarea-dim timeline-workarea-dim-before"
                style={{ "--dim-end-percent": playheadOffsetPercent(inPointSeconds ?? 0, timelineDurationSeconds) } as CSSProperties & Record<"--dim-end-percent", string>}
              />
              <div
                className="timeline-workarea-dim timeline-workarea-dim-after"
                style={{ "--dim-start-percent": playheadOffsetPercent(outPointSeconds ?? timelineDurationSeconds, timelineDurationSeconds) } as CSSProperties & Record<"--dim-start-percent", string>}
              />
            </div>
          ) : null}
          {activeSnapSeconds !== null ? (
            <div
              className="timeline-snap-guide"
              style={{ "--playhead-percent": playheadOffsetPercent(activeSnapSeconds, timelineDurationSeconds) } as CSSProperties & Record<"--playhead-percent", string>}
            />
          ) : null}
          <div
            className={`timeline-playhead ${scrub ? "is-scrubbing" : ""}`}
            ref={playheadRef}
            style={{ "--playhead-percent": playheadOffsetPercent(currentTime, timelineDurationSeconds) } as CSSProperties & Record<"--playhead-percent", string>}
          >
            <span />
          </div>
          {marquee ? createPortal(<div className="timeline-marquee" style={getMarqueeStyle(marquee)} />, document.body) : null}
          {composition.tracks.map((track) => {
            const junctions = getTrackJunctions(track);
            const junctionLeftIds = new Set(junctions.map((item) => item.leftLayerId));
            const junctionRightIds = new Set(junctions.map((item) => item.rightLayerId));
            return (
            <div className="timeline-track" key={track.id}>
              <div className="timeline-track-label">
                <div>
                  <strong>{track.name}</strong>
                  <span>{track.type === "audio" ? "audio" : "visual"}</span>
                </div>
                <div className="track-controls" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className={track.locked ? "is-active" : ""}
                    title={track.locked ? "Unlock track" : "Lock track"}
                    onClick={() => onToggleTrack(track.id, { locked: !track.locked })}
                  >
                    {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
                  </button>
                  <button
                    type="button"
                    className={track.muted ? "is-active" : ""}
                    title={track.muted ? (track.type === "audio" ? "Unmute track" : "Show track") : track.type === "audio" ? "Mute track" : "Hide track"}
                    onClick={() => onToggleTrack(track.id, { muted: !track.muted })}
                  >
                    {track.type === "audio" ? track.muted ? <VolumeX size={13} /> : <Volume2 size={13} /> : track.muted ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    type="button"
                    className={`track-solo-btn ${track.solo ? "is-active" : ""}`}
                    title={track.solo ? "Unsolo track" : "Solo track"}
                    onClick={() => onToggleTrack(track.id, { solo: !track.solo })}
                  >
                    <span aria-hidden="true">S</span>
                  </button>
                  <button type="button" title="Delete track" onClick={() => onDeleteTrack(track.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div
                className={`timeline-lane ${track.locked ? "is-locked" : ""} ${track.muted ? "is-muted" : ""}`}
                data-track-id={track.id}
                style={{ "--timeline-ruler-step-percent": `${(rulerStepSeconds / Math.max(0.001, timelineDurationSeconds)) * 100}%` } as CSSProperties & Record<"--timeline-ruler-step-percent", string>}
                onDragOver={(event) => {
                  if (!track.locked && event.dataTransfer.types.includes("application/x-lumio-asset")) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }
                }}
                onDrop={(event) => {
                  const assetId = event.dataTransfer.getData("application/x-lumio-asset");
                  if (!assetId || track.locked) {
                    return;
                  }
                  event.preventDefault();
                  onDropAsset(assetId, track.id, getDropTime(event));
                }}
              >
                {track.layers.map((layer) => {
                  const preview = layerPreview[layer.id];
                  const isSelected = selectedLayerSet.has(layer.id);
                  const isLayerSelectedForKeyframes = selectedLayerId === layer.id;
                  const draggingKeyframe = isLayerSelectedForKeyframes && keyframeDrag?.layerId === layer.id ? keyframeDrag : null;
                  const transitionPreview =
                    transitionDrag?.layerId === layer.id
                      ? { side: transitionDrag.side, durationSeconds: transitionDrag.previewDurationSeconds }
                      : null;
                  return (
                    <TimelineClip
                      assets={assets}
                      durationSeconds={preview?.durationSeconds ?? layer.durationSeconds}
                      draggingKeyframeId={draggingKeyframe?.keyframeId ?? null}
                      draggingKeyframePreviewTime={draggingKeyframe?.previewTimeSeconds ?? null}
                      isDragging={drag?.layerId === layer.id}
                      isEffectDropTarget={effectDropTargetLayerId === layer.id}
                      isSelected={isSelected}
                      isSelectedForKeyframes={isLayerSelectedForKeyframes}
                      isSlipping={slipLayerId === layer.id}
                      slipPreviewSourceInSeconds={slipPreview?.layerId === layer.id ? slipPreview.sourceInSeconds : null}
                      key={layer.id}
                      layer={layer}
                      onCancelDrag={cancelDrag}
                      onCancelKeyframeDrag={cancelKeyframeDrag}
                      onCancelResize={cancelResize}
                      onChangeCurrentTime={onChangeCurrentTime}
                      onClipContextMenu={handleClipContextMenu}
                      onDeleteKeyframe={onDeleteKeyframe}
                      onDeleteLayer={onDeleteLayer}
                      onDropAsset={onDropAsset}
                      onDropTimelineEffect={onDropTimelineEffect}
                      onEnterSlipMode={enterSlipMode}
                      onFinishDrag={finishDrag}
                      onFinishKeyframeDrag={finishKeyframeDrag}
                      onFinishResize={finishResize}
                      onMoveDrag={moveDrag}
                      onMoveKeyframeDrag={moveKeyframeDrag}
                      onMoveResize={moveResize}
                      onSelectKeyframe={setSelectedKeyframeId}
                      onSelectLayer={onSelectLayer}
                      onSetEffectDropTarget={setEffectDropTargetLayerId}
                      onStartDrag={startDrag}
                      onStartKeyframeDrag={startKeyframeDrag}
                      onStartResize={startResize}
                      onStartTransitionDrag={startTransitionDrag}
                      onMoveTransitionDrag={moveTransitionDrag}
                      onFinishTransitionDrag={finishTransitionDrag}
                      onCancelTransitionDrag={cancelTransitionDrag}
                      onRemoveTransition={onRemoveTransition}
                      onPreviewVolume={onPreviewVolume}
                      transitionPreview={transitionPreview}
                      hideFadeIn={junctionRightIds.has(layer.id)}
                      hideFadeOut={junctionLeftIds.has(layer.id)}
                      onUnlinkLayer={onUnlinkLayer}
                      selectedClipKeyframeId={isLayerSelectedForKeyframes ? selectedKeyframeId : null}
                      startSeconds={preview?.startSeconds ?? layer.startSeconds}
                      timelineDurationSeconds={timelineDurationSeconds}
                      trackId={track.id}
                      trackLocked={Boolean(track.locked)}
                    />
                  );
                })}
                {junctions.map((junction) => {
                  const isDragging =
                    crossDrag?.leftLayerId === junction.leftLayerId && crossDrag?.rightLayerId === junction.rightLayerId;
                  const durationSeconds = isDragging ? crossDrag!.previewDurationSeconds : junction.durationSeconds;
                  // Centre the element on the cut so it straddles both clips (Premiere-style), not inside one.
                  const startSeconds = Math.max(0, junction.cutSeconds - durationSeconds / 2);
                  const denominator = Math.max(0.001, timelineDurationSeconds);
                  return (
                    <button
                      key={`xfade_${junction.leftLayerId}_${junction.rightLayerId}`}
                      type="button"
                      className={`timeline-transition transition-kind-${junction.kind} ${isDragging ? "is-dragging" : ""}`}
                      title={`${transitionLabel(junction.kind)} ${durationSeconds.toFixed(2)}s — drag to adjust, double-click to remove`}
                      style={{ left: `${(startSeconds / denominator) * 100}%`, width: `${(durationSeconds / denominator) * 100}%` }}
                      onPointerDown={(event) => startCrossDrag(event, junction)}
                      onPointerMove={moveCrossDrag}
                      onPointerUp={finishCrossDrag}
                      onPointerCancel={cancelCrossDrag}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onRemoveCrossDissolve(junction.leftLayerId, junction.rightLayerId);
                      }}
                    >
                      <span className="timeline-transition-glyph" aria-hidden="true">
                        {transitionGlyph(junction.kind)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      </div>
      {showShortcuts ? (
        <div className="timeline-shortcuts-backdrop" onClick={() => setShowShortcuts(false)}>
          <div className="timeline-shortcuts-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>Keyboard shortcuts</h3>
              <button type="button" title="Close" onClick={() => setShowShortcuts(false)}>
                <X size={14} />
              </button>
            </header>
            <ul>
              {shortcutCheatSheet.map((item) => (
                <li key={item.keys}>
                  <kbd>{item.keys}</kbd>
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {showProxyInfo ? (
        <div className="timeline-shortcuts-backdrop" onClick={() => setShowProxyInfo(false)}>
          <div className="timeline-shortcuts-panel timeline-proxy-info-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>Preview proxies</h3>
              <button type="button" title="Close" onClick={() => setShowProxyInfo(false)}>
                <X size={14} />
              </button>
            </header>
            <div className="timeline-proxy-info-body">
              <p>
                Preview proxies are cached timeline sections used to keep long edits smooth without keeping many WebGL renderers alive.
              </p>
              <p>
                Use the refresh button to rebuild the whole timeline cache when playback looks stale. Set both In and Out points, then use I/O to rebuild only that range.
              </p>
              <ul>
                <li><span className="proxy-dot is-ready" /> Ready sections can play from proxy media.</li>
                <li><span className="proxy-dot is-live" /> Live sections were rendered during playback and still need proxy media.</li>
                <li><span className="proxy-dot is-pending" /> Pending sections are queued for regeneration.</li>
                <li><span className="proxy-dot is-dirty" /> Dirty sections changed and need a new proxy.</li>
                <li><span className="proxy-dot is-failed" /> Failed sections fall back to live preview until rebuilt.</li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}
      {trackContextMenu ? (
        <div
          className="timeline-context-backdrop"
          onClick={() => setTrackContextMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setTrackContextMenu(null);
          }}
        >
          <div
            className="timeline-context-menu"
            style={{ left: `${trackContextMenu.x}px`, top: `${trackContextMenu.y}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                onChangeCurrentTime(trackContextMenu.timeSeconds);
                setTrackContextMenu(null);
              }}
            >
              Go to here ({trackContextMenu.timeSeconds.toFixed(2)}s)
            </button>
            <span className="timeline-context-menu-divider" />
            <button
              type="button"
              onClick={() => {
                onSetInPoint?.(trackContextMenu.timeSeconds);
                setTrackContextMenu(null);
              }}
            >
              Set in point here
            </button>
            <button
              type="button"
              onClick={() => {
                onSetOutPoint?.(trackContextMenu.timeSeconds);
                setTrackContextMenu(null);
              }}
            >
              Set out point here
            </button>
            <span className="timeline-context-menu-divider" />
            <button
              type="button"
              disabled={inPointSeconds === undefined}
              onClick={() => {
                onClearInPoint?.();
                setTrackContextMenu(null);
              }}
            >
              Clear in point
            </button>
            <button
              type="button"
              disabled={outPointSeconds === undefined}
              onClick={() => {
                onClearOutPoint?.();
                setTrackContextMenu(null);
              }}
            >
              Clear out point
            </button>
            <button
              type="button"
              disabled={inPointSeconds === undefined && outPointSeconds === undefined}
              onClick={() => {
                onClearInOutPoints?.();
                setTrackContextMenu(null);
              }}
            >
              Clear in &amp; out
            </button>
          </div>
        </div>
      ) : null}
      {clipContextMenu ? (
        <div
          className="timeline-context-backdrop"
          onClick={() => setClipContextMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setClipContextMenu(null);
          }}
        >
          <div
            ref={contextMenuRef}
            className="timeline-context-menu"
            style={{
              left: `${contextMenuPos?.left ?? clipContextMenu.x}px`,
              top: `${contextMenuPos?.top ?? clipContextMenu.y}px`,
              visibility: contextMenuPos ? "visible" : "hidden"
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {clipContextMenu.replaceable ? (
              <button
                type="button"
                onClick={() => {
                  onReplaceLayerAsset?.(clipContextMenu.layerId);
                  setClipContextMenu(null);
                }}
              >
                Replace asset…
              </button>
            ) : null}
            {clipContextMenu.slippable ? (
              <button
                type="button"
                onClick={() => {
                  enterSlipMode(clipContextMenu.layerId);
                  setClipContextMenu(null);
                }}
              >
                Slip source (drag to shift)
              </button>
            ) : null}
            {clipContextMenu.linked && onUnlinkLayer ? (
              <button
                type="button"
                onClick={() => {
                  onUnlinkLayer(clipContextMenu.layerId);
                  setClipContextMenu(null);
                }}
              >
                Unlink clip
              </button>
            ) : null}
            {clipContextMenu.crossPair ? (
              <>
                <span className="timeline-context-menu-divider" />
                <span className="timeline-context-menu-label">{clipContextMenu.hasTransition ? "Change cut transition" : "Add transition at cut"}</span>
                {contextTransitions().map((entry) => (
                  <button
                    key={entry.label}
                    type="button"
                    onClick={() => {
                      if (clipContextMenu.crossPair) {
                        onAddCrossDissolve(clipContextMenu.crossPair.leftLayerId, clipContextMenu.crossPair.rightLayerId, {
                          ...entry.spec,
                          durationSeconds: 0.5
                        });
                      }
                      setClipContextMenu(null);
                    }}
                  >
                    {entry.label}
                  </button>
                ))}
                {clipContextMenu.hasTransition ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (clipContextMenu.crossPair) {
                        onRemoveCrossDissolve(clipContextMenu.crossPair.leftLayerId, clipContextMenu.crossPair.rightLayerId);
                      }
                      setClipContextMenu(null);
                    }}
                  >
                    Clear transition
                  </button>
                ) : null}
              </>
            ) : null}
            <span className="timeline-context-menu-divider" />
            <button
              type="button"
              onClick={() => {
                onDuplicateLayer?.(clipContextMenu.layerId);
                setClipContextMenu(null);
              }}
            >
              Duplicate clip
            </button>
            <button
              type="button"
              onClick={() => {
                onDeleteLayer(clipContextMenu.layerId);
                setClipContextMenu(null);
              }}
            >
              Delete clip
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function getClientSelectionBox(selection: { startX: number; startY: number; currentX: number; currentY: number }) {
  return {
    left: Math.min(selection.startX, selection.currentX),
    right: Math.max(selection.startX, selection.currentX),
    top: Math.min(selection.startY, selection.currentY),
    bottom: Math.max(selection.startY, selection.currentY)
  };
}

function resolveSelectMode(event: Pick<PointerEvent, "shiftKey" | "metaKey" | "ctrlKey">): LayerSelectMode {
  if (event.shiftKey && (event.metaKey || event.ctrlKey)) {
    return "add-range";
  }
  if (event.shiftKey) {
    return "range";
  }
  if (event.metaKey || event.ctrlKey) {
    return "toggle";
  }
  return "replace";
}

function getMarqueeStyle(selection: { startX: number; startY: number; currentX: number; currentY: number }) {
  const box = getClientSelectionBox(selection);
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.right - box.left}px`,
    height: `${box.bottom - box.top}px`
  } as CSSProperties;
}

// Renders the clip's ACTUAL audio waveform (decoded peaks). Falls back to a stable
// placeholder shape while the asset decodes or if it can't be read (e.g. CORS).
const Waveform = memo(function Waveform({
  layerId,
  url,
  sourceInSeconds,
  durationSeconds
}: {
  layerId: string;
  url?: string | undefined;
  sourceInSeconds: number;
  durationSeconds: number;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  // We draw in real pixel space (viewBox === element size, 1:1) so bars stay genuinely
  // thin with crisp rounded caps — a stretched viewBox distorts the corner radius.
  const [size, setSize] = useState({ w: 240, h: 36 });
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      setSize((prev) => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const { w, h } = size;
  // ~3px per bar → very thin, dense bars that multiply as the clip is zoomed/widened.
  const bucketCount = clamp(Math.round(w / 3), 24, 2000);
  const peaks = useAudioPeaksSlice(url, sourceInSeconds, durationSeconds, bucketCount);
  const data = peaks ?? Array.from({ length: bucketCount }, (_, index) => 0.25 + pseudoRandom(layerId, index) * 0.6);
  const bars = useMemo(() => {
    const n = data.length;
    const slot = w / n;
    const barW = Math.min(2, Math.max(1, slot * 0.62));
    const rx = (barW / 2).toFixed(2);
    const maxH = h * 0.9;
    return data.map((value, index) => {
      const bh = Math.max(barW, Math.min(1, value) * maxH);
      const x = index * slot + (slot - barW) / 2;
      const y = (h - bh) / 2;
      return <rect key={index} x={x.toFixed(2)} y={y.toFixed(2)} width={barW.toFixed(2)} height={bh.toFixed(2)} rx={rx} ry={rx} />;
    });
  }, [data, w, h]);
  return (
    <span ref={hostRef} className={`clip-waveform ${peaks ? "is-real" : "is-loading"}`} aria-hidden="true">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {bars}
      </svg>
    </span>
  );
});

// Movavi-style audio volume envelope: a draggable gain line over the waveform. Reads/writes the clip's
// `volume` effect gain keyframes (the same data preview audio + export consume), so dragging is heard live.
const AudioVolumeEnvelope = memo(function AudioVolumeEnvelope({
  layer,
  onPreviewVolume
}: {
  layer: TimelineLayer;
  onPreviewVolume: (layerId: string, updater: (layer: TimelineLayer) => TimelineLayer, commit: boolean) => void;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ w: 240, h: 36 });
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      setSize((prev) => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const { w, h } = size;
  const duration = Math.max(0.0001, layer.durationSeconds);
  const base = getVolumeBase(layer);
  const points = getVolumePoints(layer);

  const gainToY = (g: number) => h * (1 - g / VOLUME_MAX);
  const yToGain = (y: number) => clamp((1 - y / h) * VOLUME_MAX, 0, VOLUME_MAX);
  const tToX = (t: number) => (t / duration) * w;
  const xToT = (x: number) => clamp((x / w) * duration, 0, duration);

  type Drag =
    | { kind: "point" | "base"; id: string; pointerId: number; startX: number; startY: number; moved: boolean }
    | { kind: "handle"; id: string; which: "in" | "out"; pointerId: number; ax: number; ay: number; bx: number; by: number };
  const dragRef = useRef<Drag | null>(null);
  const localXY = (event: PointerEvent) => {
    const rect = hostRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const startPointDrag = (event: PointerEvent<SVGCircleElement>, id: string) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = localXY(event);
    dragRef.current = { kind: "point", id, pointerId: event.pointerId, startX: x, startY: y, moved: false };
  };
  // Press on the line: a plain click adds a keyframe; a drag (when unanimated) sets the base gain.
  const startLineInteraction = (event: PointerEvent<SVGPolylineElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = localXY(event);
    dragRef.current = { kind: "base", id: "base", pointerId: event.pointerId, startX: x, startY: y, moved: false };
  };
  // Press on a tangent dot: drag to shape the Bézier segment (A→B endpoints captured for the screen→dx/dy map).
  const startHandleDrag = (
    event: PointerEvent<SVGCircleElement>,
    id: string,
    which: "in" | "out",
    ax: number,
    ay: number,
    bx: number,
    by: number
  ) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "handle", id, which, pointerId: event.pointerId, ax, ay, bx, by };
  };
  const applyHandle = (drag: Extract<Drag, { kind: "handle" }>, x: number, y: number, commit: boolean) => {
    const span = drag.bx - drag.ax;
    if (Math.abs(span) < 0.5) return;
    const valSpan = drag.by - drag.ay;
    const dx =
      drag.which === "out" ? clamp((x - drag.ax) / span, 0.01, 0.99) : clamp((x - drag.bx) / span, -0.99, -0.01);
    const anchorY = drag.which === "out" ? drag.ay : drag.by;
    const dy = Math.abs(valSpan) < 0.5 ? 0 : (y - anchorY) / valSpan;
    onPreviewVolume(layer.id, (l) => setVolumePointHandle(l, drag.id, drag.which, dx, dy), commit);
  };
  const handleMove = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = localXY(event);
    if (drag.kind === "handle") {
      applyHandle(drag, x, y, false);
      return;
    }
    if (!drag.moved && Math.abs(x - drag.startX) + Math.abs(y - drag.startY) > 3) drag.moved = true;
    const gain = yToGain(y);
    if (drag.kind === "base") {
      if (drag.moved && !points.length) onPreviewVolume(layer.id, (l) => setVolumeBase(l, gain), false);
    } else {
      onPreviewVolume(layer.id, (l) => moveVolumePoint(l, drag.id, xToT(x), gain), false);
    }
  };
  const handleUp = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const { x, y } = localXY(event);
    if (drag.kind === "handle") {
      applyHandle(drag, x, y, true);
      return;
    }
    const gain = yToGain(y);
    if (drag.kind === "base") {
      if (!drag.moved) onPreviewVolume(layer.id, (l) => addVolumePoint(l, xToT(x), gain).layer, true); // click → add
      else if (!points.length) onPreviewVolume(layer.id, (l) => setVolumeBase(l, gain), true); // drag → base
    } else if (drag.moved) {
      onPreviewVolume(layer.id, (l) => moveVolumePoint(l, drag.id, xToT(x), gain), true);
    }
  };
  const removeAt = (event: ReactMouseEvent<SVGCircleElement>, id: string) => {
    event.stopPropagation();
    onPreviewVolume(layer.id, (l) => removeVolumePoint(l, id), true);
  };
  const cycleInterp = (event: ReactMouseEvent<SVGCircleElement>, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    onPreviewVolume(layer.id, (l) => cycleVolumePointInterpolation(l, id), true);
  };

  // Sample the *resolved* gain across the clip width so the line reflects Linear/Smooth/Hold exactly and
  // matches playback + export (which read the same getCompositionVolume). Flat/base falls out for free.
  const samples = points.length ? Math.max(2, Math.min(160, Math.round(w / 2))) : 1;
  const linePoints = (() => {
    if (!points.length) {
      const y = gainToY(base).toFixed(1);
      return `0,${y} ${w.toFixed(1)},${y}`;
    }
    const pts: string[] = [];
    for (let i = 0; i <= samples; i += 1) {
      const x = (i / samples) * w;
      const gain = getCompositionVolume(layer, { currentTimeSeconds: layer.startSeconds + xToT(x) }) * 100;
      pts.push(`${x.toFixed(1)},${gainToY(gain).toFixed(1)}`);
    }
    return pts.join(" ");
  })();
  const unityY = gainToY(VOLUME_UNITY).toFixed(1);

  return (
    <span ref={hostRef} className="clip-volume-envelope" aria-hidden="true">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width={w} height={h}>
        <line className="cve-unity" x1={0} y1={unityY} x2={w} y2={unityY} />
        <polyline className="cve-line" points={linePoints} />
        {/* Invisible thick hit target: click to add a point; drag (when unanimated) sets base gain. */}
        <polyline
          className="cve-hit"
          points={linePoints}
          onPointerDown={startLineInteraction}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
        />
        {points.map((p, i) => {
          const a = { x: tToX(p.t), y: gainToY(p.gain) };
          const out =
            i < points.length - 1
              ? (() => {
                  const np = points[i + 1]!;
                  const b = { x: tToX(np.t), y: gainToY(np.gain) };
                  const dx = p.temporal.out?.dx ?? VOLUME_HANDLE_OUT_DX;
                  const dy = p.temporal.out?.dy ?? 0;
                  return { cx: a.x + dx * (b.x - a.x), cy: a.y + dy * (b.y - a.y), ax: a.x, ay: a.y, bx: b.x, by: b.y };
                })()
              : null;
          const inn =
            i > 0
              ? (() => {
                  const pp = points[i - 1]!;
                  const aa = { x: tToX(pp.t), y: gainToY(pp.gain) };
                  const dx = p.temporal.in?.dx ?? VOLUME_HANDLE_IN_DX;
                  const dy = p.temporal.in?.dy ?? 0;
                  return { cx: a.x + dx * (a.x - aa.x), cy: a.y + dy * (a.y - aa.y), ax: aa.x, ay: aa.y, bx: a.x, by: a.y };
                })()
              : null;
          return (
            <g key={`h_${p.id}`}>
              {out ? (
                <>
                  <line className="cve-handle-line" x1={a.x.toFixed(1)} y1={a.y.toFixed(1)} x2={out.cx.toFixed(1)} y2={out.cy.toFixed(1)} />
                  <circle
                    className="cve-handle"
                    cx={out.cx.toFixed(1)}
                    cy={out.cy.toFixed(1)}
                    r={3}
                    onPointerDown={(event) => startHandleDrag(event, p.id, "out", out.ax, out.ay, out.bx, out.by)}
                    onPointerMove={handleMove}
                    onPointerUp={handleUp}
                  />
                </>
              ) : null}
              {inn ? (
                <>
                  <line className="cve-handle-line" x1={a.x.toFixed(1)} y1={a.y.toFixed(1)} x2={inn.cx.toFixed(1)} y2={inn.cy.toFixed(1)} />
                  <circle
                    className="cve-handle"
                    cx={inn.cx.toFixed(1)}
                    cy={inn.cy.toFixed(1)}
                    r={3}
                    onPointerDown={(event) => startHandleDrag(event, p.id, "in", inn.ax, inn.ay, inn.bx, inn.by)}
                    onPointerMove={handleMove}
                    onPointerUp={handleUp}
                  />
                </>
              ) : null}
            </g>
          );
        })}
        {points.map((p) => (
          <circle
            key={p.id}
            className="cve-point"
            cx={tToX(p.t).toFixed(1)}
            cy={gainToY(p.gain).toFixed(1)}
            r={4}
            onPointerDown={(event) => startPointDrag(event, p.id)}
            onPointerMove={handleMove}
            onPointerUp={handleUp}
            onDoubleClick={(event) => removeAt(event, p.id)}
            onContextMenu={(event) => cycleInterp(event, p.id)}
          >
            <title>{`${Math.round(p.gain)}% · ${volumeInterpolationLabel(p.interpolation)} — right-click to change · double-click to remove`}</title>
          </circle>
        ))}
      </svg>
    </span>
  );
});

// Real video-frame filmstrip: tiles captured frames across the clip at a FIXED on-screen size.
// The cache holds a fixed number of evenly-spaced frames per asset; the strip picks the tile COUNT
// from the clip's measured width so every tile is roughly one frame wide (height * frame aspect) regardless
// of clip duration. A short and a long clip then show the same-sized frames: a uniform filmstrip,
// not 10 frames squished/stretched to fit (the old `flex:1`-per-fixed-10 layout). Shows a subtle
// placeholder while frames extract (or if the asset can't be read). The host span is stable across
// loading/ready so the ResizeObserver stays attached.
const FILMSTRIP_DEFAULT_ASPECT = 16 / 9;

const Filmstrip = memo(function Filmstrip({ url }: { url?: string | undefined }) {
  const thumbs = useVideoThumbnails(url);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [aspect, setAspect] = useState(FILMSTRIP_DEFAULT_ASPECT);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setBox((prev) =>
        Math.abs(prev.width - rect.width) > 0.5 || Math.abs(prev.height - rect.height) > 0.5
          ? { width: rect.width, height: rect.height }
          : prev
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Real frame aspect from the first cached thumbnail, so each fixed tile shows a full (uncropped)
  // frame at the clip's height. Cheap one-shot decode of a tiny cached data URL.
  const firstThumb = thumbs?.[0];
  useEffect(() => {
    if (!firstThumb) return;
    const img = document.createElement("img");
    img.onload = () => {
      if (img.naturalHeight > 0) setAspect(img.naturalWidth / img.naturalHeight);
    };
    img.src = firstThumb;
  }, [firstThumb]);

  const ready = Boolean(thumbs && thumbs.length > 0);
  const tilePx = Math.max(28, Math.round((box.height || 44) * aspect));
  const tileCount = ready ? (box.width > 0 ? Math.max(1, Math.round(box.width / tilePx)) : thumbs!.length) : 0;
  const tiles = ready
    ? Array.from({ length: tileCount }, (_, i) => {
        const frac = tileCount <= 1 ? 0 : i / (tileCount - 1);
        const index = Math.min(thumbs!.length - 1, Math.round(frac * (thumbs!.length - 1)));
        return thumbs![index];
      })
    : [];

  return (
    <span ref={hostRef} className={`clip-filmstrip ${ready ? "" : "is-loading"}`} aria-hidden="true">
      {tiles.map((src, index) => (
        <i key={index} style={{ backgroundImage: `url(${src})` }} />
      ))}
    </span>
  );
});

function getDraggedTimelineEffect(event: DragEvent<HTMLElement>): TimelineEffectType | undefined {
  const type = event.dataTransfer.getData("application/x-lumio-timeline-effect");
  return getTimelineEffectDefinition(type as TimelineEffectType) ? (type as TimelineEffectType) : undefined;
}

function canDropTimelineEffect(effectType: TimelineEffectType, layer: TimelineLayer) {
  return Boolean(getTimelineEffectDefinition(effectType)?.compatibleLayerTypes.includes(layer.type));
}

interface TimelineClipProps {
  layer: TimelineLayer;
  trackId: string;
  trackLocked: boolean;
  timelineDurationSeconds: number;
  startSeconds: number;
  durationSeconds: number;
  isSelected: boolean;
  isDragging: boolean;
  isEffectDropTarget: boolean;
  isSelectedForKeyframes: boolean;
  isSlipping: boolean;
  slipPreviewSourceInSeconds: number | null;
  selectedClipKeyframeId: string | null;
  draggingKeyframeId: string | null;
  draggingKeyframePreviewTime: number | null;
  assets: SourceAsset[];
  onClipContextMenu: (event: ReactMouseEvent<HTMLDivElement>, layer: TimelineLayer) => void;
  onEnterSlipMode: (layerId: string) => void;
  onStartDrag: (event: PointerEvent<HTMLDivElement>, layer: TimelineLayer) => void;
  onMoveDrag: (event: PointerEvent<HTMLDivElement>) => void;
  onFinishDrag: (event: PointerEvent<HTMLDivElement>) => void;
  onCancelDrag: () => void;
  onStartResize: (event: PointerEvent<HTMLSpanElement>, layer: TimelineLayer, edge: "start" | "end") => void;
  onMoveResize: (event: PointerEvent<HTMLSpanElement>) => void;
  onFinishResize: (event: PointerEvent<HTMLSpanElement>) => void;
  onCancelResize: () => void;
  onUnlinkLayer?: ((layerId: string) => void) | undefined;
  onSelectLayer: (layerId: string, mode?: LayerSelectMode) => void;
  onDropAsset: (assetId: string, trackId: string, startSeconds: number, replaceLayerId?: string | undefined) => void;
  onDropTimelineEffect: (effectType: TimelineEffectType, layerId: string) => void;
  onDeleteLayer: (layerId: string) => void;
  onDeleteKeyframe: (layerId: string, keyframeId: string) => void;
  onChangeCurrentTime: (timeSeconds: number) => void;
  onStartKeyframeDrag: (event: PointerEvent<HTMLButtonElement>, layer: TimelineLayer, keyframe: TimelineKeyframeV2) => void;
  onMoveKeyframeDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onFinishKeyframeDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onCancelKeyframeDrag: () => void;
  onStartTransitionDrag: (event: PointerEvent<HTMLSpanElement>, layer: TimelineLayer, side: "fadeIn" | "fadeOut") => void;
  onMoveTransitionDrag: (event: PointerEvent<HTMLSpanElement>) => void;
  onFinishTransitionDrag: (event: PointerEvent<HTMLSpanElement>) => void;
  onCancelTransitionDrag: () => void;
  onRemoveTransition: (layerId: string, side: "fadeIn" | "fadeOut") => void;
  onPreviewVolume?: ((layerId: string, updater: (layer: TimelineLayer) => TimelineLayer, commit: boolean) => void) | undefined;
  transitionPreview: { side: "fadeIn" | "fadeOut"; durationSeconds: number } | null;
  hideFadeIn: boolean;
  hideFadeOut: boolean;
  onSelectKeyframe: (keyframeId: string | null) => void;
  onSetEffectDropTarget: (layerId: string | null) => void;
}

// Memoized so dragging/resizing/scrubbing one clip doesn't re-render every other
// clip in the timeline - see the useCallback-wrapped handlers in TimelineStrip
// that keep these props referentially stable across a single drag/resize gesture.
const TimelineClip = memo(function TimelineClip({
  layer,
  trackId,
  trackLocked,
  timelineDurationSeconds,
  startSeconds,
  durationSeconds,
  isSelected,
  isDragging,
  isEffectDropTarget,
  isSelectedForKeyframes,
  isSlipping,
  slipPreviewSourceInSeconds,
  selectedClipKeyframeId,
  draggingKeyframeId,
  draggingKeyframePreviewTime,
  assets,
  onClipContextMenu,
  onEnterSlipMode,
  onStartDrag,
  onMoveDrag,
  onFinishDrag,
  onCancelDrag,
  onStartResize,
  onMoveResize,
  onFinishResize,
  onCancelResize,
  onUnlinkLayer,
  onSelectLayer,
  onDropAsset,
  onDropTimelineEffect,
  onDeleteLayer,
  onDeleteKeyframe,
  onChangeCurrentTime,
  onStartKeyframeDrag,
  onMoveKeyframeDrag,
  onFinishKeyframeDrag,
  onCancelKeyframeDrag,
  onStartTransitionDrag,
  onMoveTransitionDrag,
  onFinishTransitionDrag,
  onCancelTransitionDrag,
  onRemoveTransition,
  onPreviewVolume,
  transitionPreview,
  hideFadeIn,
  hideFadeOut,
  onSelectKeyframe,
  onSetEffectDropTarget
}: TimelineClipProps) {
  const left = (startSeconds / timelineDurationSeconds) * 100;
  const width = (durationSeconds / timelineDurationSeconds) * 100;
  const layerKeyframes = useMemo(() => getVisibleLayerKeyframes(layer), [layer]);
  const fades = useMemo(() => getClipFades(layer), [layer]);
  // A fade that's part of a cross-dissolve junction renders as the shared junction element, not as a
  // per-clip band, so suppress that side here to avoid drawing both.
  const fadeInDuration = hideFadeIn ? 0 : transitionPreview?.side === "fadeIn" ? transitionPreview.durationSeconds : fades.fadeIn;
  const fadeOutDuration = hideFadeOut ? 0 : transitionPreview?.side === "fadeOut" ? transitionPreview.durationSeconds : fades.fadeOut;
  const fadeInPercent = Math.min(100, (fadeInDuration / Math.max(0.0001, layer.durationSeconds)) * 100);
  const fadeOutPercent = Math.min(100, (fadeOutDuration / Math.max(0.0001, layer.durationSeconds)) * 100);
  const slipReadout = isSlipping ? (slipPreviewSourceInSeconds ?? layer.sourceInSeconds ?? 0) : null;
  const canSlip = (layer.type === "video" || layer.type === "audio") && Boolean(layer.assetId);
  const asset = layer.assetId ? assets.find((item) => item.id === layer.assetId) : undefined;
  const audioUrl = layer.type === "audio" ? asset?.fileUrl : undefined;

  return (
    <div
      aria-label={`${layer.name}, ${layer.type}, starts at ${startSeconds.toFixed(1)} seconds`}
      className={`timeline-clip timeline-clip-${layer.type} ${isSelected ? "is-selected" : ""} ${isDragging ? "is-dragging" : ""} ${
        isEffectDropTarget ? "is-effect-drop-target" : ""
      } ${isSlipping ? "is-slipping" : ""}`}
      data-layer-id={layer.id}
      role="button"
      tabIndex={0}
      title={`${layer.name} · ${startSeconds.toFixed(1)}s - ${(startSeconds + durationSeconds).toFixed(1)}s${canSlip ? " · double-click to slip source" : ""}`}
      onPointerDown={(event) => onStartDrag(event, layer)}
      onPointerMove={onMoveDrag}
      onPointerUp={onFinishDrag}
      onPointerCancel={onCancelDrag}
      onDoubleClick={(event) => {
        if (!canSlip) {
          return;
        }
        event.stopPropagation();
        onEnterSlipMode(layer.id);
      }}
      onContextMenu={(event) => onClipContextMenu(event, layer)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onSelectLayer(layer.id);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/x-lumio-asset")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          return;
        }

        if (event.dataTransfer.types.includes("application/x-lumio-timeline-effect")) {
          const effectType = getDraggedTimelineEffect(event);
          if (effectType && canDropTimelineEffect(effectType, layer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            onSetEffectDropTarget(layer.id);
          } else {
            event.dataTransfer.dropEffect = "none";
            onSetEffectDropTarget(null);
          }
        }
      }}
      onDragLeave={() => {
        if (isEffectDropTarget) {
          onSetEffectDropTarget(null);
        }
      }}
      onDrop={(event) => {
        onSetEffectDropTarget(null);
        const assetId = event.dataTransfer.getData("application/x-lumio-asset");
        if (assetId) {
          event.preventDefault();
          event.stopPropagation();
          onDropAsset(assetId, trackId, startSeconds, layer.id);
          return;
        }

        const effectType = getDraggedTimelineEffect(event);
        if (effectType && canDropTimelineEffect(effectType, layer)) {
          event.preventDefault();
          event.stopPropagation();
          onDropTimelineEffect(effectType, layer.id);
        }
      }}
      style={{
        left: `${left}%`,
        // Width reflects the clip's ACTUAL duration (no artificial percentage floor — that
        // made short clips look like they had a minimum length). A small px min-width in CSS
        // keeps a 1-frame clip grabbable without distorting its length.
        width: `${Math.max(0, width)}%`
      }}
    >
      <span className="clip-resize clip-resize-start" onPointerDown={(event) => onStartResize(event, layer, "start")} onPointerMove={onMoveResize} onPointerUp={onFinishResize} onPointerCancel={onCancelResize} />
      {fadeInDuration > 0 ? (
        <span
          className="clip-fade-band clip-fade-band-in"
          style={{ width: `${fadeInPercent}%` }}
          title={`Fade in ${fadeInDuration.toFixed(2)}s — drag to adjust, double-click to remove`}
          onPointerDown={(event) => onStartTransitionDrag(event, layer, "fadeIn")}
          onPointerMove={onMoveTransitionDrag}
          onPointerUp={onFinishTransitionDrag}
          onPointerCancel={onCancelTransitionDrag}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemoveTransition(layer.id, "fadeIn");
          }}
        >
          <span className="clip-fade-handle" aria-hidden="true" />
        </span>
      ) : null}
      {fadeOutDuration > 0 ? (
        <span
          className="clip-fade-band clip-fade-band-out"
          style={{ width: `${fadeOutPercent}%` }}
          title={`Fade out ${fadeOutDuration.toFixed(2)}s — drag to adjust, double-click to remove`}
          onPointerDown={(event) => onStartTransitionDrag(event, layer, "fadeOut")}
          onPointerMove={onMoveTransitionDrag}
          onPointerUp={onFinishTransitionDrag}
          onPointerCancel={onCancelTransitionDrag}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemoveTransition(layer.id, "fadeOut");
          }}
        >
          <span className="clip-fade-handle" aria-hidden="true" />
        </span>
      ) : null}
      {layer.type === "audio" ? (
        <Waveform
          layerId={layer.id}
          url={audioUrl}
          sourceInSeconds={isSlipping ? (slipPreviewSourceInSeconds ?? layer.sourceInSeconds ?? 0) : (layer.sourceInSeconds ?? 0)}
          durationSeconds={layer.durationSeconds}
        />
      ) : null}
      {layer.type === "audio" && onPreviewVolume ? (
        <AudioVolumeEnvelope layer={layer} onPreviewVolume={onPreviewVolume} />
      ) : null}
      {layer.type === "video" ? <Filmstrip url={asset?.fileUrl} /> : null}
      {isSlipping ? <span className="clip-slip-badge">slip {slipReadout!.toFixed(2)}s</span> : null}
      <span className="clip-label">
        <span className="clip-icon" aria-hidden="true">{clipTypeIcon(layer.type)}</span>
        {layer.linkedGroupId ? <span className="clip-kind">linked</span> : null}
        <strong aria-hidden="true">{clipTitle(layer, assets)}</strong>
      </span>
      {isSelectedForKeyframes && layerKeyframes.length ? (
        <div className="clip-keyframe-lane" aria-label={`${layer.name} keyframes`} onPointerDown={(event) => event.stopPropagation()}>
          <span className="clip-keyframe-lane-label">KF</span>
          {layerKeyframes.map((keyframe) => {
            const previewTime = draggingKeyframeId === keyframe.id ? (draggingKeyframePreviewTime ?? keyframe.timeSeconds) : keyframe.timeSeconds;
            const isSelectedKeyframe = selectedClipKeyframeId === keyframe.id;
            return (
              <button
                aria-label={`${shortKeyframeProperty(keyframe.target.property)} keyframe at ${previewTime.toFixed(2)} seconds`}
                className={`clip-keyframe-marker ${isSelectedKeyframe ? "is-selected" : ""} ${
                  draggingKeyframeId === keyframe.id ? "is-dragging" : ""
                } clip-keyframe-${keyframe.interpolation}`}
                key={`${keyframe.id}_${keyframe.target.property}`}
                title={`${shortKeyframeProperty(keyframe.target.property)} · ${previewTime.toFixed(2)}s`}
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectKeyframe(keyframe.id);
                  onSelectLayer(layer.id, "replace");
                  onChangeCurrentTime(layer.startSeconds + keyframe.timeSeconds);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDeleteKeyframe(layer.id, keyframe.id);
                  onSelectKeyframe(null);
                }}
                onPointerCancel={onCancelKeyframeDrag}
                onPointerDown={(event) => onStartKeyframeDrag(event, layer, keyframe)}
                onPointerMove={onMoveKeyframeDrag}
                onPointerUp={onFinishKeyframeDrag}
                style={
                  {
                    "--keyframe-left": `${(previewTime / Math.max(0.0001, layer.durationSeconds)) * 100}%`
                  } as CSSProperties & Record<"--keyframe-left", string>
                }
              >
                <Diamond size={9} />
              </button>
            );
          })}
          {selectedClipKeyframeId ? (
            <button
              className="clip-keyframe-delete"
              type="button"
              title="Delete selected keyframe"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDeleteKeyframe(layer.id, selectedClipKeyframeId);
                onSelectKeyframe(null);
              }}
            >
              <Trash2 size={10} />
            </button>
          ) : null}
        </div>
      ) : null}
      {!trackLocked && !layer.locked ? (
        <button
          className="clip-delete"
          type="button"
          title="Delete element"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onDeleteLayer(layer.id);
          }}
        >
          <Trash2 size={11} />
        </button>
      ) : null}
      <span className="clip-resize clip-resize-end" onPointerDown={(event) => onStartResize(event, layer, "end")} onPointerMove={onMoveResize} onPointerUp={onFinishResize} onPointerCancel={onCancelResize} />
    </div>
  );
});

function getVisibleLayerKeyframes(layer: TimelineLayer) {
  return getLayerAnimations(layer)
    .filter(
      (keyframe) =>
        keyframe.target.scope === "layer" &&
        keyframe.target.property.startsWith("transform.") &&
        // Fades render as friendly bands (getClipFades), not as raw keyframe diamonds.
        !keyframe.id.includes(TRANSITION_MARKER)
    )
    .sort((a, b) => a.timeSeconds - b.timeSeconds || a.target.property.localeCompare(b.target.property));
}

/** Derive a clip's fade-in / fade-out durations (seconds) from its `_transition_` opacity keyframes. */
function getClipFades(layer: TimelineLayer): { fadeIn: number; fadeOut: number } {
  let fadeIn = 0;
  let fadeOut = 0;
  for (const keyframe of layer.animations ?? []) {
    if (!keyframe.id.includes(TRANSITION_MARKER)) continue;
    if (keyframe.id.includes(`${TRANSITION_MARKER}in_1`)) fadeIn = Math.max(fadeIn, keyframe.timeSeconds);
    if (keyframe.id.includes(`${TRANSITION_MARKER}out_0`)) fadeOut = Math.max(fadeOut, layer.durationSeconds - keyframe.timeSeconds);
  }
  return { fadeIn: Math.max(0, fadeIn), fadeOut: Math.max(0, fadeOut) };
}

function layerHasTransition(layer: TimelineLayer, side: "in" | "out"): boolean {
  return (layer.animations ?? []).some((keyframe) => keyframe.id.includes(`${TRANSITION_MARKER}${side}`));
}

/**
 * Detect cross-dissolve overlaps on a track: a pair of same-track clips (A left, B right) that
 * overlap in time where the INCOMING (right) clip has a fade-in. A correct dissolve fades only the
 * incoming clip in over the opaque outgoing one, so the right clip's `_transition_in` + a real time
 * overlap is the signal. Touching clips (overlap ≈ 0) never trigger, so a lone single-clip fade-in
 * band is unaffected.
 */
function getTrackJunctions(track: TimelineTrack): TimelineJunction[] {
  // Visual tracks only — audio crossfades would need a gain envelope, not opacity/geometry.
  if (track.type === "audio") {
    return [];
  }
  const layers = [...track.layers].sort((a, b) => a.startSeconds - b.startSeconds);
  const junctions: TimelineJunction[] = [];
  for (let index = 0; index < layers.length - 1; index += 1) {
    const left = layers[index]!;
    const right = layers[index + 1]!;
    // The incoming clip's `transitionIn` spec is the single source of truth. Clips stay touching now
    // (no overlap/extend), so detect purely by the spec; the element is centred on the cut.
    const spec = right.transitionIn;
    if (!spec) {
      continue;
    }
    const duration = Math.max(0.001, spec.durationSeconds);
    junctions.push({
      leftLayerId: left.id,
      rightLayerId: right.id,
      kind: spec.kind,
      cutSeconds: right.startSeconds,
      startSeconds: Math.max(0, right.startSeconds - duration / 2),
      durationSeconds: duration
    });
  }
  return junctions;
}

/** Find a same-track clip that touches `layer` at a cut, returning the (left, right) pair for a default transition. */
function findTouchingNeighbor(track: TimelineTrack, layer: TimelineLayer): { leftLayerId: string; rightLayerId: string } | null {
  if (track.type === "audio" || layer.type === "audio") {
    return null;
  }
  const end = layer.startSeconds + layer.durationSeconds;
  const right = track.layers.find((item) => item.id !== layer.id && Math.abs(item.startSeconds - end) < 0.02);
  if (right) {
    return { leftLayerId: layer.id, rightLayerId: right.id };
  }
  const left = track.layers.find((item) => item.id !== layer.id && Math.abs(item.startSeconds + item.durationSeconds - layer.startSeconds) < 0.02);
  if (left) {
    return { leftLayerId: left.id, rightLayerId: layer.id };
  }
  return null;
}

function shortKeyframeProperty(property: string) {
  if (property === "transform.position.x") return "X";
  if (property === "transform.position.y") return "Y";
  if (property === "transform.scale") return "Scale";
  if (property === "transform.rotation") return "Rotate";
  if (property === "transform.opacity") return "Opacity";
  return property.replace("transform.", "");
}

function clipTypeIcon(type: TimelineLayerType) {
  switch (type) {
    case "text":
      return <Type size={11} />;
    case "audio":
      return <Music size={11} />;
    case "video":
      return <Film size={11} />;
    case "image":
      return <Image size={11} />;
    case "shape":
      return <Shapes size={11} />;
    case "adjustment":
      return <SlidersHorizontal size={11} />;
    default:
      return <Film size={11} />;
  }
}

function clipTitle(layer: TimelineLayer, assets: SourceAsset[]) {
  const asset = layer.assetId ? assets.find((item) => item.id === layer.assetId) : undefined;
  if (asset) {
    return asset.fileName;
  }
  if (layer.type === "text") {
    return layer.text?.trim() || layer.name;
  }
  return layer.name;
}

function getLayerMaxDuration(layer: TimelineLayer, layerMaxDurations: Record<string, number>, compositionDuration: number) {
  return Math.max(0.2, Math.min(layerMaxDurations[layer.id] ?? compositionDuration, compositionDuration));
}

function playheadOffsetPercent(timeSeconds: number, durationSeconds: number) {
  const percent = (clamp(timeSeconds, 0, durationSeconds) / durationSeconds) * 100;
  return `${percent}%`;
}

function getLaneTime(
  clientX: number,
  lane: HTMLElement,
  visibleDurationSeconds: number,
  maxDurationSeconds: number,
  allowBeyondVisibleDuration: boolean
) {
  const rect = lane.getBoundingClientRect();
  const rawProgress = (clientX - rect.left) / Math.max(1, rect.width);
  const upperBound = allowBeyondVisibleDuration ? maxDurationSeconds : visibleDurationSeconds;
  return clamp(rawProgress * visibleDurationSeconds, 0, Math.max(0.2, upperBound));
}

function getRulerStepSeconds(pixelsPerSecond: number) {
  const candidates = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
  return candidates.find((step) => step * pixelsPerSecond >= 56) ?? 60;
}

function getRulerMarks(durationSeconds: number, stepSeconds: number) {
  const marks: number[] = [];
  const totalSteps = Math.floor(durationSeconds / stepSeconds);
  for (let index = 0; index <= totalSteps; index += 1) {
    marks.push(Number((index * stepSeconds).toFixed(3)));
  }
  if (marks.at(-1) !== durationSeconds) {
    marks.push(durationSeconds);
  }
  return marks;
}

function formatProxyBytes(byteSize: number): string {
  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    return "0 MB";
  }
  const mb = byteSize / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  if (mb >= 10) {
    return `${Math.round(mb)} MB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function formatRulerTime(timeSeconds: number) {
  if (timeSeconds >= 60) {
    const minutes = Math.floor(timeSeconds / 60);
    const seconds = Math.round(timeSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
  if (Math.abs(timeSeconds % 1) > 0.001) {
    return `${timeSeconds.toFixed(timeSeconds < 1 ? 1 : 2).replace(/0+$/, "").replace(/\.$/, "")}s`;
  }
  return `${timeSeconds}s`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function snap(value: number, step: number) {
  return Math.round(value / step) * step;
}

function pseudoRandom(seed: string, index: number) {
  let value = 0;
  for (let i = 0; i < seed.length; i += 1) {
    value = (value * 31 + seed.charCodeAt(i) + index * 17) % 997;
  }
  return (Math.sin(value + index * 12.9898) + 1) / 2;
}
