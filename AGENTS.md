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

### 2026-07-14 — Claude (Sonnet): Editor bug/feature batch — 16 items (masks, paste-attributes chooser, multiselect, 5 new shader effects, nesting UX, canvas frames)

Worked a user-supplied punch list end to end (plan committed to `functional-snacking-eich.md`), all typechecked
+ `editor:test`-covered + Playwright-verified live against the dev server. Summary by area:

**Inspector/input fixes**: Position X/Y range widened -50..150 → -200..300 (`TransformPanel.tsx`) and matched in
the canvas drag/resize/rotate clamps (`VideoPreview.tsx`) — the mismatch was also the root cause of a canvas
drag jump bug. `ScrubNumberInput` now holds a local draft while focused and commits only on blur/Enter (fixes
typed values getting stomped mid-keystroke by the controlled re-render). Fade-handle and keyframe-diamond timeline
drags now snap to `frameStepSeconds` instead of the coarse clip-edge `snapStepSeconds` (fixed the reported
"jumping" handles). `startPreviewDrag`/`startPreviewResize`/`startPreviewRotate` now read the KEYFRAME-EVALUATED
transform at drag-start instead of the raw base value (a keyframed clip's canvas drag/resize/rotate used to jump
the instant the gesture began).

**New capabilities**: Masks panel + region-mask folding now cover adjustment layers (`effectsWithLayerRegionMask`
in `clip-masks.ts`, used by both `VideoPreview.tsx` and Remotion `SceneStage.tsx`). "Fit canvas"/"Fill canvas"
quick actions on video/image (`TransformPanel.tsx`). Paste-attributes (⌃⌥V) now opens a group chooser modal
(`PasteAttributesModal.tsx`) — `timeline-ops.ts`'s `applyAttributesToLayer`/`pasteLayerAttributes`/
`applyLayerAttributes` gained an `AttributeGroup` filter (transform/effects/fit/masks/content/speed), fully
backward compatible (default = all groups). Multiselect property editing: `updateTimelineLayers` (shared) +
`updateLayers` (EditorPage) broadcast one inspector edit to every selected clip; `handleAddTimelineEffect` also
broadcasts. Effects catalog now sub-groups Video/Text folders by registry category (Blur/Adjust/Stylize/…) when
a folder mixes more than one. Rectangle masks gained `cornerRadius` (`roundedPolygonPathD` in `clip-masks.ts`,
shared SVG builder — both renderers get it for free). Non-source-layer (text/shape/image) trims now SQUEEZE
(proportionally rescale) keyframes onto the new duration instead of cutting them off (`squeezeLayerKeyframesTo`
in `timeline-ops.ts`; video/audio still cut, unchanged).

**5 new GPU shader effects** (Radial Blur, Directional Blur, Sharpen, Pixelate, Chromatic Aberration): real
single-pass fragment shaders registered as first-class `TimelineEffectType`s
(`color/fragment-effects/builtins.ts`), riding the EXISTING `SceneFragmentPass`/"Custom Shader" harness
(`buildFragmentPasses` in `scene/build-scene-draws.ts` now maps these types straight to their `builtin.<type>`
definition, no manifest indirection) — so preview (scene compositor) and Remotion get them for free, pixel-
identical by construction. Playwright-verified live: Radial Blur (zoom-streak ghosting), Chromatic Aberration
(RGB fringing), and Pixelate (mosaic block distortion) are unmistakable on a text layer at default settings;
Sharpen/Directional Blur added without errors (same shader harness, structurally verified). DOM (non-scene)
fallback does not render these — documented limitation, matches the existing Custom Shader effect's scope.

**Nesting (compound clips) — Phase B (editor UX)**: the render pipeline (`nesting.ts`'s
`expandNestedCompositions`, `buildSceneDraws` group-composite, Remotion `SceneStage` group support) was ALREADY
fully built (NESTING.md Phase A/C, prproj-import support) — only the user-facing actions were missing. Added
`nestLayersIntoComposition`/`unnestClip` (`nesting.ts`): Ctrl/Cmd+G nests the 2+ selection into a new
`ProjectGraph.compositions` entry + one compound clip; Shift+Ctrl+G un-nests (v1: untrimmed/unsped clips only).
Double-click a compound clip (or the timeline context menu) opens it via a "swap trick" — `graph.composition`
becomes the nested comp, the previous one stashes into `graph.compositions` under its own id, a breadcrumb bar
(`.timeline-nest-breadcrumb`) restores it — every existing composition read/write site in EditorPage keeps
working unmodified since they all target the same `graph.composition` slot. `getLayerMaxDuration` now clamps a
compound clip's trim to its nested sequence's length (`getNestedSourceDurationSeconds`), and trim now runs
through the source-aware `sourceInSeconds` branch (a compound clip has real "source" — the nest — unlike text/
shape). Playwright-verified live end to end: nest → "Nested 2 clips into…" toast → timeline collapses to one
clip → content renders correctly through the group composite → double-click → breadcrumb "My Orreris edit /
Nested Sequence" → back restores root.

**Canvas Frames v1**: deliberately NOT a new render-pipeline concept — a Frame is a compound clip
(`TimelineLayer.isFrame: true`) pre-seeded with a full-bleed background "shape" child, so resize/reposition
reuse the Transform/Fit panel and rounded clipping reuses the Masks panel, both already shipped. `createFrame`
in `nesting.ts` (empty frame via Ctrl/Cmd+Alt+F, or group 2+ selected layers via the timeline context menu
"Group into frame"). Playwright-verified: "Frame created" toast, new clip, background renders.

Gates: `pnpm -r typecheck` (web/shared/worker) clean, `editor:test` all green (added ~35 new checks: group-
filtered paste, non-source squeeze-trim, nest/un-nest/frame structural transforms), live Playwright pass against
the dev server (screenshots in session scratchpad, not committed).

### 2026-07-14 — Claude (Opus): "Page Unresponsive" mount stall — lazy effect-shader compile in SceneCompositor

Recurring ~1s main-thread freeze, identified by a NEW stall stack-sampler (perfDiagnostics.ts +
`Document-Policy: js-profiling` dev header in vite.config): sampled stacks during the freeze pointed
at `SceneCompositor` ctor → `linkProgram`/`compileShader`. The constructor synchronously linked all
7 shader programs inside a React mount effect; the driver's shader compile blocks the thread.

- **Fix (minimal, behavior-preserving)**: defer only the 5 EFFECT programs (plate/blur/glow/
  bloomBright/bloomAdd) — used only by blur/glow layers, which most comps lack. Present + the main
  composite program stay eager (needed on frame 1). Linked once via `ensureEffectPrograms()`, called
  from `effectTargets()` — the single guaranteed choke point (every effect-program use is preceded by
  effectTargets(), which allocates the RTTs those passes draw into). Fields kept byte-identical at
  the ~36 hot-path call sites (only `readonly`→`!`); dispose() guards the 5 deletes by a built-flag.
- **NOT touched**: shaders, uniforms, draw order, timeline/editor code — identical render output;
  only WHEN the effect programs link (lazy, once) changes. Web/worker/shared typecheck green.
- If a mount stall persists, the remaining eager main-composite compile is the suspect → escalate to
  KHR_parallel_shader_compile (bigger change, deferred). Re-check via the stall sampler (__rfStallStacks).

### 2026-07-14 — Claude (Fable): Asset cloud model rebuilt — "one asset, two locations" (fixes dup tiles + wrong-clip menu)

Audit of the 2026-07-13 cloud round found the upload flow fought the existing sync.ts design:
it created a SECOND asset (server id), remapped the timeline onto it (playback silently switched
from OPFS to network — local-first violation), then hid the local copy with heuristics that kept
both tiles whenever the local was still referenced → the reported duplicate. Rebuilt:

- **One asset, two locations**: "Upload to cloud" now only RECORDS the pairing
  (sync.ts `markLocalAssetPromoted` → localId→serverId + `cloudUrl` stamped on the local record via
  `updateLocalAssetRecord`). NO timeline remap, NO second tile, NO local deletion; playback stays
  on-device. Export needs zero changes — `ensureExportReady` already remaps ids from this registry
  and skips re-upload when `serverAssetId` is recorded.
- **listAssets merge is deterministic**: paired server assets are hidden behind their local tile
  (`getAssetPromotionMap`); a one-time ADOPTION pass pairs legacy pre-registry uploads by exact
  name+nonzero-size. Removed the referenced/twin hide heuristics (could orphan timeline media).
- **Remove from cloud**, synced-local case: delete server row + R2 object + clear pairing — bytes
  are already local, nothing to pull back. Pure server assets (stock/AI) keep the pull-back-first
  flow with the multi-project warning. `deleteAsset(localId)` also deletes the paired server copy.
- **Local id collision fix**: `asset_local_<ts>` → `asset_local_<ts>_<rand>`. Same-millisecond
  imports used to share an id — second OPFS put overwrote the first file's bytes (data loss) and
  id-keyed UI matched both tiles.
- **Asset context menu + topbar Theme menu**: PORTALED into `.editor-page` with fixed coords at
  the cursor/trigger rect (viewport-clamped) — the ThemedSelect pattern. Fixed-in-place alone was
  NOT enough: panel ancestors with transform/backdrop-filter hijack `position: fixed` (containing
  block), which is why the menu still landed on the wrong clip. Portal target is `.editor-page`
  (not body) so the [data-orreris-theme] accent variable scope is preserved; it carries no
  transform/filter in any state — keep it that way or portaled menus drift again.
- Synced tiles show a small cloud chip (`asset-chip-cloud`); localblob resolution falls back to
  `cloudUrl` when on-device bytes are missing. Web + api typecheck green.
- **/storage CORS fix (render-blocking)**: `/storage` is now mounted BEFORE the strict /api CORS
  gate with `Access-Control-Allow-Origin: *` (non-credentialed capability-URL media). The strict
  gate THROWS for unknown origins (500, no ACAO) and was killing every media fetch from the export
  worker's headless browser (Remotion bundle origin, e.g. localhost:3000) → render timeouts.
  Verified live: worker-origin fetch of a real upload returns 200 + ACAO *.
- **/storage read-through fallback**: with STORAGE_DRIVER=r2, a bucket miss now falls through
  (next()) to the on-disk express.static — media uploaded BEFORE the R2 flip exists only on local
  disk and was 404ing (black clips in older projects). Verified: pre-R2 file 200, missing file 404.
  Bin thumbnails also stopped passing empty-string srcs (`||` not `??`, guarded renders).
- **BACKGROUND SYNC NO LONGER UPLOADS MEDIA BYTES** (verified root cause via DB inspection, not
  the UI): sync.ts `doSyncProject` step 1 uploaded EVERY graph-referenced local asset's bytes on
  every background save/reconnect — merely editing while online shipped footage to the server
  (doctrine violation; the "it's in the cloud but I never opted in" report). Now gated behind
  `{ uploadAssets: true }`, passed ONLY by `ensureExportReady` (export = consent); matte blob
  resolution gated the same way. Background sync ships the project JSON only; un-uploaded local
  ids stay in the saved graph and the export gate's verify/retry closes the inflight-coalescing race.
- **"Missing video asset" fix**: listAssets must return paired server assets (graphs saved by the
  old remap flow / export promotion reference SERVER ids); hiding them at the data layer broke
  clip resolution. Dedupe moved to the DISPLAY layer (AssetBin filters via getAssetPromotionMap).
  "Remove from cloud" also heals legacy graphs (remaps serverId→localId) before deleting the copy.

### 2026-07-13 — Claude (Fable): Frozen ~1s clip tails — Float asset durations + proxy decodable-end clamp + duration heal

Root cause + 3-layer fix for "last one sec is frozen in all clips" (full analysis:
project-tracker/playback-preview.md v13). The ceil-to-Int `SourceAsset.durationSeconds` column made
every reloaded asset overshoot its decodable media by up to ~1s; clips authored to that length froze
on the final frame (getFrame clamps past the last sample — never null — so no existing guard fired),
and proxy builds baked the repeats in.

- **Root**: Prisma `SourceAsset.durationSeconds` Int → Float (migration
  `20260713180524_source_asset_duration_float`, applied); de-ceiled assets route, stock route, web
  `createAsset`, sync `serverCreateAsset`. ⚠ Prisma client regen still PENDING — `prisma generate`
  EPERM-locks against the running dev API; run `pnpm --filter @orreris/api prisma:generate`
  with `pnpm dev` stopped, or float writes will be rejected by the stale client at runtime.
- **Defense**: `FrameProvider.decodableEndSeconds` (demuxed sample-table end) + both proxy build
  loops (sourceProxy.worker.ts / sourceProxyEngine.ts) clamp their frame loop to it.
  `SOURCE_PROXY_VERSION` 4 → 5 (rebuild v4 proxies encoded without the clamp).
- **Heal**: proxy transcode reports the demuxed end; `healAssetDurationSeconds` (lib/api) PATCHes
  the asset downward-only (`PATCH /assets/:id` now accepts `durationSeconds`, server rejects
  growth) + updates the local record. Legacy Int rows heal progressively as proxies build.
- **Residual**: already-placed clips keep their ceiled length (auto-shortening placed clips would
  silently change timeline layout) — retrim or delete+re-add after the asset heals.
- **Verify**: typecheck 5/5; editor:test all pass; DB migration applied against the live Postgres.
- Note for the R2 round (Opus, below): local-first `localOnly` imports keep the REAL fractional
  duration in the local record — the heal's local-record update and the de-ceiled promotion path
  keep that exactness through later cloud promotion.

### 2026-07-13 — Claude (Opus): Local-first media + opt-in cloud (R2) — imports no longer auto-upload

Cloud-storage productionization. STORAGE_DRIVER=r2 (Cloudflare R2, S3-compatible) already wired; this
round makes upload local-first + opt-in and adds the direct-to-R2 fast path.

- **Imports are local-first**: `createAsset` (apps/web/src/lib/api.ts) gained `localOnly` →
  on-device persist only (OPFS, `asset_local_*`, `localblob:` marker), NO server round-trip.
  `handleUploadAsset` + package-import pass it. The old behavior auto-uploaded bytes to the server on
  every import when the API was reachable — that was the silent auto-sync (2–3GB footage included).
- **CRITICAL fix**: `listAssets` now MERGES local-only records into the online server list — without
  it, every un-pushed clip vanished from the bin on reload and its timeline layer lost media.
- **Opt-in upload**: per-asset "Upload to cloud" + Media-Pool-header "Sync N" chip (Pro-gated).
  Presigned direct-to-R2 via `upload.worker.ts` + `cloud-upload.ts` (browser→bucket, off main thread,
  no API RAM buffering). `POST /assets/presign` (assets.routes) mints the URL + creates the row.
  After upload: `finalizePromotedLocalAsset` marks promotion (sync.ts `markLocalAssetPromoted`) and,
  for project-owned assets, drops the local record+blob (`removeLocalAssetRecord`) — no bin dup.
- **Remove from cloud** (inverse): pulls bytes back local (localOnly re-import) → remaps graph →
  deletes server row + R2 object. Never deletes before the pull-back succeeds.
- **Per-user storage keys**: `uploads/u_<userId>/<ts>-<rand>-<name>` (storage.service `uploadKeyFor`);
  presign/saveUpload/saveBuffer thread userId. R2 needs a CORS PUT policy for the direct path
  (documented in .env.example).
- **Verify**: web + api typecheck green. R2 round-trip smoke test (`scripts/r2-smoke.ts`) passing.

### 2026-07-13 — Claude (Fable): Coherence follow-up — durable editor masks + resolver artifact threading

Completes the two remainders deferred from the coherence round below (tracker: ai-tools.md v2).

- **Editor one-click masks are now durable**: `useLayerToolEffectRunner` passes the graph's
  `editableFields` into `handler.run` (reuse lookup) and returns the handler's
  `describeEditableFields` patch through `onApplied`; EditorPage's new `applyToolEffectResult`
  merges patch + composition in ONE `updateGraph` (atomic, same pattern as
  `applySmartFollowTextResult`). EditorPage touch limited to the tool-modal callsite + this helper.
- **Dependency resolver threads artifacts**: `resolveModuleInsertions(existing, type,
  {editableFields})` — a durable existing mask/tracking path makes the auto-inserted PREREQUISITE
  land as `status: "ready"` with the artifact ref in config (`artifactSatisfiesModule`); the
  requested module always inserts idle; blob:/opfs: URIs never satisfy. Both `addEffect` call
  sites updated (web local fallback + API route). `mockProcessing` verified status-agnostic.
- **Verify**: 8 new editor:test checks; full 5-package typecheck green.

### 2026-07-13 — Claude (Fable): AI tools coherence round (mask reuse + matte export + ToolDetailPage migration)

Closed the three "AI tools coherence" tracker items. Zero EditorPage.tsx edits (transitions-round
agent active there); zero renderer/shader/manifest-schema changes (parity risk nil by construction).
Full detail: project-tracker/ai-tools.md v1; architecture.md "Tool surface unification" updated.

- **Cross-tool mask reuse** (`apps/web/src/tools/mask-resolver.ts`, new): producers
  (`local-segmentation`/`local-sam`/`local-tracking` + matte-store metadata) now stamp
  `sourceAssetId`; consumers (`runSegmentationMatte` = remove-background + text-behind-person,
  extract-person fast tier, smart-follow tracking) reuse a prior real mask/track via session index →
  `editableFields` → composition scan (durable http URIs only, AI-roto `_sam_` mattes excluded)
  before segmenting fresh. New "Subject mask: Reuse/Re-analyze" + "Tracking data" optionFields;
  reuse always announced in progress text. Dependency-resolver artifact threading deferred.
