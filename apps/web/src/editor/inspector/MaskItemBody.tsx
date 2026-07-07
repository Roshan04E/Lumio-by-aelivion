import { useState } from "react";
import { ChevronLeft, ChevronRight, Diamond, FlipHorizontal2, Spline } from "lucide-react";
import {
  resolveMaskAtTime,
  trackingPathToMaskTransformKeyframes,
  withAutoTangents,
  type Mask,
  type MaskMode,
  type MaskScalarProperty,
  type TimelineLayer
} from "@lumio-by-aelivion/shared";
import { ThemedSelect, type ThemedSelectGroup } from "./controls/ThemedSelect";
import { EffectSliderControl } from "../../components/EffectSliderControl";
import { averageTrackConfidence, type SavedTrack } from "../../lib/trackLibrary";
import {
  attachTrackToMask,
  clearMaskScalarKeyframes,
  detachTrackFromMask,
  findMaskPathKeyframeTime,
  findMaskScalarKeyframeTime,
  getActiveMaskScalarKeyframe,
  getMaskPathKeyframes,
  getMaskScalarKeyframes,
  hasMaskPathKeyframeAt,
  maskScalarKeyframeCount,
  setMaskScalarInterpolation,
  toggleMaskPathKeyframe,
  toggleMaskScalarKeyframe,
  updateMaskById,
  updateMaskScalarAtTime
} from "./maskKeyframeUtils";

const MODE_GROUPS: ThemedSelectGroup<MaskMode>[] = [
  {
    label: "Mode",
    options: [
      { value: "add", label: "Add" },
      { value: "subtract", label: "Subtract" },
      { value: "intersect", label: "Intersect" },
      { value: "exclude", label: "Exclude" }
    ]
  }
];

/**
 * The per-mask controls *below* the item header — shared by clip masks (`MaskPanel`) and effect-region masks
 * (`EffectMaskControls`) so the two never diverge. Mode/Invert, shape keyframes, keyframeable scalar +
 * transform sliders, and mask tracking. Works for a mask in either `layer.masks` or `effect.masks` because all
 * the helpers (and `mapMask`) are container-agnostic; `onChange` commits a layer update (with history).
 */
