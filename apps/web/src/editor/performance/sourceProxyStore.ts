/**
 * Per-SOURCE ingest proxies — the Premiere/Resolve proxy model, missing half of our caching story.
 *
 * The span cache (renderCache.ts / proxyMediaStore.ts) is a TIMELINE render cache: flattened
 * composites, invalidated by every edit. This store is the other kind: one small, keyframe-dense
 * H.264 file PER SOURCE ASSET, generated once at import/first-use and NEVER invalidated by edits —
 * trims, effects, and quality toggles don't touch it. The live playback path decodes these instead
 * of the original camera file (a 108MB sparse-GOP 4K source needs a multi-second decode catch-up
 * for every playhead drop; its 480p 1s-GOP proxy seeks in ~15 delta frames). Exports always read
 * the ORIGINAL bytes — proxies are a preview-only substitution via `SourceAsset.proxyUrl`.
 *
 * Storage: OPFS directory `orreris-source-proxies/` — `<assetId>.mp4` blobs plus an `index.json` of
 * metadata records. A record is valid only while its `sourceByteSize` matches the current asset
 * bytes (relinking different footage under the same id invalidates the proxy). No IndexedDB/memory
 * fallback: proxies are a performance layer, and where OPFS is unavailable the editor simply plays
 * originals like before.
 */

export interface SourceProxyRecord {
  assetId: string;
  /** Fingerprint of the source bytes the proxy was built from. */
  sourceByteSize: number;
  width: number;
  height: number;
  durationSeconds: number;
  hasAudio: boolean;
  byteSize: number;
  savedAt: number;
  version: number;
}

/** Bump to invalidate all persisted proxies when the transcode recipe changes. */
// v2 (2026-07-05): v1 proxies could contain a BAKED-IN frozen tail (the transcode kept encoding the
// last good canvas after the decoder failed mid-file) and sampled every source on a hardcoded 30fps
// grid (judder on 24/25fps content). Rebuild everything with the frozen-tail guard + source-fps recipe.
// v3 (2026-07-06): the pre-worker engine could build DURING ½/¼/Auto playback on the main thread
// (starved decoder → suspect output; the build-origin "plays ~4s then freezes in Auto, originals
// fine everywhere" report matches proxy playback exactly). Invalidate everything built by that
// engine — rebuilds now run in sourceProxy.worker.ts and only while the transport is parked.
// v4 (2026-07-06): fragmented MP4s (Pexels/CMAF) were indexed only to their FIRST fragment by
// demuxIndex — the decoder clamped past it, so v3 proxies of those sources carry a frozen tail
// BAKED IN from ~the fragment boundary (user matrix: frozen at 8.5/10.4/16.8s by variant; Clipchamp
// re-encodes fine). The demuxer now walks all fragments; rebuild everything decoded before that.
// v5 (2026-07-13): asset/element duration metadata (ceil-to-Int asset column, stock whole-seconds)
// OVERSHOOTS the decodable sample table by up to ~1s; the build loop trusted it, and past the last
// sample getFrame CLAMPS to the final frame (never null) — so v4 proxies bake a frozen last-second
// repeat the null-based frozen-tail guard cannot see. Builds now clamp their frame loop to the
// provider's demuxed `decodableEndSeconds`; rebuild everything encoded without that clamp.
// v6 (2026-07-18): quality recipe upgrade — long edge 854 → 1280, 0.1 → 0.18 bits/pixel/frame
// (user report: crowd/street proxies unusably soft while skipped clips played the sharp original).
// Rebuild everything encoded with the 480p recipe.
// v7 (2026-07-19): motion parity — PROXY_FPS cap 30 → 60 (60fps footage played at HALF rate on
// ½/¼/Auto quality; Premiere proxies drop resolution, never motion) + sublinear fps bitrate law.
// 24/30fps sources re-encode identically; the rebuild exists to catch every >30fps proxy.
// v8 (2026-07-24): nominalFps B-frame reorder fix. The source-cadence detector took a median of
// adjacent DECODE-ORDER cts deltas, which a B-frame pyramid fools into ~¼ rate (a 30fps stock clip
// resampled to a ~8fps stop-motion proxy while the untouched original played smooth — confirmed via
// the Source Viewer's decoded-fps meter + the [nominalFps] cross-check log). Detection is now
// count-based (samples ÷ cts span, reorder-invariant). Rebuild every proxy encoded from B-frame
// footage (i.e. most H.264/HEVC sources) at its true frame rate.
// v9 (2026-07-25): frame-based GOP. v8 finally produced true 60fps proxies (v7's intent), which then
// FROZE in the WebCodecs preview pool: a 1-second GOP is 60 frames at 60fps, and the seek-on-demand
// decoder can only catch up by grinding a whole GOP — it can't decode 60 inter-frames/s in realtime, so
// the served frame fell past the 0.35s hold cutoff and the canvas held (froze). Keyframe cadence is now
// a fixed FRAME COUNT (PROXY_KEYFRAME_EVERY_N_FRAMES=12 → interval N/fps), so max catch-up is ~12 frames
// at ANY fps (30/60/120) → high-fps proxies play frame-dropped-but-smooth. Rebuild everything with the
// long-GOP recipe (bigger files: ~2–3× more keyframes, the standard edit-proxy tradeoff).
export const SOURCE_PROXY_VERSION = 9;

