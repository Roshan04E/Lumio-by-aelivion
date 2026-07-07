/**
 * Content / Crop panel — adjusts the SOURCE MEDIA *within* the clip's frame (CapCut/Canva-style), separate
 * from the comp-space Transform (which moves the whole frame). Lets you reframe a mismatched-aspect source
 * (e.g. a 9:16 video in a 16:9 comp): zoom + pan the visible part, and crop the frame edges. Writes the
 * `content` field; every renderer reads it via `getCompositionContentTransform`. Media (video/image) only.
 *
 * Uses the shared EffectSliderControl (label + keyframe nav + slider + number + reset) so it matches the
 * effect panels. Each field is keyframeable (`content.*` layer-scope keyframes) via the shared evaluator, so
 * pan/zoom/crop animate identically in preview and export.
 */

import { Crop } from "lucide-react";
import { getCompositionContentTransform } from "@lumio-by-aelivion/shared";
import type { InspectorPanelProps } from "../../registry/inspector";
import { InspectorSection } from "../InspectorSection";
import { EffectSliderControl } from "../../../components/EffectSliderControl";
import {
  applyContentValueAtTime,
  clamp,
  clearContentKeyframes,
  findContentKeyframeTime,
  getActiveContentKeyframe,
  getContentKeyframes,
  toggleContentKeyframe,
  type ContentAnimationProperty
} from "../keyframeUtils";

type CropEdge = "top" | "right" | "bottom" | "left";
const CROP_EDGES: Array<{ edge: CropEdge; label: string; property: ContentAnimationProperty }> = [
  { edge: "top", label: "Crop Top", property: "content.crop.top" },
  { edge: "right", label: "Crop Right", property: "content.crop.right" },
  { edge: "bottom", label: "Crop Bottom", property: "content.crop.bottom" },
  { edge: "left", label: "Crop Left", property: "content.crop.left" }
];

export default function ContentPanel({ layer, onChange, currentTime = 0, onSeek, autoKeyframe }: InspectorPanelProps) {
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);
  // Animated (playhead-evaluated) content values so sliders track keyframes, not just the static base.
  const resolved = getCompositionContentTransform(layer, { currentTimeSeconds: currentTime });

  // One keyframe-control descriptor per content property, shared shape with the effect sliders.
  function contentKeyframe(property: ContentAnimationProperty) {
    const active = Boolean(getActiveContentKeyframe(layer, property, layerTime));
    const currentRaw = getContentBaseAt(property);
    return {
      active,
      hasAny: getContentKeyframes(layer, property).length > 0,
      hasNext: findContentKeyframeTime(layer, property, layerTime, 1) !== undefined,
      hasPrevious: findContentKeyframeTime(layer, property, layerTime, -1) !== undefined,
      onToggle: () => onChange((item) => toggleContentKeyframe(item, property, layerTime, currentRaw)),
      onClearAll: () => onChange((item) => clearContentKeyframes(item, property)),
      onNext: () => {
        const t = findContentKeyframeTime(layer, property, layerTime, 1);
        if (t !== undefined) onSeek?.(layer.startSeconds + t);
      },
      onPrevious: () => {
        const t = findContentKeyframeTime(layer, property, layerTime, -1);
        if (t !== undefined) onSeek?.(layer.startSeconds + t);
      }
    };
  }

  // Current (animated) raw value for a property — used as the value stored when a keyframe is toggled on.
  function getContentBaseAt(property: ContentAnimationProperty): number {
    switch (property) {
      case "content.scale":
        return resolved.scale;
      case "content.offsetX":
        return resolved.offsetX;
      case "content.offsetY":
        return resolved.offsetY;
      case "content.crop.top":
        return resolved.crop.top;
      case "content.crop.right":
        return resolved.crop.right;
      case "content.crop.bottom":
        return resolved.crop.bottom;
      case "content.crop.left":
        return resolved.crop.left;
      default:
        return 0;
    }
  }

  const write = (property: ContentAnimationProperty, raw: number) =>
    onChange((item) => applyContentValueAtTime(item, property, layerTime, raw, { autoKeyframe }));

  return (
    <InspectorSection title="Content / Crop" icon={<Crop size={13} />} defaultOpen={false}>
      <div className="effect-controls">
        <EffectSliderControl
          label="Scale"
          tone="light"
          value={Math.round(resolved.scale * 100)}
          min={10}
          max={800}
          step={1}
          keyframe={contentKeyframe("content.scale")}
          onReset={resolved.scale !== 1 ? () => write("content.scale", 1) : undefined}
          onChange={(v) => write("content.scale", Math.max(0.1, v / 100))}
        />
        <EffectSliderControl
          label="Pan X"
          value={Math.round(resolved.offsetX * 100)}
          min={-100}
          max={100}
          step={1}
          keyframe={contentKeyframe("content.offsetX")}
          onReset={resolved.offsetX !== 0 ? () => write("content.offsetX", 0) : undefined}
          onChange={(v) => write("content.offsetX", v / 100)}
        />
        <EffectSliderControl
          label="Pan Y"
          value={Math.round(resolved.offsetY * 100)}
          min={-100}
          max={100}
          step={1}
          keyframe={contentKeyframe("content.offsetY")}
          onReset={resolved.offsetY !== 0 ? () => write("content.offsetY", 0) : undefined}
          onChange={(v) => write("content.offsetY", v / 100)}
        />
        {CROP_EDGES.map(({ edge, label, property }) => {
          const value = resolved.crop[edge];
          return (
            <EffectSliderControl
              key={edge}
              label={label}
              tone="shadow"
              value={Math.round(value * 100)}
              min={0}
              max={95}
              step={1}
              keyframe={contentKeyframe(property)}
              onReset={value !== 0 ? () => write(property, 0) : undefined}
              onChange={(v) => write(property, Math.max(0, Math.min(0.95, v / 100)))}
            />
          );
        })}
      </div>
    </InspectorSection>
  );
}
