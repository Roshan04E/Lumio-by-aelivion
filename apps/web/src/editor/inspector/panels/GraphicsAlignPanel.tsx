/**
 * Graphics tab — Align (Premiere EGP "Align & Transform"). Six align-to-frame buttons that write
 * the layer's transform position so its PAINTED content box (not the comp-filling element box)
 * lands flush left/center/right/top/middle/bottom. Writes go through applyTransformValueAtTime so
 * keyframed/auto-keyframe layers behave like every other transform edit.
 */

import type { ReactNode } from "react";
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  LayoutPanelTop
} from "lucide-react";
import { containContentRect, getCompositionTransform, type TimelineLayer } from "@kimera-by-aelivion/shared";
import { InspectorSection } from "../InspectorSection";
import { applyTransformValueAtTime } from "../keyframeUtils";

type AlignTarget = "left" | "centerH" | "right" | "top" | "middle" | "bottom";

/**
 * The layer's painted box as fractions of the comp (before the layer transform's scale).
 * Media/graphics: the `contain` content rect from the natural aspect (full frame for cover/fill or
 * unknown aspect). Shapes: their percent box. Text: the wrap width + a line-count height estimate
 * (Premiere also aligns the text BOX, not glyph ink).
 */
function contentFractions(layer: TimelineLayer, compWidth: number, compHeight: number): { w: number; h: number } {
  if (layer.type === "shape") {
    return { w: (layer.widthPercent ?? 40) / 100, h: (layer.heightPercent ?? 40) / 100 };
  }
  if (layer.type === "text") {
    const lines = (layer.text ?? "").split("\n").length || 1;
    const fontSize = layer.fontSize ?? 64;
    const lineHeight = layer.lineHeight ?? 1.2;
    return {
      w: (layer.textWidthPercent ?? 80) / 100,
      h: Math.min(1, (lines * fontSize * lineHeight) / compHeight)
    };
  }
  const aspect =
    layer.graphic?.naturalWidth && layer.graphic.naturalHeight
      ? layer.graphic.naturalWidth / layer.graphic.naturalHeight
      : undefined;
  if ((layer.fit ?? (layer.graphic ? "contain" : "cover")) === "contain") {
    const rect = containContentRect(compWidth, compHeight, aspect);
    if (rect) return { w: rect.width / compWidth, h: rect.height / compHeight };
  }
  return { w: 1, h: 1 };
}

export default function GraphicsAlignPanel({
  layer,
  composition,
  currentTime,
  autoKeyframe,
  onChange
}: {
  layer: TimelineLayer;
  composition: { width: number; height: number };
  currentTime: number;
  autoKeyframe?: boolean | undefined;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
}) {
  const layerTime = Math.max(0, currentTime - layer.startSeconds);

  function align(target: AlignTarget) {
    onChange((item) => {
      const resolved = getCompositionTransform(item, { currentTimeSeconds: currentTime });
      const scale = resolved.scale || 1;
      const { w, h } = contentFractions(item, composition.width, composition.height);
      // Position is the content CENTER in percent; a box of fraction `w` scaled by `scale` spans
      // w*scale*100 percent, so flush-left puts its center at half that span.
      const halfW = Math.min(50, w * scale * 50);
      const halfH = Math.min(50, h * scale * 50);
      if (target === "left" || target === "centerH" || target === "right") {
        const x = target === "left" ? halfW : target === "right" ? 100 - halfW : 50;
        return applyTransformValueAtTime(item, "transform.position.x", layerTime, x, { autoKeyframe });
      }
      const y = target === "top" ? halfH : target === "bottom" ? 100 - halfH : 50;
      return applyTransformValueAtTime(item, "transform.position.y", layerTime, y, { autoKeyframe });
    });
  }

  const buttons: Array<{ target: AlignTarget; title: string; icon: ReactNode }> = [
    { target: "left", title: "Align left edge to frame", icon: <AlignHorizontalJustifyStart size={14} /> },
    { target: "centerH", title: "Center horizontally", icon: <AlignHorizontalJustifyCenter size={14} /> },
    { target: "right", title: "Align right edge to frame", icon: <AlignHorizontalJustifyEnd size={14} /> },
    { target: "top", title: "Align top edge to frame", icon: <AlignVerticalJustifyStart size={14} /> },
    { target: "middle", title: "Center vertically", icon: <AlignVerticalJustifyCenter size={14} /> },
    { target: "bottom", title: "Align bottom edge to frame", icon: <AlignVerticalJustifyEnd size={14} /> }
  ];

  return (
    <InspectorSection title="Align" icon={<LayoutPanelTop size={13} />}>
      <div className="graphics-align-row">
        {buttons.map(({ target, title, icon }) => (
          <button key={target} type="button" title={title} aria-label={title} onClick={() => align(target)}>
            {icon}
          </button>
        ))}
      </div>
    </InspectorSection>
  );
}
