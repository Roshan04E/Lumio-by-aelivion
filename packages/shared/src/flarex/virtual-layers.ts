/**
 * Flarex asset-source MediaIn — virtual media layers (FLAREX.md Phase 2, Fusion Loader model).
 *
 * A MediaIn node with a `sourceAssetId` loads a media-pool asset INTO the comp, decoded independently
 * of the timeline (so the comp is self-contained — nothing is borrowed from / removed from the
 * timeline). The compositor only knows how to decode timeline layers, so each such MediaIn is backed
 * by a synthetic, off-timeline `TimelineLayer` ("virtual loader") that every renderer runs through its
 * normal per-layer media pipeline (decode + grade → graded canvas). The renderers pass these in a
 * SEPARATE list from the real timeline layers (they never composite on their own — they only feed
 * MediaIn via the compiler's `resolveSourceDraw`).
 *
 * Time model: comp-local sync. The virtual layer mirrors the host clip's `startSeconds`/
 * `durationSeconds`, so the source plays with the comp, starting at `sourceInSeconds` (Trim In). The
 * `freeze` (Hold) knob is applied by the renderer when it computes the layer's currentTime (it has the
 * node in hand), not here — this module only assembles the decode-shaped layers.
 */

import type { TimelineLayer } from "../types";
import type { FlarexComp } from "./types";

const VIRTUAL_PREFIX = "flarexsrc:";

/** Stable id for the virtual loader backing one comp's MediaIn node. */
export function flarexVirtualLayerId(compId: string, nodeId: string): string {
  return `${VIRTUAL_PREFIX}${compId}:${nodeId}`;
}

export function isFlarexVirtualLayerId(id: string): boolean {
  return id.startsWith(VIRTUAL_PREFIX);
}

/** Minimal asset facts a virtual loader needs (resolved by the caller from its asset list). */
export interface FlarexSourceAssetInfo {
  type: "video" | "image";
  durationSeconds?: number | undefined;
}

/**
 * Build the virtual media layers for every asset-source MediaIn across a project's Flarex comps.
 * `layers` is the flat list of the composition's timeline layers (the HOSTS — a comp is attached to a
 * layer via `flarexCompId`); `lookupAsset` resolves an asset id to its media kind. A MediaIn whose
 * asset can't be resolved is skipped (its MediaIn soft-degrades to the host clip at compile time).
 */
export function collectFlarexVirtualLayers(
  layers: readonly TimelineLayer[],
  flarexComps: Record<string, FlarexComp> | undefined,
  lookupAsset: (assetId: string) => FlarexSourceAssetInfo | null,
): TimelineLayer[] {
  if (!flarexComps) return [];
  const out: TimelineLayer[] = [];
  for (const host of layers) {
    if (!host.flarexCompId) continue;
    const comp = flarexComps[host.flarexCompId];
    if (!comp) continue;
    for (const node of Object.values(comp.nodes)) {
      if (node.type !== "mediaIn") continue;
      const assetId = typeof node.params.sourceAssetId === "string" ? node.params.sourceAssetId : "";
      if (!assetId) continue; // empty = the host clip, not a virtual loader
      const asset = lookupAsset(assetId);
      if (!asset) continue;
      const sourceInSeconds = typeof node.params.sourceInSeconds === "number" ? node.params.sourceInSeconds : 0;
      const freeze = node.params.freeze === true;
      // How long this loader is ACTIVE (comp-local). A video source that's shorter than the host clip
      // ENDS at its own duration — past that the MediaIn produces nothing (self-contained-clip
      // semantics), so downstream merges drop it and only the background remains (NOT a held last
      // frame). `freeze` (Hold a still), images (no timeline), and unknown-duration sources have no
      // natural end, so they mirror the host span and stay active for the whole comp.
      const sourceRemain =
        asset.type === "video" && !freeze && asset.durationSeconds != null && Number.isFinite(asset.durationSeconds)
          ? Math.max(0, asset.durationSeconds - sourceInSeconds)
          : Infinity;
      const activeSeconds = Math.min(host.durationSeconds, sourceRemain);
      out.push({
        id: flarexVirtualLayerId(comp.id, node.id),
        trackId: "__flarex_virtual",
        type: asset.type,
        name: `${node.label ?? "MediaIn"} source`,
        // Mirror the host START so comp-local time (t − hostStart) drives the source in sync with the
        // comp; the DURATION is clamped to the source's own remaining length so the loader ends when
        // its media runs out (the compiler gates on this via `resolveSourceDraw`).
        startSeconds: host.startSeconds,
        durationSeconds: activeSeconds,
        assetId,
        sourceInSeconds,
        fit: "fill",
        transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
        effects: [],
        keyframes: [],
      });
    }
  }
  return out;
}
