/**
 * ADR-023 D3 — the EDITOR half: install what we can, and surface what we cannot.
 *
 * The worker's rule is "abort by name". The editor's is deliberately the opposite, and D3 spends a
 * paragraph on why: an editor that renders nothing because one font of forty is missing has turned a
 * small problem into a stopped session. So the preview substitutes — and says so, loudly, on the
 * layer and in a project banner, reusing the `needs-relink` vocabulary this repo already has for
 * assets (`sync.ts:92`). The hard fail lands at the action that produces a deliverable: export is
 * blocked until the font is resolved.
 *
 * The failure mode this exists to prevent is the warp-catalogue incident: wrong pixels that look
 * like a working feature. A substitution nobody is told about is exactly that.
 */
import {
  collectPinnedFontRefs,
  fontLoadSpec,
  fontObjectKey,
  fontStoreKeyFor,
  isPinnedFontRef,
  type CompositionLayerStyleInput,
  type FontRef,
  type PinnedFontRef
} from "@orreris/shared";
import { readLocalUserFont } from "./user-fonts";

/** Per-font outcome. `undefined` for a family means "never asked for" — not "fine". */
export type FontInstallState = "installed" | "missing";

const installs = new Map<string, Promise<FontInstallState>>();
const states = new Map<string, FontInstallState>();
const listeners = new Set<() => void>();

/** Where the API serves stored objects. Same base the asset pipeline already uses. */
function storageUrl(relativeKey: string): string {
  const base = (import.meta.env?.VITE_API_URL as string | undefined) ?? "http://localhost:4100";
  return `${base.replace(/\/+$/, "")}/storage/${relativeKey}`;
}

export function fontRefInstallKey(ref: PinnedFontRef): string {
  return `${ref.source}|${ref.fileHash}|${ref.weight}|${ref.style}`;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Install one pinned font, once per process.
 *
 * Memoized on the ref key rather than the family: two projects pinning different hashes of "Inter
 * 700" are two different faces (D1), and collapsing them here would silently serve one project the
 * other's outlines — the same mistake at runtime that D4 forbids in storage.
 */
export function installPinnedFont(ref: PinnedFontRef): Promise<FontInstallState> {
  const key = fontRefInstallKey(ref);
  const existing = installs.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<FontInstallState> => {
    // D4/T-3: discriminate on the store to get a location. There is no generic "URL of a font".
    const storeKey = fontStoreKeyFor(ref);
    if (!storeKey) return "missing";
    let source: string;
    let revoke: (() => void) | undefined;
    try {
      /**
       * ADR-023 D4 (S3) — **the two stores are fetched two ways, and it is not an optimisation.**
       *
       * A catalogue face is public by licence, so it is a plain URL and the browser can load it
       * directly. A per-user face is not: its key is content-addressed, so two accounts holding the
       * same commercial font produce the same hash, and the only thing keeping account B out is a
       * bearer token the server checks. `new FontFace(url)` cannot send one — font loads carry no
       * custom headers — so the bytes are fetched explicitly and handed over as a blob.
       *
       * That asymmetry is why this switch exists rather than a shared `urlOf(key)` helper: T-3 says
       * no function may resolve a font to bytes without discriminating on the store, and a helper
       * returning "the URL of a font" would be exactly the shared supertype D4 forbids.
       */
      switch (storeKey.store) {
        case "catalogue":
          source = `url(${storageUrl(fontObjectKey(storeKey))})`;
          break;
        case "user": {
          /**
           * LOCAL FIRST (D5). The bytes of a font this account uploaded are on this device already,
           * and reading them from OPFS means an uploaded font works with no network and before any
           * opt-in cloud upload has happened — which is the whole shape of the asset doctrine this
           * reuses. The server is the fallback, for a second machine or a cleared profile.
           */
          const local = await readLocalUserFont(storeKey.ownerId, storeKey.fileHash);
          if (local) {
            const url = URL.createObjectURL(local);
            revoke = () => URL.revokeObjectURL(url);
            source = `url(${url})`;
            break;
          }
          const token = localStorage.getItem("orreris_token");
          if (!token) return "missing";
          const response = await fetch(storageUrl(fontObjectKey(storeKey)), { headers: { Authorization: `Bearer ${token}` } });
          // A 404 here is the server refusing, and it is deliberately indistinguishable from the
          // font not existing — see the /storage guard. Either way this account cannot have it.
          if (!response.ok) return "missing";
          const url = URL.createObjectURL(await response.blob());
          revoke = () => URL.revokeObjectURL(url);
          source = `url(${url})`;
          break;
        }
        default: {
          const unreachable: never = storeKey;
          return unreachable;
        }
      }
      const face = new FontFace(ref.family, source, {
        weight: String(ref.weight),
        style: ref.style
      });
      await face.load();
      document.fonts.add(face);
      // Loading the FACE is not the same as the canvas being able to use it: the raster both
      // renderers draw through resolves fonts by shorthand, so ask for the shorthand too.
      await document.fonts.load(fontLoadSpec({ family: ref.family, weight: ref.weight, style: ref.style, src: "" }));
      return "installed";
    } catch {
      // No rethrow, and no console noise pretending to be a report. The state IS the report — it
      // drives the layer marker and the banner, which is what D3 asks for.
      return "missing";
    } finally {
      // `FontFace.load()` has read the blob by now, so the object URL has done its job. Released
      // here rather than left to the page's lifetime: a session that installs a few dozen user
      // faces would otherwise pin every one of their buffers in memory for nothing.
      revoke?.();
    }
  })();

  installs.set(key, promise);
  void promise.then((state) => {
    states.set(key, state);
    notify();
  });
  return promise;
}

