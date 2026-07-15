/// <reference lib="webworker" />
/**
 * Direct-to-R2 upload worker. Streams a Blob to a presigned PUT URL entirely off the main thread,
 * reporting byte progress. Used by the opt-in "upload to cloud" path (see cloud-upload.ts):
 * bytes go browser → bucket directly, so the API never buffers the file and the editor UI never
 * janks during a large upload.
 *
 * XHR (not fetch) because it's the only in-worker API that exposes upload progress events.
 */

interface UploadRequest {
  type: "upload";
  uploadUrl: string;
  blob: Blob;
  /** MUST equal the Content-Type the presigned URL was signed with, or R2 rejects the signature. */
  contentType: string;
}
interface AbortRequest {
  type: "abort";
}
type WorkerRequest = UploadRequest | AbortRequest;

let active: XMLHttpRequest | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "abort") {
    active?.abort();
    return;
  }
  if (message.type !== "upload") return;

  const xhr = new XMLHttpRequest();
  active = xhr;
  xhr.open("PUT", message.uploadUrl, true);
  xhr.setRequestHeader("Content-Type", message.contentType);

  xhr.upload.onprogress = (progress) => {
    if (!progress.lengthComputable) return;
    self.postMessage({
      type: "progress",
      loaded: progress.loaded,
      total: progress.total,
      fraction: progress.total ? progress.loaded / progress.total : 0
    });
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      self.postMessage({ type: "done" });
    } else {
      self.postMessage({ type: "error", message: `Upload rejected (HTTP ${xhr.status})` });
    }
    active = null;
  };
  xhr.onerror = () => {
    self.postMessage({ type: "error", message: "Network error during upload" });
    active = null;
  };
  xhr.onabort = () => {
    self.postMessage({ type: "error", message: "Upload aborted" });
    active = null;
  };

  xhr.send(message.blob);
};
