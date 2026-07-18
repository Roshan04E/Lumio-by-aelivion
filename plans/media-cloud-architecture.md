# Media & cloud storage architecture (planned 2026-07-17)

Founder request: local storage isn't project-persistent, cloud sync pulls everything into every
project, folder organization is immature. Design a mature per-project asset system: one cloud root →
user → product → project; pull only what a project needs and only if it's not already local;
"refresh from cloud" for corrupted files; stock stays URL-first (never re-upload what a provider
already serves); per-project folders/subfolders mirrored cloud+local; multi-import; stock subpanel
folders.

## How the pros do it (research 2026-07-17)

- **Adobe Creative Cloud**: a *project* is a shared storage container holding folders + libraries;
  folder trees organize files *within* a project; *libraries* are user-level reusable assets shared
  ACROSS projects (our Brand/AI tabs are exactly this). Physical storage is fixed system folders
  (`assets/adobe-libraries`, `cloud-content`) — the user-visible folder tree is metadata, not
  physical paths. ([projects overview](https://helpx.adobe.com/creative-cloud/apps/manage-projects/projects-overview.html),
  [folders & libraries](https://helpx.adobe.com/creative-cloud/help/projects-create-folder-library.html))
- **Frame.io × DaVinci Resolve**: pull-on-demand — a clip added to the media pool starts a background
  download, you edit immediately on the proxy, and the full-res file auto-swaps in when it lands;
  local cache on disk; render-to-mount auto-uploads. ([integration](https://blog.frame.io/2019/04/08/davinci-resolve-in-frameio/),
  [mounted storage](https://help.frame.io/en/articles/14442067-davinci-resolve-mounted-storage-optimization))

Two rules fall out of this, and both are load-bearing for us:
1. **Storage keys are immutable; folder trees are metadata.** Renaming/moving a folder must be a
   manifest edit, never an object-storage copy. "Cloud keeps the same folder structure" is achieved
   by SYNCING THE TREE (one small JSON), not by mirroring paths in bucket keys.
2. **Bytes move lazily and proxy-first.** A project pull fetches what's missing, smallest usable
   rendition first; originals only when needed (export, full-quality park).

## Current state (verified in source; what each phase must respect)

- **Doctrine (founder 2026-07-13, memory `local-first-import-no-autosync`)**: local-first, "one
  asset, two locations". Imports NEVER auto-upload; bytes leave only via explicit per-asset upload
  or export consent (`ensureExportReady` → `syncProject(..., { uploadAssets: true })`). Pairing
  registry in `apps/web/src/lib/sync.ts` (`markLocalAssetPromoted`/`getAssetPromotionMap`); NO
  timeline remap on upload, NO duplicate tiles. This plan EXTENDS that model (adds the pull
  direction); it must not reintroduce auto-upload.
- Local bytes: OPFS single flat dir `orreris-assets/` (`asset-blob-store.ts`), ids
  `asset_local_<ts>_<rand>`.
- Cloud bytes: R2 keys `uploads/u_<userId>/<ts>-<rand>-<name>` — flat, no product/project level.
- Folders: `SourceAsset.folder` is a flat string; the user-created folder LIST + active-folder state
  live in GLOBAL localStorage (`orreris_asset_custom_folders`, `orreris_asset_folder_local|brand|ai` —
  EditorPage.tsx ~9645/10267) → **this is the reported "folders leak into every new project" bug.**
- Scoping: `SourceAsset.ownerProjectId` (project-owned uploads) + `ProjectAsset` join (user-level
  reusables linked per project) already exist (MEDIA_LIBRARY.md "Project scoping"). But the web's
  local fallback enumerates ALL OPFS assets for every project → **the reported "new project searches
  old assets" perf bug.**
- Stock: `POST /stock/import` downloads bytes server-side into our storage → **contradicts the new
  URL-first directive.**

## Target model

### Identity & taxonomy (logical)

```
account (userId)
└── product: "video"            ← later "photo", "vfs" — top-level namespace from day one
    ├── library/                ← user-level reusable assets (Brand, AI, pinned Stock refs)
    │   └── <assetId>           ← bytes + renditions (original / proxy / thumb)
    └── projects/
        └── <projectId>/
            ├── manifest        ← THE project media manifest (see below)
            └── assets/<assetId>← bytes owned by this project (local uploads)
```

- **Cloud (R2) keys** (immutable, content-addressed-ish):
  `u_<userId>/video/library/<assetId>/{original.<ext>|proxy.mp4|thumb.jpg}` and
  `u_<userId>/video/projects/<projectId>/assets/<assetId>/…`. Never encode user folder names in keys.
- **Local (OPFS) mirrors the SAME shape**: `u_<userId>/video/library/…` and
  `u_<userId>/video/projects/<projectId>/…` (replaces the flat `orreris-assets/`). A one-time
  migration walks existing blobs and re-homes them by `ownerProjectId` (project-owned) vs source
  brand/ai/stock (library). Same structure both sides = the founder's "cloud keeps the same folder
  structure", done the durable way.

### The project media manifest (the "mature system")

One versioned JSON per project (server: column/table on Project; local: OPFS file next to the
project assets; synced with the project graph through the existing `scheduleGraphSave` path):

```ts
interface ProjectMediaManifest {
  version: number;                       // monotonic, last-writer-wins with graph save
  folders: MediaFolder[];                // { id, name, parentId | null, tab: "local"|"brand"|"ai"|"stock" }
  items: { assetId: string; folderId: string | null; pinnedOffline?: boolean }[];
  }
```

- Folder tree is per-project and NESTED (`parentId`) — replaces the flat global-localStorage list
  (bug fix) and gives subfolders everywhere, including the stock subpanel (`tab: "stock"` folders
  hold URL-first stock refs the user organized).
- `SourceAsset.folder` (flat string) is kept as a legacy read-only hint during migration, then
  ignored; membership lives in `items[]`.
- A USER-LEVEL manifest (same shape, no projectId) organizes the shared library for Brand/AI tabs.

### Per-project sync engine ("pull what's missing", never push uninvited)

On project open (and on the new bin "Refresh" action):
1. Load manifest + graph → the set of REFERENCED assetIds (manifest items ∪ graph layer assetIds).
2. For each: **local bytes present (OPFS stat) → do nothing** (founder rule: no pointless pull).
3. Absent locally but has a cloud location (cloudUrl / promotion registry / server asset) →
   enqueue background pull, **thumb → proxy → original-on-demand** (Frame.io model): the tile shows
   instantly from thumb, timeline plays the proxy, original fetch is triggered by export or the
   full-quality settle path. Pull queue: small concurrency (2–3), abortable, survives tab reload
   (resume by re-diffing — no persistent queue state needed).
4. Nothing else is fetched: `listAssets(projectId)` local fallback enumerates ONLY
   `projects/<projectId>/` + `library/` entries LINKED in the manifest — a new empty project scans
   nothing (perf bug fix).
5. Upload direction unchanged (explicit only). The pairing registry gains renditions:
   `{ localId → { serverId, urls: { original, proxy?, thumb? } } }`.

### Refresh from cloud (corruption recovery)

- Per-asset (kebab menu) "Refresh from cloud": re-download the cloud rendition(s), overwrite the
  OPFS blob under the SAME assetId (verify `sizeBytes` — mismatch → keep old + notice), bump the
  blob-store epoch so open leases re-prime. Available only when a cloud location exists.
- Bin-level "Refresh from cloud" in the source-menu: runs the project diff (step 1–3 above) plus
  re-verifies sizes of local blobs that have cloud pairs, repairing corrupted ones.

### Stock = URL-first (reversal of today's server-side download)

- `importStock` no longer downloads bytes. It creates a `SourceAsset` row with `source:"pexels"`,
  `external{provider, externalId, sourceUrl, license}`, `fileUrl` = provider CDN URL, variants kept,
  `sizeBytes` absent — a REFERENCE, linked into the project via `ProjectAsset` + manifest item
  (organizable into stock folders). No bytes in R2, no bytes in OPFS.
- Playback streams the provider URL (Pexels CDN is direct-linkable). Export: the worker already
  fetches HTTP URLs — provider URLs qualify. Two safety valves:
  - **Pin offline** (kebab): downloads the chosen variant into `library/` OPFS (and only then can
    "Upload to cloud" apply, for the user's own guarantee). Auto-suggest pinning at export time if
    the URL HEAD-checks dead.
  - Dead-URL surface: bin tile shows a "source offline" badge when a HEAD probe fails; refresh
    re-probes.
- Existing byte-imported stock assets keep working (they're just assets); no migration needed.

## Phases & execution split

⚠️ Sequencing: EditorPage.tsx is being edited by the transition-alignment run — M0/M5/M6 must start
AFTER it lands (same working tree, no parallel edits to shared files).

- **M0 (Sonnet) — folder leak + nested folders**: move folder state out of global localStorage into
  the manifest model (start with a per-project localStorage key as an interim shim if manifest lands
  later, but the end state is the manifest); nested folder rail (indent + breadcrumb), folder
  create/rename/move/delete = manifest edits; `tab:"stock"` folders in the Search panel.
- **M1 (Fable) — manifest + storage taxonomy + OPFS migration**: shared `ProjectMediaManifest`
  types, OPFS re-home migration (flat → user/product/project), blob-store API gains scoped dirs,
  server manifest column + save path. Migration must be idempotent and crash-safe (copy-verify-
  delete per blob).
- **M2 (Fable) — pull engine + refresh-from-cloud**: project-open diff, rendition-aware pull queue,
  per-asset/bin refresh, pairing registry rendition upgrade, `listAssets` scoped local enumeration.
- **M3 (Sonnet) — stock URL-first**: importStock reference-mode + pin-offline + dead-URL badge +
  export-time HEAD check prompt. API change is small (skip download, keep row creation).
- **M4 (Sonnet) — bin UX**: multi-file import (`<input multiple>` + folder drag-drop batch with one
  progress toast), upload icon batches, stock subpanel folder chips, "Refresh from cloud" menu
  entries wired to M2.
- **R2 key taxonomy for NEW uploads** can ship inside M1 (old flat keys stay valid forever — keys
  are opaque; no bucket migration needed).

## Implementation status (2026-07-17, same day — implemented by Fable)

Shipped (typecheck 5/5 green):
- **M1** shared `ProjectMediaManifest` (`packages/shared/src/media-manifest.ts`, travels in
  `graph.mediaManifest` → syncs with the project); R2/local key taxonomy for NEW uploads
  (`uploadKeyFor` in storage.service.ts: `u_<id>/video/{library|projects/<pid>/assets}/…`; presign +
  multipart + saveBuffer all routed); OPFS taxonomy via scoped `put(id, blob, scope)` + path index +
  legacy-flat fallback (asset-blob-store.ts).
- **M0** folder leak FIXED: custom folder list lives in the project manifest, active-folder
  navigation in per-project localStorage keys; Search tab gained the folder system (root `stock/`,
  crumbs, folder tiles, New bin).
- **M2** pull engine (`apps/web/src/lib/media-pull.ts`): on project open, graph-referenced assets
  missing locally are background-pulled (concurrency 2, size-verified) into OPFS; local cache
  overlay in listAssets resolution; per-asset "Refresh from cloud" menu action; scoped bin load
  (`listProjectAssets` = project scope + library scope; `fetchAssetById` heals legacy graph refs).
- **M3** stock URL-first: `POST /stock/import` defaults to `referenceOnly` (provider CDN URL stored,
  no bytes copied); "Pin offline" menu action caches provider bytes on-device; "Source offline"
  tile badge on media load errors.
- **M4 + file-explorer bin** (founder addition mid-implementation): the bin accepts ANY file —
  media plays, timeline/template files import, everything else (.cube/.json/docs) becomes a generic
  "file" asset (extension tile, download/organize, timeline-guarded); DIRECTORY drops import
  recursively and recreate the folder structure as bin folders; upload input already multi-file.

Follow-ups shipped same day (founder feedback rounds):
- **Folder explorer UX**: window.prompt replaced by create-then-INLINE-RENAME; folder context menu
  (Open / New bin inside / Rename / Move to / Delete-with-assets-moving-up) on tiles + list rows;
  F2/Delete keys.
- **Stock mount**: Local tab = the project MEDIA POOL — imported stock appears under a "Stock" bin
  mounted at Local's root, the SAME `stock/` tree the Search subpanel roots at (one tree, two
  surfaces). Ancestor folders are now materialized (fixes deep derived paths like
  `stock/pexels/video` being unbrowsable); crumbs are mount-aware (Local › Stock › …). Stock rows
  are scoped per project via the ProjectAsset link mirror (`getLinkedAssetIdsForProject`) or
  timeline use.
- **Import = reference + on-device copy**: importing stock stores the provider reference AND kicks
  a background local download (pin) — "downloaded" stock genuinely lives on-device, still zero
  server bytes. Decoder pool already sets crossOrigin=anonymous, so provider URLs composite in GL.
- Timeline textures: kolam dot-lattice (loading filmstrip), patola diamond weave (transition pill),
  toran triangle fringe (insufficient-media warning) — replaced the stripe/zebra patterns.

Deliberate deviations:
- NO bulk OPFS migration of existing blobs (plan said one-time walk): mass-moving user footage
  risks the data it organizes; instead new writes use the taxonomy and reads fall back to the
  legacy flat dir forever. Same call as old R2 keys staying valid.
- Manifest simplified to a path-list (`customFolders`) — folder MEMBERSHIP already persists per
  asset (`asset.folder`), so an id-tree would have duplicated state.
- Export-time HEAD probe for provider URLs: deferred (the tile badge + pin cover the practical
  case; the export error path stays visible).
- Legacy global custom-folder list is NOT migrated into projects (migrating would copy the leak
  into every project — the bug being fixed). Folders derived from assets still appear; only empty
  custom folders from the global era are dropped.

## Non-goals / guards

- No auto-upload, ever (founder decree) — the pull engine is download-only.
- No physical folder paths in object keys; no bucket-side renames.
- Monetization: cloud storage is real COGS — per-directive, gating/quota UI may attach here later,
  but this plan adds NO enforcement.
- Photo/VFS products get a namespace, not an implementation.
