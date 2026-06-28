import type { StockOrientation, StockResult, StockVariant } from "@reelforge/shared";
import { env } from "../config/env";
import { HttpError } from "../lib/http";

export type StockProvider = "pexels" | "pixabay";
export type StockMediaType = "image" | "video";

/** Results per page — shared with the search response so the UI knows when to show "Load more". */
export const STOCK_PER_PAGE = 24;

export function isStockProvider(value: string): value is StockProvider {
  return value === "pexels" || value === "pixabay";
}

export function stockProviderConfigured(provider: StockProvider): boolean {
  return provider === "pexels" ? Boolean(env.PEXELS_API_KEY) : Boolean(env.PIXABAY_API_KEY);
}

function requireKey(provider: StockProvider): string {
  const key = provider === "pexels" ? env.PEXELS_API_KEY : env.PIXABAY_API_KEY;
  if (!key) {
    throw new HttpError(
      501,
      `${provider} is not configured. Add ${provider === "pexels" ? "PEXELS_API_KEY" : "PIXABAY_API_KEY"} to enable stock import.`
    );
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

function orientationOf(width?: number | null, height?: number | null): StockOrientation {
  const w = width ?? 0;
  const h = height ?? 0;
  if (!w || !h) return "all";
  const ratio = w / h;
  if (ratio > 1.15) return "horizontal";
  if (ratio < 0.87) return "vertical";
  return "square";
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

// --- Pixabay --------------------------------------------------------------------

interface PixabayImage {
  id: number;
  webformatURL: string;
  largeImageURL: string;
  previewURL: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  pageURL: string;
}

interface PixabayVideoVariant {
  url: string;
  width: number;
  height: number;
}

interface PixabayVideo {
  id: number;
  duration: number;
  pageURL: string;
  user: string;
  videos: { large?: PixabayVideoVariant; medium?: PixabayVideoVariant; small?: PixabayVideoVariant };
}

async function searchPixabay(query: string, type: StockMediaType, page: number, orientation: StockOrientation): Promise<StockResult[]> {
  const key = requireKey("pixabay");
  if (type === "video") {
    const res = await fetch(
      `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=${STOCK_PER_PAGE}&page=${page}`
    );
    if (!res.ok) throw new HttpError(502, `Pixabay error (${res.status})`);
    const data = (await res.json()) as { hits: PixabayVideo[] };
    const results = data.hits.map((hit) => {
      const ordered = [hit.videos.large, hit.videos.medium, hit.videos.small].filter(
        (variant): variant is PixabayVideoVariant => Boolean(variant?.url)
      );
      const variants = dedupeVariants(
        ordered.map((variant) => ({
          label: resolutionLabel(variant.width, variant.height),
          downloadUrl: variant.url,
          fileType: "video/mp4",
          width: variant.width,
          height: variant.height
        }))
      );
      const best = ordered[0];
      const smallest = ordered[ordered.length - 1];
      return {
        provider: "pixabay",
        externalId: String(hit.id),
        type: "video",
        thumbnailUrl: `https://i.vimeocdn.com/video/${hit.id}_295x166.jpg`,
        previewUrl: smallest?.url ?? best?.url,
        downloadUrl: best?.url ?? "",
        width: best?.width ?? 1920,
        height: best?.height ?? 1080,
        durationSeconds: hit.duration,
        author: hit.user,
        sourceUrl: hit.pageURL,
        fileType: "video/mp4",
        variants
      } satisfies StockResult;
    });
    // Pixabay has no orientation filter — narrow by aspect ratio of the best variant.
    return filterByOrientation(results, orientation);
  }
  const res = await fetch(
    `https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(query)}&image_type=photo&per_page=${STOCK_PER_PAGE}&page=${page}`
  );
  if (!res.ok) throw new HttpError(502, `Pixabay error (${res.status})`);
  const data = (await res.json()) as { hits: PixabayImage[] };
  const results = data.hits.map((hit) => ({
    provider: "pixabay" as const,
    externalId: String(hit.id),
    type: "image" as const,
    thumbnailUrl: hit.webformatURL ?? hit.previewURL,
    downloadUrl: hit.largeImageURL ?? hit.webformatURL,
    width: hit.imageWidth,
    height: hit.imageHeight,
    author: hit.user,
    sourceUrl: hit.pageURL,
    fileType: "image/jpeg",
    variants: [
      { label: "Large", downloadUrl: hit.largeImageURL ?? hit.webformatURL, fileType: "image/jpeg", width: hit.imageWidth, height: hit.imageHeight },
      { label: "Web", downloadUrl: hit.webformatURL, fileType: "image/jpeg" }
    ]
  }));
  return filterByOrientation(results, orientation);
}

function filterByOrientation(results: StockResult[], orientation: StockOrientation): StockResult[] {
  if (orientation === "all") return results;
  return results.filter((result) => orientationOf(result.width, result.height) === orientation);
}

export async function searchStock(
  provider: StockProvider,
  query: string,
  type: StockMediaType,
  page: number,
  orientation: StockOrientation = "all"
): Promise<StockResult[]> {
  if (!query.trim()) return [];
  return provider === "pexels"
    ? searchPexels(query, type, page, orientation)
    : searchPixabay(query, type, page, orientation);
}

/** Download a stock media URL into a Buffer + filename, ready for saveBuffer(). */
export async function downloadStockMedia(downloadUrl: string, externalId: string, type: StockMediaType) {
  if (!downloadUrl) throw new HttpError(400, "Missing download URL");
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new HttpError(502, `Failed to download stock media (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  const ext = type === "video" ? "mp4" : "jpg";
  return { buffer: Buffer.from(arrayBuffer), fileName: `stock-${externalId}.${ext}` };
}
