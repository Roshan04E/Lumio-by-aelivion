/**
 * Graphic panel — edits a vector graphic layer (a Search → Graphics pick stored as `layer.graphic`).
 * Single-color graphics get the solid Fill control (recolored via `currentColor`); multicolor
 * graphics (external SVGs baked with several paints) get one control per palette slot, applied as
 * exact-literal substitutions in `graphicToDataUrl` — so preview and export update instantly and
 * stay crisp at any scale. Renders nothing for ordinary photo/file image layers (no `layer.graphic`).
 */

import { useState } from "react";
import { Shapes, Palette, Save, Repeat, Timer, Gauge } from "lucide-react";
import {
  sanitizeGraphicFill,
  resolveGraphicAnimation,
  graphicAnimationLoopsByDefault,
  graphicAnimationPhase,
  evaluateAnimatedValue,
  GRAPHIC_DURATION_PROPERTY,
  GRAPHIC_PROGRESS_PROPERTY,
  DEFAULT_GRAPHIC_FILL,
  type GraphicLoopMode,
  type LayerGraphic,
  type KeyframeInterpolation,
  type TimelineLayer
} from "@orreris/shared";
import type { InspectorPanelProps } from "../../registry/inspector";
import { InspectorSection } from "../InspectorSection";
import { ColorControl } from "../../../components/ColorControl";
import { NumberControl } from "../controls/NumberControl";
import { ThemedSelect } from "../controls/ThemedSelect";
import {
  applyLayerPropertyValueAtTime,
  clamp,
  clearLayerPropertyKeyframes,
  findLayerPropertyKeyframe,
  getActiveLayerPropertyKeyframe,
  getLayerPropertyKeyframes,
  setLayerPropertyKeyframeInterpolation,
  toggleLayerPropertyKeyframe
} from "../keyframeUtils";
import { defaultColorPalette } from "../../../lib/colorPalette";
import { saveGraphicPreset } from "../../graphic-presets";

/** Base (un-keyframed) Duration write target — the layer's own graphic animation override. */
function setDurationBase(layer: TimelineLayer, value: number): TimelineLayer {
  return setGraphicAnimation(layer, { durationSeconds: value > 0 ? value : undefined });
}