- **Matte export path closed**: the 5 silent `catch{keep blob:}` upload fallbacks route through one
  `uploadMatteForExport` helper (never throws, warns visibly). New pre-submit choke point
  `apps/web/src/export/matte-resolve.ts`: `doSyncProject` best-effort resolves blob:/opfs: matte
  URIs (bytes from live blob URL or OPFS — `artifact-store.get()` now has a `${id}.bin` filename
  fallback so OPFS survives reload despite its in-memory metadata Map) and `ensureExportReady`
  hard-gates with `MatteResolveError` naming the layer — the worker can no longer receive an
  unfetchable matte and hang silently. `renderPreview` deliberately ungated (API mock never fetches
  mattes). Stale "resolution step is not built yet" doc in `render-templates/src/index.ts` corrected.
- **ToolDetailPage → handler contract**: transcribe/extract run paths now call the registered
  handlers (option overrides model the fast→quality two-stage flow; shared `assertToolRunnable`
  executor gate; page `bakeMatte` deleted), and the extract/tbp/rbg apply switch collapsed into
  `handler.applyResult({context:"standalone"})` + `describeEditableFields`. Contract extensions all
  additive: `composition`/`editableFields`/optional `layer` in run args, `context` in apply args,
  `describeEditableFields`, hook `run(optionOverrides)`. Still bespoke: auto-captions apply, cloud
  transcribe, the `runToolAdapter` prompt-bridge shell (by design), the three standalone panels.
- **Verify**: full `pnpm typecheck`; `editor:test` incl. 21 new checks (resolver tiers,
  collect/rewrite, apply modes); matte end-to-end through the REAL Remotion renderer with an
  http-served matte (inverted-matte differential flips the frame 60%-light → 100%-dark — proves the
  worker fetched + multiplied the matte texture). Manual browser QA (reuse second-run instant path,
  offline warning, /tools flows) not run this session — listed for the next manual pass.

### 2026-07-13 — Claude: Monetization Phase 0 — Instrument & Shadow-Bill

Additive telemetry only, per MONETIZATION_STRATEGY.md §4 (editor free forever; charge only real
COGS later). Nothing gates, nothing blocks, `user.walletCredits` is never decremented — a reviewer
can confirm this from the diff.

- **`packages/shared/src/billing/pricing.ts`** (new): `BillableSurface`/`BillableUnit` vocabulary +
  `billableSurfaces` registry + `creditCost(action, units)`. Credits-per-unit reconciled from
  existing numbers (`model-registry.ts` model costs, `catalog.ts` `estimatedCostCredits`) — not
  invented. `// TODO(phase1)` markers left on both source files (not collapsed this phase, per
  "don't touch shipped code" directive). Exported from `packages/shared/src/index.ts`.
- **`apps/api/prisma/schema.prisma`**: `WalletTransaction` gains nullable `action`/`unit`/`units`/
  `provider`/`providerCost` + `shadow Boolean @default(true)` and a `[userId, createdAt]` index —
  additive columns, existing rows/migrations unaffected. Migration `phase0_usage_ledger` applied.
- **`apps/api/src/services/usageLedger.service.ts`** (new): `recordUsage()` writes
  `{ type: "usage", shadow: true }` rows; whole body try/caught (telemetry can never break a real
  user action); never touches `user.walletCredits`.
- **Three real hook points, all fire-and-forget (`void recordUsage(...)`)**:
  `generationRouter.service.ts` (fal generation, after the job completes — image units=1,
  video units=durationSeconds), `tools.routes.ts` `runAutoCaptionJob` (cloud Gemini transcription,
  units=minutes), `ai.routes.ts` (5 call sites: `/plan`, `/plan/fast`, `/ack`, `/plan/stream`,
  `/chat/stream`, units=1 per call). **Deviation from the original plan**: those AI routes are
  genuinely unauthenticated by design (guests can use the planner) — added a non-blocking
  `optionalUserId(req)` that decodes a bearer token if present and no-ops otherwise, so usage is
  attributed for signed-in users without adding `requireAuth` or changing any route's behavior.
- **`GET /api/payments/usage`** (new, `requireAuth`): recent `type:"usage"` rows (30-day window) +
  per-action aggregates + total shadow credits.
- **Web**: `fetchUsage()` + `UsageSummary` type (`lib/api.ts`); new `ShadowCostBadge` component
  (`components/ShadowCostBadge.tsx`) — "~N credits · free during beta", renders nothing for
  zero-cost/unknown actions — mounted next to the Generate button (`GenerateStudio.tsx`, skipped
  for local/free models) and the Cloud transcribe button (`ToolDetailPage.tsx`
  `AutoCaptionsPanel`). `CheckoutPage.tsx` + `AccountMenu.tsx` grew a read-only "usage this month
  (free during beta)" section from `fetchUsage()` — the real `walletCredits` display is untouched.
- Gates: `pnpm -r typecheck` clean (shared/api/web all 0 errors).
- Deferred (Phase 1, explicitly out of scope this round): real payments, credit
  enforcement/debits, BYOK settings UI, daily-allowance *blocking* (the `freeDailyAllowance` field
  is informational only), per-token LLM cost accuracy, collapsing `estimatedCostCredits`/
  `model.cost` into `creditCost()`.

### 2026-07-13 — Claude (Fable): Transitions round — fallback transform fix, junction params popover, drag-tile-to-cut, shared junction actions

- **DOM-fallback transition transform fix** (`TransitionLayer.tsx`, VideoPreview overlay wiring): with
  scene preview off (`?singleCtxPreview=0`), a scaled/positioned/rotated clip snapped at the transition
  window boundary — the two-texture mix only remapped object-fit. The overlay now pre-bakes each side
  through the clip's exact DOM CSS geometry (keyframe-aware, box-clipped) into a reused comp-sized 2D
  canvas and mixes with fit "fill" (same pre-baked-sides model as the scene path's P2a nest pre-compose;
  scene/export/Remotion were already correct and are untouched). Identity transforms skip the bake —
  byte-identical fast path. Stale transition-compositor.ts header fixed. Tracker: playback-preview v12.
- **Junction params popover** (`JunctionTransitionPopover.tsx` + TimelineStrip gesture): motionless
  click on the on-cut element opens schema-driven controls (duration + `getTransition(kind).params`,
  plugin transitions included, NO kind switch); drag still resizes (3px slop `moved` flag), double-click
  still removes (popover self-closes via composition-derived spec). Draft-local scrubbing, commit on
  release → one undo step, zero strip re-renders. New shared `resolveSpecParams` (composition-style.ts)
  keeps the legacy direction/mode/softness/color folding single-sourced.
- **Drag transition tile → cut** (TimelineStrip lanes + TransitionThumb `dragPayload`): lanes consume
  the previously-orphaned `application/x-orreris-transition` MIME; `getTrackCuts` derives ALL adjacent
  cuts; nearest-cut hit-test within a zoom-aware ~24px radius with a REF-GUARDED highlight (setState
  only on target change); drop applies with registry default duration, replaces occupied junctions,
  and passes plugin manifests through a new optional 4th arg on `handleAddCrossDissolve`.
- **Shared junction actions** (timeline-actions/actions/transition.ts): `applyJunctionTransition` /
  `removeJunctionTransition` / neighbor finders / `DEFAULT_CROSS_DISSOLVE_SECONDS` moved verbatim out
  of EditorPage; NEW registered actions `setJunctionTransition` + `removeJunctionTransition` (validated
  touching-pair, `runReplace`-wrapped) — junction edits are now AI/voice reachable. Tracker: timeline v3.
- Gates: typecheck 4/4, shared `actions:test`, web `editor:test` all pass. `render:compare:pixels`
  (chrome) 27/27 fixtures pass — `transition` 0.000% (identity fast path byte-identical), all others
  0.000% except grain/chroma-key at their standing 0.001%.

### 2026-07-13 — Claude (Fable): Effects completeness round — FAQ truth-up, keyframes travel with paste/presets, pro chroma/grain/vignette

