import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object storage — driver-abstracted, shared by @orreris/api and @orreris/worker.
 *
 *   STORAGE_DRIVER=local  → on-disk (dev default). API and worker share one filesystem.
 *   STORAGE_DRIVER=r2     → Cloudflare R2. R2 speaks the S3 API, so we use @aws-sdk/client-s3
 *                           pointed at the R2 endpoint (region "auto", path-style) — Cloudflare's
 *                           recommended integration. Reads are served from R2_PUBLIC_BASE_URL when
 *                           set, otherwise proxied through the API (works with a private bucket).
 *
 * `getPublicUrl` keeps the SAME `/storage/<rel>` shape for both drivers (unless a public base is
 * configured), so stored `fileUrl`s are driver-agnostic — nothing else in the app has to change.
 * Media remains LOCAL-FIRST in the browser regardless; this only backs the opt-in cloud upload and
 * cloud (Remotion) render output.
 *
 * Config is read from `process.env` LAZILY (first use, cached) — never at module load. The worker
 * calls `dotenv.config()` in its module BODY, which runs AFTER imported modules evaluate; an eager
 * module-load read here would see the env before dotenv populated it. Defaults mirror
 * `.env.example` / the API's zod env schema (the single documented source).
 */

// ---------------------------------------------------------------------------
// Config (lazy, cached — see module doc)
// ---------------------------------------------------------------------------

interface StorageConfig {
  driver: "local" | "r2";
  /** Absolute path to the on-disk storage root (local driver only). */
  storageRoot: string;
  apiPublicUrl: string;
  r2Endpoint: string | undefined;
  r2Bucket: string | undefined;
  r2AccessKeyId: string | undefined;
  r2SecretAccessKey: string | undefined;
  r2PublicBaseUrl: string | undefined;
}

let cachedConfig: StorageConfig | null = null;

/** Treat a blank env value (`FOO=`) as unset — mirrors the API env schema's `emptyAsUndefined`. */
function emptyAsUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

export function resolveStorageConfig(): StorageConfig {
  if (cachedConfig) {
    return cachedConfig;
  }
  const driver = process.env.STORAGE_DRIVER === "r2" ? "r2" : "local";
  const storageRootRaw = process.env.STORAGE_ROOT ?? "apps/api/storage";
  // Both apps run their scripts with cwd = their own package dir (`apps/api`, `apps/worker`), so
  // `../..` resolves to the workspace root in either process. The on-disk path only matters for the
  // local driver on a single machine; the r2 driver makes it irrelevant (cross-container correct).
  const workspaceRoot = path.resolve(process.cwd(), "../..");
  const storageRoot = path.isAbsolute(storageRootRaw) ? storageRootRaw : path.resolve(workspaceRoot, storageRootRaw);
  cachedConfig = {
    driver,
    storageRoot,
    apiPublicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:4100",
    r2Endpoint: emptyAsUndefined(process.env.R2_ENDPOINT),
    r2Bucket: emptyAsUndefined(process.env.R2_BUCKET),
    r2AccessKeyId: emptyAsUndefined(process.env.R2_ACCESS_KEY_ID),
    r2SecretAccessKey: emptyAsUndefined(process.env.R2_SECRET_ACCESS_KEY),
    r2PublicBaseUrl: emptyAsUndefined(process.env.R2_PUBLIC_BASE_URL)
  };
  return cachedConfig;
}

/** Storage-relative folders under the on-disk root (local driver). */
export function getStoragePaths() {
  const { storageRoot } = resolveStorageConfig();
  return {
    root: storageRoot,
    uploads: path.join(storageRoot, "uploads"),
    previews: path.join(storageRoot, "previews"),
    finals: path.join(storageRoot, "finals"),
    derived: path.join(storageRoot, "derived")
  };
}

export function isR2StorageEnabled(): boolean {
  return resolveStorageConfig().driver === "r2";
}

// ---------------------------------------------------------------------------
// R2 client (S3-compatible; lazy — only constructed when the r2 driver is used)
// ---------------------------------------------------------------------------

let r2Client: S3Client | null = null;

function r2(): { client: S3Client; bucket: string } {
  const cfg = resolveStorageConfig();
  if (!cfg.r2Endpoint || !cfg.r2Bucket || !cfg.r2AccessKeyId || !cfg.r2SecretAccessKey) {
    throw new Error(
      "STORAGE_DRIVER=r2 but R2 credentials are incomplete. Set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
    );
  }
  if (!r2Client) {
    r2Client = new S3Client({
      region: "auto", // R2 is region-agnostic
      endpoint: cfg.r2Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.r2AccessKeyId,
        secretAccessKey: cfg.r2SecretAccessKey
      }
    });
  }
  return { client: r2Client, bucket: cfg.r2Bucket };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Ensure the on-disk folders exist (no-op for r2 — buckets need no local dirs). */
