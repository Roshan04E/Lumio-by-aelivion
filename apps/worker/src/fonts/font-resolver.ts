/**
 * ADR-023 D3 / T-2 — the render boundary. Resolve every pinned font to bytes, or abort by name.
 *
 * This is the half of D3 that has no forgiveness in it. An export runs unattended and produces a
 * deliverable; a font that quietly became something else there is wrong pixels that look like a
 * working feature, and the person who finds out is the person who already published them. So there
 * is no fallback here, no substitution, and deliberately no `catch` that turns a missing font into a
 * shrug — the shrug at `export-core.ts:332` is what this stage deletes.
 *
 * Bytes become `data:` URLs carried in `inputProps` rather than files written into Remotion's public
 * dir. Two reasons, and the second is the load-bearing one:
 *
 *  1. The bundle is built once and cached across renders (`bundleLocationPromise`), so a file
 *     written after the first bundle is not reliably served — an install path that works only on the
 *     first render of a process is worse than none.
 *  2. It makes the claim provable. The bytes travel from the store, through this function, into the
 *     page. Nothing about the render can be satisfied by a font that happens to be installed on the
 *     host, which is exactly what the gate needs to demonstrate.
 *
 * The cost is honest: fonts are inlined per render. A typical face is 100–500KB and a composition
 * uses a handful, so this is small next to the media in the same render; a project pinning dozens of
 * faces would want the file route instead, and that is the point at which to build it.
 */
import { getObjectStream, isR2StorageEnabled, resolveStorageConfig } from "@orreris/storage";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  canServeFont,
  collectPinnedFontRefs,
  fontObjectKey,
  FontResolutionError,
  fontStoreKeyFor,
  type CompositionLayerStyleInput,
  type InstalledFontFace,
  type PinnedFontRef
} from "@orreris/shared";

/** Read one stored object's bytes, or `undefined` if it is not there. Absence is an answer, not a throw. */
async function readStoredBytes(relativeKey: string): Promise<Buffer | undefined> {
  if (isR2StorageEnabled()) {
    try {
      const { body } = await getObjectStream(relativeKey);
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks);
    } catch {
      return undefined;
    }
  }
  try {
    return await fs.readFile(path.join(resolveStorageConfig().storageRoot, relativeKey));
  } catch {
    return undefined;
  }
}

/**
 * Resolve every pinned font a set of layers needs.
 *
 * Throws {@link FontResolutionError} naming EVERY unresolved font, not just the first. A render that
 * fails four times because four fonts are missing is four round trips through a slow pipeline; one
 * message listing all four is one.
 */
export async function resolveFontsForLayers(
  layers: CompositionLayerStyleInput[],
  /**
   * Who this render is FOR. Required, and required to be spelled even when it is `undefined` (D4).
   *
   * A default would be an owner nobody chose, and the failure it hides is silent: a render that
   * quietly resolved another account's licensed font would produce a perfectly good deliverable and
   * a licence violation at the same time. Passing `undefined` is a legitimate answer — a catalogue-
   * only render has no viewer — and it fails CLOSED: every per-user face becomes unresolvable, and
   * unresolvable aborts by name (T-2).
   */
  viewerId: string | undefined
): Promise<InstalledFontFace[]> {
  const refs = collectPinnedFontRefs(layers);
  if (!refs.length) return [];

  const faces: InstalledFontFace[] = [];
  const missing: PinnedFontRef[] = [];

  for (const ref of refs) {
    // D4/T-3: the key is derived by discriminating on `source`. There is no way to ask for "the
    // bytes of a font" without saying which store it lives in, which is what keeps a per-user face
    // from ever being resolved through the shared path.
    const storeKey = fontStoreKeyFor(ref);
    if (!storeKey) continue;
    /**
     * D4, and this is the line the whole two-stores decision exists for. Content-addressed storage
     * means two accounts with byte-identical copies of the same commercial font produce the same
     * hash; the ONLY thing standing between account B and account A's licensed bytes is that the
     * key carries an owner and this check reads it. `canServeFont` is total over the union, so a
     * third store added later cannot slip past by defaulting to "sure".
     */
    if (!canServeFont(storeKey, viewerId)) {
      // Treated as MISSING rather than as a distinct error: from this render's position the font is
      // exactly as unavailable as one that was never uploaded, and saying "you are not allowed to
      // see this font" would confirm the hash exists in someone else's store.
      missing.push(ref);
      continue;
    }
    const bytes = await readStoredBytes(fontObjectKey(storeKey));
    if (!bytes) {
      missing.push(ref);
      continue;
    }
    faces.push({
      family: ref.family,
      weight: ref.weight,
      style: ref.style,
      src: `data:font/ttf;base64,${bytes.toString("base64")}`
    });
  }

  if (missing.length) throw new FontResolutionError(missing);
  return faces;
}

/** Convenience for the render entry points: every layer in a manifest. */
export async function resolveManifestFonts(
  manifest: { layers: CompositionLayerStyleInput[] },
  viewerId: string | undefined
): Promise<InstalledFontFace[]> {
  return resolveFontsForLayers(manifest.layers, viewerId);
}
