# Media Library — implementation notes

Living doc for the Asset / Media Library. Update this when the library changes so we don't
lose track of what's real vs deferred.

## What it is

A structured asset bin with top-level source tabs — **Search · Local · AI · Brand · Templates · Used**
(2026-07-08: renamed from "Stock" to "Search" and added "Templates" — see "Project scoping" and
"Templates gallery" below) — plus type filters (All / Video / Image / Audio / Graphics), search, and
redesigned cards (thumbnail, type badge, source badge, dims/duration, used count, Add, More menu).

The bin lives inside `AssetBin` in `apps/web/src/pages/EditorPage.tsx`.

## Card / grid (footage-first redesign)

The bin is **visual-first** — the footage is the card, not the filename.

- **Fluid masonry.** `.asset-grid` is a CSS multi-column layout (`column-count`), tiles use
  `break-inside: avoid`. The S/M/L size control maps to `column-count` 3/2/1; List view is a
  single column of compact rows.
- **True aspect ratio.** Each tile's media box uses `aspect-ratio: var(--asset-ar)`. `--asset-ar`
  comes from `asset.width/asset.height`; when dims are missing (local uploads have mocked metadata),
  `AssetCardMedia` **measures on load** (`<img onLoad>` → naturalWidth/Height, `<video onLoadedMetadata>`
  → videoWidth/Height) and reflows the masonry to the real shape.
- **Hover-to-scrub, NOT hover-to-play** (changed 2026-07-08 — autoplay was noisy/unwanted). Video tiles
  mount a `<video preload="auto" muted loop playsInline>` (src = `proxyUrl ?? previewUrl ?? fileUrl`,
  poster = `thumbnailUrl`) on hover but it starts **paused** on the poster frame; moving the pointer across
  the tile scrubs `video.currentTime` to that horizontal fraction (Premiere-style). Gated by
  `prefersReducedMotion()`. Stock search result tiles (`StockCardMedia`) don't scrub at all — hover just
  shows the still `thumbnailUrl` poster, no video element ever plays or fetches (`preload="none"`).
- **Icons, not text.** Type is a small icon chip (Film/Image/Music/Palette via `assetTypeIcon`) top-left;
  source is a colored badge top-right; duration chip bottom-right; used-count chip top-right (clickable →
  `onFocusAssetUse`).
- **Hover-only label + actions.** Name + dims/duration and the action bar live in `.asset-card-hover`
  (gradient, fades in on `:hover`/`:focus-within`). Add actions are **icon buttons**: video → 🎬 video-only
  / 🎵 audio-only / ⧉ both (`Layers`); image/audio/graphic → a single ＋. Kebab (⋮) keeps the existing
  menu (Upload-to-cloud when local-only, In-cloud note, Delete). Tile click = assign/replace,
  double-click = quick add, drag = drag-to-timeline (all unchanged).
- **Audio cards** have no frame → a short fixed-ratio (`5/2`) gradient tile with a music glyph.
- CSS lives in `apps/web/src/styles/global.css` under the `.asset-grid` / `.asset-tile` / `.asset-card-*`
  blocks; a `prefers-reduced-motion` guard disables the hover zoom.

## Asset viewer (double-click)

Double-clicking any library asset or stock result opens `AssetViewerModal`
(`apps/web/src/components/AssetViewerModal.tsx`, built on `Modal`):
- **Library** assets play from our storage (`fileUrl`/`proxyUrl`) with full controls; images show
  uncropped (`object-fit: contain`); audio gets a player. Actions: add to timeline (video → video/
  audio/both), Upload-to-cloud (local-only), Delete.
- **Stock** results **stream from the provider** (video → `previewUrl`, image → `downloadUrl`) and show
  a **Quality** `ThemedSelect` listing the real resolutions from `StockResult.variants`
  (`4K · 3840×2160`, …); **Import** downloads the chosen variant into our storage via
  `handleImportStock(result, variant)` and closes the viewer.
