/**
 * Content / Crop panel — adjusts the SOURCE MEDIA *within* the clip's frame (CapCut/Canva-style), separate
 * from the comp-space Transform (which moves the whole frame). Lets you reframe a mismatched-aspect source
 * (e.g. a 9:16 video in a 16:9 comp): zoom + pan the visible part, and crop the frame edges. Writes the
 * `content` field; every renderer reads it via `getCompositionContentTransform`. Media (video/image) only.
 *
 * Uses the shared EffectSliderControl (label + slider + number + reset) so it matches the effect panels.
 * Numeric/sliders for now; the Canva-style in-viewer double-tap + drag handles are a follow-up.
 */

import { Crop } from "lucide-react";
import type { LayerContentTransform, TimelineLayer } from "@reelforge/shared";
import type { InspectorPanelProps } from "../../registry/inspector";
import { InspectorSection } from "../InspectorSection";
import { EffectSliderControl } from "../../../components/EffectSliderControl";

type CropEdge = "top" | "right" | "bottom" | "left";
const CROP_EDGES: Array<{ edge: CropEdge; label: string }> = [
  { edge: "top", label: "Crop Top" },
  { edge: "right", label: "Crop Right" },
  { edge: "bottom", label: "Crop Bottom" },
  { edge: "left", label: "Crop Left" }
];

export default function ContentPanel({ layer, onChange }: InspectorPanelProps) {
  const content = layer.content ?? {};
  const scale = content.scale ?? 1;
  const offsetX = content.offsetX ?? 0;
  const offsetY = content.offsetY ?? 0;
  const crop = content.crop ?? {};

  const patch = (next: Partial<LayerContentTransform>) =>
    onChange((item: TimelineLayer) => ({ ...item, content: { ...(item.content ?? {}), ...next } }));
  const patchCrop = (edge: CropEdge, value: number) =>
    onChange((item: TimelineLayer) => ({
      ...item,
      content: { ...(item.content ?? {}), crop: { ...(item.content?.crop ?? {}), [edge]: value } }
    }));

  return (
    <InspectorSection title="Content / Crop" icon={<Crop size={13} />} defaultOpen={false}>
      <div className="effect-controls">
        <EffectSliderControl
          label="Scale"
          tone="light"
          value={Math.round(scale * 100)}
          min={10}
          max={800}
          step={1}
          onReset={scale !== 1 ? () => patch({ scale: 1 }) : undefined}
          onChange={(v) => patch({ scale: Math.max(0.1, v / 100) })}
        />
        <EffectSliderControl
          label="Pan X"
          value={Math.round(offsetX * 100)}
          min={-100}
          max={100}
          step={1}
          onReset={offsetX !== 0 ? () => patch({ offsetX: 0 }) : undefined}
          onChange={(v) => patch({ offsetX: v / 100 })}
        />
        <EffectSliderControl
          label="Pan Y"
          value={Math.round(offsetY * 100)}
          min={-100}
          max={100}
          step={1}
          onReset={offsetY !== 0 ? () => patch({ offsetY: 0 }) : undefined}
          onChange={(v) => patch({ offsetY: v / 100 })}
        />
        {CROP_EDGES.map(({ edge, label }) => {
          const value = crop[edge] ?? 0;
          return (
            <EffectSliderControl
              key={edge}
              label={label}
              tone="shadow"
              value={Math.round(value * 100)}
              min={0}
              max={95}
              step={1}
              onReset={value !== 0 ? () => patchCrop(edge, 0) : undefined}
              onChange={(v) => patchCrop(edge, Math.max(0, Math.min(0.95, v / 100)))}
            />
          );
        })}
      </div>
    </InspectorSection>
  );
}