/** Kick off installation for every pinned font a composition needs. Idempotent. */
export function installCompositionFonts(layers: CompositionLayerStyleInput[]): void {
  for (const ref of collectPinnedFontRefs(layers)) void installPinnedFont(ref);
}

/**
 * ADR-023 D8 (S8) — the `@font-face` rule for a pinned face, with the BYTES inlined as a data URI.
 *
 * Path text is drawn by rasterizing an SVG, and an SVG loaded as an image is an isolated document:
 * it cannot see `document.fonts`, cannot follow an HTTP URL, and cannot reach a blob URL from this
 * page. The face has to be inside the document, so the bytes have to be read.
 *
 * Memoized per ref key for `installPinnedFont`'s reason, restated because it is the same hazard:
 * two projects pinning different hashes of "Inter 700" are two different faces (D1), and keying this
 * by family would serve one project the other's outlines.
 *
 * Returns `undefined` when the bytes cannot be had — which the raster treats as a REFUSAL to draw
 * the curve, not as permission to draw it in a fallback (D3/T-2).
 */
const faceCssCache = new Map<string, Promise<string | undefined>>();

/**
 * The `OverlayStyleOptions.resolveFontFaceCss` the editor's three raster consumers hand the shared
 * draw — the preview canvas, the local export compositor, and the DOM overlay's warp/curve image.
 *
 * A `{source: "system"}` ref returns `undefined` and that is not a refusal: a system family resolves
 * by NAME inside an SVG image, so there is nothing to embed. `buildArcTextSvg` only treats the empty
 * string as the refusal, and only a PINNED ref can produce it.
 */
export function resolveFontFaceCss(ref: FontRef): Promise<string | undefined> | undefined {
  return isPinnedFontRef(ref) ? pathTextFontFaceCss(ref) : undefined;
}

export function pathTextFontFaceCss(ref: PinnedFontRef): Promise<string | undefined> {
  const key = fontRefInstallKey(ref);
  const existing = faceCssCache.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<string | undefined> => {
    // T-3 again: the store is discriminated before anything resolves to bytes. This deliberately
    // repeats `installPinnedFont`'s switch rather than sharing a `urlOf(font)` helper, because that
    // helper is precisely the "resolvable URL supertype" D4 forbids.
    const storeKey = fontStoreKeyFor(ref);
    if (!storeKey) return undefined;
    let blob: Blob | undefined;
    try {
      if (storeKey.store === "catalogue") {
        const response = await fetch(storageUrl(fontObjectKey(storeKey)));
        if (!response.ok) return undefined;
        blob = await response.blob();
      } else {
        blob = (await readLocalUserFont(storeKey.ownerId, storeKey.fileHash)) ?? undefined;
        if (!blob) {
          const token = localStorage.getItem("orreris_token");
          if (!token) return undefined;
          const response = await fetch(storageUrl(fontObjectKey(storeKey)), { headers: { Authorization: `Bearer ${token}` } });
          if (!response.ok) return undefined;
          blob = await response.blob();
        }
      }
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buffer.length; i += 1) binary += String.fromCharCode(buffer[i]!);
      const dataUrl = `data:font/ttf;base64,${btoa(binary)}`;
      return (
        `@font-face{font-family:"${ref.family}";font-weight:${ref.weight};font-style:${ref.style};` +
        `src:url(${dataUrl})}`
      );
    } catch {
      return undefined;
    }
  })();
  faceCssCache.set(key, promise);
  return promise;
}

/** Synchronous read of what we know so far — `undefined` while a load is still in flight. */
export function fontInstallState(ref: PinnedFontRef): FontInstallState | undefined {
  return states.get(fontRefInstallKey(ref));
}

/**
 * Every pinned font in a composition that we KNOW is missing.
 *
 * Deliberately excludes in-flight loads: a font that has not finished loading is not yet evidence of
 * anything, and a banner that flashes "missing font" during startup teaches people to ignore it.
 */
export function missingCompositionFonts(layers: CompositionLayerStyleInput[]): PinnedFontRef[] {
  return collectPinnedFontRefs(layers).filter((ref) => states.get(fontRefInstallKey(ref)) === "missing");
}

export function subscribeFontInstalls(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let version = 0;
/** `useSyncExternalStore` snapshot: a monotonic counter, so the store is comparable by identity. */
export function fontInstallVersion(): number {
  return version;
}

/**
 * NOTE on the error type: the export boundary throws `FontResolutionError` from
 * `@orreris/shared` — the SAME class the worker throws — rather than a web-specific sibling. A
 * second, differently-shaped "you must fix something first" error is exactly how one of them ends up
 * unhandled, and D3 wants one vocabulary, not two. `sync.ts`'s `RelinkRequiredError` stays what it
 * is for assets; fonts reuse its shape (named cause, actionable message, blocks the deliverable)
 * without cloning its class.
 */

/** Reset — tests only. */
export function __resetFontInstallsForTest(): void {
  installs.clear();
  states.clear();
}