export async function ensureStorage() {
  if (isR2StorageEnabled()) {
    return;
  }
  await Promise.all(Object.values(getStoragePaths()).map((folder) => fs.mkdir(folder, { recursive: true })));
}

/** Public URL for a stored object, keyed by its storage-relative path (e.g. `uploads/123-clip.mp4`). */
export function getPublicUrl(relativePath: string) {
  const cfg = resolveStorageConfig();
  const rel = relativePath.replace(/^\/+/, "");
  if (cfg.driver === "r2" && cfg.r2PublicBaseUrl) {
    return `${cfg.r2PublicBaseUrl.replace(/\/+$/, "")}/${rel}`;
  }
  return `${cfg.apiPublicUrl}/storage/${rel}`;
}

/** Turn a stored public URL back into its storage-relative key (handles both driver URL shapes). */
export function relativeKeyFromUrl(publicUrl: string): string | null {
  const cfg = resolveStorageConfig();
  const proxyPrefix = `${cfg.apiPublicUrl}/storage/`;
  if (publicUrl.startsWith(proxyPrefix)) {
    return publicUrl.slice(proxyPrefix.length);
  }
  if (cfg.r2PublicBaseUrl) {
    const base = `${cfg.r2PublicBaseUrl.replace(/\/+$/, "")}/`;
    if (publicUrl.startsWith(base)) {
      return publicUrl.slice(base.length);
    }
  }
  return null;
}

/** Persist bytes at a storage-relative key and return its public URL. */
export async function persistBytes(relativeKey: string, bytes: Buffer, contentType: string) {
  const cfg = resolveStorageConfig();
  if (cfg.driver === "r2") {
    const { client, bucket } = r2();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: relativeKey, Body: bytes, ContentType: contentType }));
    return getPublicUrl(relativeKey);
  }
  await ensureStorage();
  const target = path.join(cfg.storageRoot, relativeKey);
  // Per-user keys (uploads/u_<id>/…) nest one level deeper than the folders ensureStorage creates.
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return getPublicUrl(relativeKey);
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
  if (!isR2StorageEnabled()) {
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

/**
 * Mint a presigned GET URL for a stored object so a consumer can read it DIRECTLY from R2 —
 * bypassing the API's `/storage` proxy. Used by the render worker: fetching source clips through the
 * proxy (Remotion → API → R2) is a double hop, and OffthreadVideo seeks per-frame via Range, so every
 * grab pays that hop twice and a large clip starves the compositor (frame delayRender never clears).
 * A presigned URL goes worker → R2 directly with native Range support, and works for a PRIVATE bucket
 * (no public base URL needed). `expiresIn` must outlast the whole render (default 2h). r2 driver only.
 */
export async function createPresignedDownload(relativeKey: string, expiresIn = 7200): Promise<string> {
  const { client, bucket } = r2();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: relativeKey }), { expiresIn });
}

export async function deleteAsset(publicUrl: string) {
  const cfg = resolveStorageConfig();
  const key = relativeKeyFromUrl(publicUrl);
  if (!key) {
    return; // not an API-managed object (e.g. a remote/AI URL) — nothing to delete
  }
  if (cfg.driver === "r2") {
    const { client, bucket } = r2();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return;
  }
  await fs.rm(path.join(cfg.storageRoot, key), { force: true });
}

/**
 * Fetch an object's stream + metadata (used by the API proxy when serving r2-backed reads).
 *
 * `range` forwards an HTTP `Range` header (e.g. `bytes=0-1023`) to R2, which honors it natively.
 * This is REQUIRED for video: Remotion's OffthreadVideo (export) and the editor's media scrubber
 * seek frames via Range requests, and a proxy that always returns the full object makes every seek
 * re-download the whole file — the render then blows past Remotion's delayRender timeout. When a
 * range is served, `contentRange` is set (the caller should reply 206 Partial Content) and
 * `contentLength` is the length of the returned slice, not the whole object.
 */
export async function getObjectStream(
  relativeKey: string,
  range?: string
): Promise<{ body: Readable; contentType?: string; contentLength?: number; contentRange?: string }> {
  const { client, bucket } = r2();
  const out = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: relativeKey, ...(range ? { Range: range } : {}) })
  );
  return {
    body: out.Body as Readable,
    ...(out.ContentType ? { contentType: out.ContentType } : {}),
    ...(typeof out.ContentLength === "number" ? { contentLength: out.ContentLength } : {}),
    ...(out.ContentRange ? { contentRange: out.ContentRange } : {})
  };
}
