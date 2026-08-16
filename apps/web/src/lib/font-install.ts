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
  collectPinnedFontInstances,
  fontAxisInstanceFamily,
  fontLoadSpec,
  fontVariationSettingsCss,
  parseFontVariationAxes,
  type FontAxisRange,
  type FontVariationAxes,
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

export function fontRefInstallKey(ref: PinnedFontRef, axes?: FontVariationAxes | undefined): string {
  return `${ref.source}|${ref.fileHash}|${ref.weight}|${ref.style}|${fontVariationSettingsCss(axes) ?? ""}`;
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
export function installPinnedFont(ref: PinnedFontRef, axes?: FontVariationAxes | undefined): Promise<FontInstallState> {
  const key = fontRefInstallKey(ref, axes);
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
      /**
       * ADR-023 S9a — the axis is a REGISTRATION-time descriptor, and an instance is its own family.
       *
       * `variationSettings` here is the browser-side twin of the `font-variation-settings` line the
       * worker writes into its `@font-face` block. It instances the file as the face is built, which
       * is the only route that reaches the canvas raster: canvas 2D exposes no `fontVariationSettings`
       * and `ctx.font` rejects an inline declaration, and since T-13 the raster is where BOTH
       * renderers get their text pixels.
       *
       * ⚠ Do NOT feature-detect this by reading `face.variationSettings` back. It does not reflect —
       * Chromium returns empty for a face that renders the axis correctly — so a detect on the
       * reflected value calls a working API unsupported. Detect by rendering two instances and
       * measuring, or do not detect. Measured in `apps/worker/tmp/oq6-spike.mjs`.
       *
       * With no axis the family is `ref.family` and the descriptor is absent, so this is byte-for-byte
       * the registration that shipped before S9a.
       */
      const settings = fontVariationSettingsCss(axes);
      const family = fontAxisInstanceFamily(ref.family, axes);
      const face = new FontFace(family, source, {
        weight: String(ref.weight),
        style: ref.style,
        ...(settings ? { variationSettings: settings } : {})
      });
      await face.load();
      document.fonts.add(face);
      // Loading the FACE is not the same as the canvas being able to use it: the raster both
      // renderers draw through resolves fonts by shorthand, so ask for the shorthand too.
      await document.fonts.load(fontLoadSpec({ family, weight: ref.weight, style: ref.style, src: "" }));
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
  // Instances, not refs (S9a): a variable file authored at two axis coordinates needs two
  // registrations, and the emitted CSS names the alias of each.
  for (const { ref, axes } of collectPinnedFontInstances(layers)) void installPinnedFont(ref, axes);
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
export function resolveFontFaceCss(
  ref: FontRef,
  instance?: { instanceFamily: string; axisSettings: string | undefined }
): Promise<string | undefined> | undefined {
  return isPinnedFontRef(ref) ? pathTextFontFaceCss(ref, instance) : undefined;
}

/**
 * The BYTES of a pinned face, memoized per FILE.
 *
 * Two consumers now — the path-text `@font-face` below, and S9a's `fvar` read — and keying this by
 * `fileHash` rather than by ref instance is the point: a file's axis ranges and its outlines do not
 * depend on which axis coordinate a layer authored, so several instances share one download.
 */
const fileBytesCache = new Map<string, Promise<Uint8Array | undefined>>();

function fontFileBytes(ref: PinnedFontRef): Promise<Uint8Array | undefined> {
  const key = `${ref.source}|${ref.fileHash}`;
  const existing = fileBytesCache.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<Uint8Array | undefined> => {
    // T-3 again: the store is discriminated before anything resolves to bytes. This deliberately
    // repeats `installPinnedFont`'s switch rather than sharing a `urlOf(font)` helper, because that
    // helper is precisely the "resolvable URL supertype" D4 forbids.
    const storeKey = fontStoreKeyFor(ref);
    if (!storeKey) return undefined;
    try {
      let blob: Blob | undefined;
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
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      return undefined;
    }
  })();
  fileBytesCache.set(key, promise);
  return promise;
}

/**
 * ADR-023 S9a — which axes a pinned FILE actually exposes, for the inspector's controls.
 *
 * Synchronous, and `undefined` means "have not read it yet" rather than "no axes" — the three-valued
 * shape `fontAxisSupport` needs. A control that treated "not read yet" as "no axes" would be
 * disabled for the first seconds of every session, and a control that treated it as "has axes" would
 * put a slider on a static file, which is "no cut, no lie" broken. The read is kicked off here and
 * reported through the same `notify()` the install states use, so the panel re-renders when it lands.
 */
const axesByFile = new Map<string, FontAxisRange[] | undefined>();
const axisReadsStarted = new Set<string>();

export function fontFileAxes(ref: PinnedFontRef): FontAxisRange[] | undefined {
  const key = `${ref.source}|${ref.fileHash}`;
  if (!axisReadsStarted.has(key)) {
    axisReadsStarted.add(key);
    void fontFileBytes(ref).then((bytes) => {
      axesByFile.set(key, bytes ? parseFontVariationAxes(bytes) : undefined);
      notify();
    });
  }
  return axesByFile.get(key);
}

export function pathTextFontFaceCss(
  ref: PinnedFontRef,
  /**
   * S9a. Absent means the base file, which is what every pre-S9a caller wants. When present, the
   * embedded face is registered under the ALIAS the emitted style names and carries the axis
   * descriptor — otherwise the SVG defines "Arimo" while its `<text>` asks for "Arimo ~axis~wght700"
   * and the arc renders in the isolated document's fallback, silently.
   */
  instance?: { instanceFamily: string; axisSettings: string | undefined }
): Promise<string | undefined> {
  const key = `${fontRefInstallKey(ref)}|${instance?.instanceFamily ?? ""}`;
  const existing = faceCssCache.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<string | undefined> => {
    try {
      const buffer = await fontFileBytes(ref);
      if (!buffer) return undefined;
      let binary = "";
      for (let i = 0; i < buffer.length; i += 1) binary += String.fromCharCode(buffer[i]!);
      const dataUrl = `data:font/ttf;base64,${btoa(binary)}`;
      return (
        `@font-face{font-family:"${instance?.instanceFamily ?? ref.family}";font-weight:${ref.weight};` +
        `font-style:${ref.style};` +
        `${instance?.axisSettings ? `font-variation-settings:${instance.axisSettings};` : ""}` +
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
export function fontInstallState(ref: PinnedFontRef, axes?: FontVariationAxes | undefined): FontInstallState | undefined {
  return states.get(fontRefInstallKey(ref, axes));
}

/**
 * Every pinned font in a composition that we KNOW is missing.
 *
 * Deliberately excludes in-flight loads: a font that has not finished loading is not yet evidence of
 * anything, and a banner that flashes "missing font" during startup teaches people to ignore it.
 */
export function missingCompositionFonts(layers: CompositionLayerStyleInput[]): PinnedFontRef[] {
  // Keyed per INSTANCE (S9a), because that is what was installed: asking about the bare ref when the
  // layer authored an axis reads a key nothing ever wrote, and "never asked for" would be reported as
  // fine. The returned refs are still bare — a missing font is a FILE problem, and naming an axis
  // coordinate in a banner would tell the user to relink something that is not the thing missing.
  return collectPinnedFontInstances(layers)
    .filter(({ ref, axes }) => states.get(fontRefInstallKey(ref, axes)) === "missing")
    .map(({ ref }) => ref);
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
