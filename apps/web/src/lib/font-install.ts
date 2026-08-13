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
  type CompositionLayerStyleInput,
  type PinnedFontRef
} from "@orreris/shared";

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
    try {
      const face = new FontFace(ref.family, `url(${storageUrl(fontObjectKey(storeKey))})`, {
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
