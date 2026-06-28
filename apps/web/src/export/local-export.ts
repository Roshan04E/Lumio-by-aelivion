/**
 * Local export orchestrator (Phase L3, main-thread coordinator).
 *
 * Renders the timeline to an MP4/WebM entirely in the browser. The heavy composite → encode →
 * mux loop runs in a Web Worker ([export.worker.ts]) so the editor stays responsive; this
 * module does the Window-only prep — resolving asset URLs and mixing audio (AudioContext can't
 * run in a Worker) — then hands the Worker plain, transferable data. If the Worker is
 * unavailable or hits a source WebCodecs can't decode, it transparently re-runs the same
 * pipeline on the main thread (where the `<video>`-seek fallback exists).
 */

import { type TimelineComposition } from "@reelforge/shared";
import { detectBrowserToolCapabilities } from "../tools/capabilities";
import { type ExportFormat } from "./video-encoder";
import {
  buildSourceUrlMap,
  runExportCore,
  type ExportCoreInput,
} from "./export-core";
import { collectAudioLayers, extractAudioChannels, mixTimelineAudio } from "./audio-mixer";
import type { ExportWorkerRequest, ExportWorkerResponse } from "./export-worker-protocol";

export interface LocalExportRequest {
  composition: TimelineComposition;
  /** Resolve a timeline asset id to a playable URL (object URL / OPFS-resolved). */
  urlForAsset: (assetId: string) => string | undefined;
  format?: ExportFormat;
  /** Export frame rate (defaults to the composition's fps). */
  fps?: number | undefined;
  onProgress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
}

/** True when this browser can run the local exporter at all. */
export function canExportLocally(): boolean {
  const caps = detectBrowserToolCapabilities();
  return (
    caps.webCodecs &&
    typeof VideoFrame !== "undefined" &&
    typeof AudioData !== "undefined" &&
    typeof OffscreenCanvas !== "undefined"
  );
}

class Aborted extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "Aborted";
  }
}

function canUseWorker(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
}

export async function exportLocally(request: LocalExportRequest): Promise<Blob> {
  const { composition, urlForAsset, format = "mp4", fps, onProgress, signal } = request;
  if (signal?.aborted) throw new Aborted();

  // Resolve sources + mix audio on the main thread (both need Window-only APIs).
  const urlMap = buildSourceUrlMap(composition, urlForAsset);

  onProgress?.(0.02, "Mixing audio…");
  const audioLayers = collectAudioLayers(composition, urlForAsset);
  const mixedBuffer = await mixTimelineAudio(audioLayers, composition.durationSeconds).catch(() => null);
  const audio = mixedBuffer ? extractAudioChannels(mixedBuffer) : null;

  const input: ExportCoreInput = { composition, urlMap, audio, format, fps };

  // Preferred path: render in a Worker (keeps the UI responsive).
  if (canUseWorker()) {
    try {
      return await runInWorker(input, onProgress, signal);
    } catch (error) {
      if (error instanceof Aborted) throw error;
      // Worker failed (e.g. a source WebCodecs can't demux) — fall through to the main thread,
      // which has the <video>-seek fallback. Re-loading sources there is fine; this is rare.
    }
  }

  return runExportCore(input, { onProgress, ...(signal ? { signal } : {}) });
}

/** Drive the export Worker, relaying progress and cancellation. */
function runInWorker(
  input: ExportCoreInput,
  onProgress: LocalExportRequest["onProgress"],
  signal: AbortSignal | undefined
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });

    const onAbort = () => worker.postMessage({ type: "abort" } satisfies ExportWorkerRequest);
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Aborted());
        return;
      }
      signal.addEventListener("abort", onAbort);
    }

    worker.onmessage = (event: MessageEvent<ExportWorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.fraction, message.label);
      } else if (message.type === "done") {
        cleanup();
        resolve(new Blob([message.buffer], { type: message.mime }));
      } else {
        cleanup();
        reject(message.aborted ? new Aborted() : new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Export worker crashed"));
    };

    worker.postMessage({ type: "start", payload: input } satisfies ExportWorkerRequest);
  });
}

/** Save a Blob to disk — File System Access dialog when available, else a download. */
export async function saveExportedFile(blob: Blob, suggestedName: string): Promise<void> {
  const picker = (window as Window & {
    showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }>;
  }).showSaveFilePicker;
  const ext = blob.type === "video/webm" ? "webm" : "mp4";
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: "Video", accept: { [blob.type]: [`.${ext}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return; // user cancelled
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