const OPFS_DIR = "orreris-source-proxies";
const INDEX_FILE = "index.json";

interface OpfsHandle {
  dir: FileSystemDirectoryHandle;
}

let handlePromise: Promise<OpfsHandle | null> | null = null;

function getHandle(): Promise<OpfsHandle | null> {
  return (handlePromise ??= (async () => {
    const storage = navigator.storage as (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }) | undefined;
    if (!storage?.getDirectory) return null;
    try {
      const root = await storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
      return { dir };
    } catch {
      return null;
    }
  })());
}

async function readIndex(dir: FileSystemDirectoryHandle): Promise<SourceProxyRecord[]> {
  try {
    const handle = await dir.getFileHandle(INDEX_FILE);
    const file = await handle.getFile();
    const parsed = JSON.parse(await file.text()) as unknown;
    return Array.isArray(parsed) ? (parsed as SourceProxyRecord[]) : [];
  } catch {
    return [];
  }
}

// index.json is read ONCE per session into this map, and every mutation rewrites the file from
// it — previously each getSourceProxy/saveSourceProxy re-read + re-parsed the whole file per
// asset (O(assets) OPFS reads on import). The store stays best-effort/self-healing: a lost or
// stale index only means a proxy rebuild. (Two tabs racing writes was last-writer-wins before
// this cache and still is.)
let recordsPromise: Promise<SourceProxyRecord[]> | null = null;

function loadRecords(dir: FileSystemDirectoryHandle): Promise<SourceProxyRecord[]> {
  return (recordsPromise ??= readIndex(dir));
}

async function writeIndex(dir: FileSystemDirectoryHandle, records: SourceProxyRecord[]): Promise<void> {
  const handle = await dir.getFileHandle(INDEX_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(records));
  await writable.close();
}

function blobName(assetId: string): string {
  // Asset ids are our own generated tokens, but sanitize anyway — OPFS names can't contain "/".
  return `${assetId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.mp4`;
}

/** Resume-cache segment file for an asset (see sourceProxySegments.ts). Not a playable container. */
function segmentName(assetId: string, segmentIndex: number): string {
  return `${assetId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.seg${segmentIndex}.bin`;
}

/**
 * Persist one completed segment of an in-flight build. Best-effort by design: a failed segment
 * write costs a slower resume later, never a failed or corrupt build, so it is swallowed.
 */
