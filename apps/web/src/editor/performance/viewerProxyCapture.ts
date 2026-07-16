/**
 * Viewer-capture proxy generation (todo.md Phase 6B P1a — "the proxy IS the viewer") and the P1b parity
 * self-check.
 *
 * P1a: renders a span's frames through the VISIBLE preview's own SceneCompositor (via the
 * `SceneViewerCaptureHandle`: same compositor instance, texture caches, text rasterizer, matte cache,
 * draw builder, and flags as the on-screen frame — WITHOUT presenting, so the canvas never flashes),
 * with media decoded by pooled `<video>` elements (the SAME decoder family playback uses — this is what
 * makes browser-playable sources that WebCodecs can't decode finally proxyable) and graded by
 * shared-context MediaWebGLRenderers on the compositor's own GL context (ZERO new WebGL contexts —
 * governor-friendly, unlike the old main-thread SceneFrameCompositor fallback).
 *
 * P1b: `verifySpanProxyAgainstViewer` decodes sample frames from a SEALED span webm (either pipeline)
 * and pixel-compares them against a fresh offscreen viewer render at the same times — the safety net
 * that makes proxy/viewer divergence impossible to ship silently (a black or effect-missing span fails
 * the check and stays on live render instead of sealing).
 *
 * Faithful by construction: any effect/transition/plugin the viewer renders is in the proxy, because it
 * IS the viewer's render. The export-Worker pipeline remains the fallback when capture fails.
 * Runs only while the editor is paused/idle; the abort signal fires on play/edit (EditorPage's loop).
 */

import {
  colorPipelineCacheKey,
  findTransitionPairs,
  getActiveTransition,
  graphicToDataUrl,
  getCompositionColorPipeline,
  getCompositionMediaEffects,
  getCompositionObjectFit,
  isTrackEnabled,
  MediaWebGLRenderer,
  RenderTarget,
  layerSourceTimeSeconds,
  type ScenePreviewTransition,
  type SceneTextureSource,
  type TimelineComposition,
  type TimelineLayer,
  type TransitionSpec,
} from "@kimera-by-aelivion/shared";
import { MediaEncoder } from "../../export/video-encoder";
import { acquireVideo, type VideoLease } from "../../lib/video-element-pool";
import { applyActiveAdjustmentEffects, isLayerActive, isIncomingInPreroll, isOutgoingInPostroll } from "../../components/VideoPreview";
import type { SceneViewerCaptureHandle } from "../../components/ScenePreviewCanvas";

/** Capture cannot run right now (no GL, source won't load, …) — caller falls back to the Worker path. */
export class ViewerCaptureUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerCaptureUnavailable";
  }
}

export class ViewerCaptureAborted extends Error {
  constructor() {
    super("viewer capture aborted");
    this.name = "ViewerCaptureAborted";
  }
}

export interface ViewerCaptureSpanInput {
  composition: TimelineComposition;
  spanStartSeconds: number;
  spanEndSeconds: number;
  fps: number;
  capture: SceneViewerCaptureHandle;
  resolveAssetUrl: (assetId: string | undefined) => string | undefined;
  signal: AbortSignal;
}

const SEEK_TIMEOUT_MS = 8000;
const METADATA_TIMEOUT_MS = 10_000;
// Retry budget for a frame whose async pieces (text raster, first decoded frame) weren't ready yet.
const FRAME_RETRIES = 3;
// P1b thresholds: catch GROSS divergence (black frame, missing effect/grade, wrong content) while
// tolerating VP9 compression noise. A pixel "differs" past DELTA on any channel; the frame fails when
// more than RATIO of pixels differ; the span fails when any sampled frame fails.
const PARITY_CHANNEL_DELTA = 24;
const PARITY_MAX_DIFF_RATIO = 0.08;

interface MediaSourceEntry {
  layer: TimelineLayer;
  lease?: VideoLease | undefined;
  matteLease?: VideoLease | undefined;
  image?: HTMLImageElement | undefined;
  renderer?: MediaWebGLRenderer | undefined;
  target?: RenderTarget | undefined;
  pipelineKey: string;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ViewerCaptureAborted();
}

