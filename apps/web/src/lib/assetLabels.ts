import type { SourceAsset, TimelineLayer } from "@orreris/shared";

// Premiere-style color labels. Asset labels persist as a "label:<color>" tag on the asset (API
// store and local fallback alike, no schema change); clip labels live on `TimelineLayer.label`
// (cosmetic, per-clip override — a clip without one inherits its source asset's label).
export const ASSET_LABEL_COLORS: Record<string, string> = {
  violet: "#8b7ce8",
  blue: "#4da3ff",
  teal: "#3ec6bb",
  green: "#5cb96b",
  yellow: "#e3c14f",
  orange: "#e8924d",
  red: "#e85d5d",
  pink: "#e070c0"
};

/** Explicit user-set label only (null when the asset just wears its type default). */
export function assetLabelOf(asset: SourceAsset): string | null {
  const tag = asset.tags?.find((entry) => entry.startsWith("label:"));
  const name = tag?.slice("label:".length) ?? "";
  return ASSET_LABEL_COLORS[name] ? name : null;
}

/**
 * Premiere-style TYPE DEFAULTS: every asset has a label color out of the box (video/audio/stills/
 * graphics each get their own), so the bin and the timeline are color-scannable before the user
 * labels anything. An explicit label always overrides.
 *
 * UNREFERENCED as of 2026-08-09 (founder decision: an unlabelled clip/asset has no colour identity
 * — see layerLabelOf below). Its only callers were effectiveAssetLabelOf (also now unreferenced) and
 * two `--asset-label` style computations in EditorPage.tsx, both switched to assetLabelOf. Left in
 * place rather than deleted in the same commit as the behaviour change, per instruction.
 */
export function defaultAssetLabelOf(asset: SourceAsset): string {
  if (asset.fileType.startsWith("image/")) return asset.fileType.includes("svg") ? "orange" : "violet";
  if (asset.fileType.startsWith("audio/")) return "green";
  return "blue";
}

/** UNREFERENCED as of 2026-08-09 — see defaultAssetLabelOf above. Its only caller was layerLabelOf. */
export function effectiveAssetLabelOf(asset: SourceAsset): string {
  return assetLabelOf(asset) ?? defaultAssetLabelOf(asset);
}

export function tagsWithAssetLabel(tags: string[] | undefined, label: string | null): string[] {
  const rest = (tags ?? []).filter((entry) => !entry.startsWith("label:"));
  return label ? [...rest, `label:${label}`] : rest;
}

/**
 * Type defaults for ASSET-LESS layers (text/shape/adjustment), so they join the color language.
 *
 * UNREFERENCED as of 2026-08-09 — see defaultAssetLabelOf above. Its only caller was layerLabelOf.
 */
export function defaultLayerLabelOf(layer: TimelineLayer): string | null {
  switch (layer.type) {
    case "text":
      return "pink";
    case "shape":
      return "orange";
    case "adjustment":
      return "yellow";
    default:
      return null;
  }
}

/**
 * Effective label for a timeline clip: per-clip override → the source asset's EXPLICIT label. No
 * default of any kind — an unlabelled clip has no colour identity until the user assigns one (founder
 * decision, 2026-08-09). Was per-clip override → asset (explicit → type default) → layer-type
 * default; the two default tiers are gone (defaultAssetLabelOf via effectiveAssetLabelOf, and
 * defaultLayerLabelOf) — see assetLabels.ts's other exports for why they're kept, unreferenced,
 * rather than deleted here.
 */
export function layerLabelOf(layer: TimelineLayer, assets: SourceAsset[]): string | null {
  if (layer.label && ASSET_LABEL_COLORS[layer.label]) return layer.label;
  if (layer.assetId) {
    const asset = assets.find((entry) => entry.id === layer.assetId);
    if (asset) return assetLabelOf(asset);
  }
  return null;
}
