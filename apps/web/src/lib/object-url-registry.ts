/**
 * `blob:` URL → the Blob behind it, without a copy.
 *
 * WHY THIS EXISTS (DEBT-019). There is no web API to get a Blob back from an object URL. The only
 * way is `fetch(url).blob()`, and that is NOT a handle pass-through — it is a full disk→RAM copy.
 * Measured: holding six OPFS `File`s of 32 MB costs 204 MB, and holding `fetch(objectURL).blob()`
 * of the same six costs 430 MB — **+226 MB of resident RAM for 192 MB of files**, bought for
 * nothing, because the originals were already disk-backed and already sliceable on demand.
 *
 * That copy was the whole of DEBT-019's duration-scaling term for local media: a 2-minute source
 * held ~86.5 MB of RAM where a 3-second one held ~4.9 MB, purely as a function of file length.
 * An OPFS/IndexedDB `File` has no such term — the bytes stay on disk and `blob.slice()` reads the
 * window it needs, which is exactly what the decoder's chunk window already asks for.
 *
 * So: record the Blob at the ONE place each object URL is minted, and let consumers ask for it
 * back. The registry is not a cache and adds no residency of its own — the object URL already
 * pins its Blob in the browser's blob storage for exactly as long as the entry lives, and for
 * disk-backed sources "pinning" is a file handle, not bytes. Entries die with their URL.
 *
 * This is deliberately NOT a general-purpose Blob cache. It answers one question — "do we already
 * have the bytes behind this URL?" — and answers `null` when it does not, so every caller keeps
 * its existing fetch path for remote sources.
 */

/**
 * url → backing Blob. Strong refs by design: the mapping must live exactly as long as the object
 * URL does, and `URL.revokeObjectURL` is not observable, so revocation has to come through the
 * paired helper below. A leaked entry costs one Map slot and a handle, not the file's bytes.
 */
const backing = new Map<string, Blob>();

/** `URL.createObjectURL`, remembering what the URL points at. Use wherever media URLs are minted. */
export function createTrackedObjectUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  backing.set(url, blob);
  return url;
}

/** `URL.revokeObjectURL` plus registry cleanup. Pair with `createTrackedObjectUrl`. */
export function revokeTrackedObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
  backing.delete(url);
}

/**
 * The Blob behind an object URL, or null when unknown (remote http(s) URLs, URLs minted before
 * this registry, or URLs from another realm — a Worker cannot see the main thread's registrations).
 * Callers MUST treat null as "fetch it yourself" rather than an error.
 */
export function resolveObjectUrlBlob(url: string): Blob | null {
  if (!url.startsWith("blob:")) return null;
  return backing.get(url) ?? null;
}

/** Registered-entry count. Diagnostics only (probes assert the pass-through actually engaged). */
export function trackedObjectUrlCount(): number {
  return backing.size;
}
