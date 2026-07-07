# AGENTS.md — live handoff log between AI coding agents (Claude / Codex)

Rules: check **Active Work Claims** before editing a claimed file; claim files before starting
non-trivial work on them; move finished work to the **Changelog** (dated, newest first) and release
the claim. `architecture.md` is the product tracker (what shipped) — this file is only about WHO is
working WHERE right now.

## Active Work Claims

| Agent | Area / files | Since | Notes |
|---|---|---|---|
| Claude | Source (ingest) proxy system: `sourceProxyStore.ts`, `sourceProxyEngine.ts`, `resolvePlaybackUrl` proxy wiring in EditorPage/VideoPreview; TimelineStrip trim+move gestures; VideoPreview memoization. | 2026-07-04 | Premiere-model per-SOURCE proxies (480p, 1s GOP, background transcode → `asset.proxyUrl`). Exports/freeze-frame keep ORIGINAL bytes — don't point any export path at `proxyUrl`. VideoPreview is now `memo`'d with a clockDriven-aware comparator; its EditorPage function props MUST stay `useStableHandler`-wrapped (`stablePreview*`). |
| Claude | — (Clip audio FX + ducking, speed ramps, res Auto toggle, clip fade handles SHIPPED, see changelog. wcDecode stage 2 still soaking, default OFF. Color investigation PAUSED, Downloads/color-debug.) | 2026-07-03 | Codex: `WebglMediaLayer.tsx` now has a dual frame source (WC provider OR `<video>` lease) — don't reintroduce a declarative `<video>` and route new draw sources through `drawVideoFrame`'s source selection. |

## Changelog

### 2026-07-07 — Claude: Phase 3 — unified Search (drop Pixabay, Pexels provider-agnostic) + Graphics (media/library plan)

Executes Phase 3 of `~/.claude/plans/project-scoped-media-and-libraries.md`. Phase 4 (curated/user-saved
Templates) and Phase 5 (docs) still PENDING.

- **Stock provider-agnostic + Pixabay removed entirely.** `apps/api/src/services/stock.service.ts`:
  `StockProvider` is now a single-member union (`"pexels"`), deleted all Pixabay fetch/parse code plus
  `PIXABAY_API_KEY` (`env.ts`); `stock.routes.ts` routes are provider-less (`/status`, `/search`, `/import`
  — no provider in the URL or response, matching the "one unified Search surface" decision). `POST
  /stock/import` now accepts an optional `projectId` and LINKS the imported asset into that project
  (`ProjectAsset`) rather than leaving it a dangling user-level asset — stock stays a reusable library
  asset like Brand/AI, consistent with Phase 1's model.
