import { useEffect, useState } from "react";

/**
 * Real video-frame thumbnails for timeline clips (the filmstrip look). Loads a video once
 * off-screen, seeks to evenly-spaced timestamps, and captures each frame to a small JPEG
 * data URL. Results are cached by URL so every clip backed by the same asset shares one
 * extraction. Assets are served with CORS (see api `app.ts`), so `crossOrigin="anonymous"`
 * keeps the capture canvas untainted.
 */

const FRAME_COUNT = 10;
const THUMB_WIDTH = 96;

const cache = new Map<string, string[]>();
const inflight = new Map<string, Promise<string[] | null>>();

function waitFor(el: HTMLVideoElement, event: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
      clearTimeout(timer);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("video error"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  const done = waitFor(video, "seeked");
  video.currentTime = time;
  return done;
}

export async function getVideoThumbnails(url: string, count = FRAME_COUNT): Promise<string[] | null> {
  if (!url) return null;
  const cached = cache.get(url);
  if (cached) return cached;
  const pending = inflight.get(url);
  if (pending) return pending;

  const task = (async () => {
    let video: HTMLVideoElement | null = null;
    try {
      if (typeof document === "undefined") return null;
      video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.preload = "auto";
      video.src = url;
      await waitFor(video, "loadedmetadata");
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return null;

      const aspect = video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
      const canvas = document.createElement("canvas");
      canvas.width = THUMB_WIDTH;
      canvas.height = Math.max(1, Math.round(THUMB_WIDTH / aspect));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      const thumbs: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const t = ((i + 0.5) / count) * duration;
        await seek(video, Math.min(t, Math.max(0, duration - 0.05)));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        thumbs.push(canvas.toDataURL("image/jpeg", 0.6));
      }
      cache.set(url, thumbs);
      return thumbs;
    } catch {
      return null;
    } finally {
      if (video) {
        video.removeAttribute("src");
        video.load();
      }
      inflight.delete(url);
    }
  })();
  inflight.set(url, task);
  return task;
}

// ── First-frame poster (held in the preview until the real frame decodes) ──────────────
// A single, higher-res still captured at a clip's in-point. Used as a placeholder over the WebGL
// canvas / as the native <video poster> so the viewer never shows a black surface before the first
// frame paints — the same "always present a frame" guarantee pro editors give. Cached per url@time.
const POSTER_WIDTH = 480;
const posterCache = new Map<string, string>();
const posterInflight = new Map<string, Promise<string | null>>();

function posterKey(url: string, atSeconds: number): string {
  return `${url}@${atSeconds.toFixed(2)}`;
}

export async function getVideoPoster(url: string, atSeconds = 0): Promise<string | null> {
  if (!url) return null;
  const key = posterKey(url, atSeconds);
  const cached = posterCache.get(key);
  if (cached) return cached;
  const pending = posterInflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    let video: HTMLVideoElement | null = null;
    try {
      if (typeof document === "undefined") return null;
      video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.preload = "auto";
      video.src = url;
      await waitFor(video, "loadedmetadata");
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return null;

      const aspect = video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
      const canvas = document.createElement("canvas");
      canvas.width = POSTER_WIDTH;
      canvas.height = Math.max(1, Math.round(POSTER_WIDTH / aspect));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      await seek(video, Math.min(Math.max(0, atSeconds), Math.max(0, duration - 0.05)));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const poster = canvas.toDataURL("image/jpeg", 0.72);
      posterCache.set(key, poster);
      return poster;
    } catch {
      return null;
    } finally {
      if (video) {
        video.removeAttribute("src");
        video.load();
      }
      posterInflight.delete(key);
    }
  })();
  posterInflight.set(key, task);
  return task;
}

/** React hook: returns a first-frame poster (at `atSeconds`) for the url once captured, else `null`. */
export function useVideoPoster(url: string | undefined, atSeconds = 0): string | null {
  const [poster, setPoster] = useState<string | null>(() => (url ? posterCache.get(posterKey(url, atSeconds)) ?? null : null));
  useEffect(() => {
    if (!url) {
      setPoster(null);
      return;
    }
    const cached = posterCache.get(posterKey(url, atSeconds));
    if (cached) {
      setPoster(cached);
      return;
    }
    let active = true;
    void getVideoPoster(url, atSeconds).then((result) => {
      if (active) setPoster(result);
    });
    return () => {
      active = false;
    };
  }, [url, atSeconds]);
  return poster;
}

/** React hook: returns the asset's frame thumbnails once extracted, or `null` meanwhile. */
export function useVideoThumbnails(url: string | undefined, count = FRAME_COUNT): string[] | null {
  const [thumbs, setThumbs] = useState<string[] | null>(() => (url ? cache.get(url) ?? null : null));
  useEffect(() => {
    if (!url) {
      setThumbs(null);
      return;
    }
    const cached = cache.get(url);
    if (cached) {
      setThumbs(cached);
      return;
    }
    let active = true;
    void getVideoThumbnails(url, count).then((result) => {
      if (active) setThumbs(result);
    });
    return () => {
      active = false;
    };
  }, [url, count]);
  return thumbs;
}
