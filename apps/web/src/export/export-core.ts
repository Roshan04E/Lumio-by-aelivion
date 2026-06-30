/**
 * Local export — environment-agnostic render pipeline.
 *
 * Runs the composite → encode → mux loop with no dependency on the React app or (where the
 * platform allows) the DOM, so the SAME code drives both the export Worker (Phase L3, keeps
 * the UI responsive) and the main-thread fallback. The caller does the DOM/Window-only work
 * up front — resolving asset URLs and mixing audio (AudioContext can't run in a Worker) — and
 * hands this pipeline plain, transferable data.
 */

import { expandEffectRegionMasks, getCompositionFontsUsed, type TimelineComposition, type TimelineLayer } from "@reelforge/shared";
import { MediaEncoder, type ExportFormat } from "./video-encoder";
import { FrameCompositor } from "./frame-compositor";
import { SceneFrameCompositor } from "./scene-frame-compositor";
import { getExportCompositor } from "../color/render-engine";
import { createFrameProvider, type FrameProvider } from "./source-decoder";
import { audioConfig, encodeMixedChannels, type MixedAudioChannels } from "./audio-mixer";

/** The composite contract both export compositors satisfy (canvas2D `FrameCompositor` + GPU `SceneFrameCompositor`). */
interface ExportCompositorLike {
  renderFrame(timeSeconds: number): Promise<void>;
  dispose(): void;
}

/** A resolved visual source: `assetId` (or `matte:<layerId>`) → playable URL + kind. */
export type SourceUrlMap = Record<string, { url: string; kind: "video" | "image" }>;

