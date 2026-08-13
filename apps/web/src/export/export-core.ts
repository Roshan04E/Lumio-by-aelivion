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
  expandFrameBorders,
  expandNestedCompositions,
  getCompositionFontsUsed,
  collectPinnedFontRefs,
  fontRefCss,
  FontResolutionError,
  graphicAnimationBakeTime,
  graphicToAnimatedDataUrl,
  graphicToDataUrl,
  resolveGraphicAnimation,
  normalizeProjectColorSettings,
  type GraphicAnimationPlan,
  registerLookManifests,
  registerTransitionManifests,
  type PluginLookManifest,
  type PluginTransitionManifest,
  collectFlarexVirtualLayers,
  type FlarexComp,
  type TimelineComposition,
  type TimelineLayer
} from "@orreris/shared";
import { EncoderStallRecoveredError, MediaEncoder, REC709_SDR_LIMITED, type ExportFormat } from "./video-encoder";
import { installPinnedFont } from "../lib/font-install";
import { getRegionPassesEnabled } from "../color/render-engine";
import { SceneFrameCompositor } from "./scene-frame-compositor";
import { clipSourceKey, createAnimatedGraphicSource, createFrameProvider, graphicSourceKey, type FrameProvider } from "./source-decoder";
import { audioConfig, encodeMixedChannels, type MixedAudioChannels } from "./audio-mixer";

type StageProbe = { stage: "decode" | "rtt" | "final" | "draws" | "gl"; timeSeconds: number; meanLuma?: number; layerId?: string; assetId?: string; detail?: string };

/** A resolved visual source: `assetId` (or `matte:<layerId>`) → playable URL + kind. */
export type SourceUrlMap = Record<
  string,
  {
    url: string;
    kind: "video" | "image";
    /**
     * ANIMATED vector graphic (`graphic:<layerId>` keys only): the resolved playback plan plus one
     * deep-linked frame URL per frame index. `buildSourceUrlMap` emits SVG data URLs; `local-export`
     * rasterizes them to PNG on the main thread so the DOM-less Worker can decode them. Present ⇒ the
     * source loads as an animated provider whose frames advance with CLIP-LOCAL time.
     */
    animation?: { frameUrls: string[]; plan: GraphicAnimationPlan } | undefined;
  }
>;

export interface ExportCoreInput {
  composition: TimelineComposition;
  /**
   * Auxiliary compositions (`ProjectGraph.compositions`) — nested sequences referenced by
   * `TimelineLayer.nestedCompositionId` clips (NESTING.md Phase C, imported prproj nests today). Undefined
   * = no nesting support for this export (any `nestedCompositionId` clip renders as an empty media layer,
   * same as a missing/cyclic reference — see `expandNestedCompositions`). Plain JSON — safe across the
   * Worker postMessage boundary.
   */
  compositions?: Record<string, TimelineComposition> | undefined;
  /** Flarex node comps (`ProjectGraph.flarexComps`, FLAREX.md) — clips with `flarexCompId` lower
   *  through the shared compiler in buildSceneDraws. Undefined = comp'd clips render plain. */
  flarexComps?: Record<string, FlarexComp> | undefined;
  /**
   * Media kind + duration for every asset a Flarex asset-source `MediaIn` loads. These assets are NOT on
   * the timeline (the Fusion Loader model — the comp loads them itself), so nothing derived from
   * `composition.tracks` can supply them. Without this the loaders get no decoder and every asset-source
   * MediaIn falls back to the host clip in the rendered file (user report 2026-07-27).
   */
  flarexSourceAssets?: FlarexSourceAssetMap | undefined;
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
  /** Target video bitrate (bits/s) from the export window. Undefined → resolution-derived default. */
  videoBitrate?: number | undefined;
  /** Encoder rate-control mode from the export window. Undefined → the encoder's default (VBR). */
  bitrateMode?: "vbr" | "cbr" | undefined;
  /** Encode-output width/height (a resolution downscale). Undefined → composition size (no scaling). */
  outputWidth?: number | undefined;
  outputHeight?: number | undefined;
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
      if ((layer.type !== "video" && layer.type !== "image") || (!layer.assetId && !layer.graphic)) return false;
      return t >= layer.startSeconds && t < layer.startSeconds + layer.durationSeconds;
    })
  );
}

