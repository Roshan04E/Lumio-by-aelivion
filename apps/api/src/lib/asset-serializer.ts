import type { AssetAiRef, AssetExternalRef, AssetSource, SourceAsset } from "@reelforge/shared";

/** The Prisma `SourceAsset` row shape (subset we read). */
interface SourceAssetRow {
  id: string;
  userId: string;
  fileName: string;
  fileType: string;
  fileUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  status: string;
  createdAt: Date;
  source?: string | null;
  folder?: string | null;
  tags?: unknown;
  originalName?: string | null;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  proxyUrl?: string | null;
  cloudUrl?: string | null;
  fps?: number | null;
  sizeBytes?: number | null;
  projectId?: string | null;
  externalJson?: unknown;
  aiJson?: unknown;
  updatedAt?: Date | null;
}

function normalizeStatus(status: string): SourceAsset["status"] {
  return status === "processing" || status === "ready" || status === "failed" || status === "uploaded"
    ? status
    : "uploaded";
}

const ASSET_SOURCES: AssetSource[] = [
  "local",
  "ai",
  "pexels",
  "pixabay",
  "unsplash",
  "timeline-generated",
  "brand"
];

/** Map a Prisma SourceAsset row to the shared `SourceAsset` API/client shape. */
export function serializeAsset(row: SourceAssetRow): SourceAsset {
  const source = ASSET_SOURCES.includes(row.source as AssetSource) ? (row.source as AssetSource) : undefined;
  return {
    id: row.id,
    userId: row.userId,
    fileName: row.fileName,
    fileType: row.fileType,
    fileUrl: row.fileUrl,
    durationSeconds: row.durationSeconds,
    width: row.width,
    height: row.height,
    status: normalizeStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    source,
    folder: row.folder ?? undefined,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : undefined,
    originalName: row.originalName ?? undefined,
    thumbnailUrl: row.thumbnailUrl ?? undefined,
    previewUrl: row.previewUrl ?? undefined,
    proxyUrl: row.proxyUrl ?? undefined,
    cloudUrl: row.cloudUrl ?? undefined,
    fps: row.fps ?? undefined,
    sizeBytes: row.sizeBytes ?? undefined,
    projectId: row.projectId ?? undefined,
    external: (row.externalJson as AssetExternalRef | null) ?? undefined,
    ai: (row.aiJson as AssetAiRef | null) ?? undefined,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : undefined
  };
}
