import { unzipSync, zipSync, zip, strToU8, strFromU8, type Zippable, type AsyncZippable } from "fflate";
import { assertPluginPackageSafe } from "./plugin-safety";
import { parseTimelineTemplatePackage, type LumioTimelineTemplatePackage } from "./plugin-template-package";

/**
 * `.lumio` ZIP packages (PLUGIN_ARCHITECTURE.md "Package Shape") — a single file that carries a timeline
 * template AND its media, so importing it never hits the "relink your media" warning the bare-JSON
 * `.lumio-template.json` path always does. Layout:
 *   manifest.json    — the package's PluginTimelineTemplateManifest (same shape as the bare package's `manifest`)
 *   timeline.json    — the full LumioTimelineTemplatePackage (manifest + graph + assets + preview + warnings)
 *   assets/<id>.<ext> — one file per embedded SourceAsset, named by its LumioTemplateAssetRef.id
 *   previews/        — optional thumbnail/preview images (not required for import)
 *
 * ZIP (not gzip): `external-timeline-adapter.ts`'s `.prproj` support already uses
 * `DecompressionStream("gzip")` for Premiere's *.prproj gzip format — a different, single-stream format
 * that can't hold multiple named entries. fflate is the only zip-capable dep in the repo (browser + Node,
 * zero native bindings, works in the export Worker).
 */

export const lumioPackageZipManifestEntry = "manifest.json" as const;
export const lumioPackageZipTimelineEntry = "timeline.json" as const;
export const lumioPackageZipAssetsDir = "assets" as const;
export const lumioPackageZipPreviewsDir = "previews" as const;

/** ZIP local-file-header magic bytes — how callers pick the ZIP branch vs the legacy bare-JSON branch. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export interface LumioPackageZipAssetInput {
  id: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface BuildLumioPackageZipInput {
  pkg: LumioTimelineTemplatePackage;
  assets: LumioPackageZipAssetInput[];
  /** Optional preview image (e.g. a poster frame), stored under `previews/`. */
  preview?: { fileName: string; bytes: Uint8Array } | undefined;
}

export interface ParsedLumioPackageZip {
  pkg: LumioTimelineTemplatePackage;
  /** Embedded asset bytes, keyed by `LumioTemplateAssetRef.id` (matches `pkg.assets[].id`). */
  assetBytes: Map<string, Uint8Array>;
}