function mediaSourceKey(layer: TimelineLayer): string | null {
  if (layer.type === "image" && layer.graphic) return graphicSourceKey(layer.id);
  if ((layer.type !== "video" && layer.type !== "image") || !layer.assetId) return null;
  return layer.type === "video" ? clipSourceKey(layer.id, layer.assetId) : layer.assetId;
}

function buildProviderUrlMap(
  composition: TimelineComposition,
  urlMap: SourceUrlMap,
  /** Flarex asset-source loaders. They are OFF-TIMELINE, so the track walk below cannot reach them and
   *  they would get no decoder at all — the export-renders-the-host-clip bug. */
  flarexVirtualLayers: readonly TimelineLayer[] = []
): SourceUrlMap {
  const map: SourceUrlMap = {};
  for (const [key, source] of Object.entries(urlMap)) {
    if (key.startsWith("matte:") || source.kind === "image") map[key] = source;
  }
  for (const virtual of flarexVirtualLayers) {
    if (!virtual.assetId) continue;
    const source = urlMap[virtual.assetId];
    const key = mediaSourceKey(virtual);
    if (source && key) map[key] = { url: source.url, kind: virtual.type as "video" | "image" };
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
  // Nested sequences (NESTING.md Phase C) expand FIRST — same order as the web preview (VideoPreview.tsx)
  // and the render manifest (timeline.ts): nest-expand, THEN region-mask expand. Getting this order (or the
  // even-dimension adjustment's placement) wrong would make export composite a DIFFERENT layer set than the
  // preview — the repo's #1 parity bug class. `expandNestedCompositions` returns the SAME `composition`
  // reference when there's nothing to expand, so a non-nested export is byte-identical to before.
  const nestExpansion = expandNestedCompositions(composition, input.compositions);
  // Frame borders expand between nest and region expansion (Step E) — same order as the web preview and
  // the render manifest. Runs AFTER the even-dimension adjustment so the border geometry (comp-px stroke,
  // box %) derives from the composition actually being rendered.
  const renderComposition = expandEffectRegionMasks(
    expandFrameBorders(
      width === nestExpansion.composition.width && height === nestExpansion.composition.height
        ? nestExpansion.composition
        : { ...nestExpansion.composition, width, height }
    )
  );
  // Flarex asset-source MediaIn (FLAREX.md Phase 2, Fusion Loader model): synthetic OFF-TIMELINE layers,
  // one per `sourceAssetId` MediaIn. The preview builds these in VideoPreview; export never did, so every
  // asset-source MediaIn soft-degraded to the host clip in the rendered file while the editor showed the
  // real sources (user report 2026-07-27). Built from the SAME shared helper so the two agree by
  // construction. `durationSeconds` matters: it is what makes a source SHORTER than its host go
  // transparent at its end rather than hold a frozen last frame.
  const flarexVirtualLayers = collectFlarexVirtualLayers(
    renderComposition.tracks.flatMap((track) => track.layers),
    input.flarexComps,
    (assetId) => {
      const info = input.flarexSourceAssets?.[assetId];
      if (info) return { type: info.type, durationSeconds: info.durationSeconds };
      const source = urlMap[assetId];
      return source ? { type: source.kind } : null;
    }
  );
  const providerUrlMap = buildProviderUrlMap(renderComposition, urlMap, flarexVirtualLayers);

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

  // Region-effect pass model: `__rfx_` clone layers are pure structure for the scene draw builder
  // (mask + effect params) — their media is never decoded/graded (blur passes gaussian the layer's
  // running image, color passes grade it in-compositor). Loading their providers would burn a full
  // WebCodecs decoder per region effect for frames nothing reads.
  const regionPasses = getRegionPassesEnabled();

  const activeSourceKeysAt = (t: number): string[] => {
    const keys = new Set<string>();
    // Flarex loaders are active for their own (host-mirrored, source-clamped) span — keep their decoders
    // resident exactly like a timeline clip's, or the comp renders a hole where the source should be.
    for (const virtual of flarexVirtualLayers) {
      const key = mediaSourceKey(virtual);
      if (!key) continue;
      if (t < virtual.startSeconds || t >= virtual.startSeconds + virtual.durationSeconds) continue;
      keys.add(key);
    }
    for (const track of renderComposition.tracks) {
      for (const layer of track.layers) {
        if (regionPasses && layer.id.includes("__rfx_")) continue;
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

  /**
   * ADR-023 D3/T-2 — **the shrug is gone.**
   *
   * This used to be `document.fonts.load(...).catch(() => undefined)` inside a 3-second timeout
   * race: a font that failed, or merely arrived slowly, was silently swallowed and the export went
   * ahead in whatever face the platform happened to offer. That is the defect this stage exists to
   * remove — an export is a deliverable, produced unattended, and a substituted font there is wrong
   * pixels that look like a working feature.
   *
   * The split is D3's, not an invention here. A PINNED font (catalogue/user) has a `fileHash`: it is
   * a specific file, we either have it or we do not, and if we do not the export ABORTS by name. A
   * legacy `{ source: "system" }` ref names a CSS stack and has always resolved to whatever the
   * platform has — there is nothing to fail to fetch, so it keeps the timeout-raced preload it has
   * always had. Making legacy stacks hard-fail would break every project authored before `FontRef`
   * existed, which D1a forbids in the strongest terms.
   */
  const layers = composition.tracks.flatMap((track) => track.layers);
  const pinnedFonts = collectPinnedFontRefs(layers);
  if (pinnedFonts.length) {
    const outcomes = await Promise.all(pinnedFonts.map(installPinnedFont));
    const unresolved = pinnedFonts.filter((_, index) => outcomes[index] !== "installed");
    if (unresolved.length) throw new FontResolutionError(unresolved);
  }

  // Legacy system stacks: unchanged behaviour, including the timeout race. See above for why.
  const systemFamilies = getCompositionFontsUsed(layers)
    .filter((ref) => ref.source === "system")
    .map((ref) => fontRefCss(ref).fontFamily);
  if (systemFamilies.length && typeof document !== "undefined" && document.fonts) {
    const fontTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
    await Promise.race([
      (async () => {
        await Promise.all(systemFamilies.map((family) => document.fonts.load(`900 64px ${family}`).catch(() => undefined)));
        await document.fonts.ready;
      })(),
      fontTimeout,
    ]);
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
      // DEBT-015: this used to swallow load failures for matte-prefixed keys, on the theory that
      // mattes are optional. But a `matte:<layerId>` key only ever exists in providerUrlMap when
      // `layer.matte?.uri` is set (see activeSourceKeysAt / the map-building sites below) — a
      // NEVER-specified matte never reaches this function at all. So a failure here is always
      // "specified and broken", never "never specified", and swallowing it fed the same silent
      // unmatted-render defect as the matteFrame consumer in scene-frame-compositor.ts.
      try {
        sources.set(
          key,
          await withTimeout(
            // Animated vector graphic → frame sequence provider (advances with clip-local time).
            sourceDef.animation
              ? createAnimatedGraphicSource(sourceDef.animation.frameUrls, sourceDef.animation.plan)
              : createFrameProvider(sourceDef.url, sourceDef.kind),
            SOURCE_LOAD_TIMEOUT_MS,
            `loadSource ${key}`
          )
        );
      } catch (error) {
        // DEBT-015 message residual: createVideoSource/createImageSource's own errors ("Failed to
        // load video source for export") name neither the layer nor the URL — a user staring at a
        // failed export has no way to tell which clip broke. Name both; the underlying detail is
        // preserved (not replaced), so a genuine codec/timeout reason survives alongside "what/where".
        const detail = error instanceof Error ? error.message : String(error);
        const label = key.startsWith("matte:") ? `matte for layer "${key.slice("matte:".length)}"` : `source "${key}"`;
        throw new Error(`Export: failed to load ${label} (${sourceDef.url}) — ${detail}`);
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
    ...(nestExpansion.groups.size > 0
      ? {
          nestedGroups: nestExpansion.groups,
          // Block 4c: junctions where a side is a compound clip are only discoverable on the RAW comp.
          rawJunctionLayers: composition.tracks.flatMap((track) => track.layers),
        }
      : {}),
    // Flarex node comps (FLAREX.md) — only when at least one exists, keeping non-Flarex exports identical.
    ...(input.flarexComps && Object.keys(input.flarexComps).length > 0 ? { flarexComps: input.flarexComps } : {}),
    // Asset-source MediaIn loaders: the compositor must GRADE these (they are off-timeline, so its own
    // active-layer scan cannot find them) and hand them to buildSceneDraws, or every one falls back to
    // the host clip. Empty = unchanged behavior for comps without asset sources.
    ...(flarexVirtualLayers.length > 0 ? { flarexVirtualLayers } : {}),
  };
  const activeCanvas = new OffscreenCanvas(width, height);
  // Resolution downscale (export window): composite ALWAYS at full comp res (activeCanvas) so layer
  // coordinates are untouched, then blit each finished frame into a smaller encode canvas whose size
  // matches the encoder config (a VideoFrame's size must equal the encoder's configured dimensions).
  const encodeWidth = Math.max(2, (input.outputWidth ?? width) - ((input.outputWidth ?? width) % 2));
  const encodeHeight = Math.max(2, (input.outputHeight ?? height) - ((input.outputHeight ?? height) % 2));
  const downscaleOutput = encodeWidth !== width || encodeHeight !== height;
  const encodeCanvas = downscaleOutput ? new OffscreenCanvas(encodeWidth, encodeHeight) : activeCanvas;
  const encodeCtx = downscaleOutput ? encodeCanvas.getContext("2d") : null;
  if (encodeCtx) {
    encodeCtx.imageSmoothingEnabled = true;
    encodeCtx.imageSmoothingQuality = "high";
  }
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

  // Managed color contract for this project → container color tag. Working space is always
  // Rec.709 SDR in v1; only the output RANGE (limited/full) is user-visible, so map it here.
  const projectColor = normalizeProjectColorSettings(renderComposition.settings?.color);
  const outputColorSpace = { ...REC709_SDR_LIMITED, fullRange: projectColor.range === "full" };
  const encoder = new MediaEncoder({
    width: encodeWidth,
    height: encodeHeight,
    fps,
    format,
    outputColorSpace,
    ...(input.videoBitrate && input.videoBitrate > 0 ? { videoBitrate: input.videoBitrate } : {}),
    ...(input.bitrateMode ? { bitrateMode: input.bitrateMode } : {}),
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
      try {
        // Downscale (if any) happens here: blit the full-res composite into the encode-sized canvas
        // right before encoding, so recovery re-renders (which loop back to this call) also scale.
        if (encodeCtx) {
          encodeCtx.drawImage(activeCanvas, 0, 0, encodeWidth, encodeHeight);
        }
        await withTimeout(encoder.addVideoFrame(downscaleOutput ? encodeCanvas : activeCanvas, i), FRAME_TIMEOUT_MS, `encodeFrame ${i + 1}/${totalFrames}`);
      } catch (error) {
        if (error instanceof EncoderStallRecoveredError) {
          // The wedged encoder was reset; frames after resumeFrameIndex were queued but never muxed.
          // Rewind and RE-RENDER them (the compositor is deterministic — identical pixels), so the
          // recovery leaves no held frame / motion jump in the output. loadSource() recreates any
          // decoder releaseSpentSources() already freed for this span.
          onProgress?.(0.04 + (error.resumeFrameIndex / totalFrames) * 0.88, `Encoder recovered — re-rendering frame ${error.resumeFrameIndex + 1}…`);
          i = error.resumeFrameIndex - 1; // loop increment lands exactly on resumeFrameIndex
          continue;
        }
        throw error;
      }
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
    const appliedColor = encoder.getAppliedColorSpace();
    if (appliedColor) {
      onProgress?.(0.999, `[color] tagged ${appliedColor.primaries}/${appliedColor.transfer}/${appliedColor.matrix} ${appliedColor.fullRange ? "full" : "limited"} range`);
    } else {
      // The encoder emitted no decoderConfig to attach color to → the container color tag isn't guaranteed.
      onProgress?.(0.999, "[color] export-metadata-fallback: container color tag not guaranteed by this encoder");
    }
    onProgress?.(1, "Done");
    return blob;
  } finally {
    compositor.dispose();
    for (const source of sources.values()) source.dispose();
  }
}

/**
 * Every media-pool asset loaded by a Flarex asset-source `MediaIn` (`sourceAssetId`), across all comps.
 *
 * These are NOT timeline layers — a Flarex comp loads them directly (the Fusion Loader model), so nothing
 * that walks `composition.tracks` can see them. Missing this is why export rendered the HOST clip in place
 * of every asset-source `MediaIn`: with no provider the compiler's `resolveSourceDraw` returns null and
 * `MediaIn` soft-degrades to the host (user report 2026-07-27).
 */
export type FlarexSourceAssetMap = Record<string, { type: "video" | "image"; durationSeconds?: number | undefined }>;

// Single definition, in shared — the upload/remap path (lib/sync.ts) needs the SAME answer, and the two
// silently disagreeing is precisely how the 404 shipped. Re-exported so existing importers are unchanged.
export { collectFlarexSourceAssetIds } from "@orreris/shared";

/** Build the resolved source URL map (visual layers + per-clip luma mattes) for the pipeline. */
export function buildSourceUrlMap(
  composition: TimelineComposition,
  urlForAsset: (assetId: string) => string | undefined,
  /** Media kind + duration for every Flarex asset-source `MediaIn` asset (off-timeline — see above).
   *  The kind must be the REAL one: an image decoded through a video provider is not the same thing. */
  flarexSourceAssets?: FlarexSourceAssetMap | undefined
): SourceUrlMap {
  const map: SourceUrlMap = {};
  for (const [assetId, info] of Object.entries(flarexSourceAssets ?? {})) {
    const url = urlForAsset(assetId);
    if (url && !map[assetId]) map[assetId] = { url, kind: info.type };
  }
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.type === "image" && layer.graphic) {
        // Self-contained vector graphic: bake the recolored SVG data URL (same bake as preview/Remotion).
        // SMIL-animated ones additionally emit one deep-linked frame per cycle index, so the export can
        // play the animation instead of freezing it at the settled final frame.
        const plan = resolveGraphicAnimation(layer.graphic, { animations: layer.animations });
        const animation = plan
          ? {
              plan,
              frameUrls: Array.from({ length: plan.frameCount }, (_unused, index) =>
                graphicToAnimatedDataUrl(layer.graphic!, graphicAnimationBakeTime(plan, index))
              ),
            }
          : undefined;
        map[graphicSourceKey(layer.id)] = { url: graphicToDataUrl(layer.graphic), kind: "image", animation };
        if (layer.matte?.uri) map[`matte:${layer.id}`] = { url: layer.matte.uri, kind: layer.type };
        continue;
      }
      if ((layer.type === "video" || layer.type === "image") && layer.assetId) {
        const url = urlForAsset(layer.assetId);
        if (url && !map[layer.assetId]) map[layer.assetId] = { url, kind: layer.type };
        if (layer.matte?.uri) map[`matte:${layer.id}`] = { url: layer.matte.uri, kind: layer.type };
      }
    }
  }
  return map;
}
