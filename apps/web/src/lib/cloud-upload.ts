/**
 * Main-thread client for the direct-to-R2 upload worker (upload.worker.ts). Spins a one-shot
 * worker that streams a Blob to a presigned PUT URL and resolves when the bucket has the bytes.
 * Kept separate from api.ts so the worker module is only pulled in when a cloud upload actually runs.
 */

export interface CloudUploadProgress {
  loaded: number;
  total: number;
  /** 0..1 */
  fraction: number;
}

interface WorkerProgress extends CloudUploadProgress {
  type: "progress";
}
interface WorkerDone {
  type: "done";
}
interface WorkerError {
  type: "error";
  message: string;
}
type WorkerMessage = WorkerProgress | WorkerDone | WorkerError;

/**
 * Stream `blob` to a presigned PUT `uploadUrl` off the main thread. `contentType` MUST match the
 * type the URL was signed with. Resolves on 2xx, rejects on failure/abort.
 */
export function putBlobToCloud(
  uploadUrl: string,
  blob: Blob,
  contentType: string,
  options: { onProgress?: (progress: CloudUploadProgress) => void; signal?: AbortSignal } = {}
): Promise<void> {
  const { onProgress, signal } = options;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./upload.worker.ts", import.meta.url), { type: "module" });
    const onAbort = () => worker.postMessage({ type: "abort" });
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.({ loaded: message.loaded, total: message.total, fraction: message.fraction });
      } else if (message.type === "done") {
        cleanup();
        resolve();
      } else if (message.type === "error") {
        cleanup();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Upload worker crashed"));
    };

    worker.postMessage({ type: "upload", uploadUrl, blob, contentType });
  });
}
