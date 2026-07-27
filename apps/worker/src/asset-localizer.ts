import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { RenderManifest } from "@orreris/render-templates";
import { createPresignedDownload, isR2StorageEnabled, relativeKeyFromUrl } from "@orreris/storage";

/**
 * Localize a render manifest's R2-backed source media to LOCAL disk, then serve it to Remotion from a
 * loopback file server — so the render never fetches media from R2 during frame extraction.
 *
 * Why: R2 from some networks intermittently SEVERS long streaming GETs (measured: a 10.9MB clip
 * truncated mid-stream ~half the time, while small ranged reads were 100% reliable). Remotion's
 * OffthreadVideo does one big streaming download per source; a single sever aborts the render and
 * orphans the job. We instead download each source ONCE in small ranged chunks with per-chunk retry
 * (a sever costs one 4MB retry, never the whole file), write it to a temp dir, and rewrite the
 * manifest to point at a `http://127.0.0.1:<port>/…` loopback server reading that temp dir. Reliable,
 * fast (local disk), and works for a fully PRIVATE bucket. No-op under the local storage driver.
 */

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB ranged chunks — small enough that a mid-stream sever is cheap to retry.
const CHUNK_ATTEMPTS = 6;
const CHUNK_TIMEOUT_MS = 45_000;

export interface LocalizedManifest {
  manifest: RenderManifest;
  /** Stop the loopback server and delete the temp download dir. Always call in a finally. */
  cleanup: () => Promise<void>;
}

/** No-op localizer (local driver, or nothing to localize) — keeps the caller's control flow uniform. */
function passthrough(manifest: RenderManifest): LocalizedManifest {
  return { manifest, cleanup: async () => undefined };
}