Four-item round; every new param defaults to current-equivalent output (existing projects don't shift).

- **Brain FAQ was LYING about effect keyframes** (supersedes the "capability-gap" honest-limit FAQ
  described in earlier brain changelog entries): "keyframe the blur amount" returned "can't be
  keyframed yet" — but effect-param keyframes shipped and evaluate in all 3 renderers. The B5
  pre-check (`ai/brain/faq.ts`) now derives its answer from the registry's `keyframeable` flags:
  how-to (slider diamond, Shift+G graph editor) for keyframeable params, honest "static per clip"
  for audio dynamics/graph-param color effects. `brain:eval` assertions flipped + a new
  "keyframe the eq" static case. See project-tracker/editor-ui.md v2.
- **Keyframes travel with paste-attributes (⌃⌥C/⌃⌥V) AND effect presets**: `LayerAttributes.animations`
  (timeline-ops.ts) — effect-scope keys remapped to the fresh per-target effect ids at apply,
  `transform.*` layer keys clipboard-only (presets strip them with transform). Replace-per-scope
  semantics; mask/other-scope keys untouched; legacy v1 `keyframes` cleared when transform keys apply
  (they'd double-animate through the `getLayerAnimations` merge); old saved presets (no `animations`
  field) apply exactly as before. 9 new editor:test checks.
- **Chroma key → pro CbCr keyer; vignette + grain hardened** — all in the ONE shared
  `MEDIA_FRAGMENT_SHADER`: BT.709 chroma-plane distance (any key color, luminance-robust) + new
  `despill` (default 60 ≈ old fixed green desaturate) / `choke` / `matteView` params (matteView =
  first boolean registry param, renders as the existing checkbox control); vignette `feather` /
  `roundness` (aspect-corrected via new `u_aspect`) / `highlights` protection, defaults bit-equal to
  the old math; grain `size` (25–400%) + continuous seed (`mod(t, 61.7)` — old `fract(u_time)` reset
  the pattern every whole second). ACCEPTED DELTAS: grain pattern re-rolls once (statistically
  identical); existing chroma-key edges shift slightly (metric change, generally better). New pixel
  fixtures `vignette`/`grain`/`chroma-key` (keys the fixture ORANGE hill — proves non-green keying).
  See project-tracker/playback-preview.md v11.
- Gates: typecheck 5/5 · `brain:eval` all pass · `editor:test` all pass (incl. 9 new) ·
  `render:compare:pixels` (chrome) plain-image/blur 0.000% (no default drift) + vignette 0.000% /
  grain 0.001% / chroma-key 0.001% · `scene:compare` 4/4 under the global bar (no per-fixture
  override needed) · Remotion still verify: keyframed vignette/grain/chroma stills at t=0.2/3/6s
  animate correctly end-to-end.

### 2026-07-13 — Claude (Fable): Empty-track add no longer dirties every proxy + AI createTrack lands on top

- **Adding an empty track regenerated the whole timeline's proxies**: the span content signature
  hashed each layer's ABSOLUTE `trackIndex`; the "Add visual layer" button unshifts the new track at
  the top, shifting every index → every span flipped with zero pixel change. `spanContentSignature`
  (renderCache.ts) now hashes a DENSE RANK of the tracks present — relative draw order (what pixels
  actually depend on) still flips on a real reorder (existing check), but empty-track inserts are
  no-ops (new check: "inserting an empty track does NOT flip it"). One-time cost: all existing span
  signatures change once (rank vs absolute), so proxies regenerate once after this lands.
- **AI `createTrack` placed new tracks at the BOTTOM of the stack** (hidden under existing clips)
  while the editor button adds visual tracks on top. Default placement in the shared action
  (timeline-actions/actions/track.ts) now matches the button: visual types unshift to index 0
  (drawn on top), audio stays at the bottom; explicit `index` still honored. Gates: `actions:test`
  (undo/patch round-trips), `editor:test`, typecheck 5/5.

### 2026-07-13 — Claude (Fable): Timeline pro-density redesign + minimap + deep zoom-out

DaVinci-style visual compaction of `TimelineStrip.tsx` + `global.css` (perf architecture untouched —
all gesture/clock-tier code intact, changes are CSS + a few constants + one new imperative strip):

- **Flush rows**: `.timeline-tracks` gap 6px → 1px hairline; clips fill the row (1px inset, was
  2–5px). GESTURE-MATH SYNC: `rowPitchPx = trackHeight + 1` and `laneOffsetPx = 58/78/104/108`
  (label widths, `--timeline-label-gap` now 0) must track the CSS if either changes again.
- **Header rail**: no gutter (border-right divider), flat borderless track-control icons, solo "S"
  glyph pinned to the icons' 13px optical box (was riding ~1px high).
- **Flat clips**: solid muted fills (no 135° gradients), 3px corners, thin dark seam border, crisp
  1px selection halo (no shadow blob), 14px name bars, clip-kind chip only at L rows, video clips
  get a Resolve-style always-on top name scrim (hidden at XS/S), full-bleed waveforms.
- **Deep zoom-out**: wheel-zoom min 24 → 1 px/s (~2% like Premiere; readout used to floor at 43%);
  Fit floor 2 → 1 px/s.
- **Minimap** (new): thin 30px full-project strip, 4th grid row of `.timeline-editor`, sticky
  bottom+left; per-clip bars from composition (type hues / label colors), viewport window synced
  imperatively off dock scroll, playhead mirrored in the SAME zero-render clock paths as the main
  playhead (`minimapPlayheadRef` writes next to `playheadRef` writes — keep them paired). Grab
  anywhere to pan (centers view). Toolbar toggle (map icon, right group), persisted at
  `localStorage["orreris:timeline-minimap"]`.

Gates: web typecheck clean. Renderers untouched (no render:compare needed — zero manifest/draw changes).

**Follow-up same day — timeline tool audit (cut tools misbehaving, user report):**
- Split-at-playhead (S / scissors button) was a silent no-op with nothing selected — now falls back
  to splitting EVERY editable clip under the playhead (Premiere ⌘K semantics); selection still
  scopes it when present (`handleSplitAtPlayhead`, EditorPage).
- Blade clicks near clip edges trimmed instead of cutting: in blade/roll/slide modes the clip
  sub-controls (trim handles, fade buttons, volume-envelope cve-* hits, keyframe lane, transition
  glyphs) are now `pointer-events: none` via `.is-blade-tool`/`.is-roll-tool`/`.is-slide-tool`
  editor classes — the whole clip body is the tool's gesture surface. Also lets roll grab a
  junction that has a transition glyph straddling it (previously unreachable).
- Blade cut point is now frame-quantized (`snap(pointerSeconds, frameStepSeconds)`) like every
  other edit op.
- Tool cursors: blade = crosshair, roll = col-resize, slide = ew-resize.
- Roll/slide precondition feedback: failed starts (clips not touching) now toast via a new
  `onNotice` TimelineStrip prop wired to EditorPage's `setNotice` (was a silent return).

Gates: web typecheck clean, `editor:test` full suite green (roll/slide/split/ramp conventions all pass).

### 2026-07-13 — Claude (Fable): Vector graphics — missing from proxies/local export + ~2–10% of icons rastering invisible

User reports: (1) graphic layers invisible during proxy-span playback (visible only at "1"/proxy-off),
(2) ~10% of imported graphics never render on the preview canvas. Three root causes, all fixed:

- **Graphics missing from the worker pipelines** (the proxy symptom): every worker-side consumer keyed
  media off `layer.assetId` — vector graphic layers are self-contained (no SourceAsset), so span proxies
  AND the local WebCodecs export silently dropped them (Remotion was fixed earlier in b9f2360; these
  paths were missed the same way). Fix: new `graphicSourceKey(layerId)` (`source-decoder.ts`) +
  `buildSourceUrlMap`/`mediaSourceKey`/`hasActiveMediaAt` register a `graphic:<layerId>` image source
  from `graphicToDataUrl` (export-core.ts); `SceneFrameCompositor.gradeMediaLayer` resolves it
  (scene-frame-compositor.ts); `viewerProxyCapture` synthesizes the same data URL instead of throwing
  "no source url". Span signatures already hash the full layer (incl. `graphic`) → recolors invalidate.
- **SMIL `fill="freeze"` read as a paint color** (`extractSvgPalette`, shared layer-graphic.ts): the
  palette scan matched `fill=` on `<animate>` tags, so animated icons imported with `color="freeze"`
  and their animation keywords rewritten to `currentColor`. Fix: palette scan strips SMIL elements
  first + excludes non-paint keywords (freeze/remove/inherit/initial/unset/revert); same keywords
  rejected in `sanitizeGraphicFill` (heals stored `fill:"freeze"` graphics to the default fill).
- **Animated icon packs raster invisible** (line-md etc.): their base state is hidden
  (`fill-opacity="0"`, dash-hidden strokes) and only the SMIL animation draws them in — a static
  `<img>`/texture raster paints ZERO pixels. Fix: new `settleSvgAnimations()` (shared) bakes each
  `<animate>`/`<set>`'s final value onto its parent and strips all animation elements; applied at
  import (`normalizeGraphicSvg`) AND at bake (`graphicToDataUrl`) so previously imported animated
  graphics heal without re-import.
- **Evidence**: headless Chrome probe over 256 real Iconify icons (8 queries, mixed packs) through the
  real import pipeline — before: 6/256 invisible (all line-md); after: 256/256 decode + paint. Gates:
  typecheck 5/5, editor:test, `render:compare:pixels` 24/24 @ 0.000%, `scene:compare` 22/22.
- Also: stock result cards no longer render `<img src="">`/`poster=""` when a provider returns an
  empty thumbnail URL (the console's "empty string passed to src" warning; an empty src re-requests
  the page). Not-a-bug: `hvc1` (HEVC) sources correctly fall back to the native `<video>` decoder
  (the BoxParser size warnings come from mp4box probing those files).

### 2026-07-12 — Claude (Fable): Editor performance round — per-frame CPU/GC churn removal (zero-behavior-change)

Five independently gated phases from a full-codebase perf audit. Every change is designed to be
bit-identical in output; gates re-run per phase: typecheck 5/5, `animation:test`, `governor:test`,
`editor:test`, `render:compare:pixels` 24/24 @ 0.000% (×3 runs), `scene:compare` 22/22.

- **`animation.ts` fast paths** (shared): `getLayerAnimations` returns `layer.animations` by
  reference when no legacy keyframes (callers verified read-only); per-property sorted keyframe
  lists cached in a WeakMap keyed on the animations ARRAY identity (same filter order + same
  stable-sort comparator → tie order preserved); `evaluateTimelineTransform` stops re-filter+
  sorting 9× per layer per frame; `evaluateSpatialPosition` x/y pairing is now binary-search
  (was O(n²) find-per-key). Public `evaluateAnimatedValue` semantics untouched (delegates to the
  extracted `evaluateSortedKeyframes`).
- **ColorPipeline memoized** (`getCompositionColorPipeline`, composition-style.ts): WeakMap keyed
  on the `effects` array reference + guards (animations ref, colorSettings ref); layers with ANY
  effect-scope keyframe only cache-hit on the exact same resolved layer time (keyframed grades
  recompile per frame exactly as before — no quantization). Unchanged grades now return the SAME
  object every frame → downstream identity memos work. New `colorPipelineCacheKey(pipeline)`
  (pipeline.ts, WeakMap-memoized `JSON.stringify`) replaced the per-frame stringify at ALL
  change-detection sites: build-scene-draws, ScenePreviewCanvas, scene-frame-compositor (×3),
  SceneStage (Remotion), viewerProxyCapture, WebglMediaLayer (incl. single-ctx snapshot key),
  WebglVideoOverlay, WebglColorView. Key values are byte-identical to the old stringify.
- **WebCodecs decoder cursors** (`webcodecs-decoder.ts`): `chunkIndexForMicros` keeps a forward
  cursor (monotonic playback/export now amortized O(1); backward seek = full rescan, same result;
  scan stays linear because cts order isn't sorted under B-frames); `keyAtOrBefore` is a binary
  search over the ascending `keyIndices` (preserves the before-first-key → `keyIndices[0]` clamp).
  Was O(n²) across long clips for export AND WC preview.
- **React UI**: `VideoPreview` video branch no longer computes `getCompositionMediaStyle` twice
  per tick (dead `baseStyle` in the WebGL branch — moved below it); `AgentTranscript` + `AiChatPanel`
  are `memo`'d and EditorPage now feeds the panel identity-stable props via a `useStableHandlers`
  block (`aiPanelHandlers`, + `aiAssetUrlById` Map for O(1) `resolveAssetUrl`) — typing in the AI
  composer no longer re-maps the transcript per keystroke, and EditorPage edits no longer re-render
  the panel. Timeline `Waveform` draws to ONE dpr-scaled `<canvas>` (same bar geometry/colors)
  instead of up to 2000 SVG `<rect>`s per audio clip (`.clip-waveform canvas` CSS added).
  Composer input-state extraction deliberately deferred (entangled with voice/dictation).
- **Small wins**: `build-scene-draws` skips the nesting bookkeeping (incl. the O(layers)
  `layerIndex` fill) when there are no nested groups; ScenePreviewCanvas allocates the alias-walk
  Set only when an alias chain exists; `sourceProxyStore` loads index.json ONCE per session
  (in-memory records + write-through, was full read+parse per asset); `local-tracking` transfers a
  COPY of the per-frame grayscale to the worker (transfer list; original kept intact for the
  inline fallback).
- **Deferred (not in this pass)**: EditorPage→zustand store migration; asset-bin/chat virtualization;
  composer state extraction; `getCompositionMediaEffects` memoization (embeds timeSeconds by design);
  segmentation/tracking loops → worker; unifying the two `@huggingface/transformers` copies
  (CDN 3.7.2 in local-transcription/local-sam vs npm 3.8.1 in asr/tts workers).

### 2026-07-12 — Claude (Fable): Rotated phone footage in export + Typewriter card in Effects subtab

- **Mobile footage exported tilted 90°** (user report with screenshot): the WebCodecs export
  decoder (`webcodecs-decoder.ts`) served CODED-orientation frames — it never read the container's
  `tkhd` display-rotation matrix, unlike the `<video>` fallback which the browser auto-rotates
  (editor preview looked fine for the same reason). Fix inside the provider so every consumer
  (export compositor, preview frame pool, ingest-proxy transcode — rotated proxies were silently
  tilted too) is corrected at once: `demuxIndex` captures `rotationFromMatrix(tkhd.matrix)`
  (helper now exported from `source-color.ts`), and `createWebCodecsVideoSource` bakes the
  quarter-turn via a reused OffscreenCanvas + reports swapped display dims. rotation 0 (common
  case) keeps the untouched raw-VideoFrame path. GATE: scratchpad `rot/rotation-parity.mjs` —
  ffmpeg-static synthesizes `-display_rotation 90/270` files, real Chromium compares provider
  output pixel-by-pixel against a same-origin `<video>` element (ground truth): 6/6 pass
  (dims + <2% pixel diff; fixtures grayscale because BT.601/709 ambiguity on saturated bars is
  ~33% RGB diff regardless of rotation).
- **Typewriter now surfaces in the Effects subtab** (user request): the preset lives as
  `textRevealProgress` keyframes in `layer.animations`, not `layer.effects`, so the effect list
  never showed it. New `TypewriterEffectCard` (EditorPage) renders in the Effects subtab when
  reveal keys exist — "Reveal duration (s)" speed control (proportional key rescale), delete
  button (strips the reveal keys), graph-editor hint; section count includes it. The duplicate
  control was REMOVED from TransformPanel's Animation Presets section (moved, not copied).

### 2026-07-12 — Claude (Fable): Rich text round — per-run editor, highlights, source-text keyframes, typewriter speed

- **Rich text Content editor** replaces the plain textarea (`RichTextEditor.tsx` +
  `rich-text-serialize.ts`): contentEditable + execCommand (Chromium-only product) authoring the
  ALREADY-SHIPPED `TextRun[]` model — per-run bold/italic/color/highlight/font/size render in all
  three renderers via `getCompositionTextRunStyle`, so the feature is render-parity-free. DOM↔runs
  round-trip is covered by a real-Chromium test (11 checks incl. execCommand bold/hiliteColor,
  Chromium-shaped HTML, font-family quote normalization); paste is plain-text-only (style
  smuggling); unstyled results collapse back to `text`-only. Toolbar font picker is ThemedSelect
  (custom dropdown, user call); a saved selection Range survives portal-menu focus steals.
- **Per-run HIGHLIGHT** (user call): new `TextRun.backgroundColor` — DOM/Remotion get it via the
  run style; the GPU raster paints marker boxes behind words (ascent..descent, spaces bridged
  between same-highlight words) in `text-shape.ts`.
- **SOURCE TEXT keyframes** (Premiere-style, user call): `TimelineLayer.sourceTextKeyframes`
  (hold; `SourceTextKeyframe {id,timeSeconds,runs}`) resolved centrally in `getVisibleTextRuns`
  → every renderer follows; passed through the render manifest. Content field gets the standard
  KeyframeButtons (diamond captures the current text; arrows hop keys); the editor edits the
  GOVERNING key while scrubbing. Manual typewriter/word-reveals = keyframe progressively longer
  text.
- **Graph editor lanes** (user call): new GraphTarget kinds — `sourceText` (flat HOLD lane: move
  in time, add via click-on-lane capturing governing text, delete; interpolation/handles/value
  drags are no-ops) and generic `layer` (numeric layer-scope tracks; first user: "Typewriter
  reveal" = `textRevealProgress`). Clipboard paste skips sourceText (non-numeric).
- **Typewriter speed** (user call): "Reveal duration (s)" NumberControl in Animation Presets
  (TransformPanel) — proportionally rescales the reveal keys; same keys editable in the graph.
- **Speed ramp keyframe buttons** (user call): standard diamond/nav/clear cluster on the Speed
  section head, writing `speedKeyframes` ramp points at the playhead.
- **BUG (user report): mixed-size text clipped in the viewer** — the raster's box math used ONE
  base-font line height for every line; CSS grows a line box to its largest span. Latent until
  the rich editor made mixed `fontSizeMultiplier` lines authorable. `measureTextLayout` now
  computes per-line heights (`lineHeight × max(base, largest word size)`), and the draw pass
  stacks lines by those heights.
- Raster cache key now includes ALL run fields (bold/italic/highlight/font were missing — an
  edit/keyframe crossing wouldn't re-raster) — `scene-text-raster.ts`.
- Keyframe nav is always-visible on rows outside the slider grid (Content field, Speed ramp head).
- Gates: shared build ✓, full typecheck ✓, Chromium round-trip 11/11 ✓, scene:compare run.

### 2026-07-12 — Claude (Fable): Essential Graphics round — Graphics inspector sub-tab + graphics bug fixes

- **BUG: masks "literally off" on graphic clips** — the SceneCompositor samples clip-mask mattes
  at `gl_FragCoord` (comp-fixed) but the mask editor, DOM path, and Remotion all ride the LAYER
  transform for media masks. Fixed the one outlier: `SceneMaskMatteCache.get` now takes the
  layer's resolved transform (media/clone/effect masks in `build-scene-draws.ts` pass it;
  text/shape stay comp-fixed by design), applied outermost around the mask's own transform,
  feather scaled to match the DOM path, keyed for keyframed moves (`scene-mask-matte.ts`).
- **BUG: graphics slow/never loading** — the still-image texture path awaited the idle-gated
  still-proxy chain (600ms of no playback/gesture, serialized) before decoding; pure loss for
  data-URL graphics (proxy always null). data: URLs now decode immediately; `img.decode()`
  failure gets one retry + a console.warn instead of silently staying blank forever
  (`WebglMediaLayer.tsx`). Duplicate aspect-measure decode skipped for graphics (viewBox naturals).
- **BUG: Search-tab vectors "not editable"** — two causes: (1) Iconify picks passed no
  `sourceColor`, so multicolor icons never got `currentColor` mapping → Fill was a visual no-op;
  (2) the registered GraphicPanel (id "graphic") was in NO panelIds array since the tab refactor —
  the Fill control rendered nowhere. Import now runs `extractSvgPalette` (new, shared): one baked
  color → normalized like the bundled pack; several → stored as `LayerGraphic.palette` slots,
  substituted at `graphicToDataUrl` bake (single combined pass, boundary-guarded) so every
  renderer recolors identically. GraphicPanel rehomed (see below) with per-slot color rows.
- **Graphics inspector sub-tab** (right of Effects, all visual layer types — Premiere v25's
  Properties-panel model): `GraphicsStackPanel` (draw-ordered stack of text/shape/graphic layers:
  select, eye = `layer.muted` (already hides in both renderers), rename) + `GraphicsAlignPanel`
  (6 align-to-frame buttons on the PAINTED content box, writes via `applyTransformValueAtTime` so
  auto-keyframe rules hold) + the rehomed GraphicPanel with palette editing and "Save graphic".
- **Round-trip**: `graphic-presets.ts` (localStorage, mirrors effect-presets) + Saved tiles and an
  "Import SVG" tile in the Graphics chip (external .svg files → the same normalize/palette path,
  fully editable). Deferred: selection-scoped save-as-template (topbar Save-as-template + slot
  marking already cover it); drag-reorder in the stack panel; keyframeable graphic colors (data-URL
  re-bake would thrash the texture cache — needs a shader tint path).
- Shift+M default mask now hugs a `contain` layer's content rect (`containContentRect`, shared).
- Gates: shared build ✓, full `pnpm typecheck` ✓, `scene:compare` (mask parity) 22/22 ✓.
- **Follow-up fixes (same day, user report)**:
  - *Italic ROOT CAUSE (second pass — first fix was necessary but downstream)*:
    `getCompositionTextRunStyle` forced `fontStyle: run.italic ? "italic" : "normal"`, silently
    DISCARDING the layer-level Italic toggle in every renderer (plain text = one flagless run;
    fontWeight on the adjacent line correctly fell back to base). Now falls back to
    `baseStyle.fontStyle` like fontWeight. Verified: layer.italic survives run resolution.
  - *Italic did nothing on Impact & other italic-less fonts*: canvas2D never synthesizes italic
    (silently falls back to the upright face) while the DOM/Remotion path oblique-slants via CSS
    `font-synthesis`. `text-shape.ts` now detects a missing italic face (italic vs upright probe
    metrics identical — advance width AND glyph ink bounds, so a real italic monospace face is
    never double-slanted) and skews the glyph draw ~tan(14°) about the word baseline. Cached per
    font string.
  - *Position X/Y rows had no keyframe navigation*: the grouped-row CSS suppressed prev/next/clear
    entirely (hover-reveal used to grow the row). Prev/next are now ALWAYS visible at fixed 14px in
    groups (zero layout shift; fields already flex-wrap), clear stays graph-only.
  - *Graph editor X/Y*: the mutation pipeline (bezier convert, handle write, curve-click add) was
    empirically verified working for transform.position.x/y in BOTH storage forms (V2 animations
    and legacy `layer.keyframes` — by-id migration on write). No code defect found; awaiting a
    precise repro if the user still hits it in the UI.
  - *Color controls truncated ("#F…") + swatches wrapping to 2 lines*: auto-fill grids pack cells
    to the 88px minimum regardless of panel width; `.color-control` now spans 2 grid cells in
    `.graphic-controls`/`.control-grid` — full hex + one swatch row.
  - *TEXT STYLE KEYFRAMING (new)*: font size, letter spacing, line height, text box width, stroke
    width, background padding/corner radius, shadow blur/X/Y are now keyframeable. One shared
    evaluation point — `animStyleNumber` in `getCompositionTextStyle` (composition-style.ts),
    tracks are V2 animations `{scope:"layer", property:"style.<field>"}` — so DOM preview, GPU
    scene raster (cache re-keys off the evaluated style), and Remotion animate identically.
    Panel side: `getStyleKeyframes`/`toggleStyleKeyframe`/`applyStyleValueAtTime` (four-way
    auto-keyframe rule; static branch writes the flat layer field) in keyframeUtils +
    `makeStyleKeyframeTools` wiring KeyframeButtons onto the text rows (EditorPage). Background
    OPACITY not keyframeable (baked into the rgba string); shape-layer style rows + graph-editor
    lanes for style tracks deferred.
  - *`subscribeGraphicPresets is not defined` + unclickable clip middles*: stale Vite HMR state
    (EditorPage too large to hot-swap); production build compiles clean — hard reload clears it.
  - *On-clip keyframe lane retired*: the diamond "KF" lane on selected timeline clips is hidden
    (`.clip-keyframe-lane { display:none }`) — the graph editor drawer is the dedicated keyframe
    surface; markup/drag machinery left intact behind the CSS for easy revival.
  - *Motion-path dots in the viewer were distracting*: `.preview-motion-path` is now hidden by
    default and shown only while the graph editor drawer is open
    (`.editor-page:has(.graph-workspace)` — CSS-only, Chromium `:has()`, zero React/perf-path
    changes; spatial handles stay fully functional in the motion-editing context).

### 2026-07-12 — Claude (Fable): Voice round 9 — self-echo loop killed (one command executed ×3) + reorderTrack

- **Root cause (real transcript)**: "move clip 1 to V3" ran three times because the assistant
  transcribed its OWN TTS as new commands. Chain: (1) the final batch carried both an `answer`
  step and `finalSummary` → `AgentLoop` spoke twice; (2) `speakReply` cancels the previous
  speech, and the cancelled speak's `.finally` cleared the boolean `speaking` flag while the
  newer speech was still playing; (3) the mic re-armed 140ms later mid-audio and heard "Moved
  clip 1 onto V3." as "Move to clip 1 onto V3." → auto-submit → repeat.
- **Fixes**: speak hold is now a COUNTER (`speakDepthRef` — drops only when every pending speak
  settled; talk-mode stream included); hard speaker/mic mutual exclusion in `speakIfVoice`
  (open idle mic is cancelled before speaking; if the user already started talking, the speak
  is dropped — user wins the channel); `AgentLoop` no longer re-announces `finalSummary` when
  the batch had an answer step; NEW `ai/echo-guard.ts` `looksLikeSelfEcho()` (token-set Dice ≥
  0.8, -ed tolerant, ≥3 tokens, 6s window) discards voice transcripts matching
  `recentlySpokenLines()` (new tts.ts ring buffer, recorded at push time) before auto-submit —
  6 new eval checks incl. the real corpus pair. History summary turns now read "…the requested
  edit is complete." (weak models burned 30–50s deliberating whether a repeated-looking
  request was already done).
- **NEW `reorderTrack` action** ("move layer V3 to top" was impossible — the model rightly
  refused): `{trackId, toIndex | position: top|bottom}` in shared track actions; verified both
  renderers draw `tracks[0]` ON TOP (preview sorts descending trackIndex; manifest
  `zIndex = visualTracks.length - trackIndex`); slice header + DISAMBIGUATION note route
  whole-track moves to it (clip-named moves stay on moveLayer); registry test covers
  top/toIndex/rejections/undo round-trip.
- Gates: shared typecheck-build + `actions:test` all green, `pnpm typecheck` all packages,
  `brain:eval` all checks passed.

### 2026-07-12 — Claude (Fable): Dense tabbed inspector + dedicated graph editor (bottom workspace)

- **Inspector density (Phase 1)**: new `PropertyRow`/`PropertyRowGroup` primitives
  (`editor/inspector/controls/PropertyRow.tsx`) — NumberControl + EffectSliderControl now render
  through ONE row shell; select/toggle effect params flattened from 38px stacks to the same
  label-left 24px row grid; new `--insp-*` density tokens; Position X/Y and Tilt X/Y merged into
  single multi-value rows; inspector triple header stack (h2 + chip + subtitle + TemplateSlot)
  collapsed to one chip-titled header, TemplateSlotControl moved below the properties.
- **Inspector structure (Phase 2)**: Resolve-style top-level tabs (Video/Text/Shape | Audio |
  Effects | Color) via `editor/inspector/InspectorTabs.tsx`, remembered per layer type; flat 22px
  uppercase section headers (CSS-scoped to `.editor-inspector`); registry gained a `group` field.
  **Color grading is now reachable from the right inspector** (Color tab hosts `LumetriPanel`;
  the left panel Color tab still works — same component, two mounts).
- **Graph editor (Phase 4/5)**: new `editor/graph/` — `BottomWorkspace.tsx` (tabbed drawer under
  the timeline: Graph | Audio | Scopes | Metadata; Shift+G; height-resizable, persisted, snap
  200/300/450), `GraphEditor.tsx` (canvas-based multi-curve editor: property tree, marquee +
  multi-kf drag, bezier handle editing w/ Alt-split, cursor-anchored wheel zoom, pan, F fit,
  frame/keyframe/playhead snapping, per-selection interpolation, easing preset bar, Ctrl+C/V
  keyframe clipboard, arrow nudge, ruler seek, imperative playhead via `subscribePlaybackClock`),
  plus pure `graph-view.ts`/`graph-scene.ts` (samples through the SHARED evaluator) and
  `useDraftLayer.ts` (one gesture = one undo snapshot). `packages/shared/animation.ts` gained
  ADDITIVE `computeAutoTangents`/`easyEaseHandles` (evaluator behavior unchanged;
  `render:compare` passed). The old 320px SVG `TransformGraphEditor` in TransformPanel was
  REMOVED — replaced by an "Open Graph Editor" button (dispatches `orreris:open-graph-editor`,
  optional `detail.targetKey` focuses a property).
- **Timeline lane (Phase 6)**: `clip-keyframe-lane` now also shows effect + content keyframes
  (color-coded); **double-click a lane marker now OPENS the graph editor focused on that property**
  (was: delete — deleting stays on the lane trash button / Delete key / inspector diamonds).
- Deferred (follow-ups): EffectsPanel extraction out of EditorPage (3a), velocity/speed graph
  mode, mask/speed/audio keyframes in the graph tree, real Audio/Scopes workspace tabs.
- Same-day fixes (user report + screenshots): inspector **Color tab REMOVED** (three color
  surfaces was two too many — the left Color panel stays the one color surface; tabs are now
  Video/Text/Shape | Audio | Effects); timeline layout regression fixed — `.timeline-stack`
  (the new wrapper for dock row + drawer) is the grid item, so the expanded/tablet/phone
  grid-placement rules were migrated from `.timeline-dock-row` to `.timeline-stack`.
- Same-day round 2 (user testing): **canvas ↔ background differentiation** (lighter vignette
  matte on `.editor-viewer .preview-viewport` + 1px ring on `.phone-frame`; media was always
  clipped by `.preview-comp-clip` — the boundary was just invisible on black); drawer got the
  standard pane-resizer pill affordance; Position/Tilt group rows widened (X/Y values clipped
  at 256px); graph editor hover cursor = grab over keys (no crosshair); **bezier handle model
  fixed**: (1) `animation.ts` segment easing now honors the incoming key's `in` handle even
  when the outgoing key isn't bezier (was: left segment ignored the handle; linear surrogate
  `{dx:.33,dy:.33}` for the non-bezier end — `animation:test` + `render:compare` green),
  (2) grabbing a handle on any selected key converts it to bezier with SEEDED linear handles
  (evaluator default dy:0 made the curve jump), (3) linked mirroring is now slope-preserving
  in display space (negating `{dx,dy}` fractions across segments with different value deltas
  produced a cusp at value peaks), (4) Alt-drag permanently splits handles (linked:false).
- Round 4: **two-sided interpolation (Premiere/AE semantics)** in `animation.ts` — a segment
  now combines the outgoing key's LEAVE behavior (bezier out-handle / easeOut→flat) with the
  incoming key's ARRIVE behavior (bezier in-handle / easeIn→flat); previously only
  `previous.interpolation` shaped the segment, so "Ease In" eased the wrong side. `easeProgress`
  cubic removed — every non-hold segment is one bezier (linear = fast path). The evaluator
  CONTRACT TEST was updated to the new semantics (easeIn asserts arrival-side, easeOut
  departure-side). Also: graph curve sampling now scales with plot pixel width (~2px/sample,
  was fixed 160 → faceted when zoomed); single click ON the curve line adds a keyframe
  (crosshair over line, grab over keys, arrow elsewhere); per-property reset button in the
  graph tree clears every keyframe of that property.
- Round 5: viewer toggles (auto-key diamond + graph) resized to the flat 28×20 transport
  footprint; **keyframed clips are draggable in the viewer again** — `handlePreviewMoveLayer`
  wrote the base `transform.position` which the animation overrode (drag looked dead); it now
  routes both axes through `applyTransformValueAtTime` like scale/rotate already did, so a
  drag on an animated clip drops/updates a position keyframe at the playhead.
- Round 3: graph plot cursor = crosshair with grab ONLY over keys/handles; Position/Tilt
  group rows reworked — prev/next/clear are display:none in groups (their hover-reveal grew
  the row and made the X/Y fields overlap), each axis got its own always-reserved 15px reset
  (X→50 / Y→type default, Tilt→0) replacing the group-level reset.

### 2026-07-12 — Claude (Fable): Voice round 8 — prompt-specific acks, track targeting, hear-check reflex

- **Progressive ack, done right** (user feedback: a canned phrase is NOT an acknowledgment):
  NEW `/ai/ack` endpoint (fast pool, `ACK_SYSTEM_PROMPT` in shared — one ≤12-word line naming
  THIS request's subject; payload-free by contract: prompt only, no slice/capabilities/history,
  per-prompt cached, not rate-bucket-counted) + web `ai/ack.ts` `requestSpokenAck()`. The
  agentic path fires it in PARALLEL with the planner and speaks it only while still planning
  (never over a clarify/answer; voice sessions only). Canned `THINKING_ACKS` removed; talk mode
  relies on its own live first sentence.
- **Track targeting fixed** (real transcript: "put clip 1 in video layer 3" → three failed
  moveLayer attempts with invented ids): the planner slice header now lists the TRACK INVENTORY
  (`V1=<id> (video), A1=<id> (audio)…` + guidance); `createTrack`'s result message includes the
  new track's id (the loop's next step needs it); `assertTrackExists` failures enumerate the
  real ids; registry `validation_failed` messages now EMBED the issue texts (result lines only
  surface `message` — the model was repairing blind).
