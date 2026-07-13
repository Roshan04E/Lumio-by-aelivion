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
 * Storage: OPFS directory `kimera-source-proxies/` — `<assetId>.mp4` blobs plus an `index.json` of
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
export const SOURCE_PROXY_VERSION = 4;

const OPFS_DIR = "kimera-source-proxies";
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
  const records = (await loadRecords(handle.dir)).filter((item) => item.assetId !== assetId);
  recordsPromise = Promise.resolve(records);
  await writeIndex(handle.dir, records).catch(() => undefined);
}
