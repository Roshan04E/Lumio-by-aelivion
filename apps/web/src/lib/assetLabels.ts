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

/** Explicit user-set label only (null when the asset has none). */
export function assetLabelOf(asset: SourceAsset): string | null {
  const tag = asset.tags?.find((entry) => entry.startsWith("label:"));
  const name = tag?.slice("label:".length) ?? "";
  return ASSET_LABEL_COLORS[name] ? name : null;
}

export function tagsWithAssetLabel(tags: string[] | undefined, label: string | null): string[] {
  const rest = (tags ?? []).filter((entry) => !entry.startsWith("label:"));
  return label ? [...rest, `label:${label}`] : rest;
}

/**
 * Effective label for a timeline clip: per-clip override → the source asset's EXPLICIT label. No
 * default of any kind — an unlabelled clip has no colour identity until the user assigns one (founder
 * decision, 2026-08-09).
 */
export function layerLabelOf(layer: TimelineLayer, assets: SourceAsset[]): string | null {
  if (layer.label && ASSET_LABEL_COLORS[layer.label]) return layer.label;
  if (layer.assetId) {
    const asset = assets.find((entry) => entry.id === layer.assetId);
    if (asset) return assetLabelOf(asset);
  }
  return null;
}
