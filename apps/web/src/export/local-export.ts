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

import { clipCompositionToWorkArea, type TimelineComposition } from "@reelforge/shared";
import { detectBrowserToolCapabilities } from "../tools/capabilities";
import { type ExportFormat } from "./video-encoder";
import {
  buildSourceUrlMap,
  runExportCore,
  type ExportCoreInput,
} from "./export-core";
import { collectAudioLayers, extractAudioChannels, mixTimelineAudio } from "./audio-mixer";
import { getExportCompositor } from "../color/render-engine";
import { beginPreviewSuspendForExport, endPreviewSuspendForExport } from "./export-preview-suspend";
import { logExportGl } from "./export-gl-debug";
import { getActiveGlContextCount } from "@reelforge/shared";
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
  const { urlForAsset, format = "mp4", fps, onProgress, signal } = request;
  if (signal?.aborted) throw new Aborted();

  // Honor Premiere-style in/out points (work area): clip the composition to the range and shift it so
  // the in-point becomes t=0 — same as the cloud render path (buildRenderManifest). Applied BEFORE
  // audio mixing + source resolution so audio, video, and durationSeconds all share the clipped timeline.
  // Identity (same reference) when no in/out point is set, so a full-project export is unaffected.
  const composition = clipCompositionToWorkArea(request.composition);

  // Resolve sources + mix audio on the main thread (both need Window-only APIs).
  const urlMap = buildSourceUrlMap(composition, urlForAsset);

  onProgress?.(0.02, "Mixing audio…");
  const audioLayers = collectAudioLayers(composition, urlForAsset);
  const mixedBuffer = await mixTimelineAudio(audioLayers, composition.durationSeconds).catch(() => null);
  const audio = mixedBuffer ? extractAudioChannels(mixedBuffer) : null;

  // Resolve the composite engine ONCE here (main thread) and thread it through — the Worker can't read the
  // ?exportCompositor= flag (no window) and would otherwise always default to "scene".
  const mode = getExportCompositor();
  const input: ExportCoreInput = { composition, urlMap, audio, format, fps, exportCompositor: mode };

  // The GPU scene compositor's multi-/cross-context WebGL is reliable on the MAIN thread (the editor preview
  // uses the same SceneCompositor) but loses its context in the export Worker's isolated GPU process → black
  // frames. So scene-mode exports run on the main thread (slightly sluggish UI, but correct + with bloom); the
  // canvas2D "frame" path stays in the Worker (non-blocking). Worker hardening to return scene there is Phase 2.
  if (canUseWorker() && mode !== "scene") {
    try {
      return await runInWorker(input, onProgress, signal);
    } catch (error) {
      if (error instanceof Aborted) throw error;
      // Worker failed (e.g. a source WebCodecs can't demux) — fall through to the main thread,
      // which has the <video>-seek fallback. Re-loading sources there is fine; this is rare.
    }
  }

  // Main-thread export: the editor preview's GPU compositor must yield its WebGL context for the
  // duration (its own SceneFrameCompositor + per-media contexts can evict the preview's context). Pausing
  // the preview's compositing while we run here keeps it off its context during the eviction window, so it
  // doesn't flood the console with "lost WebGL context" uploads, and it repaints once the export releases.
  beginPreviewSuspendForExport();
  logExportGl(() => `main-thread export start: preview suspended=true, mode=${mode}, active contexts=${getActiveGlContextCount()}`);
  try {
    return await runExportCore(input, { onProgress, ...(signal ? { signal } : {}) });
  } finally {
    endPreviewSuspendForExport();
    logExportGl(() => `main-thread export end: preview suspended=false, active contexts=${getActiveGlContextCount()}`);
  }
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
