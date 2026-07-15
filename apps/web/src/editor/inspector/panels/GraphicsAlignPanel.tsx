/**
 * Graphics tab — Align + Distribute (Premiere EGP "Align & Transform").
 *
 * Align: six align buttons that write a layer's transform position so its PAINTED
 * content box (not the comp-filling element box) lands flush to an edge/center. The
 * "Align to" toggle picks the reference: the comp Frame, or the Selection's union
 * bounds (enabled only with 2+ visible layers).
 *
 * Distribute: space 3+ layers evenly (equal centers or equal gaps, H or V).
 *
 * All writes go through applyTransformValueAtTime (the canonical four-way rule) so
 * keyframed / auto-keyframe layers behave like every other transform edit, and a
 * whole multi-layer op commits through onChangeLayers as ONE history entry.
 * Geometry lives in ./graphicsAlignGeometry (pure, testable). See §3 BUILD SPEC.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceBetween,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceBetween,
  LayoutPanelTop
} from "lucide-react";
import type { TimelineLayer } from "@kimera-by-aelivion/shared";
import { InspectorSection } from "../InspectorSection";
import { applyTransformValueAtTime } from "../keyframeUtils";
import {
  alignTargets,
  distributeTargets,
  paintedBoxAt,
  unionBounds,
  type AlignMode,
  type AlignTarget,
  type AlignWrite,
  type DistributeAxis,
  type DistributeMethod,
  type PaintedBox
} from "./graphicsAlignGeometry";
import { measureTextContentFraction } from "./measureTextBox";

/**
 * Sticky "Align to" mode for the session (module-level, mirrors InspectorTabs'
 * lastTabByLayerType). Undefined until the user picks a segment, then it wins;
 * before that we default by selection count. Reset only on reload.
 */
let rememberedAlignMode: AlignMode | undefined;

/** A visual layer has geometry to align/distribute; audio does not. */
function isVisual(layer: TimelineLayer): boolean {
  return layer.type !== "audio";
}

