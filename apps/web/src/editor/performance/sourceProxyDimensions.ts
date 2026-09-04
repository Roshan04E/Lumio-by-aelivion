/**
 * Proxy geometry — the ONE place that decides what size an ingest proxy is encoded at.
 *
 * A SEPARATE MODULE ON PURPOSE. This is pure arithmetic with no imports, so a test can assert it in
 * milliseconds. Living inside `sourceProxyEngine.ts` it could not be: importing that module pulls in
 * the frame provider, the media encoder and the worker plumbing, which is why the previously-instant
 * copy test hung the moment it imported one function from there.
 *
 * WHY THE NUMBERS MATTER BEYOND THE TRANSCODE. `PROXY_LONG_EDGE` is the reason the WARM decode path can
 * be budgeted in STREAM COUNT while the COLD path cannot: every proxy is normalised to the same long
 * edge, so a 2160x3840 source and a 1080x1920 source both encode to 720x1280 and cost the decoder the
 * same. On the cold path a stream is whatever the source is — 4K carries ~4x the pixels of 1080p — so
 * that budget is expressed in PIXELS instead. Asserted in `sourceProxyNotice.test.ts`.
 */

/** Long edge every proxy is scaled to fit. Recipe-visible: changing it invalidates persisted proxies. */
export const PROXY_LONG_EDGE = 1280;

/** The downscale a source of these dimensions gets. Capped at 1 — a small source is never upscaled. */
export function proxyScaleFor(width: number, height: number): number {
  return Math.min(1, PROXY_LONG_EDGE / Math.max(width, height));
}

/** Dimensions a proxy is encoded at: even (H.264 chroma), never larger than the source. */
export function proxyDimensionsFor(width: number, height: number): { width: number; height: number } {
  const scale = proxyScaleFor(width, height);
  return {
    width: Math.max(2, Math.round((width * scale) / 2) * 2),
    height: Math.max(2, Math.round((height * scale) / 2) * 2)
  };
}
