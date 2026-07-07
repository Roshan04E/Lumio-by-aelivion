/**
 * Effect presets row (Effects inspector): save the selected clip's effect stack as a named look,
 * apply/delete saved looks. Application reuses the shared paste-attributes path
 * (`applyAttributesToLayer`) so effect ids are re-minted per layer; transform is never stored
 * (see effect-presets.ts), so applying a look can't move a clip.
 */
import { useState, useSyncExternalStore } from "react";
import { Save, Trash2, Wand2 } from "lucide-react";
import type { TimelineLayer } from "@lumio-by-aelivion/shared";
import { applyAttributesToLayer } from "@lumio-by-aelivion/shared";
import { deleteEffectPreset, listEffectPresets, saveEffectPreset, subscribeEffectPresets } from "../editor/effect-presets";
import { ThemedSelect } from "../editor/inspector/controls/ThemedSelect";

interface EffectPresetRowProps {
  layer: TimelineLayer;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  onNotice?: ((message: string) => void) | undefined;
}

export function EffectPresetRow({ layer, onChange, onNotice }: EffectPresetRowProps) {
  const presets = useSyncExternalStore(subscribeEffectPresets, listEffectPresets, listEffectPresets);
  const [selectedId, setSelectedId] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const selected = presets.find((p) => p.id === selectedId) ?? null;

  const commitSave = () => {
    const preset = saveEffectPreset(name, layer);
    setSelectedId(preset.id);
    setNaming(false);
    setName("");
    onNotice?.(`Preset "${preset.name}" saved`);
  };

  return (
    <div className="effect-preset-row">
      {naming ? (
        <>
          <input
            className="effect-preset-name-input"
            autoFocus
            placeholder="Preset name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSave();
              if (e.key === "Escape") setNaming(false);
              e.stopPropagation();
            }}
          />
          <button type="button" className="button button-ghost" onClick={commitSave} title="Save preset">
            <Save size={13} />
          </button>
        </>
      ) : (
        <>
          <ThemedSelect
            className="effect-preset-select"
            value={selectedId}
            ariaLabel="Saved effect presets"
            options={[
              { value: "", label: "Presets..." },
              ...presets.map((preset) => ({ value: preset.id, label: preset.name }))
            ]}
            onChange={setSelectedId}
          />
          <button
            type="button"
            className="button button-ghost"
            disabled={!selected}
            title="Apply preset to this clip (replaces its effects)"
            onClick={() => {
              if (!selected) return;
              onChange((item) => applyAttributesToLayer(item, selected.attributes));
              onNotice?.(`Preset "${selected.name}" applied`);
            }}
          >
            <Wand2 size={13} />
            Apply
          </button>
          <button
            type="button"
            className="button button-ghost"
            disabled={!selected}
            title="Delete selected preset"
            onClick={() => {
              if (!selected) return;
              deleteEffectPreset(selected.id);
              setSelectedId("");
            }}
          >
            <Trash2 size={13} />
          </button>
          <button
            type="button"
            className="button button-ghost"
            disabled={!layer.effects.length}
            title="Save this clip's effects as a preset"
            onClick={() => setNaming(true)}
          >
            <Save size={13} />
            Save
          </button>
        </>
      )}
    </div>
  );
}