export default function GraphicsAlignPanel({
  layer,
  selectedLayers,
  composition,
  currentTime,
  autoKeyframe,
  onChange,
  onChangeLayers
}: {
  /** The inspected (primary) layer — the fallback participant when nothing else is multi-selected. */
  layer: TimelineLayer;
  /** All selected layers (any type); the panel filters to visible visual layers itself. */
  selectedLayers?: TimelineLayer[] | undefined;
  composition: { width: number; height: number };
  currentTime: number;
  autoKeyframe?: boolean | undefined;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  /** Batch commit: applies `updater` to every id in ONE history entry. Required for multi-layer ops. */
  onChangeLayers?: ((layerIds: string[], updater: (layer: TimelineLayer) => TimelineLayer) => void) | undefined;
}) {
  const [, forceRender] = useState(0);

  // Participants: selected VISIBLE visual layers (locked included — they act as fixed
  // references). Falls back to the inspected layer so a single selection still aligns.
  const participants = useMemo(() => {
    const source = selectedLayers && selectedLayers.length ? selectedLayers : [layer];
    return source.filter((item) => isVisual(item) && item.muted !== true);
  }, [selectedLayers, layer]);

  const movableCount = participants.filter((item) => item.locked !== true).length;
  const selectionAlignable = participants.length >= 2 && movableCount >= 1;
  const distributable = participants.length >= 3 && movableCount >= 1;

  // Effective mode: forced to "frame" when a selection align isn't possible; otherwise
  // the remembered choice, else default by count.
  const mode: AlignMode = !selectionAlignable ? "frame" : rememberedAlignMode ?? (participants.length >= 2 ? "selection" : "frame");

  function setMode(next: AlignMode) {
    rememberedAlignMode = next;
    forceRender((value) => value + 1);
  }

  /** Apply a precomputed per-layer position map as one batched, undoable edit. */
  function commit(writes: Map<string, AlignWrite>) {
    if (!writes.size) return;
    const ids = [...writes.keys()];
    const updater = (item: TimelineLayer): TimelineLayer => {
      const write = writes.get(item.id);
      if (!write) return item;
      const layerTime = Math.max(0, currentTime - item.startSeconds);
      let next = item;
      if (write.x !== undefined) {
        next = applyTransformValueAtTime(next, "transform.position.x", layerTime, write.x, { autoKeyframe });
      }
      if (write.y !== undefined) {
        next = applyTransformValueAtTime(next, "transform.position.y", layerTime, write.y, { autoKeyframe });
      }
      return next;
    };
    if (onChangeLayers) {
      onChangeLayers(ids, updater);
    } else if (ids.length === 1 && ids[0] === layer.id) {
      // Single-layer fallback when no batch handler is wired.
      onChange(updater);
    }
  }

  // Text boxes hug their glyphs / wrap in a frame, so measure the REAL rendered box at
  // click time (renderer-faithful, one-shot). Media/shapes use the analytic contentFractions.
  function boxFor(item: TimelineLayer): PaintedBox {
    const override = item.type === "text" ? measureTextContentFraction(item, composition, currentTime) : undefined;
    return paintedBoxAt(item, composition, currentTime, override);
  }

  function align(target: AlignTarget) {
    const boxes = participants.map(boxFor);
    const bounds = mode === "selection" ? unionBounds(boxes) : null;
    commit(alignTargets(boxes, target, mode, bounds));
  }

  function distribute(axis: DistributeAxis, method: DistributeMethod) {
    const boxes = participants.map(boxFor);
    commit(distributeTargets(boxes, axis, method));
  }

  const alignButtons: Array<{ target: AlignTarget; title: string; icon: ReactNode }> = [
    { target: "left", title: "Align left edges", icon: <AlignHorizontalJustifyStart size={14} /> },
    { target: "centerH", title: "Align horizontal centers", icon: <AlignHorizontalJustifyCenter size={14} /> },
    { target: "right", title: "Align right edges", icon: <AlignHorizontalJustifyEnd size={14} /> },
    { target: "top", title: "Align top edges", icon: <AlignVerticalJustifyStart size={14} /> },
    { target: "middle", title: "Align vertical centers", icon: <AlignVerticalJustifyCenter size={14} /> },
    { target: "bottom", title: "Align bottom edges", icon: <AlignVerticalJustifyEnd size={14} /> }
  ];

  const distributeDisabledTitle = "Select 3 or more layers to distribute";
  const distributeButtons: Array<{ axis: DistributeAxis; method: DistributeMethod; title: string; icon: ReactNode }> = [
    { axis: "h", method: "centers", title: "Distribute horizontal centers", icon: <AlignHorizontalDistributeCenter size={14} /> },
    { axis: "h", method: "gaps", title: "Distribute horizontal gaps (even spacing)", icon: <AlignHorizontalSpaceBetween size={14} /> },
    { axis: "v", method: "centers", title: "Distribute vertical centers", icon: <AlignVerticalDistributeCenter size={14} /> },
    { axis: "v", method: "gaps", title: "Distribute vertical gaps (even spacing)", icon: <AlignVerticalSpaceBetween size={14} /> }
  ];

  return (
    <InspectorSection title="Align" icon={<LayoutPanelTop size={13} />}>
      <div className="graphics-align-to" role="radiogroup" aria-label="Align to">
        <button
          type="button"
          role="radio"
          aria-checked={mode === "frame"}
          className={mode === "frame" ? "is-active" : ""}
          onClick={() => setMode("frame")}
        >
          Frame
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "selection"}
          className={mode === "selection" ? "is-active" : ""}
          disabled={!selectionAlignable}
          title={selectionAlignable ? "Align to the selection's bounds" : "Select 2 or more layers to align to selection"}
          onClick={() => setMode("selection")}
        >
          Selection
        </button>
      </div>

      <div className="graphics-align-row">
        {alignButtons.map(({ target, title, icon }) => (
          <button key={target} type="button" title={title} aria-label={title} onClick={() => align(target)}>
            {icon}
          </button>
        ))}
      </div>

      <div className="graphics-align-row graphics-distribute-row">
        {distributeButtons.map(({ axis, method, title, icon }) => (
          <button
            key={`${axis}-${method}`}
            type="button"
            title={distributable ? title : distributeDisabledTitle}
            aria-label={title}
            disabled={!distributable}
            onClick={() => distribute(axis, method)}
          >
            {icon}
          </button>
        ))}
      </div>
    </InspectorSection>
  );
}
