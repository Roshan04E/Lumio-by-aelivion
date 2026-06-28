import { ChevronDown, ChevronUp, Circle, Eye, EyeOff, Hexagon, PenTool, Pencil, Square, Trash2 } from "lucide-react";
import { type Mask, type TimelineLayer } from "@reelforge/shared";
import type { InspectorPanelProps } from "../../registry/inspector";
import { InspectorSection } from "../InspectorSection";
import { MaskItemBody } from "../MaskItemBody";
import { clamp } from "../keyframeUtils";

/**
 * Inspector Mask section. Creates rectangle/ellipse/polygon/pen clip masks; per-mask controls (mode/invert,
 * keyframeable scalars + transform, shape keyframes, mask tracking) live in the shared {@link MaskItemBody},
 * which effect-region masks reuse so the two never diverge.
 */
export default function MaskPanel({
  layer,
  onChange,
  composition,
  activeMaskId,
  onSelectMask,
  onChangeMaskTool,
  currentTime = 0,
  onSeek,
  trackLibrary
}: InspectorPanelProps) {
  const masks = layer.masks ?? [];
  const width = composition?.width ?? 1080;
  const height = composition?.height ?? 1920;
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);
  const seek = (timeSeconds: number) => onSeek?.(layer.startSeconds + timeSeconds);

  // Arm the matching draw tool (deselect any active mask first); the user draws the shape in the preview
  // overlay, which creates the mask and flips back to Select. Mirrors the Pen button — nothing is added until
  // the user draws.
  function armTool(tool: "rectangle" | "ellipse" | "polygon" | "pen") {
    onSelectMask?.(null);
    onChangeMaskTool?.(tool);
  }

  function updateMask(maskId: string, patch: Partial<Mask>) {
    onChange((current: TimelineLayer) => ({
      ...current,
      masks: (current.masks ?? []).map((mask) => (mask.id === maskId ? { ...mask, ...patch } : mask))
    }));
  }

  function deleteMask(maskId: string) {
    onChange((current: TimelineLayer) => ({
      ...current,
      // also drop this mask's scalar keyframes so nothing dangles in the animations array.
      masks: (current.masks ?? []).filter((mask) => mask.id !== maskId),
      animations: (current.animations ?? []).filter(
        (kf) => !(kf.target.scope === "mask" && kf.target.maskId === maskId)
      )
    }));
    if (activeMaskId === maskId) onSelectMask?.(null);
  }

  // Reorder = change composite order (index 0 = top/base; each lower mask composites by its mode).
  function moveMask(maskId: string, direction: -1 | 1) {
    onChange((current: TimelineLayer) => {
      const list = [...(current.masks ?? [])];
      const i = list.findIndex((mask) => mask.id === maskId);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= list.length) return current;
      [list[i], list[j]] = [list[j]!, list[i]!];
      return { ...current, masks: list };
    });
  }

  return (
    <InspectorSection title="Masks" icon={<Square size={13} />} count={masks.length}>
      <div className="mask-add-row">
        <button type="button" aria-label="Draw a rectangle mask" onClick={() => armTool("rectangle")} title="Draw a rectangle mask (drag in the preview)">
          <Square size={14} />
        </button>
        <button type="button" aria-label="Draw an ellipse mask" onClick={() => armTool("ellipse")} title="Draw an ellipse mask (drag in the preview)">
          <Circle size={14} />
        </button>
        <button type="button" aria-label="Draw a polygon mask" onClick={() => armTool("polygon")} title="Draw a polygon mask (click points in the preview, Enter/click first point to close)">
          <Hexagon size={14} />
        </button>
        <button
          type="button"
          aria-label="Draw a Bezier mask with the Pen"
          onClick={() => armTool("pen")}
          title="Draw a Bezier mask with the Pen (click corners, drag for curves, Enter/click first point to close)"
        >
          <PenTool size={14} />
        </button>
      </div>

      {masks.length === 0 ? (
        <p className="mask-empty-hint">No masks. Pick a shape, then drag in the preview to draw it, then drag its points.</p>
      ) : (
        <p className="mask-hint">
          Alt-drag a point to curve it · Alt-drag a handle to break/relink · Alt-click toggles corner/smooth · double-click an edge to
          add a point · Shift constrains (even shapes · axis-lock move · 45° handles).
        </p>
      )}

      {masks.map((mask, index) => {
        const isActive = activeMaskId === mask.id;
        return (
          <div className={`mask-item ${isActive ? "is-active" : ""}`} key={mask.id}>
            <div className="mask-item-head">
              <button
                type="button"
                className="mask-icon-btn"
                title={mask.enabled ? "Disable mask" : "Enable mask"}
                onClick={() => updateMask(mask.id, { enabled: !mask.enabled })}
              >
                {mask.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <input
                className="mask-name-input"
                value={mask.name}
                onChange={(event) => updateMask(mask.id, { name: event.target.value })}
                aria-label="Mask name"
              />
              <button type="button" className="mask-icon-btn" title="Move up (composite earlier)" disabled={index === 0} onClick={() => moveMask(mask.id, -1)}>
                <ChevronUp size={13} />
              </button>
              <button type="button" className="mask-icon-btn" title="Move down (composite later)" disabled={index === masks.length - 1} onClick={() => moveMask(mask.id, 1)}>
                <ChevronDown size={13} />
              </button>
              <button
                type="button"
                className={`mask-icon-btn ${isActive ? "is-active" : ""}`}
                title={isActive ? "Stop editing in preview" : "Edit in preview"}
                onClick={() => onSelectMask?.(isActive ? null : mask.id)}
              >
                <Pencil size={13} />
              </button>
              <button type="button" className="mask-icon-btn is-danger" title="Delete mask" onClick={() => deleteMask(mask.id)}>
                <Trash2 size={13} />
              </button>
            </div>

            <MaskItemBody
              layer={layer}
              mask={mask}
              width={width}
              height={height}
              layerTime={layerTime}
              seek={seek}
              trackLibrary={trackLibrary}
              onChange={onChange}
            />

            {index < masks.length - 1 ? <div className="mask-item-divider" /> : null}
          </div>
        );
      })}
    </InspectorSection>
  );
}
