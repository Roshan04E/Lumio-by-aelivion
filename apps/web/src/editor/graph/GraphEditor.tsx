/**
 * The dedicated keyframe graph editor — canvas-based, multi-curve, docked in the
 * bottom workspace (After Effects model). Left rail lists the layer's animatable
 * GraphTargets (Transform + every keyframeable effect param); the plot overlays the
 * visible curves, each normalized to its own value range with a stable color.
 *
 * Interactions: click/marquee select, multi-keyframe drag (Shift = axis lock),
 * bezier temporal handle drag (Alt = split), cursor-anchored wheel zoom (plain =
 * time, Shift = value, Ctrl = both), middle/space drag pan, `F` fit, frame /
 * keyframe / playhead snapping, per-selection interpolation, exact time/value
 * scrub fields, ruler drag = seek, double-click curve = add key, double-click
 * point = delete, Delete = delete selection, arrows = nudge.
 *
 * All mutations go through the proven keyframeUtils GraphTarget helpers (writes
 * are standard TimelineKeyframeV2 — Remotion parity by construction) with the
 * draft/commit pattern: one gesture = one undo snapshot. The playhead line is
 * drawn imperatively from the playback clock's sync tier (never re-Reactified).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import { Diamond, List, Magnet, Maximize, RotateCcw, Spline, Trash2 } from "lucide-react";
import {
  computeAutoTangents,
  easyEaseHandles,
  GRAPHIC_DURATION_PROPERTY,
  GRAPHIC_PROGRESS_PROPERTY,
  type KeyframeInterpolation,
  type TimelineKeyframeV2,
  type TimelineLayer
} from "@orreris/shared";
import { copyKeyframes, hasClipboardKeyframes, pasteKeyframes } from "./graph-clipboard";
import { ScrubNumberInput } from "../../components/ScrubNumberInput";
import { ThemedSelect } from "../inspector/controls/ThemedSelect";
import {
  buildEffectGraphTargets,
  buildGraphicGraphTargets,
  clamp,
  clearEffectParamKeyframes,
  clearTransformKeyframes,
  contentGraphTargets,
  graphTargetKey,
  interpolationOptions,
  setGraphTargetInterpolation,
  setGraphTargetLinked,
  clearStyleKeyframes,
  sourceTextGraphTarget,
  speedGraphTarget,
  toggleEffectParamKeyframe,
  toggleSourceTextKeyframe,
  toggleSpeedKeyframe,
  toggleStyleKeyframe,
  toggleTransformKeyframe,
  transformGraphTargets,
  typewriterGraphTarget,
  updateGraphTargetHandle,
  updateGraphTargetKeyframe,
  type GraphTarget
} from "../inspector/keyframeUtils";
import { getPlaybackClock, subscribePlaybackClock } from "../../playback/playback-clock";
import {
  bezierHandlePoint,
  buildCurveScene,
  curveNorm,
  curveValue,
  evaluateGraphTargetValue,
  hasBezierHandles,
  hitTestScene,
  targetKeyframes,
  type GraphCurveScene
} from "./graph-scene";
import {
  clampGraphView,
  curveColor,
  fitGraphView,
  graphRulerTicks,
  normToPx,
  pxToNorm,
  pxToTime,
  timeToPx,
  zoomGraphNorm,
  zoomGraphTime,
  type GraphViewState,
  type PlotRect
} from "./graph-view";
import { useDraftLayer } from "./useDraftLayer";

const RULER_H = 20;

type DragState =
  | {
      mode: "points";
      pointerId: number;
      startX: number;
      startY: number;
      // Initial (time, value) of every dragged keyframe, in its own curve domain.
      entries: Array<{ curveKey: string; keyframeId: string; timeSeconds: number; value: number }>;
      moved: boolean;
    }
  | { mode: "handle"; pointerId: number; curveKey: string; keyframeId: string; handle: "in" | "out" }
  | { mode: "marquee"; pointerId: number; startX: number; startY: number; additive: boolean; baseSelection: string[] }
  | { mode: "pan"; pointerId: number; startX: number; startY: number; startView: GraphViewState }
  | { mode: "ruler"; pointerId: number };

export interface GraphEditorProps {
  layer: TimelineLayer;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  /** Absolute composition seconds (cold tier — chrome only; the playhead line uses the sync clock). */
  currentTime: number;
  onSeek: (seconds: number) => void;
  fps: number;
  /** Open with this property focused (from a timeline diamond / inspector row double-click). */
  focusTargetKey?: string | undefined;
  /** Other SELECTED clips: their matching curves draw faded (read-only, never hit-tested). */
  ghostLayers?: TimelineLayer[] | undefined;
}