export async function localizeManifestMedia(
  manifest: RenderManifest,
  /** Reports download progress (`done` of `total` assets). This phase can run for tens of seconds on a
   *  media-heavy project, and without it the job sat at a single frozen percentage the whole time. */
  onProgress?: (done: number, total: number) => void
): Promise<LocalizedManifest> {
  if (!isR2StorageEnabled()) {
    return passthrough(manifest);
  }

  // Collect every unique storage URL in the manifest (field-name-agnostic walk, so nested groups,
  // flarex comps, junction layers, mattes and audio are all covered).
  const urls = new Set<string>();
  const scan = (value: unknown) => {
    if (typeof value === "string") {
      if (relativeKeyFromUrl(value)) urls.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) scan(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) scan(item);
    }
  };
  scan(manifest);
  if (urls.size === 0) {
    return passthrough(manifest);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orreris-assets-"));
  const urlToFile = new Map<string, string>();
  // The localization PLAN. A failure here reports one status code with no context, so without this you
  // cannot tell WHICH asset is missing, nor whether the manifest even referenced the one you expected —
  // the 404 that stalled cloud export for several rounds (2026-07-27).
  console.info(`[asset-localizer] localizing ${urls.size} asset(s) from the manifest:`);
  for (const url of urls) console.info(`[asset-localizer]   ${relativeKeyFromUrl(url) ?? "(unparseable)"}  ←  ${url}`);
  try {
    let index = 0;
    for (const url of urls) {
      const key = relativeKeyFromUrl(url);
      if (!key) continue;
      // Preserve the extension so the loopback server can set a sane Content-Type and Remotion's
      // source-type sniffing (mp4 vs mp3 vs png) still works.
      const ext = path.extname(key) || "";
      const fileName = `${index++}${ext}`;
      const dest = path.join(tmpDir, fileName);
      const signedUrl = await createPresignedDownload(key);
      try {
        await downloadRangedToFile(signedUrl, dest);
      } catch (r2Error) {
        // PRE-R2 MEDIA (2026-07-27). Not every storage URL is an R2 object: the API's /storage route
        // serves R2 first and falls through to `express.static` for media uploaded before the R2
        // migration — legacy flat `uploads/...` keys, as opposed to today's `u_<user>/video/...`. The
        // browser therefore plays them fine, but the worker presigns R2 DIRECTLY and got a hard 404,
        // failing the whole export over one old asset. Retry through the API URL, which owns that
        // fallback, so the worker resolves exactly what every other consumer resolves.
        console.warn(`[asset-localizer] R2 miss for "${key}" — retrying via the API (pre-R2 media?): ${String(r2Error)}`);
        try {
          await downloadRangedToFile(url, dest);
          console.info(`[asset-localizer] recovered "${key}" from the API's local-disk fallback`);
        } catch (apiError) {
          // Name the asset that actually failed, and BOTH causes. `urls` is a Set with no ordering
          // guarantee, so "the 6th attempt failed" told you nothing about which object is missing.
          throw new Error(
            `[asset-localizer] FAILED on key "${key}" (manifest url: ${url}) — R2: ${String(r2Error)} | API fallback: ${String(apiError)}`
          );
        }
      }
      urlToFile.set(url, fileName);
      onProgress?.(urlToFile.size, urls.size);
    }

    const server = await startLoopbackFileServer(tmpDir);
    const base = `http://127.0.0.1:${server.port}`;

    const rewrite = (value: unknown): unknown => {
      if (typeof value === "string") {
        const file = urlToFile.get(value);
        return file ? `${base}/${file}` : value;
      }
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
      }
      return value;
    };
    const rewritten = rewrite(manifest) as RenderManifest;

    return {
      manifest: rewritten,
      cleanup: async () => {
        await server.close().catch(() => undefined);
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    };
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Download a URL to `dest` in sequential ranged chunks, retrying each chunk independently. R2 honors
 * `Range` reliably even when it severs long full-GET streams, so this assembles the whole file even on
 * a flaky link. Falls back to a single full read if the server ignores Range (200 instead of 206).
 */
async function downloadRangedToFile(url: string, dest: string): Promise<void> {
  const write = createWriteStream(dest);
  try {
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const end = total === Infinity ? offset + CHUNK_SIZE - 1 : Math.min(offset + CHUNK_SIZE - 1, total - 1);
      const { bytes, parsedTotal, isFullBody } = await fetchChunk(url, offset, end);
      write.write(bytes);
      if (isFullBody) {
        // Server ignored Range and returned the whole object — we're done after this write.
        break;
      }
      if (parsedTotal !== undefined) total = parsedTotal;
      offset += bytes.length;
      if (bytes.length === 0) break; // defensive: avoid an infinite loop on an empty response.
    }
  } finally {
    await new Promise<void>((resolve, reject) => write.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
}

/** A permanently-failed fetch (404/403/401): retrying cannot change the outcome, so don't burn attempts. */
class FatalFetchError extends Error {}

/** Fetch a single byte range with retry + timeout. Returns the bytes and (from Content-Range) the total size. */
async function fetchChunk(
  url: string,
  start: number,
  end: number
): Promise<{ bytes: Buffer; parsedTotal: number | undefined; isFullBody: boolean }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal });
      if (res.status !== 206 && res.status !== 200) {
        // The URL is the whole diagnosis for a 4xx — "unexpected status 404" with no URL cost several
        // rounds (2026-07-27), because it cannot distinguish a missing upload from a bad id from a bad
        // host. A 404/403 is also DETERMINISTIC: retrying it 6× just delays the same answer, so fail fast.
        const detail = `unexpected status ${res.status} for ${url}`;
        if (res.status === 404 || res.status === 403 || res.status === 401) {
          throw new FatalFetchError(detail);
        }
        throw new Error(detail);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const contentRange = res.headers.get("content-range"); // "bytes 0-4194303/10941526"
      const totalMatch = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
      const parsedTotal = totalMatch?.[1] ? Number(totalMatch[1]) : undefined;
      return { bytes: buf, parsedTotal, isFullBody: res.status === 200 };
    } catch (error) {
      lastError = error;
      // A missing/forbidden object will never appear by retrying — surface it immediately, with the URL.
      if (error instanceof FatalFetchError) {
        throw new Error(`asset download failed (not retryable): ${error.message}`);
      }
      // Log EVERY failed attempt. The thrown message is the only thing that reaches the UI, where it is
      // truncated to a badge — so when a render dies here the actual cause (timeout vs truncated body vs
      // status code) was invisible unless you hovered it. Six identical lines also distinguish a
      // deterministic failure from genuine flakiness at a glance.
      console.warn(
        `[asset-localizer] chunk ${start}-${end} attempt ${attempt}/${CHUNK_ATTEMPTS} failed: ${String(error)}`
      );
      if (attempt < CHUNK_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 200 * attempt)); // linear backoff
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`asset download failed after ${CHUNK_ATTEMPTS} attempts: ${String(lastError)}`);
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

/**
 * Minimal loopback static server over the temp dir with HTTP Range support — Remotion's OffthreadVideo
 * seeks via Range, so partial responses (206) are required. Bound to 127.0.0.1 on an ephemeral port; it
 * only ever serves files inside `dir` (basename-only path, no traversal).
 */
async function startLoopbackFileServer(dir: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const name = path.basename(decodeURIComponent((req.url ?? "/").split("?")[0] ?? ""));
        const filePath = path.join(dir, name);
        if (!filePath.startsWith(dir)) {
          res.statusCode = 400;
          res.end();
          return;
        }
        const stat = await fs.stat(filePath);
        const type = CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
        res.setHeader("Content-Type", type);
        res.setHeader("Accept-Ranges", "bytes");

        const range = req.headers.range;
        const match = typeof range === "string" ? /bytes=(\d+)-(\d*)/.exec(range) : null;
        if (match) {
          const startStr = match[1] ?? "0";
          const start = Number(startStr);
          const end = match[2] ? Number(match[2]) : stat.size - 1;
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          res.setHeader("Content-Length", String(end - start + 1));
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          await pipeline(createReadStream(filePath, { start, end }), res);
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Length", String(stat.size));
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        await pipeline(createReadStream(filePath), res);
      } catch {
        if (!res.headersSent) res.statusCode = 404;
        res.end();
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
