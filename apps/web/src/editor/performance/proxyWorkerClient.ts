/**
 * Background proxy generation — worker-only, playhead-independent.
 *
 * A preview proxy for a span is just a low-cost, span-scoped export: clip the composition to the span's
 * [start,end] work area, then render it to a compressed webm through the SAME export Worker
 * ([export.worker.ts]) the local exporter uses. Running in the Worker means:
 *   - zero main-thread / playback load (the editor stays responsive),
 *   - the Worker's single self-contained WebGL2 context is used — NOT a new preview context, and
 *   - it never touches the visible preview compositor (unlike the exporter's main-thread fallback, which
 *     suspends the preview — we deliberately do NOT fall back here; a failed span just stays pending).
 *
 * The output is byte-aligned with the real export by construction (same SceneFrameCompositor + builder),
 * so a proxy is a faithful low-bitrate stand-in for live preview.
 */

import { clipCompositionToWorkArea, isGlBudgetOverTarget, isGlGovernorEnabled, type PluginLookManifest, type PluginTransitionManifest, type TimelineComposition } from "@kimera-by-aelivion/shared";
import { Aborted, buildSourceUrlMap, runExportCore, type ExportCoreInput } from "../../export/export-core";
import type { ExportWorkerRequest, ExportWorkerResponse } from "../../export/export-worker-protocol";

/** Proxies are visual-only and bitrate-capped, so full resolution is fine and stays pixel-aligned. */
export interface GenerateSpanProxyInput {
  composition: TimelineComposition;
  spanStartSeconds: number;
  spanEndSeconds: number;
  fps: number;
  urlForAsset: (assetId: string) => string | undefined;
  transitionManifests?: PluginTransitionManifest[] | undefined;
  lookManifests?: PluginLookManifest[] | undefined;
  signal: AbortSignal;
  onProgress?: ((fraction: number) => void) | undefined;
  onDiagnostic?: ((event: ProxyGenerationDiagnostic) => void) | undefined;
}

export class ProxyGenerationAborted extends Error {
  constructor() {
    super("proxy generation aborted");
    this.name = "ProxyGenerationAborted";
  }
}

