/**
 * Local export — environment-agnostic render pipeline.
 *
 * Runs the composite → encode → mux loop with no dependency on the React app or (where the
 * platform allows) the DOM, so the SAME code drives both the export Worker (Phase L3, keeps
 * the UI responsive) and the main-thread fallback. The caller does the DOM/Window-only work
 * up front — resolving asset URLs and mixing audio (AudioContext can't run in a Worker) — and
 * hands this pipeline plain, transferable data.
 */

import {
  expandEffectRegionMasks,
  getCompositionFontsUsed,
  registerLookManifests,
  registerTransitionManifests,
  type PluginLookManifest,
  type PluginTransitionManifest,
  type TimelineComposition,
  type TimelineLayer
} from "@lumio-by-aelivion/shared";
import { MediaEncoder, type ExportFormat } from "./video-encoder";
import { SceneFrameCompositor } from "./scene-frame-compositor";
import { clipSourceKey, createFrameProvider, type FrameProvider } from "./source-decoder";
import { audioConfig, encodeMixedChannels, type MixedAudioChannels } from "./audio-mixer";

type StageProbe = { stage: "decode" | "rtt" | "final" | "draws" | "gl"; timeSeconds: number; meanLuma?: number; layerId?: string; assetId?: string; detail?: string };

/** A resolved visual source: `assetId` (or `matte:<layerId>`) → playable URL + kind. */
export type SourceUrlMap = Record<string, { url: string; kind: "video" | "image" }>;

export interface ExportCoreInput {
  composition: TimelineComposition;
  /** Every visual source the timeline references, pre-resolved to fetchable URLs. */
  urlMap: SourceUrlMap;
  /** Pre-mixed audio PCM (null when the timeline is silent). */
  audio: MixedAudioChannels | null;
  format: ExportFormat;
  /** Imported transition definitions needed for custom transition ids stored in transitionIn.kind. */
  transitionManifests?: PluginTransitionManifest[] | undefined;
  /** Imported creative looks needed for creativeLook effect names stored on clips/adjustment layers. */
  lookManifests?: PluginLookManifest[] | undefined;
  /** Export frame rate. Defaults to the composition's fps; lets the user export at a different rate. */
  fps?: number | undefined;
  /**
   * Vestigial scene-only marker (Method 3 Phase 5). The canvas2D "frame" compositor is retired — export ALWAYS
   * uses `SceneFrameCompositor`. Retained as an accepted no-op so the Worker-scene gate page (and probes) that
   * still pass `exportCompositor: "scene"` keep compiling; the pipeline ignores its value.
   */
  exportCompositor?: "scene" | undefined;
  /**
   * Single-context scene export (Method 3, Phase 2) — RESOLVED on the main thread and passed in, same reason
   * as `exportCompositor`: the Worker has no `window` so it can't read `?exportSingleContext=` itself. When
   * true, `SceneFrameCompositor` grades media + overlays into RTTs on its ONE WebGL2 context — the
   * Worker-portable path. Undefined → the compositor falls back to its own flag read (main-thread only).
   */
  exportSingleContext?: boolean | undefined;
  /**
   * Phase 2 Stage 3.x diagnostics/guard for the experimental Worker scene route only. The main-thread scene
   * path leaves this unset, so default export behavior is unchanged.
   */
  workerSceneDiagnostics?: {
    sampleTimes?: number[] | undefined;
    blackFrameGuard?: boolean | undefined;
    stageProbes?: boolean | undefined;
  } | undefined;
}

/** Minimal abort surface — satisfied by both `AbortSignal` and the Worker's abort flag. */
export interface AbortLike {
  readonly aborted: boolean;
}

export interface ExportCoreHandlers {
  onProgress?: ((fraction: number, label: string) => void) | undefined;
  signal?: AbortLike | undefined;
}

export class Aborted extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "Aborted";
  }
}

/**
 * Per-frame watchdog: a single stalled decode/composite (e.g. a WebCodecs decoder that never
 * outputs near a clip boundary) used to freeze the whole export indefinitely with no way out. Bound
 * each frame so a stall becomes a loud error (→ Worker→main-thread retry, or surfaced to the user)
 * instead of an infinite hang. Generous so a legitimately heavy frame / large seek never trips it.
 */
const FRAME_TIMEOUT_MS = 30_000;
const SOURCE_LOAD_TIMEOUT_MS = 25_000;
const BLACK_LUMA_THRESHOLD = 3;
const BLACK_GUARD_CONSECUTIVE_FRAMES = 2;

