/**
 * The style preset library (ADR-023 S6 / D12 layer 1) — browse and apply.
 *
 * Distinct from {@link TextStylesSection} directly above it, and the distinction is the product one:
 * Text Styles are looks YOU saved in THIS project; this is the shipped library, the same object in
 * the same envelope, listed by category. Both call the same apply path.
 *
 * **Apply-to-captions is the feature this whole stage exists for.** `AUTO_CAPTIONS` already produces
 * a caption track; one click that bakes a look across every segment of it is short-form captioning,
 * with no graphics-template machinery involved at all (D12 keeps that at layer 2).
 *
 * VIEW STATE ONLY here — which category tab is open, which row is highlighted. The presets are data
 * from `@orreris/shared`, and the mutation is routed by EditorPage like every other look apply.
 */

import { useMemo, useState } from "react";
import { Check, Captions, Sparkles } from "lucide-react";
import {
  stylePresetsForCategory,
  type PresetReference,
  type StylePreset,
  type StylePresetCategory
} from "@orreris/shared";
import { InspectorSection } from "./InspectorSection";

const CATEGORY_TABS: ReadonlyArray<{ id: StylePresetCategory; label: string }> = [
  { id: "caption", label: "Captions" },
  { id: "title", label: "Titles" },
  { id: "shape", label: "Shapes" }
];

export function StylePresetsSection({
  layerType,
  userPresets = [],
  onApply,
  onApplyToCaptions,
  hasCaptionTrack = false,
  unresolvedFor
}: {
  layerType: "text" | "shape";
  userPresets?: readonly StylePreset[] | undefined;
  onApply: (preset: StylePreset) => void;
  /** Absent when there is no caption track to apply across. */
  onApplyToCaptions?: ((preset: StylePreset) => void) | undefined;
  hasCaptionTrack?: boolean | undefined;
  /** OQ8's humane half: what this viewer cannot resolve, by name, BEFORE they apply it. */
  unresolvedFor?: ((preset: StylePreset) => PresetReference[]) | undefined;
}) {
  // A shape layer can only take shape looks, so it opens on the tab that can do something.
  const [category, setCategory] = useState<StylePresetCategory>(layerType === "shape" ? "shape" : "caption");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const presets = useMemo(() => stylePresetsForCategory(category, userPresets), [category, userPresets]);
  const selected = presets.find((preset) => preset.id === selectedId) ?? null;
  const unresolved = selected && unresolvedFor ? unresolvedFor(selected) : [];

  return (
    <InspectorSection title="Presets" icon={<Sparkles size={13} />} count={presets.length} defaultOpen={false}>
      <div className="style-presets">
        <div className="style-presets-tabs" role="tablist">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={category === tab.id}
              className={category === tab.id ? "is-active" : undefined}
              onClick={() => {
                setCategory(tab.id);
                setSelectedId(null);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="style-presets-list" role="listbox" aria-label="Style presets">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={preset.id === selectedId}
              className={`style-presets-row${preset.id === selectedId ? " is-selected" : ""}`}
              title={preset.description ?? preset.name}
              onClick={() => setSelectedId(preset.id)}
              onDoubleClick={() => onApply(preset)}
            >
              <span className="style-presets-name">{preset.name}</span>
              {preset.description ? <span className="style-presets-desc">{preset.description}</span> : null}
            </button>
          ))}
        </div>

        {/* Named, before the apply — not after the render fails. OQ7's closing note, one layer up. */}
        {unresolved.length ? (
          <p className="style-presets-warning">
            {unresolved.map((ref) => `${ref.kind === "font" ? "Font" : "Image"} “${ref.label}”`).join(", ")} isn’t available to
            you — the rest of the look still applies.
          </p>
        ) : null}

        <div className="style-presets-actions">
          <button type="button" disabled={!selected} onClick={() => selected && onApply(selected)}>
            <Check size={13} /> Apply
          </button>
          {onApplyToCaptions ? (
            <button
              type="button"
              disabled={!selected || !hasCaptionTrack || category === "shape"}
              title={hasCaptionTrack ? "Apply this look to every caption on the track" : "No caption track in this project"}
              onClick={() => selected && onApplyToCaptions(selected)}
            >
              <Captions size={13} /> All captions
            </button>
          ) : null}
        </div>
      </div>
    </InspectorSection>
  );
}
