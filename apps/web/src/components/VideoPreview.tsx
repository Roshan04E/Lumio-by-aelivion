import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import { Camera, Check, ChevronLeft, ChevronRight, Circle, Columns2, Eye, Grid3x3, Hexagon, Maximize, MousePointer2, PenTool, Ratio, Square, SunMoon } from "lucide-react";
import {
  buildColorFilterDefs,
  buildMaskDefsSvg,
  buildWarpedTextPathSvg,
  createBoxMask,
  createMask,
  getCompositionTransform,
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
  isWebgl2ColorSupported,
  getCompositionMediaStyle,
  getCompositionShapeStyle,
  getCompositionTextRunStyle,
  getCompositionTextStyle,
  getCompositionTransition,
  getCompositionVolume,
  getVisibleTextRuns,
  evaluateTimelineTransform,
  findTransitionPairs,
  getActiveTransition,
  getLayerAnimations,
  hasTextWarp,
  normalizeTextWarp,
  type ProjectGraph,
  type SourceAsset,
  type TimelineComposition,
  type TimelineKeyframeV2,
  type TimelineLayer,
  type TimelineTrack,
  type TransitionSpec
} from "@reelforge/shared";
import { MaskedVideoLayer } from "./MaskedVideoLayer";
import { TransitionOverlay } from "./TransitionLayer";
import { ColorEngineBoundary } from "./ColorEngineBoundary";
import { WebglColorView } from "./WebglColorView";
import { WebglVideoOverlay } from "./WebglVideoOverlay";
import { WebglMediaLayer } from "./WebglMediaLayer";
import { getVideoPoster, useVideoPoster } from "../lib/videoThumbnails";
import { useWebglColorEngine, useWebglRenderer } from "../color/render-engine";

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