export interface ExportCoreInput {
  composition: TimelineComposition;
  /** Every visual source the timeline references, pre-resolved to fetchable URLs. */
  urlMap: SourceUrlMap;
  /** Pre-mixed audio PCM (null when the timeline is silent). */
  audio: MixedAudioChannels | null;
  format: ExportFormat;
  /** Export frame rate. Defaults to the composition's fps; lets the user export at a different rate. */
  fps?: number | undefined;
  /**
   * Which composite engine to use — RESOLVED on the main thread and passed in. The export Worker has no
   * `window`, so it can't read the `?exportCompositor=` flag itself (it would always default to "scene"); the
   * caller resolves `getExportCompositor()` once and threads it here so both threads agree.
   */
  exportCompositor?: "scene" | "frame" | undefined;
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
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Export stalled: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Render `input` to an MP4/WebM Blob. Safe to run on the main thread or in a Worker. */
export async function runExportCore(input: ExportCoreInput, handlers: ExportCoreHandlers = {}): Promise<Blob> {
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

  // Preload text fonts so canvas fillText matches the preview. Only possible where the DOM
  // FontFaceSet exists (main thread); the Worker uses the platform's installed fonts.
  const fonts = getCompositionFontsUsed(composition.tracks.flatMap((track) => track.layers));
  if (typeof document !== "undefined" && document.fonts) {
    await Promise.all(fonts.map((family) => document.fonts.load(`900 64px ${family}`).catch(() => undefined)));
    await document.fonts.ready;
  }

  // Load every visual source in parallel (P4 — was sequential). A failed non-matte source is
  // fatal (we can't render that clip); a failed matte just drops that clip's mask.
  onProgress?.(0, "Loading media…");
  const sources = new Map<string, FrameProvider>();
  await Promise.all(
    Object.entries(urlMap).map(async ([key, { url, kind }]) => {
      throwIfAborted();
      try {
        // Bound the whole per-source load: an un-timed fetch / decode-init that never settles used to
        // hang the export at "Loading media…" forever. On timeout this names the exact stalled asset.
        sources.set(key, await withTimeout(createFrameProvider(url, kind), SOURCE_LOAD_TIMEOUT_MS, `loadSource ${key}`));
      } catch (error) {
        if (!key.startsWith("matte:")) throw error;
      }
    })
  );

  // H.264 (and cleanly VP9) require even dimensions — round down to even and render the compositor at that
  // size so the VideoFrame always matches the encoder config (odd comps otherwise crash the encoder).
  const width = Math.max(2, composition.width - (composition.width % 2));
  const height = Math.max(2, composition.height - (composition.height % 2));
  // Even dims for the encoder + expand color/glow region masks into base/duplicate layers so the canvas
  // compositor renders them via its existing per-layer grade + clip-mask matte (region effects in export).
  const renderComposition = expandEffectRegionMasks(
    width === composition.width && height === composition.height ? composition : { ...composition, width, height }
  );

  // Method 3 Phase 5: flag-select the composite engine. "scene" (default) drives the SAME shared
  // SceneCompositor + buildSceneDraws as the editor preview (preview IS export — so blur/glow/highlight
  // bloom/content-transform all render in export, which the canvas2D "frame" path never did). "frame" is
  // the proven canvas2D fallback, still reachable via ?exportCompositor=frame. Both present into a canvas,
  // so the encode loop is identical — `addVideoFrame(canvas)` reads a 2D or WebGL surface transparently.
  // A WebGL canvas can't be re-acquired as 2D, so the fallback below allocates a fresh canvas.
  const getSrc = (id: string) => sources.get(id);
  // Mode is resolved by the caller (main thread) and passed in — the Worker can't read the flag itself.
  // Fall back to getExportCompositor() only when not provided (e.g. a direct call without the field).
  let usingScene = (input.exportCompositor ?? getExportCompositor()) === "scene";
  let activeCanvas = new OffscreenCanvas(width, height);
  let compositor: ExportCompositorLike;
  try {
    compositor = usingScene
      ? new SceneFrameCompositor(renderComposition, activeCanvas, getSrc)
      : new FrameCompositor(renderComposition, activeCanvas, getSrc);
  } catch (constructError) {
    if (!usingScene) throw constructError;
    // Scene compositor failed to construct (e.g. WebGL2 unavailable in this Worker) — degrade to canvas2D.
    console.warn("[export] scene compositor construction failed, using frame compositor:", constructError);
    usingScene = false;
    activeCanvas = new OffscreenCanvas(width, height);
    compositor = new FrameCompositor(renderComposition, activeCanvas, getSrc);
  }

  // When each MEDIA source is last needed = the latest end (+ transition postroll) of any clip using it.
  // The export reads time monotonically, so once we pass that we can dispose the source — this is what
  // stops a video decoder from pinning its read-ahead VideoFrames (GPU memory) through a long trailing
  // gap (e.g. an audio clip longer than the video). Holding ~32 decoded frames across that empty tail
  // can exhaust GPU memory and stall the encoder — the reported "render stops at frame N" hang.
  const sourceLastNeeded = new Map<string, number>();
  const trackEndPostroll = (layer: TimelineLayer, track: { layers: TimelineLayer[] }): number => {
    const end = layer.startSeconds + layer.durationSeconds;
    let postroll = 0;
    for (const other of track.layers) {
      if (other.id !== layer.id && other.transitionIn && Math.abs(other.startSeconds - end) < 0.05) {
        postroll = Math.max(postroll, other.transitionIn.durationSeconds);
      }
    }
    return postroll;
  };
  for (const track of renderComposition.tracks) {
    for (const layer of track.layers) {
      if ((layer.type === "video" || layer.type === "image") && layer.assetId) {
        const last = layer.startSeconds + layer.durationSeconds + trackEndPostroll(layer, track) + 0.15;
        sourceLastNeeded.set(layer.assetId, Math.max(sourceLastNeeded.get(layer.assetId) ?? 0, last));
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
      try {
        await withTimeout(compositor.renderFrame(t), FRAME_TIMEOUT_MS, `renderFrame ${i + 1}/${totalFrames}`);
      } catch (renderError) {
        if (signal?.aborted) throw renderError;
        // Scene export failed (e.g. the Worker's WebGL context was lost mid-render under GPU pressure — the
        // scene compositor throws on isContextLost). Degrade to the canvas2D FrameCompositor for the REST of
        // the export instead of shipping black frames. Fires at ANY frame: already-encoded scene frames keep
        // their bloom; the tail switches to the (bloom-less but correct) frame path — never black.
        if (!usingScene) throw renderError;
        console.warn(`[export] scene compositor failed on frame ${i}, falling back to frame compositor:`, renderError);
        try {
          compositor.dispose();
        } catch {
          /* already disposed */
        }
        usingScene = false;
        activeCanvas = new OffscreenCanvas(width, height); // a WebGL canvas can't be re-acquired as 2D
        compositor = new FrameCompositor(renderComposition, activeCanvas, getSrc);
        await withTimeout(compositor.renderFrame(t), FRAME_TIMEOUT_MS, `renderFrame ${i + 1}/${totalFrames}`);
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