- **Hear-check reflex** — "are you listening (to me)" / "can you hear me" (+ the observed
  mishearing "you're listening to me") answer instantly from tier-0 FAQ (varied lines) instead
  of a 4–15s LLM round-trip; gated so "listening to the audio track" still escalates. NOTE
  learned: the router's `normalize()` strips leading "can you/could you/please" — FAQ patterns
  must match the STRIPPED form. 7 new eval checks.

### 2026-07-12 — Claude (Fable): Voice on/off loop ROOT-CAUSED (two-way binding ping-pong) + Ollama 403 surfaced

- **The recurring voice-session on/off loop is dead.** Root cause (from a Maximum-update-depth
  stack): `voiceDesired` was a two-way-bound boolean — the panel mirrored real session state up
  (`onVoiceSessionChange` → EditorPage `setAiVoiceWanted(active)`), and the panel's sync effect
  converged the session to the prop. The two sides ran half a render out of phase, each
  "correcting" to the other's stale value → infinite enter/exit. Edge-triggering (round 6.2's
  guard) couldn't fix a bidirectional convergence. FIX: the Alt+L intent now travels as a
  monotonic **`voiceToggleToken`** COMMAND (micToggleToken house pattern) — panel toggles once
  per token (`handledVoiceTokenRef`), owns the session, and the report-back is one-way (can't
  re-command). `aiVoiceWanted` is now just the mount hint (set true on Alt+L, follows reports).
  RULE for future host↔panel state: reports must never round-trip into commands.
- **Ollama CORS 403 surfaced to the user** — Ollama rejects browser calls unless
  `OLLAMA_ORIGINS` allows the origin; Local mode silently fell back to the cloud and looked
  broken. `ollama.ts` now recognizes the 403: one actionable console warning +
  `onOllamaCorsBlocked()` (replays if already fired) → AiChatPanel pushes ONE visible warn
  notice with the fix (`setx OLLAMA_ORIGINS "*"` + restart Ollama). Fallback unchanged.

### 2026-07-12 — Claude (Fable): Voice round 7.3 — progressive-response acks ("heard you, thinking…")

- The Claude/Alexa progressive-response pattern: the instant an LLM run starts, the assistant
  SAYS a short varied ack, then thinks. `THINKING_ACKS` (tts.ts, 5 variants) are pre-generated
  into the ack cache at ready → zero-wait playback. Agentic runs: `speakIfVoice(randomThinkingAck())`
  right after `setPhase("planning")` (brain-instant paths return earlier and never ack; clarify
  ANSWERS resolve via `pendingInputRef` before the branch and never ack). Talk mode (voice):
  the ack is pushed as the live speech stream's FIRST sentence, speaking while the model
  streams. Voice-session only; typed chat unchanged (the dot-wave/thinking log already covers
  visual feedback).

### 2026-07-12 — Claude (Fable): Voice round 7.2 — truthful "listening" + ready earcon (first words eaten)

