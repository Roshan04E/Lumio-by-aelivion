import type { PreviewQuality } from "../state/editorStore";

/**
 * Preview quality profiles (Phase 3 interface; wired into `VideoPreview` in
 * Phase 5). Lower quality trades fidelity for a faster, lighter preview — the
 * core lever for staying responsive in the browser on big compositions.
 */
export interface PreviewQualityProfile {
  /** Resolution scale applied to the preview surface (1 = full). */
  resolutionScale: number;
  /** Skip expensive effects (heavy blur/grain) below this fidelity. */
  effectFidelity: "low" | "medium" | "high";
  /** Target frame budget in ms (drives debounce / frame skipping). */
  frameBudgetMs: number;
  /** Prefer proxy media when available. */
  useProxy: boolean;
}

export const previewQualityProfiles: Record<PreviewQuality, PreviewQualityProfile> = {
  performance: { resolutionScale: 0.5, effectFidelity: "low", frameBudgetMs: 33, useProxy: true },
  balanced: { resolutionScale: 0.75, effectFidelity: "medium", frameBudgetMs: 24, useProxy: true },
  quality: { resolutionScale: 1, effectFidelity: "high", frameBudgetMs: 16, useProxy: false }
};

export function getPreviewQualityProfile(quality: PreviewQuality): PreviewQualityProfile {
  return previewQualityProfiles[quality];
}
