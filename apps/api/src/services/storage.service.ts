import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

/**
 * Object storage — driver-abstracted.
 *
 *   STORAGE_DRIVER=local  → on-disk (dev default). Behaviour is unchanged from before.
 *   STORAGE_DRIVER=r2     → Cloudflare R2. R2 speaks the S3 API, so we use @aws-sdk/client-s3
 *                           pointed at the R2 endpoint (region "auto", path-style) — Cloudflare's
 *                           recommended integration. Reads are served from R2_PUBLIC_BASE_URL when
 *                           set, otherwise proxied through the API (works with a private bucket).
 *
 * `getPublicUrl` keeps the SAME `/storage/<rel>` shape for both drivers (unless a public base is
 * configured), so stored `fileUrl`s are driver-agnostic — nothing else in the app has to change.
 * Media remains LOCAL-FIRST in the browser regardless; this only backs the opt-in cloud upload.
 */

const workspaceRoot = path.resolve(process.cwd(), "../..");
const storageRoot = path.isAbsolute(env.STORAGE_ROOT)
  ? env.STORAGE_ROOT
  : path.resolve(workspaceRoot, env.STORAGE_ROOT);

export const storagePaths = {
  root: storageRoot,
  uploads: path.join(storageRoot, "uploads"),
  previews: path.join(storageRoot, "previews"),
  finals: path.join(storageRoot, "finals"),
  derived: path.join(storageRoot, "derived")
};

export const isR2Storage = env.STORAGE_DRIVER === "r2";

// ---------------------------------------------------------------------------
// R2 client (S3-compatible; lazy — only constructed when the r2 driver is used)
// ---------------------------------------------------------------------------

let r2Client: S3Client | null = null;

function r2(): { client: S3Client; bucket: string } {
  if (!env.R2_ENDPOINT || !env.R2_BUCKET || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "STORAGE_DRIVER=r2 but R2 credentials are incomplete. Set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
    );
  }
  if (!r2Client) {
    r2Client = new S3Client({
      region: "auto", // R2 is region-agnostic
      endpoint: env.R2_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY
      }
    });
  }
  return { client: r2Client, bucket: env.R2_BUCKET };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export async function ensureStorage() {
  if (isR2Storage) return; // buckets need no local dirs
  await Promise.all(Object.values(storagePaths).map((folder) => fs.mkdir(folder, { recursive: true })));
}

/** Public URL for a stored object, keyed by its storage-relative path (e.g. `uploads/123-clip.mp4`). */
export function getPublicUrl(relativePath: string) {
  const rel = relativePath.replace(/^\/+/, "");
  if (isR2Storage && env.R2_PUBLIC_BASE_URL) {
    return `${env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${rel}`;
  }
  return `${env.API_PUBLIC_URL}/storage/${rel}`;
}

/** Turn a stored public URL back into its storage-relative key (handles both driver URL shapes). */
function relativeKeyFromUrl(publicUrl: string): string | null {
  const proxyPrefix = `${env.API_PUBLIC_URL}/storage/`;
  if (publicUrl.startsWith(proxyPrefix)) return publicUrl.slice(proxyPrefix.length);
  if (env.R2_PUBLIC_BASE_URL) {
    const base = `${env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "")}/`;
    if (publicUrl.startsWith(base)) return publicUrl.slice(base.length);
  }
  return null;
}

/** Persist bytes at a storage-relative key and return its public URL. */
async function persistBytes(relativeKey: string, bytes: Buffer, contentType: string) {
  if (isR2Storage) {
    const { client, bucket } = r2();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: relativeKey, Body: bytes, ContentType: contentType }));
    return getPublicUrl(relativeKey);
  }
  await ensureStorage();
  const target = path.join(storageRoot, relativeKey);
  // Per-user keys (uploads/u_<id>/…) nest one level deeper than the folders ensureStorage creates.
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return getPublicUrl(relativeKey);
}

// ---------------------------------------------------------------------------
// Public API (identical signatures to before)
// ---------------------------------------------------------------------------

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

/**
 * Mint a presigned PUT URL so the browser can stream bytes DIRECTLY to R2 — bypassing the API
 * (no server RAM buffering, no double bandwidth, R2 egress is free). Only valid for the r2 driver;
 * the local driver has no equivalent, so callers fall back to the multipart upload path.
 *
 * The URL signs the Content-Type, so the client MUST send exactly `contentType` on the PUT or R2
 * rejects the signature. `expiresIn` is generous (15 min) to cover slow large-file uploads.
 */
export async function createPresignedUpload(relativeKey: string, contentType: string) {
  if (!isR2Storage) {
    throw new Error("Presigned uploads require STORAGE_DRIVER=r2.");
  }
  const { client, bucket } = r2();
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: relativeKey, ContentType: contentType }),
    { expiresIn: 900 }
  );
  return { uploadUrl, publicUrl: getPublicUrl(relativeKey), key: relativeKey };
}

export async function saveDerivedAsset(sourceAssetId: string, type: string, data: unknown) {
  const fileName = `${sourceAssetId}-${type.toLowerCase()}-${Date.now()}.json`;
  return persistBytes(`derived/${fileName}`, Buffer.from(JSON.stringify(data, null, 2)), "application/json");
}

export async function savePreview(projectId: string, payload: unknown) {
  const fileName = `${projectId}-preview-${Date.now()}.json`;
  return persistBytes(`previews/${fileName}`, Buffer.from(JSON.stringify(payload, null, 2)), "application/json");
}

export async function saveFinal(projectId: string, payload: unknown) {
  const fileName = `${projectId}-final-${Date.now()}.json`;
  return persistBytes(`finals/${fileName}`, Buffer.from(JSON.stringify(payload, null, 2)), "application/json");
}

export async function deleteAsset(publicUrl: string) {
  const key = relativeKeyFromUrl(publicUrl);
  if (!key) return; // not an API-managed object (e.g. a remote/AI URL) — nothing to delete
  if (isR2Storage) {
    const { client, bucket } = r2();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return;
  }
  await fs.rm(path.join(storageRoot, key), { force: true });
}

/** Fetch an object's stream + metadata (used by the API proxy when serving r2-backed reads). */
export async function getObjectStream(relativeKey: string): Promise<{ body: Readable; contentType?: string; contentLength?: number }> {
  const { client, bucket } = r2();
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: relativeKey }));
  return {
    body: out.Body as Readable,
    ...(out.ContentType ? { contentType: out.ContentType } : {}),
    ...(typeof out.ContentLength === "number" ? { contentLength: out.ContentLength } : {})
  };
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
  return path.join(storageRoot, relative);
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
