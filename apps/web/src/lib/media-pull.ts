/**
 * Per-project media pull engine (plans/media-cloud-architecture.md M2) — the DOWNLOAD half of
 * "one asset, two locations". On project open (and on "Refresh from cloud") we diff the project's
 * referenced assets against on-device bytes and pull ONLY what's missing:
 *
 *   1. bytes already in the local store → do nothing (founder rule: no pointless pull),
 *   2. missing locally but a cloud/provider URL exists → background-fetch into OPFS under the SAME
 *      asset id, scoped to the cloud taxonomy (project-owned vs library),
 *   3. no URL → left alone (the bin's relink flow owns that case).
 *
 * Upload stays explicit-only elsewhere (local-first decree, 2026-07-13) — this module never ships
 * bytes anywhere; it only fills the local cache. Pulled bytes are picked up by the listAssets
 * resolution overlay (api.ts), so playback switches from network streaming to on-device reads.
 */

import type { ProjectGraph, SourceAsset, TimelineComposition } from "@orreris/shared";
import { getAssetBlobStore, type AssetScope } from "./asset-blob-store";
import { LOCAL_BLOB_PREFIX } from "./api";

export interface MediaPullReport {
  checked: number;
  pulled: string[];
  failed: { assetId: string; reason: string }[];
  skippedLocal: number;
  /** Referenced ids with no local bytes AND no pullable URL (need relink / dead source). */
  unresolvable: string[];
}

/** Every asset id referenced by the project's timelines (root + nested compositions). */
export function collectGraphAssetIds(graph: ProjectGraph): Set<string> {
  const ids = new Set<string>();
  const walk = (composition: TimelineComposition | undefined) => {
    if (!composition) return;
    for (const track of composition.tracks) {
      for (const layer of track.layers) {
        if (layer.assetId) ids.add(layer.assetId);
      }
    }
  };
  walk(graph.composition);
  for (const composition of Object.values(graph.compositions ?? {})) walk(composition);
  if (graph.sourceAssetId) ids.add(graph.sourceAssetId);
  return ids;
}

/** A URL we can actually re-fetch bytes from (never a session object URL or a local marker). */
function pullableUrl(asset: SourceAsset): string | null {
  const candidates = [asset.cloudUrl, asset.fileUrl];
  for (const url of candidates) {
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function scopeFor(asset: SourceAsset, userId: string | undefined): AssetScope {
  return { userId, projectId: asset.ownerProjectId ?? null };
}

async function fetchIntoStore(asset: SourceAsset, url: string, userId: string | undefined): Promise<void> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("empty response");
  // Corruption guard: when the record knows its true size, a mismatched download is worse than
  // none (it would silently replace good bytes on refresh) — reject it.
  if (typeof asset.sizeBytes === "number" && asset.sizeBytes > 0 && Math.abs(blob.size - asset.sizeBytes) > 0) {
    throw new Error(`size mismatch (got ${blob.size}, expected ${asset.sizeBytes})`);
  }
  const store = await getAssetBlobStore();
  await store.put(asset.id, blob, scopeFor(asset, userId));
}

/**
 * Ensure every asset the project references has on-device bytes, pulling missing ones from their
 * cloud/provider URLs. Concurrency-limited; abortable; never throws (per-asset failures are
 * reported, not fatal). `assets` is the already-loaded record list (the diff needs metadata only).
 */
export async function ensureProjectMediaLocal(
  graph: ProjectGraph,
  assets: SourceAsset[],
  options: { userId?: string | undefined; signal?: AbortSignal | undefined; onPulled?: ((assetId: string) => void) | undefined } = {}
): Promise<MediaPullReport> {
  const report: MediaPullReport = { checked: 0, pulled: [], failed: [], skippedLocal: 0, unresolvable: [] };
  const referenced = collectGraphAssetIds(graph);
  if (referenced.size === 0) return report;
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const store = await getAssetBlobStore();

  const queue: { asset: SourceAsset; url: string }[] = [];
  for (const id of referenced) {
    const asset = byId.get(id);
    if (!asset) continue; // unknown record — resolution/relink surfaces own that
    report.checked += 1;
    if (await store.has(id)) {
      report.skippedLocal += 1;
      continue;
    }
    // A local-marker asset whose bytes are gone AND has no cloud copy can't be pulled.
    const url = pullableUrl(asset);
    if (!url || url.startsWith(LOCAL_BLOB_PREFIX)) {
      report.unresolvable.push(id);
      continue;
    }
    queue.push({ asset, url });
  }

  const CONCURRENCY = 2;
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      if (options.signal?.aborted) return;
      const job = queue[next]!;
      next += 1;
      try {
        await fetchIntoStore(job.asset, job.url, options.userId);
        report.pulled.push(job.asset.id);
        options.onPulled?.(job.asset.id);
      } catch (error) {
        report.failed.push({ assetId: job.asset.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return report;
}

/**
 * "Refresh from cloud" (corruption repair): re-download an asset's bytes from its cloud/provider
 * URL and overwrite the on-device copy under the SAME id (open leases re-prime via the store's
 * object-URL invalidation). Throws with a user-presentable message on failure — the caller shows
 * it and the existing local bytes stay untouched (fetch-verify-then-write, never write-then-check).
 */
export async function refreshAssetFromCloud(asset: SourceAsset, userId?: string): Promise<void> {
  const url = pullableUrl(asset);
  if (!url) throw new Error("No cloud copy recorded for this asset");
  await fetchIntoStore(asset, url, userId);
}
