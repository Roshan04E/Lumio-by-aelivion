/**
 * Orreris OS observer — Project State (K2, L0, free). Summarizes the project's media bin from
 * the asset records already in the WorldContext: counts per kind, total footage duration and
 * size, resolution ceiling, source mix (local / stock / generated). The planner's cheap first
 * stop before any per-asset perception. Target: `project:current` (the context's asset list
 * IS the current project bin — the host provider scopes it).
 */

import type { SourceAsset } from "@orreris/shared";
import type { WorldContext, WorldObserver, WorldTarget } from "../types";
import { fnv1a } from "../types";

export const PROJECT_MEDIA_FACT = "project.mediaSummary";
export const PROJECT_TARGET_ID = "current";

export interface ProjectMediaFact {
  assetCount: number;
  videoCount: number;
  imageCount: number;
  audioCount: number;
  otherCount: number;
  totalFootageSeconds: number;
  totalSizeBytes: number;
  /** Largest source dimensions seen — the project's resolution ceiling. */
  maxWidth: number;
  maxHeight: number;
  /** Asset `source` mix, e.g. { local: 4, stock: 2 }. Absent source counts as "local". */
  bySource: Record<string, number>;
}

function kindOf(asset: SourceAsset): "video" | "image" | "audio" | "other" {
  const prefix = asset.fileType.split("/")[0];
  return prefix === "video" || prefix === "image" || prefix === "audio" ? prefix : "other";
}

function applies(target: WorldTarget): boolean {
  return target.kind === "project" && target.id === PROJECT_TARGET_ID;
}

export const projectMediaObserver: WorldObserver = {
  id: "project-media@builtin",
  version: 1,
  factTypes: [PROJECT_MEDIA_FACT],
  fidelity: 0,
  estCostMs: 2,
  estConfidence: 0.95,
  signature(target, ctx: WorldContext) {
    if (!applies(target)) {
      return null;
    }
    const parts = ctx.assets
      .map((asset) => `${asset.id}:${asset.sizeBytes ?? ""}:${asset.updatedAt ?? ""}:${asset.durationSeconds}`)
      .sort();
    return fnv1a(parts.join("|") || "empty");
  },
  async observe(target, ctx) {
    if (!applies(target)) {
      return [];
    }
    const value: ProjectMediaFact = {
      assetCount: ctx.assets.length,
      videoCount: 0,
      imageCount: 0,
      audioCount: 0,
      otherCount: 0,
      totalFootageSeconds: 0,
      totalSizeBytes: 0,
      maxWidth: 0,
      maxHeight: 0,
      bySource: {}
    };
    for (const asset of ctx.assets) {
      const kind = kindOf(asset);
      if (kind === "video") value.videoCount += 1;
      else if (kind === "image") value.imageCount += 1;
      else if (kind === "audio") value.audioCount += 1;
      else value.otherCount += 1;
      if (kind === "video" || kind === "audio") {
        value.totalFootageSeconds += asset.durationSeconds;
      }
      value.totalSizeBytes += asset.sizeBytes ?? 0;
      value.maxWidth = Math.max(value.maxWidth, asset.width);
      value.maxHeight = Math.max(value.maxHeight, asset.height);
      const source = asset.source ?? "local";
      value.bySource[source] = (value.bySource[source] ?? 0) + 1;
    }
    return [{ type: PROJECT_MEDIA_FACT, value, confidence: 0.95 }];
  }
};
