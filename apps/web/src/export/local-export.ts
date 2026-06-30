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
import { getExportSingleContext, getExportWorkerScene } from "../color/render-engine";
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

  // Resolve the single-context flag ONCE here (main thread) and thread it through — the Worker can't read the
  // ?exportSingleContext= flag (no window), so resolve once on the main thread and pass it down. Single-context
  // defaults ON. Method 3 Phase 5: SceneFrameCompositor is the only export compositor, so there's no longer a
  // frame/scene mode to resolve.
  const singleContext = getExportSingleContext();
  const input: ExportCoreInput = { composition, urlMap, audio, format, fps, exportSingleContext: singleContext };

  // Phase 2 Stage 4: scene export defaults to the Worker when single-context is on. The one self-contained
  // WebGL2 context survives the Worker's isolated GPU process, whereas the legacy multi-/cross-context path
  // black-framed there (Stage 0). If Worker scene fails or the black-frame guard throws, fall back to the
  // MAIN-THREAD scene path below (NOT to canvas2D — that path was retired in Phase 5).
  const workerScene = singleContext && getExportWorkerScene();
  let workerInput = input;
  if (workerScene) {
    const exportFps = Math.max(1, fps || composition.fps || 30);
    const activeMediaTimes = composition.tracks
      .flatMap((track) => track.layers)
      .filter((layer) => (layer.type === "video" || layer.type === "image") && layer.assetId && layer.durationSeconds > 0)
      .slice(0, 4)
      .map((layer) => Math.min(composition.durationSeconds - 1 / exportFps, layer.startSeconds + Math.min(layer.durationSeconds * 0.5, 0.5)))
      .filter((time) => Number.isFinite(time) && time >= 0);
    workerInput = {
      ...input,
      workerSceneDiagnostics: {
        sampleTimes: activeMediaTimes,
        blackFrameGuard: true,
      },
    };
  }

  // Scene export runs in the Worker by default via the single-context path; if that fails, the proven
  // main-thread scene path below keeps export correct (NOT canvas2D — retired in Phase 5).
  if (canUseWorker() && workerScene) {
    try {
      if (workerScene) {
        logExportGl(() => `worker scene export start: single-context=true, active contexts=${getActiveGlContextCount()}`);
      }
      return await runInWorker(workerInput, onProgress, signal);
    } catch (error) {
      if (error instanceof Aborted) throw error;
      // Worker failed (e.g. a source WebCodecs can't demux, or — for scene — the Worker GPU process choked).
      // Fall through to the main thread, which has the <video>-seek fallback and the (proven) main-thread
      // scene path. Re-loading sources there is fine; this is rare.
      if (workerScene) {
        logExportGl(() => `worker scene export failed, falling back to main-thread scene: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Main-thread export: the editor preview's GPU compositor must yield its WebGL context for the
  // duration (its own SceneFrameCompositor + per-media contexts can evict the preview's context). Pausing
  // the preview's compositing while we run here keeps it off its context during the eviction window, so it
  // doesn't flood the console with "lost WebGL context" uploads, and it repaints once the export releases.
  beginPreviewSuspendForExport();
  logExportGl(() => `main-thread export start: preview suspended=true, mode=scene, active contexts=${getActiveGlContextCount()}`);
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