export function GraphEditor({ layer, onChange, currentTime, onSeek, fps, focusTargetKey, ghostLayers }: GraphEditorProps) {
  const { displayLayer, isDrafting, beginDraft, updateDraft, commitDraft } = useDraftLayer(layer, onChange);
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);

  const allTargets = useMemo<GraphTarget[]>(
    () => [
      ...transformGraphTargets,
      // Text layers: SOURCE TEXT hold lane + Typewriter reveal curve (both user-visible only
      // once they carry keys — the default visible set filters to animated targets).
      ...(layer.type === "text" ? [sourceTextGraphTarget, typewriterGraphTarget] : []),
      // Video/audio clips with a source asset: the speed-ramp lane (mirrors ClipSpeedControl's gate).
      ...(((layer.type === "video" || layer.type === "audio") && layer.assetId) ? [speedGraphTarget] : []),
      // Media clips: content pan/zoom/crop lanes (mirrors ContentPanel's video/image-only gate).
      ...((layer.type === "video" || layer.type === "image") ? contentGraphTargets : []),
      // Animated (SMIL) graphics: Progress (cycles) + Duration lanes. Empty for static graphics.
      ...buildGraphicGraphTargets(layer),
      ...buildEffectGraphTargets(layer)
    ],
    [layer]
  );
  const colorByKey = useMemo(() => {
    const map = new Map<string, string>();
    allTargets.forEach((target, index) => map.set(graphTargetKey(target), curveColor(index)));
    return map;
  }, [allTargets]);

  const animatedKeys = useMemo(
    () => allTargets.filter((target) => targetKeyframes(displayLayer, target).length > 0).map(graphTargetKey),
    [allTargets, displayLayer]
  );

  // null = auto (all animated curves visible). Materializes on the first manual toggle.
  const [visibleKeys, setVisibleKeys] = useState<string[] | null>(null);
  useEffect(() => {
    setVisibleKeys(null);
    setSelectedIds([]);
  }, [layer.id]);
  useEffect(() => {
    if (focusTargetKey) setVisibleKeys([focusTargetKey]);
  }, [focusTargetKey]);
  const effectiveVisible = visibleKeys ?? animatedKeys;

  const [view, setView] = useState<GraphViewState>(() => fitGraphView(layer.durationSeconds));
  useEffect(() => {
    setView(fitGraphView(layer.durationSeconds));
  }, [layer.id]);

  // TWO-VIEW (user request 2026-07-16, DaVinci model): "curves" = the editable bezier plot;
  // "lanes" = a keyframe editor — EVERY visible parameter as a row of retimeable diamonds on a
  // shared time axis, no value dimension. Same selection set and toolbar (Time/Value/easing/
  // delete) drive both, so switching views never loses context. Choice persists per session.
  const [graphView, setGraphView] = useState<"curves" | "lanes">(() => {
    try {
      // Default to the KEYFRAMES (lanes) view — the dope-sheet is the everyday surface (curves are
      // opt-in). Only an explicit prior "curves" choice overrides it.
      return window.localStorage.getItem("orreris.graph.view") === "curves" ? "curves" : "lanes";
    } catch {
      return "lanes";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("orreris.graph.view", graphView);
    } catch {
      /* private mode */
    }
  }, [graphView]);
  const laneDragRef = useRef<{
    pointerId: number;
    keyframeId: string;
    curveKey: string;
    startClientX: number;
    trackWidthPx: number;
    baseTimeSeconds: number;
  } | null>(null);
  const laneMarqueeRef = useRef<{ pointerId: number; startX: number; startY: number; additive: boolean; baseSelection: string[] } | null>(
    null
  );
  const lanesBodyRef = useRef<HTMLDivElement | null>(null);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 });
  const [marqueeRect, setMarqueeRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [laneMarqueeRect, setLaneMarqueeRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const spaceHeldRef = useRef(false);
  // Single-click-on-line just added a key here — the double-click that follows the same
  // click must not toggle it back off (click 2 lands on the new point).
  const lastAddRef = useRef<{ curveKey: string; timeSeconds: number; at: number } | null>(null);
  // Frozen per-curve normalization during a drag so curves don't re-fit mid-gesture.
  const dragNormsRef = useRef<Map<string, { vMin: number; vMax: number }> | null>(null);
  // Bumped whenever dragNormsRef is (un)set: the ref alone isn't a dep of the `scenes` memo, so
  // the freeze/unfreeze landed one render LATE — a one-frame window where diamonds were placed
  // with the old range while the curve was drawn with the new one (the visible "detach").
  const [dragNormEpoch, setDragNormEpoch] = useState(0);

  const plot: PlotRect = { x: 0, y: RULER_H, width: plotSize.width, height: Math.max(10, plotSize.height - RULER_H) };

  const scenes = useMemo<GraphCurveScene[]>(() => {
    const timeEnd = view.timeStart + view.timeDuration;
    // Sample density follows the plot's pixel width (~2px per sample) so curves stay
    // smooth at any zoom instead of faceting at a fixed 160 points.
    const sampleCount = Math.min(800, Math.max(160, Math.ceil(plotSize.width / 2)));
    return allTargets
      .filter((target) => effectiveVisible.includes(graphTargetKey(target)))
      .map((target) => {
        const key = graphTargetKey(target);
        return buildCurveScene(
          displayLayer,
          target,
          colorByKey.get(key) ?? "#4f9cff",
          Math.max(0, view.timeStart),
          Math.min(displayLayer.durationSeconds, timeEnd),
          sampleCount,
          dragNormsRef.current?.get(key)
        );
      })
      .filter((scene) => scene.keyframes.length > 0 || effectiveVisible.length <= 3);
    // dragNormEpoch: recompute the moment the normalization freeze is set/cleared (see dragNormsRef).
  }, [allTargets, colorByKey, displayLayer, effectiveVisible, view.timeStart, view.timeDuration, plotSize.width, dragNormEpoch]);

  // GHOST CURVES: the other selected clips' curves for the currently visible targets, drawn faded
  // under the primary's. Read-only by construction — never passed to hitTestScene, never selectable.
  // Layer-local time axis (curves compare by clip-relative animation, matching the keyframe model).
  // Effect-scope targets are skipped when the ghost doesn't carry the same effect instance id.
  const ghostScenes = useMemo<GraphCurveScene[]>(() => {
    if (!ghostLayers?.length || ghostLayers.length > 8) return [];
    const timeEnd = view.timeStart + view.timeDuration;
    const sampleCount = Math.min(400, Math.max(120, Math.ceil(plotSize.width / 4)));
    const visibleTargets = allTargets.filter((target) => effectiveVisible.includes(graphTargetKey(target)));
    return ghostLayers.flatMap((ghost) =>
      visibleTargets
        .filter((target) => targetKeyframes(ghost, target).length > 0)
        .map((target) =>
          buildCurveScene(
            ghost,
            target,
            colorByKey.get(graphTargetKey(target)) ?? "#4f9cff",
            Math.max(0, view.timeStart),
            Math.min(ghost.durationSeconds, timeEnd),
            sampleCount
          )
        )
    );
  }, [ghostLayers, allTargets, effectiveVisible, colorByKey, view.timeStart, view.timeDuration, plotSize.width]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedEntries = useMemo(() => {
    const entries: Array<{ curve: GraphCurveScene; keyframe: TimelineKeyframeV2 }> = [];
    for (const curve of scenes) {
      for (const kf of curve.keyframes) {
        if (selectedSet.has(kf.id)) entries.push({ curve, keyframe: kf });
      }
    }
    return entries;
  }, [scenes, selectedSet]);
  const singleSelection = selectedEntries.length === 1 ? selectedEntries[0] : undefined;

  // Prune selection when keyframes disappear (deleted / layer switched).
  useEffect(() => {
    const alive = new Set<string>();
    for (const curve of scenes) for (const kf of curve.keyframes) alive.add(kf.id);
    setSelectedIds((current) => {
      const next = current.filter((id) => alive.has(id));
      return next.length === current.length ? current : next;
    });
  }, [scenes]);

  // ── Canvas sizing (DPR-aware) ────────────────────────────────────────────────
  // Re-runs on view switch: wrapRef points at the CURVES wrap or the LANES container depending on
  // `graphView`, and the observer must follow the live element (lanes reuse plotSize for snap
  // tolerance; curves need fresh sizes after switching back).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      setPlotSize({ width: Math.max(0, rect.width), height: Math.max(0, rect.height) });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [graphView]);

  function prepareCanvas(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
    if (!canvas || plotSize.width < 2 || plotSize.height < 2) return null;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(plotSize.width * dpr);
    const h = Math.round(plotSize.height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, plotSize.width, plotSize.height);
    return ctx;
  }

  // ── Base paint: ruler, grid, curves, points, handles ─────────────────────────
  useEffect(() => {
    const ctx = prepareCanvas(baseCanvasRef.current);
    if (!ctx) return;

    const ticks = graphRulerTicks(view, plot, fps);
    ctx.font = "600 9.5px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (const tick of ticks) {
      const x = timeToPx(view, plot, tick.timeSeconds);
      if (x < plot.x - 1 || x > plot.x + plot.width + 1) continue;
      ctx.strokeStyle = tick.major ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)";
      ctx.beginPath();
      ctx.moveTo(x, tick.major ? 4 : RULER_H - 6);
      ctx.lineTo(x, tick.major ? plot.y + plot.height : RULER_H - 1);
      ctx.stroke();
      if (tick.major && tick.label) {
        ctx.fillStyle = "rgba(255,255,255,0.42)";
        ctx.fillText(tick.label, x + 4, 9);
      }
    }
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(plot.width, RULER_H - 0.5);
    ctx.stroke();

    // Horizontal reference lines at normalized 0 / 0.5 / 1.
    for (const norm of [0, 0.5, 1]) {
      const y = normToPx(view, plot, norm);
      if (y < plot.y || y > plot.y + plot.height) continue;
      ctx.strokeStyle = norm === 0.5 ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.width, y);
      ctx.stroke();
    }

    // Layer bounds shading (outside [0, duration] is dead space).
    const startX = timeToPx(view, plot, 0);
    const endX = timeToPx(view, plot, displayLayer.durationSeconds);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    if (startX > plot.x) ctx.fillRect(plot.x, plot.y, startX - plot.x, plot.height);
    if (endX < plot.x + plot.width) ctx.fillRect(endX, plot.y, plot.x + plot.width - endX, plot.height);

    // Ghost curves first (under the primary's): faded stroke + tiny hollow diamonds, no handles.
    for (const ghost of ghostScenes) {
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = ghost.color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ghost.samples.forEach(([t, norm], index) => {
        const x = timeToPx(view, plot, t);
        const y = normToPx(view, plot, norm);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 0.35;
      for (const kf of ghost.keyframes) {
        const x = timeToPx(view, plot, kf.timeSeconds);
        const y = normToPx(view, plot, curveNorm(ghost, Number(kf.value)));
        if (x < plot.x - 8 || x > plot.x + plot.width + 8) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.strokeStyle = ghost.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(-2.5, -2.5, 5, 5);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    for (const curve of scenes) {
      // Curve stroke.
      ctx.strokeStyle = curve.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      curve.samples.forEach(([t, norm], index) => {
        const x = timeToPx(view, plot, t);
        const y = normToPx(view, plot, norm);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Handles of every selected keyframe (drawn under the points) — dragging one
      // on a non-bezier key converts it to bezier. Skipped for hold/linear-only lanes.
      if (hasBezierHandles(curve.target)) {
        for (const kf of curve.keyframes) {
          if (!selectedSet.has(kf.id)) continue;
          const kx = timeToPx(view, plot, kf.timeSeconds);
          const ky = normToPx(view, plot, curveNorm(curve, Number(kf.value)));
          for (const handle of ["in", "out"] as const) {
            const point = bezierHandlePoint(curve, kf, handle);
            if (!point) continue;
            const hx = timeToPx(view, plot, point.timeSeconds);
            const hy = normToPx(view, plot, curveNorm(curve, point.value));
            ctx.strokeStyle = "rgba(255,255,255,0.4)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(kx, ky);
            ctx.lineTo(hx, hy);
            ctx.stroke();
            ctx.fillStyle = "#e7e9ee";
            ctx.beginPath();
            ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Keyframe diamonds.
      for (const kf of curve.keyframes) {
        const x = timeToPx(view, plot, kf.timeSeconds);
        const y = normToPx(view, plot, curveNorm(curve, Number(kf.value)));
        if (x < plot.x - 8 || x > plot.x + plot.width + 8) continue;
        const selected = selectedSet.has(kf.id);
        const r = selected ? 5 : 4;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = selected ? curve.color : "#12151c";
        ctx.strokeStyle = selected ? "#ffffff" : curve.color;
        ctx.lineWidth = selected ? 1.4 : 1.2;
        ctx.fillRect(-r, -r, r * 2, r * 2);
        ctx.strokeRect(-r, -r, r * 2, r * 2);
        ctx.restore();
      }
    }
  }, [scenes, ghostScenes, view, plotSize, selectedSet, fps, displayLayer.durationSeconds]);

  // ── Overlay paint: playhead + marquee (imperative; playback-clock sync tier) ─
  const overlayStateRef = useRef({ view, plot, layerStart: layer.startSeconds, layerDuration: layer.durationSeconds, marqueeRect });
  overlayStateRef.current = { view, plot, layerStart: layer.startSeconds, layerDuration: layer.durationSeconds, marqueeRect };

  function drawOverlay() {
    const ctx = prepareCanvas(overlayCanvasRef.current);
    if (!ctx) return;
    const state = overlayStateRef.current;
    const clockLayerTime = clamp(getPlaybackClock() - state.layerStart, 0, state.layerDuration);
    const x = timeToPx(state.view, state.plot, clockLayerTime);
    if (x >= state.plot.x - 1 && x <= state.plot.x + state.plot.width + 1) {
      ctx.strokeStyle = "#4f9cff";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x, state.plot.y + state.plot.height);
      ctx.stroke();
      ctx.fillStyle = "#4f9cff";
      ctx.beginPath();
      ctx.moveTo(x - 4, 2);
      ctx.lineTo(x + 4, 2);
      ctx.lineTo(x, 9);
      ctx.closePath();
      ctx.fill();
    }
    if (state.marqueeRect) {
      const { x0, y0, x1, y1 } = state.marqueeRect;
      ctx.fillStyle = "rgba(79,156,255,0.12)";
      ctx.strokeStyle = "rgba(79,156,255,0.7)";
      ctx.lineWidth = 1;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
  }

  // The clock subscription lives for the component's life; call through a ref so it
  // always sees the latest closure (plot size, view) instead of the mount-time one.
  const drawOverlayRef = useRef(drawOverlay);
  drawOverlayRef.current = drawOverlay;
  useEffect(() => {
    drawOverlayRef.current();
    return subscribePlaybackClock(() => drawOverlayRef.current());
  }, []);
  useEffect(() => {
    drawOverlayRef.current();
  }, [view, plotSize, marqueeRect, layer.startSeconds]);

  // ── Snapping ─────────────────────────────────────────────────────────────────
  function snapTime(timeSeconds: number, excludeIds: ReadonlySet<string>): number {
    const clamped = clamp(timeSeconds, 0, displayLayer.durationSeconds);
    if (!snapEnabled) return clamped;
    const tolerance = (view.timeDuration / Math.max(1, plot.width)) * 7; // ~7px
    // Playhead magnet first, then other keyframes, then the frame grid.
    if (Math.abs(clamped - layerTime) <= tolerance) return layerTime;
    for (const curve of scenes) {
      for (const kf of curve.keyframes) {
        if (excludeIds.has(kf.id)) continue;
        if (Math.abs(clamped - kf.timeSeconds) <= tolerance) return kf.timeSeconds;
      }
    }
    const frame = 1 / Math.max(1, fps);
    return clamp(Math.round(clamped / frame) * frame, 0, displayLayer.durationSeconds);
  }

  // ── Selection helpers ────────────────────────────────────────────────────────
  function selectOne(id: string, additive: boolean) {
    setSelectedIds((current) => {
      if (!additive) return current.includes(id) ? current : [id];
      return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    });
  }

  function idsInRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const ids: string[] = [];
    for (const curve of scenes) {
      for (const kf of curve.keyframes) {
        const x = timeToPx(view, plot, kf.timeSeconds);
        const y = normToPx(view, plot, curveNorm(curve, Number(kf.value)));
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) ids.push(kf.id);
      }
    }
    return ids;
  }

  // ── Mutations ────────────────────────────────────────────────────────────────
  function toggleKeyframeOnTarget(target: GraphTarget, timeSeconds: number, value: number) {
    if (target.kind === "transform") {
      onChange((item) => toggleTransformKeyframe(item, target.property, timeSeconds, value));
    } else if (target.kind === "sourceText") {
      // Hold lane: adding captures the text governing that time (see toggleSourceTextKeyframe).
      onChange((item) => toggleSourceTextKeyframe(item, timeSeconds));
    } else if (target.kind === "speed") {
      onChange((item) => toggleSpeedKeyframe(item, timeSeconds));
    } else if (target.kind === "layer") {
      onChange((item) => toggleStyleKeyframe(item, target.property, timeSeconds, value));
    } else {
      onChange((item) => toggleEffectParamKeyframe(item, target.effectId, target.property, timeSeconds, value));
    }
  }

  function deleteSelected() {
    if (!selectedIds.length) return;
    const doomed = new Set(selectedIds);
    onChange((item) => {
      const sourceKeys = (item.sourceTextKeyframes ?? []).filter((key) => !doomed.has(key.id));
      const speedKeys = (item.speedKeyframes ?? []).filter((point, index) => !doomed.has(point.id ?? `speed_${index}`));
      return {
        ...item,
        keyframes: item.keyframes.filter((kf) => !doomed.has(kf.id)),
        animations: (item.animations ?? []).filter((kf) => !doomed.has(kf.id)),
        sourceTextKeyframes: sourceKeys.length ? sourceKeys : undefined,
        speedKeyframes: speedKeys.length ? speedKeys : undefined
      };
    });
    setSelectedIds([]);
  }

  // ── Lanes view: diamond retiming ─────────────────────────────────────────────
  // Drafted like the curve-point drag (no store write per move, one undo on release). The draft is
  // established lazily on the first MOVE so a plain click never commits a phantom edit.
  function laneKeyPointerDown(event: ReactPointerEvent<HTMLButtonElement>, curve: GraphCurveScene, kf: TimelineKeyframeV2) {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    if (event.shiftKey) {
      setSelectedIds((current) => (current.includes(kf.id) ? current.filter((id) => id !== kf.id) : [...current, kf.id]));
    } else if (!selectedSet.has(kf.id)) {
      setSelectedIds([kf.id]);
    }
    const track = (event.currentTarget as HTMLElement).parentElement;
    laneDragRef.current = {
      pointerId: event.pointerId,
      keyframeId: kf.id,
      curveKey: curve.key,
      startClientX: event.clientX,
      trackWidthPx: Math.max(1, track?.clientWidth ?? 1),
      baseTimeSeconds: kf.timeSeconds
    };
  }
  function laneKeyPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = laneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const curve = scenes.find((scene) => scene.key === drag.curveKey);
    if (!curve) return;
    const dt = ((event.clientX - drag.startClientX) / drag.trackWidthPx) * view.timeDuration;
    // No draft until real movement — a plain click must never commit a phantom edit.
    if (!isDrafting && Math.abs(event.clientX - drag.startClientX) < 2) return;
    const nextTime = snapTime(drag.baseTimeSeconds + dt, new Set([drag.keyframeId]));
    updateDraft((item) => updateGraphTargetKeyframe(item, curve.target, drag.keyframeId, { timeSeconds: nextTime }));
  }
  function laneKeyPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = laneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    laneDragRef.current = null;
    commitDraft();
  }

  // ── Lanes view: marquee selection (mirrors the curves-view canvas marquee, DOM-positioned) ──────
  // Row height (26px) and the label column width (132px) are CSS constants (.graph-lane-row /
  // .graph-lane-label in global.css) — duplicated here because lane rows are plain DOM, not canvas,
  // so there's no plot/view rect to hit-test against.
  const LANE_ROW_HEIGHT_PX = 26;
  const LANE_LABEL_WIDTH_PX = 132;
  function keyframeIdsInLaneRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const trackWidth = Math.max(1, (lanesBodyRef.current?.clientWidth ?? 0) - LANE_LABEL_WIDTH_PX);
    const ids: string[] = [];
    scenes.forEach((curve, index) => {
      const rowTop = index * LANE_ROW_HEIGHT_PX;
      const rowBottom = rowTop + LANE_ROW_HEIGHT_PX;
      if (rowBottom < minY || rowTop > maxY) return;
      for (const kf of curve.keyframes) {
        const leftPercent = ((kf.timeSeconds - view.timeStart) / Math.max(1e-4, view.timeDuration)) * 100;
        const px = LANE_LABEL_WIDTH_PX + (leftPercent / 100) * trackWidth;
        if (px >= minX && px <= maxX) ids.push(kf.id);
      }
    });
    return ids;
  }
  function laneBodyPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Diamonds/rows that own the pointerdown already stopPropagation, so this only fires on
    // genuinely empty lane space.
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    laneMarqueeRef.current = { pointerId: event.pointerId, startX: x, startY: y, additive: event.shiftKey, baseSelection: event.shiftKey ? selectedIds : [] };
    setLaneMarqueeRect({ x0: x, y0: y, x1: x, y1: y });
  }
  function laneBodyPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = laneMarqueeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setLaneMarqueeRect({ x0: drag.startX, y0: drag.startY, x1: x, y1: y });
    const inside = keyframeIdsInLaneRect(drag.startX, drag.startY, x, y);
    setSelectedIds(drag.additive ? Array.from(new Set([...drag.baseSelection, ...inside])) : inside);
  }
  function laneBodyPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = laneMarqueeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    laneMarqueeRef.current = null;
    setLaneMarqueeRect(null);
  }

  /** Double-click a lane diamond deletes just that key (mirrors deleteSelected's per-track filters). */
  function laneDeleteKeyframe(keyframeId: string) {
    onChange((item) => {
      const sourceKeys = (item.sourceTextKeyframes ?? []).filter((key) => key.id !== keyframeId);
      const speedKeys = (item.speedKeyframes ?? []).filter((point, index) => (point.id ?? `speed_${index}`) !== keyframeId);
      return {
        ...item,
        keyframes: item.keyframes.filter((kf) => kf.id !== keyframeId),
        animations: (item.animations ?? []).filter((kf) => kf.id !== keyframeId),
        sourceTextKeyframes: sourceKeys.length ? sourceKeys : undefined,
        speedKeyframes: speedKeys.length ? speedKeys : undefined
      };
    });
    setSelectedIds((current) => current.filter((id) => id !== keyframeId));
  }

  function nudgeSelected(deltaTime: number, valueSteps: number) {
    if (!selectedEntries.length) return;
    const moves = selectedEntries.map(({ curve, keyframe }) => ({
      target: curve.target,
      keyframeId: keyframe.id,
      timeSeconds: clamp(keyframe.timeSeconds + deltaTime, 0, displayLayer.durationSeconds),
      // Arrow-up must move the diamond UP on screen; inverted-Y curves (position.y) flip the sign.
      value: clamp(
        Number(keyframe.value) + valueSteps * curve.target.step * (curve.invertY ? -1 : 1),
        curve.target.min,
        curve.target.max
      )
    }));
    onChange((item) =>
      moves.reduce(
        (acc, move) =>
          updateGraphTargetKeyframe(acc, move.target, move.keyframeId, {
            timeSeconds: move.timeSeconds,
            value: move.value
          }),
        item
      )
    );
  }

  function applyInterpolation(interpolation: KeyframeInterpolation) {
    if (!selectedEntries.length) return;
    const entries = selectedEntries.map(({ curve, keyframe }) => ({ target: curve.target, id: keyframe.id }));
    onChange((item) =>
      entries.reduce((acc, entry) => setGraphTargetInterpolation(acc, entry.target, entry.id, interpolation), item)
    );
  }

  /** Easing presets — all write explicit bezier handles via the SHARED helpers,
   *  so authored curves render identically in preview and Remotion export. */
  function applyEasingPreset(kind: "auto" | "easeBoth" | "easeIn" | "easeOut") {
    if (!selectedEntries.length) return;
    const entries = selectedEntries.map(({ curve, keyframe }) => {
      const index = curve.keyframes.findIndex((kf) => kf.id === keyframe.id);
      const prev = curve.keyframes[index - 1];
      const next = curve.keyframes[index + 1];
      const handles =
        kind === "auto"
          ? computeAutoTangents(
              prev ? { timeSeconds: prev.timeSeconds, value: Number(prev.value) } : undefined,
              { timeSeconds: keyframe.timeSeconds, value: Number(keyframe.value) },
              next ? { timeSeconds: next.timeSeconds, value: Number(next.value) } : undefined
            )
          : easyEaseHandles(kind === "easeBoth" ? "both" : kind === "easeIn" ? "in" : "out");
      return { target: curve.target, id: keyframe.id, handles };
    });
    onChange((item) =>
      entries.reduce((acc, entry) => {
        let next = setGraphTargetInterpolation(acc, entry.target, entry.id, "bezier");
        if (entry.handles.in) next = updateGraphTargetHandle(next, entry.target, entry.id, "in", entry.handles.in, false);
        if (entry.handles.out) next = updateGraphTargetHandle(next, entry.target, entry.id, "out", entry.handles.out, false);
        return next;
      }, item)
    );
  }

  function copySelection() {
    copyKeyframes(selectedEntries.map(({ curve, keyframe }) => ({ curveKey: curve.key, keyframe })));
  }

  function pasteAtPlayhead() {
    if (!hasClipboardKeyframes()) return;
    let pastedIds: string[] = [];
    onChange((item) => {
      const result = pasteKeyframes(item, allTargets, layerTime, fps);
      pastedIds = result.ids;
      return result.layer;
    });
    if (pastedIds.length) setSelectedIds(pastedIds);
  }

  // ── Pointer state machine (on the overlay canvas) ────────────────────────────
  function canvasPoint(event: ReactPointerEvent | ReactWheelEvent): { x: number; y: number } {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    // Claim keyboard focus for the workspace so F / Delete / arrows land here.
    (wrapRef.current?.closest(".graph-workspace") as HTMLElement | null)?.focus();
    const { x, y } = canvasPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (event.button === 1 || spaceHeldRef.current) {
      dragRef.current = { mode: "pan", pointerId: event.pointerId, startX: x, startY: y, startView: view };
      return;
    }
    if (event.button !== 0) return;

    if (y < RULER_H) {
      dragRef.current = { mode: "ruler", pointerId: event.pointerId };
      onSeek(layer.startSeconds + clamp(pxToTime(view, plot, x), 0, displayLayer.durationSeconds));
      return;
    }

    const hit = hitTestScene(scenes, selectedSet, view, plot, x, y);
    if (hit?.type === "handle") {
      selectOne(hit.keyframeId, false);
      beginDraft();
      dragNormsRef.current = new Map(scenes.map((scene) => [scene.key, { vMin: scene.vMin, vMax: scene.vMax }]));
      setDragNormEpoch((epoch) => epoch + 1);
      // Grabbing a handle on a non-bezier keyframe converts it to bezier so the
      // handle actually shapes the curve. Seed BOTH handles with linear surrogates —
      // the evaluator's default for a missing out-handle is dy 0 (ease), which would
      // make the curve jump away from the drawn handles at drag start.
      const hitCurve = scenes.find((scene) => scene.key === hit.curveKey);
      const hitKeyframe = hitCurve?.keyframes.find((kf) => kf.id === hit.keyframeId);
      if (hitCurve && hitKeyframe && hitKeyframe.interpolation !== "bezier") {
        updateDraft((item) => {
          let next = setGraphTargetInterpolation(item, hitCurve.target, hit.keyframeId, "bezier");
          if (!hitKeyframe.temporal.in) {
            next = updateGraphTargetHandle(next, hitCurve.target, hit.keyframeId, "in", { dx: -0.33, dy: -0.33 }, false);
          }
          if (!hitKeyframe.temporal.out) {
            next = updateGraphTargetHandle(next, hitCurve.target, hit.keyframeId, "out", { dx: 0.33, dy: 0.33 }, false);
          }
          // Seeding wrote linked:false — a fresh bezier key starts LINKED.
          return setGraphTargetLinked(next, hitCurve.target, hit.keyframeId, hitKeyframe.temporal.linked !== false);
        });
      }
      dragRef.current = { mode: "handle", pointerId: event.pointerId, curveKey: hit.curveKey, keyframeId: hit.keyframeId, handle: hit.handle };
      return;
    }
    if (hit?.type === "point") {
      const alreadySelected = selectedSet.has(hit.keyframeId);
      const nextIds = event.shiftKey
        ? alreadySelected
          ? selectedIds.filter((id) => id !== hit.keyframeId)
          : [...selectedIds, hit.keyframeId]
        : alreadySelected
          ? selectedIds
          : [hit.keyframeId];
      setSelectedIds(nextIds);
      if (event.shiftKey && alreadySelected) return; // deselected — no drag

      const draggedSet = new Set(nextIds);
      const entries: Array<{ curveKey: string; keyframeId: string; timeSeconds: number; value: number }> = [];
      for (const curve of scenes) {
        for (const kf of curve.keyframes) {
          if (draggedSet.has(kf.id)) {
            entries.push({ curveKey: curve.key, keyframeId: kf.id, timeSeconds: kf.timeSeconds, value: Number(kf.value) });
          }
        }
      }
      beginDraft();
      dragNormsRef.current = new Map(scenes.map((scene) => [scene.key, { vMin: scene.vMin, vMax: scene.vMax }]));
      setDragNormEpoch((epoch) => epoch + 1);
      dragRef.current = { mode: "points", pointerId: event.pointerId, startX: x, startY: y, entries, moved: false };
      return;
    }

    // Click ON the curve line adds a keyframe right there (single tap — the plus
    // cursor promises it). Marquee stays available from empty space.
    if (hit?.type === "curve") {
      const curve = scenes.find((scene) => scene.key === hit.curveKey);
      if (curve) {
        const timeSeconds = snapTime(clamp(pxToTime(view, plot, x), 0, displayLayer.durationSeconds), new Set());
        const value = evaluateGraphTargetValue(displayLayer, curve.target, timeSeconds);
        lastAddRef.current = { curveKey: curve.key, timeSeconds, at: performance.now() };
        toggleKeyframeOnTarget(curve.target, timeSeconds, value);
        return;
      }
    }

    // Empty space → marquee.
    dragRef.current = {
      mode: "marquee",
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      additive: event.shiftKey,
      baseSelection: event.shiftKey ? selectedIds : []
    };
    if (!event.shiftKey) setSelectedIds([]);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      // Hover feedback (no active drag): hand over keys/handles, plus over the curve
      // line (add-key affordance), plain arrow on empty plot, resize on the ruler.
      const { x, y } = canvasPoint(event);
      const hit = y < RULER_H ? undefined : hitTestScene(scenes, selectedSet, view, plot, x, y);
      event.currentTarget.style.cursor =
        y < RULER_H ? "col-resize" : hit ? (hit.type === "curve" ? "crosshair" : "grab") : "default";
      return;
    }
    event.currentTarget.style.cursor = drag.mode === "ruler" ? "col-resize" : "grabbing";
    const { x, y } = canvasPoint(event);

    if (drag.mode === "pan") {
      const dt = (drag.startX - x) * (drag.startView.timeDuration / Math.max(1, plot.width));
      const dn = (y - drag.startY) * ((drag.startView.normMax - drag.startView.normMin) / Math.max(1, plot.height));
      setView(
        clampGraphView(
          {
            ...drag.startView,
            timeStart: drag.startView.timeStart + dt,
            normMin: drag.startView.normMin - dn,
            normMax: drag.startView.normMax - dn
          },
          displayLayer.durationSeconds
        )
      );
      return;
    }

    if (drag.mode === "ruler") {
      onSeek(layer.startSeconds + clamp(pxToTime(view, plot, x), 0, displayLayer.durationSeconds));
      return;
    }

    if (drag.mode === "marquee") {
      const rect = { x0: drag.startX, y0: drag.startY, x1: x, y1: y };
      setMarqueeRect(rect);
      const inside = idsInRect(rect.x0, rect.y0, rect.x1, rect.y1);
      setSelectedIds(drag.additive ? Array.from(new Set([...drag.baseSelection, ...inside])) : inside);
      return;
    }

    if (drag.mode === "points") {
      let dxPx = x - drag.startX;
      let dyPx = y - drag.startY;
      if (event.shiftKey) {
        // Axis lock to the dominant direction.
        if (Math.abs(dxPx) >= Math.abs(dyPx)) dyPx = 0;
        else dxPx = 0;
      }
      const dt = dxPx * (view.timeDuration / Math.max(1, plot.width));
      const dNorm = -dyPx * ((view.normMax - view.normMin) / Math.max(1, plot.height));
      const excluded = new Set(drag.entries.map((entry) => entry.keyframeId));
      drag.moved = drag.moved || Math.hypot(dxPx, dyPx) > 2;
      const sceneByKey = new Map(scenes.map((scene) => [scene.key, scene]));
      updateDraft((item) =>
        drag.entries.reduce((acc, entry) => {
          const curve = sceneByKey.get(entry.curveKey);
          if (!curve) return acc;
          const nextTime = snapTime(entry.timeSeconds + dt, excluded);
          const nextValue = clamp(
            curveValue(curve, curveNorm(curve, entry.value) + dNorm),
            curve.target.min,
            curve.target.max
          );
          return updateGraphTargetKeyframe(acc, curve.target, entry.keyframeId, {
            timeSeconds: nextTime,
            value: nextValue
          });
        }, item)
      );
      return;
    }

    if (drag.mode === "handle") {
      const curve = scenes.find((scene) => scene.key === drag.curveKey);
      const keyframe = curve?.keyframes.find((kf) => kf.id === drag.keyframeId);
      if (!curve || !keyframe) return;
      const point = bezierHandlePoint(curve, keyframe, drag.handle);
      if (!point) return;
      const targetTime = pxToTime(view, plot, x);
      const targetValue = curveValue(curve, pxToNorm(view, plot, y));
      const duration = Math.max(1e-4, Math.abs(keyframe.timeSeconds - point.neighbor.timeSeconds));
      const valueDelta =
        Number(drag.handle === "in" ? keyframe.value : point.neighbor.value) -
        Number(drag.handle === "in" ? point.neighbor.value : keyframe.value);
      const dx =
        drag.handle === "in"
          ? clamp((targetTime - keyframe.timeSeconds) / duration, -0.98, -0.02)
          : clamp((targetTime - keyframe.timeSeconds) / duration, 0.02, 0.98);
      const dy =
        Math.abs(valueDelta) < 1e-4 ? 0 : clamp((targetValue - Number(keyframe.value)) / valueDelta, -3, 3);

      // Linked mirroring must preserve the DISPLAY-SPACE tangent line through the key.
      // The in/out fractions live in DIFFERENT segment spaces (each side's duration and
      // value delta), so negating {dx,dy} only works when both neighbors match — at a
      // value peak it produced a cusp (both handles below the key). Instead: compute the
      // dragged handle's display slope and re-express it in the opposite segment's space.
      const linked = !event.altKey && keyframe.temporal.linked !== false;
      const opposite: "in" | "out" = drag.handle === "in" ? "out" : "in";
      const oppositePoint = bezierHandlePoint(curve, keyframe, opposite);
      let oppositeHandle: { dx: number; dy: number } | null = null;
      if (linked && oppositePoint) {
        const displayDt = dx * duration; // signed time offset of the dragged handle
        const displayDv = dy * valueDelta; // signed value offset of the dragged handle
        const slope = displayDt === 0 ? 0 : displayDv / displayDt;
        const oppositeDuration = Math.max(1e-4, Math.abs(keyframe.timeSeconds - oppositePoint.neighbor.timeSeconds));
        const oppositeValueDelta =
          Number(opposite === "in" ? keyframe.value : oppositePoint.neighbor.value) -
          Number(opposite === "in" ? oppositePoint.neighbor.value : keyframe.value);
        // Keep the opposite handle's own reach (its dx), align its direction to the tangent.
        const oppositeDx = clamp(
          Math.abs(oppositePoint.storedHandle.dx) * (opposite === "in" ? -1 : 1),
          opposite === "in" ? -0.98 : 0.02,
          opposite === "in" ? -0.02 : 0.98
        );
        const oppositeDisplayDt = oppositeDx * oppositeDuration;
        const oppositeDisplayDv = slope * oppositeDisplayDt;
        const oppositeDy =
          Math.abs(oppositeValueDelta) < 1e-4 ? 0 : clamp(oppositeDisplayDv / oppositeValueDelta, -3, 3);
        oppositeHandle = { dx: oppositeDx, dy: oppositeDy };
      }

      updateDraft((item) => {
        let next = updateGraphTargetHandle(item, curve.target, keyframe.id, drag.handle, { dx, dy }, false);
        if (oppositeHandle) {
          next = updateGraphTargetHandle(next, curve.target, keyframe.id, opposite, oppositeHandle, false);
        }
        // updateGraphTargetHandle(…, false) stamps linked:false — restore the real state
        // (Alt permanently splits; otherwise the key stays linked).
        return setGraphTargetLinked(next, curve.target, keyframe.id, event.altKey ? false : keyframe.temporal.linked !== false);
      });
    }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.style.cursor = "default";
    if (drag.mode === "marquee") {
      setMarqueeRect(null);
      return;
    }
    if (drag.mode === "points" || drag.mode === "handle") {
      dragNormsRef.current = null;
      setDragNormEpoch((epoch) => epoch + 1);
      // NOTE: a pure click on a point used to seek the playhead to it ("AE behavior") — removed
      // 2026-07-16 by user request: clicking a keyframe selects it and must NOT move the playhead.
      commitDraft();
    }
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLCanvasElement>) {
    const { x, y } = canvasPoint(event as unknown as ReactPointerEvent<HTMLCanvasElement>);
    if (y < RULER_H) return;
    const hit = hitTestScene(scenes, selectedSet, view, plot, x, y);
    if (hit?.type === "point") {
      const curve = scenes.find((scene) => scene.key === hit.curveKey);
      const keyframe = curve?.keyframes.find((kf) => kf.id === hit.keyframeId);
      if (!curve || !keyframe) return;
      // Guard: single-click just ADDED this key — the trailing dblclick must not delete it.
      const lastAdd = lastAddRef.current;
      if (
        lastAdd &&
        lastAdd.curveKey === curve.key &&
        Math.abs(lastAdd.timeSeconds - keyframe.timeSeconds) < 1e-3 &&
        performance.now() - lastAdd.at < 700
      ) {
        return;
      }
      toggleKeyframeOnTarget(curve.target, keyframe.timeSeconds, Number(keyframe.value));
    }
  }

  function handleWheel(event: ReactWheelEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const { x, y } = canvasPoint(event);
    const factor = Math.pow(1.0016, event.deltaY);
    if (event.ctrlKey || event.metaKey) {
      setView((current) =>
        clampGraphView(
          zoomGraphNorm(zoomGraphTime(current, pxToTime(current, plot, x), factor), pxToNorm(current, plot, y), factor),
          displayLayer.durationSeconds
        )
      );
    } else if (event.shiftKey) {
      setView((current) =>
        clampGraphView(zoomGraphNorm(current, pxToNorm(current, plot, y), factor), displayLayer.durationSeconds)
      );
    } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      setView((current) =>
        clampGraphView(
          { ...current, timeStart: current.timeStart + event.deltaX * (current.timeDuration / Math.max(1, plot.width)) },
          displayLayer.durationSeconds
        )
      );
    } else {
      setView((current) =>
        clampGraphView(zoomGraphTime(current, pxToTime(current, plot, x), factor), displayLayer.durationSeconds)
      );
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
    if (event.key === " ") {
      spaceHeldRef.current = true;
      return; // don't preventDefault — space still toggles playback upstream if bound
    }
    if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      setView(fitGraphView(displayLayer.durationSeconds));
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelected();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "c" || event.key === "C")) {
      event.preventDefault();
      copySelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "v" || event.key === "V")) {
      event.preventDefault();
      pasteAtPlayhead();
      return;
    }
    const frame = 1 / Math.max(1, fps);
    const big = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      nudgeSelected(-frame * big, 0);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      nudgeSelected(frame * big, 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      nudgeSelected(0, big);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      nudgeSelected(0, -big);
    } else if (event.key === "Escape") {
      setSelectedIds([]);
    }
  }

  function handleKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === " ") spaceHeldRef.current = false;
  }

  // ── Property tree ────────────────────────────────────────────────────────────
  // EVERY target in `allTargets` must land in some group here — a target with no tree row is
  // unreachable (the default visible set only auto-shows ANIMATED curves, so an unkeyed lane with
  // no row can never be toggled on; this is exactly how the speed lane shipped invisible).
  const treeGroups = useMemo(() => {
    const transform = { label: "Transform", targets: transformGraphTargets };
    const contentTargets = allTargets.filter((target) => target.kind === "layer" && target.property.startsWith("content."));
    const speedTargets = allTargets.filter((target) => target.kind === "speed");
    const textTargets = allTargets.filter((target) => target.kind === "sourceText" || (target.kind === "layer" && target.property === "textRevealProgress"));
    // Animated-graphic lanes get their own group so they can be toggled visible even before they
    // carry keys (the default visible set only auto-shows ANIMATED curves).
    const graphicTargets = allTargets.filter(
      (target) =>
        target.kind === "layer" &&
        (target.property === GRAPHIC_PROGRESS_PROPERTY || target.property === GRAPHIC_DURATION_PROPERTY)
    );
    const byEffect = new Map<string, { label: string; targets: GraphTarget[] }>();
    for (const target of allTargets) {
      if (target.kind !== "effect") continue;
      const [effectName] = target.label.split(" · ");
      const group = byEffect.get(target.effectId) ?? { label: effectName ?? "Effect", targets: [] };
      group.targets.push(target);
      byEffect.set(target.effectId, group);
    }
    return [
      transform,
      ...(contentTargets.length ? [{ label: "Content", targets: contentTargets }] : []),
      ...(speedTargets.length ? [{ label: "Speed", targets: speedTargets }] : []),
      ...(textTargets.length ? [{ label: "Text", targets: textTargets }] : []),
      ...(graphicTargets.length ? [{ label: "Graphic", targets: graphicTargets }] : []),
      ...byEffect.values()
    ];
  }, [allTargets]);

  function toggleVisible(key: string) {
    setVisibleKeys((current) => {
      const base = current ?? animatedKeys;
      return base.includes(key) ? base.filter((item) => item !== key) : [...base, key];
    });
  }

  const interpolationValue =
    selectedEntries.length > 0 &&
    selectedEntries.every((entry) => entry.keyframe.interpolation === selectedEntries[0]!.keyframe.interpolation)
      ? selectedEntries[0]!.keyframe.interpolation
      : "";

  return (
    <div className="graph-workspace" tabIndex={0} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp}>
      <div className="graph-workspace-tree" aria-label="Animated properties">
        {treeGroups.map((group) => (
          <div className="graph-tree-group" key={group.label}>
            <span className="graph-tree-group-label">{group.label}</span>
            {group.targets.map((target) => {
              const key = graphTargetKey(target);
              const count = targetKeyframes(displayLayer, target).length;
              const visible = effectiveVisible.includes(key);
              const shortLabel = target.kind === "effect" ? target.label.split(" · ")[1] ?? target.label : target.label;
              return (
                <div className={`graph-tree-row${visible ? " is-visible" : ""}${count ? " is-animated" : ""}`} key={key}>
                  <button
                    className="graph-tree-row-main"
                    type="button"
                    title={`${target.label} — ${count} keyframe${count === 1 ? "" : "s"}. Click: show/hide curve. Double-click: solo.`}
                    onClick={() => toggleVisible(key)}
                    onDoubleClick={() => setVisibleKeys([key])}
                  >
                    <span className="graph-tree-swatch" style={{ background: count ? colorByKey.get(key) : "transparent" }} />
                    <span className="graph-tree-label">{shortLabel}</span>
                    {count ? <span className="graph-tree-count">{count}</span> : null}
                  </button>
                  {count ? (
                    <button
                      className="graph-tree-row-clear"
                      type="button"
                      title={`Reset ${shortLabel} — remove all ${count} keyframe${count === 1 ? "" : "s"}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onChange((item) => {
                          if (target.kind === "transform") return clearTransformKeyframes(item, target.property);
                          if (target.kind === "sourceText") return { ...item, sourceTextKeyframes: undefined };
                          if (target.kind === "speed") return { ...item, speedKeyframes: undefined };
                          if (target.kind === "layer") return clearStyleKeyframes(item, target.property);
                          return clearEffectParamKeyframes(item, target.effectId, target.property);
                        });
                        setSelectedIds([]);
                      }}
                    >
                      <RotateCcw size={10} />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="graph-workspace-main">
        <div className="graph-toolbar">
          <div className="graph-toolbar-views" role="tablist" aria-label="Graph view">
            <button
              className={graphView === "curves" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={graphView === "curves"}
              title="Curve view — editable bezier graph with value axis"
              onClick={() => setGraphView("curves")}
            >
              <Spline size={12} />
            </button>
            <button
              className={graphView === "lanes" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={graphView === "lanes"}
              title="Keyframe view — all parameters as retimeable diamond lanes (drag = retime, double-click = delete)"
              onClick={() => setGraphView("lanes")}
            >
              <List size={12} />
            </button>
          </div>
          <span className="graph-toolbar-divider" />
          <button
            className={snapEnabled ? "is-active" : ""}
            type="button"
            title="Snapping — frames, keyframes, playhead"
            onClick={() => setSnapEnabled((value) => !value)}
          >
            <Magnet size={12} />
          </button>
          <button type="button" title="Fit view (F)" onClick={() => setView(fitGraphView(displayLayer.durationSeconds))}>
            <Maximize size={12} />
          </button>
          <span className="graph-toolbar-divider" />
          <span className="graph-toolbar-count">
            <Diamond size={10} />
            {selectedEntries.length ? `${selectedEntries.length} selected` : `${scenes.reduce((sum, scene) => sum + scene.keyframes.length, 0)} keys`}
          </span>
          {selectedEntries.length ? (
            <>
              <span className="graph-toolbar-divider" />
              <div className="graph-toolbar-presets" aria-label="Easing presets">
                <button type="button" title="Easy Ease — smooth in and out" onClick={() => applyEasingPreset("easeBoth")}>
                  Ease
                </button>
                <button type="button" title="Ease In — smooth arrival" onClick={() => applyEasingPreset("easeIn")}>
                  In
                </button>
                <button type="button" title="Ease Out — smooth departure" onClick={() => applyEasingPreset("easeOut")}>
                  Out
                </button>
                <button type="button" title="Auto tangents — smooth through-motion" onClick={() => applyEasingPreset("auto")}>
                  Auto
                </button>
                <button type="button" title="Linear" onClick={() => applyInterpolation("linear")}>
                  Lin
                </button>
                <button type="button" title="Hold — freeze until the next keyframe" onClick={() => applyInterpolation("hold")}>
                  Hold
                </button>
              </div>
              <div className="graph-toolbar-interp">
                <ThemedSelect
                  ariaLabel="Interpolation"
                  value={interpolationValue}
                  options={[
                    ...(interpolationValue === "" ? [{ value: "", label: "Mixed" }] : []),
                    ...interpolationOptions.map((option) => ({ value: option.value, label: option.label }))
                  ]}
                  onChange={(next) => {
                    if (next) applyInterpolation(next as KeyframeInterpolation);
                  }}
                />
              </div>
              {singleSelection ? (
                <>
                  <label className="graph-toolbar-field">
                    <span>Time</span>
                    <ScrubNumberInput
                      className="effect-slider-number"
                      min={0}
                      max={displayLayer.durationSeconds}
                      step={1 / Math.max(1, fps)}
                      value={Number(singleSelection.keyframe.timeSeconds.toFixed(3))}
                      onScrubChange={(next) =>
                        onChange((item) =>
                          updateGraphTargetKeyframe(item, singleSelection.curve.target, singleSelection.keyframe.id, {
                            timeSeconds: clamp(next, 0, displayLayer.durationSeconds)
                          })
                        )
                      }
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (!Number.isFinite(next)) return;
                        onChange((item) =>
                          updateGraphTargetKeyframe(item, singleSelection.curve.target, singleSelection.keyframe.id, {
                            timeSeconds: clamp(next, 0, displayLayer.durationSeconds)
                          })
                        );
                      }}
                    />
                  </label>
                  <label className="graph-toolbar-field">
                    <span>Value</span>
                    <ScrubNumberInput
                      className="effect-slider-number"
                      min={singleSelection.curve.target.min}
                      max={singleSelection.curve.target.max}
                      step={singleSelection.curve.target.step}
                      value={Number(Number(singleSelection.keyframe.value).toFixed(3))}
                      onScrubChange={(next) =>
                        onChange((item) =>
                          updateGraphTargetKeyframe(item, singleSelection.curve.target, singleSelection.keyframe.id, {
                            value: clamp(next, singleSelection.curve.target.min, singleSelection.curve.target.max)
                          })
                        )
                      }
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (!Number.isFinite(next)) return;
                        onChange((item) =>
                          updateGraphTargetKeyframe(item, singleSelection.curve.target, singleSelection.keyframe.id, {
                            value: clamp(next, singleSelection.curve.target.min, singleSelection.curve.target.max)
                          })
                        );
                      }}
                    />
                  </label>
                  <button
                    className={singleSelection.keyframe.temporal.linked !== false ? "is-active" : ""}
                    type="button"
                    title={singleSelection.keyframe.temporal.linked !== false ? "Linked handles (Alt-drag to split)" : "Split handles"}
                    onClick={() =>
                      onChange((item) =>
                        setGraphTargetLinked(
                          item,
                          singleSelection.curve.target,
                          singleSelection.keyframe.id,
                          singleSelection.keyframe.temporal.linked === false
                        )
                      )
                    }
                  >
                    {singleSelection.keyframe.temporal.linked !== false ? "Linked" : "Split"}
                  </button>
                </>
              ) : null}
              <button type="button" title="Delete selected keyframes (Del)" onClick={deleteSelected}>
                <Trash2 size={12} />
              </button>
            </>
          ) : null}
        </div>

        {graphView === "curves" ? (
          <div className="graph-canvas-wrap" ref={wrapRef}>
            <canvas className="graph-canvas-base" ref={baseCanvasRef} />
            <canvas
              className={`graph-canvas-overlay${isDrafting ? " is-drafting" : ""}`}
              ref={overlayCanvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onDoubleClick={handleDoubleClick}
              onWheel={handleWheel}
            />
            {scenes.length === 0 ? (
              <div className="graph-canvas-empty">
                <Diamond size={15} />
                No animated properties yet — toggle a diamond in the inspector, or pick a property on the left and
                double-click the plot to add a key.
              </div>
            ) : null}
          </div>
        ) : (
          // LANES: percent-positioned diamonds inside each row (no canvas, no value axis) over the
          // SAME view window as the curves, so zoom/fit carries across the view switch.
          <div className="graph-lanes" ref={wrapRef} aria-label="Keyframe lanes">
            <div className="graph-lanes-ruler">
              {[0, 1, 2, 3, 4].map((index) => {
                const t = view.timeStart + (view.timeDuration * index) / 4;
                return (
                  <span key={index} className="graph-lanes-tick" style={{ left: `${index * 25}%` }}>
                    {t.toFixed(1)}s
                  </span>
                );
              })}
            </div>
            <div
              className="graph-lanes-body"
              ref={lanesBodyRef}
              onPointerDown={laneBodyPointerDown}
              onPointerMove={laneBodyPointerMove}
              onPointerUp={laneBodyPointerUp}
              onPointerCancel={laneBodyPointerUp}
            >
              <div
                className="graph-lanes-playhead"
                style={{ left: `${clamp(((layerTime - view.timeStart) / view.timeDuration) * 100, 0, 100)}%` }}
              />
              {laneMarqueeRect ? (
                <div
                  className="graph-lanes-marquee"
                  style={{
                    left: Math.min(laneMarqueeRect.x0, laneMarqueeRect.x1),
                    top: Math.min(laneMarqueeRect.y0, laneMarqueeRect.y1),
                    width: Math.abs(laneMarqueeRect.x1 - laneMarqueeRect.x0),
                    height: Math.abs(laneMarqueeRect.y1 - laneMarqueeRect.y0)
                  }}
                />
              ) : null}
              {scenes.map((curve) => {
                const shortLabel =
                  curve.target.kind === "effect" ? curve.target.label.split(" · ")[1] ?? curve.target.label : curve.target.label;
                return (
                  <div className="graph-lane-row" key={curve.key}>
                    <span className="graph-lane-label" title={curve.target.label}>
                      <i style={{ background: curve.color }} />
                      {shortLabel}
                    </span>
                    <div className="graph-lane-track">
                      {curve.keyframes.map((kf) => {
                        const leftPercent = ((kf.timeSeconds - view.timeStart) / Math.max(1e-4, view.timeDuration)) * 100;
                        if (leftPercent < -2 || leftPercent > 102) return null;
                        const selected = selectedSet.has(kf.id);
                        return (
                          <button
                            key={kf.id}
                            type="button"
                            className={`graph-lane-key${selected ? " is-selected" : ""}`}
                            style={{ left: `${leftPercent}%`, borderColor: curve.color, background: selected ? curve.color : undefined }}
                            title={`${curve.target.label} @ ${kf.timeSeconds.toFixed(2)}s = ${Number(kf.value).toFixed(2)} — drag to retime, double-click to delete`}
                            onPointerDown={(event) => laneKeyPointerDown(event, curve, kf)}
                            onPointerMove={laneKeyPointerMove}
                            onPointerUp={laneKeyPointerUp}
                            onPointerCancel={laneKeyPointerUp}
                            onDoubleClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              laneDeleteKeyframe(kf.id);
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {scenes.length === 0 ? (
                <div className="graph-canvas-empty">
                  <Diamond size={15} />
                  No animated properties yet — toggle a diamond in the inspector to start.
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
