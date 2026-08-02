/**
 * Flarex comp proxy store (plans/flarex-comp-proxy.md — S1).
 *
 * Persists ONE rendered proxy per comp to OPFS, alongside the key it was rendered under. The key is
 * OPAQUE here: this module only ever compares it for equality, so every rule about what makes a proxy
 * stale lives with the renderer ([flarex-comp-proxy.ts]) and this file never has to be changed when
 * those rules grow.
 *
 * Read is exact-or-nothing. A key mismatch returns `undefined` — never a "repaired" or best-effort
 * record — because the whole safety argument for showing a proxy instead of the live graph is that the
 * key cannot match unless the pixels would. Everything else fails open too (no OPFS, a write error, a
 * torn sidecar ⇒ no proxy), so the feature can only ever make playback cheaper, never wrong.
 *
 * Separate from `tools/artifact-store.ts` deliberately: that store is keyed by tool RUN and its records
 * are `ToolArtifact`s the user's timeline can reference. A comp proxy is a disposable render cache — it
 * is never referenced by project data and must never survive into an export.
 */

/** A proxy as stored: the blob plus the key that must match for it to be usable. */
export interface StoredFlarexCompProxy {
  key: string;
  blob: Blob;
  /** Epoch ms — for the S3 lifecycle UI ("built 4 min ago") and eviction ordering. */
  renderedAt: number;
}

interface ProxySidecar {
  key: string;
  renderedAt: number;
  mime: string;
}

const DIRECTORY_NAME = "orreris-flarex-comp-proxies";

/**
 * Total bytes of stored proxies before the oldest are evicted.
 *
 * A comp proxy is a full-resolution render of a clip's whole span, so these are the largest artifacts
 * the editor writes — a handful of comps on a long timeline reaches gigabytes, and nothing was ever
 * deleting them. Eviction is safe precisely because a proxy is never authoritative: a discarded one
 * costs a re-render, never data. Oldest-first by render time, which approximates least-recently-useful
 * without needing access tracking.
 */
const PROXY_BUDGET_BYTES = 1_500_000_000;

/** Memory fallback — same contract, lost on reload. Used when OPFS is unavailable or throws. */
const memoryProxies = new Map<string, StoredFlarexCompProxy>();

let directoryPromise: Promise<FileSystemDirectoryHandle | null> | null = null;

function proxyDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!directoryPromise) {
    directoryPromise = (async () => {
      const storage = navigator.storage as (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }) | undefined;
      if (!storage?.getDirectory) return null;
      try {
        const root = await storage.getDirectory();
        return await root.getDirectoryHandle(DIRECTORY_NAME, { create: true });
      } catch {
        return null;
      }
    })();
  }
  return directoryPromise;
}

/** OPFS file names are derived from the comp id by convention, so a reload recovers with no index. */
function blobFileName(compId: string): string {
  return `${encodeURIComponent(compId)}.media`;
}

