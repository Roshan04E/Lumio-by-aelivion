/**
 * Orreris OS observer — media metadata (L0, free). Reads the SourceAsset record the ingest
 * pipeline already produced: duration, dimensions, fps, size, container rotation. Costs
 * nothing because the work was done at import — the fidelity-ladder's ground floor.
 */

import type { ObservedFact, WorldContext, WorldObserver, WorldTarget } from "../types";
import { fnv1a } from "../types";

export interface MediaMetadataFact {
  fileName: string;
  fileType: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps?: number | undefined;
  sizeBytes?: number | undefined;
  rotationDegrees?: number | undefined;
}

export const MEDIA_METADATA_FACT = "media.metadata";

function assetFor(target: WorldTarget, ctx: WorldContext) {
  if (target.kind !== "asset") {
    return undefined;
  }
  return ctx.assets.find((asset) => asset.id === target.id);
}

export const metadataObserver: WorldObserver = {
  id: "metadata@builtin",
  version: 1,
  factTypes: [MEDIA_METADATA_FACT],
  fidelity: 0,
  estCostMs: 1,
  estConfidence: 0.98,
  signature(target, ctx) {
    const asset = assetFor(target, ctx);
    if (!asset) {
      return null;
    }
    return fnv1a(
      [asset.id, asset.fileType, asset.durationSeconds, asset.width, asset.height, asset.fps ?? "", asset.sizeBytes ?? "", asset.updatedAt ?? ""].join("|")
    );
  },
  async observe(target, ctx) {
    const asset = assetFor(target, ctx);
    if (!asset) {
      return [];
    }
    const value: MediaMetadataFact = {
      fileName: asset.originalName ?? asset.fileName,
      fileType: asset.fileType,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height,
      fps: asset.fps,
      sizeBytes: asset.sizeBytes,
      rotationDegrees: asset.rotationDegrees
    };
    const fact: ObservedFact<MediaMetadataFact> = { type: MEDIA_METADATA_FACT, value, confidence: 0.98 };
    return [fact];
  }
};