export function VideoPreview({
  graph,
  composition,
  currentTime,
  isPlaying,
  previewQuality,
  viewerZoom,
  assets,
  selectedLayerId,
  frameRef,
  onChangeViewerZoom,
  onFitViewerHeight,
  onFitViewerWidth,
  onSaveFreezeFrame,
  onSelectLayer,
  onMoveLayer,
  onMovePositionKeyframe,
  onMoveSpatialHandle,
  onResizeShapeLayer,
  onRotateLayer,
  onScaleLayer,
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
  maskEffectId
}: {
  graph: ProjectGraph;
  composition: TimelineComposition;
  currentTime: number;
  isPlaying: boolean;
  previewQuality: "performance" | "balanced" | "quality";
  viewerZoom: number;
  assets: SourceAsset[];
  selectedLayerId?: string | undefined;
  /** Optional ref forwarded to the phone-frame element so callers can sample its content (e.g. color scopes). */
  frameRef?: React.Ref<HTMLDivElement> | undefined;
  onChangeViewerZoom?: ((zoom: number) => void) | undefined;
  onFitViewerHeight?: ((zoom: number) => void) | undefined;
  onFitViewerWidth?: ((zoom: number) => void) | undefined;
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
}) {
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
  const [gridMode, setGridMode] = useState<GridMode>("off");
  const [gridMenuOpen, setGridMenuOpen] = useState(false);
  const gridMenuRef = useRef<HTMLDivElement | null>(null);
  // Collapse the floating tool bar to a single chevron to free up viewer room.
  const [toolsCollapsed, setToolsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("reelforge_preview_tools_collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [spiralRotate, setSpiralRotate] = useState(false);

  // Close the composition-guides popover on outside click / Escape.
  useEffect(() => {
    if (!gridMenuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (gridMenuRef.current && !gridMenuRef.current.contains(event.target as Node)) {
        setGridMenuOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setGridMenuOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [gridMenuOpen]);
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
  const viewerZoomRef = useRef(viewerZoom);
  const onChangeViewerZoomRef = useRef(onChangeViewerZoom);
  const [compositionScale, setCompositionScale] = useState(1);
  // Unclipped layer that editing overlays (selection box, motion path) portal into, so their handles show
  // past the canvas edge (the comp content is still cropped by .preview-comp-clip).
  const [overlayLayer, setOverlayLayer] = useState<HTMLDivElement | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const shouldRenderRichEffects = previewQuality !== "performance";
  const hasTracking = shouldRenderRichEffects && graph.effects.some((effect) => effect.type === "SMART_3D_FOLLOW_TEXT");
  const hasBehindText = shouldRenderRichEffects && graph.effects.some((effect) => effect.type === "TEXT_BEHIND_PERSON");
  const resolvedAssets = useMemo(() => {
    if (!sourceAsset || assets.some((asset) => asset.id === sourceAsset.id)) {
      return assets;
    }

    return [sourceAsset, ...assets];
  }, [assets, sourceAsset]);
  // Region color/glow masks expand into base + duplicate layers at render time (duplicate = the masked effect
  // applied globally, clipped to the region). Render-only; the editor state keeps the original single layer.
  const expandedTracks = useMemo(() => expandEffectRegionMasks(composition).tracks, [composition]);
  const activeVisualLayerEntries = useMemo(
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
  const pendingVideoLayerEntries = useMemo(
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
  const activeAudioLayerEntries = useMemo(
    () =>
      composition.tracks
        .flatMap((track, trackIndex) => track.layers.map((layer) => ({ layer, trackIndex, track })))
        .filter(({ layer, track }) => isTrackEnabled(track, composition.tracks) && !layer.muted && layer.type === "audio" && isLayerActive(layer, currentTime)),
    [composition, currentTime]
  );

  // The selected media layer is the mask-editing target (clip masks apply to video/image in Phase 1). Read it
  // from the ORIGINAL composition, not `renderedLayerEntries`: region effects expand into render-only clones
  // (the base clone keeps this id but has the region effects stripped), so editing must use the un-expanded
  // layer to still see `effect.masks` (region masks) — otherwise the region mask is invisible/uneditable.
  const maskActiveLayer = selectedLayerId
    ? composition.tracks
        .flatMap((track) => track.layers)
        .find((layer) => layer.id === selectedLayerId && (layer.type === "video" || layer.type === "image"))
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
  const transitionPairs = useMemo(() => {
    const layers = renderedLayerEntries.map((entry) => entry.layer);
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const out: {
      outgoingId: string;
      incomingId: string;
      spec: TransitionSpec;
      startSeconds: number;
      fromFit: "cover" | "contain" | "fill";
      toFit: "cover" | "contain" | "fill";
    }[] = [];
    for (const pair of findTransitionPairs(layers)) {
      const incoming = byId.get(pair.incomingId);
      const outgoing = byId.get(pair.outgoingId);
      if (!incoming || !outgoing) continue;
      const active = getActiveTransition(pair.spec, { currentTimeSeconds: currentTime, startSeconds: incoming.startSeconds });
      if (!active) continue;
      out.push({
        outgoingId: pair.outgoingId,
        incomingId: pair.incomingId,
        spec: pair.spec,
        startSeconds: incoming.startSeconds,
        fromFit: getCompositionObjectFit(outgoing) as "cover" | "contain" | "fill",
        toFit: getCompositionObjectFit(incoming) as "cover" | "contain" | "fill",
      });
    }
    return out;
  }, [renderedLayerEntries, currentTime]);
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

  useEffect(() => {
    viewerZoomRef.current = viewerZoom;
    onChangeViewerZoomRef.current = onChangeViewerZoom;
  }, [onChangeViewerZoom, viewerZoom]);

  useEffect(() => {
    const frame = phoneFrameRef.current;
    if (!frame) {
      return;
    }

    function updateScale(width: number, height: number) {
      const nextScale = Math.min(width / composition.width, height / composition.height);
      setCompositionScale(Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1);
      updateFitZooms();
    }

    function updateFitZooms() {
      const viewport = viewportRef.current;
      const currentFrame = phoneFrameRef.current;
      if (!viewport || !currentFrame) {
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const viewportStyle = window.getComputedStyle(viewport);
      // Always subtract the viewport padding (the editor viewport now has padding so handles show past
      // the frame edge); the fitted frame must leave that margin free.
      const horizontalPadding = Number.parseFloat(viewportStyle.paddingLeft) + Number.parseFloat(viewportStyle.paddingRight);
      const verticalPadding = Number.parseFloat(viewportStyle.paddingTop) + Number.parseFloat(viewportStyle.paddingBottom);
      const availableWidth = viewportRect.width - horizontalPadding;
      const availableHeight = viewportRect.height - verticalPadding;
      const fitWidth = availableWidth / currentFrame.offsetWidth;
      const fitHeight = availableHeight / currentFrame.offsetHeight;
      if (Number.isFinite(fitWidth) && fitWidth > 0) {
        onFitViewerWidth?.(clamp(fitWidth, 0.1, 4));
      }
      if (Number.isFinite(fitHeight) && fitHeight > 0) {
        onFitViewerHeight?.(clamp(fitHeight, 0.1, 4));
      }
    }

    updateScale(frame.clientWidth, frame.clientHeight);

    // This observer watches three different elements (frame, viewport, the
    // .editor-viewer panel) so any of them resizing triggers a recompute - but
    // updateScale() divides by composition.width/height, so it must always be
    // called with the FRAME's own box size, never whichever element happened to
    // produce entries[0]. Using the wrong entry (e.g. the much larger panel) was
    // producing a stale/wrong compositionScale that no longer matched the
    // frame's actual rendered size, leaving a visible gap between the frame box
    // and its (now mis-scaled) inner video content after resizing the timeline
    // panel. Re-reading the frame's current size directly from the ref sidesteps
    // that ambiguity entirely.
    const observer = new ResizeObserver(() => {
      const currentFrame = phoneFrameRef.current;
      if (!currentFrame) {
        return;
      }

      updateScale(currentFrame.clientWidth, currentFrame.clientHeight);
    });
    observer.observe(frame);
    if (viewportRef.current) {
      observer.observe(viewportRef.current);
    }
    const editorViewer = viewportRef.current?.closest(".editor-viewer");
    if (editorViewer) {
      observer.observe(editorViewer);
    }

    return () => observer.disconnect();
  }, [composition.height, composition.width, onFitViewerHeight, onFitViewerWidth]);

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
        const zoomDelta = event.deltaY < 0 ? 0.12 : -0.12;
        onChangeViewerZoomRef.current?.(clamp(viewerZoomRef.current + zoomDelta, 0.55, 4));
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
    if (event.button !== 1) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
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
    const pan = panRef.current;
    const viewport = viewportRef.current;
    if (!pan || !viewport || event.pointerId !== pan.pointerId) {
      return;
    }

    event.preventDefault();
    viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
    viewport.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
  }

  function finishViewportPan(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (!pan || event.pointerId !== pan.pointerId) {
      return;
    }

    panRef.current = null;
    setIsPanning(false);
  }

  function deselectFromEmptyPreviewClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.closest(".preview-text-layer, .preview-shape-layer, .preview-media, .preview-missing-layer, .preview-selection-box")) {
      return;
    }

    onSelectLayer(undefined);
  }

  return (
    <div className={`preview-stage preview-quality-${previewQuality}`} ref={stageRef}>
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
                localStorage.setItem("reelforge_preview_tools_collapsed", next ? "1" : "0");
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
        <div className="preview-tool-menu" ref={gridMenuRef}>
          <button
            type="button"
            className={gridMode !== "off" ? "is-active" : ""}
            title="Composition guides"
            aria-haspopup="menu"
            aria-expanded={gridMenuOpen}
            onClick={() => setGridMenuOpen((v) => !v)}
            onBlur={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) setGridMenuOpen(false);
            }}
          >
            <Grid3x3 size={15} />
          </button>
          {gridMenuOpen ? (
            <div className="preview-tool-popover" role="menu">
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
            </div>
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
      {activeAudioLayerEntries.map(({ layer }) => (
        <AudioPreviewLayer
          assets={resolvedAssets}
          currentTime={currentTime}
          isPlaying={isPlaying}
          key={layer.id}
          layer={layer}
          sourceAsset={sourceAsset}
        />
      ))}
      <div
        className={`preview-viewport ${isPanning ? "is-panning" : ""}`}
        ref={viewportRef}
        onPointerCancel={finishViewportPan}
        onPointerDown={startViewportPan}
        onPointerMove={updateViewportPan}
        onPointerUp={finishViewportPan}
        onClick={deselectFromEmptyPreviewClick}
      >
        <div className="preview-canvas" style={{ "--viewer-zoom": viewerZoom } as CSSProperties}>
          <div
            className={`phone-frame preview-bg-${previewBg}`}
            ref={mergedPhoneFrameRef}
            style={{ "--comp-aspect": composition.width / composition.height } as CSSProperties}
          >
            <div
              className="preview-composition-space"
              style={
                {
                  width: composition.width,
                  height: composition.height,
                  transform: `translate3d(-50%, -50%, 0) scale(${compositionScale})`
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
              {renderVisualLayerEntries.length === 0 ? <div className="preview-empty-frame" aria-hidden="true" /> : null}
              {renderedLayerEntries.map(({ layer, pending }) => (
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
                    onSelectLayer={onSelectLayer}
                    selected={!pending && selectedLayerId === layer.id}
                    assets={resolvedAssets}
                    sourceAsset={sourceAsset}
                    hideForTransition={transitionHiddenIds.has(layer.id)}
                    bypassColor={compareBefore}
                    onGradedFrame={
                      transitionSourceIds.has(layer.id)
                        ? (canvas) => {
                            gradedCanvasesRef.current[layer.id] = canvas;
                          }
                        : undefined
                    }
                  />
                  {(overlaysByAnchorId.get(layer.id) ?? []).map((pair) => (
                    <TransitionOverlay
                      key={`${pair.outgoingId}->${pair.incomingId}`}
                      spec={pair.spec}
                      startSeconds={pair.startSeconds}
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
              {showMasks && maskActiveLayer ? (
                <MaskEditorOverlay
                  layer={maskActiveLayer}
                  masks={maskEditMasks}
                  currentTime={currentTime}
                  width={composition.width}
                  height={composition.height}
                  scale={compositionScale}
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

function PreviewLayer({
  currentTime,
  isPlaying,
  layer,
  selected,
  pending = false,
  assets,
  sourceAsset,
  onMoveLayer,
  onMovePositionKeyframe,
  onMoveSpatialHandle,
  onResizeShapeLayer,
  onRotateLayer,
  onScaleLayer,
  onSelectLayer,
  hideForTransition = false,
  bypassColor = false,
  onGradedFrame
}: {
  currentTime: number;
  isPlaying: boolean;
  layer: TimelineLayer;
  selected: boolean;
  /** This clip is the incoming side of an active GPU transition — hide it; the overlay shows the mix. */
  hideForTransition?: boolean;
  /** Before/after compare: skip the color grade so the original (ungraded) frame shows. */
  bypassColor?: boolean;
  /** Report the graded canvas so the transition overlay can sample it as a from/to texture. */
  onGradedFrame?: ((canvas: HTMLCanvasElement) => void) | undefined;
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
  onSelectLayer: (layerId: string) => void;
}) {
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
  const isVideo = layer.type === "video" && Boolean(mediaUrl) && (asset?.fileType.startsWith("video/") ?? true);
  // First-frame still at the clip's in-point — held over the canvas/video until the real frame
  // decodes so the viewer never shows black (start, cut, or seek). Captured once, cached.
  const videoPoster = useVideoPoster(isVideo ? mediaUrl : undefined, layer.sourceInSeconds ?? 0);
  // A pending layer is only mounted to pre-seek; it must never actually play.
  const effectivePlaying = isPlaying && !pending;

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
    const resize = resizeRef.current;
    if (!resize || event.pointerId !== resize.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (layer.type === "shape" && onResizeShapeLayer) {
      const nextSize = shapeSizeFromResize(event, resize);
      resize.moved = resize.moved || Math.abs(nextSize.widthPercent - resize.startWidthPercent) > 0.2 || Math.abs(nextSize.heightPercent - resize.startHeightPercent) > 0.2;
      onResizeShapeLayer(resize.layerId, nextSize, false);
      return;
    }

    if (onScaleLayer) {
      const nextScale = scaleFromResize(event, resize);
      resize.moved = resize.moved || Math.abs(nextScale - resize.startScale) > 0.01;
      onScaleLayer(resize.layerId, nextScale, false);
    }
  }

  function finishPreviewResize(event: ReactPointerEvent<HTMLSpanElement>) {
    const resize = resizeRef.current;
    if (!resize || event.pointerId !== resize.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = null;
    if (layer.type === "shape" && onResizeShapeLayer) {
      onResizeShapeLayer(resize.layerId, shapeSizeFromResize(event, resize), true);
      return;
    }

    if (onScaleLayer) {
      onScaleLayer(resize.layerId, scaleFromResize(event, resize), true);
    }
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
  }

  function updatePreviewRotate(event: ReactPointerEvent<HTMLSpanElement>) {
    const rotate = rotateRef.current;
    if (!rotate || !onRotateLayer || event.pointerId !== rotate.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const nextRotation = rotationFromPointer(event, rotate);
    rotate.moved = rotate.moved || Math.abs(nextRotation - rotate.startRotation) > 1;
    onRotateLayer(rotate.layerId, nextRotation, false);
  }

  function finishPreviewRotate(event: ReactPointerEvent<HTMLSpanElement>) {
    const rotate = rotateRef.current;
    if (!rotate || !onRotateLayer || event.pointerId !== rotate.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const nextRotation = rotationFromPointer(event, rotate);
    rotateRef.current = null;
    onRotateLayer(rotate.layerId, nextRotation, true);
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

  const dragHandlers = {
    onClick: handlePreviewClick,
    onPointerCancel: finishPreviewDrag,
    onPointerDown: startPreviewDrag,
    onPointerMove: updatePreviewDrag,
    onPointerUp: finishPreviewDrag
  };

  function syncVideoTime(video: HTMLVideoElement) {
    // Source-aware: offset into the source media so trimmed/split clips play the correct source frame.
    // The clamp is the asset's available media (not just the clip's visible span) so that during a
    // transition post-roll the outgoing clip can play a little past its out-point into its tail handle
    // (held at the last real frame when there's no spare media) — exactly like a pro editor's handles.
    const sourceIn = layer.sourceInSeconds ?? 0;
    const maxLocal = asset?.durationSeconds != null ? Math.max(0, asset.durationSeconds - sourceIn - 0.05) : layer.durationSeconds;
    const localTime = Math.max(0, Math.min(maxLocal, currentTime - layer.startSeconds));
    const nextTime = sourceIn + localTime;
    if (Number.isFinite(nextTime) && Math.abs(video.currentTime - nextTime) > 0.08) {
      video.currentTime = nextTime;
    }
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo) {
      return;
    }

    if (effectivePlaying) {
      syncVideoTime(video);
      void video.play().catch(() => undefined);
      return;
    }

    video.pause();
    syncVideoTime(video);
  }, [effectivePlaying, isVideo, layer.id, mediaUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo || effectivePlaying) {
      return;
    }

    syncVideoTime(video);
  }, [currentTime, effectivePlaying, isVideo, layer.startSeconds, mediaUrl]);

  if (layer.type === "text") {
    const style = getCompositionTextStyle(layer, { currentTimeSeconds: currentTime });
    const visibleRuns = getVisibleTextRuns(layer, currentTime);
    // Warp renders as a vector <path> overlay (opentype outline + envelope mesh). The
    // HTML runs stay for box sizing/selection but go invisible once the warp is ready;
    // while it loads (or if the font isn't hosted) the plain text shows instead.
    const warpReady = warpTextSvg != null;

    return (
      <>
        <button className={`preview-text-layer ${selected ? "is-selected" : ""}`} type="button" {...dragHandlers} style={style as CSSProperties}>
          {visibleRuns.map((run, index) => (
            <span
              key={`${layer.id}_run_${index}`}
              style={{ ...(getCompositionTextRunStyle(run, style) as CSSProperties), visibility: warpReady ? "hidden" : undefined }}
            >
              {run.text}
            </span>
          ))}
          {warpReady ? (
            <span
              aria-hidden="true"
              style={{ position: "absolute", inset: 0, visibility: "visible" }}
              dangerouslySetInnerHTML={{ __html: warpTextSvg }}
            />
          ) : null}
        </button>
        {selected ? (
          <PreviewSelectionOverlay
            layer={layer}
            style={style as CSSProperties}
            text={layer.text}
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
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

    return (
      <>
        <button
          className={`preview-shape-layer ${selected ? "is-selected" : ""}`}
          type="button"
          {...dragHandlers}
          style={style as CSSProperties}
        />
        {selected ? (
          <PreviewSelectionOverlay
            layer={layer}
            style={style as CSSProperties}
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
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
    // Pre-rolled but not yet on-screen: keep it invisible and click-through until active.
    const style: CSSProperties = pending ? { ...baseStyle, opacity: 0, pointerEvents: "none" } : baseStyle;
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
            matte={layer.matte}
            pipeline={videoColorPipeline}
            mediaEffects={videoMediaEffects}
            currentTime={currentTime}
            isPlaying={effectivePlaying}
            layerStartSeconds={layer.startSeconds}
            sourceInSeconds={layer.sourceInSeconds}
            onLoadedMetadata={(event) => syncVideoTime(event.currentTarget)}
            dragHandlers={effectiveDragHandlers}
            onWebglFailed={() => setWebglMediaFailed(true)}
            poster={videoPoster ?? undefined}
            hidden={pending || hideForTransition}
            transition={onGradedFrame ? null : videoTransition}
            onGradedFrame={onGradedFrame}
            ref={videoRef}
            style={webglLayerStyle}
          />
          <EffectMaskOverlays layer={layer} currentTime={currentTime} style={webglLayerStyle} />
          {isSelectedVisible ? (
            <PreviewSelectionOverlay
              layer={layer}
              style={webglLayerStyle}
              onResizePointerCancel={finishPreviewResize}
              onResizePointerDown={startPreviewResize}
              onResizePointerMove={updatePreviewResize}
              onResizePointerUp={finishPreviewResize}
              onRotatePointerCancel={finishPreviewRotate}
              onRotatePointerDown={startPreviewRotate}
              onRotatePointerMove={updatePreviewRotate}
              onRotatePointerUp={finishPreviewRotate}
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
            sourceInSeconds={layer.sourceInSeconds}
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
        <EffectMaskOverlays layer={layer} currentTime={currentTime} style={style} />
        {isSelectedVisible ? (
          <PreviewSelectionOverlay
            layer={layer}
            style={style}
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
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
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
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

  const imageStyle = getCompositionMediaStyle(layer, { currentTimeSeconds: currentTime }) as CSSProperties;
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
          pipeline={imageColorPipeline}
          mediaEffects={imageMediaEffects}
          transition={onGradedFrame ? null : imageTransition}
          onGradedFrame={onGradedFrame}
          hidden={hideForTransition}
          dragHandlers={dragHandlers}
          onWebglFailed={() => setWebglMediaFailed(true)}
          style={webglImageStyle}
        />
        <EffectMaskOverlays layer={layer} currentTime={currentTime} style={webglImageStyle} />
        {selected ? (
          <PreviewSelectionOverlay
            layer={layer}
            style={webglImageStyle}
            onResizePointerCancel={finishPreviewResize}
            onResizePointerDown={startPreviewResize}
            onResizePointerMove={updatePreviewResize}
            onResizePointerUp={finishPreviewResize}
            onRotatePointerCancel={finishPreviewRotate}
            onRotatePointerDown={startPreviewRotate}
            onRotatePointerMove={updatePreviewRotate}
            onRotatePointerUp={finishPreviewRotate}
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
      <EffectMaskOverlays layer={layer} currentTime={currentTime} style={imageStyle} />
      {selected ? (
        <PreviewSelectionOverlay
          layer={layer}
          style={imageStyle}
          onResizePointerCancel={finishPreviewResize}
          onResizePointerDown={startPreviewResize}
          onResizePointerMove={updatePreviewResize}
          onResizePointerUp={finishPreviewResize}
          onRotatePointerCancel={finishPreviewRotate}
          onRotatePointerDown={startPreviewRotate}
          onRotatePointerMove={updatePreviewRotate}
          onRotatePointerUp={finishPreviewRotate}
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

/**
 * One shared AudioContext for all preview audio layers. Created lazily (and resumed on the play
 * gesture) so it satisfies the autoplay policy. Returns undefined where Web Audio is unavailable.
 */
let sharedPreviewAudioContext: AudioContext | undefined;
function getPreviewAudioContext(): AudioContext | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    return undefined;
  }
  sharedPreviewAudioContext ??= new Ctor();
  return sharedPreviewAudioContext;
}

function AudioPreviewLayer({
  assets,
  currentTime,
  isPlaying,
  layer,
  sourceAsset
}: {
  assets: SourceAsset[];
  currentTime: number;
  isPlaying: boolean;
  layer: TimelineLayer;
  sourceAsset?: SourceAsset | null | undefined;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Route the element through a Web Audio GainNode so the gain matches the export exactly — the raw
  // element.volume is clamped to 0..1, but the mixer/Remotion (and this graph) can boost past 100%.
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const asset = resolveLayerAsset(layer, assets, sourceAsset);
  const mediaUrl = resolvePlaybackUrl(asset);

  function syncAudioTime(audio: HTMLAudioElement) {
    const nextTime = Math.max(0, Math.min(layer.durationSeconds, currentTime - layer.startSeconds));
    if (Number.isFinite(nextTime) && Math.abs(audio.currentTime - nextTime) > 0.08) {
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
      source.connect(gain).connect(ctx.destination);
      sourceNodeRef.current = source;
      gainNodeRef.current = gain;
    } catch {
      // Already connected or unsupported — element.volume path covers it.
    }
  }, [mediaUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl) {
      return;
    }

    if (isPlaying) {
      void getPreviewAudioContext()?.resume();
      syncAudioTime(audio);
      void audio.play().catch(() => undefined);
      return;
    }

    audio.pause();
    syncAudioTime(audio);
  }, [isPlaying, layer.id, mediaUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl || isPlaying) {
      return;
    }
    syncAudioTime(audio);
  }, [currentTime, isPlaying, layer.startSeconds, mediaUrl]);

  // Volume / fade tracked against currentTime so it updates during scrub + playback. The GainNode
  // takes the full 0..2 range (exact parity); the element.volume fallback clamps to 0..1.
  useEffect(() => {
    const gain = Math.max(0, getCompositionVolume(layer, { currentTimeSeconds: currentTime }));
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = gain;
      return;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.volume = Math.min(1, gain);
    }
  }, [currentTime, layer]);

  if (!mediaUrl) {
    return null;
  }

  return <audio aria-hidden="true" crossOrigin="anonymous" preload="auto" ref={audioRef} src={mediaUrl} />;
}

function applyActiveAdjustmentEffects(
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
  onResizePointerCancel,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  onRotatePointerCancel,
  onRotatePointerDown,
  onRotatePointerMove,
  onRotatePointerUp
}: {
  layer: TimelineLayer;
  style: CSSProperties;
  text?: string | undefined;
  onResizePointerCancel: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizePointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizePointerUp: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onRotatePointerCancel: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onRotatePointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onRotatePointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onRotatePointerUp: (event: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  const overlayStyle = {
    ...selectionOverlayStyle(style),
    "--handle-inverse-scale": 1 / Math.max(0.1, layer.transform.scale)
  } as CSSProperties;

  const portalTarget = useContext(OverlayPortalContext);
  const node = (
    <div className={`preview-selection-box preview-selection-box-${layer.type}`} style={overlayStyle}>
      {text ? <span className="preview-selection-measure">{text}</span> : null}
      <span className="preview-resize-handles" aria-hidden="true">
      <span
        className="preview-rotate-handle"
        onPointerCancel={onRotatePointerCancel}
        onPointerDown={onRotatePointerDown}
        onPointerMove={onRotatePointerMove}
        onPointerUp={onRotatePointerUp}
      />
      {(["nw", "ne", "sw", "se"] as const).map((corner) => (
        <span
          className={`preview-resize-handle preview-resize-handle-${corner}`}
          key={corner}
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
  const cx = (transform.x / 100) * width;
  const cy = (transform.y / 100) * height;
  const s = transform.scale || 1;
  const rad = ((transform.rotation || 0) * Math.PI) / 180;
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
        // Select tool: the active mask is draggable by its whole interior (transparent fill hit area), not
        // just the thin outline; inactive masks hit-test the stroke (click to select). While a draw tool is
        // active, masks don't capture pointers so drawing over them still works.
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
  const {
    background: _background,
    backgroundColor: _backgroundColor,
    boxShadow: _boxShadow,
    color: _color,
    filter: _filter,
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
  return clamp(resize.startScale * (nextDistance / resize.startDistance), 0.2, 5);
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

function isLayerActive(layer: TimelineLayer, currentTime: number) {
  return currentTime >= layer.startSeconds && currentTime <= layer.startSeconds + layer.durationSeconds;
}

/**
 * True when `layer` is the OUTGOING side of a junction transition that is currently playing — i.e. the
 * next same-track clip starts at this clip's end and carries a `transitionIn`, and the playhead is in
 * that transition's window `[cut, cut+D]`. The clip then keeps rendering (held at its out-point frame —
 * the "repeated frames" a pro editor shows when a clip has no spare handle) under the incoming reveal,
 * without its timeline length ever changing.
 */
function isOutgoingInPostroll(layer: TimelineLayer, track: TimelineTrack, currentTime: number): boolean {
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
    if (Math.abs(other.startSeconds - end) < 0.05 && currentTime <= end + other.transitionIn.durationSeconds) {
      return true;
    }
  }
  return false;
}

function resolveLayerUrl(layer: TimelineLayer | undefined, assets: SourceAsset[], sourceAsset: SourceAsset | null | undefined) {
  return resolvePlaybackUrl(resolveLayerAsset(layer, assets, sourceAsset));
}

function resolveLayerAsset(layer: TimelineLayer | undefined, assets: SourceAsset[], sourceAsset: SourceAsset | null | undefined) {
  if (!layer) {
    return undefined;
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

function resolvePlaybackUrl(asset: SourceAsset | undefined) {
  if (!asset) {
    return undefined;
  }

  const previewAsset = asset as SourceAsset & { proxyUrl?: string | undefined; previewUrl?: string | undefined };
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