- Real report: in voice mode the first words of an utterance were lost ("hey do you listen to
  me" heard as "you listen to me"). Root cause: Chrome's recognizer drops audio during its
  ~300–800ms service handshake after `start()`, while our pill claimed "Listening" instantly.
- `useDictation` gained `capturing` (from `recognition.onaudiostart`, safety-set on first
  result; recorder path sets it immediately; reset on start/end/teardown). The aurora shows
  "Starting the mic…" until capture is REAL, and `playReadyBlip()` (tts.ts, WebAudio
  osc 880→1318Hz, ~120ms, quiet) marks the actual talk-now moment in voice sessions — the
  standard VUI earcon pattern. Next architectural step if gaps still annoy: ONE persistent
  session recognizer (open ear) with echo filtering, replacing per-turn start/stop.

### 2026-07-12 — Claude (Fable): Voice round 7.1 — "System voice" opt-out in the picker

- Assistant-voice picker gained a third radio: **"System voice — instant, no download"**
  (`AssistantVoiceChoice = NaturalVoiceId | "system"`, same `orreris.voice.tts.voice.v1` key).
  When chosen: `warmNaturalVoice()` is a no-op (Kokoro never downloads/runs), speech + the ack
  cache route to the system engine, and the ⚙ status line reads "off — you chose the system
  voice" (no Retry). `kokoroVoice` keeps the last natural pick so the gender-matched system
  fallback keeps the chosen gender; picking a natural voice again re-warms download + acks.

### 2026-07-12 — Claude (Fable): Voice round 7 — spoken-conversation register (natural talking)

- **VOICE_MODE_NOTE** (shared `ai-prompts.ts`, VUI practice: brevity, easy-breezy reprompts,
  phrase variation, no formal echo): appended to BOTH the planner and consultant user turns
  when the request came from a live voice session. Rules: 1–2 spoken sentences, no
  lists/markdown/example menus, vary phrasing (never repeat a canned line), never "It seems
  like you want to…", garbled ASR → just ask to say it again.
- Plumbing: `PlannerContext.voiceMode` (web `types.ts`, set in AiChatPanel `buildContext` from
  `voiceSessionRef`) → LlmPlanner cloud payload + local builder; talk.ts both paths;
  `voiceMode: z.boolean().optional()` in api plan/chat schemas; server plan-cache key includes
  voice|typed (a voice-register reply must not be served to a typed chat).
- Wake ack varies ("Yes?"/"I'm listening."/"Go ahead." — all pre-generated in the ack cache);
  the deterministic fallback line shortened to a conversational reprompt (was a 4-example menu
  that sounded maximally robotic read aloud).

### 2026-07-12 — Claude (Fable): Voice round 6.2 — conversation timing + barge-in

- **Two-phase silence budget** (`useDictation` gained `initialSilenceTimeoutMs`; heard-speech
  flag picks the budget): voice sessions get ~7s of thinking time BEFORE the first word, then
  a 2.6s pause submits (the 1.6s from round 6.1 cut users off — real feedback). Typed
  dictation keeps the 3.5s default. Approvals still fire instantly via the interim
  fast-accept ("yes"/"no"/"cancel"/"stop" as a lone interim submits immediately — Web Speech
  often never finalizes single words).
- **Barge-in v1 (interrupt words)** — while `speaking && voiceSession`, a dedicated standby
  recognizer listens; a short utterance starting with stop/wait/quiet/enough/shut up/hey
  orreris calls `stopSpeaking()` → speech halts, the fast re-arm (140ms post-TTS) opens the mic.
  Interrupt-words-ONLY by design: this recognizer hears our own TTS through the speakers, and
  the interrupt set is the precision-safe subset. Aurora pill now says “Speaking — say ‘stop’
  to interrupt”. Fast re-arm from 6.2's sibling fix: re-arm delay is 140ms within 2s of TTS
  ending (was a flat 450ms that ate the user's first words — "play the video" → "the video"),
  450ms otherwise (wake handoff still needs the beat).

### 2026-07-12 — Claude (Fable): Voice round 6.1 — "Stream is already closed" cascade fixed (evidence from kokoro-js source)

- Real user crash: `first chunk timed out` → `failed to load Kokoro — Stream is already
  closed.` Root causes CONFIRMED in kokoro-js 1.2.1 dist source: (a)
  `TextSplitterStream.close()` THROWS on a second call — our `speak-cancel` after `speak-end`
  (exactly what the timeout fallback sends) double-closed, the uncaught throw hit
  `worker.onerror`, and `failNaturalVoice` terminated the whole engine; (b) kokoro-js fetches
  `voices/<voice>.bin` from huggingface.co AT FIRST GENERATION per voice — our sanity warmup
  used af_heart while the user had Michael selected, so the first real reply paid a network
  fetch inside the 12s budget.
- Fixes: worker sessions track `closed` (idempotent `closeSplitter`, push ignored after
  close), the entire worker `onmessage` is try/caught (a message can never kill the worker),
  main-thread `worker.onerror` is fatal only pre-ready (post-ready: warn + keep the engine),
  and the `warm` request now carries the USER'S voice so its style file is cached before
  "ready" (voice switches were already covered by the ack-cache warm).

### 2026-07-12 — Claude (Fable): Voice round 6 — WebGPU Kokoro (2–10×), instant acks, less-robotic fallback

- **Kokoro on WebGPU** — `tts.worker.ts` now tries `device:"webgpu"` with the SAME q8 files
  (zero new download; the "WebGPU needs 326MB fp32" assumption was outdated — kokoro-js 1.2.1
  caps dtypes at q8 so q8/webgpu it is), guarded by a worker-side SANITY GENERATION (NaN /
  silence / clipped-noise checks on a test utterance) that falls back to wasm/q8 automatically.
  The sanity generation also pays the session compile, so "ready" now means genuinely warm —
  the main-thread `warmFirstGeneration` + warmup-window strike logic was deleted (ready resets
  strikes; first-chunk budget is a flat 12s again). `ready` carries `device`; ⚙ shows
  "ready (Kokoro · GPU/CPU)"; console logs the landing device.
- **Instant acks** — `ackCache` pre-generates "Okay."/"Done."/"Yes?" per voice at ready (and on
  voice switch); `speakReply` plays them with ZERO generation wait (the wake "Yes?" is now the
  assistant's reaction time on any device).
- **Less-robotic system fallback** — `pickVoice()` now prefers NETWORK voices
  (`localService === false`, Chrome's Google voices) over local SAPI ("Microsoft David
  Desktop" tier) within the gender pool.

### 2026-07-12 — Claude (Fable): Voice round 5 — accurate EARS (lexicon normalizer + Moonshine local ASR) + "yes"-loop fix + warmup-strike fix

- **Transcript normalizer (vocabulary biasing)** — NEW `apps/web/src/ai/transcript-normalizer.ts`,
  pure + eval-tested: deterministic editor-lexicon rewrites on dictation FINALS (wired at
  AiChatPanel's `onFinal` + wake-word carry-through). Real corpus: "just make lip one in lower
  be to layer" → "just make clip 1 in lower V2 layer". PRECISION-FIRST context gates: "lip"
  corrects only next to an ordinal (lip sync survives), V/A-track homophones ("be to"/"we too")
  only against an adjacent layer/track word, "clip to/for" never treated as ordinals, fuzzy
  (Levenshtein ≤1) editor terms only for non-everyday tokens. 11 eval checks incl. 5 must-NOT.
- **Local high-accuracy ears (Moonshine)** — NEW `asr.worker.ts`/`asr.ts` pattern-copying the
  Kokoro pair: `@huggingface/transformers` (now a direct web dep; was already in the tree via
  kokoro-js — zero install weight) loads `onnx-community/moonshine-base-ONNX` (q8/wasm, ~60MB
  one-time, visible progress, honest failure reason, ↻ retry, 35s auto-retry). Opt-in ⚙ toggle
  "High-accuracy hearing" (`orreris.voice.ears.v1`). Hybrid dictation: Web Speech keeps instant
  interim + mic lifecycle; `useDictation` gained `refineFinal`/`onRefined` — the session is ALSO
  recorded (from the existing waveform stream, no extra permission) and on stop the local
  transcript (through the normalizer) REPLACES the Web Speech finals; status holds at
  "transcribing" so voice auto-submit waits; any failure keeps the Web Speech text. Wake-word
  standby stays pure Web Speech. Aurora pill shows "⬇ hearing N%" during the download.
- **AgentLoop "yes"-loop FIXED** (real transcript: five spoken confirmations, five identical
  re-asks): affirmative clarify answers are annotated `— CONFIRMED. Do NOT ask again; execute
  now.`; an IDENTICAL re-asked question is auto-answered once from the stored answer (never
  re-asks the user); a third identical ask stops with "The model kept asking the same question".
- **Kokoro warmup strikes voided** — real console: two "too slow" strikes straight after load.
  The first WASM generation's session-compile hogs the single-threaded worker, so real replies
  queue behind it. Now: 30s (not 12s) first-chunk budget until the warmup generation completes,
  timeouts in that window never strike, and warmup completion clears any strikes/demotion
  earned during the compile (status returns to ready).
- **Voice-session on/off loop guard** — the host-desire sync effect (`voiceDesired`) is now
  EDGE-triggered (acts only when the desire value changes; first mount included), so a
  remount/re-render with a stale `aiVoiceWanted=true` can no longer force re-entry after an
  internal exit (the observed on/off notice spam was HMR remounts re-entering each time).

### 2026-07-12 — Claude (Fable): Voice round 4 — streaming Kokoro, talk-mode read-back, full-length multi-point speech, gender-matched fallback

- **Streaming TTS (worker protocol v2)** — `tts.worker.ts` replaced one-shot `generate` with
  speech SESSIONS (`speak-start/push/end/cancel` → `chunk/speak-done/speak-error`): kokoro-js
  `tts.stream()` + `TextSplitterStream` yields one WAV per SENTENCE, so the first sound arrives
  after one sentence's inference (was: whole-reply generation), replies have no length cap, and
  generation pipelines ahead of playback. `tts.ts` gained `startSpeechStream()` (the one
  primitive under `speakReply` AND live push) with an ordered chunk queue + player loop; the
  12s timeout / 2-strike too-slow demotion now measures TIME TO FIRST CHUNK (fair on the new
  math); a post-`end()` 20s stall guard stops a wedged reply without a strike; pre-first-chunk
  failure replays the full text through the system voice (nothing lost), mid-reply failure
  never replays (no duplicates). `stopSpeaking()` reaches inside the session
  (`cancelActiveStream`: worker cancel + player wake) and `playWav` settles on `pause` too —
  a Stop mid-chunk used to leave the mic-gate promise hanging.
- **"After the 1st point it stops" FIXED** — `speakable()` lost its 240-char truncation and is
  now line-aware: bullet/number markers stripped, every line gets terminal punctuation, so
  multi-point answers are read IN FULL with natural pauses. New pure `splitSpeakable()` chunks
  cleaned text (~280 chars, sentence-merged) for the system engine — also dodges Chrome's
  long-utterance mid-speech silence. Both exported + covered by 8 new brain:eval checks.
- **Talk mode speaks, LIVE** — the talk branch (AiChatPanel) opens a speech stream in a voice
  session and pushes each COMPLETED sentence from `onDelta` while the LLM is still streaming
  (guards: never past the `SUGGESTIONS:` marker — its delta can leak into onDelta; local
  models that return text without deltas get a final full push; error lines are spoken).
- **Gender-matched system fallback** — `NATURAL_VOICES` gained `gender`; `pickVoice()` filters
  the system-voice pool by the selected Kokoro voice's gender (Michael selected → male system
  voice while the model downloads; honest full-pool fallback when no male voice is installed);
  `setNaturalVoice()` busts the cached pick.
- Engine analysis (researched): Kokoro stays — Piper is faster but audibly mechanical,
  KittenTTS smaller but lower quality, Supertonic fewer natural English voices; the latency
  answer was streaming, not an engine swap. WebGPU/fp32 (326MB) still deferred.

### 2026-07-11 — Claude (Fable): Editor Command Plane v1 (voice-first editor control) + feedback thank-yous + small UX fixes

- **Editor command plane** — the AI can now OPERATE the editor, not just edit timeline data.
  NEW `apps/web/src/editor/editor-commands.ts` (Zod-validated command registry: setTool /
  transport / seek / selectClip / setPreviewQuality / setSnapping / editorUndoRedo / openExport;
  web gained a direct `zod` dep) + `runEditorCommand` dispatcher in EditorPage (reuses the exact
  keyboard/button handlers — togglePlayback, startShuttle, setEditorCurrentTime,
  expandLayerSelection, the ¼/½/1/A quality logic incl. the adaptive-quality DUAL source of
  truth) passed as a prop to AiChatPanel. NEW `apps/web/src/ai/brain/commands.ts` tier-0 compiler
  ("pan mode", "pause", "go to 12 seconds"/"0:45", "next marker", "select clip 3", "half
  resolution", "toggle snapping", "redo", "export") — zero tokens, <5 ms, precision-anchored
  (bare "cut" NEVER fires — blade needs "blade"/"cut tool"). Router gained a `command` result
  kind checked before the FAQ; the play/pan FAQ *tips* were retired (commands execute instead);
  commands run with NO approval bar in any mode (non-destructive view/transport state).
  "undo" with nothing AI-applied now drives the editor's real history instead of a Ctrl+Z tip.
  Semantic tier passes command rewrites through + new exemplars ("freeze playback"→pause,
  "lowest quality"→quarter res). `brain:eval` grew to 160 checks incl. command corpus + new
  ambiguity rows ("play something fun", "cut it", "go to the good part" must escalate).
- **"ripple delete clip N" / "delete clip N and close the gap"** → tier-0 `deleteLayer{ripple:true}`.
- **`openPanel` command added same day** (user hit "open effects tab" escalating to the LLM,
  which refused): open/close/toggle Media Pool / Effects / Color / Project Settings / Inspector
  ("open effects tab", "open inspector", "hide the inspector"). Dispatcher reuses the topbar
  toggle logic incl. responsive-overlay mode. Ambiguity guard: "effects"/"color" require a
  tab/panel suffix — bare "show effects" (could mean a clip's applied effects) escalates.
  Semantic exemplars: "open the media browser"→media pool, "show clip properties"→inspector.
- **Plan cache v2 (retargetable) + feedback on LLM turns** — the v1 cache keyed on the FULL
  composition + playhead-ms, so "same request twice" almost never replayed. v2
  (`orreris.brain.plancache.v2`): keyed on normalized prompt; replay-valid while every clip the
  plan's steps REFERENCE is byte-identical (unrelated edits/playhead moves don't invalidate);
  deictic prompts ("it"/"here"/"selected"…) additionally pin exact selection + playhead-ms.
  Every successful LLM turn now shows 👍/👎 ("Was this what you wanted?"): 👍 confirms the
  cached replay (same ask = 0 tokens forever), 👎 (or undo within 60s) `forgetLearnedPlan()`s —
  drops the cached plan AND the phrase learned from it — reverts, and asks for a correction
  (deliberately no auto re-run: the same model would repeat itself). brain:eval covers replay-
  despite-drift, referenced-clip-change → escalate, and forget → escalate.
- **Voice mode toggle + full-window aurora** — new AudioLines header button in the AI panel
  toggles the hands-free voice session (long-press mic still works; "stop listening"/"exit voice
  mode" spoken also exits). While live, a portal renders `.voice-aurora` on <body>: Gemini-style
  animated conic-gradient edge frame + breathing inset glow over the ENTIRE window
  (pointer-events: none — the editor stays fully usable), cool/slow while listening, warm/fast
  while executing, plus a top-center status pill (state dot, live transcript tail, ✕ exit).
  Reduced-motion honored. CSS at the end of global.css.
- **⚙ natural-voice status + ↻ Retry, theme-accent voice UI, cancel fixes** — the ⚙ menu's
  natural-voice line now shows the stored FAILURE REASON (`lastFailureReason`, included in the
  progress replay) + a ↻ Retry button (`retryNaturalVoice()` clears cooldown AND too-slow
  strikes for a fresh verdict — pre-worker verdicts are stale). All voice-UI colors (aurora
  gradient/glow/dots, AI-live dot, ⚙ On pill) now derive from `--accent`/`--nle-accent` via
  color-mix (`--va-accent/--va-soft/--va-bright` on .voice-aurora) — states read via
  brightness+speed, not foreign hues. AgentLoop: isCancelled checked right after planning
  (Stop during a long stream no longer pops a question), and a cancel-shaped CLARIFY ANSWER
  ("don't do anything", "never mind", "stop"…) ends the run instead of being fed back to the
  model (which just asked again — real transcript).
- **Kokoro moved into a Web Worker** (`ai/tts.worker.ts`, protocol types exported; same
  pattern as sourceProxy.worker.ts) — WASM inference on the main thread froze the whole editor
  per reply ("page unresponsive"). The worker owns from_pretrained (forwards raw per-file
  download progress; main thread aggregates) + generate → transferable WAV ArrayBuffer; tts.ts
  is now a worker client (pending-generation map, load-error → terminate + retry cooldown,
  12s generation timeout + 2-strike too-slow demotion to the system voice). Also: Chrome
  speechSynthesis fixes — 80ms cancel→speak gap (same-tick speak is silently DROPPED),
  resume() before speak, module-held utterance ref (GC kills speech mid-sentence), 30s safety
  resolve; system-voice audition always answers from the ⚙ voice picker.
- **AI panel ⚙ settings menu + voice picker** — the header had piled up one icon per feature;
  now: Voice (Alt+L) · New chat · ⚙ · ✕. The ⚙ dropdown holds: "Hey Orreris" wake-word On/Off,
  "Train my wake phrase…" (re-runs the sample-capture card any time), Assistant voice picker
  (Kokoro `af_heart` "Heart — American female" / `am_michael` "Michael — American male";
  persisted `orreris.voice.tts.voice.v1`, tiny per-voice style file, instant spoken audition on
  switch when ready), BYO key / Memory / Insights, and a natural-voice status line. tts.ts
  exports NATURAL_VOICES/get/setNaturalVoice. Kokoro playback hardening same day: warmup
  generation at load (first-reply silence was WASM compile), 20s generation timeout, playback-
  blocked → system-voice fallback (was silently swallowed), q8/WASM ~86MB always (fp32/WebGPU
  326MB dropped — undownloadable on flaky networks), MB shown in progress.
- **Voice round 3: first-run wake training + Alt+L/panel-closed fixes** — (1) Alt+L with the
  chat closed was broken by a mount-race: AiChatPanel's session-mirror effect reported its
  INITIAL `false` up on hidden-mount, flipping `aiVoiceWanted` off before the session started —
  the mirror now skips the initial value, and toggle/exit write `voiceSessionRef` synchronously.
  (2) "Hey Orreris" was DEAF with the chat closed (standby lives inside the unmounted panel):
  EditorPage now keeps the dock mounted-hidden whenever the Ear is armed (`aiWakeArmed`, fed by
  the new `onWakeWordChange` prop + `loadWakeWordEnabled()` from wake-word.ts). (3) Matcher:
  "heya"/"hiya"/"yo" greetings added; distinctive l-variant names wake WITHOUT a greeting
  ("Orreris, pause" → carry-through) while mia/miu/mio stay greeting-anchored. (4) **First-run
  voice training** (`wakeSetup` transcript card, flag `orreris.voice.wakesetup.v1`): offered once
  on first panel open ("Teach me your wake phrase — say whatever feels natural"), and
  auto-starts when the Ear is armed with zero learned phrases; captures 3 spoken finals
  verbatim via the standby recognizer (never wakes mid-training) and learns them
  (`learnWakePhrase`), so "heya orreris" works exactly as the user says it. (5) Kokoro load
  failures are now RETRYABLE (30s cooldown + auto-retry timer; browser-cached files resume) —
  a mid-download "network error" no longer kills the natural voice for the session.
- **Alt+L fixes: shuttle collision + voice-only mode** — (1) the editor's transport keydown
  handler only bailed on Ctrl/Meta, so Alt+L ALSO fired the bare "L" JKL shuttle; it now bails
  on any Alt combo (they all have dedicated listeners). (2) Alt+L no longer opens the chat
  panel (user request): EditorPage keeps `aiVoiceWanted`/`aiVoiceActive`, mounts the ai-dock
  HIDDEN (`.ai-dock.is-voice-only { display:none }`) so the session can run panel-less, and the
  topbar AI button becomes "AI ● live" (pulsing dot + green glow). AiChatPanel's
  `voiceToggleToken` prop was replaced by `voiceDesired` + `onVoiceSessionChange` (two-way sync
  — Esc/"stop listening"/Ear exits report up). Kokoro download % additionally shows in the
  aurora pill (`voice-aurora-sub`) since the transcript notice is invisible in voice-only mode.
- **Natural voice: Kokoro-82M in the browser** — `apps/web` gained `kokoro-js` (Apache-2.0,
  commercial OK). `ai/tts.ts` is now two-engine: Web Speech answers instantly day one;
  `warmNaturalVoice()` (fired when a voice session starts or the wake word arms) lazily
  downloads Kokoro (`onnx-community/Kokoro-82M-v1.0-ONNX`, ALWAYS wasm+q8 ≈86MB — webgpu needs fp32 ≈326MB
  which flaky connections never finish, and the browser cache can't resume one interrupted
  file; revisit fp32 as opt-in later. Browser-cached, voice `af_heart`) with a LIVE percentage row in the chat (user requirement:
  visible progress, no magic — `onNaturalVoiceProgress` subscriber, aggregated per-file
  loaded/total). Once ready, `speakReply` routes through Kokoro (generate → wav blob →
  HTMLAudio; monotonic speak-token so stop/next-reply silences in-flight generations); any
  failure falls back to the system voice honestly. pnpm note: kokoro-js pulls Node-only
  onnxruntime-node/protobufjs/sharp — their build scripts are declared `false` in
  pnpm-workspace.yaml `allowBuilds` (browser uses onnxruntime-web; do NOT approve them).
- **Voice round 2: trainable wake word + TTS read-back + carry-through** — real transcripts
  showed Web Speech hears "hey orreris" as "hello Mia/miu/Lumia". NEW `apps/web/src/ai/wake-word.ts`
  (pure, eval-tested): greeting-anchored matcher over a variant set + Levenshtein ≤2 + split
  tokens, PLUS learned phrases (`orreris.voice.wakephrases.v1`) — standby near-misses (short
  greeting-led finals) raise a `wakeTrain` transcript card ("I heard 'hello mia' — were you
  calling me?"); confirming LEARNS that exact mishearing forever (this is the user-facing
  training loop). NEW `apps/web/src/ai/tts.ts` (speechSynthesis wrapper: emoji/markdown
  stripped, 240-char sentence truncation, voice pick cached): replies are SPOKEN only in a
  voice session via `speakIfVoice` (command says, brain answers, agent answers/finalSummary,
  clarify questions, approval prompt "say yes to apply"); the mic re-arm effect blocks while
  `speaking` so the recognizer never transcribes our own reply; aurora gained a "speaking"
  state. Carry-through: "hey orreris, blur clip 2" submits the command in one breath
  (`handleSubmitVoiceRef` late-binding); bare wake answers "Yes?". brain:eval gained a WAKE
  WORD section (~17 checks incl. learn/clear lifecycle).
- **"Hey Orreris" wake word + Alt+L** — Alt+L toggles the voice session from anywhere (token
  pattern like Alt+M; opens the AI panel if closed). New Ear header button enables the opt-in
  wake word: a standby Web Speech recognizer (`createSpeechRecognition` exported from
  useDictation.ts) runs whenever the mic is otherwise free (never contends with dictation),
  auto-restarts on Chrome's ~60s session ends, matches /hey,? orreris/ + misheard variants
  (loomio/lumeo), and on match aborts itself → enters the voice session (150ms handoff before
  dictation grabs the mic). Permission revocation auto-disables the toggle. Persisted in
  `orreris.voice.wakeword.v1`; the Ear breathes while standby is live.
- **👍/👎 feedback acknowledgments** — 👍: "Thanks — feedback like this literally trains me…";
  👎: reverts (if edits), dials the rule down, thanks the user, re-runs via the model.
- **Inspector starts collapsed** by default (user request).
- **Alt+R/Alt+T → Alt+E/Alt+R** — left-panel expand is now Alt+E, inspector expand Alt+R
  (labels/aria updated).
- Note: a transient `handleNewChat is not defined` crash on 2026-07-11 was HMR mid-edit state,
  not a code bug — definition precedes use in the committed file.

### 2026-07-10 — Claude (Fable): AI chat persistence + asset-scope leak fix

- **AI chat history persists per project** — `transcript.ts` gained `loadTranscript`/
  `saveTranscript`/`clearTranscript` (localStorage `orreris.ai.transcript.v1.<projectId>`, capped
  150 items, streaming/running flags sanitized on restore so nothing comes back "live");
  AiChatPanel restores on mount + debounce-saves on change; the planner's follow-up history is
  derived from the transcript so follow-ups survive reloads too. New ✏️ "New chat" header button
  clears the persisted conversation (disabled mid-run).
- **Asset-scope leak (user report: "videos vacant in new projects, audio persists")** — root
  cause: `EditorPage.handleUploadAsset` (and the .orreris package import) never passed `projectId`
  to `createAsset`, so those uploads were created OWNERLESS and appeared in every project's bin
  forever (e.g. `atlasaudio-calm-nature`), while older project-owned uploads were correctly
  hidden by the bin's pile-fix filter — the two behaviors looked contradictory. Fix (user chose
  per-project scoping): non-brand editor uploads + package-import media now pass
  `projectId: project.id`; brand uploads stay user-level by design. Pre-existing ownerless rows
  were deliberately NOT migrated (user declined repair) — they can be deleted from the bin.

### 2026-07-10 — Claude (Fable): Orreris Brain B3–B7 — semantic tier, fast model class, loop economy, learning write path, concept recipes

- **B3 semantic tier** — NEW `apps/web/src/ai/brain/semantic.ts`: slot extraction (clip refs /
  times / colors / numbers → intent skeletons), curated phrase index (exact skeleton match is
  free; lazy MiniLM embeddings via the local-transcription CDN pattern for unseen paraphrases,
  cosine ≥0.9 + 0.04 margin + slot-arity gate), matches select INTENT only — the canonical
  rewrite re-enters tier 0/1 so target/type/Zod gates still decide. Plan cache (normalized
  prompt + exact full-composition signature → free replay; written from fully-successful
  all-action loop runs in AiChatPanel). Async tier in `handleSubmit` after the sync router;
  escalates instantly while the embedding model is cold (download continues in background).
- **B4 fast model class + tier 3** — gateway `fast` pool (`aiGateway.service.ts` fastPool:
  llama-8b-instant/flash-lite class models, distinct `-fast` provider ids/cooldowns, 8s
  timeout, temp 0, 900-token cap; env: `*_FAST_MODEL`); NEW `POST /ai/plan/fast`
  (micro-prompt `FAST_PLANNER_SYSTEM_PROMPT` in shared/ai-prompts.ts, Zod-parsed steps-or-
  escalate reply, shared rate bucket + cache); NEW `apps/web/src/ai/brain/fast.ts`
  (`looksTransactional` gate, target-clip-only micro context + compact action catalog,
  `brainPlan` Zod re-validation, `t3.fast-lane` trust gating). Panel shows "⚡ Fast lane · one
  small model call"; ledger route `llm-fast`; escalated fast attempts' tokens are added to the
  following loop record.
- **B5 loop economy v2 (core)** — final-batch contract: planner prompt + `AiPlan.final/
  finalSummary` + AgentLoop ends the run with NO closing LLM call when a final batch fully
  succeeds (validation-dropped steps void the claim). Slice diffs: `LlmPlanner.buildSliceContext`
  sends the full slice on iteration 1, then ADDED/CHANGED/REMOVED + ref-id stubs for unchanged
  layers (keyed per prompt+composition; continuation detected via ACTION RESULT turns).
  Capability-gap pre-check in `ai/brain/faq.ts`: "keyframe/animate <effect>" answers instantly
  with the honest limit + alternatives (exact effect type/name match only; keyframeable
  properties like opacity pass through to the model). Intent DSLs (MotionIntent etc.) remain a
  future slice.
- **B6 learning loop (complete slice)** — implicit signals in AiChatPanel: undoing a brain edit
  within 60s = rejection; submitting a new prompt with a brain edit still standing = weak
  confirmation (ref-mirrored `brainTurn` so undo/submit consume it exactly once). Learned-phrase
  WRITE path `maybeLearnPhrase(prompt, steps)` in semantic.ts: a fully-successful single-action
  LLM run whose intent the phrase index knows teaches this user's skeleton (slot-arity-gated —
  non-generalizable phrasings like "the intro" are never learned).
- **B7 concept → recipe (first slice)** — exact phrases ("make it cinematic", "teal and
  orange", "make it noir") compile to ONE color-grade skill step with a registered
  `CreativeLook` (task inputSchema-validated), deterministic + free + per-recipe 👎-gated.
- **Eval** — `brain:eval` grew to ~105 checks: tier-2 exemplars/deixis/type-gates, mocked-
  embedder threshold + margin cases, learned-phrase read AND write paths, plan-cache
  hit/drift, fast-lane gate, capability-gap answers, concept recipes, and the full ambiguity
  corpus re-run through tier 2 (still zero wrong fast-paths). Gates green: shared/api/web/worker
  typecheck + brain:eval.
- Docs: AI_ARCHITECTURE.md build-plan statuses updated (B3 ✅, B4 ✅, B5 ✅ core, B6 ✅, B7 🚧).
- **Wrong-target fix (real incident)** — "detect beat from clip 2 and apply it on clip 1" split the
  AUDIO: clip 1 wasn't selected/on-playhead so it was missing from the slice, and the model used
  the only id it had while its summary claimed clip 1. Fix in `LlmPlanner.ts`: prompt-named clip
  ordinals ("clip 1", "the 2nd clip", "third clip") are now ALWAYS included in the slice, ahead of
  the cap (`promptNamedOrdinals` + reordered `relevantLayers`); plus a PLANNER_SYSTEM_PROMPT rule
  that a named-but-invisible clip must never be substituted with another layer's id (answer/clarify
  instead — wrong target is the worst outcome).

### 2026-07-10 — Claude (Fable): Orreris Brain B2 — tier-1 command compiler + 👍/👎 feedback trust loop (two-stage learning)

- **B2 command compiler** — NEW `apps/web/src/ai/brain/rules.ts`: grammar rules (verb family +
  target + params → registry actions), zero tokens, <50ms. Rule families: **text-color**
  (updateText; TYPE-GATED — "make clip 1 white" on video escalates to grade territory; suffix-split
  parsing so "make clip 2 white" splits correctly), **move-in-time** (moveLayer deltaSeconds;
  earlier/later/delay/push), **fades** (addTransition fadeIn/fadeOut, additive, optional duration),
  **blur** (addEffect, or updateEffect when a blur already exists; explicit amounts). Targets
  resolve via the clip-reference ladder (explicit ordinal → single selection → single playhead;
  ambiguous NEVER fires). Politeness prefixes ("can you… please") + trailing punctuation
  normalized. Router runs tier 0 → tier 1 → escalate; ledger route "rules".
- **👍/👎 feedback trust loop (B6 slice, user request)** — NEW `apps/web/src/ai/brain/feedback.ts`
  + a slim feedback row after every brain-resolved turn ("⚡ Instant — was this right?").
  👍 = rule earns trust. 👎 = rule LOSES trust, the local edits are auto-reverted, and the SAME
  prompt re-runs through the LLM (skipBrainRef one-shot bypass) — no retyping. A rule with 2+ net
  rejections fails `isRuleTrusted` and stops fast-pathing for this user (recovers if 👍s outweigh).
  **Two-stage learning (user requirement)**: Stage 1 local (this), Stage 2 universal — every
  feedback event is stored aggregate-ready (ruleId+outcome only, no prompt text) with
  `drainFeedbackEvents()` as the future consent-gated server sync hook.
- `brain:eval` grew to 50 checks incl. a trust-gate test (fire → 2×👎 → escalates → cleared →
  fires again) and new ambiguity entries (type-gate cases, fuzzy magnitudes, missing params).
  All green + web typecheck.
- **Clip-wording pass (user approved "go")** — user-facing registry copy renamed "layer"→"clip"
  across `packages/shared/src/timeline-actions/actions/*` (names, execute summaries,
  descriptions: "Delete clip", "Move clip", "Update text", "Group N clips", "…attach it to a
  clip", etc.). Action IDS unchanged (`deleteLayer`, `moveLayer`, …) so the planner contract,
  params, and all call sites are untouched; grep confirmed zero code/test references to the old
  strings. Rationale: timeline badges + clip-reference already say "clip N" — a clip IS a
  TimelineLayer internally; this was copy drift, not a model change.
- **FAQ paraphrase widening** — capability-question patterns now catch real paraphrases the
  user hit ("what you can do for me", "what are you capable of", "show me what you can do")
  while "what can i do" (about the user) still escalates. Safe to widen: answer-only + 👎-gated.
  Deeper paraphrase coverage is B3's job (local embeddings), not more regex.
- **Mic shortcut** — "." now toggles AI voice dictation (one-hand; user request), with a
  typing-context bail so "." types normally in fields; Source Monitor's scoped "." (overwrite
  edit) is untouched (it stopPropagation()s first). ⌘/Ctrl+"." added (user request) and Alt+M
  kept — both have NO typing bail, so they toggle the mic while the composer is focused. Cheat
  sheet updated. Ctrl+/ (panel toggle) and "/" (focus composer) unchanged.
- Gates: shared+web+worker typecheck ✓, `brain:eval` 55 checks ✓.

### 2026-07-09 (cont. 2) — Claude (Fable): Orreris Brain — architecture doc rewrite + B0 routing ledger + B1 tier-0 reflex router

Motivated by `AI_REFINEMENT.md` (real session log: 6–17s reasoning-LLM round trips for trivial
commands, a wasted closing loop iteration per run, "what can you do" costing a 17s model call).
`AI_ARCHITECTURE.md` was **fully rewritten** as the Orreris Brain plan: a 5-tier decision cascade
(reflex → command compiler → semantic/embeddings → transactional fast-LLM → creative agent loop),
precision-first fast paths that NEVER guess (escalate silently), bandit-style learning from
apply/undo feedback, phased build plan B0–B8. Old phase tracker 1–16 preserved inside it
(Current state + appendices). `AI_STRUCTURE_SUGGESTIONS.md` = the brainstorm input, kept.

Shipped this session (B0+B1):
- **B0 routing ledger** — NEW `apps/web/src/ai/brain/ledger.ts`: per-request {route, provider, ms,
  estTokens, outcome} in a localStorage-backed ring (200); `summarizeRouting()` surfaces a
  "Brain routing" block in `AiInsightsDashboard` (instant share, avg latencies, est tokens
  spent/saved). `AgentRunReport` gained `estChars`; loop/talk/reflex paths all record.
- **B1 tier-0 reflex router** — NEW `apps/web/src/ai/brain/router.ts` + `faq.ts`: exact commands
  compile locally into ordinary AiPlans (provider "brain", 0 tokens, <5ms): "delete clip 3",
  "split clip 2 at playhead" (with honest bounds answers), "add a marker", "undo"; registry-
  GENERATED capabilities answer; real-shortcut editor answers (Space/H/S/C/M… from the timeline
  cheat sheet); "what is clip 2" described from the slice. Wired into `AiChatPanel.handleSubmit`
  ahead of any model/network (Talk mode + image turns bypass). Mode gating unchanged: reflex
  plans flow through the same approval/execute pipeline; transcript shows "⚡ Instant · … — 0
  tokens" notices (honest labels).
- **brain:eval** — NEW `apps/web/src/ai/brain/router-eval.test.ts` (+ web script): transactional
  corpus must resolve at tier 0, ambiguity corpus must escalate with ZERO wrong fast paths
  (the do-not-repeat-the-deterministic-planner-frustration contract). All green + web typecheck.

Next per AI_ARCHITECTURE.md: B2 command compiler (tier 1), B3 embeddings, B4 gateway `fast`
model class, B5 loop economy v2 (final-batch contract kills the closing iteration).

### 2026-07-09 (cont.) — Claude (Fable): "Claude Code for video" — agent transcript UI, real agentic loop, tool-awareness (inspect/markers/beat-sync), hands-free voice sessions

Plan: `~/.claude/plans/after-this-plan-a-zesty-karp.md` (approved). The AI panel is no longer a
chatbot — it's an agent work log driving a real observe→think→act loop. All gates green
(typecheck 5/5, `editor:test`, worker `skills:test`/`executor:test`/`clipref:test`). NOT yet
live-tested against a real LLM turn — needs a `pnpm dev` E2E pass.

- **Agent transcript UI (replaces bubbles + PlanReviewCard + AiProgressList — both files DELETED).**
  New `apps/web/src/ai/transcript.ts` (typed `TranscriptItem` union: user/thought/step/text/
  question/summary/notice + pure append/patch helpers) and
  `apps/web/src/components/ai/AgentTranscript.tsx` (flat rows: accent-bulleted step lines with the
  executor's REAL `detail` always shown + real durations; dim streaming thought clamped to the last
  ~6 lines, collapsing to "Thought for Ns ▸"; inline questions with the answer patched onto the row;
  slim `ApprovalBar` replacing the boxy card). `AiChatPanel` keeps `pushMessage(role,text)` as a
  compat shim over the transcript; planner history is derived from user/text/question/summary items
  only (work rows never round-trip — token economy).
- **Real agentic loop** — new `apps/web/src/ai/agent/AgentLoop.ts` (`runAgentLoop`): per iteration,
  fresh timeline slice + compact one-line `ACTION RESULT:` log (capped 8, reasoning never echoed) →
  `planner.plan()` (same `/ai/plan/stream`, ZERO server changes; `PLANNER_SYSTEM_PROMPT` gained a
  static AGENTIC MODE section) → validate → execute ONE batch via the existing `executePlan` →
  feed real outcomes back. Finish = answer-only plan; clarify-only = inline question that CONTINUES
  the same run; loop-breaker on identical repeated batches; offline plan mid-run stops honestly;
  per-mode iteration caps (quick 3 / professional 8 / agent 12) + char-budget guard that injects
  "FINISH NOW" at 80%; Stop button (send button flips to ■ while running) cancels between steps.
  Professional = approve-ONCE-per-run via the slim bar (per-step checkboxes preserved), then
  free-runs — a semantics change from approve-every-plan, deliberate.
- **Tool-awareness.** New `inspect` step kind (`{"kind":"inspect","capabilityId"}`): resolved
  ENTIRELY client-side by the loop via `capability-index.describeCapability(id)` (NEW — full doc for
  any action/effect/tool/skill incl. Zod param reflection), doc rides into the next iteration's
  action log (≤800 chars), shown as a "Reading tool: X" row. Registry parity: NEW
  `timeline-actions/actions/marker.ts` (`addMarker`/`removeMarker`/`addMarkersAtTimes`, tolerant of
  legacy bare-number markers) and `splitClipAtTimes` in `clip.ts` (batch cut; applies times
  DESCENDING because `splitLayerAtTime` keeps the original id on the LEFT half).
- **Beat detection — REAL DSP, no mock.** New `apps/web/src/tools/beat-detection.ts`
  (fetch→decodeAudioData→mono→energy-flux onsets→adaptive threshold→IOI-histogram BPM; lazy-imported,
  cancellable). Exposed as a new `audio-analysis` skill (`skill-registry.ts`, taskKind
  `beat-detection`, NEW `execution: "analysis"` discriminator in skill-types) with
  `params.apply: report|markers|cuts|both` — `runSkillStep` in AiChatPanel detects beats and applies
  markers/cuts via the registry in ONE step/commit. New `AiChatPanelProps.resolveAssetUrl` (EditorPage
  passes `assets.find(...).fileUrl`) resolves the media. Speed-ramped clips approximated at 1x
  (documented in the skill procedure).
- **Hands-free voice session (E).** LONG-PRESS the mic (550ms) → session mode (`is-session` ring):
  dictation auto-submits on silence, the mic re-arms ~450ms after the agent goes idle/review/
  awaiting-answer (NEVER mid-execution), and a pending approval accepts spoken/typed
  "yes/apply/…" / "no/cancel/…" (regex intercept at the top of `handleSubmit`, works typed too).
  Esc or mic tap exits; Stop exits too. Transitions announced as transcript notices.
- **Theming fix (user report):** all hardcoded `#c9ff4a`/`rgba(201,255,74,…)` literals in the AI
  panel region of `global.css` (mic states, wave bars, pulse ring, plus-btn/pro-toggle active,
  checkbox accent) → `var(--nle-accent)` / `color-mix`, so the panel re-tints with the theme picker.
  Two remaining lime literals OUTSIDE the AI panel (l.2390 stroke, l.6667 background) left as-is —
  other shipped UI, not touched.
- **Known follow-ups:** loop provider pinning (iterations may hop providers — server-side change),
  slice DIFFS between iterations (currently each iteration re-sends the bounded slice; the action
  log is the only growth), TTS read-back (E4, deferred), `permission.ts`'s `shouldAutoApply` now
  unused by the panel (kept — other callers may exist).

### 2026-07-09 — Claude (Opus): AI panel — autonomous talk-vs-edit (`answer` step), honest thinking log, voice dictation, planner-honesty

A cluster of AI-composer work. All ADDITIVE to the planner contract — the executor, server plan
endpoint, and deterministic planner core were not restructured. `apps/web/src/components/ai/*`,
`apps/web/src/ai/*`, `packages/shared/src/ai-prompts.ts`, plus small `EditorPage`/`TimelineStrip`
shortcut edits.

- **Autonomous talk-vs-edit routing (new `answer` step kind).** The planner used to route purely on
  the selected MODE — every message in Agent/Pro/Quick went to the edit planner, so a plain question
  ("what is my clip 2?") got the "couldn't map to a tool" fallback. Now the LLM DECIDES: if the
  message needs no edit/tool/skill, it emits a single `{"kind":"answer","text":"…"}` step answered from
  the timeline slice. Wiring: `PLANNER_SYSTEM_PROMPT` gained the `answer` kind + a "decide first" rule
  + two examples (`ai-prompts.ts`); `LlmPlanner.validateSteps` accepts it; `types.ts` `PlanStepKind`
  gained `"answer"` + a `text?` field; `AiChatPanel` short-circuits an answer-only plan to a chat
  reply (parallel to the existing `onlyClarify` path) — no Apply card. The executor needs no change:
  its fall-through already skips non-action/tool/skill steps, and answer-only plans never reach it.
  A MIXED plan (answer + edits) currently drops the answer text (prompt tells the model to keep
  `answer` standalone) — render mixed answers if that ever shows up.
- **Thinking log is now real activity, not a scripted timer** (`AiThinkingLog.tsx` rewritten). The old
  version pre-listed 6 fixed phases and auto-advanced the checkmarks on a 620ms `setInterval` (the
  "magic box" feel). Now steps are revealed ONLY as real `activePhase` stream events arrive, the live
  step shows a spinner + its real elapsed seconds, finished steps show honest durations ("Thought for
  Ns"), and the real provider/reasoning are surfaced. The one remaining timer just advances the live
  seconds READOUT — it never moves steps forward. CSS: `.ai-thinking-spinner`/`.ai-thinking-time` +
  reduced-motion guard. Note: phases 0–2 are client-side prep and flash by instantly; the real dwell
  is the "Thinking" step.
- **Planner honesty (earlier same session).** `DeterministicPlanner` now tags plans `provider:"offline"`
  and is capped at "Approximation ≤55%" (was claiming "Exact 90%" for keyword guesses); the silent
  case where the LLM answered but all steps failed validation now routes through a nudge instead of
  passing the keyword fallback off as the model's work (`LlmPlanner`); `AiChatPanel` labels an offline
  plan "Offline plan (no AI)…" instead of "Here's my plan (Exact)".
- **Voice dictation (mic) in the composer.** New `apps/web/src/ai/useDictation.ts` — Web Speech API
  primary (live interim, `continuous`, silence auto-stop, Chrome ~60s restart handling), MediaRecorder
  → local whisper FALLBACK for Firefox (reuses `local-transcription.ts` via a NEW behavior-preserving
  `transcribeAudioUrlLocally` extraction). Mic button sits to the RIGHT of the composer input (new
  `.ai-composer-input-row`), live level meter + pulse ring. `capabilities.ts` gained
  `speechRecognition`/`microphone` flags. Shortcut **Alt+M** toggles it (own keydown effect in
  EditorPage, `event.code==="KeyM"` + preventDefault for Mac "µ"; opens the panel and bumps a
  `micToggleToken`, same bridge pattern as the `/`-focus `focusToken`). Cheat-sheet entry ⌥M.
- **Two composer fixes.** Bare `/` focuses the AI composer (opens the panel); the composer textarea is
  no longer `disabled` while busy (a disabled element was blurred by the browser, stealing focus on
  every send — submits are guarded in `handleSubmit` instead). Timeline bug: Alt+M also fired the bare
  `M` marker toggle — the `case "m"` in `TimelineStrip`'s keydown now bails on `event.altKey` too (it
  already special-cased ⇧M). NOTE: that same handler still doesn't bail on Alt generally, so other bare
  keys (V/N/I/O…) fire with Alt held — left as-is (only M collided); widen the top-level modifier bail
  if that becomes a problem.
- **Also fixed:** timeline clip body-click sometimes didn't select (transient desync where a superseded
  selection transition cleared the imperative `is-selected` highlight while state still held the clip);
  `startDrag` now re-commits selection for a single-selection click, matching the resize-handle path.
- Gate: `pnpm --filter @orreris/web typecheck` + `@orreris/shared typecheck` green.
  NOT live-tested (mic + LLM turns need the running app + a real browser) — verify dictation and the
  answer/thinking-log flows manually.

### 2026-07-08 — Claude (Opus): AI colorist (grade-intent compiler) + glass AI dock + Ctrl+/ toggle

Made the AI a genuine colorist (not a default-drop stub) and reskinned the AI dock.

- **`packages/shared/src/color/grade-intent.ts` (NEW):** compact `GradeIntent`
  (`{look?, primary?, tone?, balance?, hue?, secondary?}`) + `compileGradeIntent` → a STACK of real,
  editable color effects (brightnessContrast + colorCurves + colorWheels + hueSatCurves + hslSecondary).
  Pure/deterministic; reuses shipped color math (`looks/curve/wheels/hsl`), emits the graph params as
  JSON strings the existing pipeline already parses (no renderer change). `gradeIntentSchema` (Zod,
  strict) validates the intent. Worker gate `grade:test` — passing. Exported via the color barrel.
- **Skill (`skill-registry.ts`):** new `color-grade` skill, category `"color"`, task `color-grade` with
  `execution: "grade"` (new discriminator in skill-types). aiSummary always disclosed; the intent
  vocabulary rides in `procedure` (loaded only for color prompts — the token saver). `capability-index.ts`
  now routes ANY color/look request to this skill and tells the planner NOT to hand-author curve JSON.
- **Executor (`AiChatPanel.runSkillStep`):** color branch compiles the intent and applies the stack via
  `timelineActionRegistry.execute("addEffect", …)` on the `resolveTargetLayer` target, committing once
  (one undo entry). Fully local — no cloud, no tokens for the heavy structure work.
- **Deterministic floor (`DeterministicPlanner.ts`):** the color-family effect branch now emits a
  `color-grade` skill step built by a local `extractGradeIntent(prompt)`. So color grades stay REAL
  offline / on LLM fallback — removes the "deterministic catches up, can't bypass color" degradation.
  Bare "add curves" with no direction still falls back to adding the tool at default.
- **Glass AI dock (`global.css`):** `--nle-glass{,-2,-border}` tokens (theme-tinted, inherit `--nle-accent`
  per `data-orreris-theme`); `.ai-dock` is accent-frosted glass with ONE blur layer; bubbles/composer use
  translucent accent fills with NO per-bubble backdrop-filter (GPU-cheap). `@supports` solid fallback.
- **Shortcuts (`EditorPage.tsx`):** ⌘/Ctrl+/ toggles the AI panel (works even while its composer is
  focused). Alt+1/2/3 → left panel Assets/Effects/Color; Alt+4 → toggle Inspector; Alt+R / Alt+T →
  left-panel / inspector full⇄half height. All Alt-based + LEFT-HAND-only (1–4, R, T) so the panel
  scheme is one-handed for power users and never collides with the bare tool keys or ⌘/Ctrl combos;
  uses `event.code` for layout independence. Surfaced on hover via `title` + `aria-keyshortcuts` on the
  matching buttons (platform-correct ⌘/⌥ vs Ctrl/Alt labels).

### 2026-07-08 — Claude (Opus): Clip references + reference-clip resolution + non-destructive tool edits

Natural-language clip targeting foundation (typed now; voice is a later thin mic add-on). Also fixes a
verified destructive bug in the newly-wired one-click composite tools.

- **`packages/shared/src/clip-reference.ts` (NEW):** `computeLayerOrdinals` (positional "clip N" per
  spoken kind clip/text/audio/shape, eye order = start time then top track; adjustment layers excluded),
  `parseClipReference` ("clip 4"/"the 4th clip"/"second caption"), `resolveTargetLayer` (priority:
  explicit id → spoken ordinal → single selection → single playhead clip → ambiguous → none). Exported
  from shared index. Worker gate `clipref:test` (apps/worker) — passing.
- **Planner (`LlmPlanner.ts`):** the relevant-layers slice now tags each layer with a `ref` label
  ("clip 4") and the header carries the targeting rule; `capability-index.ts` DISAMBIGUATION gained one
  line. The planner sets `params.layerId` to target a clip; omitting it accepts the selection/playhead
  default.
- **Executor (`EditorPage.tsx` `openToolForAi`):** replaced the "selected-or-first-video" guess with
  `resolveTargetLayer` (explicit `params.layerId` → selection → playhead). Ambiguous/none → asks "which
  clip?" instead of guessing. NOTE: only `openToolForAi` was touched (far from the media-library area);
  the `PlanExecutor` layerId-backfill for timelineActions was DEFERRED to avoid regressing those flows.
- **Bug fix — non-destructive builders (`masks.ts`):** `applyRemoveBackgroundComposition`,
  `applyTextBehindPersonComposition`, `applyRemovePersonComposition` gained a `mode: "insert"|"replace"`
  (default `"replace"`, so the `/tools/:slug` single-source flow is unchanged). The three one-click
  handlers in `layer-effect-handlers.ts` now pass `"insert"` → they add on top and KEEP all existing
  clips instead of replacing the whole timeline. (`ai-roto` already used insert via extract-person.)
- **Timeline badge (`TimelineStrip.tsx` + `global.css`):** each clip shows its ordinal as a top-left
  `.clip-number` corner badge (direct child of the clip, since `.timeline-clip-video .clip-label` is
  `display:none`). Ordinals memoized on `composition.tracks` only — NOT on playhead/scrub (perf-safe).
- Gates: `pnpm -r typecheck` 5/5 green; worker `clipref:test`/`skills:test`/`executor:test` pass;
  `editor:test` passes.

### 2026-07-08 — Claude: Phase 5 — docs + final verification (media/library plan COMPLETE)

Executes Phase 5, the last phase of `~/.claude/plans/project-scoped-media-and-libraries.md`. All 5
phases are now done: project-scoped media, AI folders, unified Search + Graphics, Templates gallery, docs.

- `MEDIA_LIBRARY.md` rewritten to match reality: project scoping (`ownerProjectId`/`ProjectAsset`/
  backfill/local-first mirror), the Search tab (Stock provider-agnostic + Graphics bundled/Iconify),
  the Templates gallery, updated tab membership, hover-scrub (not hover-autoplay), and a trimmed Deferred
  list (moved "per-project asset silos" out of Deferred — it's done — and reflected the rest accurately).
  Per-phase detail already lives in this changelog (Phases 1–4 above) and `project-tracker/
  assets-media.md` (v6–v8) — not duplicated here.
- Final full gate: `pnpm -r typecheck` (5/5) + `editor:test` — both green.
- Nothing pushed to remote across any phase; all five phases are separate, gated commits
  (`c6163da`, `d292c4b`, `0ef003c`, `e8a1529`, and this one) so any phase can be reviewed/reverted alone.

### 2026-07-08 — Claude: Phase 4 — in-editor Templates gallery (curated + user-saved) + asset-bin hover-autoplay removed

Executes Phase 4 of `~/.claude/plans/project-scoped-media-and-libraries.md`. Phase 5 (docs) next.

- **Discovered most of the hard part already shipped:** `buildTemplateGraphFromProject`/
  `instantiateTemplateComposition`/`ensureTemplateSlots` (`packages/shared/src/timeline.ts`) already solve
  the cross-project asset problem — saving a template strips `assetId` from media layers into empty
  "slots"; applying fills them from the target project (or leaves them empty for the user to assign).
  `handleSaveAsTemplate`/`SaveTemplateModal`/the topbar "Save as template" button were already fully wired.
  Left all of that untouched — Phase 4 only ADDS the missing pieces around it.
- **User-scoping:** `Template.userId String?` (nullable migration `user_templates`, existing rows stay
  `null` = curated). `POST /templates` now stamps `userId: req.user.id` (every save-as-template
  attributes to its saver). New `GET /templates/mine` (curated + own) and `DELETE /templates/:id` (own
  only) — the existing public `GET /templates` (used by the standalone marketing `TemplatesPage`) is
  UNCHANGED, still lists everyone's active templates for that separate "start a new project" flow.
- **In-editor Templates tab** (`EditorPage.tsx`): new `AssetSourceTab` entry, its own data path (fetches
  `TemplateDefinition[]`, not `SourceAsset[]`) rendered in a dedicated grid branch, filtered client-side by
  the same search box. Hidden from the inspector's replace-picker (`clickAssigns`) since dropping a whole
  composition doesn't make sense there.
- **Apply is always append** (a deliberate simplification vs. the plan's "ask before replacing"): appending
  is non-destructive by construction (`appendTimelineComposition`, already used by the FCPXML importer), so
  there's no case where it needs a confirmation prompt. A template applied into an EMPTY project instead
  goes through `instantiateTemplateComposition` for clean id remapping. After apply, the notice reports how
  many empty media slots still need an asset — honest, not silent.
- **Own templates are deletable** from the gallery tile (curated ones aren't — the option only renders
  when `template.userId === currentUserId`).
- **Unrelated fix bundled in, per user report:** asset-bin thumbnails were autoplaying video on hover
  (`AssetCardMedia`'s `autoPlay` + `StockCardMedia`'s hover `.play()`). Both removed — `AssetCardMedia`
  keeps its hover-scrub-by-pointer-move feature (video mounts on hover but starts paused, only advances
  when the pointer moves across it); `StockCardMedia` now just shows the poster still, no video-element
  autoplay and no more hover-triggered network fetch (`preload="none"` was already there).
- Gates green: `pnpm -r typecheck` (5/5), `editor:test`.
- NOTE: an unrelated concurrent session still has uncommitted changes to `apps/web/src/tools/*` and
  `packages/shared/src/skills/*` (now also `clip-reference.ts`) — left untouched, not staged.

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
  state persisted to `localStorage["orreris_asset_folder_ai"]`).
  Fixed two spots that indexed `activeAssetFolders` / labeled the folder tab without an `"ai"` case
  (would have been `undefined` at runtime): the `activeAssetFolders` initial state and
  `currentFolderLabel`'s tab-name ternary (now a `folderTabLabel` lookup covering all three tabs).
  Upload dropzone (`showUpload`) intentionally stays Local/Brand only — AI assets arrive via
  generation, not drag-drop upload; folder organization/navigation works regardless.
- AI asset creation (`apps/web/src/generate/generateClient.ts`) already wrote `folder: ai/<taskId>` — no
  change needed there; confirmed it's the only client-side AI creation site.
- Gates green: `pnpm --filter @orreris/web typecheck`, `editor:test`.
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
- **Backfill:** `pnpm --filter @orreris/api assets:backfill` (ran: 77 projects, 75 links, 27 sole-owner
  uploads) so existing projects keep their bin media. Idempotent.
- **Web:** `listAssets(projectId?, scope?)` + local-first links mirror (`orreris_project_asset_links`) +
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

### 2026-07-07 — Claude: `.orreris` export/import hardening (default `.orreris`, async zip, trust-split caps)

- **Default export is now `.orreris`** (self-contained ZIP with embedded media), not the bare `.orreris-template.json` — plain click = `.orreris`, Shift+click = the lightweight bare JSON (`EditorPage.tsx` export button + tooltip).
- **Export no longer freezes the UI:** `buildOrrerisPackageZip` ran `zipSync(level 6)` on the main thread, re-DEFLATEing already-compressed media. Now media is STORED (`level 0`) and there's a new `buildOrrerisPackageZipAsync` (fflate worker threads) that the editor uses, with a "Building…" notice. Sync builder kept for tests.
- **`.orreris` has NO size limits by default** (it's the user's own project; export was uncapped, so import must be too). Old 512 MB / 256 MB-per-asset / 64-asset caps removed from the default path. `parseOrrerisPackageZipAsync` (new, off-thread) is what the editor imports with; sync `parseOrrerisPackageZip` kept for tests. Untrusted callers can still pass `maxPackageBytes`/`maxAssetBytes`/`maxAssetCount` explicitly ("others").
- **Zip-bomb guard retained (crash-prevention, not a product limit):** only the DEFLATE'd metadata (`manifest.json`/`timeline.json`) is capped at 512 MB decompressed via fflate's pre-decompress `filter`; embedded media under `assets/` is STORED so it can't amplify and stays unlimited. Manifest content-safety scan (`javascript:`/`importScripts` deny-list) is unchanged — `.orreris` is declarative data, no arbitrary-code execution.
- **Gates green:** `pnpm -r typecheck` (5/5), `editor:test` (`.orreris` round-trip incl. byte-for-byte asset survival).
- Files: `packages/shared/src/plugin-package-zip.ts`, `apps/web/src/pages/EditorPage.tsx`.

### 2026-07-07 — Claude: Day 2 — NLE import fidelity (titles/transitions/multi-sequence) + FCPXML export

- **Shared transition-name table:** `mapExternalTransition(name)` in `external-timeline-adapter.ts` replaces the old per-format "dissolve or nothing" checks — every importer (FCPXML, `.prproj`) and the new exporter route through the SAME table (Cross/Film Dissolve, Dip to Black/White, Wipe, Push, Slide, Cross Zoom, Iris; unknown → Cross Dissolve, never dropped).
- **FCPXML import fidelity:** `<title>` → editable text layer (text + font/size/weight/italic/color/alignment from `<text-style-def>`); `<transition>` → `transitionIn` on the following clip; `<adjust-opacity><keyframe>` → layer `animations`. Previously titles were skipped entirely and transitions always reported unsupported.
- **`.prproj` multi-sequence picker:** `report.availableSequences` lists every candidate sequence; `ParseExternalTimelineInput.sequenceId` + a new `<select>` in `ExternalTimelineImportModal` let a user pick ANY sequence, not just the auto-selected "most clips" one (re-parses from a stored raw-contents state, no re-prompt for the file).
- **New: FCPXML export.** `packages/shared/src/external-timeline-exporter.ts` `exportCompositionToFcpxml(composition, assets)` writes FCPXML 1.10 (clips/titles/transitions via the reverse of the shared name table); masks/text-warp/plugin-shader/blend-modes/keyframes are honestly reported as lossy in `report.unsupported`, never silently dropped. Wired to a new topbar "Export FCPXML" button. Round-trip verified: export → re-import matches clip count, timing, title text, and transition kind.
- **Known ceiling (documented, not attempted):** `.prproj` Position/Scale/Rotation motion-keyframe extraction — the real Premiere object-ref graph (`tmp/visualizer-full.prproj.xml`) is too deeply escaped/nested for the existing regex-based parser to walk reliably; see `project-tracker/nle-import-export.md` v1 for the full reasoning. CapCut import and MOGRT/Essential-Graphics extraction remain out of scope.
- **Gates green:** `pnpm -r typecheck`, `editor:test` (24 new asserts across transition-mapping/FCPXML-fidelity/multi-sequence/FCPXML-export-round-trip, zero failures).
- Files touched: `packages/shared/src/external-timeline-adapter.ts`, `external-timeline-exporter.ts` (new), `index.ts`; `apps/web/src/pages/EditorPage.tsx` (multi-sequence picker state + FCPXML export button), `apps/web/src/editor/editor.test.ts`; `examples/timeline-imports/simple-fcpxml.fcpxml` (extended with title/transition/keyframe); `project-tracker/nle-import-export.md` (new), `project-tracker/README.md`, `PLUGIN_ARCHITECTURE.md`.

### 2026-07-07 — Claude: Day 1 — real `webgl-fragment` effect engine + `.orreris` ZIP packages (plugin system)

- **Real GLSL "Custom Shader" effect (flagship plugin gap closed).** New `packages/shared/src/color/fragment-effects/registry.ts` mirrors the transition engine's registry+harness pattern: a plugin's `vec4 effect(vec2 uv)` body compiles into the SAME shader on preview/export/Remotion. New `pluginShader` `TimelineEffectType` (`types.ts`, `effects.ts`); `plugin-effect-adapter.ts` now supports `engine: "webgl-fragment"` — registers the GLSL and produces a `pluginShader` effect carrying `params.__shaderManifestId` + defaulted params (vec3→hex string, vec2→JSON string, matching existing param-storage conventions).
- **Render seam:** `SceneCompositor` gets a new `fragmentPasses` array on `SceneLayerDraw` (`SceneFragmentPass`), rendered inside the SAME per-layer nest `regionPasses` already uses (`renderLayerWithRegionPasses`), AFTER region passes, in effects-index order — never a second nest (would double-apply opacity/blend). Compile failures skip the pass + warn once, never black-frame. `build-scene-draws.ts`'s new `buildFragmentPasses` scans `layer.effects` for enabled `pluginShader` entries, resolves keyframed params via the existing `evaluateTimelineEffectParam`, and builds a per-effect mask via `SceneMaskMatteCache` when the effect carries its own `masks`.
- **Remotion registration gap (the #1 preview/export-divergence trap, per the plan's own risk list) is fixed:** `SceneStage.tsx` now calls `registerEffectManifests(manifest.plugins.effects, {override:true})` — previously effects were never re-registered for Remotion (fine for presets, would have rendered fragment effects BLANK in export).
- **Inspector:** `pluginShader` effects render their param controls dynamically from the fragment def (`EditorPage.tsx` `buildPluginShaderParamDefinitions`), reusing the existing number/color/boolean controls — no new control types.
- **Verified:** `render:compare:pixels` — 24/24 fixtures (incl. new `plugin-shader`) at **0.000%** diff, proving preview == export == Remotion for a real user shader. `scene:compare` 22/22 (the DOM-parity gate correctly excludes `plugin-shader` by default — the DOM renderer has no fragment-shader pass, so that comparison isn't meaningful; still available via `PIXEL_FIXTURES=plugin-shader` for manual inspection). Example manifest: `examples/plugin-manifests/invert.effect.json`.
- **`.orreris` ZIP packages with embedded media:** new `packages/shared/src/plugin-package-zip.ts` (fflate) builds/parses a `.orreris` ZIP (`manifest.json` + `timeline.json` + `assets/<id>.<ext>` + optional `previews/`), detected by ZIP magic bytes so bare `.orreris-template.json` keeps working. Editor: Shift+click the export-template-package button for the ZIP-with-media path (reads bytes from the local blob store or `fetch(fileUrl)`); import creates real local assets per embedded file and remaps `layer.assetId` (root + `graph.compositions`) to the new ids — no relink-by-warning. Example: `examples/plugin-manifests/sample-template.orreris`.
- **Gates green:** `pnpm -r typecheck`, `editor:test` (incl. new zip round-trip + fixture asserts), `scene:compare` 22/22, `render:compare:pixels` 24/24 @ 0.000%.
- Files touched: `packages/shared/src/color/fragment-effects/registry.ts` (new), `color/scene-compositor.ts`, `color/index.ts`, `scene/build-scene-draws.ts`, `types.ts`, `effects.ts`, `plugin-effect-adapter.ts`, `plugin-manifest.ts` (none needed — `webgl-fragment`/`vec2`/`vec3` param types already existed), `plugin-safety.ts` (added `webgl-fragment` to supported-engine check), `plugin-package-zip.ts` (new), `index.ts`; `apps/web/src/pages/EditorPage.tsx`, `apps/web/src/editor/effects/pluginManifestStore.ts`, `apps/web/src/lib/asset-blob-store.ts` (import only); `apps/worker/src/remotion/SceneStage.tsx`, `apps/worker/src/scene-compositor-compare.ts`; `examples/plugin-manifests/invert.effect.json` + `sample-template.orreris` (new); `apps/web/src/editor/editor.test.ts`.

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
  --filter @orreris/worker skills:test`).
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
  buffer `orreris.crashLog` (survives hard crashes); next boot surfaces the previous session's tail;
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

- **Multi-accent theme system**: `data-orreris-theme` attribute on `.editor-page` + a topbar Theme picker
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

- `apps/web/src/editor/performance/sourceProxyStore.ts` — OPFS `orreris-source-proxies/` (`<assetId>.mp4`
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
`?wcDecode=0` / `orreris.wcDecode="0"` / `VITE_WC_DECODE=0` are now the kill switches). Evidence: days of
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
  `orreris_asset_expanded_bins`), twisty + folder-open icon, click toggles / double-click opens, files indent
  one step inside their parent (thumb carries the indent; first grid column is max-content so the data
  columns stay aligned). Flat list for search / non-folder tabs.
- **Bins nest by drag-and-drop**: bin rows (list) and bin tiles are draggable
  (`application/x-orreris-asset-folder`); dropping bin A on bin B (or a breadcrumb) re-parents A's whole
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
  scheduling / single-context preview grading). **P1 SHIPPED**: `__ORRERIS_RENDER_FINGERPRINT__` — vite
  build-time sha1 of the render-critical sources (list in vite.config.ts — keep it in sync when adding
  render-affecting modules!) folded into `baseCompositionSignature`, so any decoder/compositor/effects code
  change auto-invalidates cached spans; the manual `PREVIEW_PROXY_RENDER_VERSION` stays as coarse fallback.
- **GL context governor made enableable mid-soak** (user hit GL ctx 15 ≈ Chromium's ~16 force-loss): budget
  now settable (`setGlContextBudget`, shared defaults 3/4 kept for governor:test; web app boots 8/12) and
  eviction is RECOVERABLE (disposer no longer stops the WC rAF frame loop — evicted layers recreate on next
  draw). User instructed to set `orreris.glGovernor=1`. Root cause (4K stills ≈ 64–90MB GPU each, per-layer
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
  Duration/Size/Used) with click-to-sort headers (persisted `orreris_asset_sort`/`_dir`), dense zebra rows,
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
- **User-session note**: `orreris.wcDecode=1` persisting from the soak explains fast-forward
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
`setAdaptiveQualityOn` (persists to the existing `orreris.adaptiveQuality` key, releases the cap
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
- Gates run: `pnpm --filter @orreris/web typecheck`, `pnpm --filter @orreris/web editor:test`.
- Chrome/Playwright responsive smoke captured `1920x1080`, `1440x900`, `1280x800`, `768x1024`, `390x844`, and `430x932` under `apps/worker/tmp/responsive-layout/`; horizontal overflow is 0 in the verified tablet/phone modes.

### 2026-07-03 - Codex: custom dropdown sweep

- Replaced the remaining native JSX dropdown (`EffectPresetRow` presets) with the shared `ThemedSelect` component.
- Polished the shared dropdown trigger/menu styling so existing custom dropdowns get a cleaner dark menu, hover, and active state.
- Verified no user-facing JSX `<select>` remains outside `ThemedSelect`.
- Gates run: `pnpm --filter @orreris/web typecheck`, `pnpm --filter @orreris/web editor:test`.

### 2026-07-03 — Claude: pro-floor feature batch (presets, markers, SPEED, mixer+pan, pre-warm, cloud audio post-mix)

- **Effect presets**: shared `snapshotLayerAttributes`/`applyLayerAttributes`/`applyAttributesToLayer`
  (timeline-ops); web store `editor/effect-presets.ts` (localStorage `orreris.effectPresets`); UI row in
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
- Gate run: `pnpm --filter @orreris/web typecheck`.

### 2026-07-03 - Codex: asset-bin drag-and-drop upload/import

- Local/Brand asset panels now accept dragged files; media files upload to the asset library.
- Dropped `.prproj`, `.edl`, `.fcpxml`, `.xml`, `.json`, and `.orreris-template` files in the main Assets panel route through the existing timeline/template import flow.
- File picker now supports multi-select and the same media/import file routing in the main Assets panel.
- Gate run: `pnpm --filter @orreris/web typecheck`.

### 2026-07-03 - Codex: timeline whole-track reorder handles

- Added a drag handle to the left track label rail; dragging it onto another compatible track reorders the entire track with all its layers intact.
- Track reordering is constrained within visual-vs-audio families, so audio stays below visual tracks while V tracks and A tracks can be rearranged internally.
- Added drop-position styling on the track header rail.
- Gates run: `pnpm --filter @orreris/web editor:test`, `pnpm --filter @orreris/web typecheck`.

### 2026-07-03 - Codex: timeline Ctrl+A selects all clips

- Added Ctrl/Cmd+A in the editor keyboard handler to select every timeline layer while preserving normal text selection inside inputs, textareas, selects, and contenteditable fields.
- Gate run: `pnpm --filter @orreris/web editor:test`.
- Note: `pnpm --filter @orreris/web typecheck` is currently blocked by unrelated `VideoPreview.tsx` audio prop/helper errors (`trackGain`, `getTrackAudioGain`, `getTrackPan`).

### 2026-07-03 - Codex: editor toolbar import button order

- Swapped the top editor toolbar template/timeline controls so Import timeline/template appears before Export template package.
- Gate run: `pnpm --filter @orreris/web typecheck`.

### 2026-07-03 - Codex: `.prproj` successful sequence selection no longer unsupported

- Moved `prproj.multiple_sequences` from Unsupported to Mapped because the importer now intentionally selects the clip-heavy sequence and preserves nested sequence links.
- Verified the user's `Visualizer_Slideshow.prproj` report now has `unsupportedCount: 0`.
- Gates run: `pnpm --filter @orreris/shared typecheck`, `pnpm --filter @orreris/web editor:test`.

### 2026-07-03 - Codex: `.prproj` nested sequence import foundation

- Added optional `ProjectGraph.compositions` and `TimelineLayer.nestedCompositionId` so imports can preserve Premiere nested sequences as linked Orreris compositions.
- The `.prproj` object fallback now catalogs every sequence, links parent clips whose SubClip/MasterClip name matches a sequence, and stores nested timelines alongside the root composition.
- Obvious Premiere `Graphic` title clips import as native Orreris text layers with editable placeholder text, ready for later private-data text/animation decoding.
- Verified the user's `Visualizer_Slideshow.prproj`: root `Work` sequence imports 20 clips, 15 nested sequence links, 12 compositions, and 10 native text layers.
- Gates run: `pnpm --filter @orreris/shared typecheck`, `pnpm --filter @orreris/web typecheck`, `pnpm --filter @orreris/web editor:test`.

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
- Gates run: `pnpm --filter @orreris/shared typecheck`, `pnpm --filter @orreris/web editor:test`.

### 2026-07-03 - Codex: real `.prproj` object-graph import hardening

- Hardened `.prproj` import for real Premiere project XML that stores sequences/tracks/clips as separate `ObjectID`/`ObjectUID` nodes linked by `ObjectRef`/`ObjectURef`, instead of nested timeline XML.
- Sequence import now resolves track groups -> track objects -> ref-only clip items -> actual clip objects; audio track fallback is authoritative when referenced clip objects omit an explicit media type.
- Empty sequence imports now add a clearer `prproj.no_clips` unsupported report with track/clip-ref counts and the Final Cut Pro XML fallback suggestion.
- Added editor-test coverage for referenced object-graph video/audio clips.
- Gates run: `pnpm --filter @orreris/shared typecheck`, `pnpm --filter @orreris/web editor:test`.

### 2026-07-03 - Codex: limited `.prproj` timeline import

- Added `.prproj` detection to the external timeline adapter and editor import picker.
- Browser import now accepts gzip-compressed `.prproj` files and plain XML `.prproj` files, then feeds decoded XML through the shared adapter.
- V1 imports the first readable Premiere sequence's video/audio clip timing, source in-points, media placeholders, and obvious Cross Dissolve transitions; reports multiple sequences, effects/components, nested sequences, invalid clips, and unmapped transitions.
- Added `examples/timeline-imports/simple-premiere.prproj`, docs tracker updates, and editor-test coverage.
- Gates run: `pnpm --filter @orreris/shared typecheck`, `pnpm --filter @orreris/web typecheck`, `pnpm --filter @orreris/web editor:test`.

### 2026-07-03 - Codex: smooth multi-select vertical drag

- Replaced DOM hover-based track targeting with pointer-delta/row-pitch targeting, so dragging through the gap between tracks no longer flips the target up/down.
- Selected clips now follow the pointer smoothly in Y while the destination track is snapped separately on release; all moved clips get the dragging state so CSS transitions do not lag behind the pointer.
- Gates run: `pnpm --filter @orreris/web typecheck`, `pnpm --filter @orreris/web editor:test`.

### 2026-07-03 - Codex: imported track placement + multi-select vertical track drag

- Append timeline imports now insert imported visual tracks above all existing visual tracks and keep audio tracks grouped below visuals.
- Multi-selected clip drags now preserve the selected clips' relative track spacing when dragged up/down, with per-clip target tracks and live vertical preview offsets; visual clips cannot be dropped into audio tracks and audio stays in audio tracks.
- Gates run: `pnpm --filter @orreris/web typecheck`, `pnpm --filter @orreris/web editor:test`.

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
- Gates run: `pnpm --filter @orreris/web editor:test`; web typecheck is currently blocked by Claude's claimed `scene-compositor.ts` region-effect work.

### 2026-07-02 - Codex: timeline import append, relink, and audio-track guards

- Timeline import report offers **Append to current** and **New timeline**.
- Append mode preserves the current composition and adds imported tracks after the existing timeline end with fresh IDs.
- Right-click `Replace asset...` keeps original clip start/track/duration and no longer creates companion audio while relinking.
- Asset-bin hover add buttons route to replacement while replace mode is active.
- New MP4/MOV uploads are tagged with detected audio presence; auto companion audio is only created when audio is present, and known no-audio videos disable audio-only/linked-audio actions.
- Gates run: `pnpm --filter @orreris/web typecheck`, `pnpm --filter @orreris/web editor:test`.

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
- Supports CMX-style `.edl`, FCPXML `.fcpxml`, and Final Cut/Premiere XML `.xml` imports into native Orreris compositions with media placeholder slots and import reports.
- Wired the editor top-bar Import timeline/template button to detect those files, show a report modal before applying, preserve existing project plugin manifests, and store the report in `editableFields.timelineImportReport`.
- Added manual examples in `examples/timeline-imports/`; updated `PLUGIN_ARCHITECTURE.md` and `architecture.md`.
- Gates run: `pnpm --filter @orreris/shared typecheck`, `pnpm --filter @orreris/web typecheck`, and shared smoke imports for EDL/FCPXML/XML.

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