/** True when `bytes` starts with the ZIP local-file-header magic (`.lumio` package) vs bare JSON (`{`). */
export function isLumioPackageZipBytes(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Asset id → the file extension used inside the ZIP (kept from the asset's own fileName when present). */
function assetEntryName(asset: LumioPackageZipAssetInput): string {
  const dot = asset.fileName.lastIndexOf(".");
  const ext = dot >= 0 ? asset.fileName.slice(dot) : "";
  return `${lumioPackageZipAssetsDir}/${asset.id}${ext}`;
}

/**
 * Assemble the fflate file map. Media assets (and preview images) are STORED, not DEFLATEd (`level: 0`):
 * mp4/jpg/png/webm are already compressed, so re-DEFLATE burns CPU for ~0 size gain — the exact cost that
 * froze the UI when this ran synchronously at level 6. Only the JSON entries (small, highly compressible)
 * are deflated.
 */
function buildLumioPackageZippable(input: BuildLumioPackageZipInput): Zippable {
  const files: Zippable = {
    [lumioPackageZipManifestEntry]: [strToU8(JSON.stringify(input.pkg.manifest, null, 2)), { level: 6 }],
    [lumioPackageZipTimelineEntry]: [strToU8(JSON.stringify(input.pkg, null, 2)), { level: 6 }]
  };
  for (const asset of input.assets) {
    files[assetEntryName(asset)] = [asset.bytes, { level: 0 }];
  }
  if (input.preview) {
    files[`${lumioPackageZipPreviewsDir}/${input.preview.fileName}`] = [input.preview.bytes, { level: 0 }];
  }
  return files;
}

/**
 * Build a `.lumio` ZIP: `manifest.json` + `timeline.json` (the full bare package) + `assets/<id>.<ext>`
 * for each embedded asset + an optional `previews/` image. The caller supplies asset bytes already read
 * from OPFS/blob storage (`asset-blob-store.ts` for local assets, or a `fetch(fileUrl)` for cloud ones).
 *
 * SYNCHRONOUS — blocks the calling thread for the whole archive. Fine for tests and small packages, but UI
 * callers embedding real media MUST use `buildLumioPackageZipAsync` instead so the zip runs off the main
 * thread (fflate spins up worker threads); a synchronous zip over video-sized input freezes the tab.
 */
export function buildLumioPackageZip(input: BuildLumioPackageZipInput): Uint8Array {
  return zipSync(buildLumioPackageZippable(input));
}

/**
 * Async `.lumio` build — same output as `buildLumioPackageZip`, but fflate runs the deflate/store on its own
 * worker threads so the UI thread stays responsive. This is the correct entry point for the editor export.
 */
export function buildLumioPackageZipAsync(input: BuildLumioPackageZipInput): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(buildLumioPackageZippable(input) as AsyncZippable, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/**
 * Parse a `.lumio` ZIP back into its `LumioTimelineTemplatePackage` + embedded asset bytes. Runs the same
 * `assertPluginPackageSafe` gate the bare-JSON path uses plus a per-asset count/size cap so a pathological
 * archive can't exhaust memory before the caller even looks at it.
 *
 * The defaults are sized for REAL video projects, not marketplace plugins: a user re-importing a `.lumio`
 * they exported themselves is a trusted, local, user-picked file, and export applies NO size cap — so a low
 * import cap would reject packages Lumio itself produced. The ceiling only exists to avoid OOMing the tab
 * (`unzipSync` materializes every entry in memory). Untrusted callers can pass tighter limits explicitly.
 */
export function parseLumioPackageZip(
  bytes: Uint8Array,
  options: { maxPackageBytes?: number; maxAssetBytes?: number; maxAssetCount?: number } = {}
): ParsedLumioPackageZip {
  const GB = 1024 * 1024 * 1024;
  const maxPackageBytes = options.maxPackageBytes ?? 4 * GB; // whole-archive ceiling (tab-memory guard, not a product limit)
  const maxAssetBytes = options.maxAssetBytes ?? 2 * GB; // per embedded asset (a 4K/long clip alone can exceed the old 256 MB)
  const maxAssetCount = options.maxAssetCount ?? 256;

  if (bytes.byteLength > maxPackageBytes) {
    throw new Error(`.lumio package is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB, above the ${(maxPackageBytes / (1024 * 1024)).toFixed(0)} MB limit.`);
  }

  const entries = unzipSync(bytes);
  const timelineRaw = entries[lumioPackageZipTimelineEntry];
  if (!timelineRaw) {
    throw new Error(`.lumio package is missing ${lumioPackageZipTimelineEntry}.`);
  }
  const timelineJson = JSON.parse(strFromU8(timelineRaw)) as unknown;
  assertPluginPackageSafe(
    { manifest: (timelineJson as { manifest?: unknown }).manifest ?? {} },
    { maxPackageBytes }
  );
  const pkg = parseTimelineTemplatePackage(timelineJson);

  const assetBytes = new Map<string, Uint8Array>();
  const assetPrefix = `${lumioPackageZipAssetsDir}/`;
  let assetCount = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith(assetPrefix)) continue;
    assetCount += 1;
    if (assetCount > maxAssetCount) {
      throw new Error(`.lumio package declares more than ${maxAssetCount} embedded assets.`);
    }
    if (data.byteLength > maxAssetBytes) {
      throw new Error(`.lumio package asset "${name}" is above the ${(maxAssetBytes / (1024 * 1024)).toFixed(0)} MB per-asset limit.`);
    }
    const rest = name.slice(assetPrefix.length);
    const dot = rest.lastIndexOf(".");
    const id = dot >= 0 ? rest.slice(0, dot) : rest;
    assetBytes.set(id, data);
  }

  return { pkg, assetBytes };
}