- Hover ＋/🎬🎵⧉ and single-click still quick-add/assign — only double-click opens the viewer.

## Data model (one unified model, now project-scoped)

We extended the existing `SourceAsset` (NOT a new table).

- Shared type: `packages/shared/src/types.ts` → `SourceAsset` gained optional fields:
  `source`, `folder`, `tags[]`, `originalName`, `thumbnailUrl`, `previewUrl`, `proxyUrl`,
  `cloudUrl`, `fps`, `sizeBytes`, `projectId`, `ownerProjectId`,
  `external{provider,externalId,author,sourceUrl,license}`,
  `ai{model,prompt,seed,referenceAssetIds}`, `updatedAt`. Plus `AssetSource`, `AssetExternalRef`,
  `AssetAiRef`, `StockResult` types.
- Prisma: `apps/api/prisma/schema.prisma` `SourceAsset` got matching nullable columns
  (`externalJson`/`aiJson` hold the structured refs; `tags` is `Json?`). Migration:
  `apps/api/prisma/migrations/*_media_library_assets`. Re-run `pnpm db:generate` + the migrate
  command if the schema changes (see Gotchas).
- API serializer: `apps/api/src/lib/asset-serializer.ts` maps Prisma rows → the shared shape
  (externalJson→external, aiJson→ai). Used by all `/assets` + `/stock` responses.
- `folder` is a **virtual category** (e.g. `local/video`, `stock/pexels/image`,
  `generated/freeze-frame`), not a physical per-project directory.

### Project scoping (2026-07-07 — was the #1 gap: "everyone's assets pile into every project")

Uploads bind to ONE project; Brand/AI/Stock/Graphics stay user-level and reusable via an explicit link:

- **`SourceAsset.ownerProjectId`** (`@map("projectId")` — reuses the legacy column, no data dropped) is
  set on a **local upload**: that asset belongs to the project it was added to and shows ONLY in that
  project's Local tab (`AssetBin`'s `currentProjectId` prop filters it client-side; the server mirrors
  this via `GET /assets?projectId&scope=`).
- **`ProjectAsset`** (new join table: `projectId` + `sourceAssetId`, unique pair) links a REUSABLE library
  asset (Brand, AI, imported Stock/Graphics — anything with `ownerProjectId = null`) into a specific
  project's bin without copying bytes. Created automatically: on upload (owner+link together), on AI
  generation (`generationRouter.service.ts`), on stock import (`POST /stock/import` with a `projectId`
  body field), and on-demand when a library asset from Brand/AI is dragged/added into the timeline
  (`linkAssetToProject`, `apps/web/src/lib/api.ts`).
- **Local-first mirror is mandatory**: every server-side scope filter has an offline equivalent. Web
  `listAssets(projectId?, scope?)` filters the local fallback (`filterLocalAssetsByScope`) the same way;
  a `localStorage["lumio_project_asset_links"]` map (`{projectId: assetId[]}`) mirrors `ProjectAsset` when
  there's no server.
- **Backfill**: existing projects' already-referenced assets were linked/assigned via a one-shot script
  (`apps/api/src/scripts/backfill-project-assets.ts`, `pnpm --filter @lumio-by-aelivion/api
  assets:backfill`) so migrating to this model didn't empty anyone's Local tab.
- **Known gap**: the inspector's replace-picker `AssetBin` instance isn't project-scoped (no project id
  threaded into that component) — it shows everything, same as before this change. Low risk (it's a
  picker, not the primary bin surface).

## Storage & the critical rule

All non-local assets must be saved into OUR storage before timeline use — never reference a
remote stock URL or a browser blob URL in a clip that needs to export on the server.

- `createAsset()` (`apps/web/src/lib/api.ts`) has a **dual path**: server (`POST /assets` →
  `saveUpload`/`saveBuffer` → real HTTP URL, worker-fetchable) OR **OPFS local-first** with
  `localblob:` markers resolved on load (`asset-blob-store.ts`). Server uploads set `cloudUrl`
  = the HTTP URL.
