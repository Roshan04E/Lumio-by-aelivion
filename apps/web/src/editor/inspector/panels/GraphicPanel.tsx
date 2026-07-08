/**
 * Graphic panel — edits a vector graphic layer (a Search → Graphics pick stored as `layer.graphic`). Solid
 * fill color for now; the SVG is recolored live via `graphicToDataUrl`, so preview and export update instantly
 * and stay crisp at any scale. Renders nothing for ordinary photo/file image layers (no `layer.graphic`).
 */

import { Shapes } from "lucide-react";
import { sanitizeGraphicFill, DEFAULT_GRAPHIC_FILL } from "@lumio-by-aelivion/shared";
import type { InspectorPanelProps } from "../../registry/inspector";
import { InspectorSection } from "../InspectorSection";
import { ColorControl } from "../../../components/ColorControl";
import { defaultColorPalette } from "../../../lib/colorPalette";

export default function GraphicPanel({ layer, onChange }: InspectorPanelProps) {
  const graphic = layer.graphic;
  if (!graphic) {
    return null;
  }
  const fill = sanitizeGraphicFill(graphic.fill);

  return (
    <InspectorSection icon={<Shapes size={15} />} title="Graphic">
      <ColorControl
        icon={<Shapes size={14} />}
        label="Fill color"
        palette={defaultColorPalette}
        value={fill}
        onReset={() => onChange((item) => setGraphicFill(item, DEFAULT_GRAPHIC_FILL))}
        onChange={(value) => onChange((item) => setGraphicFill(item, value))}
      />
    </InspectorSection>
  );
}

function setGraphicFill<T extends { graphic?: { svg: string; fill: string } | undefined }>(item: T, fill: string): T {
  if (!item.graphic) {
    return item;
  }
  return { ...item, graphic: { ...item.graphic, fill: sanitizeGraphicFill(fill) } };
}
