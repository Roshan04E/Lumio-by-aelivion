import { unzip, unzipSync, zipSync, zip, strToU8, strFromU8, type Zippable, type AsyncZippable, type UnzipFileInfo } from "fflate";
import { assertPluginPackageSafe } from "./plugin-safety";
import { parseTimelineTemplatePackage, type KimeraTimelineTemplatePackage } from "./plugin-template-package";

/**
 * `.kimera` ZIP packages (PLUGIN_ARCHITECTURE.md "Package Shape") — a single file that carries a timeline
 * template AND its media, so importing it never hits the "relink your media" warning the bare-JSON
 * `.kimera-template.json` path always does. Layout:
 *   manifest.json    — the package's PluginTimelineTemplateManifest (same shape as the bare package's `manifest`)
 *   timeline.json    — the full KimeraTimelineTemplatePackage (manifest + graph + assets + preview + warnings)
 *   assets/<id>.<ext> — one file per embedded SourceAsset, named by its KimeraTemplateAssetRef.id
 *   previews/        — optional thumbnail/preview images (not required for import)
 *
 * ZIP (not gzip): `external-timeline-adapter.ts`'s `.prproj` support already uses
 * `DecompressionStream("gzip")` for Premiere's *.prproj gzip format — a different, single-stream format
 * that can't hold multiple named entries. fflate is the only zip-capable dep in the repo (browser + Node,
 * zero native bindings, works in the export Worker).
 */

export const kimeraPackageZipManifestEntry = "manifest.json" as const;
export const kimeraPackageZipTimelineEntry = "timeline.json" as const;
export const kimeraPackageZipAssetsDir = "assets" as const;
export const kimeraPackageZipPreviewsDir = "previews" as const;

/** ZIP local-file-header magic bytes — how callers pick the ZIP branch vs the legacy bare-JSON branch. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export interface KimeraPackageZipAssetInput {
  id: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface BuildKimeraPackageZipInput {
  pkg: KimeraTimelineTemplatePackage;
  assets: KimeraPackageZipAssetInput[];
  /** Optional preview image (e.g. a poster frame), stored under `previews/`. */
  preview?: { fileName: string; bytes: Uint8Array } | undefined;
}

export interface ParsedKimeraPackageZip {
  pkg: KimeraTimelineTemplatePackage;
  /** Embedded asset bytes, keyed by `KimeraTemplateAssetRef.id` (matches `pkg.assets[].id`). */
  assetBytes: Map<string, Uint8Array>;
}

