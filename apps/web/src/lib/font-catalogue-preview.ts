/**
 * ADR-023 S2.5 / T-17 — load catalogue faces so the picker can PREVIEW them in their own typeface.
 *
 * A font list that shows every family's name set in the same fallback is worse than useless: it
 * looks exactly like one that works, and picking from it is guesswork. That is not a hypothetical
 * failure here — `warpFontCatalog` shipped empty once and every warped family silently rendered as
 * Roboto, which reached a user as "changing the font did nothing".
 *
 * **These bytes are for PREVIEW, and deliberately not for rendering.** They come from the copy
 * bundled in `public/fonts` rather than from the mirrored store, under a distinct
 * `<family> Preview` family name so they can never be picked up by a layer's CSS by accident. The
 * layer's own font still installs through `installPinnedFont`, which reads the store and reports
 * `missing` when it cannot — because an editor that rendered bundled bytes while the worker aborted
 * on the same project would be the editor and the export disagreeing, which is exactly what S2
 * exists to prevent.
 *
 * The two sources are the same bytes: `font:catalogue-gate` re-hashes every bundled file against the
 * `fileHash` the catalogue pins. Nothing here is trusted to be the right face merely because it is
 * in the right folder.
 */
import { fontCatalogue, type CatalogueFace } from "@orreris/shared";

/** The CSS family a preview is installed under. Never the bare family name — see the module note. */
export function previewFamily(family: string): string {
  return `${family} Preview`;
}

const started = new Set<string>();
const loaded = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeCataloguePreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function cataloguePreviewVersion(): number {
  return version;
}

/** Has this face's preview actually loaded? Drives the picker's own "still loading" state. */
export function isPreviewLoaded(family: string, face: CatalogueFace): boolean {
  return loaded.has(face.fileHash);
}

async function loadFace(family: string, face: CatalogueFace): Promise<void> {
  if (started.has(face.fileHash)) return;
  started.add(face.fileHash);
  try {
    const fontFace = new FontFace(previewFamily(family), `url(/${face.file})`, {
      weight: String(face.weight),
      style: face.style
    });
    await fontFace.load();
    document.fonts.add(fontFace);
    loaded.add(face.fileHash);
    notify();
  } catch {
    // Left out of `loaded`, so the picker shows the row as unavailable rather than silently
    // rendering its name in the fallback and implying the face is what you would get.
  }
}

/** Load every catalogue face's preview. Idempotent; safe to call on every render. */
export function loadCataloguePreviews(): void {
  for (const entry of fontCatalogue) {
    for (const face of entry.faces) void loadFace(entry.family, face);
  }
}
