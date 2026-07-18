# Assets / media

## v1 — Ingest proxy recipe history (2026-07-04 → 2026-07-06)
**Problem:** Live playback decoded original camera files (sparse-GOP 4K) against ~2-3 hardware decode
sessions — the root of the seek-catch-up/starvation/wedge family.
**Fix:** Per-SOURCE ingest proxies (Premiere model): H.264 ≤854px, source-fps capped 30, 1s GOP, AAC,
OPFS `orreris-source-proxies/`. `SOURCE_PROXY_VERSION` chronicle:
- v1: could bake a frozen tail (encoder kept last canvas after decoder death) + hardcoded 30fps judder.
- v2 (2026-07-05): frozen-tail guard + source-fps sampling.
- v3 (2026-07-06): invalidated everything the pre-worker engine built mid-playback (starved decoder).
- v4 (2026-07-06): invalidated proxies decoded from PARTIAL fragmented-MP4 indexes (frozen tail baked
  in with no null frames — the guard can't see clamped frames). Demux fix in webcodecs-decoder.ts.
**Invariants:** exports + freeze-frames read ORIGINAL bytes, never `proxyUrl`; viewer modal plays the
original; `proxyUrl` is a session blob URL — never persist it.

## v2 — Pexels/stock files are fragmented MP4s (2026-07-06)
**Problem:** Stock-tab and pexels.com downloads froze at a constant per-file timestamp (8.5–16.8s);
Clipchamp re-encodes of the SAME footage played fine at any length.
**Root cause:** fMP4/CMAF layout — sample table spread across `moof` fragments; our demuxer indexed
only the first fragment (see playback-preview.md v4 for the full mechanism).
**Fix:** fragmented-aware `demuxIndex` walk; proxy v4 rebuild.
**Note for the future:** any NEW decoder/probe that reads mp4box sample tables must handle
`info.isFragmented` — partial tables look completely valid (offsets/sizes present).

## v4 — HEVC (H.265) sources: WebCodecs rejected, slow main-thread proxy builds (2026-07-06, diagnosis)
**Problem:** Console showed `[export] VideoDecoder config unsupported → <video> fallback,
codec="hvc1.1.6.H120.b0"` plus mp4box `BoxParser` warnings (`size 1751411826` = the ASCII bytes
"hint" misread as a length — non-fatal atom-parse stumble in the same file).
**Root cause:** Chrome's WebCodecs only decodes HEVC with a platform hardware decoder and often
rejects High-tier configs. Designed fallback chain: proxy worker (WebCodecs-only) throws
`WEBCODECS_REQUIRED_NO_DOM` → engine re-runs the build on the MAIN THREAD with the hidden-<video>
seek-per-frame decoder → build succeeds but at ~real-time-or-slower, gated to paused/idle by the
background gate. Exports with HEVC sources take the same element fallback (correct, slower).
Once built, the proxy is H.264 → playback/scrub normal.
**Not a bug — platform limit.** Future nicety: "HEVC clip — optimizing takes longer" badge in the
media bin. The `[export]` log tag is just the shared decoder module's home, not an actual export.

## v3 — Thumbnail/waveform caches unbounded (2026-07-06)
**Problem:** Filmstrip data-URL strips, posters, and hi-res audio-peak arrays were cached in Maps
that never evicted; the shared AudioContext lived forever. Long sessions never plateaued in memory.
**Fix:** Bounded LRUs (200 strips / 200 posters / 100 peak arrays), extraction + decode gated behind
the background-work gate (see background-tasks.md v1), AudioContext closed after 30s idle.

## v5 — v4 field-confirmed on the :4173 production build (2026-07-07)
**Observation:** same signature as v4 on the built app — `sourceProxy.worker` rejects
`hvc1.1.6.H120.b0` (107B hvcC) → `<video>` fallback message from both the worker and the shared
`source-decoder` module, plus the BoxParser ASCII-as-length stumble (this file: `"hear"` =
1751411826; v4's was `"hint"`). Fallback chain engaged as designed, no freeze/regression — occurs
identically with `orreris.singleCtxPreview` on or off (decode pipeline, unrelated to Phase 5).
No action; v4's "HEVC clip — optimizing takes longer" badge remains the future nicety.

## v6 — Global asset pile across projects; AI folder structure (2026-07-07)
**Problem:** Every `SourceAsset` was user-level with no project scoping — uploading a clip in Project 1
made it appear in the Local tab of every other project too, so power users with 10+ projects saw one
giant undifferentiated pile instead of per-project media.
**Fix (Phase 1 — project-scoped media):** `SourceAsset.ownerProjectId` (mapped onto the legacy
`projectId` column, no data dropped) binds an upload to the project it was added to. Brand/AI assets
stay user-level & reusable; a new `ProjectAsset` join links a reusable asset into a project's bin
without duplicating bytes. `GET /assets?projectId&scope=project|library|all` scopes server-side; the
web local-first fallback mirrors the same filter via a `orreris_project_asset_links` localStorage map.
A one-shot backfill (`assets:backfill`) walked every existing project's `projectGraph` to link/assign
already-referenced assets so old projects didn't lose their bin media on migration (ran clean: 77
projects, 75 links, 27 sole-owner uploads assigned). Editor's `AssetBin` takes a `currentProjectId` and
hides uploads owned by a DIFFERENT project.
**Fix (Phase 2 — AI folders):** Widened `FolderAssetTab` to include `"ai"` so the AI tab gets the same
folder rail (create/rename/move bins) as Local/Brand. Two spots that assumed only local/brand existed
(the `activeAssetFolders` initial state and the folder-tab display label) were missing an `"ai"` case —
fixed before they could hit `undefined` at runtime.
**Verify:** `pnpm -r typecheck` (Phase 1: 5/5 packages) and `editor:test`, both green; backfill counts
printed and inspected; migration SQL inspected for no destructive `DROP COLUMN`.
**Known gap:** the inspector's replacement-picker `AssetBin` instance isn't project-scoped yet (no
project id threaded into that component) — defaults to legacy show-all; low risk, it's a picker not
the primary bin surface.

## v7 — Pixabay removed; unified provider-agnostic Search + Graphics (2026-07-07)
**Problem:** The Stock tab exposed provider identity (Pexels vs Pixabay buttons) in the UI, contrary to
the product decision to keep external-provider branding invisible behind one unified Search surface.
Pixabay itself was to be dropped entirely. There was also no way to browse/import royalty-free
graphics/icons (stickers, shapes, arrows) — only photo/video stock.
**Fix:** `StockProvider` collapsed to a single-member `"pexels"` union server-side (registry pattern kept
so adding a source later is additive); all Pixabay fetch/parse code, `PIXABAY_API_KEY`, and the
`"pixabay"` `AssetSource`/schema enum values deleted repo-wide. `POST /stock/import` now links the
imported asset into the requesting project (`ProjectAsset`) instead of leaving it unlinked. Added a new
`"graphic"` asset source backed by two content paths: an offline bundled inline-SVG shape pack
(`packages/shared/src/graphics/catalog.ts`) and searchable Iconify icons (`apps/web/src/lib/
graphics-search.ts`, no API key, fails soft on network/CSP failure). Both rasterize to a real PNG via
`apps/web/src/lib/rasterize-svg.ts` so an imported graphic is ordinary editable image media. The editor's
"Stock" tab is renamed "Search" with Photos/Videos/Graphics type chips replacing the provider picker; no
provider name is shown anywhere in badges/titles/empty-states.
**Verify:** `pnpm -r typecheck` (5/5, including after the breaking `AssetSource` enum change) and
`editor:test`, both green.
**Known gap:** Iconify sticker/emoji sets beyond line icons are not covered (icons only); a paid sticker
provider was explicitly deferred per the original plan.

## v8 — In-editor Templates gallery (curated + user-saved) + hover-autoplay removed (2026-07-08)
**Problem:** No way to drop a pre-designed timeline into the CURRENTLY OPEN project from inside the
editor — only a separate marketing page that starts a brand-new project. Separately, asset-bin video
thumbnails autoplayed on hover (both the general library grid and stock search results), which was noisy
and unwanted.
**Fix:** Found the hard part (cross-project asset safety for templates) already solved by existing
`buildTemplateGraphFromProject`/`instantiateTemplateComposition`/`ensureTemplateSlots` — templates store
media layers as empty "slots," never someone else's concrete asset id. Added: `Template.userId` (nullable,
existing rows stay curated/null), `GET /templates/mine` + `DELETE /templates/:id`, and a new in-editor
Templates tab that applies a template via `appendTimelineComposition` (always append — non-destructive,
no confirmation needed) and reports empty media slots honestly in the notice. Removed `autoPlay`/hover
`.play()` calls from both asset-tile media components; the general library grid keeps hover-scrub (paused
until the pointer moves), stock results just show a still.
**Verify:** `pnpm -r typecheck` (5/5), `editor:test`, both green.

