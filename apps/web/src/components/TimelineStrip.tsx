import { Aperture, ChevronLeft, ChevronRight, ChevronsRight, Circle, Contrast, Copy, Diamond, Eye, EyeOff, Film, Flag, GripVertical, Hand, Image, Info, Keyboard, Link2, Lock, Magnet, Maximize2, Minus, MousePointer2, MoveHorizontal, Music, Pentagon, PenTool, Redo2, RefreshCw, Scissors, Shapes, SlidersHorizontal, SplitSquareHorizontal, Square, Trash2, Triangle, Type, Undo2, UnfoldHorizontal, Unlink2, Unlock, Volume2, VolumeX, X, Zap } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { computeLayerOrdinals, computeSnapTargets, getCompositionVolume, getLayerAnimations, getTimelineEffectDefinition, getTransition, rollEditLimits, slideLayerLimits, snapValue, TIMELINE_MARKER_COLORS, TRANSITION_MARKER, type ShapeKind, type SourceAsset, type TimelineComposition, type TimelineEffectType, type TimelineKeyframeV2, type TimelineLayer, type TimelineLayerType, type TimelineMarker, type TimelineToolMode, type TimelineTrack, type TransitionKind, type TransitionSpec } from "@lumio-by-aelivion/shared";
import { useAudioPeaksSlice } from "../lib/audioPeaks";
import { getPlaybackClock, subscribePlaybackClock, usePlaybackClock } from "../playback/playback-clock";
import { ASSET_LABEL_COLORS, layerLabelOf } from "../lib/assetLabels";
import { useRenderCost } from "../lib/perfDiagnostics";
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
import { SOURCE_DRAG_MIME, type SourceDragPayload } from "./SourceMonitor";
import { useWheelScrollPerformance } from "../lib/useWheelScrollPerformance";
import { favouriteTransitionSpecs } from "../editor/effects/catalog";
import { loadFavourites } from "../editor/effects/favourites";
import { ThemedSelect, type ThemedSelectOption } from "../editor/inspector/controls/ThemedSelect";
import type { PreviewCacheRulerSegment, ProxyCacheStatus } from "../editor/performance/renderCache";

type LayerSelectMode = "replace" | "toggle" | "range" | "add-range";
type LayerCollectionSelectMode = "replace" | "add" | "toggle";
/** A source-monitor drag carries its own mode + marked in/out range — see SourceMonitor.tsx. */
type DropAssetHandler = (
  assetId: string,
  trackId: string,
  startSeconds: number,
  replaceLayerId?: string | undefined,
  sourceDrag?: SourceDragPayload | undefined
) => void;

function readSourceDragPayload(event: DragEvent<HTMLElement>): SourceDragPayload | undefined {
  if (!event.dataTransfer.types.includes(SOURCE_DRAG_MIME)) return undefined;
  try {
    return JSON.parse(event.dataTransfer.getData(SOURCE_DRAG_MIME)) as SourceDragPayload;
  } catch {
    return undefined;
  }
}
export type ShapeAddOptions = {
  shapeKind: ShapeKind;
  widthPercent: number;
  heightPercent: number;
  borderRadius: number;
  name: string;
};
type ShapeToolValue = "rectangle" | "rounded-rectangle" | "ellipse" | "circle" | "line" | "triangle" | "diamond" | "pentagon" | "pen";

type DragState = {
  layerId: string;
  lane: HTMLDivElement;
  pointerId: number;
  startClientY: number;
  offsetSeconds: number;
  previewStartSeconds: number;
  previewTrackId: string;
  movedLayerIds: string[];
  baseStartByLayerId: Record<string, number>;
  /** Original track per layer, frozen at gesture start — the no-op-click guard compares against it. */
  baseTrackByLayerId: Record<string, string>;
  previewStartByLayerId: Record<string, number>;
  previewTrackByLayerId: Record<string, string>;
  previewVerticalOffsetByLayerId: Record<string, number>;
  snappedTo: number | null;
} | null;

type ResizeState = {
  edge: "start" | "end";
  layerId: string;
  lane: HTMLDivElement;
  /** The clip's root element — trim previews write left/width here directly (no React render). */
  clip: HTMLElement | null;
  /** Inline styles as React last wrote them, restored on cancel (React's vdom diff won't). */
  originalLeft: string;
  originalWidth: string;
  /** Values at gesture start — a motionless release commits nothing (see dragChangedAnything). */
  baseStartSeconds: number;
  baseDurationSeconds: number;
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
  { keys: "R", label: "Roll tool — drag near a cut to move it" },
  { keys: "U", label: "Slide tool — drag a clip between neighbours" },
  { keys: "E", label: "Extend nearest edit of selected clip to playhead" },
  { keys: "S", label: "Split selected clips at playhead" },
  { keys: "⌘D", label: "Duplicate selected clip" },
  { keys: "⌃⌥C", label: "Copy clip attributes (effects/transform)" },
  { keys: "⌃⌥V", label: "Paste attributes onto selected clips" },
  { keys: "⇧⌫", label: "Ripple delete selected clip" },
  { keys: "Delete", label: "Delete selected clip" },
  { keys: "N", label: "Toggle snapping" },
  { keys: "M", label: "Add/remove marker at playhead (right-click marker: name/color)" },
  { keys: "⇧M", label: "Add rectangle mask to selected clip" },
  { keys: "I", label: "Set/clear in point at playhead" },
  { keys: "O", label: "Set/clear out point at playhead" },
  { keys: "\\", label: "Fit timeline to view" },
  { keys: "⌘Z", label: "Undo" },
  { keys: "⌘⇧Z", label: "Redo" },
  { keys: "⌘M", label: "Export on this device (local)" },
  { keys: "⌘⇧M", label: "Export to cloud" },
  { keys: "Space", label: "Play / pause" },
  { keys: "J / K / L", label: "Shuttle back / stop / play (tap again: 2×, 4×)" },
  { keys: "Q", label: "Ripple trim clip start to playhead" },
  { keys: "W", label: "Ripple trim clip end to playhead" },
  { keys: "Home", label: "Jump to start" },
  { keys: "End", label: "Jump to end" },
  { keys: "←", label: "Previous frame" },
  { keys: "→", label: "Next frame" },
  { keys: "⇧←/→", label: "Step 5 frames" },
  { keys: "↑ / ↓", label: "Previous / next edit point" },
  { keys: "/", label: "Focus the AI edit box (opens the AI panel)" },
  { keys: ".", label: "Voice input — dictate to the AI (⌘. or ⌥M while typing)" },
  { keys: "⌥L", label: "Voice mode — hands-free AI session (or say “Hey Lumio” with the wake word on)" },
  { keys: "?", label: "Toggle this cheat sheet" }
];

const SHAPE_TOOL_OPTIONS: Array<ShapeAddOptions & { value: ShapeToolValue }> = [
  { value: "rectangle", shapeKind: "rectangle", name: "Rectangle", widthPercent: 40, heightPercent: 22, borderRadius: 0 },
  { value: "rounded-rectangle", shapeKind: "rounded-rectangle", name: "Rounded rectangle", widthPercent: 42, heightPercent: 20, borderRadius: 22 },
  { value: "ellipse", shapeKind: "ellipse", name: "Ellipse", widthPercent: 34, heightPercent: 22, borderRadius: 999 },
  { value: "circle", shapeKind: "ellipse", name: "Circle", widthPercent: 24, heightPercent: 24, borderRadius: 999 },
  { value: "line", shapeKind: "line", name: "Line", widthPercent: 42, heightPercent: 7, borderRadius: 8 },
  { value: "triangle", shapeKind: "triangle", name: "Triangle", widthPercent: 24, heightPercent: 24, borderRadius: 0 },
  { value: "diamond", shapeKind: "diamond", name: "Diamond", widthPercent: 24, heightPercent: 24, borderRadius: 0 },
  { value: "pentagon", shapeKind: "pentagon", name: "Pentagon", widthPercent: 26, heightPercent: 24, borderRadius: 0 },
  { value: "pen", shapeKind: "pen", name: "Pen", widthPercent: 28, heightPercent: 28, borderRadius: 0 }
];

const SHAPE_SELECT_OPTIONS: ThemedSelectOption<ShapeToolValue>[] = SHAPE_TOOL_OPTIONS.map((option) => ({
  value: option.value,
  label: option.name,
  icon: shapeToolIcon(option.shapeKind, option.name)
}));

function shapeToolIcon(shapeKind: ShapeKind, name: string) {
  if (name === "Circle") return <Circle size={15} />;
  switch (shapeKind) {
    case "rectangle":
    case "rounded-rectangle":
      return <Square size={15} />;
    case "ellipse":
      return <Circle size={15} />;
    case "line":
      return <Minus size={15} />;
    case "triangle":
      return <Triangle size={15} />;
    case "diamond":
      return <Diamond size={15} />;
    case "pentagon":
      return <Pentagon size={15} />;
    case "pen":
      return <PenTool size={15} />;
    default:
      return <Shapes size={15} />;
  }
}

/**
 * Timebar timecode readout. Rides the clock store directly so it stays live during playback AND
 * updates instantly on paused seeks/scrubs — the strip itself no longer re-renders per seek (the
 * `currentTime` prop only refreshes on EditorPage's deferred cold commit).
 */
function TimebarClock({ fallback }: { fallback: number }) {
  const time = usePlaybackClock(fallback, true);
  return <span>{time.toFixed(2)}s</span>;
}

type TrackJunctionInfo = { junctions: TimelineJunction[]; junctionLeftIds: Set<string>; junctionRightIds: Set<string> };
const EMPTY_TRACK_JUNCTIONS: TrackJunctionInfo = { junctions: [], junctionLeftIds: new Set(), junctionRightIds: new Set() };

/**
 * memo() so EditorPage's frequent unrelated renders (toasts, inspector edits on other panels,
 * modal state) skip the 4k-line strip entirely — this is what lets the per-clip TimelineClip memo
 * actually pay off. EditorPage passes its ~50 callback props through useStableHandlers so their
 * identities never change; data props are state or memoized values. The strip still re-renders
 * when it must: composition edits, selection, tool/zoom changes, and the cold playhead commit
 * (the `currentTime` prop refreshes there — the live playhead itself stays imperative).
 */
export const TimelineStrip = memo(TimelineStripImpl);

