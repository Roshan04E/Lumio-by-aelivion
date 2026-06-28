/**
 * Local export — environment-agnostic render pipeline.
 *
 * Runs the composite → encode → mux loop with no dependency on the React app or (where the
 * platform allows) the DOM, so the SAME code drives both the export Worker (Phase L3, keeps
 * the UI responsive) and the main-thread fallback. The caller does the DOM/Window-only work
 * up front — resolving asset URLs and mixing audio (AudioContext can't run in a Worker) — and
 * hands this pipeline plain, transferable data.
 */

import { expandEffectRegionMasks, getCompositionFontsUsed, type TimelineComposition } from "@reelforge/shared";
import { MediaEncoder, type ExportFormat } from "./video-encoder";
import { FrameCompositor } from "./frame-compositor";
import { createFrameProvider, type FrameProvider } from "./source-decoder";
import { audioConfig, encodeMixedChannels, type MixedAudioChannels } from "./audio-mixer";

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
        sources.set(key, await createFrameProvider(url, kind));
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

  const compositorCanvas = new OffscreenCanvas(width, height);
  const compositor = new FrameCompositor(renderComposition, compositorCanvas, (id) => sources.get(id));

  const encoder = new MediaEncoder({
    width,
    height,
    fps,
    format,
    audio: audio ? { sampleRate: audioConfig.sampleRate, channels: audio.channels.length } : undefined,
  });

  try {
    for (let i = 0; i < totalFrames; i += 1) {
      throwIfAborted();
      await compositor.renderFrame(i / fps);
      await encoder.addVideoFrame(compositorCanvas, i);
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
