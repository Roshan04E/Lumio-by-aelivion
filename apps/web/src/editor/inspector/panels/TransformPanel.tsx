import { useState, useRef, useEffect, type PointerEvent as ReactPointerEvent } from "react";
import {
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Diamond,
  Eye,
  Maximize2,
  Move,
  MoveHorizontal,
  MoveVertical,
  Rotate3d,
  RotateCw,
  SlidersHorizontal,
  Sparkles
} from "lucide-react";
import {
  evaluateTimelineTransform,
  evaluateTimelineEffectParam,
  getLayerAnimations,
  type BlendMode,
  type KeyframeInterpolation,
  type TimelineKeyframeV2
} from "@reelforge/shared";

// ── Perspective control mapping ─────────────────────────────────────────────────────────────────────
// All renderers store CSS `perspective(N px)`, where a SMALLER N = STRONGER 3D foreshortening (it's a camera
// DISTANCE) and N=0 = flat (omitted). Correct, but counter-intuitive as a control: a raw 0→4000 px slider
// feels inverted (more value = flatter) AND jumps flat→extreme the instant it leaves 0. So the inspector
// exposes a monotonic "depth" 0..100 (0 = flat → 100 = strongest tilt) and converts to/from the stored px
// here — the stored `transform.perspective` field, the three renderers, and keyframes are all unchanged.
const PERSPECTIVE_DEPTH_MAX = 100;
const PERSPECTIVE_PX_FLAT = 4000; // near-flat (camera far) — the depth just above 0
const PERSPECTIVE_PX_STRONG = 350; // strongest tilt (camera close) — depth = max

/** Stored CSS-perspective px → display depth 0..100 (0 = flat). Inverse of {@link perspectiveDepthToPx}. */
function perspectivePxToDepth(px: number): number {
  if (!(px > 0)) return 0;
  const d = (PERSPECTIVE_DEPTH_MAX * (PERSPECTIVE_PX_FLAT - px)) / (PERSPECTIVE_PX_FLAT - PERSPECTIVE_PX_STRONG);
  return Math.round(Math.max(0, Math.min(PERSPECTIVE_DEPTH_MAX, d)));
}

/** Display depth 0..100 → stored CSS-perspective px (0 = flat/omitted; monotonic: more depth = stronger). */
function perspectiveDepthToPx(depth: number): number {
  if (depth <= 0) return 0;
  const d = Math.min(PERSPECTIVE_DEPTH_MAX, depth);
  return Math.round(PERSPECTIVE_PX_FLAT - (d / PERSPECTIVE_DEPTH_MAX) * (PERSPECTIVE_PX_FLAT - PERSPECTIVE_PX_STRONG));
}

/**
 * Blend-mode options shown in the inspector, grouped the way creators expect
 * (Photoshop/Premiere ordering). Every entry below is fully implemented in all
 * three renderers (preview CSS, browser-export canvas, Remotion) — see
 * BLEND_CSS / BLEND_CANVAS in `@reelforge/shared`. To expose a new mode later,
 * add it to the BlendMode union + those maps, then list it here.
 */
const BLEND_MODE_GROUPS: { label: string; options: { value: BlendMode; label: string }[] }[] = [
  { label: "Normal", options: [{ value: "normal", label: "Normal" }] },
  {
    label: "Darken",
    options: [
      { value: "darken", label: "Darken" },
      { value: "multiply", label: "Multiply" },
      { value: "color-burn", label: "Color Burn" }
    ]
  },
  {
    label: "Lighten",
    options: [
      { value: "lighten", label: "Lighten" },
      { value: "screen", label: "Screen" },
      { value: "color-dodge", label: "Color Dodge" },
      { value: "add", label: "Linear Dodge (Add)" }
    ]
  },
  {
    label: "Contrast",
    options: [
      { value: "overlay", label: "Overlay" },
      { value: "soft-light", label: "Soft Light" },
      { value: "hard-light", label: "Hard Light" }
    ]
  },
  {
    label: "Inversion",
    options: [
      { value: "difference", label: "Difference" },
      { value: "exclusion", label: "Exclusion" }
    ]
  },
  {
    label: "Component",
    options: [
      { value: "hue", label: "Hue" },
      { value: "saturation", label: "Saturation" },
      { value: "color", label: "Color" },
      { value: "luminosity", label: "Luminosity" }
    ]
  }
];
import type { InspectorPanelProps } from "../../registry/inspector";
import { InspectorSection } from "../InspectorSection";
import { NumberControl } from "../controls/NumberControl";
import { ThemedSelect } from "../controls/ThemedSelect";
import {
  animationPresets,
  applyAnimationPreset,
  buildEffectGraphTargets,
  clamp,
  clearTransformKeyframes,
  findTransformKeyframeTime,
  getActiveTransformKeyframe,
  getEffectParamBaseValue,
  getEffectParamKeyframes,
  getTransformKeyframes,
  getTransformPropertyValue,
  graphTargetKey,
  interpolationLabel,
  interpolationOptions,
  isKeyframeAt,
  setGraphTargetInterpolation,
  setGraphTargetLinked,
  setTransformKeyframeInterpolation,
  snap,
  toggleEffectParamKeyframe,
  toggleTransformKeyframe,
  transformGraphTargets,
  transformPropertyConfigs,
  updateGraphTargetHandle,
  updateGraphTargetKeyframe,
  updateTransformPropertyAtTime,
  type AnimationPresetId,
  type GraphTarget,
  type TransformAnimationProperty
} from "../keyframeUtils";