- Timeline clips reference `layer.assetId`; resolved by `resolveLayerUrl` (preview) and
  `buildSourceUrlMap` (export). The render worker prefers `cloudUrl` (it can only fetch HTTP) —
  see `toSourceAsset` in `apps/worker/src/render-worker.ts`.

### Local vs cloud render (decision)

- **Browser export is primary** (WebCodecs, local, no upload). Accuracy = manifest parity
  (`render:compare`), NOT render speed.
- **Cloud render is optional + slower** (headless Chromium + per-frame + HTTP fetch + ffmpeg).
  Slow ≠ better quality.
- **Opt-in cloud upload**: the card "More → Upload to cloud" (`handleUploadAssetToCloud` in
  EditorPage) pushes a browser-local asset to server storage and **remaps clips** from the local
  id to the new server id, so a cloud render can fetch it.

## Import flows

1. **Local upload** — `handleUploadAsset(file, {source, folder})`; tags `source:"local"` (or
   `"brand"` from the Brand tab), sets `originalName`/`sizeBytes`. Owned by the current project
   (`ownerProjectId`) — see "Project scoping" above.
2. **Search — Stock (photos/videos) + Graphics** (renamed from "Stock" 2026-07-07; provider identity is
   never shown in the UI — one unified Search surface):
   - **Stock** (Pexels-backed today; provider-agnostic layer in `stock.service.ts` so a second source is
     additive, not a rewrite). Pixabay was removed entirely (2026-07-07). Real, **env-gated**:
     - Search: `GET /api/stock/search?q&type&page` (`apps/api/src/routes/stock.routes.ts` +
       `services/stock.service.ts` — no provider in the URL). Missing key → `/stock/status` reports
       `configured:false` → UI shows an "unconfigured" state.
     - Import: `POST /api/stock/import` **downloads the file server-side** → `saveBuffer` → `SourceAsset`
       row (`source:"pexels"`) **linked into the requesting project** (`ProjectAsset`, via an optional
       `projectId` body field) rather than left as a dangling user-level asset. Frontend:
       `searchStock`/`importStock`.
     - Key: `PEXELS_API_KEY` (see `.env.example`).
     - **Type chips** (Photos/Videos/Graphics) replaced the old Pexels/Pixabay provider-picker buttons —
       no provider name anywhere. Orientation (Any/Horizontal/Vertical/Square) and Import quality
       (Highest/4K/1080p/720p/SD) selects only show for Photos/Videos. **Show more** paginates
       (`STOCK_PER_PAGE`/`STOCK_PAGE_SIZE` = 24; a full page implies more).
     - **Quality/variants:** each `StockResult` carries `variants[]` (best-first, deduped by resolution
       label) and a `previewUrl` (smallest variant). `pickStockVariant(result, quality)` chooses the
       closest variant; `importStock(result, variant, projectId)` downloads + links the chosen one.
     - Stock tiles show a still poster only — no hover-autoplay (see "Hover-to-scrub" above).
   - **Graphics** (new 2026-07-07, `source:"graphic"`): two content sources merged in one grid —
     an offline **bundled shape pack** (`packages/shared/src/graphics/catalog.ts`, ~28 inline-SVG
     shapes/arrows/badges/lines/bubbles, zero network, `searchBundledGraphics(query)`) and **searchable
     Iconify icons** (`apps/web/src/lib/graphics-search.ts`, Iconify's public API, no key, fails soft to
     `[]` on any network/CSP failure so the bundled pack always still works). Both rasterize to a real PNG
     `File` via `apps/web/src/lib/rasterize-svg.ts` on import, so a picked graphic becomes ordinary
     editable image media (project-scoped like a local upload, not linked like Stock/AI) — never a
     special-cased vector layer type. Iconify SVGs render as `<img src>` in the grid (never
     `dangerouslySetInnerHTML` — that's third-party markup); only the bundled pack's own hardcoded SVG
     strings use `dangerouslySetInnerHTML`.
3. **AI / tool output** — tool results that produce real media call `createAsset()` tagged
   `source:"ai"` or `"timeline-generated"` (e.g. extract-person matte in
   `apps/web/src/tools/layer-effect-handlers.ts`). User-level/reusable, linked into the generating
   project. Gained **folder structure** (2026-07-07) — same create/rename/move bin rail as Local/Brand.
4. **Timeline-generated** — "Save freeze frame" (camera button in the preview toolbar →
   `handleSaveFreezeFrame`) captures the selected video clip's current frame via `getVideoPoster`
   and saves it as a `timeline-generated` image. Shows in the **AI** tab.

## Templates gallery (in-editor, 2026-07-08)

A new **Templates** bin tab applies a pre-designed timeline directly into the CURRENTLY OPEN project
(distinct from the standalone marketing `TemplatesPage`, which starts a brand-new project):

- **Curated** (`Template.userId = null`, seeded/legacy rows) + **the current user's own** saved templates
  (`GET /templates/mine`, requires auth) — never other users' own templates.
- **"Save as template"** (topbar button, pre-existing) calls `buildTemplateGraphFromProject` which strips
  concrete `assetId`s from media layers into empty reusable "slots" (`ensureTemplateSlots`) — this is what
  makes a template safe to apply into ANY project without dragging along someone else's media reference.
  `POST /templates` now stamps `userId: req.user.id`.
- **Apply is always append** (`appendTimelineComposition`, or `instantiateTemplateComposition` if the
  target project is empty) — non-destructive by construction, so there's no "replace" confirmation to
  build. The notice reports how many empty media slots still need an asset assigned.
- Own templates get a delete button on the gallery tile (`DELETE /templates/:id`, ownership-checked
  server-side); curated ones don't.
- Hidden from the inspector's replace-picker context (`clickAssigns`) — applying a whole composition
  doesn't make sense there.

## Tab membership (client-side grouping; one `listAssets()` load)

- **Local** = `source` local/absent, owned by the current project · **AI** = `ai` or
  `timeline-generated` (user-level, linked into this project) · **Brand** = `brand` (user-level, linked)
  · **Search** = query-driven (Stock + Graphics; empty query browses previously-imported
  `pexels`/`unsplash`/`graphic` assets already linked/owned here) · **Templates** = its own gallery, not
  `SourceAsset`-backed at all · **Used** = `usedCount > 0` (any source).

## Deferred (next phases — planned, not built)

- **Phase D — richer previews:** audio **waveforms** (Web Audio decode → cached mini-canvas/SVG) on audio
  cards; server-side thumbnail/proxy transcoding so big libraries don't decode originals.
- **Phase E — scale & management:** virtualized masonry for large libraries; multi-select + batch
  add/delete; drag-to-reorder & user folders; tag editing + filter-by-tag.
- **Phase F — coverage:** auto-register generated outputs (masks/cutouts/object-track,
  background-removed) as browsable AI/Generated assets; fonts & captions as library items; Unsplash
  provider actually wired (type exists, no adapter yet); paid sticker providers beyond Iconify's icon set;
  export-time auto-prompt to upload local assets before cloud render; project-scope the inspector's
  replace-picker `AssetBin` instance (see "Known gap" above).

## Gotchas

- **Prisma engine DLL lock (Windows)**: `prisma generate` fails with EPERM while `pnpm dev`
  (worker/API) holds the query engine. Stop dev, then `pnpm db:generate`.
- **Migrations need DATABASE_URL**: the API reads a default from `apps/api/src/config/env.ts`,
  but the Prisma CLI does not. Run migrations with
  `DATABASE_URL="postgresql://lumio:lumio@localhost:5432/lumio?schema=public"` set,
  e.g. `npx prisma migrate dev --schema prisma/schema.prisma --name <name> --skip-generate`.
- **exactOptionalPropertyTypes**: Prisma Json columns reject an explicit `undefined`; set those
  keys conditionally (spread `...(x ? {col:x} : {})`).
