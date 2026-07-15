/**
 * Local export — source frame providers.
 *
 * `createFrameProvider` prefers the fast WebCodecs + mp4box decoder (forward, no per-frame
 * seeking) and falls back to a hidden <video> seek for codecs/containers it can't handle.
 * Both expose the same `getFrame(sourceTime)` contract; the provider owns the returned
 * frame's lifetime (callers draw it synchronously and must not close it).
 */

import { graphicAnimationFrameAt, type GraphicAnimationPlan } from "@kimera-by-aelivion/shared";
import { createWebCodecsVideoSource } from "./webcodecs-decoder";

export interface FrameProvider {
  readonly width: number;
  readonly height: number;
  /** Frame to draw at `sourceTimeSeconds`. Provider-owned; valid until the next call/dispose. */
  getFrame(sourceTimeSeconds: number): Promise<CanvasImageSource | null>;
  /**
   * How far BEHIND the last `getFrame` request the returned frame was, in seconds (0 = at/past
   * the target). Only meaningful for time-sliced preview providers (`frameBudgetMs`): during a
   * rewind catch-up on a sparse-keyframe source they serve progressively advancing stale frames —
   * the presenter uses this to HOLD the last drawn frame instead of playing the gap fast-forward
   * (user report 2026-07-03). Export providers block until decoded, so this stays 0 there.
   */
  readonly lastFrameLagSeconds?: number;
  /**
   * Nominal source frame rate estimated from the container's sample table (WebCodecs provider
   * only; undefined on the <video>/image fallbacks). Resampling consumers (the ingest-proxy
   * transcode) sample at this cadence so 24fps content isn't forced onto a 30fps grid (judder).
   */
  readonly nominalFps?: number | undefined;
  /**
   * True decodable end of the source from its sample table (last sample timestamp + duration),
   * WebCodecs provider only. Container/asset duration metadata routinely OVERSHOOTS this by a
   * frame to ~1s; getFrame past it clamps to the final frame (never null), so a transcode that
   * trusts the metadata bakes a frozen tail into its output. Resampling consumers must clamp
   * their frame loop to this when present.
   */
  readonly decodableEndSeconds?: number | undefined;
  dispose(): void;
}

export function clipSourceKey(layerId: string, assetId: string): string {
  return `clip:${layerId}:${assetId}`;
}

/** Vector graphic layers are self-contained (no SourceAsset) — their baked-SVG image source is
 *  keyed by layer id, mirroring how the preview/Remotion synthesize the data URL per layer. */
export function graphicSourceKey(layerId: string): string {
  return `graphic:${layerId}`;
}

/** Pick the fastest provider for a source; `<video>` is the universal fallback. */
export async function createFrameProvider(
  url: string,
  kind: "video" | "image",
  opts: { preferSoftware?: boolean; frameBudgetMs?: number } = {}
): Promise<FrameProvider> {
  if (kind === "image") return createImageSource(url);
  const webcodecs = await createWebCodecsVideoSource(url, opts).catch(() => null);
  if (webcodecs) return webcodecs;
  // The <video> fallback needs the DOM; inside the export Worker there is none, so signal the
  // caller (worker → main thread) to retry this export on the main thread where <video> works.
  if (typeof document === "undefined") throw new Error("WEBCODECS_REQUIRED_NO_DOM");
  return createVideoSource(url);
}

/** Fallback provider: seek a hidden <video> and read the frame after `seeked`. */
export async function createVideoSource(url: string): Promise<FrameProvider> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  await new Promise<void>((resolve, reject) => {
    // A source that never fires loadeddata OR error (unsupported codec, stalled/dead URL) would hang
    // the export at "Loading media…" forever — bound the wait so it fails cleanly instead.
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out loading video source for export"));
    }, 20_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed to load video source for export"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);
  });

  let lastSeekedTo = -1;
  async function seek(sourceTimeSeconds: number) {
    const target = Math.max(0, Math.min(sourceTimeSeconds, Math.max(0, (video.duration || 0) - 1e-3)));
    if ((Math.abs(target - lastSeekedTo) < 1e-4 || Math.abs(video.currentTime - target) < 1e-4) && video.readyState >= 2) {
      lastSeekedTo = target;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        reject(new Error(`Timed out seeking video source for export to ${target.toFixed(3)}s`));
      }, 10_000);
      const onSeeked = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        lastSeekedTo = target;
        resolve();
      };
      const onError = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        reject(new Error(`Failed seeking video source for export to ${target.toFixed(3)}s`));
      };
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onError);
      video.currentTime = target;
    });
  }

  return {
    get width() {
      return video.videoWidth;
    },
    get height() {
      return video.videoHeight;
    },
    async getFrame(sourceTimeSeconds: number) {
      await seek(sourceTimeSeconds);
      return video.readyState >= 2 && video.videoWidth > 0 ? video : null;
    },
    dispose() {
      video.removeAttribute("src");
      video.load();
    },
  };
}

