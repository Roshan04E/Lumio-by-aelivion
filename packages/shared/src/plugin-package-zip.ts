import { unzip, unzipSync, zipSync, zip, strToU8, strFromU8, type Zippable, type AsyncZippable, type UnzipFileInfo } from "fflate";
import { assertPluginPackageSafe } from "./plugin-safety";
import { parseTimelineTemplatePackage, type OrrerisTimelineTemplatePackage } from "./plugin-template-package";

/**
 * `.orreris` ZIP packages (PLUGIN_ARCHITECTURE.md "Package Shape") — a single file that carries a timeline
 * template AND its media, so importing it never hits the "relink your media" warning the bare-JSON
 * `.orreris-template.json` path always does. Layout:
 *   manifest.json    — the package's PluginTimelineTemplateManifest (same shape as the bare package's `manifest`)
 *   timeline.json    — the full OrrerisTimelineTemplatePackage (manifest + graph + assets + preview + warnings)
 *   assets/<id>.<ext> — one file per embedded SourceAsset, named by its OrrerisTemplateAssetRef.id
 *   previews/        — optional thumbnail/preview images (not required for import)
 *
 * ZIP (not gzip): `external-timeline-adapter.ts`'s `.prproj` support already uses
 * `DecompressionStream("gzip")` for Premiere's *.prproj gzip format — a different, single-stream format
 * that can't hold multiple named entries. fflate is the only zip-capable dep in the repo (browser + Node,
 * zero native bindings, works in the export Worker).
 */

export const orrerisPackageZipManifestEntry = "manifest.json" as const;
export const orrerisPackageZipTimelineEntry = "timeline.json" as const;
export const orrerisPackageZipAssetsDir = "assets" as const;
export const orrerisPackageZipPreviewsDir = "previews" as const;

/** ZIP local-file-header magic bytes — how callers pick the ZIP branch vs the legacy bare-JSON branch. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export interface OrrerisPackageZipAssetInput {
  id: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface BuildOrrerisPackageZipInput {
  pkg: OrrerisTimelineTemplatePackage;
  assets: OrrerisPackageZipAssetInput[];
  /** Optional preview image (e.g. a poster frame), stored under `previews/`. */
  preview?: { fileName: string; bytes: Uint8Array } | undefined;
}

export interface ParsedOrrerisPackageZip {
  pkg: OrrerisTimelineTemplatePackage;
  /** Embedded asset bytes, keyed by `OrrerisTemplateAssetRef.id` (matches `pkg.assets[].id`). */
  assetBytes: Map<string, Uint8Array>;
}

