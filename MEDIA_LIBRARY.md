# Media Library — implementation notes

Living doc for the Asset / Media Library. Update this when the library changes so we don't
lose track of what's real vs deferred.

## What it is

A structured asset bin with top-level source tabs — **Local · AI · Stock · Brand · Used** —
plus type filters (All / Video / Image / Audio / Graphics), search, and redesigned cards
(thumbnail, type badge, source badge, dims/duration, used count, Add, More menu).

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
- **Hover-to-play.** Video tiles render a `<video preload="metadata" muted loop playsInline>` (src =
  `proxyUrl ?? previewUrl ?? fileUrl`, poster = `thumbnailUrl`) and `.play()` on mouse-enter / pause+reset
  on leave — so only the hovered card plays. Gated by `prefersReducedMotion()`.
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

## Data model (one unified model)

We extended the existing `SourceAsset` (NOT a new table) — it stays **user-level** (assets are
reusable across all of a user's projects).

- Shared type: `packages/shared/src/types.ts` → `SourceAsset` gained optional fields:
  `source`, `folder`, `tags[]`, `originalName`, `thumbnailUrl`, `previewUrl`, `proxyUrl`,
  `cloudUrl`, `fps`, `sizeBytes`, `projectId`, `external{provider,externalId,author,sourceUrl,license}`,
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
   `"brand"` from the Brand tab), sets `originalName`/`sizeBytes`.
2. **Stock (Pexels / Pixabay)** — real, **env-gated**:
   - Search: `GET /api/stock/:provider/search?q&type&page` (`apps/api/src/routes/stock.routes.ts`
     + `services/stock.service.ts`). Missing key → `/stock/status` reports false → UI shows an
     "add API key" state.
   - Import: `POST /api/stock/:provider/import` **downloads the file server-side** → `saveBuffer`
     → `SourceAsset` row with `source` + `external{}`. Frontend: `searchStock`/`importStock`.
   - Keys: `PEXELS_API_KEY`, `PIXABAY_API_KEY` (see `.env.example`).
   - **Controls (Pexels-style):** Photos/Videos is a dropdown to the *left of the search*; an
     **Orientation** filter (Any/Horizontal/Vertical/Square — native on Pexels, aspect-ratio filtered
     server-side for Pixabay) and an **Import quality** picker (Highest/4K/1080p/720p/SD) live in the
     control strip alongside the List/S-M-L view controls. **Show more** paginates
     (`STOCK_PER_PAGE`/`STOCK_PAGE_SIZE` = 24; a full page implies more).
   - **Quality/variants:** each `StockResult` carries `variants[]` (best-first, deduped by resolution
     label) and a `previewUrl` (smallest variant) for hover-preview. `pickStockVariant(result, quality)`
     chooses the closest variant; `importStock(result, variant)` downloads the chosen one.
   - **Hover-preview:** stock *video* tiles hover-play the lightweight `previewUrl` (`preload="none"`,
     `StockCardMedia`) so you can see the footage before importing. Import button is icon-only.
3. **AI / tool output** — tool results that produce real media call `createAsset()` tagged
   `source:"ai"` or `"timeline-generated"` (e.g. extract-person matte in
   `apps/web/src/tools/layer-effect-handlers.ts`).
4. **Timeline-generated** — "Save freeze frame" (camera button in the preview toolbar →
   `handleSaveFreezeFrame`) captures the selected video clip's current frame via `getVideoPoster`
   and saves it as a `timeline-generated` image. Shows in the **AI** tab.

## Tab membership (client-side grouping; one `listAssets()` load)

- **Local** = `source` local/absent · **AI** = `ai` or `timeline-generated` ·
  **Brand** = `brand` · **Stock** = imported `pexels`/`pixabay` (when search box empty) ·
  **Used** = `usedCount > 0` (any source).
- Stock tab: provider sub-tabs + photo/video toggle; typing searches the provider live, empty
  box shows your imported stock.

## Deferred (next phases — planned, not built)

- **Phase D — richer previews:** stock-video hover-preview (expose a preview-video URL on `StockResult`);
  audio **waveforms** (Web Audio decode → cached mini-canvas/SVG) on audio cards; server-side
  thumbnail/proxy transcoding so big libraries don't decode originals.
- **Phase E — scale & management:** virtualized masonry for large libraries; multi-select + batch
  add/delete; drag-to-reorder & user folders; tag editing + filter-by-tag.
- **Phase F — coverage:** auto-register generated outputs (masks/cutouts/object-track,
  background-removed) as browsable AI/Generated assets; fonts & captions as library items; Unsplash
  provider; per-project asset silos; export-time auto-prompt to upload local assets before cloud render.

## Gotchas

- **Prisma engine DLL lock (Windows)**: `prisma generate` fails with EPERM while `pnpm dev`
  (worker/API) holds the query engine. Stop dev, then `pnpm db:generate`.
- **Migrations need DATABASE_URL**: the API reads a default from `apps/api/src/config/env.ts`,
  but the Prisma CLI does not. Run migrations with
  `DATABASE_URL="postgresql://reelforge:reelforge@localhost:5432/reelforge?schema=public"` set,
  e.g. `npx prisma migrate dev --schema prisma/schema.prisma --name <name> --skip-generate`.
- **exactOptionalPropertyTypes**: Prisma Json columns reject an explicit `undefined`; set those
  keys conditionally (spread `...(x ? {col:x} : {})`).