function TimelineStripImpl({
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
  onReorderTrack,
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
  onUpdateMarker,
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
  onRollEdit,
  onSlideLayer,
  onPreviewVolume,
  onSetLayerLabel
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
  onMoveLayer: (layerId: string, startSeconds: number, trackId?: string | undefined, movedLayerIds?: string[] | undefined, targetTrackByLayerId?: Record<string, string> | undefined) => void;
  onReorderTrack?: ((trackId: string, targetTrackId: string, placement: "before" | "after") => void) | undefined;
  onResizeLayer: (layerId: string, startSeconds: number, durationSeconds: number) => void;
  onToggleTrack: (trackId: string, patch: Partial<Pick<TimelineTrack, "locked" | "muted" | "solo">>) => void;
  onDeleteTrack: (trackId: string) => void;
  onDeleteLayer: (layerId: string) => void;
  onDeleteKeyframe: (layerId: string, keyframeId: string) => void;
  onUnlinkLayer?: (layerId: string) => void;
  onUnlinkSelectedLayers?: () => void;
  onAddLayer: (type: TimelineLayerType, options?: ShapeAddOptions) => void;
  onAddTrack: (type: TimelineTrack["type"]) => void;
  onDropAsset: DropAssetHandler;
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
  onRollEdit?: ((leftLayerId: string, rightLayerId: string, deltaSeconds: number) => void) | undefined;
  onSlideLayer?: ((layerId: string, deltaSeconds: number) => void) | undefined;
  onDuplicateLayer?: ((layerId: string) => void) | undefined;
  markers?: TimelineMarker[] | undefined;
  onToggleMarkerAtPlayhead?: (() => void) | undefined;
  onRemoveMarker?: ((markerTime: number) => void) | undefined;
  onUpdateMarker?: ((markerTime: number, patch: { name?: string | undefined; color?: string | undefined }) => void) | undefined;
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
  /** Premiere-style color label for a clip (null clears the override → inherits the asset's label). */
  onSetLayerLabel?: ((layerId: string, label: string | null) => void) | undefined;
}) {
  useRenderCost("TimelineStrip");
  const laneOffsetPx = trackHeight <= 30 ? 64 : trackHeight <= 42 ? 84 : trackHeight <= 60 ? 112 : 124;
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
  // Junction (cross-dissolve) detection sorts every track's layers; compute once per composition
  // change instead of inside the tracks render map below.
  const junctionsByTrackId = useMemo(() => {
    const byTrack = new Map<string, TrackJunctionInfo>();
    for (const track of composition.tracks) {
      const junctions = getTrackJunctions(track);
      byTrack.set(track.id, {
        junctions,
        junctionLeftIds: new Set(junctions.map((item) => item.leftLayerId)),
        junctionRightIds: new Set(junctions.map((item) => item.rightLayerId))
      });
    }
    return byTrack;
  }, [composition.tracks]);
  // Positional clip numbers ("clip N") for the badge + natural-language/AI targeting. Derived once
  // per structural edit (keyed on tracks), never on playhead/scrub, so the perf-critical strip is
  // untouched by a moving playhead.
  const clipOrdinals = useMemo(() => computeLayerOrdinals(composition), [composition.tracks]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pixelsPerSecond, setPixelsPerSecond] = useState(56);
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  const laneWidthPx = Math.max(560, Math.ceil(timelineDurationSeconds * pixelsPerSecond));
  const timelineWidthPx = laneOffsetPx + laneWidthPx;
  const rulerStepSeconds = getRulerStepSeconds(pixelsPerSecond);
  const rulerMarks = useMemo(
    () => getRulerMarks(timelineDurationSeconds, rulerStepSeconds, pixelsPerSecond),
    [timelineDurationSeconds, rulerStepSeconds, pixelsPerSecond]
  );
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
    // Snap to the LIVE playhead from the clock store, not the `currentTime` prop: EditorPage no
    // longer holds playhead state (it dropped `currentTime` useState), so the prop is only a stale
    // fallback now. The clock is the frame-accurate truth at drag time.
    const targets = computeSnapTargets(composition, { excludeLayerId, playheadSeconds: getPlaybackClock(), markers: markers.map((m) => m.timeSeconds) });
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
  // Marker rename/recolor popover (right-click a ruler marker). Identified by time — markers have no ids.
  const [markerEditor, setMarkerEditor] = useState<{ timeSeconds: number; name: string } | null>(null);
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
  // Trim drags render ZERO React frames: even one strip render per frame cost ~130ms on a busy
  // timeline (2026-07-04 soak — trimming ran at ~7fps), so the preview is now an IMPERATIVE DOM
  // write, same doctrine as the playhead. moveResize updates resizeRef synchronously (finish/cancel
  // always commit the latest position) and one rAF writes the clip's left/width + snap guide
  // directly; React re-enters only at commit (finishResize → onResizeLayer). The `resize` state
  // itself only marks gesture start/end. React never rewrites these styles mid-gesture: the strip
  // may re-render (cold playhead commit) but the clip's vdom props are frozen at gesture-start
  // values, so the diff is a no-op — and cancel restores the originals imperatively for the same
  // reason.
  const resizeRafRef = useRef<number | null>(null);
  const snapGuideRef = useRef<HTMLDivElement | null>(null);
  const flushResizePreview = useCallback(() => {
    resizeRafRef.current = null;
    const current = resizeRef.current;
    if (!current?.clip) {
      return;
    }
    const denominator = Math.max(0.001, timelineDurationSeconds);
    current.clip.style.left = `${(current.previewStartSeconds / denominator) * 100}%`;
    current.clip.style.width = `${Math.max(0, (current.previewDurationSeconds / denominator) * 100)}%`;
    const guide = snapGuideRef.current;
    if (guide) {
      if (current.snappedTo !== null) {
        guide.style.display = "";
        guide.style.setProperty("--playhead-percent", playheadOffsetPercent(current.snappedTo, timelineDurationSeconds));
      } else {
        guide.style.display = "none";
      }
    }
  }, [timelineDurationSeconds]);
  const cancelResizeFlush = useCallback(() => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
  }, []);
  // Clip-move drags follow the same imperative doctrine as trim (zero React renders mid-gesture):
  // one rAF writes each moved clip's left% + translateY straight to the DOM. Elements are looked up
  // lazily (after the gesture-start render) and cached with their React-written inline styles so
  // cancel can restore what the vdom diff never saw change.
  const dragRafRef = useRef<number | null>(null);
  const dragPreviewElsRef = useRef<Map<string, { el: HTMLElement; originalLeft: string; originalTransform: string }>>(new Map());
  const flushDragPreview = useCallback(() => {
    dragRafRef.current = null;
    const current = dragRef.current;
    if (!current) {
      return;
    }
    const denominator = Math.max(0.001, timelineDurationSeconds);
    const cache = dragPreviewElsRef.current;
    for (const layerId of current.movedLayerIds) {
      let entry = cache.get(layerId);
      if (!entry) {
        const el = document.querySelector<HTMLElement>(`.timeline-clip[data-layer-id="${CSS.escape(layerId)}"]`);
        if (!el) continue;
        entry = { el, originalLeft: el.style.left, originalTransform: el.style.transform };
        cache.set(layerId, entry);
      }
      const start = current.previewStartByLayerId[layerId];
      if (start !== undefined) {
        entry.el.style.left = `${(start / denominator) * 100}%`;
      }
      const offset = current.previewVerticalOffsetByLayerId[layerId] ?? 0;
      entry.el.style.transform = offset !== 0 ? `translateY(${offset}px)` : entry.originalTransform;
    }
    const guide = snapGuideRef.current;
    if (guide) {
      if (current.snappedTo !== null) {
        guide.style.display = "";
        guide.style.setProperty("--playhead-percent", playheadOffsetPercent(current.snappedTo, timelineDurationSeconds));
      } else {
        guide.style.display = "none";
      }
    }
  }, [timelineDurationSeconds]);
  const cancelDragFlush = useCallback(() => {
    if (dragRafRef.current !== null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
  }, []);
  /**
   * Shared end-of-drag DOM settlement for BOTH commit paths (element finishDrag + the stuck-drag
   * window net): paint the final ref state now (so a vdom-no-op commit — dropped back at the
   * origin — still leaves correct pixels) and restore the React-written transform (a leftover
   * cross-lane translateY would float the clip off its lane if the commit keeps it on-track,
   * because React's diff never saw the transform change).
   */
  const settleDragPreviewForCommit = useCallback(() => {
    cancelDragFlush();
    flushDragPreview();
    for (const entry of dragPreviewElsRef.current.values()) {
      entry.el.style.transform = entry.originalTransform;
    }
    dragPreviewElsRef.current = new Map();
  }, [cancelDragFlush, flushDragPreview]);
  /** Full restore for the cancel paths — the clip snaps back to where React last drew it. */
  const restoreDragPreviewDom = useCallback(() => {
    for (const entry of dragPreviewElsRef.current.values()) {
      entry.el.style.left = entry.originalLeft;
      entry.el.style.transform = entry.originalTransform;
    }
    dragPreviewElsRef.current = new Map();
  }, []);
  /**
   * INSTANT SELECTION HIGHLIGHT: selection state commits through a React transition (see
   * EditorPage's commitLayerSelection), so the `is-selected` classes React renders arrive AFTER the
   * click frame paints. Write them imperatively at pointerdown so the highlight appears the same
   * frame the user clicks; the transition render then reconciles to the identical classes (every
   * clip whose selection changed gets its className rewritten, so the imperative write can never
   * outlive the state). Linked-group partners may light up one commit later — the group expansion
   * lives in EditorPage. Replace-mode paths only; modifier selections keep the current highlight
   * until React catches up.
   */
  const pendingInstantSelectionRef = useRef<string[] | null>(null);
  const applyInstantSelectionHighlight = useCallback((layerIds: string[]) => {
    pendingInstantSelectionRef.current = layerIds;
    const next = new Set(layerIds);
    for (const el of document.querySelectorAll<HTMLElement>(".timeline-clip.is-selected")) {
      if (!next.has(el.dataset.layerId ?? "")) {
        el.classList.remove("is-selected");
      }
    }
    for (const layerId of next) {
      document.querySelector<HTMLElement>(`.timeline-clip[data-layer-id="${CSS.escape(layerId)}"]`)?.classList.add("is-selected");
    }
  }, []);
  /**
   * KEEP THE INSTANT HIGHLIGHT ALIVE UNTIL STATE CATCHES UP (flicker fix, 2026-07-09): the same
   * pointerdown that writes the imperative `is-selected` also sets drag state, so the clicked
   * clip's `isDragging` prop flips and the memo'd TimelineClip RE-RENDERS with the STALE
   * `isSelected` (selection commits through a transition, landing ~hundreds of ms later) — that
   * render rewrote className WITHOUT `is-selected`, visibly dropping the glow until the transition
   * landed (glow → gone → glow). This layout effect re-asserts the pending imperative classes after
   * EVERY strip render, before paint, and self-clears once the committed selection contains them —
   * at which point React's own classes are authoritative (incl. linked-group partners).
   */
  useLayoutEffect(() => {
    const pending = pendingInstantSelectionRef.current;
    if (!pending) {
      return;
    }
    if (pending.every((layerId) => selectedLayerSet.has(layerId))) {
      pendingInstantSelectionRef.current = null;
      return;
    }
    const next = new Set(pending);
    for (const el of document.querySelectorAll<HTMLElement>(".timeline-clip.is-selected")) {
      if (!next.has(el.dataset.layerId ?? "")) {
        el.classList.remove("is-selected");
      }
    }
    for (const layerId of next) {
      document.querySelector<HTMLElement>(`.timeline-clip[data-layer-id="${CSS.escape(layerId)}"]`)?.classList.add("is-selected");
    }
  });
  /**
   * NO-OP-CLICK GUARD: a plain click on a clip runs the full drag lifecycle (pointerdown →
   * pointerup) without moving anything — committing it anyway called `onMoveLayer` with identical
   * values, which built a NEW composition object and put a phantom EDIT through the whole pipeline:
   * a second full-tree render, invalidation of every [composition]-keyed memo (waveforms, snap
   * targets, preview derivations, span-cache signature check), an undo-history snapshot of nothing,
   * and an autosave — the "selecting clips responds very late" report (2026-07-04). Selection is
   * handled by `onSelectLayer` at pointerdown; a motionless release must commit NOTHING.
   */
  const dragChangedAnything = useCallback((drag: NonNullable<DragState>): boolean => {
    for (const layerId of drag.movedLayerIds) {
      const base = drag.baseStartByLayerId[layerId];
      const preview = drag.previewStartByLayerId[layerId];
      if (base !== undefined && preview !== undefined && Math.abs(preview - base) > 1e-6) {
        return true;
      }
      const baseTrack = drag.baseTrackByLayerId[layerId];
      const previewTrack = drag.previewTrackByLayerId[layerId];
      if (baseTrack !== undefined && previewTrack !== undefined && previewTrack !== baseTrack) {
        return true;
      }
    }
    return false;
  }, []);
  const [scrub, setScrub] = useState<{ pointerId: number; frame: HTMLDivElement } | null>(null);
  const [timelinePanning, setTimelinePanning] = useState(false);
  const panRef = useRef<{
    pointerId: number;
    scrollElement: HTMLElement;
    startClientX: number;
    startClientY: number;
    startScrollLeft: number;
    startScrollTop: number;
  } | null>(null);
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
  const [mobileTrackMenu, setMobileTrackMenu] = useState<{ x: number; y: number; trackId: string; label: string } | null>(null);
  const [lastShapeTool, setLastShapeTool] = useState<ShapeToolValue>("rectangle");
  const currentShapeTool = SHAPE_TOOL_OPTIONS.find((option) => option.value === lastShapeTool) ?? SHAPE_TOOL_OPTIONS[0]!;
  const shapeSelectOptions = SHAPE_SELECT_OPTIONS;
  const [trackDrag, setTrackDrag] = useState<{ trackId: string; targetTrackId: string | null; placement: "before" | "after" } | null>(null);
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
  // Roll/slide trim drags (tool modes "roll"/"slide"): like slip, the drag only accumulates a
  // clamped delta shown as a badge on the clip — the composition mutates ONCE on pointer-up
  // through the pure shared ops (rollEditAtCut / slideLayer) via onRollEdit / onSlideLayer.
  const trimDragRef = useRef<{
    mode: "roll" | "slide";
    pointerId: number;
    startClientX: number;
    layerId: string;
    leftLayerId: string; // roll: the pair around the cut; slide: unused ("")
    rightLayerId: string;
    minDelta: number;
    maxDelta: number;
    previewDelta: number;
  } | null>(null);
  const [trimPreview, setTrimPreview] = useState<{ mode: "roll" | "slide"; layerId: string; deltaSeconds: number } | null>(null);
  const timebarRef = useRef<HTMLDivElement | null>(null);
  // The side "add tool" rail sits to the left of the whole timeline-editor column,
  // which also contains the timebar/toolbar + ruler above the tracks. Without this,
  // the rail's icons start flush with the top of the toolbar instead of the first
  // track row, looking detached from the timeline. Measured (not hardcoded) so it
  // stays correct if the toolbar ever wraps to a second line on a narrow viewport.
  const selectedLayerSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);
  const cancelTimelinePan = useCallback(() => {
    panRef.current = null;
    setTimelinePanning(false);
  }, []);
  const cancelDrag = useCallback(() => {
    cancelTimelinePan();
    cancelDragFlush();
    // Undo the imperative move preview — React's diff won't restore styles it never saw change.
    restoreDragPreviewDom();
    setDrag(null);
    slipDragRef.current = null;
    setSlipPreview(null);
    trimDragRef.current = null;
    setTrimPreview(null);
  }, [cancelTimelinePan, cancelDragFlush, restoreDragPreviewDom, setDrag]);
  const cancelResize = useCallback(() => {
    cancelTimelinePan();
    cancelResizeFlush();
    // Undo the imperative preview: React's diff won't restore styles it never saw change.
    const current = resizeRef.current;
    if (current?.clip) {
      current.clip.style.left = current.originalLeft;
      current.clip.style.width = current.originalWidth;
    }
    setResize(null);
  }, [cancelTimelinePan, cancelResizeFlush, setResize]);
  const cancelKeyframeDrag = useCallback(() => {
    cancelTimelinePan();
    setKeyframeDrag(null);
  }, [cancelTimelinePan, setKeyframeDrag]);

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

    // 24 = dock left padding (12) + editor right padding (10) + slack; the old -66 also budgeted
    // the removed 42px side-tools rail and left a dead square right of the toolbar.
    const updateToolbarWidth = () => setToolbarViewportWidth(Math.max(360, timelineDock.clientWidth - 24));
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
  const layerPreview = useMemo<Record<string, { startSeconds?: number; durationSeconds?: number; verticalOffsetPx?: number }>>(() => {
    if (drag) {
      return Object.fromEntries(
        drag.movedLayerIds.map((layerId) => [
          layerId,
          {
            startSeconds: drag.previewStartByLayerId[layerId] ?? 0,
            verticalOffsetPx: drag.previewVerticalOffsetByLayerId[layerId] ?? 0
          }
        ])
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
    if (!playhead || (isPlaying && playbackStart)) {
      return;
    }

    // Paused/scrubbing playhead is CLOCK-DRIVEN, not prop-driven: every seek path (ruler click,
    // scrub move, J/K/L, frame-step) pushes the clock store synchronously, while the `currentTime`
    // prop only arrives on EditorPage's deferred cold commit. Subscribing here moves the playhead
    // instantly with ZERO React renders per seek — before this, every scrub pointermove re-rendered
    // the entire editor tree just to move this one element (2026-07-04 __rfRenderCost capture).
    const position = (timeSeconds: number, seekIntoView: boolean) => {
      playhead.style.setProperty("--playhead-percent", playheadOffsetPercent(timeSeconds, timelineDurationSeconds));
      const liveProxyBar = liveProxyBarRef.current;
      if (liveProxyBar) {
        liveProxyBar.style.display = "none";
        liveProxyBar.style.setProperty("--proxy-start-percent", "0%");
        liveProxyBar.style.setProperty("--proxy-width-percent", "0%");
      }
      if (!seekIntoView) {
        return;
      }

      // Seek-into-view: a paused seek that lands OFFSCREEN (Home/End, frame-step past the edge, a click
      // elsewhere) scrolls the dock so the playhead is visible again — before this, pressing Home while
      // the view was scrolled right left the playhead invisible at t=0. Only fires when the playhead is
      // actually outside the visible lane range (the sticky label rail hides the first
      // `laneOffset - scrollLeft` px), so ordinary on-screen seeks never yank the view; playback has its
      // own pinned follow above, and scrubbing is excluded (the user is steering the view themselves).
      const timelineDock = editorRef.current?.closest(".editor-timeline-dock");
      if (timelineDock instanceof HTMLElement) {
        measureFollowGeom(); // discrete event (not per-frame) — a fresh snapshot is cheap and always right
        const geom = followGeomRef.current;
        if (geom && geom.clientWidth > 0) {
          const frac = clamp(timeSeconds, 0, timelineDurationSeconds) / Math.max(0.001, timelineDurationSeconds);
          const playheadContentX = geom.laneOffset + frac * geom.laneWidth;
          const viewportX = playheadContentX - timelineDock.scrollLeft;
          if (viewportX < geom.laneOffset + 4 || viewportX > geom.clientWidth - 4) {
            // Land the playhead ~30% in from the left — room to read what comes next (Premiere feel).
            timelineDock.scrollLeft = clamp(playheadContentX - geom.clientWidth * 0.3, 0, geom.maxScroll);
          }
        }
      }
    };

    position(getPlaybackClock(), !scrub);
    return subscribePlaybackClock(() => position(getPlaybackClock(), !scrub));
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

  const startTimelinePan = useCallback((event: PointerEvent<HTMLElement>, frame: HTMLElement | null) => {
    if (event.button !== 0 || !(frame instanceof HTMLElement)) {
      return false;
    }

    const scrollElement = frame.closest(".editor-timeline-dock");
    const target = scrollElement instanceof HTMLElement ? scrollElement : frame;
    event.preventDefault();
    event.stopPropagation();
    frame.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      scrollElement: target,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: target.scrollLeft,
      startScrollTop: target.scrollTop
    };
    setTimelinePanning(true);
    return true;
  }, []);

  // Drag/resize handlers below are wrapped in useCallback and read live state
  // through refs (dragRef/resizeRef) rather than closing over the `drag`/`resize`
  // state directly. That keeps their identity stable across the many re-renders
  // a single drag gesture causes (composition/layerMaxDurations/etc. don't change
  // mid-gesture), which lets the memoized TimelineClip below skip re-rendering
  // every other clip on each pointer move instead of just the one being dragged.
  const startDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>, layer: TimelineLayer) => {
      if (toolMode === "hand") {
        startTimelinePan(event, event.currentTarget.closest(".timeline-editor"));
        return;
      }

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
          applyInstantSelectionHighlight([layer.id]);
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

      // Roll/slide tools: the drag accumulates a clamped delta (badge preview only) and the
      // composition mutates once on release — the slip-mode pattern.
      if (toolMode === "roll" || toolMode === "slide") {
        const limitOptions = { maxDurationsSeconds: layerMaxDurations, minDurationSeconds: frameStepSeconds };
        if (toolMode === "roll") {
          // Roll the junction nearest the grab point: (prev|layer) or (layer|next), touching only.
          const ordered = [...(track?.layers ?? [])].sort((a, b) => a.startSeconds - b.startSeconds);
          const index = ordered.findIndex((item) => item.id === layer.id);
          const pointerSeconds = getLaneTime(event.clientX, lane, timelineDurationSeconds, interactionDurationSeconds, true);
          const candidates: Array<{ left: TimelineLayer; right: TimelineLayer; cut: number }> = [];
          const previous = index > 0 ? ordered[index - 1]! : null;
          const next = index < ordered.length - 1 ? ordered[index + 1]! : null;
          if (previous) candidates.push({ left: previous, right: layer, cut: layer.startSeconds });
          if (next) candidates.push({ left: layer, right: next, cut: layer.startSeconds + layer.durationSeconds });
          const nearest = candidates.sort((a, b) => Math.abs(a.cut - pointerSeconds) - Math.abs(b.cut - pointerSeconds))[0];
          const limits = nearest ? rollEditLimits(composition, nearest.left.id, nearest.right.id, limitOptions) : null;
          if (!nearest || !limits) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          trimDragRef.current = {
            mode: "roll",
            pointerId: event.pointerId,
            startClientX: event.clientX,
            layerId: layer.id,
            leftLayerId: nearest.left.id,
            rightLayerId: nearest.right.id,
            minDelta: limits.minDelta,
            maxDelta: limits.maxDelta,
            previewDelta: 0
          };
          setTrimPreview({ mode: "roll", layerId: layer.id, deltaSeconds: 0 });
          return;
        }
        const limits = slideLayerLimits(composition, layer.id, limitOptions);
        if (!limits) return; // slide needs touching neighbours on both sides
        event.currentTarget.setPointerCapture(event.pointerId);
        trimDragRef.current = {
          mode: "slide",
          pointerId: event.pointerId,
          startClientX: event.clientX,
          layerId: layer.id,
          leftLayerId: "",
          rightLayerId: "",
          minDelta: limits.minDelta,
          maxDelta: limits.maxDelta,
          previewDelta: 0
        };
        setTrimPreview({ mode: "slide", layerId: layer.id, deltaSeconds: 0 });
        return;
      }

      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        onSelectLayer(layer.id, resolveSelectMode(event));
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      // Re-commit selection on a plain click unless the clip is part of a genuine multi-selection
      // (length > 1) — that group must stay intact so the drag moves it together (collapse happens on
      // a motionless release in finishDrag). For a single selection we ALWAYS re-commit, even when the
      // clip is already in selectedLayerSet: this matches the resize-handle path (startResize selects
      // unconditionally) and heals the transient desync where a superseded selection transition cleared
      // the imperative `is-selected` highlight while React state still held this clip, making a body
      // click a silent no-op ("can't select the middle, but the ends work; refresh fixes it").
      if (!selectedLayerSet.has(layer.id) || selectedLayerIds.length <= 1) {
        applyInstantSelectionHighlight([layer.id]);
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
      const previewTrackByLayerId = Object.fromEntries(
        movableLayerIds.map((layerId) => {
          const candidate = layerById.get(layerId);
          return [layerId, candidate?.trackId ?? layer.trackId];
        })
      );

      const pointerSeconds = getLaneTime(event.clientX, lane, timelineDurationSeconds, interactionDurationSeconds, true);
      setDrag({
        layerId: layer.id,
        lane,
        pointerId: event.pointerId,
        startClientY: event.clientY,
        offsetSeconds: pointerSeconds - layer.startSeconds,
        movedLayerIds: movableLayerIds,
        baseStartByLayerId,
        baseTrackByLayerId: previewTrackByLayerId,
        previewStartByLayerId: baseStartByLayerId,
        previewTrackByLayerId,
        previewVerticalOffsetByLayerId: Object.fromEntries(movableLayerIds.map((layerId) => [layerId, 0])),
        previewStartSeconds: layer.startSeconds,
        previewTrackId: layer.trackId,
        snappedTo: null
      });
    },
    [composition, toolMode, slipLayerId, layerMaxDurations, frameStepSeconds, selectedLayerSet, selectedLayerIds, applyInstantSelectionHighlight, onSelectLayer, onSplitLayerAt, timelineDurationSeconds, interactionDurationSeconds, setDrag, startTimelinePan]
  );

  const moveDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const pan = panRef.current;
      if (pan && pan.pointerId === event.pointerId) {
        pan.scrollElement.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startClientX);
        pan.scrollElement.scrollTop = pan.startScrollTop - (event.clientY - pan.startClientY);
        return;
      }

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
      const trackPreview = getDragTrackPreview(drag, event.clientY);
      // Ref now, render on the next animation frame (see dragRafRef) — one strip render per frame.
      dragRef.current = {
        ...drag,
        previewStartSeconds: nextStart,
        previewStartByLayerId,
        previewTrackId: trackPreview.previewTrackId,
        previewTrackByLayerId: trackPreview.previewTrackByLayerId,
        previewVerticalOffsetByLayerId: trackPreview.previewVerticalOffsetByLayerId,
        snappedTo: snapped.snappedTo
      };
      if (dragRafRef.current === null) {
        dragRafRef.current = requestAnimationFrame(flushDragPreview);
      }
    },
    [composition, layerMaxDurations, timelineDurationSeconds, interactionDurationSeconds, frameStepSeconds, snapEnabled, currentTime, pixelsPerSecond, markers, flushDragPreview]
  );

  // Roll/slide drags listen on WINDOW while active (not the clip element): the gesture starts on
  // a clip but must keep tracking wherever the pointer goes, without depending on pointer-capture
  // retargeting through the memoized clip tree. Bound only while a trim drag is live.
  useEffect(() => {
    if (!trimPreview) {
      return;
    }
    function handleTrimMove(event: globalThis.PointerEvent) {
      const trim = trimDragRef.current;
      if (!trim || trim.pointerId !== event.pointerId) return;
      const raw = (event.clientX - trim.startClientX) / pixelsPerSecond;
      const nextDelta = clamp(snap(raw, frameStepSeconds), trim.minDelta, trim.maxDelta);
      if (nextDelta !== trim.previewDelta) {
        trim.previewDelta = nextDelta;
        setTrimPreview({ mode: trim.mode, layerId: trim.layerId, deltaSeconds: nextDelta });
      }
    }
    function handleTrimUp(event: globalThis.PointerEvent) {
      const trim = trimDragRef.current;
      if (!trim || trim.pointerId !== event.pointerId) return;
      trimDragRef.current = null;
      setTrimPreview(null);
      if (Math.abs(trim.previewDelta) > 0.0001) {
        if (trim.mode === "roll") {
          onRollEdit?.(trim.leftLayerId, trim.rightLayerId, trim.previewDelta);
        } else {
          onSlideLayer?.(trim.layerId, trim.previewDelta);
        }
      }
    }
    window.addEventListener("pointermove", handleTrimMove);
    window.addEventListener("pointerup", handleTrimUp);
    window.addEventListener("pointercancel", handleTrimUp);
    return () => {
      window.removeEventListener("pointermove", handleTrimMove);
      window.removeEventListener("pointerup", handleTrimUp);
      window.removeEventListener("pointercancel", handleTrimUp);
    };
  }, [trimPreview, pixelsPerSecond, frameStepSeconds, onRollEdit, onSlideLayer]);

  const finishDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (panRef.current && panRef.current.pointerId === event.pointerId) {
        panRef.current = null;
        setTimelinePanning(false);
        return;
      }

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

      if (dragChangedAnything(drag)) {
        onMoveLayer(
          drag.layerId,
          drag.previewStartSeconds,
          drag.previewTrackId,
          drag.movedLayerIds.length > 1 ? drag.movedLayerIds : undefined,
          drag.movedLayerIds.length > 1 ? drag.previewTrackByLayerId : undefined
        );
      } else if (drag.movedLayerIds.length > 1) {
        // Motionless click on a clip that was part of a MULTI-selection → collapse to just that clip
        // (Premiere/Resolve behavior). On pointerdown we keep the whole group selected so a real drag
        // can move them together; a click that never moved should focus the clicked clip so the
        // Inspector shows it. This commits NO move — it only narrows the selection (respects the
        // no-op-click guard: `dragChangedAnything` was false here).
        applyInstantSelectionHighlight([drag.layerId]);
        onSelectLayer(drag.layerId, "replace");
      }
      settleDragPreviewForCommit();
      setDrag(null);
    },
    [onMoveLayer, onSlipLayer, onRollEdit, onSlideLayer, settleDragPreviewForCommit, dragChangedAnything, setDrag, applyInstantSelectionHighlight, onSelectLayer]
  );

  // STUCK-DRAG SAFETY NET (2026-07-03 user report: a clip chased the mouse and could not be
  // dropped). The clip-move lifecycle is element-bound behind setPointerCapture; if the browser
  // drops that capture mid-drag (element remount, OS-level loss), the element's pointerup never
  // fires — while every clip the pointer passes over still processes moveDrag for the same
  // persistent mouse pointerId, so the clip follows the pointer forever with no way to release.
  // While a clip drag is live, terminal events are ALSO handled at the window: pointerup COMMITS
  // (a release means drop-here), pointercancel and Escape CANCEL (clip returns to its origin).
  // The normal element path runs first and clears the state, making these no-ops.
  const dragActive = drag !== null;
  useEffect(() => {
    if (!dragActive) return undefined;
    const commitFromWindow = (event: globalThis.PointerEvent) => {
      const active = dragRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      if (dragChangedAnything(active)) {
        onMoveLayer(
          active.layerId,
          active.previewStartSeconds,
          active.previewTrackId,
          active.movedLayerIds.length > 1 ? active.movedLayerIds : undefined,
          active.movedLayerIds.length > 1 ? active.previewTrackByLayerId : undefined
        );
      }
      settleDragPreviewForCommit();
      setDrag(null);
    };
    const cancelFromWindow = (event: globalThis.PointerEvent) => {
      const active = dragRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      cancelDragFlush();
      restoreDragPreviewDom();
      setDrag(null);
    };
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current) return;
      event.stopPropagation();
      cancelDragFlush();
      restoreDragPreviewDom();
      setDrag(null);
    };
    window.addEventListener("pointerup", commitFromWindow);
    window.addEventListener("pointercancel", cancelFromWindow);
    window.addEventListener("keydown", cancelOnEscape, true);
    return () => {
      window.removeEventListener("pointerup", commitFromWindow);
      window.removeEventListener("pointercancel", cancelFromWindow);
      window.removeEventListener("keydown", cancelOnEscape, true);
    };
  }, [dragActive, onMoveLayer, cancelDragFlush, settleDragPreviewForCommit, restoreDragPreviewDom, dragChangedAnything, setDrag]);

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
      if (toolMode === "hand") {
        startTimelinePan(event, event.currentTarget.closest(".timeline-editor"));
        return;
      }

      event.stopPropagation();
      const lane = event.currentTarget.closest(".timeline-lane");
      const track = composition.tracks.find((item) => item.id === layer.trackId);
      if (!(lane instanceof HTMLDivElement) || layer.locked || track?.locked) {
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      applyInstantSelectionHighlight([layer.id]);
      onSelectLayer(layer.id);
      const clip = event.currentTarget.closest<HTMLElement>(".timeline-clip");
      setResize({
        edge,
        layerId: layer.id,
        lane,
        clip,
        originalLeft: clip?.style.left ?? "",
        originalWidth: clip?.style.width ?? "",
        baseStartSeconds: layer.startSeconds,
        baseDurationSeconds: layer.durationSeconds,
        pointerId: event.pointerId,
        previewStartSeconds: layer.startSeconds,
        previewDurationSeconds: layer.durationSeconds,
        snappedTo: null
      });
    },
    [composition, applyInstantSelectionHighlight, onSelectLayer, setResize, startTimelinePan, toolMode]
  );

  const moveResize = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      const pan = panRef.current;
      if (pan && pan.pointerId === event.pointerId) {
        pan.scrollElement.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startClientX);
        pan.scrollElement.scrollTop = pan.startScrollTop - (event.clientY - pan.startClientY);
        return;
      }

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
      // Write the preview to the ref synchronously, render it on the next animation frame (see
      // resizeRafRef above) — never more than one strip re-render per frame while trimming.
      if (resize.edge === "start") {
        const maxStart = layer.startSeconds + layer.durationSeconds - frameStepSeconds;
        const minStart = Math.max(0, layer.startSeconds + layer.durationSeconds - maxDuration);
        const nextStart = clamp(pointerSeconds, minStart, maxStart);
        resizeRef.current = {
          ...resize,
          previewStartSeconds: nextStart,
          previewDurationSeconds: layer.durationSeconds + (layer.startSeconds - nextStart),
          snappedTo: snapped.snappedTo
        };
      } else {
        resizeRef.current = {
          ...resize,
          previewDurationSeconds: clamp(pointerSeconds - layer.startSeconds, frameStepSeconds, maxDuration),
          snappedTo: snapped.snappedTo
        };
      }
      if (resizeRafRef.current === null) {
        resizeRafRef.current = requestAnimationFrame(flushResizePreview);
      }
    },
    [composition, layerMaxDurations, timelineDurationSeconds, interactionDurationSeconds, snapEnabled, currentTime, pixelsPerSecond, markers, flushResizePreview]
  );

  const finishResize = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      if (panRef.current && panRef.current.pointerId === event.pointerId) {
        panRef.current = null;
        setTimelinePanning(false);
        return;
      }

      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }

      // The ref holds the final (possibly un-flushed) preview: cancel the pending rAF and paint it
      // NOW, so the DOM matches the committed values even when the commit is a vdom no-op (e.g. the
      // user dragged back to the original position — React would skip the style write).
      cancelResizeFlush();
      flushResizePreview();
      // No-op guard: grabbing a handle and releasing without moving must not commit a phantom edit
      // (new composition identity → full-tree render + memo invalidation + undo snapshot + autosave).
      if (
        Math.abs(resize.previewStartSeconds - resize.baseStartSeconds) > 1e-6 ||
        Math.abs(resize.previewDurationSeconds - resize.baseDurationSeconds) > 1e-6
      ) {
        onResizeLayer(resize.layerId, resize.previewStartSeconds, resize.previewDurationSeconds);
      }
      setResize(null);
    },
    [onResizeLayer, setResize, cancelResizeFlush, flushResizePreview]
  );

  function startScrub(event: PointerEvent<HTMLDivElement>) {
    // Hand tool: drag anywhere to pan the timeline freely, including over clips.
    if (toolMode === "hand" && event.button === 0) {
      startTimelinePan(event, event.currentTarget);
      return;
    }

    if (event.target instanceof HTMLElement && event.target.closest(".timeline-clip")) {
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
      panRef.current.scrollElement.scrollLeft = panRef.current.startScrollLeft - (event.clientX - panRef.current.startClientX);
      panRef.current.scrollElement.scrollTop = panRef.current.startScrollTop - (event.clientY - panRef.current.startClientY);
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
      setTimelinePanning(false);
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
      if (toolMode === "hand") {
        startTimelinePan(event, event.currentTarget.closest(".timeline-editor"));
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const clip = event.currentTarget.closest(".timeline-clip");
      if (!(clip instanceof HTMLDivElement) || layer.locked) {
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      setSelectedKeyframeId(keyframe.id);
      applyInstantSelectionHighlight([layer.id]);
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
    [applyInstantSelectionHighlight, onSelectLayer, onChangeCurrentTime, setKeyframeDrag, startTimelinePan, toolMode]
  );

  const moveKeyframeDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const pan = panRef.current;
      if (pan && pan.pointerId === event.pointerId) {
        pan.scrollElement.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startClientX);
        pan.scrollElement.scrollTop = pan.startScrollTop - (event.clientY - pan.startClientY);
        return;
      }

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
      if (panRef.current && panRef.current.pointerId === event.pointerId) {
        panRef.current = null;
        setTimelinePanning(false);
        return;
      }

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
      if (toolMode === "hand") {
        startTimelinePan(event, event.currentTarget.closest(".timeline-editor"));
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const clip = event.currentTarget.closest(".timeline-clip");
      if (!(clip instanceof HTMLDivElement) || layer.locked) {
        return;
      }
      // NO setPointerCapture here: the create-dot span unmounts on the first move (it renders
      // only while its side has no fade), which silently released the capture and dropped both
      // the move stream and the pointerup — fades froze mid-drag or kept following an unclicked
      // cursor. The drag listens on WINDOW instead (effect below), like the roll/slide trims.
      applyInstantSelectionHighlight([layer.id]);
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
    [applyInstantSelectionHighlight, onSelectLayer, setTransitionDrag, startTimelinePan, toolMode]
  );

  const moveTransitionDrag = useCallback(
    (event: { pointerId: number; clientX: number }) => {
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
    (event: { pointerId: number }) => {
      const drag = transitionDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      onSetTransition(drag.layerId, drag.side, drag.previewDurationSeconds);
      setTransitionDrag(null);
    },
    [onSetTransition, setTransitionDrag]
  );

  // Fade drags listen on WINDOW while active — the create-dot span that starts the gesture
  // unmounts on the first move (its side gains a fade), so element-level pointer capture broke
  // the move stream AND swallowed the pointerup: fades froze mid-drag, or the leaked drag kept
  // following the unclicked cursor over the band (same mouse pointerId). Window listeners
  // survive any re-render/unmount; same pattern as the roll/slide trim drags above.
  const transitionDragActive = transitionDrag !== null;
  useEffect(() => {
    if (!transitionDragActive) {
      return;
    }
    const handleMove = (event: globalThis.PointerEvent) => moveTransitionDrag(event);
    const handleUp = (event: globalThis.PointerEvent) => finishTransitionDrag(event);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [transitionDragActive, moveTransitionDrag, finishTransitionDrag]);

  // Cross-dissolve junction drag — the left clip's end stays anchored; the overlap duration `D`
  // shrinks as the pointer moves right (the left edge of the element follows). Commits on release.
  const startCrossDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>, junction: TimelineJunction) => {
      if (toolMode === "hand") {
        startTimelinePan(event, event.currentTarget.closest(".timeline-editor"));
        return;
      }

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
    [setCrossDrag, timelineDurationSeconds, interactionDurationSeconds, startTimelinePan, toolMode]
  );

  const moveCrossDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const pan = panRef.current;
      if (pan && pan.pointerId === event.pointerId) {
        pan.scrollElement.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startClientX);
        pan.scrollElement.scrollTop = pan.startScrollTop - (event.clientY - pan.startClientY);
        return;
      }

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
      if (panRef.current && panRef.current.pointerId === event.pointerId) {
        panRef.current = null;
        setTimelinePanning(false);
        return;
      }

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

  const cancelCrossDrag = useCallback(() => {
    cancelTimelinePan();
    setCrossDrag(null);
  }, [cancelTimelinePan, setCrossDrag]);

  const fitZoom = useCallback(() => {
    const viewport = editorRef.current?.clientWidth ?? 0;
    const usable = Math.max(120, viewport - laneOffsetPx - 24);
    // Fit to the ACTUAL content end (last clip out-point), not interactionDurationSeconds — that
    // one counts every clip's untrimmed source length (trim headroom), so a 3s clip cut from a
    // 9-minute asset made Fit zoom for 9 minutes and never visibly squeeze. Floor of 2px/s (was
    // 24) so genuinely long edits can still fully fit in view.
    const contentEnd = Math.max(
      1,
      ...composition.tracks.flatMap((track) => track.layers.map((layer) => layer.startSeconds + layer.durationSeconds))
    );
    const next = clamp(usable / contentEnd, 2, 480);
    pixelsPerSecondRef.current = next;
    setPixelsPerSecond(next);
  }, [laneOffsetPx, composition]);

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
        case "r":
          event.preventDefault();
          onChangeToolMode?.("roll");
          return;
        case "u":
          event.preventDefault();
          onChangeToolMode?.("slide");
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
          // ⇧M belongs to the mask-add shortcut and ⌥M to the AI voice-dictation shortcut (both in
          // EditorPage) — plain M is the marker toggle.
          if (event.shiftKey || event.altKey) return;
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

  function getDragTrackPreview(dragState: NonNullable<DragState>, clientY: number) {
    const draggedLayer = composition.tracks.flatMap((track) => track.layers).find((item) => item.id === dragState.layerId);
    if (!draggedLayer) {
      return {
        previewTrackId: dragState.previewTrackId,
        previewTrackByLayerId: dragState.previewTrackByLayerId,
        previewVerticalOffsetByLayerId: dragState.previewVerticalOffsetByLayerId
      };
    }

    const rowPitchPx = trackHeight + 6;
    const tracksByAudioKind = (isAudio: boolean) => composition.tracks.filter((track) => (track.type === "audio") === isAudio);
    const draggedCompatibleTracks = tracksByAudioKind(draggedLayer.type === "audio");
    const baseFamilyIndex = draggedCompatibleTracks.findIndex((track) => track.id === draggedLayer.trackId);
    if (baseFamilyIndex === -1) {
      return {
        previewTrackId: dragState.previewTrackId,
        previewTrackByLayerId: dragState.previewTrackByLayerId,
        previewVerticalOffsetByLayerId: dragState.previewVerticalOffsetByLayerId
      };
    }

    const rawFamilyDelta = Math.round((clientY - dragState.startClientY) / rowPitchPx);
    const familyDelta = clamp(rawFamilyDelta, -baseFamilyIndex, draggedCompatibleTracks.length - 1 - baseFamilyIndex);
    const visualDeltaPx = clamp(clientY - dragState.startClientY, -baseFamilyIndex * rowPitchPx, (draggedCompatibleTracks.length - 1 - baseFamilyIndex) * rowPitchPx);
    const layerById = new Map(composition.tracks.flatMap((track) => track.layers).map((item) => [item.id, item]));
    const previewTrackByLayerId: Record<string, string> = {};
    const previewVerticalOffsetByLayerId: Record<string, number> = {};
    for (const layerId of dragState.movedLayerIds) {
      const candidate = layerById.get(layerId);
      if (!candidate) {
        continue;
      }
      const compatibleTracks = tracksByAudioKind(candidate.type === "audio");
      const candidateFamilyIndex = compatibleTracks.findIndex((track) => track.id === candidate.trackId);
      if (candidateFamilyIndex === -1) {
        continue;
      }
      const targetFamilyIndex = clamp(candidateFamilyIndex + familyDelta, 0, compatibleTracks.length - 1);
      const targetTrack = compatibleTracks[targetFamilyIndex] ?? compatibleTracks[candidateFamilyIndex];
      if (!targetTrack || targetTrack.locked || targetTrack.type === "audio" !== (candidate.type === "audio")) {
        previewTrackByLayerId[layerId] = candidate.trackId;
        previewVerticalOffsetByLayerId[layerId] = 0;
        continue;
      }
      previewTrackByLayerId[layerId] = targetTrack.id;
      const maxUpPx = candidateFamilyIndex * rowPitchPx;
      const maxDownPx = (compatibleTracks.length - 1 - candidateFamilyIndex) * rowPitchPx;
      previewVerticalOffsetByLayerId[layerId] = clamp(visualDeltaPx, -maxUpPx, maxDownPx);
    }

    const previewTrack = draggedCompatibleTracks[baseFamilyIndex + familyDelta] ?? draggedCompatibleTracks[baseFamilyIndex];
    return {
      previewTrackId: previewTrack && !previewTrack.locked ? previewTrack.id : draggedLayer.trackId,
      previewTrackByLayerId,
      previewVerticalOffsetByLayerId
    };
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
    setMobileTrackMenu(null);
    setTrackContextMenu({ x: event.clientX, y: event.clientY, timeSeconds });
  }

  function isPhoneTrackRail(element: HTMLElement) {
    const layout = element.closest(".editor-layout");
    return layout instanceof HTMLElement && layout.dataset.editorMode === "phone";
  }

  function handleMobileTrackMenuOpen(event: ReactMouseEvent<HTMLDivElement>, trackId: string, label: string) {
    if (!isPhoneTrackRail(event.currentTarget)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 232;
    const menuHeight = 330;
    setTrackContextMenu(null);
    setClipContextMenu(null);
    setMobileTrackMenu({
      trackId,
      label,
      x: Math.max(8, Math.min(rect.right + 8, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.top, window.innerHeight - menuHeight - 8))
    });
  }

  function getTrackReorderTarget(trackId: string, direction: -1 | 1) {
    const track = composition.tracks.find((item) => item.id === trackId);
    if (!track) return null;
    const compatibleTracks = composition.tracks.filter((item) => item.type === track.type);
    const index = compatibleTracks.findIndex((item) => item.id === trackId);
    return index === -1 ? null : compatibleTracks[index + direction] ?? null;
  }

  function moveTrackFromMenu(trackId: string, direction: -1 | 1) {
    const target = getTrackReorderTarget(trackId, direction);
    if (!target) return;
    onReorderTrack?.(trackId, target.id, direction < 0 ? "before" : "after");
    setMobileTrackMenu(null);
  }

  function canDropTrackOnTarget(sourceTrackId: string, targetTrackId: string) {
    if (sourceTrackId === targetTrackId) return false;
    const source = composition.tracks.find((track) => track.id === sourceTrackId);
    const target = composition.tracks.find((track) => track.id === targetTrackId);
    if (!source || !target) return false;
    return (source.type === "audio") === (target.type === "audio");
  }

  function trackDropPlacement(event: DragEvent<HTMLElement>): "before" | "after" {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  function handleTrackDragOver(event: DragEvent<HTMLElement>, targetTrackId: string) {
    const sourceTrackId = trackDrag?.trackId || event.dataTransfer.getData("application/x-lumio-track");
    if (!sourceTrackId || !canDropTrackOnTarget(sourceTrackId, targetTrackId)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setTrackDrag({ trackId: sourceTrackId, targetTrackId, placement: trackDropPlacement(event) });
  }

  function handleTrackDrop(event: DragEvent<HTMLElement>, targetTrackId: string) {
    const sourceTrackId = event.dataTransfer.getData("application/x-lumio-track") || trackDrag?.trackId;
    const placement = trackDropPlacement(event);
    setTrackDrag(null);
    if (!sourceTrackId || !canDropTrackOnTarget(sourceTrackId, targetTrackId)) {
      return;
    }
    event.preventDefault();
    onReorderTrack?.(sourceTrackId, targetTrackId, placement);
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
      setMobileTrackMenu(null);
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
      <div
        className={`timeline-editor scroll-performance-pane ${
          trackHeight <= 30 ? "is-xs-rows" : trackHeight <= 42 ? "is-s-rows" : trackHeight <= 60 ? "is-m-rows" : "is-l-rows"
        } ${toolMode === "hand" ? "is-hand-tool" : ""} ${timelinePanning ? "is-panning" : ""}`}
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
          panRef.current = null;
          setTimelinePanning(false);
          setScrub(null);
          setMarquee(null);
        }}
      >
        <div className="timeline-timebar" ref={timebarRef} style={toolbarViewportWidth ? { width: `${toolbarViewportWidth}px` } : undefined}>
          <TimebarClock fallback={currentTime} />
          {/* Add-layer tools live IN the header row (was a vertical left rail) — frees the full
              width for track menus and keeps every timeline control on one clean line. */}
          <div className="timeline-side-tools" aria-label="Timeline add tools" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <button type="button" title="Add text" onClick={() => onAddLayer("text")}>
              <Type size={15} />
            </button>
            <button type="button" title="Add image" onClick={() => onAddLayer("image")}>
              <Image size={15} />
            </button>
            <div className="timeline-shape-tool">
              <button
                type="button"
                className="timeline-shape-repeat-button"
                title={`Add ${currentShapeTool.name}`}
                aria-label={`Add ${currentShapeTool.name}`}
                onClick={() => onAddLayer("shape", currentShapeTool)}
              >
                {shapeToolIcon(currentShapeTool.shapeKind, currentShapeTool.name)}
              </button>
              <ThemedSelect<ShapeToolValue>
                className="timeline-shape-select"
                value={lastShapeTool}
                options={shapeSelectOptions}
                iconOnly
                ariaLabel="Choose shape tool"
                menuMinWidth={190}
                onChange={(value) => {
                  const option = SHAPE_TOOL_OPTIONS.find((item) => item.value === value) ?? SHAPE_TOOL_OPTIONS[0]!;
                  setLastShapeTool(value);
                  onAddLayer("shape", option);
                }}
              />
            </div>
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
              <button type="button" className={toolMode === "hand" ? "is-active" : ""} title="Hand — drag to pan (H)" onClick={() => onChangeToolMode?.("hand")}>
                <Hand size={13} />
              </button>
              <button type="button" className={toolMode === "blade" ? "is-active" : ""} title="Blade — click a clip to split (C)" onClick={() => onChangeToolMode?.("blade")}>
                <Scissors size={13} />
              </button>
              <button type="button" className={toolMode === "roll" ? "is-active" : ""} title="Roll edit — drag near a cut to move it (R)" onClick={() => onChangeToolMode?.("roll")}>
                <UnfoldHorizontal size={13} />
              </button>
              <button type="button" className={toolMode === "slide" ? "is-active" : ""} title="Slide — drag a clip between its neighbours (U)" onClick={() => onChangeToolMode?.("slide")}>
                <MoveHorizontal size={13} />
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
              <button type="button" className={trackHeight <= 30 ? "is-active" : ""} title="Extra compact tracks" onClick={() => onChangeTrackHeight(28)}>
                XS
              </button>
              <button type="button" className={trackHeight > 30 && trackHeight <= 42 ? "is-active" : ""} title="Compact tracks" onClick={() => onChangeTrackHeight(36)}>
                S
              </button>
              <button type="button" className={trackHeight > 42 && trackHeight <= 60 ? "is-active" : ""} title="Normal tracks" onClick={() => onChangeTrackHeight(44)}>
                M
              </button>
              <button type="button" className={trackHeight > 60 ? "is-active" : ""} title="Tall tracks" onClick={() => onChangeTrackHeight(68)}>
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
              key={`${mark.timeSeconds}-${mark.endpoint ? "end" : "tick"}`}
              className={mark.endpoint ? "timeline-ruler-tick is-end" : "timeline-ruler-tick"}
              style={{ "--ruler-mark-percent": playheadOffsetPercent(mark.timeSeconds, composition.durationSeconds) } as CSSProperties & Record<"--ruler-mark-percent", string>}
            >
              {formatRulerTime(mark.timeSeconds)}
            </span>
          ))}
          {markers.map((marker) => (
            <button
              className="timeline-ruler-marker"
              key={marker.timeSeconds}
              title={`${marker.name ? `"${marker.name}" ` : "Marker "}at ${marker.timeSeconds.toFixed(2)}s — click to seek, double-click to remove, right-click to rename/recolor`}
              type="button"
              style={
                {
                  "--ruler-mark-percent": playheadOffsetPercent(marker.timeSeconds, composition.durationSeconds),
                  ...(marker.color ? { "--marker-color": marker.color } : {})
                } as CSSProperties & Record<"--ruler-mark-percent", string>
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onChangeCurrentTime(marker.timeSeconds);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onRemoveMarker?.(marker.timeSeconds);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMarkerEditor({ timeSeconds: marker.timeSeconds, name: marker.name ?? "" });
              }}
            >
              <Flag size={10} />
              {marker.name ? <span className="timeline-ruler-marker-label">{marker.name}</span> : null}
            </button>
          ))}
          {markerEditor
            ? (() => {
                const editing = markers.find((m) => m.timeSeconds === markerEditor.timeSeconds);
                if (!editing) return null;
                return (
                  <div
                    className="timeline-marker-editor"
                    style={{ "--ruler-mark-percent": playheadOffsetPercent(editing.timeSeconds, composition.durationSeconds) } as CSSProperties & Record<"--ruler-mark-percent", string>}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      autoFocus
                      placeholder="Marker name…"
                      value={markerEditor.name}
                      onChange={(event) => setMarkerEditor({ ...markerEditor, name: event.target.value })}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          onUpdateMarker?.(editing.timeSeconds, { name: markerEditor.name.trim() || undefined });
                          setMarkerEditor(null);
                        }
                        if (event.key === "Escape") setMarkerEditor(null);
                      }}
                    />
                    <div className="timeline-marker-editor-swatches">
                      {TIMELINE_MARKER_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={`timeline-marker-swatch${(editing.color ?? TIMELINE_MARKER_COLORS[0]) === color ? " is-active" : ""}`}
                          style={{ background: color }}
                          title={color}
                          onClick={() => onUpdateMarker?.(editing.timeSeconds, { color })}
                        />
                      ))}
                    </div>
                    <div className="timeline-marker-editor-actions">
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() => {
                          onUpdateMarker?.(editing.timeSeconds, { name: markerEditor.name.trim() || undefined });
                          setMarkerEditor(null);
                        }}
                      >
                        Done
                      </button>
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() => {
                          onRemoveMarker?.(editing.timeSeconds);
                          setMarkerEditor(null);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })()
            : null}
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
          {activeSnapSeconds !== null || resize || drag ? (
            // Mounted (hidden) for the whole resize/move gesture: gesture previews drive it
            // imperatively via snapGuideRef — there are no React renders mid-gesture to show it with.
            <div
              className="timeline-snap-guide"
              ref={snapGuideRef}
              style={{
                display: activeSnapSeconds === null ? "none" : undefined,
                ...( { "--playhead-percent": playheadOffsetPercent(activeSnapSeconds ?? 0, timelineDurationSeconds) } as Record<"--playhead-percent", string>)
              } as CSSProperties}
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
          {composition.tracks.map((track, trackIndex) => {
            const { junctions, junctionLeftIds, junctionRightIds } = junctionsByTrackId.get(track.id) ?? EMPTY_TRACK_JUNCTIONS;
            const mobileTrackNumber = composition.tracks.slice(0, trackIndex + 1).filter((item) => item.type === track.type).length;
            const mobileTrackLabel = `${track.type === "audio" ? "A" : "V"}${mobileTrackNumber}`;
            return (
            <div className="timeline-track" key={track.id}>
              <div
                className={`timeline-track-label ${trackDrag?.trackId === track.id ? "is-track-dragging" : ""} ${trackDrag?.targetTrackId === track.id ? `is-track-drop-${trackDrag.placement}` : ""}`}
                data-mobile-label={mobileTrackLabel}
                onPointerDown={(event) => {
                  if (isPhoneTrackRail(event.currentTarget)) {
                    event.stopPropagation();
                  }
                }}
                onClick={(event) => handleMobileTrackMenuOpen(event, track.id, mobileTrackLabel)}
                onDragOver={(event) => handleTrackDragOver(event, track.id)}
                onDragLeave={() => setTrackDrag((current) => (current?.targetTrackId === track.id ? { ...current, targetTrackId: null } : current))}
                onDrop={(event) => handleTrackDrop(event, track.id)}
              >
                <div className="track-label-main">
                  <button
                    type="button"
                    className="track-reorder-handle"
                    draggable
                    title="Drag to reorder track"
                    aria-label={`Reorder ${track.name}`}
                    onDragStart={(event) => {
                      event.stopPropagation();
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-lumio-track", track.id);
                      setTrackDrag({ trackId: track.id, targetTrackId: null, placement: "before" });
                    }}
                    onDragEnd={() => setTrackDrag(null)}
                  >
                    <GripVertical size={13} />
                  </button>
                  <div className="track-label-text">
                    <strong>{track.name}</strong>
                    <span>{track.type === "audio" ? "audio" : "visual"}</span>
                  </div>
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
                  onDropAsset(assetId, track.id, getDropTime(event), undefined, readSourceDragPayload(event));
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
                      clipNumber={clipOrdinals.get(layer.id)?.ordinal}
                      durationSeconds={preview?.durationSeconds ?? layer.durationSeconds}
                      draggingKeyframeId={draggingKeyframe?.keyframeId ?? null}
                      draggingKeyframePreviewTime={draggingKeyframe?.previewTimeSeconds ?? null}
                      isDragging={drag?.movedLayerIds.includes(layer.id) ?? false}
                      isEffectDropTarget={effectDropTargetLayerId === layer.id}
                      isSelected={isSelected}
                      isSelectedForKeyframes={isLayerSelectedForKeyframes}
                      isSlipping={slipLayerId === layer.id}
                      slipPreviewSourceInSeconds={slipPreview?.layerId === layer.id ? slipPreview.sourceInSeconds : null}
                      trimPreview={trimPreview?.layerId === layer.id ? { mode: trimPreview.mode, deltaSeconds: trimPreview.deltaSeconds } : null}
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
                      verticalOffsetPx={preview?.verticalOffsetPx ?? 0}
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
      {mobileTrackMenu
        ? (() => {
            const track = composition.tracks.find((item) => item.id === mobileTrackMenu.trackId);
            if (!track) return null;
            const moveBefore = getTrackReorderTarget(track.id, -1);
            const moveAfter = getTrackReorderTarget(track.id, 1);
            return (
              <div
                className="timeline-context-backdrop"
                onClick={() => setMobileTrackMenu(null)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMobileTrackMenu(null);
                }}
              >
                <div
                  className="timeline-context-menu timeline-mobile-track-menu"
                  style={{ left: `${mobileTrackMenu.x}px`, top: `${mobileTrackMenu.y}px` }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <span className="timeline-context-menu-label">
                    {mobileTrackMenu.label} · {track.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onToggleTrack(track.id, { locked: !track.locked });
                      setMobileTrackMenu(null);
                    }}
                  >
                    {track.locked ? <Unlock size={14} /> : <Lock size={14} />}
                    {track.locked ? "Unlock track" : "Lock track"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onToggleTrack(track.id, { muted: !track.muted });
                      setMobileTrackMenu(null);
                    }}
                  >
                    {track.type === "audio" ? track.muted ? <Volume2 size={14} /> : <VolumeX size={14} /> : track.muted ? <Eye size={14} /> : <EyeOff size={14} />}
                    {track.type === "audio" ? (track.muted ? "Unmute track" : "Mute track") : track.muted ? "Show track" : "Hide track"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onToggleTrack(track.id, { solo: !track.solo });
                      setMobileTrackMenu(null);
                    }}
                  >
                    <span aria-hidden="true">S</span>
                    {track.solo ? "Unsolo track" : "Solo track"}
                  </button>
                  <span className="timeline-context-menu-divider" />
                  <button type="button" disabled={!moveBefore} onClick={() => moveTrackFromMenu(track.id, -1)}>
                    <ChevronLeft size={14} />
                    Move track up
                  </button>
                  <button type="button" disabled={!moveAfter} onClick={() => moveTrackFromMenu(track.id, 1)}>
                    <ChevronRight size={14} />
                    Move track down
                  </button>
                  <span className="timeline-context-menu-divider" />
                  <button
                    type="button"
                    className="timeline-context-menu-danger"
                    onClick={() => {
                      onDeleteTrack(track.id);
                      setMobileTrackMenu(null);
                    }}
                  >
                    <Trash2 size={14} />
                    Delete track
                  </button>
                </div>
              </div>
            );
          })()
        : null}
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
            {onSetLayerLabel
              ? (() => {
                  const contextLayer = composition.tracks.flatMap((track) => track.layers).find((item) => item.id === clipContextMenu.layerId);
                  const activeLabel = contextLayer ? layerLabelOf(contextLayer, assets) : null;
                  return (
                    <>
                      <span className="timeline-context-menu-divider" />
                      <span className="timeline-context-menu-label">Label color</span>
                      <div className="asset-label-swatches timeline-clip-label-swatches" role="group" aria-label="Clip label color">
                        {Object.entries(ASSET_LABEL_COLORS).map(([name, color]) => (
                          <button
                            key={name}
                            type="button"
                            className={activeLabel === name ? "is-active" : ""}
                            style={{ background: color }}
                            title={`Label: ${name}`}
                            onClick={() => {
                              onSetLayerLabel(clipContextMenu.layerId, name);
                              setClipContextMenu(null);
                            }}
                          />
                        ))}
                        <button
                          type="button"
                          className="asset-label-clear"
                          title="Clear label (inherit from asset)"
                          onClick={() => {
                            onSetLayerLabel(clipContextMenu.layerId, null);
                            setClipContextMenu(null);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </>
                  );
                })()
              : null}
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
  verticalOffsetPx: number;
  isSelected: boolean;
  isDragging: boolean;
  isEffectDropTarget: boolean;
  isSelectedForKeyframes: boolean;
  isSlipping: boolean;
  slipPreviewSourceInSeconds: number | null;
  trimPreview: { mode: "roll" | "slide"; deltaSeconds: number } | null;
  selectedClipKeyframeId: string | null;
  draggingKeyframeId: string | null;
  draggingKeyframePreviewTime: number | null;
  assets: SourceAsset[];
  /** Positional clip number ("clip N") for the badge, so users (and voice/AI) can name this clip. */
  clipNumber?: number | undefined;
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
  onDropAsset: DropAssetHandler;
  onDropTimelineEffect: (effectType: TimelineEffectType, layerId: string) => void;
  onDeleteLayer: (layerId: string) => void;
  onDeleteKeyframe: (layerId: string, keyframeId: string) => void;
  onChangeCurrentTime: (timeSeconds: number) => void;
  onStartKeyframeDrag: (event: PointerEvent<HTMLButtonElement>, layer: TimelineLayer, keyframe: TimelineKeyframeV2) => void;
  onMoveKeyframeDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onFinishKeyframeDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onCancelKeyframeDrag: () => void;
  // Fade drags: only the START is element-bound; move/up/cancel live on window while the drag
  // is active (the create dot unmounts mid-gesture, so element handlers can't be trusted).
  onStartTransitionDrag: (event: PointerEvent<HTMLSpanElement>, layer: TimelineLayer, side: "fadeIn" | "fadeOut") => void;
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
  verticalOffsetPx,
  isSelected,
  isDragging,
  isEffectDropTarget,
  isSelectedForKeyframes,
  isSlipping,
  slipPreviewSourceInSeconds,
  trimPreview,
  selectedClipKeyframeId,
  draggingKeyframeId,
  draggingKeyframePreviewTime,
  assets,
  clipNumber,
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
  // Premiere-style label color: per-clip override, else inherited from the source asset.
  const labelName = layerLabelOf(layer, assets);
  const labelColor = labelName ? ASSET_LABEL_COLORS[labelName] : undefined;
  // No selection lift: clips stay planted on their lane when clicked (the -2px translate read as
  // the clip "shifting upward"). Selection is the border/glow alone.
  const transform = verticalOffsetPx !== 0 ? `translateY(${verticalOffsetPx}px)` : undefined;

  return (
    <div
      aria-label={`${layer.name}, ${layer.type}, starts at ${startSeconds.toFixed(1)} seconds`}
      className={`timeline-clip timeline-clip-${layer.type} ${isSelected ? "is-selected" : ""} ${isDragging ? "is-dragging" : ""} ${
        isEffectDropTarget ? "is-effect-drop-target" : ""
      } ${isSlipping ? "is-slipping" : ""} ${labelColor ? "has-label" : ""}`}
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
          onDropAsset(assetId, trackId, startSeconds, layer.id, readSourceDragPayload(event));
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
        width: `${Math.max(0, width)}%`,
        transform,
        ...(labelColor ? ({ "--clip-label": labelColor } as CSSProperties) : {})
      }}
    >
      <span className="clip-resize clip-resize-start" onPointerDown={(event) => onStartResize(event, layer, "start")} onPointerMove={onMoveResize} onPointerUp={onFinishResize} onPointerCancel={onCancelResize} />
      {/* DaVinci-style corner fade handles: when a side has no fade yet, a small grab dot sits in
          that top corner — dragging it inward CREATES the fade (the same transition drag the
          existing bands use; it commits through onSetTransition on release). Once a fade exists,
          the band's own handle takes over and the corner dot hides. */}
      {!trackLocked && !layer.locked && fadeInDuration <= 0 && !hideFadeIn ? (
        <span
          className="clip-fade-create clip-fade-create-in"
          title="Drag right to fade this clip in"
          onPointerDown={(event) => onStartTransitionDrag(event, layer, "fadeIn")}
        />
      ) : null}
      {!trackLocked && !layer.locked && fadeOutDuration <= 0 && !hideFadeOut ? (
        <span
          className="clip-fade-create clip-fade-create-out"
          title="Drag left to fade this clip out"
          onPointerDown={(event) => onStartTransitionDrag(event, layer, "fadeOut")}
        />
      ) : null}
      {fadeInDuration > 0 ? (
        <span
          className="clip-fade-band clip-fade-band-in"
          style={{ width: `${fadeInPercent}%` }}
          title={`Fade in ${fadeInDuration.toFixed(2)}s — drag to adjust, double-click to remove`}
          onPointerDown={(event) => onStartTransitionDrag(event, layer, "fadeIn")}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemoveTransition(layer.id, "fadeIn");
          }}
        >
          {/* DaVinci fade drawing: slant line from the bottom-left corner up to the fade point at
              the top edge; the triangle ABOVE the line (the faded-away region) is darkened. */}
          <svg className="clip-fade-slant" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polygon points="0,0 100,0 0,100" fill="rgba(0, 0, 0, 0.45)" />
            {/* Barely-there edge line: the darkened quadrant is the fade indicator; the line only
                crispens the boundary (user feedback: a bright slant adds no value). */}
            <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(255, 255, 255, 0.18)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
          <span className="clip-fade-handle" aria-hidden="true" />
        </span>
      ) : null}
      {fadeOutDuration > 0 ? (
        <span
          className="clip-fade-band clip-fade-band-out"
          style={{ width: `${fadeOutPercent}%` }}
          title={`Fade out ${fadeOutDuration.toFixed(2)}s — drag to adjust, double-click to remove`}
          onPointerDown={(event) => onStartTransitionDrag(event, layer, "fadeOut")}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemoveTransition(layer.id, "fadeOut");
          }}
        >
          {/* Mirror of the fade-in drawing: slant from the fade point at the top edge down to the
              bottom-right corner; the region past the line darkens toward the clip end. */}
          <svg className="clip-fade-slant" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polygon points="0,0 100,0 100,100" fill="rgba(0, 0, 0, 0.45)" />
            <line x1="0" y1="0" x2="100" y2="100" stroke="rgba(255, 255, 255, 0.18)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
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
      {trimPreview ? (
        <span className="clip-slip-badge">
          {trimPreview.mode} {trimPreview.deltaSeconds >= 0 ? "+" : ""}{trimPreview.deltaSeconds.toFixed(2)}s
        </span>
      ) : null}
      {clipNumber !== undefined ? (
        <span className="clip-number" aria-hidden="true">{clipNumber}</span>
      ) : null}
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
                } clip-keyframe-${keyframe.interpolation} clip-keyframe-scope-${keyframeMarkerScope(keyframe)}`}
                key={`${keyframe.id}_${keyframe.target.property}`}
                title={`${shortKeyframeProperty(keyframe.target.property)} · ${previewTime.toFixed(2)}s — double-click to open the graph editor`}
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectKeyframe(keyframe.id);
                  onSelectLayer(layer.id, "replace");
                  onChangeCurrentTime(layer.startSeconds + keyframe.timeSeconds);
                }}
                onDoubleClick={(event) => {
                  // Double-click OPENS THE GRAPH EDITOR focused on this property (2026-07-12,
                  // user-specified drawer behavior). Deleting stays on the lane trash button,
                  // Delete in the graph editor, and the diamond toggles in the inspector.
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectLayer(layer.id, "replace");
                  window.dispatchEvent(
                    new CustomEvent("lumio:open-graph-editor", { detail: { targetKey: keyframeGraphTargetKey(keyframe) } })
                  );
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
      {/* Clean-timeline pass (2026-07-03): the hover delete icon is gone — Delete/Backspace on the
          selection and the right-click menu already cover it, and the top corners belong to the
          fade handles now. */}
      <span className="clip-resize clip-resize-end" onPointerDown={(event) => onStartResize(event, layer, "end")} onPointerMove={onMoveResize} onPointerUp={onFinishResize} onPointerCancel={onCancelResize} />
    </div>
  );
});

function getVisibleLayerKeyframes(layer: TimelineLayer) {
  return getLayerAnimations(layer)
    .filter(
      (keyframe) =>
        // Transform + content (layer scope) AND effect-param keyframes all surface in the
        // lane (2026-07-12) — effect/content ones draw as color-coded dots.
        ((keyframe.target.scope === "layer" &&
          (keyframe.target.property.startsWith("transform.") || keyframe.target.property.startsWith("content."))) ||
          keyframe.target.scope === "effect") &&
        // Fades render as friendly bands (getClipFades), not as raw keyframe diamonds.
        !keyframe.id.includes(TRANSITION_MARKER)
    )
    .sort((a, b) => a.timeSeconds - b.timeSeconds || a.target.property.localeCompare(b.target.property));
}

/** Lane marker family: transform diamonds vs content/effect dots (styling hook). */
function keyframeMarkerScope(keyframe: TimelineKeyframeV2): "transform" | "content" | "effect" {
  if (keyframe.target.scope === "effect") return "effect";
  return keyframe.target.property.startsWith("content.") ? "content" : "transform";
}

/** GraphTarget key for the graph editor drawer ("open focused on this property"). */
function keyframeGraphTargetKey(keyframe: TimelineKeyframeV2): string {
  return keyframe.target.scope === "effect"
    ? `effect:${keyframe.target.effectId}:${keyframe.target.property}`
    : `transform:${keyframe.target.property}`;
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

function getRulerMarks(durationSeconds: number, stepSeconds: number, pixelsPerSecond: number) {
  const marks: Array<{ timeSeconds: number; endpoint: boolean }> = [];
  const totalSteps = Math.floor(durationSeconds / stepSeconds);
  for (let index = 0; index <= totalSteps; index += 1) {
    marks.push({ timeSeconds: Number((index * stepSeconds).toFixed(3)), endpoint: false });
  }
  const roundedDuration = Number(durationSeconds.toFixed(3));
  const last = marks.at(-1);
  if (!last || Math.abs(last.timeSeconds - roundedDuration) > 0.001) {
    // 64px, not 44: the end label renders a full H:MM:SS timecode (~50px in the mono font,
    // right-aligned so it extends left) — 44px let it overlap the previous tick's label.
    const minEndpointGapSeconds = 64 / Math.max(1, pixelsPerSecond);
    if (last && roundedDuration - last.timeSeconds < minEndpointGapSeconds && marks.length > 1) {
      marks.pop();
    }
    marks.push({ timeSeconds: roundedDuration, endpoint: true });
  } else {
    last.endpoint = true;
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
