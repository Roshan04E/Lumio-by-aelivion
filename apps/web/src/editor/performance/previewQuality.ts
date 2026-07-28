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
}

// Premiere-style playback resolution: Quarter / Half / Full. `resolutionScale` downscales the scene
// render surface DURING PLAYBACK (the backing renders at comp*scale, CSS upscales to display size), the
// real GPU cost lever — applied by `VideoPreview` → `ScenePreviewCanvas`. Paused renders at Full (scale 1).
//
// RESOLUTION ONLY (2026-07-28). A `useProxy` field used to live here, false on `quality` — encoding the
// idea that picking Full also means "play the originals". It was never read by anything; the actual
// substitution went through `setIngestProxyPlaybackEnabled`. Removed rather than left as documentation
// of a coupling that no longer exists: media source is now its own control, because resolution and
// substitution answer different questions and every pro NLE keeps them on separate axes. A field that
// describes a policy nobody consults is a future reader's false lead.
export const previewQualityProfiles: Record<PreviewQuality, PreviewQualityProfile> = {
  performance: { resolutionScale: 0.25, effectFidelity: "low", frameBudgetMs: 33 }, // Quarter
  balanced: { resolutionScale: 0.5, effectFidelity: "medium", frameBudgetMs: 24 }, // Half
  quality: { resolutionScale: 1, effectFidelity: "high", frameBudgetMs: 16 } // Full
};

export function getPreviewQualityProfile(quality: PreviewQuality): PreviewQualityProfile {
  return previewQualityProfiles[quality];
}