/**
 * Decode an image URL to a flipped, GPU-ready bitmap.
 *
 * createImageBitmap works on both the main thread and inside a Worker (unlike `new Image()`), decodes
 * once up front, and returns a GPU-friendly CanvasImageSource/TexImageSource.
 * imageOrientation "flipY": texImage2D IGNORES UNPACK_FLIP_Y_WEBGL for ImageBitmap sources, but the
 * media-renderer's upload convention assumes flipped uploads (true for the preview's HTMLImageElement
 * stills) — an unflipped bitmap exported every photo UPSIDE DOWN (2026-07-03 report). Baking the flip
 * into the bitmap restores preview↔export parity; the preview's own bitmap path (WebglMediaLayer)
 * applies the same option.
 */
async function decodeImageBitmap(url: string): Promise<ImageBitmap> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const blob = await (await fetch(url, { signal: controller.signal, cache: "no-store" })).blob();
    if (blob.type.includes("svg") || /^data:image\/svg/i.test(url)) {
      // createImageBitmap CANNOT rasterize an SVG blob without a layout engine: it throws inside the
      // export Worker (no DOM) and on Firefox/Safari even on the main thread — that was the
      // "Failed to load image source for export" reported on vector-graphic layers (Remotion's own
      // <img> rasterization made server exports fine while local export failed). Decode through an
      // <img> (the preview's proven SVG path) then snapshot to a bitmap; works wherever the DOM
      // exists. With no DOM (Worker), signal the caller to retry on the main thread — local-export
      // rasterizes graphics to PNG up front so this is only a safety net.
      if (typeof document === "undefined") throw new Error("SVG_REQUIRES_DOM");
      return await createSvgBitmapViaImage(url);
    }
    return await createImageBitmap(blob, { imageOrientation: "flipY" }).catch(() => createImageBitmap(blob));
  } finally {
    clearTimeout(timer);
  }
}

export async function createImageSource(url: string): Promise<FrameProvider> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeImageBitmap(url);
  } catch (error) {
    if (error instanceof Error && error.message === "SVG_REQUIRES_DOM") throw error;
    throw new Error("Failed to load image source for export");
  }
  return {
    get width() {
      return bitmap.width;
    },
    get height() {
      return bitmap.height;
    },
    async getFrame() {
      return bitmap;
    },
    dispose() {
      bitmap.close();
    },
  };
}

/**
 * Frame provider for an ANIMATED vector graphic: the pre-baked cycle frames (one per
 * `graphicAnimationFrame` index), selected by CLIP-LOCAL time. `local-export` bakes `frameUrls` to PNG on
 * the main thread, so this decodes plain bitmaps and needs no DOM — the Worker path works unchanged.
 * The same shared selection math runs in the preview and Remotion, so all three stay frame-aligned.
 */
export async function createAnimatedGraphicSource(frameUrls: string[], plan: GraphicAnimationPlan): Promise<FrameProvider> {
  let frames: ImageBitmap[];
  try {
    frames = await Promise.all(frameUrls.map((url) => decodeImageBitmap(url)));
  } catch (error) {
    if (error instanceof Error && error.message === "SVG_REQUIRES_DOM") throw error;
    throw new Error("Failed to load image source for export");
  }
  if (!frames.length) throw new Error("Failed to load image source for export");
  const pick = (localSeconds: number) => {
    const frameIndex = graphicAnimationFrameAt(plan, localSeconds);
    return frames[Math.min(frameIndex, frames.length - 1)]!;
  };
  return {
    get width() {
      return frames[0]!.width;
    },
    get height() {
      return frames[0]!.height;
    },
    async getFrame(localSeconds: number) {
      return pick(localSeconds);
    },
    dispose() {
      for (const frame of frames) frame.close();
      frames = [];
    },
  };
}

/** Rasterize an SVG (data) URL to a bitmap via a decoded `<img>` — the browser's layout engine handles
 *  SVG that `createImageBitmap(blob)` refuses. Requires the DOM (main thread only). The `flipY` matches
 *  the raster/image path so preview↔export stay pixel-aligned (see the note in `createImageSource`). */
async function createSvgBitmapViaImage(url: string): Promise<ImageBitmap> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return createImageBitmap(img, { imageOrientation: "flipY" }).catch(() => createImageBitmap(img));
}