export interface ProxyGenerationDiagnostic {
  stage:
    | "viewer-start"
    | "viewer-ready"
    | "viewer-failed"
    | "worker-start"
    | "worker-ready"
    | "worker-failed"
    | "fallback-start"
    | "fallback-ready"
    | "fallback-failed"
    | "parity-ok"
    | "parity-failed"
    | "verify-ok"
    | "verify-failed";
  spanStartSeconds: number;
  spanEndSeconds: number;
  message?: string | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build a composition clipped to exactly the span's work area (in-point shifted to t=0). */
function spanComposition(composition: TimelineComposition, startSeconds: number, endSeconds: number): TimelineComposition {
  const settings = composition.settings;
  if (!settings?.timeline) {
    // No work-area metadata to drive the clip; render the composition as-is.
    return clipCompositionToWorkArea(composition);
  }
  return clipCompositionToWorkArea({
    ...composition,
    settings: {
      ...settings,
      timeline: {
        ...settings.timeline,
        inPointSeconds: startSeconds,
        outPointSeconds: endSeconds
      }
    }
  });
}

/**
 * Render one span to a webm Blob. Prefer the export Worker; if the Worker cannot decode the user's source
 * (common when WebCodecs/mp4box cannot handle a browser-playable file), fall back to the same export core on
 * the main thread while the editor is idle. The fallback can use the browser's native <video> decoder, so a
 * playable preview source can still become a real proxy instead of painting every span failed.
 */
export async function generateSpanProxy(input: GenerateSpanProxyInput): Promise<Blob> {
  const { composition, spanStartSeconds, spanEndSeconds, fps, urlForAsset, transitionManifests, lookManifests, signal, onProgress, onDiagnostic } = input;
  if (signal.aborted) {
    throw new ProxyGenerationAborted();
  }

  const clipped = spanComposition(composition, spanStartSeconds, spanEndSeconds);
  const urlMap = buildSourceUrlMap(clipped, urlForAsset);
  // Sample a handful of frames across the (clipped, in-point→0) span for the black-frame guard: a WebCodecs
  // decode that silently emits BLACK (no error) would otherwise seal a black "ready" proxy that plays instead
  // of the correct live picture. The guard trips only when media is expected AND the composite is near-black,
  // so ordinary (even dark) footage is unaffected; when it trips we FAIL the span so playback uses the live
  // compositor. Spread across the span so a clip that blacks partway through is still caught.
  const spanDurationSeconds = Math.max(1 / Math.max(1, fps), clipped.durationSeconds);
  const sampleCount = Math.min(6, Math.max(2, Math.round(spanDurationSeconds)));
  const sampleTimes = Array.from({ length: sampleCount }, (_, index) => (spanDurationSeconds * (index + 0.5)) / sampleCount);
  const coreInput: ExportCoreInput = {
    composition: clipped,
    urlMap,
    audio: null, // visual proxy only
    format: "webm",
    fps,
    transitionManifests,
    lookManifests,
    exportSingleContext: true,
    workerSceneDiagnostics: { blackFrameGuard: true, sampleTimes }
  };

  try {
    onDiagnostic?.({ stage: "worker-start", spanStartSeconds, spanEndSeconds });
    const blob = await runProxyWorker(coreInput, signal, onProgress);
    onDiagnostic?.({ stage: "worker-ready", spanStartSeconds, spanEndSeconds });
    return blob;
  } catch (error) {
    if (signal.aborted || error instanceof ProxyGenerationAborted) {
      throw new ProxyGenerationAborted();
    }
    const workerMessage = errorMessage(error);
    onDiagnostic?.({ stage: "worker-failed", spanStartSeconds, spanEndSeconds, message: workerMessage });
    // A black composite is a deterministic decode failure, not a transient worker glitch: the main-thread
    // fallback re-decodes the same source through the same WebCodecs path and blacks again. Don't seal or
    // retry it — fail the span so playback falls back to the correct live compositor. (Real faithful proxy
    // for these clips is Phase 6B/M3: decode via the viewer's <video> path.)
    if (workerMessage.includes("WORKER_SCENE_BLACK_FRAME_GUARD")) {
      throw new Error(`proxy produced black frames: ${workerMessage}`);
    }
    // The Worker path uses its own isolated context, but this main-thread fallback creates a SceneFrameCompositor
    // context ON the main thread — stacking on the paused preview's live contexts. When the governor is enabled
    // and we're already at/over the soft target, DEFER rather than push toward the browser cap: abort leaves the
    // span pending (the caller's loop `break`s without marking it failed) so it retries once the budget frees.
    if (isGlGovernorEnabled() && isGlBudgetOverTarget()) {
      onDiagnostic?.({ stage: "fallback-failed", spanStartSeconds, spanEndSeconds, message: "deferred: preview context budget over target" });
      throw new ProxyGenerationAborted();
    }
    try {
      onDiagnostic?.({ stage: "fallback-start", spanStartSeconds, spanEndSeconds, message: workerMessage });
      const blob = await runExportCore(coreInput, {
        signal,
        onProgress: onProgress ? (fraction) => onProgress(fraction) : undefined
      });
      onDiagnostic?.({ stage: "fallback-ready", spanStartSeconds, spanEndSeconds });
      return blob;
    } catch (fallbackError) {
      if (signal.aborted || fallbackError instanceof Aborted) {
        throw new ProxyGenerationAborted();
      }
      const fallbackMessage = errorMessage(fallbackError);
      onDiagnostic?.({ stage: "fallback-failed", spanStartSeconds, spanEndSeconds, message: fallbackMessage });
      throw new Error(`proxy worker failed: ${workerMessage}; main-thread fallback failed: ${fallbackMessage}`);
    }
  }
}

function runProxyWorker(
  coreInput: ExportCoreInput,
  signal: AbortSignal,
  onProgress?: ((fraction: number) => void) | undefined
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL("../../export/export.worker.ts", import.meta.url), { type: "module" });
    const onAbort = () => worker.postMessage({ type: "abort" } satisfies ExportWorkerRequest);
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
    };

    if (signal.aborted) {
      cleanup();
      reject(new ProxyGenerationAborted());
      return;
    }
    signal.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<ExportWorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.fraction);
      } else if (message.type === "done") {
        cleanup();
        resolve(new Blob([message.buffer], { type: message.mime || "video/webm" }));
      } else {
        cleanup();
        reject(message.aborted ? new ProxyGenerationAborted() : new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "proxy worker crashed"));
    };

    worker.postMessage({ type: "start", payload: coreInput } satisfies ExportWorkerRequest);
  });
}
