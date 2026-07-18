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

/**
 * Optional storage scope for NEW writes — the local mirror of the cloud taxonomy
 * (plans/media-cloud-architecture.md M1): `u_<userId>/video/projects/<projectId>` for
 * project-owned bytes, `u_<userId>/video/library` for user-level reusables. Purely an
 * organizational layout inside OPFS: the public API stays id-keyed, a path index maps id → home,
 * and reads always fall back to the legacy flat dir, so pre-taxonomy blobs keep working untouched
 * (no bulk migration of user footage — deliberately; a mass move risks the data it organizes).
 */
export interface AssetScope {
  userId?: string | undefined;
  /** Owning project, or null/absent for the user-level library. */
  projectId?: string | null | undefined;
}

export interface AssetBlobStore {
  kind: "opfs" | "indexeddb" | "memory";
  put: (id: string, blob: Blob, scope?: AssetScope) => Promise<void>;
  getObjectUrl: (id: string) => Promise<string | null>;
  /** Raw bytes for re-upload (FormData) during local→server promotion. Null if absent. */
  getBlob: (id: string) => Promise<Blob | null>;
  /** Whether bytes for `id` are still present on-device (false → needs relink). */
  has: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}

const OPFS_DIR = "orreris-assets";
const IDB_NAME = "orreris-assets";
const IDB_STORE = "blobs";
// id → scoped path segments (relative to the OPFS root dir). Only ids written with a scope appear
// here; anything else resolves from the legacy flat dir. Corruption-tolerant: a miss falls back to
// the flat dir, and remove() clears the entry.
const PATH_INDEX_KEY = "orreris_blob_paths";

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}

function scopeSegments(scope: AssetScope | undefined): string[] | null {
  if (!scope) return null;
  const user = `u_${sanitizeSegment(scope.userId || "local")}`;
  return scope.projectId
    ? [user, "video", "projects", sanitizeSegment(scope.projectId), "assets"]
    : [user, "video", "library"];
}

function readPathIndex(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PATH_INDEX_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function writePathIndexEntry(id: string, segments: string[] | null): void {
  try {
    const index = readPathIndex();
    if (segments) index[id] = segments;
    else delete index[id];
    localStorage.setItem(PATH_INDEX_KEY, JSON.stringify(index));
  } catch {
    /* index is an optimization — resolution still falls back to the flat dir */
  }
}

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

    /** Resolve nested segments to a directory handle under the store root. */
    async function dirFor(segments: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
      let current = dir;
      for (const segment of segments) {
        try {
          current = await current.getDirectoryHandle(segment, { create });
        } catch {
          return null;
        }
      }
      return current;
    }

    /** Find the file handle for `id`: index path → legacy flat dir. Heals a stale index entry. */
    async function fileFor(id: string): Promise<FileSystemFileHandle | null> {
      const segments = readPathIndex()[id];
      if (segments) {
        const home = await dirFor(segments, false);
        if (home) {
          try {
            return await home.getFileHandle(id);
          } catch {
            /* fall through to flat */
          }
        }
      }
      try {
        const handle = await dir.getFileHandle(id);
        if (segments) writePathIndexEntry(id, null); // index lied — the blob lives flat; heal it
        return handle;
      } catch {
        return null;
      }
    }

    return {
      kind: "opfs",
      async put(id, blob, scope) {
        const segments = scopeSegments(scope);
        const home = segments ? ((await dirFor(segments, true)) ?? dir) : dir;
        const handle = await home.getFileHandle(id, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        writePathIndexEntry(id, home === dir ? null : segments);
        dropUrl(id); // a new blob → invalidate any stale cached url
      },
      async getObjectUrl(id) {
        const cached = urlCache.get(id);
        if (cached) return cached;
        const handle = await fileFor(id);
        if (!handle) return null;
        try {
          return cacheUrl(id, await handle.getFile());
        } catch {
          return null;
        }
      },
      async getBlob(id) {
        const handle = await fileFor(id);
        if (!handle) return null;
        try {
          return await handle.getFile();
        } catch {
          return null;
        }
      },
      async has(id) {
        return (await fileFor(id)) !== null;
      },
      async remove(id) {
        dropUrl(id);
        const segments = readPathIndex()[id];
        if (segments) {
          const home = await dirFor(segments, false);
          await home?.removeEntry(id).catch(() => undefined);
          writePathIndexEntry(id, null);
        }
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