function waitForMetadata(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onError);
      window.clearTimeout(timer);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new ViewerCaptureUnavailable(`video failed to load: ${video.src.slice(0, 80)}`));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(signal.aborted ? new ViewerCaptureAborted() : new ViewerCaptureUnavailable("video metadata timeout"));
    }, METADATA_TIMEOUT_MS);
    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function seekTo(video: HTMLVideoElement, target: number, signal: AbortSignal): Promise<void> {
  const clamped = Math.max(0, target);
  if (Math.abs(video.currentTime - clamped) < 1 / 240 && video.readyState >= 2 && !video.seeking) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      window.clearTimeout(timer);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(signal.aborted ? new ViewerCaptureAborted() : new ViewerCaptureUnavailable("video seek timeout"));
    }, SEEK_TIMEOUT_MS);
    video.addEventListener("seeked", onSeeked, { once: true });
    try {
      video.currentTime = clamped;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function loadImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(signal.aborted ? new ViewerCaptureAborted() : new ViewerCaptureUnavailable(`image failed to load: ${url.slice(0, 80)}`));
    img.src = url;
  });
}

interface SpanRenderer {
  /** Render the viewer's frame at absolute timeline time `t` offscreen (top-origin RGBA). */
  renderFrame(t: number, buffer?: Uint8Array): Promise<{ pixels: Uint8Array; width: number; height: number }>;
  dispose(): void;
}

/**
 * Set up the span's sources (pooled `<video>` leases, images, shared-context grade renderers) and return
 * a per-frame renderer that produces the LIVE viewer's pixels for any time in the span. Shared by the
 * P1a capture loop and the P1b parity sampler so both render through exactly one code path.
 */
