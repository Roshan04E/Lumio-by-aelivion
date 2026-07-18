/**
 * Project media manifest — the per-project organization layer of the media library
 * (plans/media-cloud-architecture.md, M1).
 *
 * Design rule (the Adobe model): STORAGE KEYS ARE IMMUTABLE; the user-visible folder tree is
 * METADATA. Folder membership already lives on each asset (`SourceAsset.folder`, a nested "a/b/c"
 * path string persisted per asset on the server and in the local record), so the manifest only has
 * to carry what assets can't: the folder tree the user created (including empty folders), scoped to
 * ONE project. It travels inside `ProjectGraph.mediaManifest`, so it syncs to the cloud with the
 * project through the existing graph save path — the cloud keeps the same folder structure by
 * construction, with zero object-storage renames.
 *
 * This replaces the global `orreris_asset_custom_folders` / `orreris_asset_folder_*` localStorage
 * keys, which leaked one project's folders into every other project (2026-07-17 report).
 */

export interface ProjectMediaManifest {
  /** Schema version for forward migration. */
  version: 1;
  /**
   * User-created folder PATHS ("local/B-roll/Drone", "stock/Favorites", …), including empty ones.
   * Folders implied by asset membership don't need to be listed (the bin derives those from
   * `asset.folder`), but keeping them here is harmless and preserves them when they empty out.
   */
  customFolders: string[];
}

export const EMPTY_MEDIA_MANIFEST: ProjectMediaManifest = { version: 1, customFolders: [] };

/** Parse an untrusted (persisted/synced) value into a well-formed manifest. Never throws. */
export function normalizeMediaManifest(value: unknown): ProjectMediaManifest {
  if (!value || typeof value !== "object") return EMPTY_MEDIA_MANIFEST;
  const raw = value as Partial<ProjectMediaManifest>;
  const customFolders = Array.isArray(raw.customFolders)
    ? [...new Set(raw.customFolders.filter((item): item is string => typeof item === "string" && item.length > 0))]
    : [];
  return { version: 1, customFolders };
}

/** Value-equality so graph writes can be skipped when nothing changed. */
export function mediaManifestsEqual(a: ProjectMediaManifest, b: ProjectMediaManifest): boolean {
  return a.customFolders.length === b.customFolders.length && a.customFolders.every((item, i) => b.customFolders[i] === item);
}