export async function saveSourceProxySegment(assetId: string, segmentIndex: number, blob: Blob): Promise<void> {
  const handle = await getHandle();
  if (!handle) return;
  try {
    const fileHandle = await handle.dir.getFileHandle(segmentName(assetId, segmentIndex), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch {
    /* resume is an optimization — never fail a build over its cache */
  }
}

/** Read a persisted segment blob, or null when absent/unreadable (→ that segment gets rebuilt). */
export async function getSourceProxySegment(assetId: string, segmentIndex: number): Promise<Blob | null> {
  const handle = await getHandle();
  if (!handle) return null;
  try {
    const fileHandle = await handle.dir.getFileHandle(segmentName(assetId, segmentIndex));
    return await fileHandle.getFile();
  } catch {
    return null;
  }
}

/**
 * Drop every segment file for an asset. Called once a build completes (the finished proxy
 * supersedes its own resume cache) and whenever a proxy is invalidated or removed, so a stale
 * prefix from different source bytes can never be spliced into a later build.
 */
export async function clearSourceProxySegments(assetId: string): Promise<void> {
  const handle = await getHandle();
  if (!handle) return;
  const prefix = `${assetId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.seg`;
  try {
    const dir = handle.dir as FileSystemDirectoryHandle & { keys?: () => AsyncIterableIterator<string> };
    if (!dir.keys) return;
    const names: string[] = [];
    for await (const name of dir.keys()) {
      if (name.startsWith(prefix) && name.endsWith(".bin")) names.push(name);
    }
    for (const name of names) await handle.dir.removeEntry(name).catch(() => undefined);
  } catch {
    /* best-effort cleanup */
  }
}

// One stable object URL per asset per session (revoked on remove).
const urlCache = new Map<string, string>();

/** Whether this browser can persist source proxies at all. */
export async function sourceProxyStoreAvailable(): Promise<boolean> {
  return (await getHandle()) !== null;
}

/**
 * Fetch a valid persisted proxy for the asset, or null. `sourceByteSize` guards against a proxy
 * built from different bytes (relinked asset) and a version bump retires old recipes — both cases
 * delete the stale blob so OPFS stays clean.
 */
export async function getSourceProxy(
  assetId: string,
  sourceByteSize: number
): Promise<{ url: string; record: SourceProxyRecord } | null> {
  const handle = await getHandle();
  if (!handle) return null;
  const records = await loadRecords(handle.dir);
  const record = records.find((item) => item.assetId === assetId);
  if (!record) return null;
  if (record.sourceByteSize !== sourceByteSize || record.version !== SOURCE_PROXY_VERSION) {
    await removeSourceProxy(assetId);
    return null;
  }
  const cached = urlCache.get(assetId);
  if (cached) return { url: cached, record };
  try {
    const fileHandle = await handle.dir.getFileHandle(blobName(assetId));
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    urlCache.set(assetId, url);
    return { url, record };
  } catch {
    // Index points at a missing blob — drop the record (in-memory + persisted).
    const remaining = records.filter((item) => item.assetId !== assetId);
    recordsPromise = Promise.resolve(remaining);
    await writeIndex(handle.dir, remaining).catch(() => undefined);
    return null;
  }
}

/**
 * DIAGNOSTIC: the proxy blob URL for an asset if one exists on disk, WITHOUT the byte-size/version
 * guard `getSourceProxy` enforces — for the Source Viewer, which just wants to PLAY whatever proxy is
 * persisted so a user can A/B it against the original (a stale/mismatched proxy is still worth seeing).
 * Returns null when no proxy blob is stored. Never used by the render path.
 */
export async function getSourceProxyBlobUrl(assetId: string): Promise<{ url: string; record: SourceProxyRecord | null } | null> {
  const handle = await getHandle();
  if (!handle) return null;
  const cached = urlCache.get(assetId);
  const record = (await loadRecords(handle.dir)).find((item) => item.assetId === assetId) ?? null;
  if (cached) return { url: cached, record };
  try {
    const fileHandle = await handle.dir.getFileHandle(blobName(assetId));
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    urlCache.set(assetId, url);
    return { url, record };
  } catch {
    return null;
  }
}

/** Persist a freshly transcoded proxy and return its session object URL. */
export async function saveSourceProxy(record: Omit<SourceProxyRecord, "byteSize" | "savedAt" | "version">, blob: Blob): Promise<string | null> {
  const handle = await getHandle();
  if (!handle) return null;
  try {
    const fileHandle = await handle.dir.getFileHandle(blobName(record.assetId), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    const records = (await loadRecords(handle.dir)).filter((item) => item.assetId !== record.assetId);
    records.push({ ...record, byteSize: blob.size, savedAt: Date.now(), version: SOURCE_PROXY_VERSION });
    recordsPromise = Promise.resolve(records);
    await writeIndex(handle.dir, records);
    const previous = urlCache.get(record.assetId);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob);
    urlCache.set(record.assetId, url);
    return url;
  } catch {
    return null;
  }
}

export async function removeSourceProxy(assetId: string): Promise<void> {
  const handle = await getHandle();
  if (!handle) return;
  const cached = urlCache.get(assetId);
  if (cached) {
    URL.revokeObjectURL(cached);
    urlCache.delete(assetId);
  }
  await handle.dir.removeEntry(blobName(assetId)).catch(() => undefined);
  // A proxy invalidated by changed source bytes or a recipe bump must take its resume cache with
  // it, or the next build could splice a prefix encoded from the OLD bytes into the new one.
  await clearSourceProxySegments(assetId);
  const records = (await loadRecords(handle.dir)).filter((item) => item.assetId !== assetId);
  recordsPromise = Promise.resolve(records);
  await writeIndex(handle.dir, records).catch(() => undefined);
}
