/**
 * Import-time still proxies (PREVIEW_PIPELINE.md P2).
 *
 * A 4K still costs ~64–90MB of GPU memory once decoded — FILE format/quality is irrelevant, only
 * pixel dimensions matter — and an image-heavy timeline of them overwhelms an iGPU (2026-07-03
 * soak: replacing 4K sources with full-HD fixed playback entirely). Premiere's model: the preview
 * edits against a conformed/downscaled proxy; the ORIGINAL renders the export. This store is that,
 * for stills:
 *
 *  - PREVIEW-ONLY: `getStillProxyBlob(src, edge)` returns a downscaled WebP (q≈0.82, alpha
 *    preserved) generated once and persisted in OPFS. The export/cloud paths never see it — they
 *    keep decoding the original at full quality.
 *  - Two size tiers (1920 / 2560 long edge) rather than arbitrary edges, so one image caches at
 *    most two variants; the caller picks the tier from the clip's zoom (a scaled-up clip needs the
 *    bigger tier for crispness).
 *  - `null` means "use the original": image already small enough, OPFS/canvas unavailable, or
 *    generation failed — the caller's original decode path is always the fallback. Failures are
 *    remembered per session so a hostile source doesn't re-attempt every mount.
 *  - EXIF orientation is applied at generation (`createImageBitmap(blob)` default), so consumers
 *    treat the proxy exactly like the original file, including the mandatory `flipY` pre-flip at
 *    texture load. NO flip is baked in here.
 *  - Invalidation: the OPFS key hashes the source URL + tier + STILL_PROXY_VERSION. Downscaling is
 *    render-pipeline-independent, so it does NOT key on the render fingerprint. Bump the version
 *    if the generation logic itself changes (quality, format, resize algorithm).
 */

import { whenBackgroundIdle } from "./backgroundScheduler";

export const STILL_PROXY_EDGES = { base: 1920, zoomed: 2560 } as const;
const STILL_PROXY_VERSION = 1;
const WEBP_QUALITY = 0.82;
const DIR_NAME = "lumio-still-proxies";
/** Serialize generations — decode+encode of a 4K image is heavy; two at once doubles the jank. */
let generationChain: Promise<unknown> = Promise.resolve();
/** Per-session results: Blob (ready), null (proxy not applicable / failed — use original). */
const sessionCache = new Map<string, Promise<Blob | null>>();

function keyFor(src: string, edge: number): string {
  // djb2 — cheap, stable, collision-tolerable (a collision only swaps one preview proxy for
  // another until site data is cleared; originals/export are never involved).
  let hash = 5381;
  for (let i = 0; i < src.length; i += 1) hash = ((hash << 5) + hash + src.charCodeAt(i)) | 0;
  return `v${STILL_PROXY_VERSION}-${edge}-${(hash >>> 0).toString(36)}-${src.length}`;
}

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR_NAME, { create: true });
  } catch {
    return null;
  }
}

async function readOpfs(name: string): Promise<Blob | null> {
  try {
    const dir = await opfsDir();
    if (!dir) return null;
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return file.size > 0 ? file : null;
  } catch {
    return null; // not cached yet
  }
}

async function writeOpfs(name: string, blob: Blob): Promise<void> {
  try {
    const dir = await opfsDir();
    if (!dir) return;
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch {
    /* persistence is best-effort — the session cache still serves this run */
  }
}

async function generate(src: string, edge: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return null;
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) return null;
  const sourceBlob = await response.blob();
  const bitmap = await createImageBitmap(sourceBlob); // EXIF-applied, unflipped
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= edge) return null; // already small enough — original wins on quality
    const scale = edge / longEdge;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const webp = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
    // Some engines silently fall back to PNG; that's fine — smaller pixels are the win, the
    // container is a bonus.
    return webp.size > 0 ? webp : null;
  } finally {
    bitmap.close();
  }
}

/**
 * The preview proxy for `src` at the given tier edge, or `null` when the original should be used.
 * First call generates (serialized, off the render path); subsequent calls (any mount of the same
 * image) resolve from the session cache or OPFS instantly.
 */
export function getStillProxyBlob(src: string, edge: number): Promise<Blob | null> {
  const key = keyFor(src, edge);
  const cached = sessionCache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const persisted = await readOpfs(key);
    if (persisted) return persisted;
    const result: Blob | null = await new Promise((resolveGen) => {
      generationChain = generationChain.then(async () => {
        try {
          // Background gate (Phase 2): a 4K fetch+decode+re-encode never lands during playback /
          // a gesture / an export. The still layer shows the original until the idle window.
          await whenBackgroundIdle();
          resolveGen(await generate(src, edge));
        } catch {
          resolveGen(null);
        }
      });
    });
    if (result) void writeOpfs(key, result);
    return result;
  })();
  sessionCache.set(key, pending);
  return pending;
}
