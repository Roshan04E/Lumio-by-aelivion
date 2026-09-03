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
import { fileURLToPath } from "node:url";
import {
  canServeFont,
  catalogueFileForHash,
  collectFlarexGeneratorTextLayers,
  collectPinnedFontInstances,
  fontAxisInstanceFamily,
  fontObjectKey,
  fontVariationSettingsCss,
  FontResolutionError,
  fontStoreKeyFor,
  type CompositionLayerStyleInput,
  type FlarexComp,
  type InstalledFontFace,
  type PinnedFontRef
} from "@orreris/shared";

// apps/worker/public — the same tree `getBundleLocation` hands Remotion as `publicDir`
// (remotion-renderer.ts:266), so a bundled catalogue file resolves from the identical bytes the
// render itself would serve via `staticFile()`.
const workerPublicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

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
 * Bytes of a pinned catalogue face, preferring the bundled copy this app ships over the mirror.
 *
 * Same reasoning as the editor's `installPinnedFont` (`font-install.ts`): the mirror is seeded FROM
 * the bundled file, never the other way round, so the bundled hash is never a key the mirror holds.
 * A render pinning one of the five pre-S2.6 families must not depend on the network to resolve it —
 * that is the entire reason those bytes are bundled — so this checks `file:` before it ever touches
 * storage, and falls back to the mirror only for a catalogue hash the bundle does not carry.
 */
async function readCatalogueBytes(fileHash: string): Promise<Buffer | undefined> {
  const bundled = catalogueFileForHash(fileHash);
  if (bundled) {
    try {
      return await fs.readFile(path.join(workerPublicRoot, bundled));
    } catch {
      // Fall through to the mirror: a repo whose bundled file went missing is still allowed to have
      // mirrored the same hash independently.
    }
  }
  return readStoredBytes(fontObjectKey({ store: "catalogue", fileHash }));
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
  /**
   * ADR-023 S9a — instances, not refs, and the difference is one download versus N.
   *
   * A variable file authored at two axis coordinates is ONE set of bytes and TWO registrations. So
   * the loop walks (file, axis) pairs while `srcByFile` keeps the base64 per FILE: inlining a
   * 300KB face once per axis value would multiply `inputProps` by the number of instances, and S9b
   * turns "a couple of instances" into "one per sampled value".
   */
  const instances = collectPinnedFontInstances(layers);
  if (!instances.length) return [];

  const faces: InstalledFontFace[] = [];
  const missing: PinnedFontRef[] = [];
  const srcByFile = new Map<string, string>();

  for (const { ref, axes } of instances) {
    const fileKey = `${ref.source}|${ref.fileHash}`;
    const cached = srcByFile.get(fileKey);
    if (cached) {
      faces.push({
        family: fontAxisInstanceFamily(ref.family, axes),
        weight: ref.weight,
        style: ref.style,
        src: cached,
        variationSettings: fontVariationSettingsCss(axes)
      });
      continue;
    }
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
    const bytes = storeKey.store === "catalogue" ? await readCatalogueBytes(storeKey.fileHash) : await readStoredBytes(fontObjectKey(storeKey));
    if (!bytes) {
      missing.push(ref);
      continue;
    }
    const src = `data:font/ttf;base64,${bytes.toString("base64")}`;
    srcByFile.set(fileKey, src);
    faces.push({
      // Identical to `ref.family` when no axis is authored, so a pinned face's registration is
      // byte-for-byte what it was before S9a — which is what makes `render:baseline` the instrument
      // for the "nothing else moved" half of this claim.
      family: fontAxisInstanceFamily(ref.family, axes),
      weight: ref.weight,
      style: ref.style,
      src,
      variationSettings: fontVariationSettingsCss(axes)
    });
  }

  if (missing.length) throw new FontResolutionError(missing);
  return faces;
}

/**
 * Convenience for the render entry points: every layer in a manifest, PLUS every Text+ node's pin.
 *
 * `manifest.layers` alone misses Flarex generator nodes — their virtual layer is synthesized on demand
 * deep inside scene-building, never present in the flattened list `RenderManifest.layers` is built
 * from. Concatenating `collectFlarexGeneratorTextLayers(manifest.flarexComps)` is the worker-side half
 * of the same fix `VideoPreview.tsx`'s `installCompositionFonts` call needed (DEBT-028).
 */
export async function resolveManifestFonts(
  manifest: { layers: CompositionLayerStyleInput[]; flarexComps?: Record<string, FlarexComp> | undefined },
  viewerId: string | undefined
): Promise<InstalledFontFace[]> {
  return resolveFontsForLayers(manifest.layers.concat(collectFlarexGeneratorTextLayers(manifest.flarexComps)), viewerId);
}
