/**
 * Persistent browser cache for ML model weights (ONNX / TFLite / WASM blobs) shared by every local
 * tool engine. Models are downloaded ONCE, stored in OPFS, and reused across sessions and reloads —
 * so a flaky network (corporate/OS network optimizations, throttling, dropped connections) can't turn
 * a working engine into a hard failure on the next run, and we never re-pull tens of MB every session.
 *
 * We fetch the bytes ourselves (with progress + retry) and hand the ArrayBuffer straight to the engine
 * (onnxruntime `InferenceSession.create(bytes)`, MediaPipe `modelAssetBuffer`) instead of letting the
 * engine fetch a URL internally — that both enables caching and sidesteps the internal-fetch paths
 * that were failing under the user's network. OPFS-unavailable browsers fall back to an in-memory
 * cache (still one download per session).
 */

const MODELS_DIR = "orreris-models";
const memoryCache = new Map<string, ArrayBuffer>();

export interface ModelFetchProgress {
  /** Bytes downloaded so far. */
  loaded: number;
  /** Total bytes when known (Content-Length), else 0. */
  total: number;
}

export interface ModelFetchOptions {
  onProgress?: ((progress: ModelFetchProgress) => void) | undefined;
  /** Re-download even if cached (the "Redownload" action). */
  force?: boolean | undefined;
  /** Network attempts before giving up (default 3). */
  retries?: number | undefined;
}

/** Stable, filesystem-safe cache key for a model URL (keeps a readable tail + a short hash of the URL). */
function keyForUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i += 1) {
    hash = (hash * 31 + url.charCodeAt(i)) | 0;
  }
  const tail = url.split(/[/?#]/).filter(Boolean).pop() ?? "model";
  const safeTail = tail.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-48);
  return `${(hash >>> 0).toString(36)}_${safeTail}`;
}

async function modelsDirectory(create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) {
      return undefined;
    }
    return await root.getDirectoryHandle(MODELS_DIR, { create });
  } catch {
    return undefined;
  }
}

async function readFromOpfs(key: string): Promise<ArrayBuffer | undefined> {
  try {
    const dir = await modelsDirectory(false);
    if (!dir) {
      return undefined;
    }
    const handle = await dir.getFileHandle(key);
    const file = await handle.getFile();
    return file.size > 0 ? await file.arrayBuffer() : undefined;
  } catch {
    return undefined;
  }
}

async function writeToOpfs(key: string, bytes: ArrayBuffer): Promise<void> {
  try {
    const dir = await modelsDirectory(true);
    if (!dir) {
      return;
    }
    const handle = await dir.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  } catch {
    /* best-effort persistence — an OPFS write failure just means we re-download next session */
  }
}

async function downloadWithProgress(url: string, onProgress?: (p: ModelFetchProgress) => void): Promise<ArrayBuffer> {
  const response = await fetch(url, { mode: "cors", cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !onProgress) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ loaded: buffer.byteLength, total: total || buffer.byteLength });
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress({ loaded, total });
    }
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/**
 * Returns the model bytes, downloading (with retry) and caching to OPFS on first use. `force`
 * re-downloads. Concurrent callers for the same URL share one in-flight download.
 */
const inFlight = new Map<string, Promise<ArrayBuffer>>();

export async function getCachedModel(url: string, options: ModelFetchOptions = {}): Promise<ArrayBuffer> {
  const key = keyForUrl(url);
  if (!options.force) {
    const memory = memoryCache.get(key);
    if (memory) {
      return memory;
    }
    const existing = inFlight.get(key);
    if (existing) {
      return existing;
    }
    const disk = await readFromOpfs(key);
    if (disk) {
      memoryCache.set(key, disk);
      return disk;
    }
  }

  const attempts = Math.max(1, options.retries ?? 3);
  const task = (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const bytes = await downloadWithProgress(url, options.onProgress);
        memoryCache.set(key, bytes);
        await writeToOpfs(key, bytes);
        return bytes;
      } catch (error) {
        lastError = error;
        // brief backoff before retrying a flaky network
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Unable to download model ${url}`);
  })();
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

/** Clears cached model(s): one URL, or (no arg) every cached model. Used by the "Redownload" action. */
export async function clearCachedModels(urls?: string[]): Promise<void> {
  const dir = await modelsDirectory(false);
  if (urls && urls.length) {
    for (const url of urls) {
      const key = keyForUrl(url);
      memoryCache.delete(key);
      inFlight.delete(key);
      await dir?.removeEntry(key).catch(() => undefined);
    }
    return;
  }
  memoryCache.clear();
  inFlight.clear();
  if (dir) {
    // Remove every entry in the models directory. `keys()` is present on OPFS dir handles at runtime;
    // cast for older lib.dom typings that don't yet declare the async iterators.
    const iterable = dir as unknown as { keys?: () => AsyncIterable<string> };
    if (iterable.keys) {
      for await (const name of iterable.keys()) {
        await dir.removeEntry(name).catch(() => undefined);
      }
    }
  }
}

/** True when a model URL is already cached (OPFS or memory) — for a "downloaded ✓" status in the UI. */
export async function isModelCached(url: string): Promise<boolean> {
  const key = keyForUrl(url);
  if (memoryCache.has(key)) {
    return true;
  }
  return (await readFromOpfs(key)) !== undefined;
}