function sidecarFileName(compId: string): string {
  return `${encodeURIComponent(compId)}.json`;
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

/** What is stored for a comp, without reading the blob back. */
export interface FlarexCompProxyInfo {
  key: string;
  renderedAt: number;
  bytes: number;
}

/** OPFS directory iteration isn't in the TS lib yet. */
type IterableDirectory = FileSystemDirectoryHandle & { entries?: () => AsyncIterableIterator<[string, FileSystemHandle]> };

/**
 * Everything currently stored, newest first. Best-effort: an unreadable or torn record is skipped
 * rather than failing the sweep — this feeds eviction, and a record we cannot parse is one we also
 * cannot safely keep accounting for.
 */
async function listStoredProxies(directory: FileSystemDirectoryHandle): Promise<Array<FlarexCompProxyInfo & { compId: string }>> {
  const entries = (directory as IterableDirectory).entries;
  if (!entries) return [];
  const out: Array<FlarexCompProxyInfo & { compId: string }> = [];
  try {
    for await (const [name] of entries.call(directory)) {
      if (!name.endsWith(".json")) continue;
      const compId = decodeURIComponent(name.slice(0, -".json".length));
      try {
        const sidecar = JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text()) as ProxySidecar;
        let bytes = 0;
        try {
          bytes = (await (await directory.getFileHandle(blobFileName(compId))).getFile()).size;
        } catch {
          // Sidecar without a blob — a torn write. Size 0 makes it the cheapest thing to evict.
        }
        out.push({ compId, key: sidecar.key, renderedAt: sidecar.renderedAt, bytes });
      } catch {
        /* unparseable — skip */
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.renderedAt - a.renderedAt);
}

/**
 * Evict oldest-first until the total is within budget. `keepCompId` is never evicted — it is the proxy
 * that was just written, and dropping it would make "Prepare proxy" silently do nothing on a machine
 * already at budget.
 */
async function enforceBudget(directory: FileSystemDirectoryHandle, keepCompId: string): Promise<void> {
  const stored = await listStoredProxies(directory);
  let total = stored.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= PROXY_BUDGET_BYTES) return;
  for (const entry of [...stored].reverse()) {
    if (total <= PROXY_BUDGET_BYTES) break;
    if (entry.compId === keepCompId) continue;
    await removeFlarexCompProxy(entry.compId);
    total -= entry.bytes;
  }
}

/** The stored record for `compId` whatever its key — the basis for "a proxy exists but is stale". */
export async function peekFlarexCompProxy(compId: string): Promise<FlarexCompProxyInfo | undefined> {
  const inMemory = memoryProxies.get(compId);
  if (inMemory) return { key: inMemory.key, renderedAt: inMemory.renderedAt, bytes: inMemory.blob.size };
  const directory = await proxyDirectory();
  if (!directory) return undefined;
  try {
    const sidecar = JSON.parse(await (await (await directory.getFileHandle(sidecarFileName(compId))).getFile()).text()) as ProxySidecar;
    let bytes = 0;
    try {
      bytes = (await (await directory.getFileHandle(blobFileName(compId))).getFile()).size;
    } catch {
      /* torn write — reported as 0 bytes */
    }
    return { key: sidecar.key, renderedAt: sidecar.renderedAt, bytes };
  } catch {
    return undefined;
  }
}

/**
 * Store the proxy for `compId`, replacing any previous one. Writes the BLOB first and the sidecar
 * second: a crash between the two leaves a blob with a stale/absent key, which reads as "no proxy" —
 * the safe direction. The reverse order could publish a key that points at the previous render.
 */
export async function putFlarexCompProxy(compId: string, key: string, blob: Blob): Promise<StoredFlarexCompProxy> {
  const record: StoredFlarexCompProxy = { key, blob, renderedAt: Date.now() };
  const directory = await proxyDirectory();
  if (!directory) {
    memoryProxies.set(compId, record);
    return record;
  }
  try {
    await writeFile(directory, blobFileName(compId), blob);
    const sidecar: ProxySidecar = { key, renderedAt: record.renderedAt, mime: blob.type || "video/webm" };
    await writeFile(directory, sidecarFileName(compId), JSON.stringify(sidecar));
    // Sweep AFTER publishing, so a machine already at budget still gets the proxy it just asked for.
    // Never fatal: failing to evict costs disk, failing to store costs the feature.
    await enforceBudget(directory, compId).catch(() => undefined);
  } catch {
    // OPFS quota/permission failure — keep the render usable for this session rather than losing it.
    memoryProxies.set(compId, record);
  }
  // AFTER the write, on both paths: a listener that re-checks the store must never be woken before the
  // thing it is going to look for exists.
  notifyStoreChanged();
  return record;
}

/**
 * The stored proxy for `compId` IF it was rendered under exactly `key`, else undefined. Callers must
 * treat undefined as "evaluate the graph live" — there is no partial-hit path.
 */
export async function getFlarexCompProxy(compId: string, key: string): Promise<StoredFlarexCompProxy | undefined> {
  const inMemory = memoryProxies.get(compId);
  if (inMemory) return inMemory.key === key ? inMemory : undefined;

  const directory = await proxyDirectory();
  if (!directory) return undefined;
  try {
    const sidecarFile = await (await directory.getFileHandle(sidecarFileName(compId))).getFile();
    const sidecar = JSON.parse(await sidecarFile.text()) as ProxySidecar;
    if (sidecar.key !== key) return undefined;
    const blobFile = await (await directory.getFileHandle(blobFileName(compId))).getFile();
    return {
      key: sidecar.key,
      renderedAt: sidecar.renderedAt,
      blob: sidecar.mime ? blobFile.slice(0, blobFile.size, sidecar.mime) : blobFile,
    };
  } catch {
    // Missing file, torn sidecar, unparseable JSON — all mean "no usable proxy".
    return undefined;
  }
}

/** Whether a proxy rendered under exactly `key` exists, without reading the blob back. */
export async function hasFlarexCompProxy(compId: string, key: string): Promise<boolean> {
  const inMemory = memoryProxies.get(compId);
  if (inMemory) return inMemory.key === key;
  const directory = await proxyDirectory();
  if (!directory) return false;
  try {
    const sidecarFile = await (await directory.getFileHandle(sidecarFileName(compId))).getFile();
    return (JSON.parse(await sidecarFile.text()) as ProxySidecar).key === key;
  } catch {
    return false;
  }
}

/** Drop the proxy for `compId` (the S3 "Clear proxy" action). Never throws. */
export async function removeFlarexCompProxy(compId: string): Promise<void> {
  memoryProxies.delete(compId);
  notifyStoreChanged();
  const directory = await proxyDirectory();
  if (!directory) return;
  await directory.removeEntry(sidecarFileName(compId)).catch(() => undefined);
  await directory.removeEntry(blobFileName(compId)).catch(() => undefined);
}

// ── Store-change notification (2026-08-02) ──────────────────────────────────
//
// WHY THIS EXISTS. `useFlarexCompProxies` remembers keys it has already looked up and found nothing
// for, so an eligibility recompute does not re-hit the store every render. That memo had no
// invalidation: its comment said it is "retried only when the KEY changes, i.e. after a re-render of
// the proxy" — but **re-rendering a proxy does not change the key.** The key is a hash of the comp's
// identity, and preparing a proxy is precisely the operation that does not alter it.
//
// So the sequence that matters most was the one that could never recover: open the Edit page (no proxy
// yet → key memoized as missing), press Prepare proxy (stored under the SAME key), and the substitution
// never engages until a reload clears the ref. Reported from the soak, 2026-08-02.
//
// A store notification rather than a TTL: "has a proxy appeared?" has an exact answer at an exact
// moment, and polling for it would be a guess with a latency knob attached.

const storeListeners = new Set<() => void>();

function notifyStoreChanged(): void {
  for (const listener of [...storeListeners]) {
    try {
      listener();
    } catch {
      /* a listener must never break a store write */
    }
  }
}

/**
 * Fires whenever a proxy is stored or removed. Callers that memoize a *negative* lookup must
 * invalidate that memo here — a positive lookup is self-invalidating (the key changes with the comp),
 * a negative one is not.
 */
export function subscribeFlarexProxyStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}
