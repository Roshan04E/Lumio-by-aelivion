import { ChevronDown, ChevronUp, Circle, Eye, EyeOff, Hexagon, PenTool, Pencil, Square, Trash2 } from "lucide-react";
import { type Mask, type TimelineEffect, type TimelineLayer } from "@orreris/shared";
import type { MaskTool } from "../registry/inspector";
import type { SavedTrack } from "../../lib/trackLibrary";
import { MaskItemBody } from "./MaskItemBody";
import { clearAllMaskKeyframes } from "./maskKeyframeUtils";

/**
 * Effect-level (region) mask controls. Authoring for an effect's masks (e.g. blur-a-face): the effect is
 * limited to these regions and blends with the original outside — it does NOT crop the clip. Per-mask controls
 * (mode/invert, keyframeable scalars + transform, shape keyframes, mask tracking) come from the shared
 * {@link MaskItemBody}, identical to clip masks. Keyframes live in `layer.animations` by `maskId`; the static
 * mask geometry lives in `effect.masks`. Geometry is edited in the preview overlay.
 */
export function EffectMaskControls({
  effect,
  layer,
  composition,
  activeMaskId,
  layerTime,
  trackLibrary,
  onChangeMasks,
  onChangeLayer,
  onEditInPreview,
  onChangeMaskTool,
  onSeek
}: {
  effect: TimelineEffect;
  layer: TimelineLayer;
  composition: { width: number; height: number };
  activeMaskId?: string | undefined;
  /** Layer-local seconds at the playhead (for keyframe diamonds). */
  layerTime: number;
  trackLibrary?: SavedTrack[] | undefined;
  /** Update this effect's masks array (static geometry/mode/name/enable). */
  onChangeMasks: (updater: (masks: Mask[]) => Mask[]) => void;
  /** Update the whole layer (keyframes/tracking live in layer.animations). */
  onChangeLayer: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  /** Make this effect the overlay's active mask target; pass a maskId to also select it (null = just target). */
  onEditInPreview: (maskId: string | null) => void;
  onChangeMaskTool: (tool: MaskTool) => void;
  onSeek?: ((seconds: number) => void) | undefined;
}) {
  const masks = effect.masks ?? [];
  const seek = (timeSeconds: number) => onSeek?.(layer.startSeconds + timeSeconds);

  // Arm the matching draw tool while keeping THIS effect the overlay's mask target (no specific mask selected).
  // The user draws the region in the preview, which creates the mask in `effect.masks` and flips to Select.
  function armTool(tool: "rectangle" | "ellipse" | "polygon" | "pen") {
    onEditInPreview(null);
    onChangeMaskTool(tool);
  }
  function updateMask(maskId: string, patch: Partial<Mask>) {
    onChangeMasks((current) => current.map((mask) => (mask.id === maskId ? { ...mask, ...patch } : mask)));
  }
  function deleteMask(maskId: string) {
    // Remove the region from this effect AND drop its keyframes from layer.animations, atomically.
    onChangeLayer((item) => {
      const cleared = clearAllMaskKeyframes(item, maskId);
      return {
        ...cleared,
        effects: cleared.effects.map((e) =>
          e.id === effect.id ? { ...e, masks: (e.masks ?? []).filter((m) => m.id !== maskId) } : e
        )
      };
    });
    if (activeMaskId === maskId) onEditInPreview(null);
  }
  function moveMask(maskId: string, direction: -1 | 1) {
    onChangeMasks((current) => {
      const list = [...current];
      const i = list.findIndex((mask) => mask.id === maskId);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= list.length) return current;
      [list[i], list[j]] = [list[j]!, list[i]!];
      return list;
    });
  }

  return (
    <div className="effect-mask-controls">
      <div className="effect-mask-title">Region mask</div>
      <div className="mask-add-row">
        <button type="button" aria-label="Draw a rectangle region" onClick={() => armTool("rectangle")} title="Draw a rectangle region (drag in the preview)">
          <Square size={14} />
        </button>
        <button type="button" aria-label="Draw an ellipse region" onClick={() => armTool("ellipse")} title="Draw an ellipse region (drag in the preview)">
          <Circle size={14} />
        </button>
        <button type="button" aria-label="Draw a polygon region" onClick={() => armTool("polygon")} title="Draw a polygon region (click points in the preview, Enter/click first point to close)">
          <Hexagon size={14} />
        </button>
        <button
          type="button"
          aria-label="Draw a region with the Pen"
          onClick={() => armTool("pen")}
          title="Draw a region with the Pen"
        >
          <PenTool size={14} />
        </button>
      </div>
      {masks.length === 0 ? (
        <p className="mask-hint">The effect applies to the whole clip. Add a region (e.g. a face) to limit it — the rest stays untouched.</p>
      ) : null}

      {masks.map((mask, index) => {
        const isActive = activeMaskId === mask.id;
        return (
          <div className={`mask-item ${isActive ? "is-active" : ""}`} key={mask.id}>
            <div className="mask-item-head">
              <button
                type="button"
                className="mask-icon-btn"
                title={mask.enabled ? "Disable region" : "Enable region"}
                onClick={() => updateMask(mask.id, { enabled: !mask.enabled })}
              >
                {mask.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <input
                className="mask-name-input"
                value={mask.name}
                onChange={(event) => updateMask(mask.id, { name: event.target.value })}
                aria-label="Region name"
              />
              <button type="button" className="mask-icon-btn" title="Move up" disabled={index === 0} onClick={() => moveMask(mask.id, -1)}>
                <ChevronUp size={13} />
              </button>
              <button type="button" className="mask-icon-btn" title="Move down" disabled={index === masks.length - 1} onClick={() => moveMask(mask.id, 1)}>
                <ChevronDown size={13} />
              </button>
              <button
                type="button"
                className={`mask-icon-btn ${isActive ? "is-active" : ""}`}
                title={isActive ? "Stop editing in preview" : "Edit in preview"}
                onClick={() => onEditInPreview(isActive ? null : mask.id)}
              >
                <Pencil size={13} />
              </button>
              <button type="button" className="mask-icon-btn is-danger" title="Delete region" onClick={() => deleteMask(mask.id)}>
                <Trash2 size={13} />
              </button>
            </div>

            <MaskItemBody
              layer={layer}
              mask={mask}
              width={composition.width}
              height={composition.height}
              layerTime={layerTime}
              seek={seek}
              trackLibrary={trackLibrary}
              onChange={onChangeLayer}
            />
          </div>
        );
      })}
    </div>
  );
}
