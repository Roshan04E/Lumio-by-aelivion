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

import { clipCompositionToWorkArea, expandNestedCompositions, type FlarexComp, type PluginLookManifest, type PluginTransitionManifest, type TimelineComposition } from "@orreris/shared";
import { detectBrowserToolCapabilities } from "../tools/capabilities";
import { type ExportFormat } from "./video-encoder";
import {
  buildSourceUrlMap,
  runExportCore,
  type ExportCoreInput,
  type FlarexSourceAssetMap,
  type SourceUrlMap,
} from "./export-core";
import { collectAudioLayers, extractAudioChannels, mixTimelineAudio } from "./audio-mixer";
import { getExportSingleContext, getExportWorkerScene } from "../color/render-engine";
import { beginPreviewSuspendForExport, endPreviewSuspendForExport } from "./export-preview-suspend";
import { logExportGl } from "./export-gl-debug";
import { getActiveGlContextCount } from "@orreris/shared";
import type { ExportWorkerRequest, ExportWorkerResponse } from "./export-worker-protocol";

export interface LocalExportRequest {
  composition: TimelineComposition;
  /** Auxiliary compositions (`ProjectGraph.compositions`) — nested sequences (NESTING.md Phase C).
   *  Undefined = no nesting support for this export. */
  compositions?: Record<string, TimelineComposition> | undefined;
  /** Flarex node comps (`ProjectGraph.flarexComps`, FLAREX.md). Undefined = comp'd clips render plain. */
  flarexComps?: Record<string, FlarexComp> | undefined;
  /**
   * Media kind + duration for every asset a Flarex asset-source `MediaIn` loads (`sourceAssetId`).
   * REQUIRED for those sources to appear in the export: they are off-timeline (the comp loads them
   * itself), so `buildSourceUrlMap` cannot discover them by walking tracks and they get no decoder —
   * the compiler then soft-degrades every one of them to the HOST clip, which is exactly what the
   * rendered file showed on 2026-07-27. Undefined = asset-source MediaIns render as the host clip.
   */
  flarexSourceAssets?: FlarexSourceAssetMap | undefined;
  /** Resolve a timeline asset id to a playable URL (object URL / OPFS-resolved). */
  urlForAsset: (assetId: string) => string | undefined;
  format?: ExportFormat;
  /** Export frame rate (defaults to the composition's fps). */
  fps?: number | undefined;
  /** Target video bitrate (bits/s) from the export window. Undefined → resolution-derived default. */
  videoBitrate?: number | undefined;
  /** Encoder rate-control mode from the export window. Undefined → default (VBR). */
  bitrateMode?: "vbr" | "cbr" | undefined;
  /** Encode-output width/height (a resolution downscale). Undefined → composition size. */
  outputWidth?: number | undefined;
  outputHeight?: number | undefined;
  transitionManifests?: PluginTransitionManifest[] | undefined;
  lookManifests?: PluginLookManifest[] | undefined;
  preferWorker?: boolean | undefined;
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

function yieldToBrowser(): Promise<void> {
  if (typeof requestAnimationFrame !== "undefined") {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return Promise.resolve();
}

export async function exportLocally(request: LocalExportRequest): Promise<Blob> {
  const { urlForAsset, format = "mp4", fps, onProgress, signal } = request;
  if (signal?.aborted) throw new Aborted();

  // Honor Premiere-style in/out points (work area): clip the composition to the range and shift it so
  // the in-point becomes t=0 — same as the cloud render path (buildRenderManifest). Applied BEFORE
  // audio mixing + source resolution so audio, video, and durationSeconds all share the clipped timeline.
  // Identity (same reference) when no in/out point is set, so a full-project export is unaffected.
  onProgress?.(0.005, "Clipping work area...");
  await yieldToBrowser();
  const composition = clipCompositionToWorkArea(request.composition);

  // Resolve sources + mix audio on the main thread (both need Window-only APIs).
  onProgress?.(0.01, "Resolving sources...");
  await yieldToBrowser();
  // NESTED children (NESTING.md Phase C) must be visible to BOTH URL resolution and audio collection below
  // — neither `buildSourceUrlMap` nor `collectAudioLayers` recurses into `nestedCompositionId` clips on its
  // own, so an asset/audio-clip used ONLY inside a nested sequence would otherwise silently drop out of the
  // export. export-core.ts repeats this same expansion internally for the actual video render (it's also
  // called directly by fixtures/tests, so it can't rely on this call site having already done it) —
  // expandNestedCompositions is cheap/pure, so doing it twice per export is an acceptable cost for keeping
  // buildSourceUrlMap/collectAudioLayers's own signatures untouched.
  const expandedForSourceResolution = expandNestedCompositions(composition, request.compositions).composition;
  // Flarex asset-source assets are passed EXPLICITLY: they are off-timeline, so no amount of walking
  // `expandedForSourceResolution` can find them (see LocalExportRequest.flarexSourceAssets).
  const urlMap = buildSourceUrlMap(expandedForSourceResolution, urlForAsset, request.flarexSourceAssets);
  // Vector-graphic layers resolve to inline SVG data URLs, but the export decoder runs in a Worker
  // where createImageBitmap can't rasterize SVG (no layout engine) — pre-rasterize to PNG here on the
  // main thread (Window APIs available) so the Worker path decodes a plain bitmap instead of failing
  // and forcing a full main-thread re-export. Same 1024px baked raster the preview uses, so recolors
  // stay pixel-aligned.
  await rasterizeSvgSources(urlMap);

  onProgress?.(0.02, "Mixing audio…");
  await yieldToBrowser();
  const audioLayers = collectAudioLayers(expandedForSourceResolution, urlForAsset);
  // DEBT-015: mixTimelineAudio's OWN contract legitimately resolves null when there is nothing
  // audible to mix (no audio layers, all muted, or zero duration) — that case must ship silent,
  // same as today. A throw and a stalled race are both real failures and must not collapse into
  // that same null, so the timeout resolves a private sentinel instead of null — a sentinel is the
  // only way to tell "the timeline has no audio" apart from "the mixdown never finished".
  const AUDIO_MIXDOWN_TIMED_OUT = Symbol("audio-mixdown-timed-out");
  let mixResult: Awaited<ReturnType<typeof mixTimelineAudio>> | typeof AUDIO_MIXDOWN_TIMED_OUT;
  try {
    mixResult = await Promise.race([
      mixTimelineAudio(audioLayers, composition.durationSeconds),
      new Promise<typeof AUDIO_MIXDOWN_TIMED_OUT>((resolve) => setTimeout(() => resolve(AUDIO_MIXDOWN_TIMED_OUT), 20_000))
    ]);
  } catch (error) {
    throw new Error(
      `Export: audio mixdown failed — ${error instanceof Error ? error.message : String(error)} — refusing to ship a silently muted export (DEBT-015).`
    );
  }
  if (mixResult === AUDIO_MIXDOWN_TIMED_OUT) {
    throw new Error(
      `Export: audio mixdown did not finish within 20s (${audioLayers.length} layer(s), ${composition.durationSeconds.toFixed(1)}s timeline) — refusing to ship a silently muted export (DEBT-015).`
    );
  }
  const audio = mixResult ? extractAudioChannels(mixResult) : null;

  // Resolve the single-context flag ONCE here (main thread) and thread it through — the Worker can't read the
  // ?exportSingleContext= flag (no window), so resolve once on the main thread and pass it down. Single-context
  // defaults ON. Method 3 Phase 5: SceneFrameCompositor is the only export compositor, so there's no longer a
  // frame/scene mode to resolve.
  const singleContext = getExportSingleContext();
  const input: ExportCoreInput = {
    composition,
    compositions: request.compositions,
    flarexComps: request.flarexComps,
    flarexSourceAssets: request.flarexSourceAssets,
    urlMap,
    audio,
    format,
    fps,
    videoBitrate: request.videoBitrate,
    bitrateMode: request.bitrateMode,
    outputWidth: request.outputWidth,
    outputHeight: request.outputHeight,
    exportSingleContext: singleContext,
    transitionManifests: request.transitionManifests,
    lookManifests: request.lookManifests
  };

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
  if (request.preferWorker !== false && canUseWorker() && workerScene) {
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

/** Replace any inline SVG image sources in `urlMap` with rasterized PNG data URLs (main thread). SVG
 *  can't be decoded via `createImageBitmap` in the export Worker, so leaving it here fixes the
 *  "Failed to load image source for export" on graphic layers. Failures fall through unchanged —
 *  `createImageSource`'s `<img>` path still handles SVG on any main-thread export. */
async function rasterizeSvgSources(urlMap: SourceUrlMap): Promise<void> {
  const toPng = async (url: string) => (/^data:image\/svg/i.test(url) ? await rasterizeSvgToPng(url) : url);
  await Promise.all(
    Object.entries(urlMap).map(async ([key, source]) => {
      if (source.kind !== "image") return;
      try {
        // Animated graphics: every deep-linked cycle frame must be rasterized too — the Worker's
        // decoder can't rasterize any of them as SVG.
        const animation = source.animation
          ? { ...source.animation, frameUrls: await Promise.all(source.animation.frameUrls.map(toPng)) }
          : undefined;
        urlMap[key] = { ...source, url: await toPng(source.url), animation };
      } catch {
        // Keep the SVG URLs; the main-thread <img> decode path is the fallback.
      }
    })
  );
}

async function rasterizeSvgToPng(url: string): Promise<string> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const width = img.naturalWidth || 1024;
  const height = img.naturalHeight || 1024;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return url;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/png");
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
