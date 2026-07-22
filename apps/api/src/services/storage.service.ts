import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  getPublicUrl,
  getStoragePaths,
  isR2StorageEnabled,
  persistBytes
} from "@orreris/storage";
import { env } from "../config/env";

/**
 * App-level storage helpers for the API. The driver-abstracted primitives (local disk / Cloudflare
 * R2) live in the shared `@orreris/storage` package so the render worker consumes the SAME logic —
 * there is no second copy of the URL/driver code to drift out of sync.
 *
 * `import "../config/env"` above runs dotenv as a side-effect before the eager `storagePaths` /
 * `isR2Storage` reads below, so the package's lazy config sees a populated `process.env` in the API
 * process.
 */

// Re-export the shared primitives so existing API import sites (`app.ts`, `assets.routes.ts`,
// `stock.routes.ts`, `scripts/r2-smoke.ts`, `server.ts`, `generationRouter.service.ts`, …) keep
// importing them from this module unchanged.
export { persistBytes, getPublicUrl, ensureStorage, getObjectStream, deleteAsset, createPresignedUpload } from "@orreris/storage";

/** On-disk folders (local driver). Computed once here, after `../config/env` has loaded dotenv. */
export const storagePaths = getStoragePaths();

/** True when the r2 driver is active. Kept as a boolean const for existing callers. */
export const isR2Storage = isR2StorageEnabled();

export async function saveUpload(file: Express.Multer.File | undefined, fallbackName: string, userId?: string, projectId?: string | null) {
  const safeName = sanitizeFileName(file?.originalname ?? fallbackName);
  const key = uploadKeyFor(safeName, userId, projectId);
  const bytes = file?.buffer ?? Buffer.from("Mock upload placeholder for Orreris.\n");
  const contentType = file?.mimetype || contentTypeFor(safeName);
  return persistBytes(key, bytes, contentType);
}

/** Save raw bytes (e.g. a downloaded stock file) into uploads and return its public URL. */
export async function saveBuffer(buffer: Buffer, fileName: string, userId?: string, projectId?: string | null) {
  const safeName = sanitizeFileName(fileName);
  return persistBytes(uploadKeyFor(safeName, userId, projectId), buffer, contentTypeFor(safeName));
}

/**
 * Storage key for an uploaded object — the cloud media taxonomy (plans/media-cloud-architecture.md):
 *
 *   u_<userId>/video/projects/<projectId>/assets/<ts>-<rand>-<name>   (project-owned uploads)
 *   u_<userId>/video/library/<ts>-<rand>-<name>                       (user-level reusable: brand/AI/stock)
 *
 * `video` is the product namespace (photo editing / cloud VFS become siblings later, never a
 * migration). Keys are IMMUTABLE — the user-visible folder tree is metadata (asset.folder + the
 * project media manifest), never encoded here, so folder renames are free. Per-tenant prefixes are
 * the standard multi-tenant object-store layout; ownership is still enforced by the DB
 * (SourceAsset.userId) + the API — the prefix is defense-in-depth, not the only gate. Without a
 * userId (e.g. the smoke-test script) it falls back to the legacy flat `uploads/` prefix. Old
 * `uploads/u_<id>/…` keys remain valid forever (keys are opaque; URLs round-trip by string).
 */
function uploadKeyFor(safeName: string, userId?: string, projectId?: string | null) {
  const rand = randomUUID().slice(0, 8);
  const stamp = `${Date.now()}-${rand}-${safeName}`;
  if (!userId) return `uploads/${stamp}`;
  const base = `u_${sanitizeFileName(userId)}/video`;
  return projectId ? `${base}/projects/${sanitizeFileName(projectId)}/assets/${stamp}` : `${base}/library/${stamp}`;
}

/** Build the storage-relative key an uploaded file will live at (same scheme as saveUpload). */
export function buildUploadKey(fileName: string, userId?: string, projectId?: string | null) {
  return uploadKeyFor(sanitizeFileName(fileName), userId, projectId);
}

export async function saveDerivedAsset(sourceAssetId: string, type: string, data: unknown) {
  const fileName = `${sourceAssetId}-${type.toLowerCase()}-${Date.now()}.json`;
  return persistBytes(`derived/${fileName}`, Buffer.from(JSON.stringify(data, null, 2)), "application/json");
}

export function resolvePublicStoragePath(publicUrl: string) {
  if (isR2Storage) {
    // Server-side transcription reads a local file path; cloud-stored media would need a temp
    // download first. Browser transcription (the default) is unaffected.
    throw new Error("Server transcription of cloud-stored media isn't supported yet — use browser transcription.");
  }
  if (!publicUrl.startsWith(`${env.API_PUBLIC_URL}/storage/`)) {
    throw new Error("Only API-managed uploaded media can be used for server transcription.");
  }
  const relative = publicUrl.replace(`${env.API_PUBLIC_URL}/storage/`, "");
  return path.join(storagePaths.root, relative);
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}

function contentTypeFor(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".json": "application/json"
  };
  return map[ext] ?? "application/octet-stream";
}