function shouldSampleTime(timeSeconds: number, sampleTimes: number[] | undefined, fps: number): boolean {
  if (!sampleTimes?.length) return false;
  const windowSeconds = Math.max(1 / Math.max(1, fps) / 2, 1e-4);
  return sampleTimes.some((sample) => Math.abs(sample - timeSeconds) <= windowSeconds);
}

function meanLumaFromRgba(data: Uint8ClampedArray | Uint8Array, pixels: number): number {
  if (pixels <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  return sum / pixels;
}

function sampleCanvasLuma(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): number {
  const w = Math.max(1, Math.min(64, sourceWidth));
  const h = Math.max(1, Math.round((w * sourceHeight) / Math.max(1, sourceWidth)));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("export diagnostics: 2D sample context unavailable");
  ctx.drawImage(source, 0, 0, w, h);
  return meanLumaFromRgba(ctx.getImageData(0, 0, w, h).data, w * h);
}

function hasActiveMediaAt(composition: TimelineComposition, t: number): boolean {
  return composition.tracks.some((track) =>
    track.layers.some((layer) => {
      if ((layer.type !== "video" && layer.type !== "image") || !layer.assetId) return false;
      return t >= layer.startSeconds && t < layer.startSeconds + layer.durationSeconds;
    })
  );
}

function mediaSourceKey(layer: TimelineLayer): string | null {
  if ((layer.type !== "video" && layer.type !== "image") || !layer.assetId) return null;
  return layer.type === "video" ? clipSourceKey(layer.id, layer.assetId) : layer.assetId;
}

function buildProviderUrlMap(composition: TimelineComposition, urlMap: SourceUrlMap): SourceUrlMap {
  const map: SourceUrlMap = {};
  for (const [key, source] of Object.entries(urlMap)) {
    if (key.startsWith("matte:") || source.kind === "image") map[key] = source;
  }
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if ((layer.type === "video" || layer.type === "image") && layer.assetId) {
        const source = urlMap[layer.assetId];
        const key = mediaSourceKey(layer);
        if (source && key) map[key] = { url: source.url, kind: layer.type };
      }
      if ((layer.type === "video" || layer.type === "image") && layer.matte?.uri) {
        map[`matte:${layer.id}`] = { url: layer.matte.uri, kind: layer.type };
      }
    }
  }
  return map;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Export stalled: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Render `input` to an MP4/WebM Blob. Safe to run on the main thread or in a Worker. */