- Shared: `AssetSource`/`assetSourceSchema`/`AssetExternalRef.provider` drop `"pixabay"`, add `"graphic"`
  (imported bundled shape or Iconify icon) and `"iconify"` provider. This is a breaking union change —
  grepped and fixed every reference (`asset-serializer.ts`, `EditorPage.tsx`, `AssetViewerModal.tsx`,
  `api.ts`, `.env.example`, `global.css`'s now-dead `.asset-badge-pixabay` rule).
- **Graphics, bundled pack:** new `packages/shared/src/graphics/catalog.ts` — ~28 inline-SVG shapes/
  arrows/badges/lines/bubbles, zero network, `listBundledGraphics()`/`searchBundledGraphics(query)`.
- **Graphics, searchable icons:** new `apps/web/src/lib/graphics-search.ts` — Iconify's public search API
  (no key), fails soft to `[]` on any network/CSP failure (bundled pack still renders). New
  `apps/web/src/lib/rasterize-svg.ts` rasterizes either source's SVG to a real PNG `File` so an imported
  graphic is ordinary editable image media, not a special-cased vector layer type. Iconify SVGs are
  rendered via `<img src=".../icon.svg">` (never `dangerouslySetInnerHTML`, since that content is
  third-party) — only our own hardcoded bundled-pack strings use `dangerouslySetInnerHTML`.
- **Unified Search bin tab** (`EditorPage.tsx`): `AssetSourceTab`'s `"stock"` renamed to `"search"`
  (mechanical rename across ~12 call sites); the old Pexels/Pixabay provider-picker buttons replaced with
  Photos/Videos/Graphics type chips; no provider name shown anywhere in the UI (badges/titles/empty-states
  all genericized to "Stock"/"Graphic"). Graphics imports are project-scoped directly (`ownerProjectId`),
  same as a local upload, since each is freshly rasterized rather than a reusable pre-existing object.
  Also fixed a Phase-2 gap found while in this code: `folderCrumbs`' root-label ternary didn't cover the
  AI tab (only checked brand/local) — now uses the shared `folderTabLabel`.
- Gates green: `pnpm -r typecheck` (5/5, including after the breaking enum removal), `editor:test`.
- NOTE: an unrelated concurrent session still has uncommitted changes to `apps/web/src/tools/*` and
  `packages/shared/src/skills/*` — left untouched, not staged in this commit.

### 2026-07-07 — Claude: Phase 2 — AI folder structure (media/library plan)

Executes Phase 2 of `~/.claude/plans/project-scoped-media-and-libraries.md`. Phases 3–5 (unified
provider-agnostic Search + Graphics, curated/user-saved Templates, docs) still PENDING.

- `EditorPage.tsx`: `FolderAssetTab` widened to `"local" | "brand" | "ai"`; `isFolderAssetTab` updated.
  AI tab now gets the same folder rail as Local/Brand (create/rename/move bins, per-tab active-folder
  state persisted to `localStorage["lumio_asset_folder_ai"]`).
  Fixed two spots that indexed `activeAssetFolders` / labeled the folder tab without an `"ai"` case
  (would have been `undefined` at runtime): the `activeAssetFolders` initial state and
  `currentFolderLabel`'s tab-name ternary (now a `folderTabLabel` lookup covering all three tabs).
  Upload dropzone (`showUpload`) intentionally stays Local/Brand only — AI assets arrive via
  generation, not drag-drop upload; folder organization/navigation works regardless.
- AI asset creation (`apps/web/src/generate/generateClient.ts`) already wrote `folder: ai/<taskId>` — no
  change needed there; confirmed it's the only client-side AI creation site.
- Gates green: `pnpm --filter @lumio-by-aelivion/web typecheck`, `editor:test`.
- NOTE: an unrelated concurrent session has uncommitted changes to `apps/web/src/tools/*` and
  `packages/shared/src/skills/*` (executor/skills work) — left untouched, not staged in this commit.

### 2026-07-07 — Claude: Phase 1 — project-scoped media (foundation for the media/library plan)

Executes Phase 1 of `~/.claude/plans/project-scoped-media-and-libraries.md`. Phases 2–5 (AI folders, unified
provider-agnostic Search + Graphics, curated/user-saved Templates, docs) are still PENDING and being handed to
another agent — read that plan file before continuing.

- **Model:** uploads bind to a project via `SourceAsset.ownerProjectId` (`@map("projectId")` — reuses the legacy
  column, no data dropped). Brand/AI stay user-level & reusable; `ProjectAsset` join links a library asset into
  a project's bin without copying bytes. Named the pre-existing Project↔SourceAsset relation
  (`ProjectPrimarySource`) to disambiguate from the new `ProjectUploads`. Migration `project_scoped_media`.
- **API:** `GET /assets?projectId&scope=project|library|all`; create sets owner + auto-links; `POST`/`DELETE`
  `/assets/:id/link`; serializer emits `ownerProjectId` (mirrors to legacy `projectId` for back-compat). AI
  generations stay user-level and link to the generating project.
- **Backfill:** `pnpm --filter @lumio-by-aelivion/api assets:backfill` (ran: 77 projects, 75 links, 27 sole-owner
  uploads) so existing projects keep their bin media. Idempotent.
- **Web:** `listAssets(projectId?, scope?)` + local-first links mirror (`lumio_project_asset_links`) +
  `linkAssetToProject`/`unlinkAssetFromProject`. `AssetBin` takes `currentProjectId` and hides uploads owned by
  OTHER projects (the "pile" fix) while keeping library tabs global; link-on-add for library assets.
- **Known gap (deferred):** the inspector's replacement-picker AssetBin isn't project-scoped yet (no projectId in
  scope there) — defaults to legacy show-all.
- Gates green: `pnpm -r typecheck` (5/5), `editor:test`. Commit `c6163da`.
- NOTE: API+worker dev processes were stopped to run prisma migrate (Windows DLL lock) — restart `pnpm dev`.

### 2026-07-07 — Claude: DIAGNOSIS (not fixed) — local export produces 90°-rotated clips for phone videos

Root cause found, fix deferred. Nothing in web/worker reads the container's **rotation/display matrix** (tkhd).
Preview is correct because proxies are built by drawing an `HTMLVideoElement` to a canvas
(`proxyMediaStore.ts`, `sourceProxyEngine.ts`, `sourceProxy.worker.ts`, `viewerProxyCapture.ts`) and a `<video>`
element auto-applies rotation; ingest also reads `video.videoWidth/Height` (post-rotation dims). But **export
reads ORIGINAL bytes via WebCodecs `VideoDecoder`** (per the "exports read original bytes never proxyUrl" rule),
which emits **coded frames with rotation NOT applied** → a portrait phone clip decodes landscape and is drawn
into a portrait layer box → rotated export. Only clips carrying a rotation flag are affected ("some clips").
**Fix direction:** parse track rotation (mp4box exposes tkhd `matrix`) during demux, thread a `rotationDeg` onto
the decoded source, and rotate the `VideoFrame` 90/180/270 in the export scene compositor before compositing
(or bake rotation during a normalization transcode) — must land shared so preview/export stay pixel-aligned.

### 2026-07-07 — Claude: `.lumio` export/import hardening (default `.lumio`, async zip, trust-split caps)

- **Default export is now `.lumio`** (self-contained ZIP with embedded media), not the bare `.lumio-template.json` — plain click = `.lumio`, Shift+click = the lightweight bare JSON (`EditorPage.tsx` export button + tooltip).
- **Export no longer freezes the UI:** `buildLumioPackageZip` ran `zipSync(level 6)` on the main thread, re-DEFLATEing already-compressed media. Now media is STORED (`level 0`) and there's a new `buildLumioPackageZipAsync` (fflate worker threads) that the editor uses, with a "Building…" notice. Sync builder kept for tests.
- **`.lumio` has NO size limits by default** (it's the user's own project; export was uncapped, so import must be too). Old 512 MB / 256 MB-per-asset / 64-asset caps removed from the default path. `parseLumioPackageZipAsync` (new, off-thread) is what the editor imports with; sync `parseLumioPackageZip` kept for tests. Untrusted callers can still pass `maxPackageBytes`/`maxAssetBytes`/`maxAssetCount` explicitly ("others").
- **Zip-bomb guard retained (crash-prevention, not a product limit):** only the DEFLATE'd metadata (`manifest.json`/`timeline.json`) is capped at 512 MB decompressed via fflate's pre-decompress `filter`; embedded media under `assets/` is STORED so it can't amplify and stays unlimited. Manifest content-safety scan (`javascript:`/`importScripts` deny-list) is unchanged — `.lumio` is declarative data, no arbitrary-code execution.
- **Gates green:** `pnpm -r typecheck` (5/5), `editor:test` (`.lumio` round-trip incl. byte-for-byte asset survival).
- Files: `packages/shared/src/plugin-package-zip.ts`, `apps/web/src/pages/EditorPage.tsx`.

### 2026-07-07 — Claude: Day 2 — NLE import fidelity (titles/transitions/multi-sequence) + FCPXML export

- **Shared transition-name table:** `mapExternalTransition(name)` in `external-timeline-adapter.ts` replaces the old per-format "dissolve or nothing" checks — every importer (FCPXML, `.prproj`) and the new exporter route through the SAME table (Cross/Film Dissolve, Dip to Black/White, Wipe, Push, Slide, Cross Zoom, Iris; unknown → Cross Dissolve, never dropped).
- **FCPXML import fidelity:** `<title>` → editable text layer (text + font/size/weight/italic/color/alignment from `<text-style-def>`); `<transition>` → `transitionIn` on the following clip; `<adjust-opacity><keyframe>` → layer `animations`. Previously titles were skipped entirely and transitions always reported unsupported.
- **`.prproj` multi-sequence picker:** `report.availableSequences` lists every candidate sequence; `ParseExternalTimelineInput.sequenceId` + a new `<select>` in `ExternalTimelineImportModal` let a user pick ANY sequence, not just the auto-selected "most clips" one (re-parses from a stored raw-contents state, no re-prompt for the file).
- **New: FCPXML export.** `packages/shared/src/external-timeline-exporter.ts` `exportCompositionToFcpxml(composition, assets)` writes FCPXML 1.10 (clips/titles/transitions via the reverse of the shared name table); masks/text-warp/plugin-shader/blend-modes/keyframes are honestly reported as lossy in `report.unsupported`, never silently dropped. Wired to a new topbar "Export FCPXML" button. Round-trip verified: export → re-import matches clip count, timing, title text, and transition kind.
- **Known ceiling (documented, not attempted):** `.prproj` Position/Scale/Rotation motion-keyframe extraction — the real Premiere object-ref graph (`tmp/visualizer-full.prproj.xml`) is too deeply escaped/nested for the existing regex-based parser to walk reliably; see `project-tracker/nle-import-export.md` v1 for the full reasoning. CapCut import and MOGRT/Essential-Graphics extraction remain out of scope.
- **Gates green:** `pnpm -r typecheck`, `editor:test` (24 new asserts across transition-mapping/FCPXML-fidelity/multi-sequence/FCPXML-export-round-trip, zero failures).
- Files touched: `packages/shared/src/external-timeline-adapter.ts`, `external-timeline-exporter.ts` (new), `index.ts`; `apps/web/src/pages/EditorPage.tsx` (multi-sequence picker state + FCPXML export button), `apps/web/src/editor/editor.test.ts`; `examples/timeline-imports/simple-fcpxml.fcpxml` (extended with title/transition/keyframe); `project-tracker/nle-import-export.md` (new), `project-tracker/README.md`, `PLUGIN_ARCHITECTURE.md`.

### 2026-07-07 — Claude: Day 1 — real `webgl-fragment` effect engine + `.lumio` ZIP packages (plugin system)

- **Real GLSL "Custom Shader" effect (flagship plugin gap closed).** New `packages/shared/src/color/fragment-effects/registry.ts` mirrors the transition engine's registry+harness pattern: a plugin's `vec4 effect(vec2 uv)` body compiles into the SAME shader on preview/export/Remotion. New `pluginShader` `TimelineEffectType` (`types.ts`, `effects.ts`); `plugin-effect-adapter.ts` now supports `engine: "webgl-fragment"` — registers the GLSL and produces a `pluginShader` effect carrying `params.__shaderManifestId` + defaulted params (vec3→hex string, vec2→JSON string, matching existing param-storage conventions).
- **Render seam:** `SceneCompositor` gets a new `fragmentPasses` array on `SceneLayerDraw` (`SceneFragmentPass`), rendered inside the SAME per-layer nest `regionPasses` already uses (`renderLayerWithRegionPasses`), AFTER region passes, in effects-index order — never a second nest (would double-apply opacity/blend). Compile failures skip the pass + warn once, never black-frame. `build-scene-draws.ts`'s new `buildFragmentPasses` scans `layer.effects` for enabled `pluginShader` entries, resolves keyframed params via the existing `evaluateTimelineEffectParam`, and builds a per-effect mask via `SceneMaskMatteCache` when the effect carries its own `masks`.
- **Remotion registration gap (the #1 preview/export-divergence trap, per the plan's own risk list) is fixed:** `SceneStage.tsx` now calls `registerEffectManifests(manifest.plugins.effects, {override:true})` — previously effects were never re-registered for Remotion (fine for presets, would have rendered fragment effects BLANK in export).
- **Inspector:** `pluginShader` effects render their param controls dynamically from the fragment def (`EditorPage.tsx` `buildPluginShaderParamDefinitions`), reusing the existing number/color/boolean controls — no new control types.
- **Verified:** `render:compare:pixels` — 24/24 fixtures (incl. new `plugin-shader`) at **0.000%** diff, proving preview == export == Remotion for a real user shader. `scene:compare` 22/22 (the DOM-parity gate correctly excludes `plugin-shader` by default — the DOM renderer has no fragment-shader pass, so that comparison isn't meaningful; still available via `PIXEL_FIXTURES=plugin-shader` for manual inspection). Example manifest: `examples/plugin-manifests/invert.effect.json`.
- **`.lumio` ZIP packages with embedded media:** new `packages/shared/src/plugin-package-zip.ts` (fflate) builds/parses a `.lumio` ZIP (`manifest.json` + `timeline.json` + `assets/<id>.<ext>` + optional `previews/`), detected by ZIP magic bytes so bare `.lumio-template.json` keeps working. Editor: Shift+click the export-template-package button for the ZIP-with-media path (reads bytes from the local blob store or `fetch(fileUrl)`); import creates real local assets per embedded file and remaps `layer.assetId` (root + `graph.compositions`) to the new ids — no relink-by-warning. Example: `examples/plugin-manifests/sample-template.lumio`.
- **Gates green:** `pnpm -r typecheck`, `editor:test` (incl. new zip round-trip + fixture asserts), `scene:compare` 22/22, `render:compare:pixels` 24/24 @ 0.000%.
- Files touched: `packages/shared/src/color/fragment-effects/registry.ts` (new), `color/scene-compositor.ts`, `color/index.ts`, `scene/build-scene-draws.ts`, `types.ts`, `effects.ts`, `plugin-effect-adapter.ts`, `plugin-manifest.ts` (none needed — `webgl-fragment`/`vec2`/`vec3` param types already existed), `plugin-safety.ts` (added `webgl-fragment` to supported-engine check), `plugin-package-zip.ts` (new), `index.ts`; `apps/web/src/pages/EditorPage.tsx`, `apps/web/src/editor/effects/pluginManifestStore.ts`, `apps/web/src/lib/asset-blob-store.ts` (import only); `apps/worker/src/remotion/SceneStage.tsx`, `apps/worker/src/scene-compositor-compare.ts`; `examples/plugin-manifests/invert.effect.json` + `sample-template.lumio` (new); `apps/web/src/editor/editor.test.ts`.

### 2026-07-07 — Claude (Fable): Phase 5 GPU-first single-context preview — DEFAULT ON (flipped same day, user go)

- **Flip (tracker v10):** `getSingleCtxPreviewEnabled()` now defaults TRUE after the ladder re-ran
  green on the flipped default — `scene:compare` 22/22 AND `render:compare:pixels` 23/23 at 0.000%
  (the in-context preview is pixel-aligned with Remotion). Escape hatch `?singleCtxPreview=0` /
  localStorage `"0"`; rollback = one line back to `false`. Per-clip-context media path remains in
  the tree (DOM-compositor mode uses it) — do NOT delete it.

- **Scene-mode media can now grade IN-CONTEXT on the SceneCompositor's own WebGL2 context** (the
  export's proven `exportSingleContext` architecture, brought to the preview): `WebglMediaLayer`
  with the new `sceneMediaSink` prop creates NO per-clip GL context — it publishes a raw
  frame-source descriptor (new `apps/web/src/components/scene-media-source.ts`) and
  `ScenePreviewCanvas` uploads ONCE + grades through pooled shared-context `MediaWebGLRenderer` +
  `RenderTarget` (returned as `SceneTextureSource`, sampled directly). 1 upload/layer/frame instead
  of 2, zero per-clip contexts, static stills re-grade-skip to zero uploads.
- **Codex note:** the dual frame source rule still holds — `selectVideoDrawSource()` is now the
  single source-selection for BOTH modes (own-canvas draw + single-ctx `snapshot()`); route any new
  draw source through it, never around it. The sink prop's PRESENCE is the mode switch.
- Async PBO scope readback (`SceneCompositor.readCompositeThumbnailAsync`, WebGL2 fence) replaces
  the synchronous scopes `readPixels` — gated behind the SAME flag; OFF keeps the sync path.
- Gates (final code): typecheck 5/5, editor:test, governor:test, `scene:compare` chrome OFF 22/22
  + `SINGLE_CTX_PREVIEW=1` 22/22 at zero threshold changes, `render:compare:pixels` 23/23 at
  0.000% ×2, engagement probe (`__rfSingleCtxPreview`). Tracker: playback-preview v8.
- **Harness fix (flagged for user sign-off):** `render-pixel-comparison.ts` was missing the
  scene-paint settle its sibling gate has — screenshots raced first GPU present → random black
  captures (~88% "diffs"). Added the 250ms wait; capture-sync only, no thresholds touched.
- **Soak fix (tracker v9):** ruler-click black flicker — mid-seek `readyState` dip made
  `snapshot().frame` null → layer dropped for a composite. `gradeMediaInContext` now holds the last
  graded RenderTarget while the source is transiently unready (the old graded-canvas semantics).

### 2026-07-07 — Claude (Opus): Skill engine + AI asset generation (Studio + chat), fal.ai/local

- **NEW skill engine** `packages/shared/src/skills/*` — generalizes the capability-index idea into a
  first-class `Skill` (always-disclosed `aiSummary` + on-demand `procedure` + typed `taskKinds`). One
  skill implemented: `assetGenerationSkill` (text/image→image, text/image→video, inpaint/outpaint,
  upscale). `describeSkillsForPlanner()` is wired INTO `capability-index.describeForPlanner()`, so the
  planner sees generation as a real capability. Added `generatedImage`/`generatedVideo` to
  `ToolArtifactType`.
- **Model capability registry + resolver** (`model-registry.ts`, `resolveModels.ts`) — the "which model
  is capable, and is it available" answer. Filters by capability (task/modality/inputs/constraints) AND
  availability (fal key / reachable local endpoint / BYO), then ranks **local-first** (image) with
  video always resolving to cloud. Asserted by `apps/worker/src/skills-resolver-test.ts` (`pnpm
  --filter @lumio-by-aelivion/worker skills:test`).
- **API cloud route** — `GenerationJob` Prisma model (+ migration `20260707120000_add_generation_job`,
  APPLIED to dev DB), `generationRouter.service.ts` (fal.ai queue submit/poll/download, `FAL_KEY` held
  server-side, mirrors the aiGateway pool pattern), `routes/generate.routes.ts` (`POST /api/generate`,
  `GET /api/generate/:id`, `GET /api/generate/availability`), registered in `app.ts`. Completed media is
  ingested as `SourceAsset(source="ai", aiJson=…)` — **no schema change** (fields already existed) → it
  lands in the media library AI tab automatically. Jobs run in-process background (BullMQ is the
  durable-scale path later).
- **Web local route** — `apps/web/src/generate/localGen.ts` + `LocalGenPanel.tsx` mirror `ai/ollama.ts`:
  browser talks directly to a local AUTOMATIC1111 server (`--api --cors-allow-origins`), free/private,
  image-only (ComfyUI probes but needs a workflow — deferred). `generateClient.ts` is the orchestrator
  (resolve → local-direct or cloud-poll → SourceAsset).
- **Generate Studio** (`components/generate/GenerateStudio.tsx`, CSS in `global.css` under
  `.gen-studio*`) — near-fullscreen floating overlay (NOT a new tab, on purpose: generation is
  iterative and context-bound). Prompt/refs/aspect/duration/variations/seed, availability-driven model
  picker (local·free vs cloud), history grid, add-to-timeline. Lazy-mounted in EditorPage; opened from
  the AI dock composer's Generate button (`onOpenGenerate`).
- **Chat integration** — new `PlanStepKind "skill"` (`ai/types.ts`), `PlanExecutor.runSkillStep` dep +
  branch, `LlmPlanner.validateSteps` accepts+validates skill steps against the skill schema, and the
  planner system prompt (`ai-prompts.ts`) documents the `skill` step + examples. AiChatPanel's
  `runSkillStep`: **image → generate inline and drop on the timeline; video → open the Studio
  pre-filled** (the async video handoff). Additive throughout — did not touch timeline/proxy/color
  internals. Gates: shared+web+api+worker typecheck, skills:test, web production build.

### 2026-07-07 — Claude (Opus): topbar status cleanup + badge/button restyle (CSS + small EditorPage logic)

- **Duplicate "export ready" resolved**: the topbar-center `<Badge>{project.status}</Badge>` (persistent
  DB lifecycle status) and the right-hand `SyncBadge` (live sync/render state) both surfaced "export
  ready". Center badge now only renders for NON-ready statuses (`isReadyProjectStatus` /
  `READY_PROJECT_STATUSES` in EditorPage.tsx) so it has one job — flag a work-in-progress Draft — and
  uses a neutral `muted` tone (was `lime`), reserving green exclusively for the SyncBadge's live "Export
  ready". `formatProjectStatus` Title-Cases the raw enum (no more `EXPORT_READY` underscore soup).
- **SyncBadge de-pilled**: `.sync-badge` is now flat (dot + colored label, no border/background/pill) to
  match the `AiActivityIndicator` ("Export N%") weight; per-state rules keep only the color.
- **Download button + credit badge**: both restyled to transparent bg + `var(--nle-accent)` border
  (theme-aware), compact `--nle-ctl-h`. The credit-badge accent rule is scoped to `.editor-topbar` only
  (marketing/tool-page credit badges keep the filled pill). Export stays the only solid-fill primary.

### 2026-07-06 (cont. 5) — Claude (Fable): Phase 4 resilience (degradation controller, crash telemetry, origin-split doc)

- **`degradation.ts`** (started from EditorPage mount): long-task pressure (>30% of trailing 5s)
  → background gate reason `"pressure"` + one adaptive-cap step-down + "Performance mode" notice;
  Chrome heap >85% of limit → gate reason `"memory"` + clears the filmstrip/poster/peak LRUs
  (new `clearThumbnailCaches`/`clearAudioPeakCaches` exports). Hysteresis both directions;
  telemetry `__rfDegradation`. `BackgroundGateReason` union grew — the gate is still the single
  authority, add new suspension conditions THERE, not in producers.
- **`crash-telemetry.ts`** (installed in main.tsx): onerror/unhandledrejection → localStorage ring
  buffer `lumio.crashLog` (survives hard crashes); next boot surfaces the previous session's tail;
  `window.__rfCrashLog`.
- README documents the `:5173`/`:4173` separate-storage-universe rule + stale-SW bundle-hash check.
- Gates: web typecheck, editor:test, production build.

### 2026-07-06 (cont. 4) — Claude (Fable): WC live-clock frame serving + GPU context-loss recovery fix

- **Ingest-proxy motion no longer capped at the clock-commit cadence** (tracker playback-preview
  v5→v6): `requestWcFrame` reads `getLivePlaybackTime()` while playing, guarded by
  `WC_LIVE_CLOCK_MAX_DIVERGENCE_S` (0.35s) so non-editor VideoPreview mounts / fast shuttle fall
  back to the committed prop. Probe on the user's project: ½ and ¼ tiers now EQUAL at ~22.5
  distinct frames/s (was ~25 vs ~11).
- **GPU compositor recovery ladder actually retries now** (tracker playback-preview v7): compile/
  link on a lost context throws `GL_CONTEXT_LOST`/`MEDIA_RENDERER_CONTEXT_LOST` sentinels instead
  of "shader compile failed: unknown" (gl-context.ts, media-renderer.ts); ScenePreviewCanvas keys
  its `<canvas>` on `recoveryTick` (fresh element + context per rebuild — getContext on a lost
  canvas returns the dead context) and re-attaches lost/restored listeners per tick. Was: first
  rebuild attempt hard-failed to the DOM path; user-visible as black frames on frame-stepping.
- HEVC sources diagnosed (assets-media v4): WebCodecs rejects → designed main-thread element-decode
  fallback for proxy builds/exports — slow but correct; not a bug.
- Gates: shared+web typecheck, governor:test, editor:test, color pixel gate (earlier, 0.000%),
  production build.

### 2026-07-06 (cont. 3) — Claude (Fable): Phase 3 UI fast pass (memo TimelineStrip/inspector, toast store, GPU upload micro-fix)

- **`memo(TimelineStrip)`** with ALL ~50 callback props frozen through a new grouped
  `useStableHandlers` hook (useStableHandler.ts) — the `timelineHandlers` block in EditorPage is
  spread onto the strip. `markers` memoized (`normalizeTimelineMarkers` returned a fresh array per
  render). Strip body: `rulerMarks` + per-track junction map memoized, `shapeSelectOptions` hoisted.
  Any NEW prop added to TimelineStrip must be identity-stable (add it to `timelineHandlers`, or
  state/memo for data) or it silently defeats the memo.
- **`notice` toast → `lib/noticeStore.tsx` module store + `<NoticeToast/>` leaf.** `setNotice` keeps
  its exact name/signature (now an import; ~106 call sites untouched) and NO LONGER re-renders
  EditorPage — don't add EditorPage state for transient feedback, use the store.
- **`memo(LayerInspector)` + `memo(InspectorHost)`**, hoisted `panelIds` constants
  (TRANSFORM/CONTENT/MASK/TEXT_WARP_PANEL_IDS), memoized composition-size object, and an
  `inspectorHandlers` useStableHandlers block (handlers self-guard the no-inspected-layer case).
- **WebglMediaLayer:** the three per-render `JSON.stringify` keys (pipeline/mediaEffects/transition)
  are now `useMemo`'d on object identity.
- **MediaWebGLRenderer (`packages/shared`):** per-frame `texImage2D` full realloc →
  `texSubImage2D` in-place upload when the source's intrinsic size matches the last allocation
  (`uploadedTexSizes`; realloc + record on size change/error). Verified pixel-identical:
  `color:compare` gate 0.000% diff (0/2,073,600).
- **DIAGNOSIS logged, no code:** ingest-proxy playback motion is gated to the playback clock's
  commit cadence (40/90ms) via the WC request path → ~11–25fps feel while HUD shows 65–72fps. Full
  mechanism + fix direction in project-tracker/playback-preview.md v5. New tracker category
  project-tracker/editor-ui.md (v1 = this pass).
- Gates: `pnpm -r typecheck` ✓, web `editor:test` all pass ✓, color pixel gate 0.000% ✓, production
  build ✓ (`index-Cu6PG4wB.js`).

### 2026-07-06 (cont. 2) — Claude (Fable): fragmented-MP4 demux fix (freeze cause #4) + Phase 2 background gate + project-tracker/

- **Fragmented MP4s (Pexels/CMAF) froze at a constant per-file timestamp** (8.5–16.8s): `demuxIndex`
  (webcodecs-decoder.ts) accepted the onReady sample table as the whole movie, but for fMP4 that's only
  the FIRST fragment; `chunkIndexForMicros` clamps past it, and proxy builds BAKED the frozen tail in
  (clamped frames aren't null → frozen-tail guard blind). Fix: when `info.isFragmented`, keep following
  mp4box's next-parse positions to EOF (full index, absolute offsets → existing streaming window works).
  `SOURCE_PROXY_VERSION` 3→4. Verified: Node demux probe (250→1108 samples on beach.mp4) + harness played
  the user's 47.2s Pexels project end-to-end. **Any mp4box sample-table consumer must handle isFragmented.**
- **Phase 2 — background-work gate**: new `editor/performance/backgroundScheduler.ts` (single gate:
  playing / timeline-gesture / exporting; `waitWhileBackgroundBlocked` + debounced `whenBackgroundIdle`).
  Wired: source-proxy suspension (whole gate), span generation (loop + gate-reopen re-kick), filmstrip/
  poster extraction, audio-peak decode, still proxies, worker transcode tail. Bounded LRUs for
  filmstrips/posters/peaks; AudioContext closes after 30s idle. Scopes decimation found already solved
  by the cold-clock suspension. Telemetry: `__rfBgGate`.
- **NEW: `project-tracker/`** (user directive): append-only versioned problem/solution log per category
  (playback-preview, assets-media, timeline, background-tasks, export, infrastructure). ADD entries on
  recurrence — never rewrite. Seeded with the full freeze saga (v1–v4). Add to it when you fix anything
  non-trivial.

### 2026-07-06 (cont.) — Claude (Fable): Phase 1 CONFIRMED FIXED (user + Playwright harness); root causes were THREE stacked bugs

User-confirmed fixed after the follow-ups below. The "plays ~4s then freezes" was three independent causes wearing one symptom:
1. Corrupt v2 ingest proxies on the build origin (built mid-playback by the old main-thread engine) → **SOURCE_PROXY_VERSION bumped to 3** (sourceProxyStore.ts) to force rebuilds through the new worker.
2. The WC preview pool grinding sparse-GOP ORIGINALS (1 sync/250 samples) for clips whose proxy didn't exist yet → **`preferNativeDecode` prop** (VideoPreview → WebglMediaLayer): original-bytes sources skip `acquirePreviewFrameProvider` entirely and play via the native element; they upgrade to WC automatically when the proxy lands (src flips).
3. Stale-bundle confusion: the OLD CacheFirst service worker kept serving pre-fix chunks — diagnose with the bundle hash in console; fixed going forward by 1d (NetworkFirst).
New self-heals in the WebglMediaLayer watchdog: **SELF-HEAL 3** (element >1s behind while playing → re-seek+resume, rate-limited 2.5s, `__rfElementNudges`) and **SELF-HEAL 4** (no paint for 1s while playing → forced draw, `__rfStaleDrawKicks` — catches the rvfc-quiet state that frame-rate telemetry cannot see; user finding: "HUD 75fps but viewer still").
**Repro harness**: `scratchpad/repro-freeze.mjs` (Playwright + channel:chrome against :4173; mints a JWT with the API secret, screenshot-hashes the viewer every 500ms + dumps __rf* telemetry; persistent-profile mode builds proxies paused then replays warm). Both cache states play the user's 45.8s project end-to-end clean.
Known benign leftovers for Phase 2: worker transcode's audio/finalize tail isn't suspension-gated (frame loop is); WC hold occasionally re-presents a stale frame (the "jumped" cyan/blue band texture).

### 2026-07-06 — Claude (Fable): Preview-never-freezes Phase 1 (build-only "plays ~4s then freezes" fix)

Root cause chain (production build `:4173` = separate origin, cold OPFS): ingest-proxy transcodes
started ON THE MAIN THREAD the moment play did (old rule only suspended at full quality), starving
the live layers hidden under the proxy overlay; at span exit the overlay hid itself INSTANTLY and
unconditionally, exposing whatever silently-wedged frame the live layer produced while covered.

- **1a — builds suspend during ANY playback** (`EditorPage.tsx`: `setSourceProxyBuildSuspended(isPlaying)`;
  user decision 2026-07-06 supersedes the full-quality-only rule).
- **1b — transcode moved into a Worker**: new `sourceProxy.worker.ts` + `sourceProxyWorkerProtocol.ts`
  (editor/performance). Main thread keeps queue/OPFS/`<video>` probe/audio pre-decode (PCM planes
  copied+transferred); worker does WebCodecs SW decode → OffscreenCanvas → H.264+AAC encode, frozen-tail
  guard ported verbatim; suspension forwarded as messages; WEBCODECS_REQUIRED_NO_DOM/worker-crash →
  main-thread fallback (deterministic build failures do NOT fall back).
- **1c — span-exit handoff hardening**: `ProxyPlaybackLayer` now fires `onCoverageEnding` (lookahead
  says span ends into a live region) and `onCoverageEnd` (coverage exited while playing; front held up
  to 250ms instead of instant reveal). Both call `requestLiveReprime()` (exported from
  `WebglMediaLayer.tsx`): every video layer heals a busy-wedge on the spot / requests a WC frame /
  re-seeks + resumes the element. Telemetry: `__rfSpanExitReprimes`; acceptance stays `__rfLiveFreeze`.
- **1d — SW chunk rule**: `vite.config.ts` JS/wasm runtime caching CacheFirst → NetworkFirst (the SW
  intercepts module-worker chunk fetches; CacheFirst was a build-only staleness surface no dev session
  exercises).
- **1e — cold-origin notice**: first REAL transcode of a session fires `setSourceProxyFirstBuildListener`
  → passive "Optimizing media in the background" toast. NOTE: `:4173` (vite preview) and `:5173` (dev)
  are separate browser-storage universes (localStorage + OPFS) — cold caches on the build origin are
  expected; the first session there rebuilds proxies while paused.
- Gates: web typecheck clean, `editor:test` all pass, `pnpm --filter web build` clean (worker chunk
  emitted). Phases 2–5 (background scheduler, UI fast pass, resilience, single-context GPU preview)
  are planned but NOT started — Phase 1 must soak in the real build first.

### 2026-07-06 — Claude (Sonnet): DaVinci-style redesign polish — theme system, source monitor drag-drop, timeline header rework, inspector/color parity

- **Multi-accent theme system**: `data-lumio-theme` attribute on `.editor-page` + a topbar Theme picker
  (7 presets: Ocean Blue/Warm Amber/Neutral Graphite/Ember Red/Bamboo Green/Sunset Orange/Neon Green).
  Bulk-converted ~200 hardcoded `rgba(77,159,255,*)`/`#4d9fff`/`#4f9cff` literals in `global.css` to
  `color-mix(in srgb, var(--nle-accent) N%, transparent)`. **Gotcha**: the `--editor-accent`/`--primary`
  alias layer had to be RE-DECLARED on `.editor-page` (not just `:root`) — var() references inside a
  custom property resolve where that property is declared, so the `:root`-level aliases were frozen to
  the default blue and never picked up the per-theme `--nle-accent` override. If you add new accent-
  colored UI, read `var(--nle-accent)` (or an alias declared on `.editor-page`) directly — don't
  hardcode a blue literal.
- **Source monitor drag-drop completed**: bin-tile → source monitor now loads that asset
  (`SourceMonitor` `onLoadAssetId` prop + `onDragOver`/`onDrop` on `.source-monitor`, guarded against
  its own outgoing `SOURCE_DRAG_MIME` drags); source monitor → program viewer now **inserts** (not
  overwrite — a drop must never silently delete clips under the playhead) at the timeline in-point,
  respecting the marked in/out range + V/A/V+A mode. Verified via synthetic Playwright DnD that trimmed
  duration matches the marked range in both the timeline-lane and program-viewer drop paths.
- **Resizable source|program divider**: `sourceMonitorSplit` state + `.monitor-split-resizer`
  (`startSourceProgramResize` in EditorPage.tsx). **Do not** widen the
  `.editor-layout.is-left-collapsed .pane-resizer-vertical:not(.pane-resizer-right) { display:none }`
  selector back to a descendant combinator — it must stay `.editor-main > .pane-resizer-vertical...`
  (direct child only), otherwise closing the Media panel also hides this nested resizer and the CSS
  grid auto-placement squeezes the program monitor into the 8px resizer column (real regression hit
  and fixed this session).
- **Timeline header rework**: the old vertical `.timeline-side-tools` rail moved INTO the sticky
  `.timeline-timebar` row (horizontal now); `--timeline-tools-width` is 0px (kept as a var for the
  ruler/playhead left-anchor, just zeroed). Ruler is now `position: sticky; top: 38px` under the also-
  sticky toolbar (z-index 9 > playhead's 8) so neither the ruler nor the add-layer tools scroll off,
  and the playhead cap tucks under the header instead of painting over it. Timeline Fit button
  (`fitZoom` in TimelineStrip.tsx) now fits the ACTUAL last-clip-end, not `interactionDurationSeconds`
  (which counted every clip's untrimmed source length / trim headroom — a 3s clip cut from a 9-minute
  asset made Fit zoom for 9 minutes and visibly never squeeze).
- **Inspector ↔ Color tab parity**: `.editor-section` (inspector) was getting DOUBLE gap between
  sections — both the parent `.inspector-panel`'s `gap: var(--section-gap)` AND a redundant
  `.editor-section + .editor-section { margin-top: var(--section-gap) }` sibling rule stacked, vs. the
  Color tab's `.lumetri-panel` which only had the parent gap. Removed the redundant margin-top rule.
  Also stripped `.editor-section`'s border (color panel's `.lumetri-section` was already borderless —
  the mismatch read as two different design languages) and made both panels' "active section" bg
  neutral, not accent-tinted (user explicitly rejected accent-tinted section backgrounds as
  distracting — keep it that way, the header dot + reset icon are the "has edits" signal).
- **Graph Editor property-tab overflow fix**: `.graph-property-tabs` was `display:grid; grid-template-
  columns: repeat(5, 1fr)` — a clip with several keyframeable effects (each effect contributes one pill
  per param, e.g. "Basic Correction · Exposure") wrapped into many rows, ballooning the section's
  height. Now `display:flex; flex-wrap:nowrap; overflow-x:auto` — one scrollable row regardless of
  count (verified with 21 tabs → 1 row).
- Misc: viewer zoom slider removed (dropdown + Fit only — zoom % is intentionally actual-size
  semantics, not a bug); canvas fit margin 56→24px (was leaving vacant space around the frame); handle
  size 9→13px (`--handle-size`, too small to reliably grab); AI dock bottom clearance 10→34px + closed
  a double-counted `padding-right` gap on `.editor-page.is-ai-open` (372→364, `.editor-layout`'s own
  8px right padding was being added on top).
- **Not done / next**: full sweep for any remaining hardcoded accent-adjacent literals outside
  `global.css` (checked TSX — only `TrackBoxEditor.tsx`'s canvas stroke was hardcoded, now reads
  `--nle-accent` via `getComputedStyle`); program-monitor caption/controls still don't visually mirror
  the source monitor's compact caption-bar treatment (partially flattened only); no additional visual
  QA pass done at 1280×720 this session (only 1536×864).

### 2026-07-05 (cont.) — Claude (Fable): Nesting Block 1 REVIEWED+APPROVED; full-res settle frame on pause; span cache survives full-quality switch

- **Nesting Block 1 review (the promised Fable pass)**: walked all 8 checklist items in
  `NESTING_BLOCK1_PLAN.md` against the actual code (not the handoff notes), re-ran `pnpm -r typecheck`
  (clean) + `editor:test` (all pass). Verdict: APPROVED — all four `// NEST-REVIEW:` deviations upheld,
  the two beyond-plan fixes (`buildSourceUrlMap`/`collectAudioLayers` on the nest-expanded comp) were real
  gaps correctly caught. Checklist annotated in place with per-item evidence. Open follow-ups unchanged
  (nested pixel fixture, Task 7 transitions, audio volume folding, manifest work-area+shell gap).
- **Full-res SETTLE FRAME on pause (user report: paused frame stayed proxy-soft at ½/¼/Auto)**:
  `WebglMediaLayer` (video) gains `fullResSrc` — ~300ms after the transport parks, the ORIGINAL bytes are
  leased from the element pool (`acquireVideo`), seeked once to the exact source time, and preferred as
  the draw source while paused (settle → WC frame → element); paused grade/mask/opacity repaints hit
  full-res pixels, and the scene path recomposites via the existing `onGradedFrame` → `sceneRedrawRef`
  hook. Any transport movement (play/scrub/src change) drops it synchronously — the settle effect is
  declared BEFORE the paused-seek redraw effect so a scrub never repaints a stale full-res frame.
  DELIBERATE deviation from the deferred plan's "preview-pool provider" wording: the WC pool returns null
  while `wcDecode` is off (its current default), so the element pool is the source — exact native seek,
  no catch-up machinery, works today. `VideoPreview` passes `fullResSrc={asset?.fileUrl ?? asset?.previewUrl}`
  (freeze-frame preference order — never `proxyUrl`); at fixed full quality it equals `src` and no-ops.
  Telemetry: `window.__rfSettleSwaps`.
- **Span/render cache no longer wiped by switching to fixed full quality (user report)**: switching to
  "1" (Auto off) reconciled the preview cache at renderScale 1, and `reconcile` deletes every SOFTER span
  → all ½/¼ proxies gone + full-res regeneration queued that nobody plays. Now `fullQualityPlayback`
  makes the span system DORMANT: folded into `proxyGenActive` (kills generation AND playback
  substitution — full quality plays raw/live) and `updateProxyCacheRuler` skips the reconcile entirely
  (store untouched, ruler keeps painting what's cached). Returning to ½/¼ finds the old spans immediately
  (base signature excludes render scale since 2026-07-04); edits made while at full quality invalidate
  only the spans they overlap via per-span content signatures on that next reconcile.
- Gates: `pnpm --filter web typecheck` clean; `editor:test` all pass.

### 2026-07-05 (cont.) — Claude (Sonnet executor): Nesting Block 1 — compound clips RENDER (preview + local export + Remotion)

Implemented `NESTING_BLOCK1_PLAN.md` (exact spec, Fable-authored). `expandNestedCompositions` was complete
but unconsumed before this; now a `nestedCompositionId` clip (imported prproj nest today, native compounds
later) composites identically across all three renderers via a new `SceneGroupDraw` kind.

- **`packages/shared/src/color/scene-compositor.ts`**: `SceneGroupDraw` (kind:"group") — renders `children`
  into a depth-indexed RTT sized to the nest, transparent clear, then composites it through the ordinary
  layer-draw path using `shell` (the compound clip's own transform/mask/blur/glow/blend). Depth-indexed RTT
  pool, not keyed by `debugGroupId` — see the NEST-REVIEW comment there.
- **`packages/shared/src/scene/build-scene-draws.ts`**: owner-resolution + group folding (`buildGroupDraw`,
  `orderedGroupChildRefs`, bottom-up `groupFirstIndex` for z-slot placement); `buildLayerDraw`/
  `buildRegionPasses`/`buildLayerDrawWithPasses` gained an optional `dims` override (nest size + matte cache)
  defaulting to today's behavior — every existing call site is unchanged. New `buildShellPresentation` shared
  between ordinary media layers and compound-clip shells. New caller-owned `nestMatteCaches` pool.
- **Web preview** (`VideoPreview.tsx`/`ScenePreviewCanvas.tsx`): nest-expand before region-expand at the
  `expandedTracks` seam; `nestedGroups` threaded into `ScenePreviewCanvas`. `__nest_` interaction hygiene
  needed zero new code — `realLayerIds` is already built from the un-expanded composition.
- **Local export** (`export-core.ts`/`local-export.ts`/`EditorPage.tsx`): `ExportCoreInput.compositions` +
  same expansion order; also fixed two real gaps beyond the plan's literal text — `buildSourceUrlMap` and
  `collectAudioLayers` were reading the un-expanded composition, silently dropping assets/audio used only
  inside a nested sequence.
- **Remotion/manifest** (`packages/render-templates/src/index.ts` — NOT `timeline.ts`, the plan named the
  wrong file — /`SceneStage.tsx`): `RenderManifest.nestedGroups` (Map serialized to a Record); `SceneStage`
  already force-casts `RenderManifestLayer[]` as `TimelineLayer[]` for the whole shared pipeline, so nested
  ids flow through with zero Remotion-specific special-casing.
- **`editor:test`**: 10 new checks exercising `buildSceneDraws`'s nesting path directly. **Caught a real
  bug**: the main draw loop's "skip nested layers" check ran BEFORE the "emit the group here" check, so a
  group's z-slot (which IS the index of one of its own members) got eaten by the skip — every compound clip
  silently vanished from the frame. Fixed by reordering; all 148 checks pass.
- **Gates**: `pnpm -r typecheck` clean (5 packages). `scene:compare` run partially (8/22 existing fixtures
  clean at tuned thresholds, 1 hit an infra `ERR_NO_BUFFER_SPACE` flake, rest not attempted) as a regression
  check — no new nested pixel fixture authored. `render:compare:pixels`/`render:manifest` not run. Task 7
  (transitions at compound↔clip junctions) not attempted (explicitly stretch/deferrable in the plan). Full
  reasoning + 4 `// NEST-REVIEW:` comments (depth-indexed RTT pool, audio volume folding deferred, nested
  child-to-child transitions dropped not mixed, work-area+nesting shell correction gap) documented in
  `NESTING_BLOCK1_PLAN.md`'s handoff section — start there before touching this area again.
- Claim released. Next: Fable review pass (re-run gates, walk the plan's review checklist), then either the
  deferred E2E fixtures or Block 2 (editor UX: Nest command, open/breadcrumb, un-nest).

### 2026-07-05 — Claude: auto-keyframe mode, unified modern viewer handles, content-transform keyframes

- **Auto-keyframe ("stopwatch") mode**: new toolbar toggle in the viewer control cluster (`autoKeyframe`
  state in `EditorPage`, `.viewer-autokey-toggle` in `global.css`). Default OFF. Threaded to registry
  panels via `InspectorPanelProps.autoKeyframe` (+ `InspectorHost`) and to the inline EditorPage effect
  controls via the new `AutoKeyframeContext` (`editor/inspector/autoKeyframeContext.ts`).
- **Write semantics + bug fix** (`keyframeUtils.ts`): new `applyTransformValueAtTime` /
  `applyEffectParamValueAtTime` / `applyContentValueAtTime` centralize where an edit lands —
  kf-at-playhead → update; already-animated → INSERT at playhead (**fixes the old bug** where editing an
  animated property off a keyframe silently wrote to the ignored base); autoKeyframe → first kf; else base.
  Panels (`TransformPanel`, `ContentPanel`, `EffectParamControl`) and the viewer scale/rotate gesture
  handlers (`handlePreviewScaleLayer/RotateLayer`) route through these. Gesture plumbing unchanged
  (only the commit target branched — honors the timeline-perf DO-NOT-TOUCH directive).
- **Content pan/zoom/crop is now keyframeable**: `getCompositionContentTransform` (shared
  `composition-style.ts`) is time-aware — evaluates `content.scale|offsetX|offsetY|crop.{t,r,b,l}`
  layer-scope keyframes via `evaluateAnimatedValue`. One call-site change in shared `buildSceneDraws`
  (`{ currentTimeSeconds: t }`) covers preview GPU + browser export + Remotion (all consume it). Identity
  fallback is byte-identical when no content keyframes exist. `ContentPanel` gained keyframe controls.
- **Unified modern handles**: `:root` handle tokens (`--handle-size/-fill/-border-color/…`) drive ONE look
  everywhere. Viewer selection box now has 8 square handles (4 corners + 4 edge midpoints, radial
  scale-from-center) + round rotate handle (`PreviewSelectionOverlay` in `VideoPreview.tsx`). Motion-path,
  spatial, tracker handles restyled to the shared white-core/accent-border tokens; mask points already
  matched. Constant on-screen size preserved via `--handle-inverse-scale` (DOM) / comp-space SVG.
- Gates: full `pnpm -r typecheck` + web build clean; `render:compare:pixels` 23/23 @ 0.000% (incl.
  `content-transform` fixture); animation + editor foundation tests pass.

### 2026-07-05 — Claude: proxy frozen-tail guard + source-fps recipe (v2), selection render diet, export encoder stall recovery, viewer uses original

- **Proxy corruption fix (the "video plays then freezes like a photo" soak report)**: `sourceProxyEngine.ts`
  kept encoding the last good canvas after the decoder failed mid-file — the freeze was BAKED INTO the
  proxy MP4. Now a >0.5s run of null frames ABORTS the build (no proxy beats a corrupt proxy); tail nulls
  (≤0.25s before declared duration) end the encode cleanly; saved duration = actual encoded frames.
  `SOURCE_PROXY_VERSION` bumped 1→2 — every existing proxy is invalidated and rebuilt on next open.
- **Proxy judder fix**: transcode now samples at the SOURCE's fps (new optional `FrameProvider.nominalFps`,
  computed in `webcodecs-decoder.ts` from the sample table's median timestamp delta, capped at 30) instead
  of a hardcoded 30fps grid that duplicated every 4th frame of 24fps content.
- **AssetViewerModal** plays the ORIGINAL (`fileUrl ?? previewUrl`), never `proxyUrl` — the viewer is where
  source quality is judged. Bin-card hover-scrub intentionally keeps the proxy (cheap dense-GOP scrubbing).
- **Export encoder stall recovery** (`video-encoder.ts`): "Export stalled: encodeFrame N/M exceeded 30000ms"
  now reset+reconfigures the wedged VideoEncoder (≤2×/export, forced IDR on resume, ~0.3s output stutter)
  instead of killing a long export. Video config extracted to `this.videoConfig` for the reconfigure.
- **Selection render diet** (`EditorPage.tsx` `commitLayerSelection` + `TimelineStrip.tsx`
  `applyInstantSelectionHighlight`): interactive selection commits via `startTransition` with an
  identity bail; the instant highlight is an imperative `is-selected` class write at pointerdown.
  Do NOT make selection setState synchronous again.
- **Encoder recovery made GAPLESS** (follow-up): `addVideoFrame` now throws `EncoderStallRecoveredError`
  carrying the muxed-chunk count; `export-core.ts` rewinds `i` and re-renders the dropped frames
  (deterministic compositor) — no held frame / motion jump in the output.
- **Full-quality playback toggle**: transport "1" (quality, Auto off) now also BYPASSES ingest proxies —
  playing and paused frames use original media (`setIngestProxyPlaybackEnabled` in VideoPreview,
  wired from EditorPage's quality control). ½/¼/Auto keep proxy playback.
- **Build-queue suspend during full-quality playback**: `setSourceProxyBuildSuspended` (engine) parks the
  proxy transcode — between builds AND mid-frame-loop — while `isPlaying && fullQualityPlayback` ("1",
  Auto off); resumes on pause/quality switch. Proxy-quality playback keeps building. Cloud export
  explicitly deprioritized by the user until local export is fully stable.
- **api `assets.routes.ts`**: multer `fileSize` 250MB → 1GiB (memoryStorage — that's also the RAM bound).
- Gates: web+api typecheck clean, all editor foundation checks pass.

### 2026-07-04 (night, cont.) — Claude: export dialog color warning (closes last deferred color-system item)

Small follow-up after the work claim above was released: the "Export on this device" dialog
(`EditorPage.tsx`, `.export-settings` block) now computes `sourceColorWarnings` across every
video/image asset used in the composition and shows a non-blocking amber banner
(`.export-color-warning` in `global.css`) when any source is HDR/wide-gamut/log — the original
Phase 2 plan item ("export dialog warning when exact color can't be guaranteed"), which had been
deferred until Phase 3's real per-source detection made it a genuine signal instead of a guess.
`pnpm -r typecheck` clean. No open items remain in `~/.claude/plans/professional-color-system-logical-patterson.md`.

### 2026-07-04 (night) — Claude: real source color detection + Prisma persistence (Color Phase 3, DONE)

- **Detection** — NEW `apps/web/src/export/source-color.ts` (`detectSourceColorFromFile`): parses the MP4/MOV
  `colr` box via mp4box (added `ColrBox`/`colr` to `mp4box.d.ts`), maps ISO 23091-2 code points to
  `SourceColorMetadata`. Only `nclx`/`nclc` are mapped (numeric codes); ICC-profile (`prof`/`rICC`) `colr`
  variants correctly return `null` → caller assumes Rec.709. Runs at ingest (`EditorPage.tsx readMediaMetadata`,
  parallel with the existing audio-detect probe) — off the render/preview loop, no UI lag.
- **Persistence** — `SourceAsset.color?: SourceColorMetadata` (shared types) → Prisma `SourceAsset.colorJson`
  (migration `20260704170156_add_source_asset_color_metadata`, nullable additive column) → `assets.routes.ts`
  (`createAssetSchema.color` + `asJson(normalizeSourceColorMetadata(...))`) → `asset-serializer.ts`. Threaded
  through `api.ts CreateAssetInput.color` (both the multipart and JSON create paths, plus the local-first
  fallback asset).
- **UI** — Color tab shows a `.source-color-notice` for the selected video/image clip via `sourceColorWarnings`
  (HDR/wide-gamut/log → amber "treated as Rec.709 SDR"; unknown → info "Assumed Rec.709"; clean Rec.709 SDR →
  no notice).
- **Cache** — deliberately did NOT hash source color into `spanContentSignature`: detected color only drives
  warnings/export tags in v1, not different render math, so it wouldn't be a real invalidation trigger yet.
  Revisit if/when a future milestone transforms pixels based on detected primaries.
- **Verified live** (not just typechecked): ran the detector against a real ffmpeg-encoded `nclx` BT.709
  limited-range MP4 → correctly detected `{primaries:"bt709", transfer:"bt709", matrix:"bt709", fullRange:false,
  confidence:"high"}`; against a Chrome/Remotion-produced MP4 with an ICC-profile `colr` → correctly returned
  `null` (no false positive). `pnpm db:migrate` applied cleanly to the running Postgres container. `pnpm -r
  typecheck` clean across all 5 packages.
- **Status:** Phases 1, 2, and 3 of the Professional Color System plan
  (`~/.claude/plans/professional-color-system-logical-patterson.md`) are now all complete. Work claim released
  (see below) at user request.

### 2026-07-04 (night) — Claude: export color tagging + manifest color handoff (Color Phase 2)

- **Local export tagging** — `apps/web/src/export/video-encoder.ts`: `MediaEncoder` now writes the container
  color box (MP4 `colr` / WebM `Colour`) by merging a Rec.709 SDR descriptor (`REC709_SDR_LIMITED`) into the
  encoded-chunk `meta.decoderConfig.colorSpace` the muxers read. **Encoder-reported fields win** (they match the
  actual RGB→YUV matrix/range — overriding would reintroduce the BT.601-vs-BT.709 mismatch the Remotion path
  disables parallel-encoding to avoid); only unspecified fields are filled. `getAppliedColorSpace()` surfaces the
  result; `export-core.ts` derives range from `composition.settings.color` and logs `[color] tagged …` /
  `export-metadata-fallback` via `onProgress` (Phase 2c diagnostics; a dialog banner is deferred to Phase 3 —
  local export always uses the exact WebGL scene compositor, so source-HDR is the only real "not exact" signal).
- **Manifest handoff** — `packages/render-templates/src/index.ts`: `RenderManifest.output.color?`
  (`ProjectColorSettings`, always set by `buildRenderManifest` from `composition.settings.color`) +
  `RenderManifestAsset.color?` (`SourceColorMetadata`, populated in Phase 3). `apps/worker/src/remotion-renderer.ts`
  `colorSpace` is now `manifestOutputColorSpace(manifest)` (v1 → always "bt709", but manifest-driven so future
  output spaces are a data change). `SourceAsset.color?` added to shared types (Phase-3 persistence home).
- **Verified:** `pnpm -r typecheck` clean; rendered a synthetic text/shape manifest through the real Remotion
  renderer → `ffprobe`: `color_space=bt709`, `color_range=tv` (limited). (Transfer/primaries atoms are a known
  Remotion cloud-path limitation, unchanged by this refactor.) Local WebCodecs `colr` tag is by-construction
  (muxer writes from the `decoderConfig.colorSpace` now set) — browser-only, not headlessly probable.

### 2026-07-04 (night) — Claude: managed Rec.709-linear color pipeline + trustworthy scopes (Color Phase 1)

Handed off from Codex (quota). First milestone of the Professional Color System plan
(`~/.claude/plans/professional-color-system-logical-patterson.md`). **Rec.709 SDR, HDR/log/P3 deferred.**

- **Managed linear correction** — NEW `packages/shared/src/color/managed.ts` (`applyControlsLinear`): Basic
  Correction now grades in **Rec.709 linear light, unclamped** (real ±2-stop exposure, contrast pivoted on
  display-mid linear, luma-weighted shadow/highlight/white/black masks, linear WB gain, luma-preserving
  saturation/vibrance). Wired into `cpu.ts applyPipelineToRgb` as the single chokepoint → the baked 3D LUT
  (`bakePipelineToLut3d`) inherits it, so **WebGL preview + Remotion export are identical with ZERO shader
  changes** (render:compare:pixels 23/23 @ **0.000%**). Authored curves/wheels/HSL/.cube LUTs stay
  display-referred (they're authored on 0..1 display graphs — running them through linear would distort them).
  `ColorStage.controls` (Codex's scaffold) is now populated (`pipeline.ts controlsToStage`) + consumed;
  `matrix`/`curve` remain the SVG/no-GL approximation. `compileColorPipeline` now takes `ProjectColorSettings`
  (default managed); `composition.settings.color` + `CompositionStyleOptions.colorSettings` thread it.
- **SVG degradation** — `svg.ts svgFallbackWarnings()` flags managed/HSL/LUT grades on the no-GL path;
  VideoPreview shows a `.preview-color-degraded` badge when NO WebGL grade path is active.
- **Trustworthy scopes** — `SceneCompositor.readCompositeThumbnail()` (NEW; linear-blit downsample of the
  RETAINED `accumA` composite — no re-render, no `preserveDrawingBuffer` dependency), exposed via
  `SceneViewerCaptureHandle.readCompositeThumbnail` → EditorPage `sampleScopeFrame` → `ColorScopes`.
  Replaces the fragile `querySelector("canvas")` (kept only as a flagged "approx" DOM fallback). Vectorscope
  switched **BT.601 → Rec.709** Cb/Cr; added legal-range (16/235) guides, clip/crush markers, "Rec.709 SDR"
  label, and paused-vs-playing sample resolution (320×180 / 160×90).
- **Cache** — `renderCache.ts`: `PREVIEW_PROXY_RENDER_VERSION` 5→6; `baseCompositionSignature` now hashes
  `settings.color` (runtime color-settings change → proxy regen; code changes already flip the fingerprint).

Gates (real Chrome/GPU, this box): `color:test` 60/60, `animation:test`, `render:compare`, `scene:compare`
22/22, `render:compare:pixels` **23/23 @ 0.000%**, `pnpm -r typecheck` clean. **Deferred (Phase 2/3):** export
`VideoColorSpace`/muxer BT.709 tagging + manifest handoff; real source color detection (mp4box `colr` /
`VideoFrame.colorSpace`) + Prisma `SourceAsset` persistence.

**Watch-outs for Codex:**
- The managed grade is applied ONLY when `ColorStage.controls` is set AND `colorSettings.workingSpace ===
  "rec709-linear"` (the default). Don't strip `controls` off correction stages — it's the exact path; the
  `matrix`/`curve` on the same stage are just the SVG approximation and are SKIPPED when controls run.
- `readCompositeThumbnail` reads `accumA` WITHOUT re-compositing — call it only after a `renderFrame`; it
  returns the last retained frame (correct for the scope cadence). Don't route export through it.

### 2026-07-04 (evening) — Claude: per-SOURCE ingest proxies (Premiere model) + zero-render trim + hot-spot attribution

**Source proxies** (the structural cure for the 108MB sparse-GOP seek/starvation family — we only had a
timeline render cache, never Premiere's other half):

- `apps/web/src/editor/performance/sourceProxyStore.ts` — OPFS `lumio-source-proxies/` (`<assetId>.mp4`
  + `index.json`), validated by source byte-size fingerprint + `SOURCE_PROXY_VERSION`; no fallback store
  (no OPFS → feature off, originals play like before).
- `apps/web/src/editor/performance/sourceProxyEngine.ts` — FIFO background transcoder: H.264 ≤854px long
  edge, 30fps, **keyframe every 1s**, AAC audio included when present (proxy is a drop-in for every
  preview consumer incl. viewer modal + audio layers). Decode is `preferSoftware` (never steals the ~3 hw
  decoder sessions from playback), hw encode, breather sleeps. Skips: <12MB sources, >15min, already
  proxy-sized, no local bytes. Telemetry `window.__rfSourceProxy`.
- EditorPage: ensure-effect over `assets` → patches `asset.proxyUrl` (session object URL), DEFERRED while
  playing so a src swap never glitches active playback; stale persisted `blob:` proxyUrls stripped at
  load. `resolvePlaybackUrl` already preferred `proxyUrl` — video layers, WC decode pool, hover-scrub and
  audio layers all pick it up with no further wiring. Freeze-frame flipped to prefer ORIGINAL
  (`fileUrl ?? previewUrl ?? proxyUrl`) so stills don't bake at 480p. Exports untouched (original bytes).
- `export/video-encoder.ts`: `keyFrameIntervalSeconds` option (default 2 = export behavior unchanged).

**Trim lag** (user: "so laggy trim"; log showed ~130ms TimelineStrip render PER FRAME → ~7fps drags):
trim preview is now a fully IMPERATIVE DOM write (clip `left`/`width` + snap guide via refs, one rAF),
zero React renders mid-gesture — same doctrine as the playhead. `finishResize` paints the final ref state
synchronously before commit (vdom no-op safety); `cancelResize` restores React-written inline styles.
RULE: gesture previews must not pass through React state; React re-enters at commit only.

**Hot-spot attribution** (user's 2949ms playhead click → ONE unattributed 2077ms long task):
`markHotSpot(label, t0)` in perfDiagnostics → `window.__rfHotSpots` (>40ms only) + probes around the rAF
suspects long-task attribution can't see into: `webgl-renderer-init` (context + shader compile + LUT
re-bake in ensureRenderer), `lut-bake` (pipeline effect), `webgl-draw` (texImage2D of 4K frames),
`source-proxy-audio-decode`. Next soak names the 2s task instead of guessing.

**Follow-up 7 (same evening): NO-OP-CLICK GUARD — clip clicks no longer commit phantom EDITS.** User:
"selecting clips feels very heavy, responds very late". Root cause (pre-existing, unmasked once seeks got
fast): a plain click runs the full drag lifecycle, and `finishDrag` unconditionally called `onMoveLayer`
with IDENTICAL values → `handleMoveLayer` (no no-op guard) built a brand-new composition object →
`updateComposition` → second full-tree render + invalidation of every [composition]-keyed memo
(waveforms/snap targets/preview derivations/span-cache signature) + an undo snapshot of NOTHING + an
autosave — per click (the paired ~430ms long tasks in the log tail). Fixed in TimelineStrip:
`dragChangedAnything` (per-layer start/track vs gesture-start base in DragState.baseTrackByLayerId)
guards BOTH commit paths (element finishDrag + stuck-drag window net); same guard on `finishResize`
(base start/duration in ResizeState). A motionless release now commits NOTHING — selection alone
(pointerdown) remains. Also fixes undo-history pollution from clicks. Gates: typecheck + 148 green.

**Follow-up 6 (same evening): SCRUB RENDER STORM — React clock subscribers coalesced to frame rate.**
Scrubbing pushes the clock once per pointermove (125–1000Hz); `usePlaybackClock` subscribers
(VideoPreview ~50ms/render in dev) were notified SYNCHRONOUSLY per push → renders arrived faster than
they completed (276 VideoPreview renders in one scrub pass, 2026-07-04 soak) → gluey timeline while
scrubbing. `playback-clock.ts` now keeps TWO subscriber sets: imperative (`subscribePlaybackClock` — the
playhead DOM write, still synchronous, zero latency) and React (`usePlaybackClock` — coalesced to ONE
notification per animation frame via rAF; the snapshot read is always live, so a deferred notify renders
the LATEST time). Also diagnosed this cycle: the `/api/assets` 500 in the user's log was TRANSIENT
(endpoint re-verified 200 with real data via demo login) — but while failing, `assets=[]` made every clip
fall back to the project's single sourceAsset → decode contention + thumbnail/waveform churn = timeline
misery unrelated to render code. Clip-CLICK cost (~600ms dev: selection → full tree) is PRE-EXISTING and
unchanged by the diet — next structural target (selection render diet). Boot logs with
`reappearLayoutEffects`/`doubleInvokeEffectsInDEV` at 800–1000ms are StrictMode double-mount, dev-only.

**Follow-up 5 (same evening): SOURCE-PROXY ENGINE WAS BLOCKING THE MAIN THREAD — fixed.** User: "it feels
slow again" with `__rfRenderCost` maxMs ~1.3–1.7s across ALL FOUR components at once (a shared block, not
slow renders). Root cause in `sourceProxyEngine.ts`: (a) `feedAudio` was a SYNCHRONOUS unbounded loop
(~1600 chunks for a 2-min clip → ~1s frozen main thread per proxy — matched the 996/1015/1245ms "unknown"
long tasks 1:1 with the 3 in-flight builds); (b) the video frame loop only breathed every 30 frames
(30×~13ms ≈ the ~400ms long tasks seen mid-interaction). No `[source-proxy] built` line appeared because
the builds were still IN FLIGHT (multi-minute), so the work hammered the thread with no completion log.
Fixes: `feedAudio` is async + `yieldToMain()` (prefers `scheduler.yield`, else MessageChannel) every 24
chunks; the frame loop yields after EVERY frame; and the engine starts + gates each build behind
`requestIdleCallback` so a background transcode never lands on an active editing burst. The render diet
(parts 3+4) was correct and stands — it just wasn't the cause of THIS symptom. Gates: typecheck clean,
editor:test 148 green.

**Follow-up 4 (same evening): COLD-COMMIT RENDER DIET part 2 — EditorPage `currentTime` useState DELETED.**
Root fix, not another memo: the playhead lived in EditorPage React state (`currentTime`), so every seek's
120ms trailing commit re-rendered the whole ~9000-line tree (the EditorPage ~250ms + TimelineStrip ~150ms
pair that survived part 1). Now the playhead lives ONLY in `currentTimeRef` + the clock store.
- `playback-clock.ts`: added a COLD mirror — `useColdPlaybackTime()` (throttled ≤120ms subscription),
  `flushColdPlaybackNotify()` (immediate, for discrete pause/stop/clamp), `setColdPlaybackSuspended()`
  (freezes cold notifies during playback so inspector/scopes/mixer re-renders never fight playback —
  mirrors the old "loop doesn't mirror currentTime to state while playing" behavior).
- EditorPage: `[currentTime,setCurrentTime]` GONE; `currentTimeRef = useRef(0)`; cold-commit timer +
  `COLD_TIME_COMMIT_MS` GONE. `setEditorCurrentTime` now clamps+quantizes → ref + `setPlaybackClock`
  (which schedules the cold notify). Clamp effect keyed on `[composition]` reading the ref. Play/pause
  suspends/un-suspends+flushes the cold clock; mount resets the (module-global) suspend flag.
- Cold consumers (ColorScopes, LumetriPanel, LayerInspector, AudioMixerPanel) render through a
  `<ColdTime>{(t)=>…}</ColdTime>` render-prop wrapper subscribing to the cold clock — only THAT subtree
  re-renders on a playhead move, never EditorPage. Category-B (VideoPreview, PlayheadTimeReadout,
  TimelineStrip) get a `currentTimeRef.current` snapshot; TimelineStrip snap-to-playhead reads
  `getPlaybackClock()` live. RULE: never reintroduce EditorPage `currentTime` state — playhead is
  ref+clock only; anything needing it cold subscribes via `<ColdTime>`.
Gates: web typecheck clean, editor:test 148 green.
SOAK 1 result: EditorPage dropped to 8 renders on paused clicks (was 35+) — structural win confirmed. BUT
a regression surfaced + FIXED: `scheduleColdNotify` was a THROTTLE (fired every 120ms mid-scrub) where the
old cold commit was a DEBOUNCE (fired once, 120ms after settle) → the heavy inspector/scopes/mixer panels
re-rendered ~8×/sec during scrubbing = "it feels slow again". Now debounced (reset timer each push),
matching the old trailing-commit cadence. NOTE for whoever reads next: the residual 1–1.2s "unknown" long
tasks that land right after a ruler click are NOT this diet — they're paused-seek FRAME DECODE on heavy
sparse-GOP clips (pre-existing; source proxies fix it for proxied clips; `mode:'none'` frozen layers = still
decoding originals). That's P4 decode-authority / proxy-coverage territory, not the render path.

**Follow-up 3 (same evening): COLD-COMMIT RENDER DIET — VideoPreview memoized.** The recurring per-seek
render trio (EditorPage ~250ms + VideoPreview ~220ms + TimelineStrip ~150ms) is the 120ms deferred cold
`currentTime` commit cascading through the tree. Root cause for VideoPreview: it's CLOCK-DRIVEN
(`usePlaybackClock`, fed synchronously on every seek), so its `currentTime` prop is redundant — yet it
wasn't memoized, so every cold commit re-rendered it + every PreviewLayer for a time value the clock
already delivered. Fix: `VideoPreview = memo(impl, comparator)` where the comparator ignores
`currentTime` when `clockDriven` (fixtures that pass a fixed prop time still compare it). All 12 of its
EditorPage function props are now `useStableHandler`-wrapped (`stablePreview*`, defined just before the
`!project` early return) so the memo actually holds; mask-commit closures read the LIVE `currentTimeRef`
instead of the cold state (strict improvement). The clock subscription still re-renders VideoPreview live
on scrub/playback — only the redundant cold cascade is removed. NEXT (deferred, bigger/riskier): same
treatment for TimelineStrip (150ms, but ~25 inline-closure props + a genuine snap-to-playhead currentTime
use), OR the deeper fix — drop EditorPage's `currentTime` useState entirely and have the few cold
consumers (inspector/scopes/lumetri/audiomixer) subscribe to a throttled clock store, so a playhead move
never re-renders EditorPage at all.

**Follow-up 2 (same evening): wcDecode DEFAULT FLIPPED ON** (`preview-frame-pool.ts` —
`?wcDecode=0` / `lumio.wcDecode="0"` / `VITE_WC_DECODE=0` are now the kill switches). Evidence: days of
ON-flag soaks, final soak fully clean (`__rfSourceProxy {built:3, failed:0}`, `__rfHotSpots` worst 50ms,
`__rfWcHeals {noSource:7, pausedStall:1}` all self-healed, zero duplicate-id events), every WC failure
mode has a bounded element-fallback path, and source proxies made the decode side cheap. NEXT UP: the
cold-commit render diet — each seek's deferred commit still costs ~250ms EditorPage + ~220ms VideoPreview
+ ~150ms TimelineStrip in dev; that's the last recurring perf signal in the soak logs.

**Follow-up (same evening), from the next soak** (user: trimming confirmed fast; logs showed every real
asset skipping `no local bytes`):

- Source-proxy engine now FETCHES server-hosted originals (API uploads / stock — http fileUrl) when the
  bytes aren't in the on-device store; local-import path unchanged. Object URL revoked after transcode.
- Clip-MOVE drag converted to the same imperative doctrine as trim: `flushDragPreview` writes each moved
  clip's left% + translateY via a lazily-built element cache; commit paths (element finish + stuck-drag
  window net) paint the final ref state then restore React-written transforms; cancel paths (incl.
  Escape/pointercancel) restore left+transform. Zero React renders mid-move-drag.
- Negative attribution result recorded: with hot-spot probes live and perfLog on, NO `webgl-renderer-init`
  / `lut-bake` / `webgl-draw` hot spot fired during a full soak — the remaining ~250–400ms "unknown" long
  tasks around clicks are the deferred cold-commit full-tree render (dev/StrictMode-inflated), not GPU work.

Gates: web typecheck clean, editor:test 148 checks green.

### 2026-07-04 (day) — Claude: seek path decoupled from React state (click/scrub jank) + morning soak fixes

User's `__rfClickLatency` capture (avg 429ms, worst 788ms) named the structure: one timeline click = TWO
full-tree renders (sync flush + follow-up), with AssetBin ~240ms of pure waste in each. Shipped:

- **Deferred cold playhead mirror** (`EditorPage.setEditorCurrentTime`): seeks now write ref + clock store
  synchronously (hot leaves) and coalesce the React `currentTime` state commit behind a 120ms trailing
  timer (`COLD_TIME_COMMIT_MS`) — ONE full-tree render per seek burst, off the click's critical path,
  instead of one per pointermove. All state writes are ref-first now; the old state→ref sync effect was
  removed (it would regress a fresh seek). Handlers that read playhead time use `currentTimeRef`
  (create-layer, freeze-frame, drop-at-playhead, look layer, clipsUnderPlayhead, AI context).
- **Hot leaves ride the clock store while paused too**: `VideoPreview` grew a `clockDriven` prop
  (EditorPage passes it; PreviewFixturePage/SmartFollowTextToolPanel keep prop-driven time);
  `TimelineStrip`'s paused/scrub playhead + seek-into-view is now an IMPERATIVE
  `subscribePlaybackClock` DOM write (new export in playback-clock.ts) — zero React renders per scrub
  move; timebar + transport timecodes are tiny always-live clock leaves. Clock store is reset on editor
  mount (module-global, survives project switches).
- **AssetBin memoized**: `memo(AssetBinImpl)` + identity-stable function props via new
  `apps/web/src/lib/useStableHandler.ts` (useEvent pattern — stable identity, latest closure). Rule: any
  new AssetBin function prop at the main call site must be wrapped in `useStableHandler`.
- **Main-bin click-assign cut** (user: cost with no gain): single click = select only; assignment stays
  explicit (drag, hover "+", replace mode, inspector picker via `clickAssigns`). A stray click was a
  composition edit → proxy re-generation.
- **Quality switches no longer wipe the proxy cache** (user: "whats the point in regenerating from
  scratch"): render scale is OUT of `baseCompositionSignature` and lives only as a comparable
  per-span field. A span at LEAST as sharp as the preview serves it (smallest sufficient scale
  wins), so 1 → ½ → ¼ reuses everything and only an UPGRADE queues work; reconcile adopts
  range-equal sharper spans instead of queueing duplicates; `markSpanReady` stamps the scale the
  media was ACTUALLY produced at (clamped, never sharper than claimed) and can seal a
  sharper PERSISTED record into a softer-planned span (rehydration across quality switches —
  `PersistedProxySpanRecord` gained renderScale/start/end; old records fall back to exact-id).
  editor:test 144 (6 new: downgrade-no-regen / serve-sharper / upgrade-regenerates / record-adoption).
- **WC divergence bail-out**: the next soak (playback smooth, proxies masking) still showed a WC
  provider 24s behind with ZERO frame advancement for 23s — starved/wedged decode never converges.
  New policy in WebglMediaLayer: streak >10s with lag still >3s → fall back to the stage-1 `<video>`
  element path (plays realtime trivially); converging catch-ups (lag shrinking) never trip it.
  `__rfLiveFreeze` now reports `phase: live|hold|pan` instead of `holding` (post-fix, a streak flag
  no longer means frozen). Soak-verified: the playing episode's entries stop right at the 10s streak.
  WHY decode starves = P4 scheduler scope.
- **PAUSED stale-frame stall (user screenshots: frozen dome at pause while play was fine)**: two
  gaps found from the same soak. (1) While paused the pan branch presented once and never
  re-requested (no rAF loop paused) — the chain died, lag sat frozen at 1.41s forever; the pan
  branch now sets `wcRerequestRef` so paused layers keep converging. (2) The divergence bail-out
  ignored paused staleness (lag 1.4–2.3s < the 3s playing floor); paused has its own strict rule
  now — target is FIXED, so lag >0.5s after a 3s streak = wedged → element fallback (the user is
  LOOKING at that frame; exactness matters most paused).
- **Assets tab stays mounted across panel-tab switches**: the tab conditional unmounted AssetBin,
  so every switch back re-paid the full mount (~300–550ms dev incl. StrictMode double-invoke —
  user's boot capture). Now hidden via `.panel-tab-hidden` (display:none = no box); the
  `:has(.asset-bin)` footer-pin rules are scoped to `:not(.panel-tab-hidden)` so other tabs'
  layout is unchanged. Effects/Color/Settings stay lazily mounted.
- **WC SELF-HEAL NET (user screenshot: cyclist clip INVISIBLE in the paused composite — the layer
  had no frame source at all, dome track showed through)**. Full audit of the source-acquisition
  chain found six stuck states with no escape hatch; all now converge to the `<video>` element path:
  (1) `wcFallbackRef` guard DEADLOCK — `!wcProviderRef.current` early-return made fallback a no-op
  exactly when the provider never arrived (init hang, preempt mid-init) → guard is now
  "element already active?"; (2) fallback now RELEASES the wc lease (was leaked until unmount —
  a broken session kept pinning a pool slot and starving other layers); (3) init-hang timeout:
  `lease.ready` has no timeout of its own → 4s then element; late-resolving provider is discarded
  if the element won; (4) busy-wedge: a getFrame that never settles left `wcBusy` stuck forever —
  no lag/null/bail could ever run (the silent-wedge class behind the export freeze bug); watchdog
  detects >3s in-flight → clears busy + element; (5) paused null-stall: a null frame never
  re-requested and paused has no rAF loop, so the 8-null fallback needed 8 SEEKS — nulls now march
  on a 150ms retry timer; (6) watchdog ran ONLY while playing — every paused pathology was
  invisible; it now runs paused too, reports `playing:` in each entry, and actively heals
  no-source (2 samples) + busy-wedge. `window.__rfWcHeals` counts which hatch fired
  (initTimeout/noSource/busyWedge/divergence/pausedStall/nullFrames). Worst case for ANY wc-stuck
  layer is now ~4s to a working element source, paused or playing.
- **TRANSPORT CORPSE root cause (the whole "frozen/photo clip" family)**: WebglMediaLayer's
  `useImperativeHandle(forwardedRef, () => sourceVideoRef.current, [])` snapshotted ONCE at mount —
  null for every WC-first mount (async lease) — so VideoPreview's five transport effects
  (play/pause/seek/rate/drift) drove `null` forever, and every WC→element fallback handed the layer
  a fully-loaded element that NOBODY ever played or re-seeked (`__rfLiveFreeze`: mode:element,
  readyState:4, paused at 0 / previous position). Deps now `[wcEpoch, mediaType, src]`; every
  element-arrival path bumps wcEpoch. This armed the day wcDecode made source arrival async.
- **TRIM-DELETE root cause (silent id-collision time bomb)**: `layer_${Date.now()}_${index}` ids
  collide when two layers are minted in the same ms from the same snapshot; the duplicate rendered
  fine until the NEXT edit re-derived the composition through `dedupeLayerIds`, which silently
  DELETED the later occurrence — experienced as "trimming deleted my clip". Three-layer fix:
  (1) id generator gained a monotonic tail; (2) the healer RE-IDS instead of deleting (user content
  is never silently destroyed) and reports via console + `globalThis.__rfHealedLayerIds`;
  (3) editor:test locks it (preserves every layer, restores uniqueness, same-ref no-op when clean).
- Unblocked concurrent color work: `pipeline.ts:280` was missing the new required
  `ColorPipeline.colorSettings` (added by the in-flight color-management change) — the legacy
  compile path now passes `DEFAULT_PROJECT_COLOR_SETTINGS`. Owner of that change: re-check intent.
- Gates: web typecheck + editor:test (148). Soak: user to re-capture `__rfClickLatency` /
  `__rfRenderCost` — expect AssetBin renders ≈ frozen during seeks, click avg well under 200ms (dev).
- **Proxy→live boundary pause — CAUGHT and root-cause FIXED**: picture froze when playback crossed
  out of a ready proxy span into a live region. Shipped a per-layer LIVE-FREEZE WATCHDOG in
  WebglMediaLayer (`window.__rfLiveFreeze`: {behindS, mode element/wc/none, paused/holding}); the
  user's very next soak caught it red-handed: WC layer 5.6→15.6s behind with `holding:true` chained
  for 10s+. ROOT CAUSE: the catch-up hold's 5s wall-clock cap reset its streak after presenting ONE
  frame, so sustained decode divergence re-armed a fresh 5s freeze per frame — an eternal pause at
  ~1 frame / 5s. Now the streak ends ONLY when lag genuinely recovers; past the window the layer
  STAYS in the progressive pan (delayed picture > frozen picture). The proxy overlay had been
  masking the freeze wherever spans were ready. Still open for P4: WHY decode diverges (session
  contention/sparse keyframes — needs the scheduler), transient `mode:'none'` samples during the
  WC→element fallback window, and the green→blue quality pop (adaptive res drops live below proxy
  quality under load — P5 unifies).

### 2026-07-04 (overnight) — Claude: asset panel Premiere batch + labels→timeline + P3 gate + rewind-hold fix

User asleep, auto mode. Gates on everything: shared/web/api/worker typecheck, web editor:test (137 checks).

- **Asset panel footer truly pinned**: the full-height chain broke at `.studio-tabs` — `panel-tab-content`
  is INSIDE it, but the `:has(.asset-bin)` grid rows sized the PANEL's children, so `.studio-tabs` measured
  max-content and the bin collapsed to content height (footer floated mid-panel). Rows moved: panel =
  `minmax(0,1fr)`, `.studio-tabs` = `max-content minmax(0,1fr)` (global.css ~4428).
- **Asset bin list view = real bin TREE**: expanded bins inline their children (persisted
  `lumio_asset_expanded_bins`), twisty + folder-open icon, click toggles / double-click opens, files indent
  one step inside their parent (thumb carries the indent; first grid column is max-content so the data
  columns stay aligned). Flat list for search / non-folder tabs.
- **Bins nest by drag-and-drop**: bin rows (list) and bin tiles are draggable
  (`application/x-lumio-asset-folder`); dropping bin A on bin B (or a breadcrumb) re-parents A's whole
  subtree — per-asset folder PATCHes + custom-bin path rename + active-folder follow + auto-expand target.
  Guards: self/descendant/current-parent drops are no-ops (`moveFolderIntoFolder` in AssetBin).
- **Multi-select in the bin**: ctrl/cmd toggle, shift range (visible order), plain click keeps
  activate+anchor; Escape clears; selection resets on tab/bin navigation. Batch bar above the footer:
  label swatches (all), move-to-bin select, confirm-once delete, clear.
- **Color labels (Premiere)**: 8-color vocabulary in `apps/web/src/lib/assetLabels.ts`. ASSET labels
  persist as a `label:<color>` tag (PATCH /assets/:id now accepts `tags`; `updateAssetTags` in api.ts with
  the same local fallback). CLIP labels = new cosmetic `TimelineLayer.label` (shared types), per-clip
  override, else inherited from the source asset (`layerLabelOf`). Timeline clips recolor via
  `--clip-label` + `.has-label` (color-mix gradient; selection keeps the hue). Set via right-click: asset
  rows/tiles open their menu with a swatch row; clip context menu got a "Label color" swatch section
  (`onSetLayerLabel` → EditorPage updateLayer). CACHE RULE: `label` excluded from `cacheRenderPropsOf` +
  editor:test check "clip color label (cosmetic) does NOT flip it".
- **Tiles hover-scrub**: pointer X scrubs the hover `<video>` (pause+seek, coalesced), thin position line;
  autoplay remains for no-move hovers. Still exactly one decoder, mounted only while hovered.
- **Closed-VideoFrame texImage2D race FIXED** (console spam while playing): paused repaints drew
  `wcFrameRef` after the provider closed the served frame. WebglMediaLayer now holds a `clone()` it owns
  (`setWcHeldFrame` closes the previous clone) + a closed-frame guard (`format === null`) before upload.
- **Rewind fast catch-up pan FIXED (3rd report)**: the catch-up hold's 60-present cap was consumed at
  rerequest cadence (<1s) — a 20–30s rewind outlived it and the tail presented as the pan. Hold is now
  wall-clock bounded: lag > 0.35s holds up to 5s per streak (`wcHoldStartRef`), then degrades to the
  progressive pan. `__rfWcHolds` telemetry unchanged.
- **P3 half 2 SHIPPED — always-on span-verification gate** (`spanVerification.ts` + EditorPage generation
  loop, before seal): blob-side decode of 3 samples → fail on undecodable/truncated, FROZEN content
  (adjacent diff < 0.12% while a video layer overlaps — the shipped soak failure mode), BLACK while media
  expected (belt for the worker guard; covers viewer capture). Fail → `markFailed` (terminal for the
  signature) + live path serves. Telemetry `window.__rfSpanVerify` + `verify-ok/-failed` diagnostics.
  PREVIEW_PIPELINE.md updated (P3 ✅, rewind item closed).
- User soak note (2026-07-04 night): 30 min continuous playback with regeneration active — no stale spans,
  no playback errors. Remaining open items unchanged (see PREVIEW_PIPELINE.md §4).

### 2026-07-04 - Codex: docked asset panel footer

- AssetBin now uses a dedicated scroll well for the variable asset/bin content, so the control toolbar behaves like a true footer fixed to the bottom of the panel.
- The left studio panel gives the active asset tab its remaining height; short asset lists leave open space above the footer, and long lists scroll above it.
- Gates: web typecheck, web editor:test.

### 2026-07-04 - Codex: asset bin move controls follow-up

- Asset panel footer now splits into a scrollable left control group and a fixed right action group, so new-bin/upload icons stay pinned at the bottom-right instead of joining the filter/view scroller.
- Asset card menus now include a `Move to bin` destination list for the current Local/Brand bin tree, complementing drag/drop moves onto bin tiles and breadcrumb targets.
- Gates: web typecheck, api typecheck, web editor:test.

### 2026-07-04 - Codex: Premiere-style asset bin cleanup

- Researched Premiere Project panel behavior: bins are project-only containers, can hold clips and nested bins, views switch between list/icon/freeform, and dragging assets onto bins moves them inside.
- Reworked the asset panel from flat folder chips into real bin navigation: breadcrumb path at the top, child bins rendered in the main content area, nested bin creation inside the current bin, asset drag/drop onto bins or breadcrumbs, and a menu action to move an asset back out of the current bin.
- Added `PATCH /assets/:id` plus `updateAssetFolder()` so folder moves persist for server assets and local-only assets.
- Moved filter/view/size/new-bin/upload controls into the lower asset-panel toolbar to clear the top area.
- Gates: web typecheck, api typecheck, web editor:test.

### 2026-07-04 - Codex: minimal timeline borders + viewer controls order + rounded fade wedges

- Timeline clips/resting transitions now keep borders visually minimal/transparent, with supporting track-label and filmstrip divider cleanup so the lanes read cleaner without extra outlines.
- Viewer controls are visually reordered: time + resolution controls sit left, transport controls are centered, and zoom/Fit stays right. Phone controls keep their existing compact behavior.
- Clip fade wedge overlays now inherit the clip's own border radius and clip their SVG drawing, so fade corners round with the clip instead of introducing separate hardcoded corner values.
- Gates: web typecheck, web editor:test.

### 2026-07-03 (late night) — Claude: wcDecode live-soak fix batch (user soaking interactively)

All found during the user's `wcDecode=1` soak; every fix gate-verified (shared+web typecheck, editor:test).

- **Stale proxy spans replayed frozen video** (both videos under a text clip frozen for exactly the span,
  recovering at its boundary): the adaptive proxy cache was serving spans generated BEFORE the decoder
  warmup-wedge fix — frozen video was baked into the proxy mp4s. `PREVIEW_PROXY_RENDER_VERSION` 4→5
  (renderCache.ts) invalidates the whole store. RULE: bump that constant whenever compositor OR decode
  pipeline output can change. A deeper "proxy/caching architecture + automatic invalidation" review is the
  agreed next block (user directive).
- **Rewind fast-forward sweep** (play after a 5–8s backward jump played the gap at high speed): the
  provider's `frameBudgetMs` contract deliberately serves progressively advancing stale frames during a
  sparse-keyframe rewind catch-up. Presenter now HOLDS the last drawn frame instead:
  `FrameProvider.lastFrameLagSeconds` (source-decoder.ts + webcodecs-decoder.ts) + hold-don't-sweep in
  `WebglMediaLayer.requestWcFrame` (lag > 0.35s → keep canvas, self-rerequest; bounded at 60 holds).
- **Play-start whipsaw AGAIN** (playhead runs ~0.5–1s then jumps back to start): the audio-master authority
  gate compared against the throttled store clock AND couldn't reject a cold-starting element sitting at its
  seek position within the 0.5s window. Masters now must be ADVANCING (currentTime moved since registration;
  350ms flat tolerance for coarse audio time granularity) and the gate compares against a new LIVE reader
  (`setLivePlaybackTimeReader`/`getLivePlaybackTime` in playback-clock.ts, registered by EditorPage from
  `currentTimeRef`).
- **Trim left keyframes behind** (drag-trim didn't touch animation data; shared ops did): extracted
  `trimLayerKeyframesTo` (timeline-ops.ts) as the single source of the trim conventions; trim suite AND
  `EditorPage.handleResizeLayer` both use it; 3 new editor:test checks.
- UI batch (user requests): viewer transport bar = one centered cluster (readout · quality · transport ·
  zoom, 22px inter-group gap, transport keeps its pill border); timeline clip selection is BORDER-FREE
  (brighter fill + `:active` instant press feedback); Inspector head chip shows type icon + ellipsized clip
  name instead of the bare type label.
- **PREVIEW_PIPELINE.md (new)**: the agreed proxy/cache + rendering architecture block — soak case file,
  Premiere-aligned target design, phases P1–P5 (fingerprint / still proxies / span verification / generation
  scheduling / single-context preview grading). **P1 SHIPPED**: `__LUMIO_RENDER_FINGERPRINT__` — vite
  build-time sha1 of the render-critical sources (list in vite.config.ts — keep it in sync when adding
  render-affecting modules!) folded into `baseCompositionSignature`, so any decoder/compositor/effects code
  change auto-invalidates cached spans; the manual `PREVIEW_PROXY_RENDER_VERSION` stays as coarse fallback.
- **GL context governor made enableable mid-soak** (user hit GL ctx 15 ≈ Chromium's ~16 force-loss): budget
  now settable (`setGlContextBudget`, shared defaults 3/4 kept for governor:test; web app boots 8/12) and
  eviction is RECOVERABLE (disposer no longer stops the WC rAF frame loop — evicted layers recreate on next
  draw). User instructed to set `lumio.glGovernor=1`. Root cause (4K stills ≈ 64–90MB GPU each, per-layer
  contexts) confirmed by user A/B; still-proxy pipeline is P2, single-context grading is P5.
- **Stuck clip-drag fixed** (clip chased the mouse, couldn't be dropped): clip-move lifecycle was
  element-bound behind setPointerCapture — a dropped capture left the drag state live while every hovered
  clip processed moves for the persistent mouse pointerId. Window-level safety net while a drag is live:
  pointerup commits, pointercancel/Escape cancels (TimelineStrip).
- **P2 SHIPPED — import-time still proxies** (`editor/performance/stillProxyStore.ts`): preview stills now
  decode a downscaled OPFS WebP proxy (tiers 1920/2560 long edge picked by the clip's static zoom, q0.82,
  EXIF applied at generation, serialized generation, session+OPFS cached, best-effort throughout — null →
  original path). Export/cloud NEVER see proxies (originals keep full quality). Root cause: a 4K still is a
  ~64–90MB GPU texture from any file size; user A/B-confirmed 4K stills broke playback where full-HD was
  perfect. Wired via `WebglMediaLayer` ImageProps `stillZoomFactor` (from VideoPreview transform/content
  scale). scene:compare 22/22 green with the path live. Legacy DOM fallback path intentionally unproxied.
- **P3 (half 1) SHIPPED — span content-signature completeness** (renderCache.ts): the hand-picked field
  list was provably incomplete — user repros: transform/scale edits and TRACK REORDERS kept serving stale
  spans (old scale; old stacking incl. the "dome flash"); the OPFS purge experiment confirmed staleness (fresh
  generation is correct). Signature now includes trackIndex + track muted/solo + `renderProps` = the WHOLE
  layer minus never-render-affecting fields (name/locked/slot/linkedGroupId) — same automatic-beats-manual
  rule as the P1 fingerprint. Track volume/pan deliberately excluded (spans are picture-only). 4 new
  editor:test checks (transform flips, reorder flips, identical agree, audio volume doesn't). Track reorder
  was already safe in LOCAL and CLOUD export (both derive z from the live track array; no cache involved).
  P3 half 2 (span verification gate) still open.
- **Asset bin: Premiere-style LIST view** (user request while soaking): real column list (Name/Type/
  Duration/Size/Used) with click-to-sort headers (persisted `lumio_asset_sort`/`_dir`), dense zebra rows,
  left-accent selection, thumbnailUrl-only thumbs (no per-row decoders), hover actions (add/preview),
  used-count → focus-on-timeline, folder rows keep drag-to-bin. Tiles view unchanged; empty state shared
  (`assetEmptyState`). All inside `AssetBin` in EditorPage + `.asset-list*` CSS.
- Soak telemetry noted, NOT yet fixed: intermittent upper layer not rendered until replay (investigating;
  suspects: WC first-frame at activation vs graded-canvas version-dedup); probe log `outputs=14` but
  probe-null → clean <video> fallback (degrade worked, cause TBD); GL ctx grows ~1/live image clip (11 seen)
  — per-layer grade contexts are the scaling wall; single-context preview grading (export Phase 2 pattern)
  is the architectural fix, folded into the proxy/cache review.

### 2026-07-03 — Claude: nesting / compound clips — design + shared expansion core (Phase A)

- **NESTING.md** (new): full Premiere-architecture-aligned design. Key decision: native nesting reuses the
  EXISTING import shape (`TimelineLayer.nestedCompositionId` + `ProjectGraph.compositions`) so imported
  Premiere nested sequences and user-created compounds are ONE feature. Premiere semantics replicated:
  live-reference sequences, clip-like behavior (trim/speed/effects on the composited output), preserved alpha,
  non-live duration (overhang = transparent/silence), no self-nesting, double-click-to-edit.
- **`packages/shared/src/nesting.ts`** (new, exported from shared index): `expandNestedCompositions` — turns
  compound clips into derived child layers in parent-timeline coordinates, ids `${clipId}__nest_${childId}`
  (same derived-render-layer pattern as `__rfx_` region clones; two instances of one nest → distinct
  decoder/proxy/raster caches). Exact time mapping (inverse of `layerSourceTimeSeconds`; child speed ramps
  carried through the affine substitution; layer-local keyframes + transition durations rescaled; head-trimmed
  children drop their junction transition). Nests-in-nests recurse with visited-set + depth cap 8; group specs
  (compound clip shell + nested comp dims) returned for the Phase-C RTT group composite. Plus
  `wouldCreateCompositionCycle` (action-time guard), `getNestedSourceDurationSeconds`, `nestParentClipId`.
- Covered by 24 new checks in `editor:test` (window trims, speed folding, ramp source-continuity, keyframe
  remap, two-instance ids, nest-in-nest re-keying, cycle degrade). Gates: shared typecheck, web editor:test.
- NEXT (per NESTING.md): Phase B editor UX (Nest action, breadcrumb open-to-edit, un-nest), Phase C renderer
  group composite in `buildSceneDraws`/`SceneCompositor` + expansion call sites (preview/export-core/manifest),
  Phase D parity fixtures. v1 constraint: speed RAMPS on the compound clip itself unsupported (scalar speed ok).

### 2026-07-03 — Codex: timeline row density XS/S/M/L fix

- Fixed the row-size control properly: `XS` keeps the old compact `S` behavior (28px), `S` is now a distinct compact-readable 36px mode, `M` is a moderate 44px mode, and `L` remains 68px. Added real row-density classes (`is-s-rows`, `is-m-rows`, `is-l-rows`) instead of letting S/M share the same normal styling. Lane offset math now matches each label width so ruler/playhead/clip geometry stays aligned. Gates: web typecheck, web editor:test.

### 2026-07-03 — Codex: Premiere-style basic shape picker

- Follow-up superseded by the row-density fix above: timeline row size control now has `XS / S / M / L`.
- Follow-up: added a Pen shape option to the remembered shape tool. Shape layers now support `shapeKind: "pen"` plus `shapePath` Bezier points (same point/tangent model as masks); shared rasterization draws cubic Pen paths and the action/editor creation paths seed a smooth editable default path. Gates: shared typecheck, web typecheck, shared actions:test, web editor:test.
- Fix: moved the remembered-shape derived values below the `lastShapeTool` hook initialization in `TimelineStrip.tsx`; this removes the render-time `Cannot access 'lastShapeTool' before initialization` crash.
- Follow-up: shape picker now uses the shared `ThemedSelect` dropdown surface (portaled, outside-click/Escape close, same styling as inspector dropdowns). The visible rail tool is a rectangle/current-shape button; picking a different primitive updates the remembered tool and adds that shape, while clicking the main icon repeats the last selected shape without reopening the menu.
- Timeline left rail shape button now opens a compact basic-shape flyout instead of adding only the default rounded rectangle. Options: Rectangle, Rounded rectangle, Ellipse, Circle, Line, Triangle, Diamond, Pentagon.
- Shape layers now carry `shapeKind` through the shared action schema/types and shared canvas rasterizer, so preview/local export/cloud raster paths draw the selected primitive instead of faking every shape as a rounded rectangle. Existing projects default to rounded rectangle.
- Shape inspector gets a themed Shape dropdown so selected shapes can be changed after creation.
- Gates: shared actions:test, shared typecheck, web typecheck, web editor:test. Playwright UI smoke was attempted against local `/editor/shape-smoke`, but the app stayed on "Opening editor / Preparing the project graph" after demo entry, so no browser interaction result was recorded.

### 2026-07-03 — Claude: image-overlay root fixes (frozen playback near photos, upside-down exports)

- **Static stills re-uploaded FULL-RES every composited frame**: media draws had
  `sourceVersion: undefined` by design ("graded canvas changes every frame") — right for video,
  catastrophic for a 4180×2776 photo (≈46MB texSubImage2D per frame → the reported
  freeze/play/freeze whenever a photo overlay was on screen). `build-scene-draws.ts` now passes the
  media producer's `updatedAt` (MediaWebGLRenderer already stamps it at the end of every draw) as
  `sourceVersion` — the compositor's existing version dedup skips un-redrawn canvases. Playing
  video redraws per frame → fresh version → behavior unchanged. No producer record → undefined →
  old behavior (DOM fallback etc.).
- **Boundary freeze at photo starts**: stills decoded + uploaded synchronously at first draw. Now:
  `img.decode()` off the paint path, then a downscale-capped (2560px long edge) ImageBitmap.
- **Images exported UPSIDE DOWN**: `texImage2D` IGNORES `UNPACK_FLIP_Y_WEBGL` for ImageBitmap
  sources (spec) — preview fed HTMLImageElement (flip applies), export fed ImageBitmap (ignored) →
  export-only vertical flip. Both preview + export bitmaps are now created with
  `imageOrientation: "flipY"` (element fallback if unsupported). Gate-locked: `wc:gate` draws the
  same asymmetric image through BOTH source types via MediaWebGLRenderer and asserts identical
  orientation. When adding a NEW ImageBitmap-fed draw source, pre-flip it the same way.
- Transport ¼/½/1/A radio + video drift corrector also landed today (see previous entry).
- **NLE_ANALYSIS.md rewritten as v2** (user request): full re-analysis — per-item
  ✅ shipped / ⏳ partial / ❌ open across every section, updated comparison table, honest pending
  list (§6, headed by cloud-path end-to-end + wcDecode soak/flip + source monitor/3-point) and
  future direction (§7 incl. linear-color/10-bit maturity). It is THE comparison reference —
  update it when shipping anything from §6.
- **Fixture hygiene**: the floating `.preview-tools` strip overlapped `.preview-composition-space`
  in parity captures — now hidden on `.pixel-fixture-page` (editor chrome must never be in a
  parity screenshot). Separately, `region-text` had drifted to ~1.11% vs its 1.0% budget —
  A/B-verified independent of today's changes (identical with sourceVersion reverted), scene/dom
  captures visually equivalent (seam + glyph-AA flavor only) → budget recalibrated to 1.25% with
  a dated note. `PIXEL_FIXTURES=<name>` filters the gate to one fixture for this kind of triage.
- Gates: wc:gate green incl. orientation checks; shared+web+worker typecheck; editor:test 110 ok;
  scene:compare full-suite rerun after recalibration.

### 2026-07-03 — Claude: export freeze ROOT-CAUSED + fixed; wcDecode flip blockers 1–3 shipped; streaming demux

- **Export "clip looks paused" bug FIXED** (user report, Venice project; also the red
  `export:worker-scene` gate): Chromium's HARDWARE H.264 decoder deterministically wedges when a
  short clip's whole stream is burst-fed into its input queue before the EOS flush (flush timeout,
  ~27 chunks stuck, no error event; provider dies → compositor keeps drawing the last good frame =
  frozen clip; in the Worker it was `WEBCODECS_REQUIRED_NO_DOM`). A/B against the pre-rewrite
  decoder proved it PRE-EXISTING (soak-era `WARMUP_MAX=64`). Fix: warmup input-queue cap 64→12 in
  `webcodecs-decoder.ts` — total warmup feed stays unbounded across rounds, so the original
  B-frame/sparse warmup-starvation fix is preserved (gated by the B-frame + single-key fixtures).
  `export:worker-scene` now PASSES (maxDiff=0%, provider works IN the Worker).
- **Streaming demux (wcDecode flip blocker 1)**: sources are disk-backed Blobs (`response.blob()`),
  mp4box parses only the sample TABLE (`appendBuffer`'s return jumps over mdat for moov-at-end),
  chunks materialize on demand from `blob.slice()` in a ≤24MB window. Peak RAM = one GOP window,
  not the file. Fragmented MP4s take a full-extraction fallback with `releaseUsedSamples`.
- **Session prioritization (blocker 2)**: `acquirePreviewFrameProvider(url, { priority, onPreempted })`
  — preload (pending/pre-roll `hidden`) shells can't take the last slot or spend warm parks, and a
  mounting playhead clip preempts the oldest preload shell (falls back to `<video>`). `hidden`
  changes flow via `lease.setPriority`.
- **Reverse-shuttle cache (blocker 3)**: ≥2 consecutive backward jumps flip the key→target decode
  pass into collect mode (byte-capped 64MB VideoFrame cache, clone-served); shuttle decode work
  measured 76 vs ~450 naive. Budget-split catch-up continues an in-flight GOP pass (`fillKeyIndex`)
  instead of restarting from the key each call.
- **New permanent gate `wc:gate`** (`apps/worker/src/wc-decoder-gate.ts` + `/editor/__wc-decoder-gate`):
  synthesizes MP4s in-browser (mp4-muxer faststart + moov-at-end + MediaEncoder hw single-key repro)
  AND an ffmpeg fixture (B-frames, sparse GOP, AAC interleave); asserts streaming-path use, frame
  accuracy, export-pattern no-freeze scans (hw+sw), reverse-shuttle cost, pool priority/preemption.
- **GOTCHA (explains "export:live-stress times out at HEAD")**: ALL browser gates need
  `PIXEL_BROWSER_CHANNEL=chrome` — headless Chromium has no H.264. export:stress + worker-scene
  pass with it set.
- **Paused≠live frame mismatch** (boats screenshot): video elements free-ran with no drift
  correction during playback (audio got its corrector earlier; video never did) — pause hard-seeked
  to the true time = visible jump. Mirrored the 500ms/0.15s corrector for video in
  `VideoPreview.tsx` (ramped clips excluded — they already resync per tick).
- **Transport res control is now a RADIO** (user request): ¼/½/1 = fixed (Auto off), A = adaptive
  (balanced base); exactly one lights up.
- **User-session note**: `lumio.wcDecode=1` persisting from the soak explains fast-forward
  catch-up on backward jumps (sparse-key sources re-decode from the GOP key under the 24ms budget)
  — advised OFF for daily editing until re-soak. Open follow-ups: intermittent PHOTO clip not
  rendering (image path — awaiting flag-off retest), boundary-freeze re-verify after these fixes.
- Gates: wc:gate (full ladder green), export:worker-scene PASS, export:stress PASS, editor:test 110 ok,
  web+worker typecheck.

### 2026-07-03 — Claude: DaVinci-style inspector number rows (NumberControl rebuilt)

- `editor/inspector/controls/NumberControl.tsx` is now a full-width row reusing the `.effect-slider-*`
  classes (label | slider | blue scrub value | reset) so all inspector numbers look identical to the
  color-panel sliders. Sliders render only for natural bounded ranges (0..100, -100..100, -180..180 —
  or explicit `slider` prop); everything else (Scale, font size, stroke width…) gets an invisible
  `.number-row-scrubpad` drag surface + drag-scrub value instead of a fake slider. Keyframe
  prev/◆/next/clear cluster lives in the label (extras revealed on row hover). All existing call
  sites (Transform, 3D Tilt, text/shape/shadow/background, warp) picked this up without API changes.
- Boxy select fields converted to label-left rows: Blend/Fit (TransformPanel) and Warp Style
  (TextWarpPanel) now use `.number-row-select`. Legacy `.number-control` CSS kept for MaskItemBody.
- New CSS in global.css after the effect-slider tone block: `.number-row`, `.number-row-scrubpad`,
  `.number-row-select`. Color tab untouched.

### 2026-07-03 — Claude: fix batch 2 (fade drag lifecycle, curve add-point, trim rAF, scrub inputs, warp bold cuts)

- **Fade handle drag was erratic** (`TimelineStrip.tsx`): the create-dot span captured the pointer
  but UNMOUNTS on the first move (it renders only while its side has no fade) — capture silently
  released, the move stream + pointerup died, and the leaked `transitionDragRef` made fades follow
  an unclicked cursor later (same mouse pointerId). Fade drags now bind move/up/cancel on WINDOW
  while active (same pattern as roll/slide trims); element spans only START the gesture. Don't
  re-add per-span onPointerMove/Up or setPointerCapture there.
- **Trim/move drag lag**: `moveResize`/`moveDrag` set React state per pointer event (125–1000 Hz
  mice) re-rendering the whole strip several times a frame. Both now write previews to their refs
  synchronously and flush ONE `requestAnimationFrame` setState (`resizeRafRef`/`dragRafRef`);
  finish/cancel read the ref so no movement is lost.
- **Curve editor point-add shifted the curve** (`CurveEditor.tsx`): clicks now insert at
  `evaluateCurve(points, x)` (ON the curve — Resolve/Photoshop behavior) and immediately start
  dragging the new point (add-then-drag single gesture; capture lives on the SVG, moves handled at
  SVG level, per-circle move/up handlers removed).
- **Warp fonts weight-aware** (`font-outlines.ts`): catalog entries are now `{regular, bold}`;
  weight ≥600 loads the -Bold binaries (Arimo/Tinos/Cousine Bold added to BOTH apps' public/fonts;
  Anton is single-style). Default text is weight 900, so warping previously swapped heavy text for
  a thin Regular outline — "Arial applies a different font". `FontBinaryResolver` signature is now
  `(family, weight?)`; all three resolvers updated.
- **New-text defaults**: default text background is `transparent` (was `rgba(8,9,13,0.14)` — the
  unwanted "14% box" behind every new text) in shared `compositionTextDefaults`, EditorPage
  `defaultTextStyle`, and the `.preview-text-layer` CSS fallback.
- **Fade handle dot on applied fades** is now hover-only like the create dots (CSS opacity gate).
- **Drag-scrub number inputs** (`components/ScrubNumberInput.tsx`): AE-style — drag horizontally on
  the value (1px = 1 step, Shift = 0.1×), plain click focuses for typing. Wired into the shared
  inspector `NumberControl`, `EffectSliderControl`'s number field, TransformPanel graph exact
  fields, clip Speed % + ramp-point %, and export settings fields. Use it for any new numeric field.
- **Lazy AI dock**: `AiChatPanel` (whole ai/ planner/executor/memory graph) is now `React.lazy` in
  EditorPage — loads only when the AI dock opens.
- **Fade slant lines** toned down per feedback: 1px, white @ 0.18 (the darkened quadrant is the
  fade indicator; the line only crispens the edge).
- **Zoom control**: native `<select>` (bulky OS popup) → `ThemedSelect` with percentages only +
  a separate compact `Fit` button (`.zoom-fit-button`, is-active in fit mode).
- **ERR_CACHE_OPERATION_NOT_SUPPORTED on /storage media**: Chromium can't range-cache the dev
  server's media responses. `cache: "no-store"` added to the remaining media fetches (audioPeaks
  waveform decode, upload-to-cloud, download-asset) — export/ducking paths already had it. Use
  no-store for ANY fetch of /storage media bytes.
- **Global error toast** (`components/GlobalErrorToast.tsx`, mounted in App.tsx): last-resort
  window `error` + `unhandledrejection` handler → one dismissible toast with an actionable message
  (network/quota/GPU/decode mappings), dedupe counter, 10s auto-dismiss. Skips ApiOfflineError
  (offline banner owns that), AbortError, and ResizeObserver noise.
- Gates: web+shared+worker typecheck, editor:test (110 ok), Node warp-font check incl. bold cuts.

### 2026-07-03 — Codex: preview transform HUD, phone rotation snap, translucent mobile sheets

- Viewer scale/size/rotation drags now show a live transform HUD attached to the selected preview overlay on desktop and mobile, with a short final-value linger after release.
- Phone rotation gestures respect Magnet: near common production angles (0/45/60/90/120/135/180 families) the rotation snaps and the HUD marks `Snap`. Desktop/laptop rotation remains freeform.
- Phone overlay sheets are now half-height, translucent (`rgba(..., 0.5)`) with blur, and use a transparent phone backdrop so users can see realtime preview/timeline changes above Assets/Inspector/Audio/AI panels. Gates: web typecheck, editor:test, desktop HUD smoke, phone overlay opacity smoke.
- Phone overlay expand buttons now switch between half-height and full-height. The Audio sheet forces the mixer open and lays out mixer-left / meter-right on phone. Gates: web typecheck, editor:test, phone Audio sheet Playwright smoke.
- Viewer guide dropdown now portals/fixed-positions so it stays visible on phone. Viewer zoom uses the custom dropdown with a compact contained trigger, fixed-size Fit button, and upward menu placement over the viewer controls. Gates: web typecheck, phone guide-menu smoke, laptop zoom-menu smoke.

### 2026-07-03 — Codex: mobile viewer hand-pan + compact track menu

- Phone Hand tool now applies to the main viewer too: touch/left-drag pans the canvas viewport, two-finger pinch/ctrl-wheel zoom targets the canvas, and preview layers/masks become pointer-transparent so selected clips do not move/scale accidentally.
- Compact phone track labels (`V1`/`A1`) now open a track menu with lock, hide/mute, solo, move up/down, and delete. Desktop/laptop inline track controls are unchanged. Gates: web typecheck, editor:test, phone Playwright viewer-pan smoke.

### 2026-07-03 — Claude: user-reported fix batch (playback jump-back, offline UX, warp fonts, timeline cleanup)

- **Playback start jump-back** (`playback/audio-clock.ts` + `VideoPreview.tsx`): new
  `AUDIO_MASTER_GATE_S` (0.5s) authority gate — a just-started audio element lags the clock by its
  play() latency; electing it master hard-resynced the WHOLE clock backward ("plays 1s, jumps back,
  restarts"). Gated readers return null; the 500ms non-master corrector seeks the element FORWARD
  onto the clock, then it becomes master smoothly. Gate > HARD_RESYNC_S so real mid-play stalls
  still resync.
- **Backend offline UX** (`lib/api.ts`, `App.tsx`): first network failure flips a shared offline
  flag → banner ("working locally; reconnecting…"), all requests fail fast with `ApiOfflineError`,
  ONE backoff /health poller (2s→15s) reconnects. No more unhandled fetch spam per mounted hook.
- **Stock import errors** (`EditorPage.tsx`, api `stock.service.ts`): import failures were
  swallowed (`catch {}`) — now an in-panel dismissible error strip; the server retries transient
  CDN 5xx once and returns an actionable message.
- **Warp font bug**: `warpFontCatalog` was EMPTY — with warp active every family rendered as the
  Roboto fallback ("cannot change fonts when warp applied"). Filled with metric-compatible OFL
  fonts (Arimo→Arial/system, Anton→Impact, Tinos→Georgia/Times, Cousine→Courier), binaries added to
  BOTH apps/web/public/fonts and apps/worker/public/fonts (keep in sync).
- **Timeline clean pass** (`TimelineStrip.tsx`, CSS): fade drawing is now the DaVinci slant
  (full-height diagonal + darkened faded quadrant, SVG in the band); fade CREATE dots are square,
  hover-only, in the top corners; trim zones start at `top: 14px` so the top strip belongs to fade
  handles (no cursor fight); trim grip bars removed (invisible edge zones remain); hover delete
  icon removed (Del + context menu cover it); clip resting border transparent; selection no longer
  translateY-lifts (read as "clip shifted up").
- **Misc UX**: favicon.svg + link tags (kills the /favicon.ico 404); viewer `.preview-stage`
  padding 18px→4px (fat gutter read as wrong aspect); viewer zoom presets → compact dropdown
  (small-laptop room); Effects panel always shows the FULL catalog with the selected clip's
  category auto-expanded (was filtered to the selection's type only).
- Fade correctness NOTE: evaluation verified end-to-end in Node (buildTransitionKeyframes →
  evaluateTimelineTransform / getCompositionTransform / getCompositionTextStyle all correct) — the
  "fade does nothing" report coincided with broken-HMR ReferenceError states; retest after reload.

### 2026-07-03 — Codex: mobile editor shell refinement

- Phone mode now uses a mobile-first shell: compact topbar, forced-fit centered viewer, compact transport, short track labels (`V1`/`A1`), and a timeline that gives most width back to clip lanes instead of desktop track headers.
- Assets/Inspector/Audio/AI sheets expand nearly full-height above the bottom rail on phone; laptop/wide layout remains on the dedicated Premiere-style workspace. Verified phone/tablet/laptop screenshots and zero page overflow in phone modes.

### 2026-07-03 — Codex: hand tool pans timeline over clips

- Fixed the timeline Hand tool so clip bodies, trim edges, fade handles, keyframes, and transition overlays start a pan gesture instead of falling through to selection/move/trim behavior.
- Pan now drives the actual `.editor-timeline-dock` scroll container on both axes and shows grab/grabbing cursors in hand mode. Verified with desktop and phone Playwright smokes over visible clips.

### 2026-07-03 — Claude: speed ramps (time remap) + resolution Auto toggle + clip fade handles

**Speed ramps** — `layer.speedKeyframes` (layer-local seconds → rate, LINEAR segments; overrides
constant `speed`). Linear is deliberate: `sourceTime = sourceIn + ∫speed` has a closed-form
trapezoid integral, so the mapping is EXACT and bit-identical in every renderer. All reads go
through the new shared helpers `getSpeedRamp`/`hasSpeedRamp`/`getLayerSpeedAt`/
`layerSourceTimeSeconds`/`shiftSpeedKeyframes` (packages/shared/src/timeline.ts):
- Trim ops are ramp-aware: split/head-trim/work-area-clip consume the INTEGRAL of the trimmed span
  and rebase the ramp (value at the cut becomes the right half's first point — split is
  source-continuous, gated by editor:test). Head-material bounds use the edge rate.
- Preview: elements follow the ramp per tick (instantaneous playbackRate + integral resync);
  matte/WC sync uses a per-tick "tangent" (effective sourceIn/speed exact at the current time);
  ramped clips never take the audio-clock MASTER role.
- Local export: scene-frame-compositor maps through the shared helper; ramped audio pre-renders to
  timeline-domain PCM (the FX path) — AudioBufferSourceNode can't follow a rate curve.
- Cloud: manifest carries `speedKeyframes`; ramped VIDEO time-remaps per frame in SceneStage via
  the documented Remotion pattern (`<Sequence from={frame}>` + dynamic trimBefore from the shared
  integral); ramped AUDIO routes through the worker post-mix (trigger extended). Proxy span
  signature includes the ramp. Gates: editor:test +7 ramp checks (110 total), audio:postmix:test
  +2 (25 total), full typecheck.
- UI v1: Speed inspector section grew a "Speed ramp" editor (add point at playhead, per-point %
  field, remove). Ramp does NOT re-derive clip duration (Premiere time-remap semantics).

**Playback resolution Auto toggle** (user request) — new "A" button in the transport next to ¼/½/1:
ON = adaptive-quality may drop below the chosen profile under load (default); OFF = the manual
choice is absolute (strong-GPU users). `adaptive-quality.ts` gained `isAdaptiveQualityOn`/
`setAdaptiveQualityOn` (persists to the existing `lumio.adaptiveQuality` key, releases the cap
immediately on OFF, and evaluate() now gates on the LIVE state so re-enabling needs no reload —
the frame-stats subscription is now unconditional).

**DaVinci-style clip fade handles** (user request) — clips grow small corner dots (top-left/right,
visible on hover/selection) while a side has NO fade; dragging inward CREATES the fade using the
existing transition-drag/band machinery; releasing at ~0 removes. FIXED en route: fades on AUDIO
clips wrote opacity keyframes (inaudible) — `handleSetTransition` now writes a marker-tagged gain
envelope on the volume effect for audio layers, so audio fade bands render/drag/remove identically,
show as points on the volume rubber band, and render with exact parity everywhere via
`getCompositionVolume`.

### 2026-07-03 — Claude: clip audio FX (EQ/compressor/gate/limiter) + auto-ducking

ONE DSP implementation for all three renderers. Full typecheck green; worker
`src/audio-post-mix-test.ts` extended with 8 FX checks (all 23 pass).

- `packages/shared/src/audio-fx.ts` (NEW): `resolveAudioFxChain(layer)` reads the new
  `audioEq`/`audioCompressor`/`audioGate`/`audioLimiter` TimelineEffects;
  `createAudioFxProcessor(chain, sampleRate)` is the streaming DSP (RBJ biquads = Web Audio's exact
  filter math; stereo-linked soft-knee compressor; gate with hold; lookahead-free limiter with hard
  ceiling clamp). **The factory must stay fully self-contained (no outer-scope refs)** — the preview
  worklet embeds it via `.toString()`.
- Chain position everywhere: source → FX (timeline domain, AFTER varispeed) → clip volume → track
  fader/pan → bus. v1: params static per clip (not keyframeable), `intensity` ignored.
- Preview: `apps/web/src/playback/audio-fx-worklet.ts` (NEW) — Blob-URL AudioWorklet module
  embedding the shared factory (plus an identity `__name` shim: esbuild keep-names injects helper
  calls into serialized function bodies). `AudioPreviewLayer` lazily inserts the node between
  source and gain only when a clip has FX; worklet unavailable → preview skips FX, exports keep them.
- Local export: `audio-mixer.ts` pre-renders FX'd clips to timeline-domain stereo PCM
  (`renderFxClipChannels`: linear varispeed resample identical to the worker post-mix, mono→stereo
  duplication matching ffmpeg `-ac 2`), runs the DSP, schedules at rate 1.
- Cloud: `apps/worker/src/audio-post-mix.ts` — audio FX now also trigger `manifestNeedsAudioPostMix`
  (like pan); FX'd layers pre-render the FULL clip through the same shared DSP so envelope state
  matches the local export even when the composition truncates the clip.
- Effects tab: Audio-category registry effects surface under the Audio bin
  (`editor/effects/catalog.ts`) for audio clips only.
- Auto-ducking (Premiere Essential-Sound model): `apps/web/src/editor/audio-ducking.ts` (NEW)
  analyzes a sidechain track's RMS (20ms hops, gap-bridging/burst-dropping) and REPLACES the target
  track clips' volume keyframes with the dip envelope — plain keyframe data, hand-editable,
  identical in all three renderers, undoable. UI: "Duck" button per `AudioMixerPanel` strip
  (sidechain select, duck dB, sensitivity, fade) → `handleAutoDuck` in EditorPage.

### 2026-07-03 — Claude: wcDecode soak fixes (decoder poisoning, UI-thread demux stall, cap hole)

User soak with `?wcDecode=1` surfaced three bugs; all fixed, wc smoke re-passed (parity 0.000%, cap
holds at 3 even after playback), web typecheck green.

- `apps/web/src/export/webcodecs-decoder.ts`: (1) key-required recovery is no longer one-shot per
  `getFrame` — retries up to 8× while the decoder makes progress (soak log: recovered at fed=76/152,
  hard-failed at fed=164 → provider poisoned → clip stopped rendering). (2) mp4box demux appends in
  8MB slices with yields and no longer copies the whole buffer per provider — with wcDecode, provider
  init runs on the UI THREAD and the old single synchronous whole-file append froze the editor when
  adding a clip of a large source. Shared with the export worker; slicing is harmless there.
- `apps/web/src/playback/preview-frame-pool.ts`: (1) pooled providers serialize `getFrame` across
  lease owners (`serializeFrameProvider`) — release() parks immediately, so a warm-reused provider
  could run two interleaved decode loops (new owner's `reset()` mid-feed of the old loop → "key
  frame is required" DataError). (2) `parkOrDispose` enforces the GLOBAL session cap, not just idle
  size — a lease released while init was in flight parked without a cap check, pinning
  active+idle = 5 real sessions. (3) Pool creates providers with `frameBudgetMs: 24`.
- More `webcodecs-decoder.ts` (round 2, same soak): (3) **codec reclamation recovery** — Chrome
  reclaims inactive codecs ("Codec reclaimed due to inactivity", exactly what a parked/paused pooled
  decoder is); the closed decoder is now RECREATED on the next getFrame instead of permanently
  failing the provider. (4) `frameBudgetMs` opt (preview-only, pool passes 24ms): getFrame returns
  the stale current frame after the budget and continues catch-up next call — a sparse-keyframe
  source (4 keys / 935 frames) froze the clip for seconds re-decoding a whole GOP after any rewind.
  Export passes no budget → blocking semantics unchanged. (5) yield via MessageChannel (setTimeout(0)
  clamps to ~4ms/round) and stall heuristics are now TIME-based (warmup bail >1500ms, drain >300ms,
  stalled rounds pace with 2ms sleeps) — round-based counting with the fast yield declared a healthy
  warming decoder stuck in <1ms. (6) mp4box demux appends in 8MB slices with yields, no whole-buffer
  copy per provider.
- NOTE: `worker export:live-stress` currently TIMES OUT (300s) on this machine **at HEAD too** —
  verified by reverting webcodecs-decoder.ts/source-decoder.ts to HEAD and re-running; pre-existing,
  not caused by today's decoder work. Needs its own investigation.

### 2026-07-03 — Claude: WebCodecs decoder pool STAGE 2 (flag `wcDecode`, default OFF)

- NEW `apps/web/src/playback/preview-frame-pool.ts`: pooled preview frame providers reusing the
  export's `createFrameProvider` (mp4box + VideoDecoder, seek-on-demand). HARD cap 3 sessions
  (`MAX_WC_SESSIONS` ≈ iGPU hardware decode sessions); slot reserved synchronously at acquire, async
  init; cap reached → null → caller keeps the stage-1 `<video>` path. Warm same-URL idle cache (2).
  Telemetry `window.__rfWcPool`.
- `WebglMediaLayer.tsx`: dual frame source — when a WC lease lands, NO `<video>` element exists for
  the clip; `drawVideoFrame` draws the provider's VideoFrame; a single-in-flight, latest-time-wins
  request loop drives paused seeks + playback (rAF). ANY failure (cap, init/probe, 8 consecutive
  null frames, getFrame throw) falls back to the `<video>` lease and self-syncs the transport
  (`wcTimeRef` mapping + `wcEpoch` re-arms element-bound effects).
- Verified live (Playwright, real Chrome, 4 simultaneous video clips): flag OFF = zero WC sessions;
  flag ON = active 3 / capMisses>0 (4th clip fell back); paused frame parity vs `<video>` **0.000%**;
  playback advances; typecheck + editor:test + scene:compare green (default path untouched).
- Known v1 trade-offs before any default flip (documented in the pool header): full-file download
  demux (RAM on big sources — streaming demux is the follow-up); reverse shuttle = keyframe re-decode
  per frame (slow); pending/preload shells still take element leases (session prioritization TBD).

### 2026-07-03 — Claude: mixer AUTOMATION (fader/pan keyframes) + user-reported fixes

- **Track audio automation**: `track.volumeKeyframes`/`panKeyframes` (`TrackAudioKeyframe {timeSeconds,value}`,
  absolute comp seconds, linear v1) — evaluate ONLY via `getTrackAudioGainAt`/`getTrackPanAt` (timeline.ts;
  static fallback built in). Preview evaluates per tick; local mixer samples product/pan envelopes into
  Web Audio ramps; Remotion `<Audio volume>` multiplies the shared evaluator; keyframed PAN routes cloud
  export through the worker audio post-mix (per-sample pan law). Mixer UI: keyframe diamonds on the
  standard `EffectSliderControl` (panel restyled from raw `<input type=range>` after user feedback;
  `.audio-mixer-panel` is now `flex: 0 0 280px` — it was being flex-squeezed). Slider moves upsert a
  keyframe at the playhead when automation exists (Premiere write-style); removing the last keyframe
  bakes the value back to the static fader.
- **FIX (user-reported): proxy fails on sped-up clips** — `viewerProxyCapture.ts` had its own
  timeline→source mapping WITHOUT the ×speed term, so capture rendered wrong-time frames and the P1b
  parity check failed the span (red bar; intermittent on low-motion footage). Now speed-aware + clamped
  to the decodable range (a 400% clip near media end holds the last frame instead of seeking past EOF).
- **FIX: M-key race** — with a clip selected, plain M fired BOTH the marker toggle (TimelineStrip) and
  the add-mask shortcut (EditorPage); their two same-tick `updateComposition` writes raced and the mask
  write clobbered the marker. Mask-add is now **⇧M** (cheat sheet updated); plain M is always the marker.
  WATCH-OUT: two window-level keydown handlers acting on the same key = silent last-write-wins on
  composition state — check both key maps before binding a new key.
- Verified: full-suite editor:test, `audio:postmix:test` 15/15, 6-package typecheck, `scene:compare` green,
  live Playwright smoke (speed 200% persisted w/ re-derived duration; pan −1 persisted; named/colored
  marker persisted).

### 2026-07-03 - Codex: adaptive editor responsive shell

- Added centralized editor responsive layout config/hook in `apps/web/src/editor/responsive-layout.ts` for mode thresholds, panel sizes, resize bounds, density, and CSS vars.
- Wired `EditorPage` to use fluid computed panel/timeline sizing, mode/density data attributes, compact topbar overflow, and tablet/phone overlay state.
- Added tablet/phone panel sheets for Assets/Inspector, a mobile bottom rail, and an Audio overlay while preserving dedicated desktop/laptop spaces when width allows.
- Gates run: `pnpm --filter @lumio-by-aelivion/web typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.
- Chrome/Playwright responsive smoke captured `1920x1080`, `1440x900`, `1280x800`, `768x1024`, `390x844`, and `430x932` under `apps/worker/tmp/responsive-layout/`; horizontal overflow is 0 in the verified tablet/phone modes.

### 2026-07-03 - Codex: custom dropdown sweep

- Replaced the remaining native JSX dropdown (`EffectPresetRow` presets) with the shared `ThemedSelect` component.
- Polished the shared dropdown trigger/menu styling so existing custom dropdowns get a cleaner dark menu, hover, and active state.
- Verified no user-facing JSX `<select>` remains outside `ThemedSelect`.
- Gates run: `pnpm --filter @lumio-by-aelivion/web typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.

### 2026-07-03 — Claude: pro-floor feature batch (presets, markers, SPEED, mixer+pan, pre-warm, cloud audio post-mix)

- **Effect presets**: shared `snapshotLayerAttributes`/`applyLayerAttributes`/`applyAttributesToLayer`
  (timeline-ops); web store `editor/effect-presets.ts` (localStorage `lumio.effectPresets`); UI row in
  the Effects inspector (`EffectPresetRow.tsx`). Presets strip `transform` — a look never moves a clip.
- **Named/colored markers**: `TimelineMarker {timeSeconds,name?,color?}` + `normalizeTimelineMarkers`
  (settings.timeline.markers now `(number | TimelineMarker)[]` — ALWAYS read through the normalizer).
  Right-click a ruler marker → rename/recolor popover (TimelineStrip `markerEditor` state).
- **Clip speed / rate stretch** (`layer.speed`, read ONLY via `getLayerSpeed`): sourceTime =
  sourceIn + local×speed in web preview (`syncVideoTime`, AudioPreviewLayer, matte syncs), local export
  (`scene-frame-compositor`, `audio-mixer` via `playbackRate` + duration×speed), Remotion
  (`OffthreadVideo/Audio playbackRate`, trimBefore lead×speed). Trim ops scale sourceIn deltas by speed;
  head-material bounds divide by speed; `getLayerMaxDuration` divides by speed; renderCache span
  signature includes speed. UI: Speed inspector section, duration re-derives, linked companions follow.
  WATCH-OUT: `layerMaxDurations` map is now in speed-adjusted TIMELINE seconds.
- **Audio track mixer**: `track.volume`/`track.pan` via `getTrackAudioGain`/`getTrackPan`;
  preview graph gained a StereoPanner (unity/center = byte-identical); local mixer multiplies
  trackGain into gain/envelope + StereoPanner; `AudioMixerPanel.tsx` docked in `.timeline-dock-row`.
- **Cloud audio post-mix** (`apps/worker/src/audio-post-mix.ts` + `remotion-renderer.ts`): when ANY
  audio layer has non-zero trackPan, Remotion renders video MUTED and the worker mixes audio in JS
  (shared `getCompositionVolume`, StereoPanner spec pan law, varispeed) then ffmpeg-muxes (ffmpeg-static,
  `allowBuilds` in pnpm-workspace.yaml). Escape hatch `WORKER_AUDIO_POST_MIX=0`. Gate:
  `audio:postmix:test` — 15 checks incl. real ffmpeg decode/mux with per-channel loudness assertions.
- **Shader pre-warm**: `SceneCompositor.prewarmTransitions()` (public) + idle pre-warm in
  ScenePreviewCanvas (`prewarmTransitionIds` from VideoPreview). Export font load now timeout-raced (3s).
- **Pre-existing bugs FIXED**: preview audio ignored `sourceInSeconds` (trimmed audio clips played
  from 0 in preview, trim point in export); Remotion `<Audio>` never got `trimBefore` (sourceIn ignored
  in cloud export).

### 2026-07-03 - Codex: asset-bin folders and full-panel drop affordance

- Local/Brand asset panels now show folder controls with All, created/found folders, and a Create folder action.
- Uploads and dropped files land in the selected Local/Brand folder; root All still shows the full source library.
- The "Drop media, Premiere/XML, or template files here" prompt only appears when the current asset view is empty, while the whole asset panel remains a drop target.
- Gate run: `pnpm --filter @lumio-by-aelivion/web typecheck`.

### 2026-07-03 - Codex: asset-bin drag-and-drop upload/import

- Local/Brand asset panels now accept dragged files; media files upload to the asset library.
- Dropped `.prproj`, `.edl`, `.fcpxml`, `.xml`, `.json`, and `.lumio-template` files in the main Assets panel route through the existing timeline/template import flow.
- File picker now supports multi-select and the same media/import file routing in the main Assets panel.
- Gate run: `pnpm --filter @lumio-by-aelivion/web typecheck`.

### 2026-07-03 - Codex: timeline whole-track reorder handles

- Added a drag handle to the left track label rail; dragging it onto another compatible track reorders the entire track with all its layers intact.
- Track reordering is constrained within visual-vs-audio families, so audio stays below visual tracks while V tracks and A tracks can be rearranged internally.
- Added drop-position styling on the track header rail.
- Gates run: `pnpm --filter @lumio-by-aelivion/web editor:test`, `pnpm --filter @lumio-by-aelivion/web typecheck`.

### 2026-07-03 - Codex: timeline Ctrl+A selects all clips

- Added Ctrl/Cmd+A in the editor keyboard handler to select every timeline layer while preserving normal text selection inside inputs, textareas, selects, and contenteditable fields.
- Gate run: `pnpm --filter @lumio-by-aelivion/web editor:test`.
- Note: `pnpm --filter @lumio-by-aelivion/web typecheck` is currently blocked by unrelated `VideoPreview.tsx` audio prop/helper errors (`trackGain`, `getTrackAudioGain`, `getTrackPan`).

### 2026-07-03 - Codex: editor toolbar import button order

- Swapped the top editor toolbar template/timeline controls so Import timeline/template appears before Export template package.
- Gate run: `pnpm --filter @lumio-by-aelivion/web typecheck`.

### 2026-07-03 - Codex: `.prproj` successful sequence selection no longer unsupported

- Moved `prproj.multiple_sequences` from Unsupported to Mapped because the importer now intentionally selects the clip-heavy sequence and preserves nested sequence links.
- Verified the user's `Visualizer_Slideshow.prproj` report now has `unsupportedCount: 0`.
- Gates run: `pnpm --filter @lumio-by-aelivion/shared typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.

### 2026-07-03 - Codex: `.prproj` nested sequence import foundation

- Added optional `ProjectGraph.compositions` and `TimelineLayer.nestedCompositionId` so imports can preserve Premiere nested sequences as linked Lumio compositions.
- The `.prproj` object fallback now catalogs every sequence, links parent clips whose SubClip/MasterClip name matches a sequence, and stores nested timelines alongside the root composition.
- Obvious Premiere `Graphic` title clips import as native Lumio text layers with editable placeholder text, ready for later private-data text/animation decoding.
- Verified the user's `Visualizer_Slideshow.prproj`: root `Work` sequence imports 20 clips, 15 nested sequence links, 12 compositions, and 10 native text layers.
- Gates run: `pnpm --filter @lumio-by-aelivion/shared typecheck`, `pnpm --filter @lumio-by-aelivion/web typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.

### 2026-07-03 — Claude: paste attributes (⌃⌥C/⌃⌥V) + asset-bin preview chip & Download

- Shared ops `copyLayerAttributes`/`pasteLayerAttributes`/`hasClipboardAttributes` (timeline-ops.ts):
  effects replaced with fresh-per-layer-id clones; transform/fit copied; timing/keyframes/masks
  untouched. 6 editor:test checks + live Playwright smoke (persists to the server graph).
- WATCH-OUT (real race found live): EditorPage keyboard handlers must read selection via
  `selectedLayerIdsRef` (NEW), not the effect closure — a keypress in the same frame as a selection
  click uses the pre-click selection otherwise. If you add selection-dependent shortcuts, use the ref.
- Asset bin: type chip is now a preview button (was `pointer-events:none` + covered by the hover
  overlay — needs z-index 4 like `.asset-chip-used`); NEW Download menu item (`downloadAssetFile`,
  fetch-to-blob, works for localblob/API/cloud URLs).
- Also: decode-path color probes on the REAL venice source (15407080…mp4, confirmed bt709 8-bit):
  `<video>` vs WebCodecs → texImage2D readbacks agree (signed mean −0.5/255). Color investigation
  paused; resumes with the user's viewer.png + export.mp4 dump (Downloads/color-debug).

### 2026-07-03 - Codex: real `.prproj` fallback selects clip-heavy sequence

- Added a text-level Premiere object-reference fallback for `.prproj` files where the normal XML tree path sees only placeholder/empty sequences.
- Fallback scans `ObjectID`/`ObjectUID` blocks and follows sequence -> track group -> track -> clip refs, then selects the sequence with the most readable clips.
- Verified the user's `Visualizer_Slideshow.prproj` now imports `Work` with 20 clips instead of `Placeholder_1` with 0 clips.
- Added editor-test coverage for placeholder-first fallback sequence selection.
- Gates run: `pnpm --filter @lumio-by-aelivion/shared typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.

### 2026-07-03 - Codex: real `.prproj` object-graph import hardening

- Hardened `.prproj` import for real Premiere project XML that stores sequences/tracks/clips as separate `ObjectID`/`ObjectUID` nodes linked by `ObjectRef`/`ObjectURef`, instead of nested timeline XML.
- Sequence import now resolves track groups -> track objects -> ref-only clip items -> actual clip objects; audio track fallback is authoritative when referenced clip objects omit an explicit media type.
- Empty sequence imports now add a clearer `prproj.no_clips` unsupported report with track/clip-ref counts and the Final Cut Pro XML fallback suggestion.
- Added editor-test coverage for referenced object-graph video/audio clips.
- Gates run: `pnpm --filter @lumio-by-aelivion/shared typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.

### 2026-07-03 - Codex: limited `.prproj` timeline import

- Added `.prproj` detection to the external timeline adapter and editor import picker.
- Browser import now accepts gzip-compressed `.prproj` files and plain XML `.prproj` files, then feeds decoded XML through the shared adapter.
- V1 imports the first readable Premiere sequence's video/audio clip timing, source in-points, media placeholders, and obvious Cross Dissolve transitions; reports multiple sequences, effects/components, nested sequences, invalid clips, and unmapped transitions.
- Added `examples/timeline-imports/simple-premiere.prproj`, docs tracker updates, and editor-test coverage.
- Gates run: `pnpm --filter @lumio-by-aelivion/shared typecheck`, `pnpm --filter @lumio-by-aelivion/web typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.

### 2026-07-03 - Codex: smooth multi-select vertical drag

- Replaced DOM hover-based track targeting with pointer-delta/row-pitch targeting, so dragging through the gap between tracks no longer flips the target up/down.
- Selected clips now follow the pointer smoothly in Y while the destination track is snapped separately on release; all moved clips get the dragging state so CSS transitions do not lag behind the pointer.
- Gates run: `pnpm --filter @lumio-by-aelivion/web typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.

### 2026-07-03 - Codex: imported track placement + multi-select vertical track drag

- Append timeline imports now insert imported visual tracks above all existing visual tracks and keep audio tracks grouped below visuals.
- Multi-selected clip drags now preserve the selected clips' relative track spacing when dragged up/down, with per-clip target tracks and live vertical preview offsets; visual clips cannot be dropped into audio tracks and audio stays in audio tracks.
- Gates run: `pnpm --filter @lumio-by-aelivion/web typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.

### 2026-07-03 — Claude: trim suite complete (roll R / slide U tools, E extend edit) + color-parity elimination work

- Shared pure ops `rollEditAtCut`/`slideLayer`/`trimLayerEdgeTo` + `rollEditLimits`/`slideLayerLimits`
  in `timeline-ops.ts`; `TimelineToolMode` extended with "roll"/"slide". NOTE `layerMaxDurations`
  semantics: "max playable duration from the CURRENT sourceIn" — head-extension is bounded by
  `sourceInSeconds`, NOT by that map.
- `TimelineStrip.tsx`: roll/slide drags = slip pattern (delta badge, one commit on release). WATCH-OUT:
  clip-element pointermove after setPointerCapture did NOT fire for the new drag (pattern works for
  slip, not here) — trim drags use WINDOW pointermove/up listeners bound only while active. EditorPage:
  `handleRollEdit`/`handleSlideLayer`/`handleExtendEditToPlayhead` (E). 11 new editor:test checks +
  2 live Playwright smokes green.
- Viewer↔export ~+3.2 brightness shift (user report, venice project): measured EVERY stage in real
  Chrome incl. HEADED on the user's GPU — encode roundtrip (2d/WebGL/Worker sources), muxer bt709
  tagging, on-screen video-vs-canvas rendering, and BOTH source decode paths (<video> vs WebCodecs →
  texImage2D) — ALL ±1/255. The synthetic pipeline is color-exact end to end; the user's real (local-
  only, not on server) source file properties are the remaining suspect (10-bit/HDR transfer or
  full-range flag → asymmetric tone-mapping between <video> and WebCodecs decode). Blocked on the file.

### 2026-07-03 — Claude: keyboard editing slice 1 (JKL shuttle, ↑/↓ edit points, ⇧-step, Q/W ripple trim)

- NEW shared pure ops (`packages/shared/src/timeline-ops.ts`): `rippleTrimLayer` (Q/W head/tail trim to a
  time + per-track ripple, keyframes per the split conventions) and `collectEditPoints`. Tested in
  `editor.test.ts`.
- `EditorPage.tsx` transport handler: J/K/L (L from stop = 1x ENGINE play with audio; second L / L while
  playing = 2x→4x rAF SHUTTLE via the seek path — reverse and >1x can't ride the rate-1 wall-clock anchor),
  ↑/↓ edit-point jumps, ⇧←/→ 5-frame step, Q/W ripple trim of selected (else first) clip under playhead.
  `stopShuttle` is called from togglePlayback/stepFrame/seek-ish paths — if you add a new "user moved the
  playhead" path, stop the shuttle there too. `.viewer-shuttle-badge` overlays the viewer (global.css).
- Timeline cheat sheet ("?") updated. Live Playwright smoke passed (badge 2×/reverse/K-stop). NOTE (found
  while smoking, pre-existing, NOT fixed): layers missing `transform` crash `startPreviewDrag` +
  `TransformPanel` (`evaluateTimelineTransform` reads `.position` unguarded) — only reachable with
  hand-built/API-imported graphs, e.g. the "viewer-capture-verify" test project.

### 2026-07-03 — Claude: cloud-export (Remotion) color parity fix + proxyViewerCapture default ON

- `apps/worker/src/remotion-renderer.ts` `renderManifestToMp4`: added `colorSpace: "bt709"` AND
  `disallowParallelEncoding: true`. Without the first, ffmpeg wrote full-range untagged YUV that players
  decode as limited BT.709 (user-visible contrast/saturation blowout; measured ±19/255 on grays).
  WATCH-OUT: the second is REQUIRED with the first — Remotion's parallel pre-encode converts with BT.601
  while tagging BT.709 (±39/255 on saturated primaries). Verified empirically: color-patch manifest →
  real Remotion render → Chrome decode, post-fix worst delta ±1/255. Do not re-enable parallel encoding
  until Remotion fixes the pre-encode matrix. Note `render:compare:pixels` can NEVER catch this class
  (it compares pre-encode still frames).
- Local WebCodecs export measured clean the same way (±1: 2d canvas, WebGL2, Worker OffscreenCanvas).
  Known edge documented in GAPS.md §2b: `new VideoFrame(canvas)` premultiplies straight alpha — output
  pixels with alpha<255 darken in export (compositor clears opaque today, so not currently reachable).
- `apps/web/src/color/render-engine.ts`: `getProxyViewerCaptureEnabled` default flipped to TRUE after
  the real-project soak (viewer-first seal, parity-ok 0.00%, 0 worker fallbacks). Escape hatch
  `?proxyViewerCapture=0`. M1a/M1b KEPT — they harden the export-Worker pipeline, still the live
  fallback when capture fails. Gates: worker+web typecheck, editor:test.

### 2026-07-02 — Claude: proxy-captures-viewer P1a + parity self-check P1b (flag `proxyViewerCapture`, default OFF)

- `packages/shared/src/color/scene-compositor.ts`: `renderFrameUnchecked` split into `renderFrameCore` +
  `presentFrame` (byte-clean: scene:compare 22/22 after); NEW `renderFrameOffscreen(spec, buffer?)` —
  composite + RGBA readback WITHOUT presenting (top-origin rows; on-screen canvas untouched).
- `ScenePreviewCanvas.tsx`: NEW `captureRef` → `SceneViewerCaptureHandle` (getSharedGl /
  ensureTextRasters / renderOffscreen / releaseCaptureResources); overlay-grade pool keys prefixed
  "capture:" so capture never LUT-thrashes the live frame; drawRef prune skips those keys.
- NEW `apps/web/src/editor/performance/viewerProxyCapture.ts`: `captureSpanProxyFromViewer` (pooled
  `<video>` decode + shared-context grade renderers — zero new GL contexts — through the LIVE compositor)
  and `verifySpanProxyAgainstViewer` (P1b: decode sealed-webm sample frames, compare vs fresh offscreen
  viewer render; >8% pixels off by >24/channel → span failed, stays live).
- `EditorPage.tsx`: viewer capture first, worker pipeline fallback; P1b check runs before sealing for
  BOTH pipelines when the flag is on. `VideoPreview` exports `isLayerActive` / `isOutgoingInPostroll` /
  `applyActiveAdjustmentEffects` (the generator reuses viewer logic — do NOT duplicate them).
- Verified live (Playwright real Chrome): span sealed viewer-first (0 worker fallbacks) + parity-ok on an
  image+look+region-blur comp; failure chain degrades cleanly. Gates: 4-pkg typecheck, editor:test, build,
  scene:compare 22/22. Left "viewer-capture-verify" + "effect-leak-repro" projects on the demo account.

### 2026-07-02 — Claude: FIX pending-clip effect leak (region effects painted ~1.2s early onto the previous clip)

- Root cause: `EffectMaskOverlays` (VideoPreview) renders a `backdrop-filter` DOM overlay for MASKED
  effects — it blurs whatever is BENEATH it in the DOM (the preview canvas showing the previous clip).
  Active clips never trigger it (they're expanded — region effects stripped off the base), but PENDING
  preload entries come from the RAW composition with `effect.masks` intact, and the overlay is a SIBLING
  of the hidden media element — never hidden with it. Leak window == `PRELOAD_LOOKAHEAD_SECONDS` (1.2s
  ≈ the reported "~37 frames").
- Fix: all four `EffectMaskOverlays` call sites gate on `pending || sceneComposited` (pending = decode
  warm-up shell, never a visual; scene mode composites region effects natively — the DOM overlay is
  DOM-path machinery only). Also future-proofs the planned scene-path expansion retirement.
- Verified with a Playwright repro (pending clip with region blur over an active image): pre-fix leak
  11.127% of the frame; post-fix 0.000%. Region scene:compare fixtures byte-identical; typecheck +
  editor:test green. Repro left 4 harmless "effect-leak-repro" projects on the demo account (no DELETE
  API route to remove them).

### 2026-07-02 — Claude: region-effect pass model R2d — DEFAULT ON in all three renderers

- One flip point: `REGION_PASS_MODEL_DEFAULT` in `packages/shared/src/scene/build-scene-draws.ts` (now
  TRUE) → web flag env fallback + NEW `RenderManifest.regionPassModel` (`packages/render-templates`) →
  `SceneStage` controller. Never flip a renderer independently; escape hatch `?regionPasses=0`.
- Export front-end clone-decode skip: `export-core.activeSourceKeysAt` never loads `__rfx_` providers;
  `scene-frame-compositor` never grades clones (a WebCodecs decoder saved per region effect at export).
- NEW `overlap-region-effects` fixture (grade+blur, SAME region) — `scene:compare` runs it as an
  always-on 3-way check: clone-parity (scene off vs DOM) + combine-delta (scene on vs off) at STRICT
  pixelmatch 0.02. The strict threshold matters: the standard 0.16 perceptual threshold reported 0.000%
  on images differing on 29% of pixels — a silently-dropped pass was previously invisible to the gate.
- Gates (real Chrome): `scene:compare` 22/22 both flag states; `render:compare:pixels` 7/7 region
  fixtures (first real-GPU run); strict-threshold cross-renderer overlap check 1.186% (clone-model
  Remotion would be ~25%); 4-package typecheck; `editor:test`; web build.

### 2026-07-02 — Claude: region-effect pass model, TRUE-fix stage R2a–c (same flag, still default OFF)

- `packages/shared/src/color/media-renderer.ts`: `draw()` accepts a shared-context `sourceTexture`
  (grade an EXISTING texture — bottom-origin, drop-in with the flip-Y upload path); `source` is now
  optional when `sourceTexture` is set.
- `packages/shared/src/color/scene-compositor.ts`: `SceneRegionPass` is now `{effectKey, mask,
  blurPx? | pipeline?}` (clone-source fields REMOVED — R1 was never released); color passes grade the
  RUNNING nest image via a per-effectKey pool of shared-context `MediaWebGLRenderer`s (own baked LUT
  each, pruned ~300 idle frames, zero extra GL contexts).
- `packages/shared/src/scene/build-scene-draws.ts`: passes derive from ls clones OR are synthesized from
  UNEXPANDED layers via `expandLayerEffectRegions` — the scene path no longer needs upstream expansion.
- `apps/web/src/components/VideoPreview.tsx`: flag on → NO `__rfx_` clone mounts a decoder/GL context
  (extends the blur-alias saving to region COLOR); scene failure re-mounts them for the DOM path.
- Gates (real Chrome): `scene:compare` 21/21 flag OFF (byte-stable) + 21/21 `REGION_PASSES=1` with clone
  mounts skipped; shared/web/worker typecheck, `editor:test`, web build.
- Watch-out: `SceneRegionPass.effectKey` drives the LUT cache — keep it stable per effect (clone id today).

### 2026-07-02 — Claude: region-effect pass model, TRUE-fix stage R1 (flag `regionPasses`, default OFF)

- `packages/shared/src/color/scene-compositor.ts`: NEW `SceneRegionPass` + `SceneLayerDraw.regionPasses` +
  `renderLayerWithRegionPasses` (per-layer nest on a DEDICATED RTT pair; blur passes gaussian the RUNNING
  nest image, color passes composite their clone-graded source masked; finished nest composites once with
  the layer's opacity/blend). Zero new shaders — reuses `compositeTexture`/`gaussianBlur`/nest retargeting.
- `packages/shared/src/scene/build-scene-draws.ts`: `regionPassModel` input folds `__rfx_` clones into
  ordered passes on the base draw; transition clip groups collapse to one draw per side. Upstream expansion
  (`expandEffectRegionMasks`) + per-clone grading/aliases UNCHANGED — the flag toggles only the composite.
- Wiring: `getRegionPassesEnabled()` in `apps/web/src/color/render-engine.ts` (query/localStorage/env,
  default FALSE) read by `ScenePreviewCanvas` + `scene-frame-compositor`; Remotion `SceneStage` explicitly
  false — when the default flips it must thread through the render manifest so all three flip TOGETHER.
- Gate upgrade: `scene:compare` accepts `REGION_PASSES=1` (scene side runs the pass model vs the same DOM
  oracle). Run in real Chrome: 21/21 flag OFF (no-change) and 21/21 flag ON (region fixtures 0.005–0.743%).
- Watch-out: do NOT add per-effect-type logic to passes (registry metadata only, todo.md P3); do NOT flip
  the flag default in one renderer alone.

### 2026-07-02 - Codex: ruler endpoint jitter fix

- Made the timeline duration/end ruler tick explicit instead of relying on `span:last-child`.
- Suppressed the previous ruler tick when it is too close to the duration label, avoiding overlap/flicker at the right edge.
- Gates run: `pnpm --filter @lumio-by-aelivion/web editor:test`; web typecheck is currently blocked by Claude's claimed `scene-compositor.ts` region-effect work.

### 2026-07-02 - Codex: timeline import append, relink, and audio-track guards

- Timeline import report offers **Append to current** and **New timeline**.
- Append mode preserves the current composition and adds imported tracks after the existing timeline end with fresh IDs.
- Right-click `Replace asset...` keeps original clip start/track/duration and no longer creates companion audio while relinking.
- Asset-bin hover add buttons route to replacement while replace mode is active.
- New MP4/MOV uploads are tagged with detected audio presence; auto companion audio is only created when audio is present, and known no-audio videos disable audio-only/linked-audio actions.
- Gates run: `pnpm --filter @lumio-by-aelivion/web typecheck`, `pnpm --filter @lumio-by-aelivion/web editor:test`.

### 2026-07-02 — Claude: crash recovery + persistence hardening (P1 slice 1)

- NEW `apps/web/src/lib/crash-recovery.ts` — per-project OPFS checkpoint (`recovery/<id>.json`,
  1s debounce, pagehide/tab-hide flush). Hooked into `sync.ts` `scheduleGraphSave`, so it covers
  server projects too (they previously had NO local persistence — an offline crash lost everything
  since the last sync). Kill switch `?crashRecovery=0`.
- `sync.ts`: local draft persist is now debounced 250ms (was a synchronous full-JSON localStorage
  write of ALL local projects on every edit) with lifecycle flush + a flush before every
  server-sync path reads the record (`flushGraphSave`, `doSyncProject`).
- `api.ts` `writeLocal` no longer throws on quota overflow (console.warn instead).
- `EditorPage.tsx`: `recoveryOffer` state + "Restore unsaved changes?" modal — offered only when
  the checkpoint is strictly newer than the loaded record (2s slack) AND the graph differs;
  Restore is undoable; X keeps the checkpoint, Discard deletes it.
- Finding: the gap analysis's "patch-based undo" item is a non-issue — undo stores references over
  immutable (immer/spread) updates, so history is already structurally shared. No change made.
- Verified: web typecheck, `editor:test`, web build, and a live Playwright crash simulation
  (blocked PATCH → edit → close → reopen shows the modal → Restore reapplies → no re-offer).

### 2026-07-02 - Codex: Task 9B external timeline import adapters

- Added shared external timeline adapter in `packages/shared/src/external-timeline-adapter.ts` and exported it from shared.
- Supports CMX-style `.edl`, FCPXML `.fcpxml`, and Final Cut/Premiere XML `.xml` imports into native Lumio compositions with media placeholder slots and import reports.
- Wired the editor top-bar Import timeline/template button to detect those files, show a report modal before applying, preserve existing project plugin manifests, and store the report in `editableFields.timelineImportReport`.
- Added manual examples in `examples/timeline-imports/`; updated `PLUGIN_ARCHITECTURE.md` and `architecture.md`.
- Gates run: `pnpm --filter @lumio-by-aelivion/shared typecheck`, `pnpm --filter @lumio-by-aelivion/web typecheck`, and shared smoke imports for EDL/FCPXML/XML.

### 2026-07-02 — Claude: NLE gap analysis + full P0 performance track + timeline polish

Full detail per item is in `architecture.md` (same date). Files touched are listed so Codex knows
what's fresh:

- **NLE gap analysis** (vs Premiere/Resolve; low-end browser goal) — drove all of the below.
- **Playback frame telemetry + adaptive playback resolution** — NEW `apps/web/src/editor/performance/frame-stats.ts`,
  `adaptive-quality.ts`; loop instrumentation in `apps/web/src/components/ScenePreviewCanvas.tsx`; wiring +
  Stats HUD toggle in `apps/web/src/components/VideoPreview.tsx`; NEW `PreviewStatsOverlay.tsx`. Kill switch `?adaptiveQuality=0`.
- **Shared <video> decoder pool (stage 1)** — NEW `apps/web/src/lib/video-element-pool.ts`;
  `WebglMediaLayer.tsx` now LEASES its source/matte videos (no JSX <video>). Kill switch `?videoPool=0`.
  Verified `scene:compare` 21/21 in real Chrome.
- **Context governor DEFAULT ON** — NEW gate `apps/worker/src/governor-stress.ts` (`governor:stress` script) +
  NEW fixture `apps/web/src/pages/GovernorStressPage.tsx` (route `/editor/__governor-stress` in `App.tsx`);
  default flipped in `apps/web/src/color/render-engine.ts` (`getGlGovernorEnabled` → true). Escape `?glGovernor=0`.
- **Audio-master playback clock** — NEW `apps/web/src/playback/audio-clock.ts`; servo in `EditorPage.tsx`
  playback tick; source registration + non-master drift correction in `VideoPreview.tsx` (AudioPreviewLayer).
  Kill switch `?audioClock=0`.
- **Timeline audio meters** (Premiere-style stereo PPM + RMS core) — NEW `apps/web/src/playback/preview-audio-bus.ts`
  (shared preview AudioContext moved OUT of VideoPreview; unity master bus + analysers), NEW
  `apps/web/src/components/TimelineAudioMeters.tsx`; docked via NEW `.timeline-dock-row` flex wrapper in
  `EditorPage.tsx` + `global.css` (the wrapper took over `.editor-timeline-dock`'s grid-placement rules — the
  dock itself is still TimelineStrip's untouched scroll container).
- **Timeline polish (Playwright-verified live)** — track-header rail integrated (label z-index 8, `::after` gap
  covers, `--editor-surface` theme) in `global.css`; Home-key seek-into-view scroll in `TimelineStrip.tsx`
  (paused-seek effect only).
- **OPFS proxy-cache rehydration** — persisted span index in `apps/web/src/editor/performance/proxyMediaStore.ts`
  (`proxy-span-index.json`, `saveRecord`/`readIndex`/`releaseAllUrls`); rehydrate + no-wipe-on-unmount in
  `EditorPage.tsx`. Closes GAPS.md §1's last deferred item.

Gates run today: `pnpm -r`-level web typecheck, `editor:test`, web build (all repeatedly green);
`scene:compare` 21/21 twice in real Chrome; `governor:test`; new `governor:stress` (enforced peak 7 bounded /
control 13 unbounded). Docs updated: `architecture.md`, `GAPS.md`, `todo.md`.

**Watch-outs for Codex:**
- `WebglMediaLayer` no longer renders `<video>` in JSX — decoders come from `video-element-pool.ts` leases
  (exclusive per mount; the component is keyed by src). Don't reintroduce declarative video elements.
- `.editor-timeline-dock` grid-placement CSS rules now target `.timeline-dock-row` (its new parent). The dock
  is still the scroll container `TimelineStrip` finds via `closest(".editor-timeline-dock")`.
- Preview audio must route through `getPreviewMasterBusInput(ctx)` (not `ctx.destination`) or it won't meter.
- The governor is ON by default now — per-layer GL contexts get LRU-evicted when idle; renderers must
  register a disposer + lazily recreate (see `WebglMediaLayer.ensureRenderer`).
