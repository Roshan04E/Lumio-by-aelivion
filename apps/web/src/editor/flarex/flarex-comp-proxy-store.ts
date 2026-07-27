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
  } catch {
    // OPFS quota/permission failure — keep the render usable for this session rather than losing it.
    memoryProxies.set(compId, record);
  }
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
  const directory = await proxyDirectory();
  if (!directory) return;
  await directory.removeEntry(sidecarFileName(compId)).catch(() => undefined);
  await directory.removeEntry(blobFileName(compId)).catch(() => undefined);
}