async function createSpanRenderer(input: ViewerCaptureSpanInput): Promise<SpanRenderer> {
  const { composition, spanStartSeconds, spanEndSeconds, fps, capture, resolveAssetUrl, signal } = input;
  const sharedGl = capture.getSharedGl();
  if (!sharedGl) throw new ViewerCaptureUnavailable("preview compositor unavailable");

  // Layer census: everything visually active anywhere in the span (postroll window included).
  const spanEnd = Math.max(spanStartSeconds + 1 / Math.max(1, fps), spanEndSeconds);
  const POSTROLL_SLACK = 2; // generous: the real transition-window check happens per frame
  const spanEntries = composition.tracks
    .flatMap((track, trackIndex) => track.layers.map((layer, layerIndex) => ({ layer, trackIndex, layerIndex, track })))
    .filter(({ layer, track }) => isTrackEnabled(track, composition.tracks) && !layer.muted && layer.type !== "audio")
    .filter(
      ({ layer }) =>
        layer.startSeconds < spanEnd + POSTROLL_SLACK && spanStartSeconds < layer.startSeconds + layer.durationSeconds + POSTROLL_SLACK
    );

  // Sources: pooled <video> decoders (warm same-src reuse) / images; one shared-context grade renderer
  // per media layer (zero new GL contexts).
  const media = new Map<string, MediaSourceEntry>();
  const dispose = () => {
    for (const entry of media.values()) {
      entry.lease?.release();
      entry.matteLease?.release();
      try {
        entry.renderer?.dispose();
      } catch {
        /* ignore */
      }
      try {
        entry.target?.dispose();
      } catch {
        /* ignore */
      }
    }
    media.clear();
    capture.releaseCaptureResources();
  };

  try {
    for (const { layer } of spanEntries) {
      if (layer.type !== "video" && layer.type !== "image") continue;
      // Vector graphic layers are self-contained (no SourceAsset) — their pixel source is the baked
      // SVG data URL, same as the live preview/Remotion. Without this, any span containing a graphic
      // failed viewer capture ("no source url") and the worker fallback rendered the graphic missing.
      const url = layer.graphic ? graphicToDataUrl(layer.graphic) : resolveAssetUrl(layer.assetId);
      if (!url) throw new ViewerCaptureUnavailable(`no source url for layer ${layer.id}`);
      const entry: MediaSourceEntry = { layer, pipelineKey: "" };
      if (layer.type === "video") {
        entry.lease = acquireVideo(url);
        await waitForMetadata(entry.lease.video, signal);
      } else {
        entry.image = await loadImage(url, signal);
      }
      if (layer.matte?.uri) {
        entry.matteLease = acquireVideo(layer.matte.uri);
        await waitForMetadata(entry.matteLease.video, signal);
      }
      entry.renderer = new MediaWebGLRenderer({ sharedGl }, { label: `viewer-proxy:${layer.id}` });
      entry.target = new RenderTarget(sharedGl, 1, 1);
      media.set(layer.id, entry);
      throwIfAborted(signal);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  const renderFrame = async (t: number, buffer?: Uint8Array) => {
    throwIfAborted(signal);
    // Active entries at t — the viewer's exact activity + z-order + adjustment-merge rules.
    const activeEntries = spanEntries
      .filter(({ layer, track }) => isLayerActive(layer, t) || isOutgoingInPostroll(layer, track, t) || isIncomingInPreroll(layer, track, t))
      .sort((a, b) => (a.trackIndex !== b.trackIndex ? b.trackIndex - a.trackIndex : a.layerIndex - b.layerIndex));
    const mergedLayers = activeEntries
      .map((entry) => applyActiveAdjustmentEffects(entry.layer, entry.trackIndex, activeEntries))
      .filter((layer) => layer.type !== "adjustment");

    // Active junction transitions only (an inactive pair would make buildSceneDraws skip the outgoing).
    const byId = new Map(mergedLayers.map((layer) => [layer.id, layer]));
    const transitions: ScenePreviewTransition[] = [];
    for (const pair of findTransitionPairs(mergedLayers)) {
      const incoming = byId.get(pair.incomingId);
      const outgoing = byId.get(pair.outgoingId);
      if (!incoming || !outgoing) continue;
      const active = getActiveTransition(pair.spec as TransitionSpec, {
        currentTimeSeconds: t,
        startSeconds: incoming.startSeconds,
        clipDurationSeconds: incoming.durationSeconds,
      });
      if (!active) continue;
      transitions.push({
        outgoingId: pair.outgoingId,
        incomingId: pair.incomingId,
        spec: pair.spec as TransitionSpec,
        startSeconds: incoming.startSeconds,
        fromFit: getCompositionObjectFit(outgoing) as "cover" | "contain" | "fill",
        toFit: getCompositionObjectFit(incoming) as "cover" | "contain" | "fill",
      });
    }

    // Seek every leased video (and matte) to its layer-local source time, then grade — the same inputs
    // as the viewer's WebglMediaLayer: opacity NOT baked (compositor applies it live), transition reveal
    // handled by the folded scene transition (null here — scene mode).
    const graded = new Map<string, SceneTextureSource>();
    for (const layer of mergedLayers) {
      const entry = media.get(layer.id);
      if (!entry || !entry.renderer || !entry.target) continue;
      // Speed-aware (rate stretch) — MUST match the viewer's syncVideoTime mapping exactly, or the
      // P1b parity self-check compares span frames from the wrong source time and fails the span
      // (user-visible as the red proxy bar on sped-up clips). Clamp to the decodable range so a
      // 400% clip near its media end seeks to the last real frame instead of stalling past EOF.
      const rawSourceTime = layerSourceTimeSeconds(layer, Math.max(0, t - layer.startSeconds));
      const mediaEnd = entry.lease && Number.isFinite(entry.lease.video.duration) ? Math.max(0, entry.lease.video.duration - 0.05) : rawSourceTime;
      const sourceTime = Math.min(rawSourceTime, mediaEnd);
      let source: TexImageSource;
      let sw: number;
      let sh: number;
      if (entry.lease) {
        await seekTo(entry.lease.video, sourceTime, signal);
        source = entry.lease.video;
        sw = entry.lease.video.videoWidth;
        sh = entry.lease.video.videoHeight;
      } else if (entry.image) {
        source = entry.image;
        sw = entry.image.naturalWidth;
        sh = entry.image.naturalHeight;
      } else {
        continue;
      }
      if (sw <= 0 || sh <= 0) throw new ViewerCaptureUnavailable(`source has no pixels for layer ${layer.id}`);
      let matte: TexImageSource | null = null;
      if (entry.matteLease) {
        await seekTo(entry.matteLease.video, sourceTime, signal);
        matte = entry.matteLease.video;
      }
      const pipeline = getCompositionColorPipeline(layer, { currentTimeSeconds: t });
      const pipelineKey = colorPipelineCacheKey(pipeline);
      if (entry.pipelineKey !== pipelineKey) {
        entry.renderer.setPipeline(pipeline);
        entry.pipelineKey = pipelineKey;
      }
      entry.renderer.draw({
        source,
        sourceWidth: sw,
        sourceHeight: sh,
        matte,
        matteInvert: layer.matte?.invert ?? false,
        matteOpacity: layer.matte?.opacity ?? 1,
        pipeline,
        amount: 1,
        opacity: 1,
        mediaEffects: getCompositionMediaEffects(layer, { currentTimeSeconds: t }),
        transition: null,
        target: entry.target,
      });
      graded.set(layer.id, { texture: entry.target.tex, width: sw, height: sh });
    }

    await capture.ensureTextRasters(mergedLayers, t);
    throwIfAborted(signal);

    // Compose offscreen through the LIVE compositor (no present). Retry briefly for late async pieces.
    let frame: { pixels: Uint8Array; width: number; height: number } | null = null;
    for (let attempt = 0; attempt <= FRAME_RETRIES && !frame; attempt++) {
      frame = capture.renderOffscreen({
        layers: mergedLayers,
        timeSeconds: t,
        transitions,
        getMediaGraded: (id) => graded.get(id) ?? null,
        buffer,
      });
      if (!frame) await new Promise((resolve) => window.setTimeout(resolve, 60 * (attempt + 1)));
      throwIfAborted(signal);
    }
    if (!frame) throw new ViewerCaptureUnavailable(`viewer compositor produced no frame at ${t.toFixed(3)}s`);
    return frame;
  };

  return { renderFrame, dispose };
}

/** Render one span to a webm Blob through the live viewer's compositor (P1a). */
export async function captureSpanProxyFromViewer(input: ViewerCaptureSpanInput): Promise<Blob> {
  const { spanStartSeconds, spanEndSeconds, fps, signal } = input;
  throwIfAborted(signal);
  const renderer = await createSpanRenderer(input);
  let encoder: MediaEncoder | null = null;
  try {
    const spanEnd = Math.max(spanStartSeconds + 1 / Math.max(1, fps), spanEndSeconds);
    const frameCount = Math.max(1, Math.round((spanEnd - spanStartSeconds) * fps));
    let buffer: Uint8Array | undefined;
    for (let index = 0; index < frameCount; index++) {
      const frame = await renderer.renderFrame(spanStartSeconds + index / fps, buffer);
      buffer = frame.pixels;
      encoder ??= new MediaEncoder({ format: "webm", fps, width: frame.width, height: frame.height });
      const videoFrame = new VideoFrame(frame.pixels, {
        format: "RGBA",
        codedWidth: frame.width,
        codedHeight: frame.height,
        timestamp: 0, // MediaEncoder stamps by index
      });
      try {
        await encoder.addVideoFrame(videoFrame, index);
      } finally {
        videoFrame.close();
      }
      // Idle politeness: yield the main thread between frames so a paused UI stays responsive.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    if (!encoder) throw new ViewerCaptureUnavailable("span produced no frames");
    return await encoder.finalize();
  } finally {
    renderer.dispose();
  }
}

export interface SpanParityResult {
  ok: boolean;
  /** Worst sampled frame's differing-pixel ratio. */
  worstDiffRatio: number;
  sampledTimes: number[];
}

/**
 * P1b parity self-check: decode sample frames from a generated span webm (EITHER pipeline) and compare
 * them against a fresh offscreen viewer render at the same times. Catches gross divergence — black
 * frames, missing effects/grades, wrong content — before the span is sealed; a failed span stays on
 * live render instead of silently playing wrong pixels.
 */
export async function verifySpanProxyAgainstViewer(
  input: ViewerCaptureSpanInput & { blob: Blob; sampleCount?: number }
): Promise<SpanParityResult> {
  const { blob, spanStartSeconds, spanEndSeconds, fps, signal } = input;
  throwIfAborted(signal);
  const spanEnd = Math.max(spanStartSeconds + 1 / Math.max(1, fps), spanEndSeconds);
  const frameCount = Math.max(1, Math.round((spanEnd - spanStartSeconds) * fps));
  const samples = Math.max(1, Math.min(input.sampleCount ?? 2, frameCount));
  // Spread samples across the span, snapped to frame indices (+ε so the decoder lands inside the frame).
  const sampleIndices = Array.from({ length: samples }, (_, i) => Math.min(frameCount - 1, Math.floor(((i + 0.5) * frameCount) / samples)));

  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  const renderer = await createSpanRenderer(input);
  const canvas = document.createElement("canvas");
  try {
    await waitForMetadata(video, signal);
    let worst = 0;
    const sampledTimes: number[] = [];
    for (const index of sampleIndices) {
      const t = spanStartSeconds + index / fps;
      sampledTimes.push(t);
      await seekTo(video, index / fps + 0.001, signal);
      const live = await renderer.renderFrame(t);
      canvas.width = live.width;
      canvas.height = live.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new ViewerCaptureUnavailable("2d context unavailable for parity check");
      ctx.drawImage(video, 0, 0, live.width, live.height);
      const decoded = ctx.getImageData(0, 0, live.width, live.height).data;
      let diff = 0;
      const total = live.width * live.height;
      for (let i = 0; i < decoded.length; i += 4) {
        if (
          Math.abs(decoded[i]! - live.pixels[i]!) > PARITY_CHANNEL_DELTA ||
          Math.abs(decoded[i + 1]! - live.pixels[i + 1]!) > PARITY_CHANNEL_DELTA ||
          Math.abs(decoded[i + 2]! - live.pixels[i + 2]!) > PARITY_CHANNEL_DELTA
        ) {
          diff++;
        }
      }
      worst = Math.max(worst, diff / total);
      throwIfAborted(signal);
    }
    return { ok: worst <= PARITY_MAX_DIFF_RATIO, worstDiffRatio: worst, sampledTimes };
  } finally {
    renderer.dispose();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
