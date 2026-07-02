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
// Browsers cap concurrent connections per origin at ~6, and a loading <video> holds one. The viewer's
// playing + pre-rolled clips already use several; if every filmstrip + poster ALSO spins up its own
// <video> at once (one per clip), the surplus loads queue behind them and never receive `loadedmetadata`
// within the timeout → the "timeout" failures. So run all extraction through a small shared queue: at
// most this many extra <video>s load at a time, leaving the viewer's own loads room to finish.
const MAX_CONCURRENT_EXTRACTIONS = 2;
let activeExtractions = 0;
const extractionWaiters: Array<() => void> = [];
async function withExtractionSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeExtractions >= MAX_CONCURRENT_EXTRACTIONS) {
    await new Promise<void>((resolve) => extractionWaiters.push(resolve));
  }
  activeExtractions += 1;
  try {
    return await task();
  } finally {
    activeExtractions -= 1;
    extractionWaiters.shift()?.();
  }
}

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

/**
 * A finite, positive duration for the video, or null. Some MP4/WebM (and many MediaRecorder/blob sources —
 * the very clips that play fine in the viewer) report `duration === Infinity` from metadata alone; seeking
 * past the end forces the browser to compute the true duration (`durationchange`/`timeupdate` then fires).
 * Mirrors EditorPage.readMediaMetadata so the filmstrip/poster agree with the clip's real length.
 */
function resolveDuration(video: HTMLVideoElement, timeoutMs = 4000): Promise<number | null> {
  if (Number.isFinite(video.duration) && video.duration > 0) return Promise.resolve(video.duration);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("timeupdate", onDuration);
      clearTimeout(timer);
      resolve(value);
    };
    const onDuration = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) finish(video.duration);
    };
    video.addEventListener("durationchange", onDuration);
    video.addEventListener("timeupdate", onDuration);
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      video.currentTime = 1e101; // overshoot → browser clamps to the real end and reports duration
    } catch {
      finish(null);
    }
  });
}

/** Dev-only: surface WHY a filmstrip/poster failed (the extractor otherwise swallows every error silently). */
function warnExtract(kind: string, url: string, reason: unknown): void {
  if (import.meta.env?.DEV) {
    console.warn(`[videoThumbnails] ${kind} failed for ${url.slice(0, 80)}:`, reason);
  }
}

export async function getVideoThumbnails(url: string, count = FRAME_COUNT): Promise<string[] | null> {
  if (!url) return null;
  const cached = cache.get(url);
  if (cached) return cached;
  const pending = inflight.get(url);
  if (pending) return pending;

  const task = withExtractionSlot(async () => {
    let video: HTMLVideoElement | null = null;
    try {
      if (typeof document === "undefined") return null;
      video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      // `metadata` (not `auto`): seeking fetches just the needed byte ranges instead of streaming the whole
      // 1080p file, so the connection frees fast. Longer metadata timeout — even queued, a large mp4's first
      // moov/metadata fetch can be slow.
      video.preload = "metadata";
      video.src = url;
      await waitFor(video, "loadedmetadata", 20000);
      const duration = await resolveDuration(video);
      if (duration == null) {
        warnExtract("thumbnails", url, "no finite duration (stream/unseekable source)");
        return null;
      }

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
        // toDataURL throws a SecurityError if the canvas is tainted (asset served without CORS) — surfaced
        // by warnExtract below so a cross-origin asset failure is diagnosable, not a silent blank strip.
        thumbs.push(canvas.toDataURL("image/jpeg", 0.6));
      }
      cache.set(url, thumbs);
      return thumbs;
    } catch (err) {
      warnExtract("thumbnails", url, err);
      return null;
    } finally {
      if (video) {
        video.removeAttribute("src");
        video.load();
      }
      inflight.delete(url);
    }
  });
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

  const task = withExtractionSlot(async () => {
    let video: HTMLVideoElement | null = null;
    try {
      if (typeof document === "undefined") return null;
      video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      // `metadata` (not `auto`): seeking fetches just the needed byte ranges instead of streaming the whole
      // 1080p file, so the connection frees fast. Longer metadata timeout — even queued, a large mp4's first
      // moov/metadata fetch can be slow.
      video.preload = "metadata";
      video.src = url;
      await waitFor(video, "loadedmetadata", 20000);
      const duration = await resolveDuration(video);
      if (duration == null) {
        warnExtract("poster", url, "no finite duration (stream/unseekable source)");
        return null;
      }

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
    } catch (err) {
      warnExtract("poster", url, err);
      return null;
    } finally {
      if (video) {
        video.removeAttribute("src");
        video.load();
      }
      posterInflight.delete(key);
    }
  });
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