export async function runExportCore(input: ExportCoreInput, handlers: ExportCoreHandlers = {}): Promise<Blob> {
  if (input.lookManifests?.length) {
    registerLookManifests(input.lookManifests, { override: true });
  }
  if (input.transitionManifests?.length) {
    registerTransitionManifests(input.transitionManifests, { override: true });
  }
  const { composition, urlMap, audio, format } = input;
  const { onProgress, signal } = handlers;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Aborted();
  };

  // Export fps: the user's chosen rate, else the composition's. Not rounded so 23.976/29.97 work; frame count
  // ceils so the full duration is covered. The pipeline is time-based (renderFrame(i/fps)), so a different fps
  // just resamples — audio is mixed against durationSeconds and stays in sync.
  const fps = Math.max(1, input.fps || composition.fps || 30);
  const totalFrames = Math.max(1, Math.ceil(composition.durationSeconds * fps));

  // H.264 (and cleanly VP9) require even dimensions - round down to even and render the compositor at that
  // size so the VideoFrame always matches the encoder config (odd comps otherwise crash the encoder).
  const width = Math.max(2, composition.width - (composition.width % 2));
  const height = Math.max(2, composition.height - (composition.height % 2));
  const renderComposition = expandEffectRegionMasks(
    width === composition.width && height === composition.height ? composition : { ...composition, width, height }
  );
  const providerUrlMap = buildProviderUrlMap(renderComposition, urlMap);

  const trackEndPostroll = (layer: TimelineLayer, track: { layers: TimelineLayer[] }): number => {
    const end = layer.startSeconds + layer.durationSeconds;
    let postroll = 0;
    for (const other of track.layers) {
      if (other.id !== layer.id && other.transitionIn && Math.abs(other.startSeconds - end) < 0.05) {
        // Clamp to the incoming clip's length — matches the clamped transition window (getActiveTransition).
        postroll = Math.max(postroll, Math.min(other.transitionIn.durationSeconds, other.durationSeconds));
      }
    }
    return postroll;
  };

  const activeSourceKeysAt = (t: number): string[] => {
    const keys = new Set<string>();
    for (const track of renderComposition.tracks) {
      for (const layer of track.layers) {
        const key = mediaSourceKey(layer);
        if (!key) continue;
        const postroll = trackEndPostroll(layer, track);
        if (t < layer.startSeconds || t >= layer.startSeconds + layer.durationSeconds + postroll) continue;
        keys.add(key);
        if (layer.matte?.uri) keys.add(`matte:${layer.id}`);
      }
    }
    return [...keys];
  };

  // Preload text fonts so canvas fillText matches the preview. Only possible where the DOM
  // FontFaceSet exists (main thread); the Worker uses the platform's installed fonts.
  const fonts = getCompositionFontsUsed(composition.tracks.flatMap((track) => track.layers));
  if (typeof document !== "undefined" && document.fonts) {
    await Promise.all(fonts.map((family) => document.fonts.load(`900 64px ${family}`).catch(() => undefined)));
    await document.fonts.ready;
  }

  onProgress?.(0, "Loading media…");
  const sources = new Map<string, FrameProvider>();
  const sourceLoads = new Map<string, Promise<void>>();
  const loadSource = async (key: string): Promise<void> => {
    if (sources.has(key)) return;
    const pending = sourceLoads.get(key);
    if (pending) return pending;
    const sourceDef = providerUrlMap[key];
    if (!sourceDef) return;
    const load = (async () => {
      throwIfAborted();
      try {
        sources.set(
          key,
          await withTimeout(
            createFrameProvider(sourceDef.url, sourceDef.kind),
            SOURCE_LOAD_TIMEOUT_MS,
            `loadSource ${key}`
          )
        );
      } catch (error) {
        if (!key.startsWith("matte:")) throw error;
      }
    })().finally(() => sourceLoads.delete(key));
    sourceLoads.set(key, load);
    return load;
  };
  await Promise.all(
    Object.entries(providerUrlMap)
      .filter(([, source]) => source.kind === "image")
      .map(([key]) => loadSource(key))
  );

  // Method 3 Phase 5: SceneFrameCompositor is the ONLY local export compositor. It drives the SAME shared
  // SceneCompositor + buildSceneDraws as the editor preview (preview IS export — so blur/glow/highlight
  // bloom/content-transform all render in export, which the retired canvas2D "frame" path never did). It
  // presents into the OffscreenCanvas the encode loop reads via `addVideoFrame(canvas)`.
  const getSrc = (id: string) => sources.get(id);
  // Single-context resolved by the caller (main thread) — pass it explicitly so the Worker honors it (it can't
  // read the flag). Undefined falls through to the compositor's own flag read (main-thread direct calls).
  const diagnostics = input.workerSceneDiagnostics;
  const emitProbe = (probe: StageProbe) => {
    const luma = probe.meanLuma != null ? ` luma=${probe.meanLuma.toFixed(2)}` : "";
    onProgress?.(
      0.031,
      `[worker-scene-stage] ${probe.stage} t=${probe.timeSeconds.toFixed(3)}${luma}${probe.layerId ? ` layer=${probe.layerId}` : ""}${probe.assetId ? ` asset=${probe.assetId}` : ""}${probe.detail ? ` ${probe.detail}` : ""}`
    );
  };
  const sceneOptions = {
    ...(input.exportSingleContext != null ? { singleContext: input.exportSingleContext } : {}),
    ...(diagnostics?.stageProbes && diagnostics.sampleTimes?.length
      ? {
          stageProbe: {
            sampleTimes: diagnostics.sampleTimes,
            fps,
            onProbe: emitProbe,
          },
        }
      : {}),
  };
  const activeCanvas = new OffscreenCanvas(width, height);
  let consecutiveBlackExpectedMediaFrames = 0;
  // SceneFrameCompositor is the ONLY local export compositor (Phase 5). If it can't construct (e.g. no WebGL2
  // in this Worker), the error propagates: a Worker failure routes local-export.ts to the MAIN-THREAD scene
  // retry; there is no canvas2D fallback (the FrameCompositor path was retired).
  const compositor = new SceneFrameCompositor(renderComposition, activeCanvas, getSrc, sceneOptions);

  // When each MEDIA source is last needed = the latest end (+ transition postroll) of any clip using it.
  // The export reads time monotonically, so once we pass that we can dispose the source — this is what
  // stops a video decoder from pinning its read-ahead VideoFrames (GPU memory) through a long trailing
  // gap (e.g. an audio clip longer than the video). Holding ~32 decoded frames across that empty tail
  // can exhaust GPU memory and stall the encoder — the reported "render stops at frame N" hang.
  const sourceLastNeeded = new Map<string, number>();
  for (const track of renderComposition.tracks) {
    for (const layer of track.layers) {
      const key = mediaSourceKey(layer);
      if (key) {
        const last = layer.startSeconds + layer.durationSeconds + trackEndPostroll(layer, track) + 0.15;
        sourceLastNeeded.set(key, Math.max(sourceLastNeeded.get(key) ?? 0, last));
        if (layer.matte?.uri) {
          const matteKey = `matte:${layer.id}`;
          sourceLastNeeded.set(matteKey, Math.max(sourceLastNeeded.get(matteKey) ?? 0, last));
        }
      }
    }
  }
  const releaseSpentSources = (t: number) => {
    for (const [key, lastNeeded] of sourceLastNeeded) {
      if (t > lastNeeded) {
        sources.get(key)?.dispose();
        sources.delete(key);
        sourceLastNeeded.delete(key);
      }
    }
  };

  const encoder = new MediaEncoder({
    width,
    height,
    fps,
    format,
    audio: audio ? { sampleRate: audioConfig.sampleRate, channels: audio.channels.length } : undefined,
  });

  // Move the modal off "Loading media…" the instant the loop starts, even before frame 0 finishes.
  onProgress?.(0.03, "Rendering frame 1…");

  try {
    for (let i = 0; i < totalFrames; i += 1) {
      throwIfAborted();
      const t = i / fps;
      await Promise.all(activeSourceKeysAt(t).map((key) => loadSource(key)));
      // Phase 5: no canvas2D degrade. A scene render failure (e.g. the Worker's WebGL context lost mid-render
      // under GPU pressure — SceneFrameCompositor throws on isContextLost) propagates out of the loop: in the
      // Worker it routes local-export.ts to the main-thread scene retry; on the main thread it surfaces as a
      // hard export error rather than shipping black or a bloom-less canvas2D fallback.
      await withTimeout(compositor.renderFrame(t), FRAME_TIMEOUT_MS, `renderFrame ${i + 1}/${totalFrames}`);
      if (diagnostics?.stageProbes && diagnostics.sampleTimes?.length && shouldSampleTime(t, diagnostics.sampleTimes, fps)) {
        const meanLuma = sampleCanvasLuma(activeCanvas, width, height);
        emitProbe({ stage: "final", timeSeconds: t, meanLuma });
      }
      if (
        diagnostics?.blackFrameGuard &&
        shouldSampleTime(t, diagnostics.sampleTimes, fps) &&
        hasActiveMediaAt(renderComposition, t)
      ) {
        const meanLuma = sampleCanvasLuma(activeCanvas, width, height);
        if (meanLuma < BLACK_LUMA_THRESHOLD) {
          consecutiveBlackExpectedMediaFrames += 1;
          if (consecutiveBlackExpectedMediaFrames >= BLACK_GUARD_CONSECUTIVE_FRAMES) {
            throw new Error(
              `WORKER_SCENE_BLACK_FRAME_GUARD: final compositor mean luma ${meanLuma.toFixed(2)} below ${BLACK_LUMA_THRESHOLD} for ${consecutiveBlackExpectedMediaFrames} consecutive expected-nonblack media frames at t=${t.toFixed(3)}s`
            );
          }
        } else {
          consecutiveBlackExpectedMediaFrames = 0;
        }
      }
      await withTimeout(encoder.addVideoFrame(activeCanvas, i), FRAME_TIMEOUT_MS, `encodeFrame ${i + 1}/${totalFrames}`);
      releaseSpentSources(t); // free decoders whose clips are now fully behind the playhead
      // Reserve the last ~8% for audio + mux finalize.
      onProgress?.(0.04 + ((i + 1) / totalFrames) * 0.88, `Rendering frame ${i + 1} / ${totalFrames}`);
    }

    if (audio) {
      throwIfAborted();
      onProgress?.(0.93, "Encoding audio…");
      encodeMixedChannels(encoder, audio);
    }

    onProgress?.(0.96, "Finalizing…");
    const blob = await encoder.finalize();
    onProgress?.(1, "Done");
    return blob;
  } finally {
    compositor.dispose();
    for (const source of sources.values()) source.dispose();
  }
}

/** Build the resolved source URL map (visual layers + per-clip luma mattes) for the pipeline. */
export function buildSourceUrlMap(
  composition: TimelineComposition,
  urlForAsset: (assetId: string) => string | undefined
): SourceUrlMap {
  const map: SourceUrlMap = {};
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if ((layer.type === "video" || layer.type === "image") && layer.assetId) {
        const url = urlForAsset(layer.assetId);
        if (url && !map[layer.assetId]) map[layer.assetId] = { url, kind: layer.type };
        if (layer.matte?.uri) map[`matte:${layer.id}`] = { url: layer.matte.uri, kind: layer.type };
      }
    }
  }
  return map;
}