## v9 — Stock re-import minted a duplicate asset row every time (2026-07-18)

**Problem:** User report: the stock folder looked "recreated after every refresh — the old
one retired/delinked". Bin showed both a lowercase "stock" tile and the "Stock" mount,
each 0 assets · 1 bin.

**Root cause (confirmed half):** `POST /stock/import` (stock.routes.ts) called
`prisma.sourceAsset.create` unconditionally — no lookup by (userId, provider, externalId).
Re-importing the same Pexels clip (new session, second project, double click) created a
brand-new library asset row each time; old rows lingered with dead project links.

**Fix:** import is now idempotent — `findFirst` on `externalJson.externalId` (+ userId +
source) returns the existing asset, upserts the ProjectAsset link on the
`(projectId, sourceAssetId)` unique, and (reference mode) refreshes rotated CDN URLs.
Only truly-new items create rows.

**Unconfirmed half (needs user data):** the LOWERCASE "stock" tile beside the "Stock"
mount. No code path writes `Stock/` or `local/stock` — likely a user-dropped disk folder
named "stock" or a manually created bin. Waiting on what's inside the two tiles before
touching folder normalization.

## v10 — The duplicate stock tree, confirmed: renaming the system-owned mount forks it (2026-07-18)

**Diagnosis (user's expanded-tree screenshot closed v9's open half):** two parallel trees —
`local/stock/pexels/video` (old, unused clips) and the real mount `stock/pexels/video`
(new, used clips). Renaming the stock mount bin was allowed: `applyRenameFolder` computed
`parent = "" || folderRoot` → relocated every stock asset to `local/<typed name>/pexels/…`
and left a custom-folder entry behind; the next `/stock/import` regenerated the canonical
mount beside it. "Recreated each time, old one retired/delinked" — exactly.

**Fix:** (a) `RESERVED_STOCK_BIN_RE` — rename AND delete refuse the server-owned paths
(`stock`, `stock/pexels`, `stock/pexels/<type>`); user-created bins under `stock/` stay
renamable. (b) One-time self-heal in the bin: stock-PROVIDER assets stranded under
`local/stock/…` (any case) move back to the canonical `stock/…` path and the leftover
custom-folder entries are pruned. Gated to provider sources — user media never moves.

**Lesson:** any system-generated folder tree needs an ownership guard at every user
mutation seam (rename/delete/move), or the generator and the user fork it forever.