export function MaskItemBody({
  layer,
  mask,
  width,
  height,
  layerTime,
  seek,
  trackLibrary,
  onChange
}: {
  layer: TimelineLayer;
  mask: Mask;
  width: number;
  height: number;
  layerTime: number;
  seek: (timeSeconds: number) => void;
  trackLibrary?: SavedTrack[] | undefined;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
}) {
  const resolved = resolveMaskAtTime(mask, layer.animations, layerTime);
  const pathKeyframes = getMaskPathKeyframes(mask);
  const pathActive = hasMaskPathKeyframeAt(mask, layerTime);
  const scalarCount = maskScalarKeyframeCount(layer, mask.id);
  const canSmooth = mask.points.length >= 3 && mask.shape !== "ellipse";

  // --- Mask tracking ---
  const tracks = trackLibrary ?? [];
  const trackGroups: ThemedSelectGroup<string>[] = [
    {
      label: "Tracks",
      options: tracks.map((track) => ({
        value: track.id,
        label: `${track.label} (${Math.round(averageTrackConfidence(track.trackingPath) * 100)}%)`
      }))
    }
  ];
  function attachedTrackId(maskId: string): string | undefined {
    const base = `${layer.id}_mask_${maskId}_track_`;
    const kf = (layer.animations ?? []).find((k) => k.id.startsWith(base));
    return kf?.id.slice(base.length).replace(/_(x|y)_\d+$/, "");
  }
  const [trackChoice, setTrackChoice] = useState<Record<string, string>>({});
  function attachTrack(trackId: string) {
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return;
    const keyPrefix = `${layer.id}_mask_${mask.id}_track_${trackId}`;
    const keyframes = trackingPathToMaskTransformKeyframes(track.trackingPath, {
      maskId: mask.id,
      basePx: { x: mask.transform.x, y: mask.transform.y },
      compWidth: width,
      compHeight: height,
      keyPrefix
    });
    onChange((item) => attachTrackToMask(item, keyframes, keyPrefix));
  }
  function detachTrack(trackId: string) {
    onChange((item) => detachTrackFromMask(item, `${layer.id}_mask_${mask.id}_track_${trackId}`));
  }

  function scalarKeyframe(property: MaskScalarProperty, resolvedValue: number) {
    const active = getActiveMaskScalarKeyframe(layer, mask.id, property, layerTime);
    const nextTime = findMaskScalarKeyframeTime(layer, mask.id, property, layerTime, 1);
    const previousTime = findMaskScalarKeyframeTime(layer, mask.id, property, layerTime, -1);
    return {
      active: Boolean(active),
      hasAny: getMaskScalarKeyframes(layer, mask.id, property).length > 0,
      hasNext: nextTime !== undefined,
      hasPrevious: previousTime !== undefined,
      interpolation: active?.interpolation,
      onChangeInterpolation: (interpolation: Parameters<typeof setMaskScalarInterpolation>[4]) =>
        onChange((item) => setMaskScalarInterpolation(item, mask.id, property, layerTime, interpolation)),
      onClearAll: () => onChange((item) => clearMaskScalarKeyframes(item, mask.id, property)),
      onNext: () => {
        if (nextTime !== undefined) seek(nextTime);
      },
      onPrevious: () => {
        if (previousTime !== undefined) seek(previousTime);
      },
      onToggle: () => onChange((item) => toggleMaskScalarKeyframe(item, mask.id, property, layerTime, resolvedValue))
    };
  }
  function scalarSlider(property: MaskScalarProperty, label: string, resolvedValue: number, min: number, max: number, step: number) {
    return (
      <EffectSliderControl
        label={label}
        value={resolvedValue}
        min={min}
        max={max}
        step={step}
        keyframe={scalarKeyframe(property, resolvedValue)}
        onChange={(value) => onChange((item) => updateMaskScalarAtTime(item, mask.id, property, layerTime, value))}
      />
    );
  }

  const attached = attachedTrackId(mask.id);
  const selectedTrack = trackChoice[mask.id] ?? attached ?? tracks[0]?.id ?? "";

  return (
    <>
      <div className="mask-item-row">
        <div className="number-control">
          <span>
            <span className="number-control-label">
              <small>Mode</small>
            </span>
          </span>
          <ThemedSelect
            ariaLabel="Mask mode"
            value={mask.mode}
            groups={MODE_GROUPS}
            onChange={(mode) => onChange((item) => updateMaskById(item, mask.id, { mode }))}
          />
        </div>
        <button
          type="button"
          className={`mask-invert-btn ${mask.inverted ? "is-active" : ""}`}
          title="Invert mask"
          onClick={() => onChange((item) => updateMaskById(item, mask.id, { inverted: !mask.inverted }))}
        >
          <FlipHorizontal2 size={13} /> Invert
        </button>
      </div>

      {/* Shape (path) keyframe row — animate the outline itself over time. */}
      <div className="mask-kf-row" aria-label="Shape keyframes">
        <span className="mask-kf-label">
          <Spline size={12} /> Shape
        </span>
        <div className="mask-kf-nav">
          <button
            type="button"
            title="Previous shape keyframe"
            disabled={findMaskPathKeyframeTime(mask, layerTime, -1) === undefined}
            onClick={() => {
              const t = findMaskPathKeyframeTime(mask, layerTime, -1);
              if (t !== undefined) seek(t);
            }}
          >
            <ChevronLeft size={12} />
          </button>
          <button
            type="button"
            className={pathActive ? "is-active" : ""}
            title={pathActive ? "Remove shape keyframe" : "Add shape keyframe (animate the outline)"}
            onClick={() => onChange((item) => toggleMaskPathKeyframe(item, mask.id, layerTime))}
          >
            <Diamond size={11} />
          </button>
          <button
            type="button"
            title="Next shape keyframe"
            disabled={findMaskPathKeyframeTime(mask, layerTime, 1) === undefined}
            onClick={() => {
              const t = findMaskPathKeyframeTime(mask, layerTime, 1);
              if (t !== undefined) seek(t);
            }}
          >
            <ChevronRight size={12} />
          </button>
          {pathKeyframes.length ? <span className="mask-kf-count">{pathKeyframes.length}</span> : null}
        </div>
      </div>
      {pathKeyframes.length === 0 ? (
        <p className="mask-hint">Click ◆ then move the playhead and drag points to animate the outline.</p>
      ) : null}

      <div className="mask-slider-stack">
        {scalarSlider("feather", "Feather", resolved.feather, 0, 500, 1)}
        {scalarSlider("expansion", "Expansion", resolved.expansion, -200, 200, 1)}
        {scalarSlider("opacity", "Opacity", resolved.opacity, 0, 100, 1)}
      </div>

      <div className="mask-subhead">Transform</div>
      <div className="mask-slider-stack">
        {scalarSlider("transform.x", "X", resolved.transform.x, -width, width, 1)}
        {scalarSlider("transform.y", "Y", resolved.transform.y, -height, height, 1)}
        {scalarSlider("transform.scaleX", "Scale X", resolved.transform.scaleX, 0.1, 3, 0.01)}
        {scalarSlider("transform.scaleY", "Scale Y", resolved.transform.scaleY, 0.1, 3, 0.01)}
        {scalarSlider("transform.rotation", "Rotation", resolved.transform.rotation, -180, 180, 1)}
      </div>

      {/* Mask tracking — make the mask follow a saved motion track (rides on its current X/Y). */}
      <div className="mask-subhead">Tracking</div>
      {tracks.length === 0 ? (
        <p className="mask-hint">Save a motion track in the Track panel, then a mask can follow it.</p>
      ) : (
        <div className="mask-track-row">
          <ThemedSelect
            ariaLabel="Follow track"
            value={selectedTrack}
            groups={trackGroups}
            onChange={(id) => setTrackChoice((prev) => ({ ...prev, [mask.id]: id }))}
          />
          {attached ? (
            <button type="button" className="mask-track-btn is-active" title="Stop following this track" onClick={() => detachTrack(attached)}>
              Detach
            </button>
          ) : (
            <button type="button" className="mask-track-btn" title="Follow this track's motion" disabled={!selectedTrack} onClick={() => attachTrack(selectedTrack)}>
              Attach
            </button>
          )}
        </div>
      )}

      {canSmooth ? (
        <button
          type="button"
          className="mask-smooth-btn"
          title="Smooth all points into a Bezier curve"
          onClick={() => onChange((item) => updateMaskById(item, mask.id, { shape: "bezier", points: withAutoTangents(mask.points) }))}
        >
          <Spline size={12} /> Smooth points
        </button>
      ) : null}

      {scalarCount ? <span className="mask-kf-summary">{scalarCount} property keyframe{scalarCount === 1 ? "" : "s"}</span> : null}
    </>
  );
}
