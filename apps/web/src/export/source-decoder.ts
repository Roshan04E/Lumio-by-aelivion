/**
 * Local export — source frame providers.
 *
 * `createFrameProvider` prefers the fast WebCodecs + mp4box decoder (forward, no per-frame
 * seeking) and falls back to a hidden <video> seek for codecs/containers it can't handle.
 * Both expose the same `getFrame(sourceTime)` contract; the provider owns the returned
 * frame's lifetime (callers draw it synchronously and must not close it).
 */

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
  dispose(): void;
}

export function clipSourceKey(layerId: string, assetId: string): string {
  return `clip:${layerId}:${assetId}`;
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

export async function createImageSource(url: string): Promise<FrameProvider> {
  // createImageBitmap works on both the main thread and inside a Worker (unlike `new Image()`),
  // decodes once up front, and returns a GPU-friendly CanvasImageSource/TexImageSource.
  // imageOrientation "flipY": texImage2D IGNORES UNPACK_FLIP_Y_WEBGL for ImageBitmap sources, but
  // the media-renderer's upload convention assumes flipped uploads (true for the preview's
  // HTMLImageElement stills) — an unflipped bitmap exported every photo UPSIDE DOWN
  // (2026-07-03 report). Baking the flip into the bitmap restores preview↔export parity; the
  // preview's own bitmap path (WebglMediaLayer) applies the same option.
  let bitmap: ImageBitmap;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const blob = await (await fetch(url, { signal: controller.signal, cache: "no-store" })).blob();
      bitmap = await createImageBitmap(blob, { imageOrientation: "flipY" }).catch(() => createImageBitmap(blob));
    } finally {
      clearTimeout(timer);
    }
  } catch {
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
