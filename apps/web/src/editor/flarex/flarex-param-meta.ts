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
  // ±3600 like the clip Transform panel's Rotate → a drag value (not a ±180 "natural-range" slider),
  // so Rotation reads identically whether it's on a clip or a node.
  "transform.rotation": [-3600, 3600, 1],
  "transform.anchorX": [0, 1, 0.01],
  "transform.anchorY": [0, 1, 0.01],
  // The `brightnessContrast` effect's own scales (saturation 100 = neutral) — the node schema now
  // declares the same bounds, so slider, graph lane, and Zod all agree.
  // Unified Color node — same scales as the atomic nodes it subsumes (a slider must read identically
  // whichever node you reach it through; the lowering passes both through the same effects).
  "color.exposure": [-100, 100, 1],
  "color.contrast": [-100, 100, 1],
  "color.highlights": [-100, 100, 1],
  "color.shadows": [-100, 100, 1],
  "color.whites": [-100, 100, 1],
  "color.blacks": [-100, 100, 1],
  "color.saturation": [0, 220, 1],
  "color.vibrance": [-100, 100, 1],
  "color.temperature": [-100, 100, 1],
  "color.tint": [-100, 100, 1],
  "color.lutIntensity": [0, 1, 0.01],
  "color.lookIntensity": [0, 1, 0.01],
  "color.vignetteAmount": [0, 1, 0.01],
  "color.vignetteSize": [0, 1, 0.01],
  "color.vignetteFeather": [0, 1, 0.01],
  "color.vignetteRoundness": [0, 1, 0.01],
  "color.vignetteHighlights": [0, 1, 0.01],
  "color.grainAmount": [0, 1, 0.01],
  "color.grainSize": [0.25, 4, 0.05],
  "colorCorrect.exposure": [-100, 100, 1],
  "colorCorrect.contrast": [-100, 100, 1],
  "colorCorrect.highlights": [-100, 100, 1],
  "colorCorrect.shadows": [-100, 100, 1],
  "colorCorrect.whites": [-100, 100, 1],
  "colorCorrect.blacks": [-100, 100, 1],
  "colorCorrect.saturation": [0, 220, 1],
  "colorCorrect.vibrance": [-100, 100, 1],
  "colorCorrect.temperature": [-100, 100, 1],
  "colorCorrect.tint": [-100, 100, 1],
  "lut.intensity": [0, 1, 0.01],
  "look.intensity": [0, 1, 0.01],
  "blur.sigma": [0, 200, 1],
  "directionalBlur.amount": [0, 1, 0.01],
  "directionalBlur.angle": [-180, 180, 1],
  "radialBlur.amount": [0, 1, 0.01],
  "radialBlur.centerX": [0, 1, 0.01],
  "radialBlur.centerY": [0, 1, 0.01],
  "pixelate.blockSize": [1, 200, 1],
  "prism.amount": [0, 1, 0.01],
  "prism.angle": [-180, 180, 1],
  "crop.left": [0, 1, 0.005],
  "crop.right": [0, 1, 0.005],
  "crop.top": [0, 1, 0.005],
  "crop.bottom": [0, 1, 0.005],
  "crop.softness": [0, 1, 0.01],
  "vignette.amount": [0, 1, 0.01],
  "vignette.size": [0, 1, 0.01],
  "vignette.feather": [0, 1, 0.01],
  "vignette.roundness": [0, 1, 0.01],
  "vignette.highlights": [0, 1, 0.01],
  "grain.amount": [0, 1, 0.01],
  "grain.size": [0.25, 4, 0.05],
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
  // Expansion shares feather's scale (both are comp fractions the compiler multiplies by the same
  // half-short-edge), so the two sliders mean the same distance at the same number — and it is
  // signed, because choking a roto edge inward is the common direction.
  "polygonMask.expansion": [-1, 1, 0.01],
  "bezierMask.expansion": [-1, 1, 0.01],
  "text.fontSize": [1, 400, 1],
  "text.fontWeight": [100, 900, 100],
  "text.x": [0, 1, 0.01],
  "text.y": [0, 1, 0.01],
  "text.strokeWidth": [0, 40, 0.5],
  "text.shadowBlur": [0, 80, 1],
  "text.shadowOffsetX": [-60, 60, 1],
  "text.shadowOffsetY": [-60, 60, 1],
  "background.opacity": [0, 1, 0.01],
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
