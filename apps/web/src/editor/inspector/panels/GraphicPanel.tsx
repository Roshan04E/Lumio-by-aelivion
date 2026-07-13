/**
 * Graphic panel — edits a vector graphic layer (a Search → Graphics pick stored as `layer.graphic`).
 * Single-color graphics get the solid Fill control (recolored via `currentColor`); multicolor
 * graphics (external SVGs baked with several paints) get one control per palette slot, applied as
 * exact-literal substitutions in `graphicToDataUrl` — so preview and export update instantly and
 * stay crisp at any scale. Renders nothing for ordinary photo/file image layers (no `layer.graphic`).
 */

import { useState } from "react";
import { Shapes, Palette, Save } from "lucide-react";
import { sanitizeGraphicFill, DEFAULT_GRAPHIC_FILL, type LayerGraphic } from "@kimera-by-aelivion/shared";
import type { InspectorPanelProps } from "../../registry/inspector";
import { InspectorSection } from "../InspectorSection";
import { ColorControl } from "../../../components/ColorControl";
import { defaultColorPalette } from "../../../lib/colorPalette";
import { saveGraphicPreset } from "../../graphic-presets";

export default function GraphicPanel({ layer, onChange }: InspectorPanelProps) {
  const [naming, setNaming] = useState(false);
  const [presetName, setPresetName] = useState("");
  const graphic = layer.graphic;
  if (!graphic) {
    return null;
  }
  const fill = sanitizeGraphicFill(graphic.fill);
  const palette = graphic.palette ?? [];
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

function setPaletteSlot<T extends { graphic?: LayerGraphic | undefined }>(item: T, from: string, to: string): T {
  if (!item.graphic) {
    return item;
  }
  const palette = (item.graphic.palette ?? []).map((slot) =>
    slot.from === from ? { ...slot, to: sanitizeGraphicFill(to) } : slot
  );
  return { ...item, graphic: { ...item.graphic, palette } };
}
