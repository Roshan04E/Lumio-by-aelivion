/**
 * Flarex node param metadata — the numeric ranges (mirroring node-defs' Zod bounds) and the
 * `GraphTarget` builder that lets the SHARED graph editor plot/keyframe node params. Kept in one
 * place so the inspector sliders and the graph-editor lanes clamp identically (a lane that clamped
 * differently from its inspector row would let one surface author a value the other refuses).
 */

import type { FlarexNode } from "@orreris/shared";
import { getFlarexNodeDefinition } from "@orreris/shared";
import type { GraphTarget } from "../inspector/keyframeUtils";

/** `<nodeType>.<paramKey>` → [min, max, step]. Missing keys fall back to a free 0..1 field. */
export const FLAREX_PARAM_RANGES: Record<string, [number, number, number]> = {
  "merge.opacity": [0, 1, 0.01],
  "transform.x": [-100, 100, 0.5],
  "transform.y": [-100, 100, 0.5],
  "transform.scale": [0, 4, 0.01],
  "transform.rotation": [-180, 180, 1],
  "transform.anchorX": [0, 1, 0.01],
  "transform.anchorY": [0, 1, 0.01],
  "colorCorrect.exposure": [-100, 100, 1],
  "colorCorrect.contrast": [-100, 100, 1],
  "colorCorrect.saturation": [0, 220, 1],
  "colorCorrect.temperature": [-100, 100, 1],
  "colorCorrect.tint": [-100, 100, 1],
  "blur.sigma": [0, 200, 1],
  "glow.radius": [0, 200, 1],
  "glow.intensity": [0, 2, 0.01],
  "glow.threshold": [0, 1, 0.01],
  "sharpen.amount": [0, 2, 0.01],
  "filter.intensity": [0, 1, 0.01],
  "chromaKey.tolerance": [0, 1, 0.01],
  "chromaKey.softness": [0, 1, 0.01],
  "chromaKey.clipBlack": [0, 1, 0.01],
  "chromaKey.clipWhite": [0, 1, 0.01],
  "chromaKey.spillSuppression": [0, 1, 0.01],
  "chromaKey.edgeSoftness": [0, 20, 0.5],
  "chromaKey.choke": [-1, 1, 0.01],
  "chromaKey.decontaminate": [0, 1, 0.01],
  "lumaKey.low": [0, 1, 0.01],
  "lumaKey.high": [0, 1, 0.01],
  "lumaKey.softness": [0, 1, 0.01],
  "rectMask.centerX": [0, 1, 0.01],
  "rectMask.centerY": [0, 1, 0.01],
  "rectMask.width": [0, 2, 0.01],
  "rectMask.height": [0, 2, 0.01],
  "rectMask.feather": [0, 1, 0.01],
  "rectMask.cornerRadius": [0, 1, 0.01],
  "ellipseMask.centerX": [0, 1, 0.01],
  "ellipseMask.centerY": [0, 1, 0.01],
  "ellipseMask.width": [0, 2, 0.01],
  "ellipseMask.height": [0, 2, 0.01],
  "ellipseMask.feather": [0, 1, 0.01],
  "matteControl.feather": [0, 1, 0.01],
  "polygonMask.feather": [0, 1, 0.01],
  "bezierMask.feather": [0, 1, 0.01],
  "text.fontSize": [1, 400, 1],
  "text.x": [0, 1, 0.01],
  "text.y": [0, 1, 0.01],
  "backdrop.w": [80, 4000, 1],
  "backdrop.h": [60, 4000, 1],
};

/** camelCase param key → "Title Case" label ("edgeSoftness" → "Edge Softness"). */
function prettyLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The graph-editor targets for one node: every keyframeable param (from the node definition) as an
 * `effect`-kind GraphTarget whose `effectId` is the NODE id. The graph editor plots/edits these the
 * same as any effect param; the Flarex bridge maps the resulting `{scope:"effect"}` keyframes back
 * to the `{scope:"flarexNode"}` model on `comp.animations`.
 */
export function flarexNodeGraphTargets(node: FlarexNode): GraphTarget[] {
  const def = getFlarexNodeDefinition(node.type);
  // Label format "<Node> · <Param>" matches the graph editor's effect grouping (it splits on " · "
  // to make the node the tree GROUP and the param the ROW).
  const groupLabel = node.label ? `${def.label} — ${node.label}` : def.label;
  return def.keyframeable.map((key) => {
    const [min, max, step] = FLAREX_PARAM_RANGES[`${node.type}.${key}`] ?? [0, 1, 0.01];
    return {
      kind: "effect" as const,
      effectId: node.id,
      property: key,
      label: `${groupLabel} · ${prettyLabel(key)}`,
      min,
      max,
      step,
    };
  });
}
