/**
 * Local-first asset bytes store.
 *
 * User media (the actual file bytes) is persisted on-device — NOT in the cloud/DB — so:
 *   - it survives a page refresh (a `blob:` URL does not; that's the "black frame on
 *     refresh" bug — only the metadata persisted, the object URL died),
 *   - large high-quality clips are available instantly (no upload/download round-trip),
 *   - the footage never leaves the device (privacy).
 *
 * Backend preference: OPFS (real files, best for big media) → IndexedDB (Blob store) →
 * in-memory (session-only fallback). Object URLs are cached per session so a given asset
 * resolves to one stable URL and we don't leak. localStorage keeps only lightweight
 * metadata (see api.ts); the bytes live here, keyed by asset id.
 */

export interface AssetBlobStore {
  kind: "opfs" | "indexeddb" | "memory";
  put: (id: string, blob: Blob) => Promise<void>;
  getObjectUrl: (id: string) => Promise<string | null>;
  /** Raw bytes for re-upload (FormData) during local→server promotion. Null if absent. */
  getBlob: (id: string) => Promise<Blob | null>;
  /** Whether bytes for `id` are still present on-device (false → needs relink). */
  has: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}

const OPFS_DIR = "lumio-assets";
const IDB_NAME = "lumio-assets";
const IDB_STORE = "blobs";

// Per-session cache so repeated resolves return one stable object URL (and we can revoke).
const urlCache = new Map<string, string>();
function cacheUrl(id: string, blobOrFile: Blob): string {
  const existing = urlCache.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(blobOrFile);
  urlCache.set(id, url);
  return url;
}
function dropUrl(id: string): void {
  const url = urlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(id);
  }
}

let storePromise: Promise<AssetBlobStore> | null = null;
/** Resolve the best available local blob store (singleton). */
export function getAssetBlobStore(): Promise<AssetBlobStore> {
  return (storePromise ??= createStore());
}

/** Ask the browser to keep our storage from being evicted under pressure. Best-effort. */
export async function requestPersistentAssetStorage(): Promise<void> {
  try {
    await (navigator.storage as StorageManager & { persist?: () => Promise<boolean> })?.persist?.();
  } catch {
    /* ignore — not critical */
  }
}

async function createStore(): Promise<AssetBlobStore> {
  const opfs = await tryOpfs();
  if (opfs) return opfs;
  const idb = await tryIndexedDb();
  if (idb) return idb;
  return memoryStore();
}

async function tryOpfs(): Promise<AssetBlobStore | null> {
  const storage = navigator.storage as (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }) | undefined;
  if (!storage?.getDirectory) return null;
  try {
    const root = await storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    return {
      kind: "opfs",
      async put(id, blob) {
        const handle = await dir.getFileHandle(id, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        dropUrl(id); // a new blob → invalidate any stale cached url
      },
      async getObjectUrl(id) {
        const cached = urlCache.get(id);
        if (cached) return cached;
        try {
          const handle = await dir.getFileHandle(id);
          const file = await handle.getFile();
          return cacheUrl(id, file);
        } catch {
          return null;
        }
      },
      async getBlob(id) {
        try {
          const handle = await dir.getFileHandle(id);
          return await handle.getFile();
        } catch {
          return null;
        }
      },
      async has(id) {
        try {
          await dir.getFileHandle(id);
          return true;
        } catch {
          return false;
        }
      },
      async remove(id) {
        dropUrl(id);
        await dir.removeEntry(id).catch(() => undefined);
      }
    };
  } catch {
    return null;
  }
}

async function tryIndexedDb(): Promise<AssetBlobStore | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return {
      kind: "indexeddb",
      async put(id, blob) {
        await idbRequest(db, "readwrite", (store) => store.put(blob, id));
        dropUrl(id);
      },
      async getObjectUrl(id) {
        const cached = urlCache.get(id);
        if (cached) return cached;
        const blob = await idbRequest<Blob | undefined>(db, "readonly", (store) => store.get(id));
        return blob ? cacheUrl(id, blob) : null;
      },
      async getBlob(id) {
        const blob = await idbRequest<Blob | undefined>(db, "readonly", (store) => store.get(id));
        return blob ?? null;
      },
      async has(id) {
        const key = await idbRequest<IDBValidKey | undefined>(db, "readonly", (store) => store.getKey(id));
        return key !== undefined;
      },
      async remove(id) {
        dropUrl(id);
        await idbRequest(db, "readwrite", (store) => store.delete(id));
      }
    };
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const request = run(tx.objectStore(IDB_STORE));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

function memoryStore(): AssetBlobStore {
  const blobs = new Map<string, Blob>();
  return {
    kind: "memory",
    async put(id, blob) {
      blobs.set(id, blob);
      dropUrl(id);
    },
    async getObjectUrl(id) {
      const cached = urlCache.get(id);
      if (cached) return cached;
      const blob = blobs.get(id);
      return blob ? cacheUrl(id, blob) : null;
    },
    async getBlob(id) {
      return blobs.get(id) ?? null;
    },
    async has(id) {
      return blobs.has(id);
    },
    async remove(id) {
      dropUrl(id);
      blobs.delete(id);
    }
  };
}
