/**
 * Brand rename migration (Kimera → Orreris Pro / Aelivion → Pesamee).
 *
 * The rename moved every persisted key from a `kimera*` prefix to `orreris*`. Existing browsers
 * still hold data under the old names, so on first boot after the rename we copy it forward:
 *   - localStorage: every `kimera…` key → its `orreris…` twin (auth token, saved projects, layout
 *     prefs, wallet, voice settings, the asset blob-path index, …). Synchronous, cheap, runs before
 *     the app reads the auth token.
 *   - OPFS + IndexedDB blob stores: the imported-media bytes lived under `kimera-assets`; copy them
 *     into `orreris-assets` so local-first imports survive the rename. Best-effort and async.
 *
 * Both passes are idempotent (guarded by a done-flag) and fully swallow errors — a failed migration
 * must never block startup. Legacy data is copied, not deleted, so the step is reversible.
 */

const LS_FLAG = "orreris_brand_migrated_v1";
const BLOB_FLAG = "orreris_brand_blobs_migrated_v1";
const LEGACY_PREFIX = "kimera";
const NEW_PREFIX = "orreris";
const LEGACY_STORE = "kimera-assets";
const NEW_STORE = "orreris-assets";
const IDB_STORE = "blobs";

/** Copy all `kimera…` localStorage keys to their `orreris…` twins (without clobbering newer values). */
export function migrateBrandLocalStorage(): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(LS_FLAG)) return;

    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
    }
    for (const oldKey of legacyKeys) {
      const newKey = NEW_PREFIX + oldKey.slice(LEGACY_PREFIX.length);
      if (localStorage.getItem(newKey) !== null) continue; // don't overwrite newer data
      const value = localStorage.getItem(oldKey);
      if (value !== null) localStorage.setItem(newKey, value);
    }
    localStorage.setItem(LS_FLAG, "1");
  } catch {
    /* best-effort — a migration failure must not break boot */
  }
}

/** Copy imported-media blobs from the legacy OPFS/IndexedDB stores into the renamed ones. */
export async function migrateBrandBlobStores(): Promise<void> {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem(BLOB_FLAG)) return;
    await migrateOpfsBlobs();
    await migrateIdbBlobs();
    if (typeof localStorage !== "undefined") localStorage.setItem(BLOB_FLAG, "1");
  } catch {
    /* best-effort */
  }
}

/** Recursively copy every file/dir under `src` into `dst`, skipping entries that already exist. */
async function copyDir(src: FileSystemDirectoryHandle, dst: FileSystemDirectoryHandle): Promise<void> {
  // `entries()` is async-iterable on FileSystemDirectoryHandle in the browsers we target.
  for await (const [name, handle] of (src as unknown as {
    entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries()) {
    if (handle.kind === "file") {
      let exists = false;
      try {
        await dst.getFileHandle(name);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      const out = await dst.getFileHandle(name, { create: true });
      const writable = await out.createWritable();
      await writable.write(file);
      await writable.close();
    } else {
      const subSrc = handle as FileSystemDirectoryHandle;
      const subDst = await dst.getDirectoryHandle(name, { create: true });
      await copyDir(subSrc, subDst);
    }
  }
}

async function migrateOpfsBlobs(): Promise<void> {
  const storage = navigator.storage as (StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  }) | undefined;
  if (!storage?.getDirectory) return;
  const root = await storage.getDirectory();

  let legacy: FileSystemDirectoryHandle;
  try {
    legacy = await root.getDirectoryHandle(LEGACY_STORE); // no create — presence check
  } catch {
    return; // nothing to migrate
  }
  const target = await root.getDirectoryHandle(NEW_STORE, { create: true });
  await copyDir(legacy, target);
}

async function migrateIdbBlobs(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  // Only touch IndexedDB when we can confirm the legacy DB exists — otherwise opening it would
  // create an empty DB and we'd have nothing to copy.
  const list = (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases;
  if (!list) return;
  const dbs = await list.call(indexedDB);
  if (!dbs.some((entry) => entry.name === LEGACY_STORE)) return;

  const legacy = await openDb(LEGACY_STORE);
  const entries = await readAll(legacy);
  legacy.close();
  if (entries.length === 0) return;

  const target = await openDb(NEW_STORE);
  await new Promise<void>((resolve, reject) => {
    const tx = target.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    for (const { key, value } of entries) {
      // add() (not put()) so we never clobber blobs already written under the new name.
      const req = store.add(value, key);
      req.onerror = () => req.transaction?.abort();
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve(); // collisions are fine — the blob is already present
    tx.onerror = () => reject(tx.error);
  });
  target.close();
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readAll(db: IDBDatabase): Promise<{ key: IDBValidKey; value: Blob }[]> {
  return new Promise((resolve, reject) => {
    const out: { key: IDBValidKey; value: Blob }[] = [];
    const tx = db.transaction(IDB_STORE, "readonly");
    const cursor = tx.objectStore(IDB_STORE).openCursor();
    cursor.onsuccess = () => {
      const cur = cursor.result;
      if (!cur) return;
      out.push({ key: cur.key, value: cur.value as Blob });
      cur.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}