export default function GraphicPanel({ layer, onChange, currentTime = 0, onSeek, autoKeyframe }: InspectorPanelProps) {
  const [naming, setNaming] = useState(false);
  const [presetName, setPresetName] = useState("");
  const graphic = layer.graphic;
  if (!graphic) {
    return null;
  }
  const fill = sanitizeGraphicFill(graphic.fill);
  const palette = graphic.palette ?? [];
  // null for a static graphic → the animation controls stay hidden.
  const plan = resolveGraphicAnimation(graphic, { animations: layer.animations });
  // Keyframes are LAYER-LOCAL (the V2 convention every panel follows).
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);
  const progressKeyed = getLayerPropertyKeyframes(layer, GRAPHIC_PROGRESS_PROPERTY).length > 0;
  // Show the value AT the playhead so a keyframed row reads like every other animated control.
  const durationValue = plan
    ? getLayerPropertyKeyframes(layer, GRAPHIC_DURATION_PROPERTY).length
      ? evaluateAnimatedValue<number>({
          baseValue: plan.playDurationSeconds,
          keyframes: layer.animations,
          property: GRAPHIC_DURATION_PROPERTY,
          scope: "layer",
          timeSeconds: layerTime
        })
      : plan.playDurationSeconds
    : 0;
  const progressValue = plan ? graphicAnimationPhase(plan, layerTime) : 0;

  const keyframeProps = (property: string, value: number) => {
    const activeKeyframe = getActiveLayerPropertyKeyframe(layer, property, layerTime);
    const keys = getLayerPropertyKeyframes(layer, property);
    return {
      active: Boolean(activeKeyframe),
      interpolation: activeKeyframe?.interpolation,
      onChangeInterpolation: (interpolation: KeyframeInterpolation) =>
        onChange((item) => setLayerPropertyKeyframeInterpolation(item, property, layerTime, interpolation)),
      hasAny: keys.length > 0,
      hasNext: Boolean(findLayerPropertyKeyframe(layer, property, layerTime, 1)),
      hasPrevious: Boolean(findLayerPropertyKeyframe(layer, property, layerTime, -1)),
      onToggle: () => onChange((item) => toggleLayerPropertyKeyframe(item, property, layerTime, value)),
      onClearAll: () => onChange((item) => clearLayerPropertyKeyframes(item, property)),
      onNext: () => {
        const next = findLayerPropertyKeyframe(layer, property, layerTime, 1);
        if (next) onSeek?.(layer.startSeconds + next.timeSeconds);
      },
      onPrevious: () => {
        const previous = findLayerPropertyKeyframe(layer, property, layerTime, -1);
        if (previous) onSeek?.(layer.startSeconds + previous.timeSeconds);
      }
    };
  };
  const commitSave = () => {
    saveGraphicPreset(presetName || layer.name, graphic);
    setNaming(false);
    setPresetName("");
  };

  return (
    <InspectorSection icon={<Shapes size={15} />} title="Graphic">
      {palette.length ? (
        // Multicolor graphic: one recolor slot per distinct source paint.
        palette.map((slot, index) => (
          <ColorControl
            key={slot.from}
            icon={<Palette size={14} />}
            label={`Color ${index + 1}`}
            palette={defaultColorPalette}
            value={sanitizeGraphicFill(slot.to)}
            onReset={() => onChange((item) => setPaletteSlot(item, slot.from, slot.from))}
            onChange={(value) => onChange((item) => setPaletteSlot(item, slot.from, value))}
          />
        ))
      ) : (
        <ColorControl
          icon={<Shapes size={14} />}
          label="Fill color"
          palette={defaultColorPalette}
          value={fill}
          onReset={() => onChange((item) => setGraphicFill(item, DEFAULT_GRAPHIC_FILL))}
          onChange={(value) => onChange((item) => setGraphicFill(item, value))}
        />
      )}
      {plan ? (
        // SMIL-animated graphic (line-md-style pack). Defaults follow the SVG's OWN intent — a spinner
        // (repeatCount="indefinite") loops, a draw-in (fill="freeze") plays once and holds — and these
        // override it per layer. Both renderers resolve the same plan, so preview matches export.
        <>
          <label className="number-row-select">
            <span className="effect-slider-label">
              <span className="control-icon">
                <Repeat size={14} />
              </span>
              <span className="effect-slider-label-text">Loop</span>
            </span>
            <ThemedSelect
              ariaLabel="Graphic animation loop mode"
              value={graphic.animation?.loop ?? "auto"}
              options={[
                { value: "auto", label: `Auto (${graphicAnimationLoopsByDefault(graphic.svg) ? "infinite" : "once"})` },
                { value: "once", label: "Play once" },
                { value: "infinite", label: "Loop infinite" }
              ]}
              onChange={(value) =>
                onChange((item) => setGraphicAnimation(item, { loop: value === "auto" ? undefined : (value as GraphicLoopMode) }))
              }
            />
          </label>
          <div className="icon-control-row">
            <NumberControl
              icon={<Timer size={14} />}
              label="Duration"
              value={Number(durationValue.toFixed(2))}
              min={0.05}
              max={60}
              step={0.05}
              keyframe={keyframeProps(GRAPHIC_DURATION_PROPERTY, durationValue)}
              onReset={() =>
                onChange((item) => setGraphicAnimation(clearLayerPropertyKeyframes(item, GRAPHIC_DURATION_PROPERTY), { durationSeconds: undefined }))
              }
              onChange={(value) =>
                onChange((item) =>
                  applyLayerPropertyValueAtTime(item, GRAPHIC_DURATION_PROPERTY, layerTime, Math.max(0.05, value), setDurationBase, { autoKeyframe })
                )
              }
            />
          </div>
          <div className="icon-control-row">
            <NumberControl
              icon={<Gauge size={14} />}
              label="Progress"
              value={Number(progressValue.toFixed(2))}
              min={-100}
              max={100}
              step={0.01}
              keyframe={keyframeProps(GRAPHIC_PROGRESS_PROPERTY, progressValue)}
              onReset={() => onChange((item) => clearLayerPropertyKeyframes(item, GRAPHIC_PROGRESS_PROPERTY))}
              onChange={(value) =>
                // Progress has NO base storage — it exists only as keyframes (a lone static value would
                // just freeze the animation), so a scrub always drops a key at the playhead.
                onChange((item) => applyLayerPropertyValueAtTime(item, GRAPHIC_PROGRESS_PROPERTY, layerTime, value, (l) => l, { autoKeyframe: true }))
              }
            />
          </div>
          {progressKeyed ? (
            <div className="effect-preset-row" title="Progress keyframes define the phase directly, so the Duration control no longer applies. Loop still decides whether the phase wraps or holds.">
              Progress keyframes drive the animation — Duration is inactive.
            </div>
          ) : null}
        </>
      ) : null}
      <div className="effect-preset-row">
        {naming ? (
          <>
            <input
              className="effect-preset-name-input"
              autoFocus
              placeholder="Graphic name..."
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitSave();
                if (event.key === "Escape") setNaming(false);
                event.stopPropagation();
              }}
            />
            <button type="button" className="button button-ghost" onClick={commitSave} title="Save graphic preset">
              <Save size={13} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button-ghost"
            title="Save this graphic (with its colors) to re-add from the Graphics bin"
            onClick={() => setNaming(true)}
          >
            <Save size={13} />
            Save graphic
          </button>
        )}
      </div>
    </InspectorSection>
  );
}

function setGraphicFill<T extends { graphic?: LayerGraphic | undefined }>(item: T, fill: string): T {
  if (!item.graphic) {
    return item;
  }
  return { ...item, graphic: { ...item.graphic, fill: sanitizeGraphicFill(fill) } };
}

/**
 * Patch the graphic's animation overrides. An `undefined` field CLEARS that override (back to the SVG's
 * own intent), and once no overrides remain the whole `animation` object is dropped — so "Auto" leaves
 * the graphic byte-identical to a never-touched one (and re-baking keys don't churn on an empty object).
 */
function setGraphicAnimation<T extends { graphic?: LayerGraphic | undefined }>(
  item: T,
  patch: { loop?: GraphicLoopMode | undefined; durationSeconds?: number | undefined }
): T {
  if (!item.graphic) {
    return item;
  }
  const current = item.graphic.animation ?? {};
  const next = { ...current, ...patch };
  const cleaned: { loop?: GraphicLoopMode; durationSeconds?: number } = {};
  if (next.loop) cleaned.loop = next.loop;
  if (next.durationSeconds != null && next.durationSeconds > 0) cleaned.durationSeconds = next.durationSeconds;
  const animation = Object.keys(cleaned).length ? cleaned : undefined;
  return { ...item, graphic: { ...item.graphic, animation } };
}

function setPaletteSlot<T extends { graphic?: LayerGraphic | undefined }>(item: T, from: string, to: string): T {
  if (!item.graphic) {
    return item;
  }
  const palette = (item.graphic.palette ?? []).map((slot) =>
    slot.from === from ? { ...slot, to: sanitizeGraphicFill(to) } : slot
  );
  return { ...item, graphic: { ...item.graphic, palette } };
}