// ---------------------------------------------------------------------------
// TransformGraphEditor
// ---------------------------------------------------------------------------

function TransformGraphEditor({
  currentTime,
  layer,
  layerTime,
  onChange,
  onSeek
}: {
  currentTime: number;
  layer: InspectorPanelProps["layer"];
  layerTime: number;
  onChange: InspectorPanelProps["onChange"];
  onSeek: (seconds: number) => void;
}) {
  const effectGraphTargets: GraphTarget[] = buildEffectGraphTargets(layer);
  const graphTargets = [...transformGraphTargets, ...effectGraphTargets];
  const [targetKey, setTargetKey] = useState("transform:transform.position.x");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [view, setView] = useState({ pan: 0, zoom: 1 });
  const [dragPoint, setDragPoint] = useState<{ id: string; pointerId: number } | null>(null);
  const [dragHandle, setDragHandle] = useState<{
    handle: "in" | "out";
    id: string;
    pointerId: number;
  } | null>(null);
  const [draftLayer, setDraftLayer] = useState<InspectorPanelProps["layer"] | null>(null);
  const [interpolationMenuOpen, setInterpolationMenuOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draftLayerRef = useRef<InspectorPanelProps["layer"] | null>(null);

  const activeTarget =
    graphTargets.find((t) => graphTargetKey(t) === targetKey) ?? graphTargets[0] ?? transformGraphTargets[0]!;
  const config = activeTarget;
  const displayLayer = draftLayer ?? layer;
  const propertyKeyframes =
    activeTarget.kind === "transform"
      ? getTransformKeyframes(displayLayer, activeTarget.property)
      : getEffectParamKeyframes(displayLayer, activeTarget.effectId, activeTarget.property);
  const propertyKeyframeIds = propertyKeyframes.map((kf) => kf.id).join("|");
  const selectedKeyframes = propertyKeyframes.filter((kf) => selectedIds.includes(kf.id));
  const activeKeyframe =
    selectedKeyframes[0] ??
    propertyKeyframes.find((kf) => isKeyframeAt(kf.timeSeconds, layerTime)) ??
    propertyKeyframes.reduce<TimelineKeyframeV2 | undefined>((nearest, kf) => {
      if (!nearest) return kf;
      return Math.abs(kf.timeSeconds - layerTime) < Math.abs(nearest.timeSeconds - layerTime) ? kf : nearest;
    }, undefined);
  const activeKeyframeIndex = activeKeyframe
    ? propertyKeyframes.findIndex((kf) => kf.id === activeKeyframe.id)
    : -1;

  const viewDuration = Math.max(0.2, displayLayer.durationSeconds / view.zoom);
  const maxPan = Math.max(0, displayLayer.durationSeconds - viewDuration);
  const pan = clamp(view.pan, 0, maxPan);
  const viewEnd = Math.min(displayLayer.durationSeconds, pan + viewDuration);
  const visibleDuration = Math.max(0.0001, viewEnd - pan);

  const graphPadding = { bottom: 20, left: 32, right: 10, top: 12 };
  const graphSize = { height: 138, width: 320 };
  const plot = {
    height: graphSize.height - graphPadding.top - graphPadding.bottom,
    width: graphSize.width - graphPadding.left - graphPadding.right
  };

  const curvePoints = Array.from({ length: 72 }, (_, index) => {
    const timeSeconds = pan + (visibleDuration * index) / 71;
    const transform = evaluateTimelineTransform({
      transform: displayLayer.transform,
      startSeconds: displayLayer.startSeconds,
      keyframes: displayLayer.keyframes,
      animations: displayLayer.animations,
      timeSeconds: displayLayer.startSeconds + timeSeconds
    });
    const value =
      activeTarget.kind === "transform"
        ? getTransformPropertyValue(transform, activeTarget.property)
        : evaluateTimelineEffectParam({
            animations: displayLayer.animations,
            baseValue: getEffectParamBaseValue(displayLayer, activeTarget.effectId, activeTarget.property, activeTarget.min),
            effectId: activeTarget.effectId,
            paramKey: activeTarget.property,
            timeSeconds
          });
    return `${xForTime(timeSeconds)},${yForValue(value)}`;
  }).join(" ");

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => propertyKeyframes.some((kf) => kf.id === id)));
  }, [targetKey, propertyKeyframeIds]);

  useEffect(() => {
    draftLayerRef.current = draftLayer;
  }, [draftLayer]);

  useEffect(() => {
    if (!dragPoint && !dragHandle) {
      setDraftLayer(null);
      draftLayerRef.current = null;
    }
  }, [layer.id, targetKey]);

  useEffect(() => {
    setInterpolationMenuOpen(false);
  }, [activeKeyframe?.id, targetKey]);

  function xForTime(timeSeconds: number) {
    return graphPadding.left + ((timeSeconds - pan) / visibleDuration) * plot.width;
  }

  function yForValue(value: number) {
    const progress =
      (clamp(value, config.min, config.max) - config.min) / Math.max(0.0001, config.max - config.min);
    return graphPadding.top + (1 - progress) * plot.height;
  }

  function pointToValue(clientX: number, clientY: number) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { timeSeconds: 0, value: config.min };
    const x = clamp(
      ((clientX - rect.left) / rect.width) * graphSize.width,
      graphPadding.left,
      graphPadding.left + plot.width
    );
    const y = clamp(
      ((clientY - rect.top) / rect.height) * graphSize.height,
      graphPadding.top,
      graphPadding.top + plot.height
    );
    return {
      timeSeconds: snap(pan + ((x - graphPadding.left) / plot.width) * visibleDuration, 0.05),
      value: snap(config.min + (1 - (y - graphPadding.top) / plot.height) * (config.max - config.min), config.step)
    };
  }

  function setDraftFromUpdater(updater: (item: typeof layer) => typeof layer) {
    setDraftLayer((current) => {
      const next = updater(current ?? draftLayerRef.current ?? layer);
      draftLayerRef.current = next;
      return next;
    });
  }

  function commitDraftLayer() {
    const nextLayer = draftLayerRef.current;
    if (!nextLayer) return;
    onChange(() => nextLayer);
    window.setTimeout(() => {
      setDraftLayer(null);
      draftLayerRef.current = null;
    }, 120);
  }

  function getBezierHandlePoint(keyframe: TimelineKeyframeV2, handle: "in" | "out") {
    const keyframeIndex = propertyKeyframes.findIndex((item) => item.id === keyframe.id);
    const neighbor = handle === "in" ? propertyKeyframes[keyframeIndex - 1] : propertyKeyframes[keyframeIndex + 1];
    if (!neighbor) return undefined;
    const duration = Math.max(0.0001, Math.abs(keyframe.timeSeconds - neighbor.timeSeconds));
    const valueDelta =
      Number(handle === "in" ? keyframe.value : neighbor.value) -
      Number(handle === "in" ? neighbor.value : keyframe.value);
    const defaultHandle = handle === "in" ? { dx: -0.33, dy: -0.33 } : { dx: 0.33, dy: 0.33 };
    const storedHandle = keyframe.temporal[handle] ?? defaultHandle;
    return {
      timeSeconds: keyframe.timeSeconds + storedHandle.dx * duration,
      value: Number(keyframe.value) + storedHandle.dy * valueDelta,
      keyframe,
      neighbor,
      storedHandle
    };
  }

  function startHandleDrag(event: ReactPointerEvent<SVGCircleElement>, keyframe: TimelineKeyframeV2, handle: "in" | "out") {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectKeyframe(keyframe.id, false);
    setDraftLayer(layer);
    draftLayerRef.current = layer;
    setDragHandle({ handle, id: keyframe.id, pointerId: event.pointerId });
  }

  function moveHandleDrag(event: ReactPointerEvent<SVGCircleElement>) {
    if (!dragHandle || dragHandle.pointerId !== event.pointerId) return;
    const keyframe = propertyKeyframes.find((item) => item.id === dragHandle.id);
    const handlePoint = keyframe ? getBezierHandlePoint(keyframe, dragHandle.handle) : undefined;
    if (!keyframe || !handlePoint) return;

    const next = pointToValue(event.clientX, event.clientY);
    const duration = Math.max(0.0001, Math.abs(keyframe.timeSeconds - handlePoint.neighbor.timeSeconds));
    const valueDelta =
      Number(dragHandle.handle === "in" ? keyframe.value : handlePoint.neighbor.value) -
      Number(dragHandle.handle === "in" ? handlePoint.neighbor.value : keyframe.value);
    const dx =
      dragHandle.handle === "in"
        ? clamp((next.timeSeconds - keyframe.timeSeconds) / duration, -0.98, -0.02)
        : clamp((next.timeSeconds - keyframe.timeSeconds) / duration, 0.02, 0.98);
    const dy = Math.abs(valueDelta) < 0.0001 ? 0 : clamp((next.value - Number(keyframe.value)) / valueDelta, -2, 2);

    setDraftFromUpdater((item) =>
      updateGraphTargetHandle(item, activeTarget, keyframe.id, dragHandle.handle, { dx, dy }, !event.altKey && keyframe.temporal.linked !== false)
    );
  }

  function finishHandleDrag(event: ReactPointerEvent<SVGCircleElement>) {
    if (!dragHandle || dragHandle.pointerId !== event.pointerId) return;
    setDragHandle(null);
    commitDraftLayer();
  }

  function selectKeyframe(keyframeId: string, additive: boolean) {
    setSelectedIds((current) => {
      if (!additive) return [keyframeId];
      return current.includes(keyframeId)
        ? current.filter((id) => id !== keyframeId)
        : [...current, keyframeId];
    });
  }

  function startPointDrag(event: ReactPointerEvent<SVGCircleElement>, keyframe: TimelineKeyframeV2) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectKeyframe(keyframe.id, event.shiftKey);
    onSeek(layer.startSeconds + keyframe.timeSeconds);
    setDraftLayer(layer);
    draftLayerRef.current = layer;
    setDragPoint({ id: keyframe.id, pointerId: event.pointerId });
  }

  function movePointDrag(event: ReactPointerEvent<SVGCircleElement>) {
    if (!dragPoint || dragPoint.pointerId !== event.pointerId) return;
    const next = pointToValue(event.clientX, event.clientY);
    setDraftFromUpdater((item) => updateGraphTargetKeyframe(item, activeTarget, dragPoint.id, next));
  }

  function finishPointDrag(event: ReactPointerEvent<SVGCircleElement>) {
    if (!dragPoint || dragPoint.pointerId !== event.pointerId) return;
    setDragPoint(null);
    const nextLayer = draftLayerRef.current;
    const movedKeyframe =
      nextLayer && activeTarget.kind === "transform"
        ? getTransformKeyframes(nextLayer, activeTarget.property).find((kf) => kf.id === dragPoint.id)
        : nextLayer && activeTarget.kind === "effect"
          ? getEffectParamKeyframes(nextLayer, activeTarget.effectId, activeTarget.property).find(
              (kf) => kf.id === dragPoint.id
            )
          : undefined;
    if (movedKeyframe) {
      onSeek(layer.startSeconds + movedKeyframe.timeSeconds);
    }
    commitDraftLayer();
  }

  function updateSelectedKeyframe(patch: { timeSeconds?: number; value?: number }) {
    if (!activeKeyframe) return;
    onChange((item) => updateGraphTargetKeyframe(item, activeTarget, activeKeyframe.id, patch));
    if (patch.timeSeconds !== undefined) {
      onSeek(layer.startSeconds + patch.timeSeconds);
    }
  }

  // --- Playhead keyframe controls for the active property (add / remove / step) ---
  const keyframeAtPlayhead = propertyKeyframes.find((kf) => isKeyframeAt(kf.timeSeconds, layerTime));
  const previousKeyframeTime = [...propertyKeyframes]
    .reverse()
    .find((kf) => kf.timeSeconds < layerTime - 0.025)?.timeSeconds;
  const nextKeyframeTime = propertyKeyframes.find((kf) => kf.timeSeconds > layerTime + 0.025)?.timeSeconds;

  function valueAtPlayhead(): number {
    if (activeTarget.kind === "transform") {
      const transform = evaluateTimelineTransform({
        transform: layer.transform,
        startSeconds: layer.startSeconds,
        keyframes: layer.keyframes,
        animations: layer.animations,
        timeSeconds: layer.startSeconds + layerTime
      });
      return getTransformPropertyValue(transform, activeTarget.property);
    }
    return evaluateTimelineEffectParam({
      animations: layer.animations,
      baseValue: getEffectParamBaseValue(layer, activeTarget.effectId, activeTarget.property, activeTarget.min),
      effectId: activeTarget.effectId,
      paramKey: activeTarget.property,
      timeSeconds: layerTime
    });
  }

  function toggleKeyframeAtPlayhead() {
    const value = valueAtPlayhead();
    if (activeTarget.kind === "transform") {
      onChange((item) => toggleTransformKeyframe(item, activeTarget.property, layerTime, value));
    } else {
      onChange((item) => toggleEffectParamKeyframe(item, activeTarget.effectId, activeTarget.property, layerTime, value));
    }
  }

  return (
    <div className="graph-editor">
      <div className="panel-heading">
        <h2>
          <SlidersHorizontal size={15} />
          Graph Editor
        </h2>
        <span className={`badge badge--${propertyKeyframes.length ? "lime" : "muted"}`}>{propertyKeyframes.length}</span>
      </div>
      <div className="graph-property-tabs" aria-label="Graph property">
        {graphTargets.map((item) => (
          <button
            className={graphTargetKey(item) === graphTargetKey(activeTarget) ? "is-active" : ""}
            key={graphTargetKey(item)}
            type="button"
            onClick={() => {
              setTargetKey(graphTargetKey(item));
              setSelectedIds([]);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="graph-editor-kf-nav" aria-label="Keyframe navigation">
        <button
          type="button"
          title="Previous keyframe"
          disabled={previousKeyframeTime === undefined}
          onClick={() => previousKeyframeTime !== undefined && onSeek(layer.startSeconds + previousKeyframeTime)}
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          className={`graph-editor-kf-toggle${keyframeAtPlayhead ? " is-active" : ""}`}
          title={keyframeAtPlayhead ? `Remove ${activeTarget.label} keyframe` : `Add ${activeTarget.label} keyframe`}
          onClick={toggleKeyframeAtPlayhead}
        >
          <Diamond size={13} />
          <span>{keyframeAtPlayhead ? "Remove" : "Add"} key</span>
        </button>
        <button
          type="button"
          title="Next keyframe"
          disabled={nextKeyframeTime === undefined}
          onClick={() => nextKeyframeTime !== undefined && onSeek(layer.startSeconds + nextKeyframeTime)}
        >
          <ChevronRight size={15} />
        </button>
        <span className="graph-editor-kf-count">
          {activeKeyframeIndex >= 0 ? `${activeKeyframeIndex + 1} / ${propertyKeyframes.length}` : `${propertyKeyframes.length}`}
        </span>
      </div>
      <div className="graph-editor-frame">
        <svg
          className="graph-editor-svg"
          ref={svgRef}
          role="img"
          viewBox={`0 0 ${graphSize.width} ${graphSize.height}`}
        >
          <rect
            className="graph-editor-plot"
            x={graphPadding.left}
            y={graphPadding.top}
            width={plot.width}
            height={plot.height}
            rx="6"
          />
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <line
              className="graph-editor-grid-line"
              key={`h_${tick}`}
              x1={graphPadding.left}
              x2={graphPadding.left + plot.width}
              y1={graphPadding.top + plot.height * tick}
              y2={graphPadding.top + plot.height * tick}
            />
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <line
              className="graph-editor-grid-line"
              key={`v_${tick}`}
              x1={graphPadding.left + plot.width * tick}
              x2={graphPadding.left + plot.width * tick}
              y1={graphPadding.top}
              y2={graphPadding.top + plot.height}
            />
          ))}
          <polyline className="graph-editor-curve" points={curvePoints} />
          {layerTime >= pan && layerTime <= viewEnd ? (
            <line
              className="graph-editor-playhead"
              x1={xForTime(layerTime)}
              x2={xForTime(layerTime)}
              y1={graphPadding.top}
              y2={graphPadding.top + plot.height}
            />
          ) : null}
          {propertyKeyframes.map((keyframe) => {
            if (keyframe.timeSeconds < pan || keyframe.timeSeconds > viewEnd) return null;
            const selected = selectedIds.includes(keyframe.id);
            return (
              <circle
                className={`graph-editor-point ${selected ? "is-selected" : ""}`}
                cx={xForTime(keyframe.timeSeconds)}
                cy={yForValue(Number(keyframe.value))}
                key={keyframe.id}
                r={selected ? 5 : 4}
                tabIndex={0}
                onClick={(event) => {
                  event.preventDefault();
                  selectKeyframe(keyframe.id, event.shiftKey);
                  onSeek(layer.startSeconds + keyframe.timeSeconds);
                }}
                onPointerCancel={finishPointDrag}
                onPointerDown={(event) => startPointDrag(event, keyframe)}
                onPointerMove={movePointDrag}
                onPointerUp={finishPointDrag}
              />
            );
          })}
          {activeKeyframe ? (
            <>
              {(["in", "out"] as const).map((handle) => {
                const point = getBezierHandlePoint(activeKeyframe, handle);
                if (!point || point.timeSeconds < pan || point.timeSeconds > viewEnd) return null;
                return (
                  <g className="graph-editor-handle" key={`${activeKeyframe.id}_${handle}`}>
                    <line
                      x1={xForTime(activeKeyframe.timeSeconds)}
                      x2={xForTime(point.timeSeconds)}
                      y1={yForValue(Number(activeKeyframe.value))}
                      y2={yForValue(point.value)}
                    />
                    <circle
                      className={
                        dragHandle?.id === activeKeyframe.id && dragHandle.handle === handle
                          ? "is-dragging"
                          : ""
                      }
                      cx={xForTime(point.timeSeconds)}
                      cy={yForValue(point.value)}
                      r={4}
                      onPointerCancel={finishHandleDrag}
                      onPointerDown={(event) => startHandleDrag(event, activeKeyframe, handle)}
                      onPointerMove={moveHandleDrag}
                      onPointerUp={finishHandleDrag}
                    />
                  </g>
                );
              })}
            </>
          ) : null}
        </svg>
      </div>
      <div className="graph-editor-controls">
        <label>
          <span>Zoom</span>
          <input
            min={1}
            max={8}
            step={0.25}
            type="range"
            value={view.zoom}
            onChange={(event) =>
              setView((current) => ({ ...current, zoom: Number(event.target.value) }))
            }
          />
        </label>
        <label>
          <span>Pan</span>
          <input
            min={0}
            max={maxPan}
            step={0.05}
            type="range"
            value={pan}
            onChange={(event) =>
              setView((current) => ({ ...current, pan: Number(event.target.value) }))
            }
          />
        </label>
      </div>
      {activeKeyframe ? (
        <div className="graph-editor-exact">
          <label>
            <span>Time</span>
            <input
              min={0}
              max={displayLayer.durationSeconds}
              step={0.05}
              type="number"
              value={activeKeyframe.timeSeconds}
              onChange={(event) => updateSelectedKeyframe({ timeSeconds: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Value</span>
            <input
              min={config.min}
              max={config.max}
              step={config.step}
              type="number"
              value={Number(activeKeyframe.value)}
              onChange={(event) => updateSelectedKeyframe({ value: Number(event.target.value) })}
            />
          </label>
          <button
            className={activeKeyframe.temporal.linked !== false ? "is-active" : ""}
            type="button"
            title={activeKeyframe.temporal.linked !== false ? "Linked handles" : "Split handles"}
            onClick={() =>
              onChange((item) =>
                setGraphTargetLinked(
                  item,
                  activeTarget,
                  activeKeyframe.id,
                  activeKeyframe.temporal.linked === false
                )
              )
            }
          >
            {activeKeyframe.temporal.linked !== false ? "Linked" : "Split"}
          </button>
          <div
            className={`graph-interpolation-control ${interpolationMenuOpen ? "is-open" : ""}`}
            aria-label="Interpolation"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setInterpolationMenuOpen(false);
              }
            }}
          >
            <span>{selectedIds.length > 1 ? `${selectedIds.length} selected` : "Interpolation"}</span>
            <button
              className="graph-interpolation-trigger"
              type="button"
              onClick={() => setInterpolationMenuOpen((open) => !open)}
            >
              <span>{interpolationLabel(activeKeyframe.interpolation)}</span>
              <ChevronDown size={13} />
            </button>
            {interpolationMenuOpen ? (
              <div className="graph-interpolation-menu">
                {interpolationOptions.map((option) => (
                  <button
                    className={activeKeyframe.interpolation === option.value ? "is-active" : ""}
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onChange((item) =>
                        setGraphTargetInterpolation(item, activeTarget, activeKeyframe.id, option.value)
                      );
                      setInterpolationMenuOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="empty-mini">
          <Diamond size={16} />
          Add or select a {config.label} keyframe
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TransformPanel — registered inspector panel
// ---------------------------------------------------------------------------

function defaultPositionY(type: InspectorPanelProps["layer"]["type"]) {
  return type === "text" ? 62 : 50;
}

function defaultOpacity(type: InspectorPanelProps["layer"]["type"]) {
  return type === "shape" ? 82 : 100;
}

export default function TransformPanel({ layer, onChange, currentTime = 0, onSeek }: InspectorPanelProps) {
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);
  const animatedTransform = evaluateTimelineTransform({
    transform: layer.transform,
    startSeconds: layer.startSeconds,
    keyframes: layer.keyframes,
    animations: layer.animations,
    timeSeconds: currentTime
  });

  const keyframeCount = getLayerAnimations(layer).length;
  const fallbackSeek = (_: number) => {};
  const seek = onSeek ?? fallbackSeek;

  function transformKeyframe(property: TransformAnimationProperty) {
    const currentValue = getTransformPropertyValue(animatedTransform, property);
    const activeKeyframe = getActiveTransformKeyframe(layer, property, layerTime);
    return {
      active: Boolean(activeKeyframe),
      hasAny: getTransformKeyframes(layer, property).length > 0,
      hasNext: Boolean(findTransformKeyframeTime(layer, property, layerTime, 1)),
      hasPrevious: Boolean(findTransformKeyframeTime(layer, property, layerTime, -1)),
      interpolation: activeKeyframe?.interpolation,
      onClearAll: () => onChange((item) => clearTransformKeyframes(item, property)),
      onChangeInterpolation: (interpolation: KeyframeInterpolation) =>
        onChange((item) => setTransformKeyframeInterpolation(item, property, layerTime, interpolation)),
      onToggle: () => onChange((item) => toggleTransformKeyframe(item, property, layerTime, currentValue)),
      onNext: () => {
        const nextTime = findTransformKeyframeTime(layer, property, layerTime, 1);
        if (nextTime !== undefined) seek(layer.startSeconds + nextTime);
      },
      onPrevious: () => {
        const previousTime = findTransformKeyframeTime(layer, property, layerTime, -1);
        if (previousTime !== undefined) seek(layer.startSeconds + previousTime);
      }
    };
  }

  function changeTransformProperty(property: TransformAnimationProperty, value: number) {
    onChange((item) => updateTransformPropertyAtTime(item, property, layerTime, value));
  }

  // 3D tilt is static (not keyframed) for now — set the base transform field directly. Both the
  // preview (CSS) and the local/cloud export (WebGL perspective quad) read these fields.
  function changeTilt(field: "rotateX" | "rotateY" | "perspective", value: number) {
    onChange((item) => ({ ...item, transform: { ...item.transform, [field]: value } }));
  }

  const visiblePresets = animationPresets.filter(
    (preset) => !("textOnly" in preset && preset.textOnly) || layer.type === "text"
  );

  return (
    <>
      <InspectorSection title="Transform" icon={<Move size={13} />} collapsible={false}>
      <div className="control-grid">
        <NumberControl
          icon={<MoveHorizontal size={14} />}
          keyframe={transformKeyframe("transform.position.x")}
          label="X"
          value={animatedTransform.position.x}
          min={0}
          max={100}
          step={1}
          onReset={() => changeTransformProperty("transform.position.x", 50)}
          onChange={(value) => changeTransformProperty("transform.position.x", value)}
        />
        <NumberControl
          icon={<MoveVertical size={14} />}
          keyframe={transformKeyframe("transform.position.y")}
          label="Y"
          value={animatedTransform.position.y}
          min={0}
          max={100}
          step={1}
          onReset={() => changeTransformProperty("transform.position.y", defaultPositionY(layer.type))}
          onChange={(value) => changeTransformProperty("transform.position.y", value)}
        />
        <NumberControl
          icon={<Maximize2 size={14} />}
          keyframe={transformKeyframe("transform.scale")}
          label="Scale"
          value={animatedTransform.scale}
          min={0.01}
          max={100}
          step={0.05}
          onReset={() => changeTransformProperty("transform.scale", 1)}
          onChange={(value) => changeTransformProperty("transform.scale", value)}
        />
        <NumberControl
          icon={<RotateCw size={14} />}
          keyframe={transformKeyframe("transform.rotation")}
          label="Rotate"
          value={animatedTransform.rotation}
          min={-180}
          max={180}
          step={1}
          onReset={() => changeTransformProperty("transform.rotation", 0)}
          onChange={(value) => changeTransformProperty("transform.rotation", value)}
        />
        <NumberControl
          icon={<Eye size={14} />}
          keyframe={transformKeyframe("transform.opacity")}
          label="Opacity"
          value={animatedTransform.opacity}
          min={0}
          max={100}
          step={1}
          onReset={() => changeTransformProperty("transform.opacity", defaultOpacity(layer.type))}
          onChange={(value) => changeTransformProperty("transform.opacity", value)}
        />
        <div className="number-control">
          <span>Blend</span>
          <ThemedSelect
            ariaLabel="Blend mode"
            value={layer.blendMode ?? "normal"}
            groups={BLEND_MODE_GROUPS}
            onChange={(blendMode) => onChange((item) => ({ ...item, blendMode }))}
          />
        </div>
        {layer.type === "video" || layer.type === "image" ? (
          <div className="number-control">
            <span>Fit</span>
            <ThemedSelect
              ariaLabel="Fit"
              value={layer.fit ?? "cover"}
              options={[
                { value: "cover", label: "Cover" },
                { value: "contain", label: "Contain" },
                { value: "fill", label: "Stretch" }
              ]}
              onChange={(fit) => onChange((item) => ({ ...item, fit: fit as typeof layer.fit }))}
            />
          </div>
        ) : null}
      </div>
      </InspectorSection>

      <InspectorSection title="3D Tilt" icon={<Box size={13} />} defaultOpen={false}>
      <div className="control-grid">
        <NumberControl
          icon={<Rotate3d size={14} />}
          keyframe={transformKeyframe("transform.rotateX")}
          label="Rotate X"
          value={animatedTransform.rotateX ?? 0}
          min={-180}
          max={180}
          step={1}
          onReset={() => changeTransformProperty("transform.rotateX", 0)}
          onChange={(value) => changeTransformProperty("transform.rotateX", value)}
        />
        <NumberControl
          icon={<Rotate3d size={14} />}
          keyframe={transformKeyframe("transform.rotateY")}
          label="Rotate Y"
          value={animatedTransform.rotateY ?? 0}
          min={-180}
          max={180}
          step={1}
          onReset={() => changeTransformProperty("transform.rotateY", 0)}
          onChange={(value) => changeTransformProperty("transform.rotateY", value)}
        />
        <NumberControl
          icon={<Box size={14} />}
          keyframe={transformKeyframe("transform.perspective")}
          label="Perspective"
          // Monotonic depth 0..100 (0 = flat → 100 = strongest); stored as CSS-perspective px (see mapping above).
          value={perspectivePxToDepth(animatedTransform.perspective ?? 0)}
          min={0}
          max={100}
          step={1}
          onReset={() => changeTransformProperty("transform.perspective", 0)}
          onChange={(value) => changeTransformProperty("transform.perspective", perspectiveDepthToPx(value))}
        />
      </div>
      </InspectorSection>

      <InspectorSection
        title="Graph Editor"
        icon={<SlidersHorizontal size={13} />}
        count={keyframeCount}
        active={keyframeCount > 0}
        defaultOpen={false}
      >
        <TransformGraphEditor
          currentTime={currentTime}
          layer={layer}
          layerTime={layerTime}
          onChange={onChange}
          onSeek={seek}
        />
      </InspectorSection>

      <InspectorSection
        title="Animation Presets"
        icon={<Sparkles size={13} />}
        count={visiblePresets.length}
        defaultOpen={false}
      >
        <div className="animation-preset-grid">
          {visiblePresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onChange((item) => applyAnimationPreset(item, preset.id as AnimationPresetId))}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </InspectorSection>

      <InspectorSection
        title="Keyframes"
        icon={<Diamond size={13} />}
        count={keyframeCount}
        active={keyframeCount > 0}
        defaultOpen={false}
      >
        {keyframeCount > 0 ? (
          <div className="keyframe-list">
            {getLayerAnimations(layer).map((keyframe) => (
              <div className="keyframe-row" key={keyframe.id}>
                <strong>{shortKeyframePropertyLabel(keyframe.target.property)}</strong>
                <span>{keyframe.timeSeconds.toFixed(2)}s</span>
                <small>{keyframe.interpolation}</small>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-mini">
            <Diamond size={16} />
            No keyframes yet
          </div>
        )}
      </InspectorSection>
    </>
  );
}

function shortKeyframePropertyLabel(property: string) {
  const map: Record<string, string> = {
    "transform.position.x": "X",
    "transform.position.y": "Y",
    "transform.scale": "Scale",
    "transform.rotation": "Rotate",
    "transform.opacity": "Opacity",
    textRevealProgress: "Reveal"
  };
  return map[property] ?? property;
}
