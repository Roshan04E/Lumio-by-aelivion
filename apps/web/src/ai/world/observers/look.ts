/**
 * Orreris OS observer — visual look (L1, cheap). Samples a few frames of a video/image asset
 * into a small canvas and measures luma distribution, contrast spread, warm/cool balance and
 * saturation — the footage facts a grade planner needs BEFORE it decides anything ("already
 * dark → don't lower exposure"). Deliberately the cheapest sufficient fidelity: 3 sampled
 * frames at 96px wide, never a full scan (ORRERIS_OS.md fidelity ladder).
 *
 * Local-first: resolves bytes from the on-device blob store first (same as playback), falling
 * back to the asset's proxy/file URL. DOM-only — `signature()` returns null under node, so
 * the query planner simply skips this path in eval.
 */

import { getAssetBlobStore } from "../../../lib/asset-blob-store";
import type { WorldContext, WorldObserver, WorldTarget } from "../types";
import { fnv1a } from "../types";

export const MEDIA_LOOK_FACT = "media.look";

export interface MediaLookFact {
  /** 0..1 mean luma. */
  avgLuma: number;
  /** p95 − p5 luma spread, 0..1 — a cheap contrast proxy. */
  contrast: number;
  /** Mean (R−B)/255, −1..1: positive = warm, negative = cool. */
  temperature: number;
  /** 0..1 mean per-pixel (max−min)/max. */
  saturation: number;
  exposure: "dark" | "balanced" | "bright";
  framesSampled: number;
}

const SAMPLE_WIDTH = 96;
/** Fractions into the source duration sampled for video. */
const SAMPLE_POINTS = [0.1, 0.5, 0.9];
const LOAD_TIMEOUT_MS = 8_000;

function assetFor(target: WorldTarget, ctx: WorldContext) {
  if (target.kind !== "asset") {
    return undefined;
  }
  const asset = ctx.assets.find((item) => item.id === target.id);
  if (!asset) {
    return undefined;
  }
  const kind = asset.fileType.split("/")[0];
  return kind === "video" || kind === "image" ? asset : undefined;
}

export const lookObserver: WorldObserver = {
  id: "look-histogram@builtin",
  version: 1,
  factTypes: [MEDIA_LOOK_FACT],
  fidelity: 1,
  estCostMs: 1_500,
  estConfidence: 0.9,
  signature(target, ctx) {
    if (typeof document === "undefined") {
      return null; // no DOM (eval/node) — this access path doesn't exist here
    }
    const asset = assetFor(target, ctx);
    if (!asset) {
      return null;
    }
    // Byte-hash stand-in: asset bytes are write-once in the blob store, so identity+size+
    // updatedAt is an honest signature until real content hashing lands (K2).
    return fnv1a([asset.id, asset.sizeBytes ?? "", asset.updatedAt ?? "", asset.durationSeconds].join("|"));
  },
  async observe(target, ctx) {
    const asset = assetFor(target, ctx);
    if (!asset) {
      return [];
    }
    const localUrl = await (await getAssetBlobStore()).getObjectUrl(asset.id);
    const url = localUrl ?? asset.proxyUrl ?? asset.previewUrl ?? asset.fileUrl;
    if (!url) {
      return [];
    }
    const isVideo = asset.fileType.startsWith("video/");
    const samples = isVideo ? await sampleVideo(url, asset.durationSeconds) : await sampleImage(url);
    if (samples.frames.length === 0) {
      return [];
    }
    const value = measure(samples.frames);
    return [
      {
        type: MEDIA_LOOK_FACT,
        value,
        // Full confidence would require a full scan; 3 frames is honest at 0.85–0.9.
        confidence: isVideo ? 0.85 : 0.95,
        sampledRanges: samples.ranges
      }
    ];
  }
};

interface SampleSet {
  frames: ImageData[];
  ranges: Array<[number, number]>;
}

function drawToImageData(source: CanvasImageSource, width: number, height: number): ImageData | null {
  const scale = SAMPLE_WIDTH / Math.max(1, width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  try {
    context.drawImage(source, 0, 0, w, h);
    return context.getImageData(0, 0, w, h);
  } catch {
    return null; // CORS taint on a remote asset — decline rather than guess
  }
}

async function sampleVideo(url: string, durationSeconds: number): Promise<SampleSet> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.src = url;
  const frames: ImageData[] = [];
  const ranges: Array<[number, number]> = [];
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("video load failed"));
      }),
      LOAD_TIMEOUT_MS
    );
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : durationSeconds;
    for (const point of SAMPLE_POINTS) {
      const t = Math.min(Math.max(duration * point, 0), Math.max(duration - 0.05, 0));
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          video.onseeked = () => resolve();
          video.onerror = () => reject(new Error("video seek failed"));
          video.currentTime = t;
        }),
        LOAD_TIMEOUT_MS
      );
      const frame = drawToImageData(video, video.videoWidth, video.videoHeight);
      if (frame) {
        frames.push(frame);
        ranges.push([t, t]);
      }
    }
  } catch {
    // Partial samples are still usable; zero samples → the caller declines.
  } finally {
    video.removeAttribute("src");
    video.load();
  }
  return { frames, ranges };
}

async function sampleImage(url: string): Promise<SampleSet> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("image load failed"));
      }),
      LOAD_TIMEOUT_MS
    );
  } catch {
    return { frames: [], ranges: [] };
  }
  const frame = drawToImageData(image, image.naturalWidth, image.naturalHeight);
  return frame ? { frames: [frame], ranges: [[0, 0]] } : { frames: [], ranges: [] };
}

function measure(frames: ImageData[]): MediaLookFact {
  const lumaHistogram = new Array<number>(256).fill(0);
  let pixelCount = 0;
  let lumaSum = 0;
  let rSum = 0;
  let bSum = 0;
  let saturationSum = 0;
  for (const frame of frames) {
    const data = frame.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const luma = Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
      lumaHistogram[luma] = (lumaHistogram[luma] ?? 0) + 1;
      lumaSum += luma;
      rSum += r;
      bSum += b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      saturationSum += max > 0 ? (max - min) / max : 0;
      pixelCount += 1;
    }
  }
  const percentile = (p: number): number => {
    const threshold = pixelCount * p;
    let cumulative = 0;
    for (let i = 0; i < 256; i += 1) {
      cumulative += lumaHistogram[i]!;
      if (cumulative >= threshold) {
        return i / 255;
      }
    }
    return 1;
  };
  const avgLuma = pixelCount > 0 ? lumaSum / pixelCount / 255 : 0;
  const contrast = Math.max(0, percentile(0.95) - percentile(0.05));
  const temperature = pixelCount > 0 ? (rSum - bSum) / pixelCount / 255 : 0;
  const saturation = pixelCount > 0 ? saturationSum / pixelCount : 0;
  return {
    avgLuma,
    contrast,
    temperature,
    saturation,
    exposure: avgLuma < 0.3 ? "dark" : avgLuma > 0.62 ? "bright" : "balanced",
    framesSampled: frames.length
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