/** True when `bytes` starts with the ZIP local-file-header magic (`.kimera` package) vs bare JSON (`{`). */
export function isKimeraPackageZipBytes(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Asset id → the file extension used inside the ZIP (kept from the asset's own fileName when present). */
function assetEntryName(asset: KimeraPackageZipAssetInput): string {
  const dot = asset.fileName.lastIndexOf(".");
  const ext = dot >= 0 ? asset.fileName.slice(dot) : "";
  return `${kimeraPackageZipAssetsDir}/${asset.id}${ext}`;
}

/**
 * Assemble the fflate file map. Media assets (and preview images) are STORED, not DEFLATEd (`level: 0`):
 * mp4/jpg/png/webm are already compressed, so re-DEFLATE burns CPU for ~0 size gain — the exact cost that
 * froze the UI when this ran synchronously at level 6. Only the JSON entries (small, highly compressible)
 * are deflated.
 */
function buildKimeraPackageZippable(input: BuildKimeraPackageZipInput): Zippable {
  const files: Zippable = {
    [kimeraPackageZipManifestEntry]: [strToU8(JSON.stringify(input.pkg.manifest, null, 2)), { level: 6 }],
    [kimeraPackageZipTimelineEntry]: [strToU8(JSON.stringify(input.pkg, null, 2)), { level: 6 }]
  };
  for (const asset of input.assets) {
    files[assetEntryName(asset)] = [asset.bytes, { level: 0 }];
  }
  if (input.preview) {
    files[`${kimeraPackageZipPreviewsDir}/${input.preview.fileName}`] = [input.preview.bytes, { level: 0 }];
  }
  return files;
}

/**
 * Build a `.kimera` ZIP: `manifest.json` + `timeline.json` (the full bare package) + `assets/<id>.<ext>`
 * for each embedded asset + an optional `previews/` image. The caller supplies asset bytes already read
 * from OPFS/blob storage (`asset-blob-store.ts` for local assets, or a `fetch(fileUrl)` for cloud ones).
 *
 * SYNCHRONOUS — blocks the calling thread for the whole archive. Fine for tests and small packages, but UI
 * callers embedding real media MUST use `buildKimeraPackageZipAsync` instead so the zip runs off the main
 * thread (fflate spins up worker threads); a synchronous zip over video-sized input freezes the tab.
 */
export function buildKimeraPackageZip(input: BuildKimeraPackageZipInput): Uint8Array {
  return zipSync(buildKimeraPackageZippable(input));
}

/**
 * Async `.kimera` build — same output as `buildKimeraPackageZip`, but fflate runs the deflate/store on its own
 * worker threads so the UI thread stays responsive. This is the correct entry point for the editor export.
 */
export function buildKimeraPackageZipAsync(input: BuildKimeraPackageZipInput): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(buildKimeraPackageZippable(input) as AsyncZippable, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

export interface ParseKimeraPackageZipOptions {
  /**
   * Optional caps for UNTRUSTED callers (a marketplace/download path). Omitted = UNLIMITED, which is the
   * default for a user importing their own `.kimera`: it's their project, and export applies no size cap, so
   * import must not reject packages Kimera itself produced. These do NOT disable the zip-bomb guard below.
   */
  maxPackageBytes?: number;
  maxAssetBytes?: number;
  maxAssetCount?: number;
}

/**
 * Zip-bomb guard on the COMPRESSIBLE metadata only. `manifest.json`/`timeline.json` are DEFLATE'd, so a
 * crafted entry could expand from kilobytes to gigabytes and OOM the tab. Embedded media under `assets/` is
 * STORED (level 0) — no decompression amplification — so it stays UNLIMITED. No real timeline JSON comes
 * close to this ceiling; it exists purely to refuse a hostile file, not to limit legitimate content.
 * (fflate reports each entry's declared uncompressed size via the filter before decompressing it.)
 */
const KIMERA_METADATA_DECOMPRESSED_CAP = 512 * 1024 * 1024;

/** Build the fflate unzip `filter`: media = decompress unconditionally; metadata = only if within the bomb cap
 *  (and flags a bomb out-of-band); everything else (e.g. `previews/`) = skipped, we never read it on import. */
function kimeraUnzipFilter(onBomb: (name: string) => void): (file: UnzipFileInfo) => boolean {
  const assetPrefix = `${kimeraPackageZipAssetsDir}/`;
  return (file) => {
    if (file.name.startsWith(assetPrefix)) return true; // media: unlimited
    const isMetadata = file.name === kimeraPackageZipManifestEntry || file.name === kimeraPackageZipTimelineEntry;
    if (!isMetadata) return false;
    if (file.originalSize > KIMERA_METADATA_DECOMPRESSED_CAP) {
      onBomb(file.name);
      return false; // refuse to expand it
    }
    return true;
  };
}

/** Turn decompressed entries into the parsed package, applying the (untrusted-only) caps and safety gate. */
function decodeKimeraEntries(
  entries: Record<string, Uint8Array>,
  bombEntry: string | null,
  options: ParseKimeraPackageZipOptions
): ParsedKimeraPackageZip {
  if (bombEntry) {
    throw new Error(`.kimera metadata entry "${bombEntry}" decompresses far larger than any real project — refusing to expand it (possible zip bomb).`);
  }
  const timelineRaw = entries[kimeraPackageZipTimelineEntry];
  if (!timelineRaw) {
    throw new Error(`.kimera package is missing ${kimeraPackageZipTimelineEntry}.`);
  }
  const timelineJson = JSON.parse(strFromU8(timelineRaw)) as unknown;
  // Keep the manifest content-safety scan (blocks javascript:/importScripts/etc.); only the SIZE veto is
  // relaxed — Infinity unless an untrusted caller passed a real limit.
  assertPluginPackageSafe(
    { manifest: (timelineJson as { manifest?: unknown }).manifest ?? {} },
    { maxPackageBytes: options.maxPackageBytes ?? Number.POSITIVE_INFINITY }
  );
  const pkg = parseTimelineTemplatePackage(timelineJson);

  const assetBytes = new Map<string, Uint8Array>();
  const assetPrefix = `${kimeraPackageZipAssetsDir}/`;
  let assetCount = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith(assetPrefix)) continue;
    assetCount += 1;
    if (options.maxAssetCount !== undefined && assetCount > options.maxAssetCount) {
      throw new Error(`.kimera package declares more than ${options.maxAssetCount} embedded assets.`);
    }
    if (options.maxAssetBytes !== undefined && data.byteLength > options.maxAssetBytes) {
      throw new Error(`.kimera package asset "${name}" is above the ${(options.maxAssetBytes / (1024 * 1024)).toFixed(0)} MB per-asset limit.`);
    }
    const rest = name.slice(assetPrefix.length);
    const dot = rest.lastIndexOf(".");
    const id = dot >= 0 ? rest.slice(0, dot) : rest;
    assetBytes.set(id, data);
  }

  return { pkg, assetBytes };
}

/**
 * Parse a `.kimera` ZIP (SYNCHRONOUS — blocks the calling thread; fine for tests/Node, but UI callers should
 * use `parseKimeraPackageZipAsync` so a large or hostile file can't freeze the tab). By default there are NO
 * size limits on a `.kimera` — it's the user's own project/content — beyond the metadata zip-bomb guard.
 * Untrusted callers (marketplace/download flows) can pass `maxPackageBytes`/`maxAssetBytes`/`maxAssetCount`.
 */
export function parseKimeraPackageZip(
  bytes: Uint8Array,
  options: ParseKimeraPackageZipOptions = {}
): ParsedKimeraPackageZip {
  let bombEntry: string | null = null;
  const entries = unzipSync(bytes, { filter: kimeraUnzipFilter((name) => { bombEntry = name; }) });
  return decodeKimeraEntries(entries, bombEntry, options);
}

/**
 * Async `.kimera` parse — same result as `parseKimeraPackageZip`, but fflate runs the inflate/copy on worker
 * threads so the UI thread stays responsive. This is the correct entry point for the editor import.
 */
export function parseKimeraPackageZipAsync(
  bytes: Uint8Array,
  options: ParseKimeraPackageZipOptions = {}
): Promise<ParsedKimeraPackageZip> {
  return new Promise((resolve, reject) => {
    let bombEntry: string | null = null;
    unzip(bytes, { filter: kimeraUnzipFilter((name) => { bombEntry = name; }) }, (err, entries) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        resolve(decodeKimeraEntries(entries, bombEntry, options));
      } catch (decodeError) {
        reject(decodeError);
      }
    });
  });
}