/** True when `bytes` starts with the ZIP local-file-header magic (`.orreris` package) vs bare JSON (`{`). */
export function isOrrerisPackageZipBytes(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Asset id → the file extension used inside the ZIP (kept from the asset's own fileName when present). */
function assetEntryName(asset: OrrerisPackageZipAssetInput): string {
  const dot = asset.fileName.lastIndexOf(".");
  const ext = dot >= 0 ? asset.fileName.slice(dot) : "";
  return `${orrerisPackageZipAssetsDir}/${asset.id}${ext}`;
}

/**
 * Assemble the fflate file map. Media assets (and preview images) are STORED, not DEFLATEd (`level: 0`):
 * mp4/jpg/png/webm are already compressed, so re-DEFLATE burns CPU for ~0 size gain — the exact cost that
 * froze the UI when this ran synchronously at level 6. Only the JSON entries (small, highly compressible)
 * are deflated.
 */
function buildOrrerisPackageZippable(input: BuildOrrerisPackageZipInput): Zippable {
  const files: Zippable = {
    [orrerisPackageZipManifestEntry]: [strToU8(JSON.stringify(input.pkg.manifest, null, 2)), { level: 6 }],
    [orrerisPackageZipTimelineEntry]: [strToU8(JSON.stringify(input.pkg, null, 2)), { level: 6 }]
  };
  for (const asset of input.assets) {
    files[assetEntryName(asset)] = [asset.bytes, { level: 0 }];
  }
  if (input.preview) {
    files[`${orrerisPackageZipPreviewsDir}/${input.preview.fileName}`] = [input.preview.bytes, { level: 0 }];
  }
  return files;
}

/**
 * Build a `.orreris` ZIP: `manifest.json` + `timeline.json` (the full bare package) + `assets/<id>.<ext>`
 * for each embedded asset + an optional `previews/` image. The caller supplies asset bytes already read
 * from OPFS/blob storage (`asset-blob-store.ts` for local assets, or a `fetch(fileUrl)` for cloud ones).
 *
 * SYNCHRONOUS — blocks the calling thread for the whole archive. Fine for tests and small packages, but UI
 * callers embedding real media MUST use `buildOrrerisPackageZipAsync` instead so the zip runs off the main
 * thread (fflate spins up worker threads); a synchronous zip over video-sized input freezes the tab.
 */
export function buildOrrerisPackageZip(input: BuildOrrerisPackageZipInput): Uint8Array {
  return zipSync(buildOrrerisPackageZippable(input));
}

/**
 * Async `.orreris` build — same output as `buildOrrerisPackageZip`, but fflate runs the deflate/store on its own
 * worker threads so the UI thread stays responsive. This is the correct entry point for the editor export.
 */
export function buildOrrerisPackageZipAsync(input: BuildOrrerisPackageZipInput): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(buildOrrerisPackageZippable(input) as AsyncZippable, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

export interface ParseOrrerisPackageZipOptions {
  /**
   * Optional caps for UNTRUSTED callers (a marketplace/download path). Omitted = UNLIMITED, which is the
   * default for a user importing their own `.orreris`: it's their project, and export applies no size cap, so
   * import must not reject packages Orreris itself produced. These do NOT disable the zip-bomb guard below.
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
const ORRERIS_METADATA_DECOMPRESSED_CAP = 512 * 1024 * 1024;

/** Build the fflate unzip `filter`: media = decompress unconditionally; metadata = only if within the bomb cap
 *  (and flags a bomb out-of-band); everything else (e.g. `previews/`) = skipped, we never read it on import. */
function orrerisUnzipFilter(onBomb: (name: string) => void): (file: UnzipFileInfo) => boolean {
  const assetPrefix = `${orrerisPackageZipAssetsDir}/`;
  return (file) => {
    if (file.name.startsWith(assetPrefix)) return true; // media: unlimited
    const isMetadata = file.name === orrerisPackageZipManifestEntry || file.name === orrerisPackageZipTimelineEntry;
    if (!isMetadata) return false;
    if (file.originalSize > ORRERIS_METADATA_DECOMPRESSED_CAP) {
      onBomb(file.name);
      return false; // refuse to expand it
    }
    return true;
  };
}

/** Turn decompressed entries into the parsed package, applying the (untrusted-only) caps and safety gate. */
function decodeOrrerisEntries(
  entries: Record<string, Uint8Array>,
  bombEntry: string | null,
  options: ParseOrrerisPackageZipOptions
): ParsedOrrerisPackageZip {
  if (bombEntry) {
    throw new Error(`.orreris metadata entry "${bombEntry}" decompresses far larger than any real project — refusing to expand it (possible zip bomb).`);
  }
  const timelineRaw = entries[orrerisPackageZipTimelineEntry];
  if (!timelineRaw) {
    throw new Error(`.orreris package is missing ${orrerisPackageZipTimelineEntry}.`);
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
  const assetPrefix = `${orrerisPackageZipAssetsDir}/`;
  let assetCount = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith(assetPrefix)) continue;
    assetCount += 1;
    if (options.maxAssetCount !== undefined && assetCount > options.maxAssetCount) {
      throw new Error(`.orreris package declares more than ${options.maxAssetCount} embedded assets.`);
    }
    if (options.maxAssetBytes !== undefined && data.byteLength > options.maxAssetBytes) {
      throw new Error(`.orreris package asset "${name}" is above the ${(options.maxAssetBytes / (1024 * 1024)).toFixed(0)} MB per-asset limit.`);
    }
    const rest = name.slice(assetPrefix.length);
    const dot = rest.lastIndexOf(".");
    const id = dot >= 0 ? rest.slice(0, dot) : rest;
    assetBytes.set(id, data);
  }

  return { pkg, assetBytes };
}

/**
 * Parse a `.orreris` ZIP (SYNCHRONOUS — blocks the calling thread; fine for tests/Node, but UI callers should
 * use `parseOrrerisPackageZipAsync` so a large or hostile file can't freeze the tab). By default there are NO
 * size limits on a `.orreris` — it's the user's own project/content — beyond the metadata zip-bomb guard.
 * Untrusted callers (marketplace/download flows) can pass `maxPackageBytes`/`maxAssetBytes`/`maxAssetCount`.
 */
export function parseOrrerisPackageZip(
  bytes: Uint8Array,
  options: ParseOrrerisPackageZipOptions = {}
): ParsedOrrerisPackageZip {
  let bombEntry: string | null = null;
  const entries = unzipSync(bytes, { filter: orrerisUnzipFilter((name) => { bombEntry = name; }) });
  return decodeOrrerisEntries(entries, bombEntry, options);
}

/**
 * Async `.orreris` parse — same result as `parseOrrerisPackageZip`, but fflate runs the inflate/copy on worker
 * threads so the UI thread stays responsive. This is the correct entry point for the editor import.
 */
export function parseOrrerisPackageZipAsync(
  bytes: Uint8Array,
  options: ParseOrrerisPackageZipOptions = {}
): Promise<ParsedOrrerisPackageZip> {
  return new Promise((resolve, reject) => {
    let bombEntry: string | null = null;
    unzip(bytes, { filter: orrerisUnzipFilter((name) => { bombEntry = name; }) }, (err, entries) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        resolve(decodeOrrerisEntries(entries, bombEntry, options));
      } catch (decodeError) {
        reject(decodeError);
      }
    });
  });
}
