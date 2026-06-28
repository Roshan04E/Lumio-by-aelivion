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
  dispose(): void;
}

/** Pick the fastest provider for a source; `<video>` is the universal fallback. */
export async function createFrameProvider(url: string, kind: "video" | "image"): Promise<FrameProvider> {
  if (kind === "image") return createImageSource(url);
  const webcodecs = await createWebCodecsVideoSource(url).catch(() => null);
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
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed to load video source for export"));
    };
    const cleanup = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);
  });

  let lastSeekedTo = -1;
  async function seek(sourceTimeSeconds: number) {
    const target = Math.max(0, Math.min(sourceTimeSeconds, Math.max(0, (video.duration || 0) - 1e-3)));
    if (Math.abs(target - lastSeekedTo) < 1e-4 && video.readyState >= 2) return;
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        lastSeekedTo = target;
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
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
  let bitmap: ImageBitmap;
  try {
    const blob = await (await fetch(url)).blob();
    bitmap = await createImageBitmap(blob);
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
