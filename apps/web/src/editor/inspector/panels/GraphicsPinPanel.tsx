/**
 * Graphics tab — Responsive Pin (§1). A 3×3 anchor grid (AE/Figma constraint-picker style) that sets
 * each selected graphic layer's `responsive` pin: which edge/center of its painted box stays glued
 * when the CANVAS is reframed (16:9 ↔ 9:16, size change). The pin only has a visible effect on
 * reframe — it's baked into `transform.position` at that moment (see graphicsReflow.ts); nothing
 * about the current frame changes, so the hint spells that out.
 *
 * Mirrors Align's selection semantics: applies to every selected visual layer in ONE undo via
 * onChangeLayers (falls back to onChange for a lone inspected layer). Setting the pin is layout
 * metadata, not a geometry edit, so it goes through the unguarded batch path even for locked layers.
 */

import { useMemo } from "react";
import { Anchor } from "lucide-react";
import type { LayerResponsivePin, PinX, PinY, TimelineLayer } from "@orreris/shared";
import { InspectorSection } from "../InspectorSection";

const ROWS: PinY[] = ["top", "center", "bottom"];
const COLS: PinX[] = ["left", "center", "right"];

/** A visual layer has geometry to anchor; audio does not. */
function isVisual(layer: TimelineLayer): boolean {
  return layer.type !== "audio";
}

/** The one value shared by every entry, or undefined when they differ (indeterminate). */
function shared<T>(values: T[]): T | undefined {
  if (!values.length) return undefined;
  const first = values[0]!;
  return values.every((value) => value === first) ? first : undefined;
}

function cellLabel(x: PinX, y: PinY): string {
  if (x === "center" && y === "center") return "No pin (center — scales proportionally)";
  const parts = [y === "center" ? "" : y, x === "center" ? "" : x].filter(Boolean);
  return `Pin ${parts.join(" ")}`;
}

export default function GraphicsPinPanel({
  layer,
  selectedLayers,
  onChange,
  onChangeLayers
}: {
  /** The inspected (primary) layer — the fallback participant when nothing else is multi-selected. */
  layer: TimelineLayer;
  /** All selected layers (any type); the panel filters to visual layers itself. */
  selectedLayers?: TimelineLayer[] | undefined;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  /** Batch commit: applies `updater` to every id in ONE history entry. */
  onChangeLayers?: ((layerIds: string[], updater: (layer: TimelineLayer) => TimelineLayer) => void) | undefined;
}) {
  const participants = useMemo(() => {
    const source = selectedLayers && selectedLayers.length ? selectedLayers : [layer];
    return source.filter(isVisual);
  }, [selectedLayers, layer]);

  // Current shared anchor across the selection (undefined axis = indeterminate → no highlight).
  const activeX = shared(participants.map((item) => item.responsive?.x ?? "center"));
  const activeY = shared(participants.map((item) => item.responsive?.y ?? "center"));

  if (!participants.length) return null;

  function setPin(x: PinX, y: PinY) {
    // Store only non-center axes; center/center → no responsive field at all (natural no-op on reframe).
    const responsive: LayerResponsivePin | undefined =
      x === "center" && y === "center" ? undefined : { ...(x !== "center" ? { x } : {}), ...(y !== "center" ? { y } : {}) };
    const updater = (item: TimelineLayer): TimelineLayer => ({ ...item, responsive });
    const ids = participants.map((item) => item.id);
    if (onChangeLayers) onChangeLayers(ids, updater);
    else if (ids.length === 1 && ids[0] === layer.id) onChange(updater);
  }

  return (
    <InspectorSection title="Responsive" icon={<Anchor size={13} />} defaultOpen={false}>
      <div className="graphics-pin">
        <div className="graphics-pin-grid" role="radiogroup" aria-label="Responsive anchor">
          {ROWS.map((y) =>
            COLS.map((x) => {
              const active = activeX === x && activeY === y;
              return (
                <button
                  key={`${x}-${y}`}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`graphics-pin-cell${active ? " is-active" : ""}`}
                  title={cellLabel(x, y)}
                  aria-label={cellLabel(x, y)}
                  onClick={() => setPin(x, y)}
                >
                  <span className="graphics-pin-dot" aria-hidden="true" />
                </button>
              );
            })
          )}
        </div>
        <p className="graphics-pin-hint">Anchors this layer when the canvas size changes. Center = scales proportionally.</p>
      </div>
    </InspectorSection>
  );
}
