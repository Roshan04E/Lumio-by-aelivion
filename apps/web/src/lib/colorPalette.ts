import type { SourceAsset } from "@lumio-by-aelivion/shared";

export type EyeDropperConstructor = new () => {
  open: () => Promise<{ sRGBHex: string }>;
};

export const defaultColorPalette = ["#4D9FFF", "#F4F4F5", "#A1A1AA", "#27272A", "#161618"];

export function toInputColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
}

export function hasNativeEyeDropper(): boolean {
  return typeof globalThis !== "undefined" && Boolean((globalThis as typeof globalThis & { EyeDropper?: unknown }).EyeDropper);
}

/**
 * Pick a color from anywhere on screen.
 * Prefers the native EyeDropper API (Chromium, secure context). Falls back to a
 * screen-capture picker that works in any browser that supports getDisplayMedia:
 * the user shares a screen/window, we freeze a frame, and they click the pixel
 * they want. Returns null if unsupported or cancelled.
 */
export async function pickColorFromScreen(): Promise<string | null> {
  const EyeDropper = (globalThis as typeof globalThis & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  if (EyeDropper) {
    try {
      const result = await new EyeDropper().open();
      return result.sRGBHex;
    } catch {
      return null; // user cancelled
    }
  }
  return pickColorFromDisplayCapture();
}

async function pickColorFromDisplayCapture(): Promise<string | null> {
  const media = navigator.mediaDevices;
  if (!media?.getDisplayMedia) {
    return null;
  }

  let stream: MediaStream;
  try {
    stream = await media.getDisplayMedia({ video: true, audio: false });
  } catch {
    return null; // user declined the share prompt
  }

  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  try {
    await video.play();
  } catch {
    // some browsers resolve metadata without an explicit play
  }
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
    });
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  stream.getTracks().forEach((track) => track.stop());
  if (!context || !canvas.width || !canvas.height) {
    return null;
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  return new Promise<string | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:#000;cursor:crosshair;";
    canvas.style.cssText = "max-width:100vw;max-height:100vh;width:auto;height:auto;display:block;";

    const hint = document.createElement("div");
    hint.textContent = "Click a pixel to pick its color  •  Esc to cancel";
    hint.style.cssText =
      "position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:rgba(20,21,27,0.92);color:#fff;font:600 13px system-ui,sans-serif;pointer-events:none;";

    overlay.appendChild(canvas);
    overlay.appendChild(hint);
    document.body.appendChild(overlay);

    const cleanup = () => {
      overlay.remove();
      window.removeEventListener("keydown", onKey);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cleanup();
        resolve(null);
      }
    };
    window.addEventListener("keydown", onKey);

    canvas.addEventListener("click", (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.round(((event.clientX - rect.left) / rect.width) * canvas.width);
      const y = Math.round(((event.clientY - rect.top) / rect.height) * canvas.height);
      const px = context.getImageData(
        Math.min(canvas.width - 1, Math.max(0, x)),
        Math.min(canvas.height - 1, Math.max(0, y)),
        1,
        1
      ).data;
      cleanup();
      resolve(rgbToHex(px[0] ?? 0, px[1] ?? 0, px[2] ?? 0));
    });
  });
}

export async function extractPaletteFromAsset(asset: SourceAsset) {
  const pixels = asset.fileType.startsWith("image/") ? await sampleImagePixels(asset.fileUrl) : await sampleVideoPixels(asset.fileUrl);
  return buildPaletteFromPixels(pixels);
}

async function sampleImagePixels(src: string) {
  const image = new window.Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.src = src;
  await image.decode();
  return sampleDrawablePixels(image, image.naturalWidth, image.naturalHeight);
}

async function sampleVideoPixels(src: string) {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = src;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("Unable to load video palette source")), { once: true });
  });
  video.currentTime = Math.min(1, Math.max(0, (video.duration || 2) * 0.15));
  await new Promise<void>((resolve) => {
    video.addEventListener("seeked", () => resolve(), { once: true });
  });
  return sampleDrawablePixels(video, video.videoWidth, video.videoHeight);
}

function sampleDrawablePixels(source: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement("canvas");
  const size = 96;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !width || !height) {
    return new Uint8ClampedArray();
  }

  const scale = Math.max(size / width, size / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  context.drawImage(source, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);
  return context.getImageData(0, 0, size, size).data;
}

function buildPaletteFromPixels(pixels: Uint8ClampedArray) {
  const buckets = new Map<string, { r: number; g: number; b: number; count: number; score: number }>();
  for (let index = 0; index < pixels.length; index += 16) {
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    const a = pixels[index + 3] ?? 0;
    if (a < 180) continue;

    const hsl = rgbToHsl(r, g, b);
    if (hsl.lightness < 0.08 || hsl.lightness > 0.94 || hsl.saturation < 0.04) continue;

    const key = `${Math.round(r / 24)}:${Math.round(g / 24)}:${Math.round(b / 24)}`;
    const chromaPreference = 1 - Math.abs(hsl.saturation - 0.38);
    const tonePreference = 1 - Math.abs(hsl.lightness - 0.48);
    const score = Math.max(0.1, chromaPreference * 0.58 + tonePreference * 0.42);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
      bucket.score += score;
    } else {
      buckets.set(key, { r, g, b, count: 1, score });
    }
  }

  const candidates = [...buckets.values()]
    .map((bucket) => ({
      color: rgbToHex(Math.round(bucket.r / bucket.count), Math.round(bucket.g / bucket.count), Math.round(bucket.b / bucket.count)),
      score: bucket.count * bucket.score
    }))
    .sort((a, b) => b.score - a.score);

  const palette: string[] = [];
  for (const candidate of candidates) {
    if (palette.every((color) => colorDistance(color, candidate.color) > 42)) {
      palette.push(candidate.color);
    }
    if (palette.length === 5) break;
  }

  return [...palette, ...defaultColorPalette].slice(0, 5);
}

function rgbToHsl(r: number, g: number, b: number) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { saturation, lightness };
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(a: string, b: string) {
  const left = hexToRgb(a);
  const right = hexToRgb(b);
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}

function hexToRgb(color: string) {
  const value = color.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16)
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
