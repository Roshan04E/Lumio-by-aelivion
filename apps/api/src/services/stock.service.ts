import type { StockOrientation, StockResult, StockVariant } from "@orreris/shared";
import { env } from "../config/env";
import { HttpError } from "../lib/http";

// Provider identity is INTERNAL ONLY — never surfaced in API responses or the UI (one unified Search
// surface). `StockProvider` stays a single-member union today; the registry pattern here is what makes
// adding a second source (e.g. Unsplash) additive later rather than a rewrite.
export type StockProvider = "pexels";
export type StockMediaType = "image" | "video";

/** Results per page — shared with the search response so the UI knows when to show "Load more". */
export const STOCK_PER_PAGE = 24;

export function isStockProvider(value: string): value is StockProvider {
  return value === "pexels";
}

export function stockProviderConfigured(provider: StockProvider): boolean {
  return provider === "pexels" && Boolean(env.PEXELS_API_KEY);
}

function requireKey(provider: StockProvider): string {
  const key = provider === "pexels" ? env.PEXELS_API_KEY : undefined;
  if (!key) {
    throw new HttpError(501, "Stock search is not configured. Add PEXELS_API_KEY to enable it.");
  }
  return key;
}

/** Map a resolution to a friendly quality label (uses the long edge so portrait clips read right). */
function resolutionLabel(width?: number | null, height?: number | null): string {
  const longEdge = Math.max(width ?? 0, height ?? 0);
  if (longEdge >= 3840) return "4K";
  if (longEdge >= 2560) return "2K";
  if (longEdge >= 1920) return "1080p";
  if (longEdge >= 1280) return "720p";
  if (longEdge >= 640) return "540p";
  return "SD";
}

/** Keep one variant per quality label (best-first list already sorted), so the picker stays short. */
function dedupeVariants(variants: StockVariant[]): StockVariant[] {
  const seen = new Set<string>();
  return variants.filter((variant) => {
    if (seen.has(variant.label)) return false;
    seen.add(variant.label);
    return true;
  });
}

// --- Pexels ---------------------------------------------------------------------

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  src: { original: string; large2x: string; large: string; medium: string; tiny: string };
}

interface PexelsVideoFile {
  link: string;
  quality: string;
  width: number | null;
  height: number | null;
  file_type: string;
}

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  user: { name: string };
  video_files: PexelsVideoFile[];
}

/** Pexels accepts orientation natively (landscape/portrait/square). */
function pexelsOrientationParam(orientation: StockOrientation): string {
  switch (orientation) {
    case "horizontal":
      return "&orientation=landscape";
    case "vertical":
      return "&orientation=portrait";
    case "square":
      return "&orientation=square";
    default:
      return "";
  }
}

async function searchPexels(query: string, type: StockMediaType, page: number, orientation: StockOrientation): Promise<StockResult[]> {
  const key = requireKey("pexels");
  const orientationParam = pexelsOrientationParam(orientation);
  if (type === "video") {
    const res = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${STOCK_PER_PAGE}&page=${page}${orientationParam}`,
      { headers: { Authorization: key } }
    );
    if (!res.ok) throw new HttpError(502, `Pexels error (${res.status})`);
    const data = (await res.json()) as { videos: PexelsVideo[] };
    return data.videos.map((video) => {
      const files = [...video.video_files]
        .filter((file) => file.link)
        .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
      const variants = dedupeVariants(
        files.map((file) => ({
          label: resolutionLabel(file.width, file.height),
          downloadUrl: file.link,
          fileType: file.file_type || "video/mp4",
          width: file.width ?? undefined,
          height: file.height ?? undefined,
          quality: file.quality
        }))
      );
      const best = files[0];
      const smallest = files[files.length - 1];
      return {
        provider: "pexels",
        externalId: String(video.id),
        type: "video",
        thumbnailUrl: video.image,
        previewUrl: smallest?.link ?? best?.link,
        downloadUrl: best?.link ?? "",
        width: best?.width ?? video.width,
        height: best?.height ?? video.height,
        durationSeconds: video.duration,
        author: video.user?.name,
        sourceUrl: video.url,
        fileType: best?.file_type ?? "video/mp4",
        variants
      } satisfies StockResult;
    });
  }
  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${STOCK_PER_PAGE}&page=${page}${orientationParam}`,
    { headers: { Authorization: key } }
  );
  if (!res.ok) throw new HttpError(502, `Pexels error (${res.status})`);
  const data = (await res.json()) as { photos: PexelsPhoto[] };
  return data.photos.map((photo) => ({
    provider: "pexels",
    externalId: String(photo.id),
    type: "image",
    thumbnailUrl: photo.src.medium,
    downloadUrl: photo.src.original,
    width: photo.width,
    height: photo.height,
    author: photo.photographer,
    sourceUrl: photo.url,
    fileType: "image/jpeg",
    variants: [
      { label: "Original", downloadUrl: photo.src.original, fileType: "image/jpeg", width: photo.width, height: photo.height },
      { label: "Large", downloadUrl: photo.src.large2x, fileType: "image/jpeg" }
    ]
  }));
}

export async function searchStock(
  provider: StockProvider,
  query: string,
  type: StockMediaType,
  page: number,
  orientation: StockOrientation = "all"
): Promise<StockResult[]> {
  if (!query.trim()) return [];
  return searchPexels(query, type, page, orientation);
}

/**
 * Download a stock media URL into a Buffer + filename, ready for saveBuffer().
 *
 * Resilient to the CDN closing the connection mid-stream (large 4K videos), which surfaced as an
 * uncaught undici `TypeError: terminated` (`UND_ERR_SOCKET: other side closed`). Adds a per-attempt
 * timeout (so a stalled transfer can't hang the request), one retry on a network drop, and a clean
 * `HttpError` on final failure so the client gets a useful message instead of a raw 500.
 */
export async function downloadStockMedia(downloadUrl: string, externalId: string, type: StockMediaType) {
  if (!downloadUrl) throw new HttpError(400, "Missing download URL");
  const ext = type === "video" ? "mp4" : "jpg";
  const maxAttempts = 2;
  const timeoutMs = 120_000; // large videos can be slow; abort a stalled download rather than hang
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(downloadUrl, { signal: controller.signal });
      if (!res.ok) {
        // CDN 5xx (Pexels' edge throws transient 502/503s on large videos) → retry once like a
        // network drop. 4xx (404/403) is definitive — surface immediately.
        if (res.status >= 500 && attempt < maxAttempts) {
          lastError = new Error(`upstream ${res.status}`);
          continue;
        }
        throw new HttpError(502, `The stock provider's CDN refused the download (${res.status}). Try again, or pick a lower-resolution variant.`);
      }
      const arrayBuffer = await res.arrayBuffer();
      return { buffer: Buffer.from(arrayBuffer), fileName: `stock-${externalId}.${ext}` };
    } catch (error) {
      if (error instanceof HttpError) throw error; // status error → don't retry
      lastError = error; // network drop / timeout / "terminated" → retry once
    } finally {
      clearTimeout(timer);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : "connection closed";
  throw new HttpError(
    502,
    `Stock download was interrupted (${reason}). Please retry, or pick a lower-resolution variant.`
  );
}
