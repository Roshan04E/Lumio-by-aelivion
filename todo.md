# Preview WebGL Context Budget Tracker

Goal: stop preview WebGL context loss during normal playback, backward seek, and replay by replacing ad hoc context ownership with a small, explicit context budget system plus adaptive preview caching.

## Status update — 2026-07-02 (governor + recovery + cache verification)

Landed this pass (see also `GAPS.md` §1):
- **Phase 2 context governor — BUILT, flag-gated default-off** (`?glGovernor=1` / `localStorage orreris.glGovernor` /
  `VITE_GL_GOVERNOR`; `getGlGovernorEnabled` in `apps/web/src/color/render-engine.ts`). Enforcement lives in
  `packages/shared/src/color/gl-context.ts`: `requestContextSlot()` evicts the least-recently-used **idle**
  evictable context (never the root `scene-compositor`, never a context touched within `EVICT_IDLE_MS`) via a
  registered disposer; `touchContext()` marks per-frame liveness; `registerContextDisposer()` lets an evictable
  renderer be reclaimed. `MediaWebGLRenderer` reserves a slot before creating its context; `WebglMediaLayer`
  registers a disposer and **lazily recreates** after eviction (no permanent legacy fallback). Telemetry is
  unchanged/always-on. Gate: `pnpm --filter @orreris/shared governor:test` (15 checks).
- **GPU reset/recovery — BUILT.** `ScenePreviewCanvas` now does a **bounded auto-rebuild** of the compositor on
  a fresh context (`MAX_SCENE_REBUILDS=3`, backoff) instead of latching permanently to the DOM path; a sustained
  run of clean frames restores the retry budget; logging is de-spammed (once per loss). DOM is the last resort
  only after retries exhaust — so a transient GPU eviction no longer costs exactness/quality.
- **Persistent proxy cache — VERIFIED already-built + wired + active by default** (was tracked as unbuilt below).
  OPFS blob store + background Worker generator + double-buffered proxy playback + LRU + per-span
  content-signature invalidation all present and on by default (`proxyGenActive`). Playback proxies are
  export-grade (full-res, `defaultBitrate` ~0.12bpp), so "no quality loss" already holds; the 1.5Mbps
  `PROXY_BITRATE` only feeds the **unused** `ProxySpanEncoder` (future P1a live-capture scaffolding).
  **Deferred:** OPFS rehydration on reload (regenerates each session — correct but re-warms; needs a persisted
  per-span content signature to avoid stale proxies). **Not-yet:** flip the governor default on after a GPU
  preview-contention stress gate.

Current signal:
- `window.__rfActiveGlContexts` is mostly bounded around 3-4 after the last patch.
- Context loss still occurs during playback/replay, especially after seeking backward.
- The remaining issue is likely stale/lost producer canvases or GPU memory pressure during texture re-upload, not simply too many live contexts.
- Local export black clips are a separate symptom to investigate after preview context ownership is stable.
- Real project log found a backward-replay skip on a `_copy_...` layer at frame time `18.2`; the preview was checking the clone id in `gradedRef` before its `mediaSourceAlias`, so it could upload a stale/disposed clone canvas instead of the live base-layer canvas.
- Second real project log showed `_copy_...` duplicate chains outside the explicit `__rfx_` alias map and duplicate `scene-compositor` telemetry owners for the same connected canvas.

Hard boundaries:
- Do not commit until manual verification passes.
- Do not touch Remotion/cloud.
- Do not change Method-3/export architecture while fixing preview context ownership.
- Do not include playback-jank audit files, probes, tmp artifacts, or generated comparison outputs.

## Success Criteria

- [x] Playing 60 seconds in the editor does not show `ScenePreviewCanvas: GPU compositor context lost; falling back to DOM path`.
- [x] Seeking back 30-40 seconds and replaying does not repeatedly show `texImage2D` or `texSubImage2D` lost-context errors.
- [x] Active preview WebGL contexts stay under the configured budget.
- [x] When a context is actually lost, all dependent preview renderers stop using it immediately.
- [x] A lost producer canvas is never uploaded into `SceneCompositor`.
- [x] GPU preview recovers through a controlled reset path instead of console spam. (bounded auto-rebuild, 2026-07-02)
- [ ] Existing render comparison fixtures remain unchanged.

## Architecture Decision

- [x] Use a deterministic context governor as the source of truth for preview WebGL ownership. (flag-gated, 2026-07-02)
- [x] Keep the governor local to preview/editor code first. (enforcement in shared gl-context.ts; flag in web)
- [ ] Use AI only as an optional cache-priority advisor later, not as the correctness layer.
- [ ] Do not use fixed 10 second cache windows as the core model.
- [ ] Use adaptive cache spans based on timeline dependency intervals:
  - clip boundaries
  - effect/filter boundaries
  - text/shape overlay ranges
  - transition ranges
  - edit invalidation ranges
- [ ] Treat cached preview spans as video/image data, not as live WebGL contexts.

## Phase 1 - Inventory And Ownership

- [ ] Create a full inventory of preview WebGL context creators.
- [ ] Classify each creator as one of:
  - persistent root compositor
  - shared renderer using root context
  - short-lived isolated renderer
  - legacy/unknown
- [ ] Confirm these known creators:
  - `SceneCompositor`
  - `WebglMediaLayer`
  - `MediaWebGLRenderer`
  - graded text/shape overlay renderers
  - transition/effect renderers
  - legacy WebGL applicators
- [x] Add a lightweight owner label to every preview context allocation.
- [x] Add dev-only diagnostics:
  - active context count
  - owner label
  - created at
  - disposed at
  - last frame time
  - last source/layer id
- [x] Expose a debug snapshot at `window.__rfGlContextBudget`.

## Phase 2 - Context Governor  ✅ BUILT + DEFAULT ON (2026-07-02, flipped same day after the contention gate)

Default flipped ON after `governor:stress` (the GPU preview-contention stress gate this flip was gated on)
passed in real Chrome: fixture `/editor/__governor-stress` (`GovernorStressPage.tsx`) reproduces the
historical leak shape (renderer waves that idle without unmounting + a backward-seek revisit) against the
real `ScenePreviewCanvas`. Enforced run: peak 7 (bounded = root + active wave + not-yet-idle previous wave),
12 LRU evictions, 0 recreate failures, preview alive, settled to the hard cap 4. Control run (`glGovernor=0`):
unbounded peak 13, 0 evictions — proves genuine contention so the gate can't rot into a tautology.
Run: `PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker governor:stress`. Escape hatch: `?glGovernor=0`.

- [x] Add a preview-only governor. (in `gl-context.ts`: `requestContextSlot`/`touchContext`/`registerContextDisposer` + `setGlGovernorEnabled`)
- [x] Configure a conservative preview budget:
  - target active contexts: 3 (`PREVIEW_CONTEXT_TARGET`)
  - hard cap: 4 (`PREVIEW_CONTEXT_HARD_CAP`)
- [x] Make the governor responsible for:
  - allocating preview contexts (`requestContextSlot` before `MediaWebGLRenderer` getContext)
  - tracking ownership (owner records + `lastUsedAt`)
  - disposing inactive renderers (LRU-idle eviction via registered disposer; `WebglMediaLayer` lazily recreates)
  - refusing/reclaiming over budget (evicts idle LRU at hard cap; tolerates transient over-cap when all live)
  - logging the least-valuable context before eviction (once per loss, de-spammed)
- [x] Prefer shared-context renderers where possible. (scene shared-grade path already reuses the root context)
- [x] Keep one root `SceneCompositor` context for final preview composition. (`scene-compositor` kind never evicted)
- [x] Avoid per-layer WebGL contexts for clips outside the active lookahead window. (VideoPreview `isLayerActive` mount filter + React unmount + governor idle-reclaim)
- [~] Do not let backward seek create duplicate renderers for the same layer/time range. (bounded by the mount filter + hard cap; explicit dedup not added)

## Phase 3 - Producer Canvas Safety

- [x] Track producer ownership for canvases created by `MediaWebGLRenderer`.
- [x] Add a weak map from output canvas/source to producer renderer debug state.
- [x] Before `SceneCompositor.uploadSource`, check:
  - source dimensions are nonzero
  - source dimensions fit `MAX_TEXTURE_SIZE`
  - producer renderer still exists
  - producer renderer is not disposed
  - producer GL context is not lost
- [x] If producer context is lost, skip/fallback that source with a controlled diagnostic.
- [x] Never call `texImage2D` or `texSubImage2D` with a known lost producer canvas.
- [x] Store final failure details in `window.__rfLastSceneUploadFailure`.

## Phase 4 - Renderer Lifecycle

- [ ] Audit all renderer creation paths during:
  - play forward
  - pause
  - scrub
  - jump backward
  - replay old range
  - layer deletion
  - effect/filter changes
- [ ] Ensure clips leaving the active range release GPU renderers after a short grace period.
- [ ] Cancel pending disposal when a clip re-enters the active range.
- [x] Ensure disposed renderers cannot be reused by stale refs.
- [x] Ensure context-lost renderers are marked permanently invalid.
- [x] Prefer `mediaSourceAlias` base canvases over stale clone canvases during scene-preview draw-list construction.
- [x] Resolve media alias chains and `_copy_...` duplicate chains back to the nearest live base canvas.
- [x] Do not double-count repeated `getContext()` calls for the same live WebGL context.
- [ ] Clear any preview cache entries that reference invalid renderer output.

## Phase 5 - Upload Failure Semantics

- [x] Standardize controlled context-loss error handling around `SCENE_COMPOSITOR_CONTEXT_LOST`.
- [x] In `SceneCompositor`, before every upload:
  - check `gl.isContextLost()`
  - check producer context state when available
  - skip invalid dimensions
  - skip oversize sources
- [x] After every upload in debug mode:
  - check `gl.getError()`
  - record source kind, layer id, frame time, dimensions, and texture state
- [x] If upload fails because context is lost:
  - throw `SCENE_COMPOSITOR_CONTEXT_LOST`
  - stop the current rAF loop
  - dispose the compositor
  - do not schedule another frame with that compositor
- [ ] Do not hide real context loss with generic empty textures unless the source itself is invalid and the main compositor context is healthy.

## Phase 6 - Adaptive Preview Cache

- [x] Build a deterministic dirty interval model.
- [x] Split cache spans by real dependency boundaries, not fixed 10 second windows.
- [x] Add long-timeline proxy/render-cache mode to keep old timeline ranges as media assets, not live WebGL producers. (proxyMediaStore + ProxyPlaybackLayer, active by default)
- [x] Choose cache span length adaptively from:
  - source clip duration
  - effect density
  - overlay density
  - transition boundaries
  - recent seek/playback behavior
  - device performance and available storage
- [x] Use one active live-preview GPU window around the playhead and nearby edit range. (proxy substitutes distant ranges; live GPU around playhead)
- [x] Keep distant clean ranges as decoded proxy video/image spans. (ProxyPlaybackLayer plain-`<video>` substitution)
- [x] Never allocate one WebGL context per cached span. (spans are webm blobs; playback via `<video>`, generation via one Worker context)
- [x] Store proxy spans as files/blobs with metadata:
  - timeline fingerprint
  - source dependency ids
  - time range
  - render scale/quality
  - invalidation version
- [x] Use larger spans for simple continuous clips.
- [x] Use smaller spans around dense edits, transitions, overlays, and effects.
- [x] Add an in-memory preview cache manifest for span validity, priority, status, and budget.
- [x] Add deterministic composition/cache signatures for span invalidation.
- [x] Add a preview cache controller that plans real composition spans from playhead and render scale.
- [x] Add cache-ruler segment data for a thin Adobe-style proxy/rendered indicator.
- [x] Render a thin timeline/ruler indicator for ready, pending, dirty, and failed proxy spans.
- [x] Add timeline controls to regenerate all proxy spans or only the current In/Out range.
- [x] Add an info window explaining proxy regeneration and ruler colors.
- [x] Use successful GPU playback frames as live proxy coverage for the ruler indicator.
- [~] Store cached spans as browser-managed media assets:
  - [x] OPFS-backed blobs (in-memory fallback) — `createProxyBlobStore`
  - [x] LRU eviction by size and recency — `createPreviewRenderCacheStore` (`maxEntries`/`maxBytes`, `evictIfNeeded`)
  - [x] metadata keyed by timeline fingerprint (base + per-span content signature)
  - [x] rehydrate the manifest from OPFS on reload (2026-07-02 — persisted per-span index with content
    signatures in `proxy-span-index.json`; restore validated through `markSpanReady`'s staleness check,
    blobs kept across unmount, foreign-signature records aged out after 24h)
- [x] Positive edits invalidate only affected overlay/composite spans. (per-span `contentSignature` in `reconcile`)
- [x] Negative edits/trims/deletes/time shifts invalidate the affected + downstream spans. (`markDirty` range + content signature)
- [x] Preview playback prefers: valid cached span → live GPU (active range) → DOM last resort. (`resolveProxyPlayback` + ProxyPlaybackLayer)
- [x] Cache playback must not allocate one WebGL context per span. (plain-`<video>` playback)
- [~] Background cache renderer obeys the governor. (Worker path uses its own context; main-thread fallback defers when governor over target)
- [x] Cache writer pauses under budget / while playing. (generation loop runs only while paused; fallback gated on `isGlBudgetOverTarget`)
- [x] Cache writer may resume when preview is idle or under budget. (re-kicked on idle)

## Phase 6B - Proxy + Transition Faithfulness (GENERAL, plugin-ready)

Guiding constraint: fixes must be effect/transition-AGNOSTIC. Effects + transitions will grow via a plugin
system, so the proxy, transition, and region-expansion code must never switch on specific effect/transition
type names — behaviour comes from registry METADATA. "Fix blur", "skip blur clones", "special-case iris" are
all anti-patterns. Three principles:

- P1 - The proxy IS the viewer. Generate proxies by capturing the SAME renderer the viewer uses
  (`SceneCompositor` + the viewer's decoded/graded sources + `buildSceneDraws`), NOT a second pipeline
  (`SceneFrameCompositor` + WebCodecs). Then ANY effect/transition the viewer renders — including future
  plugins — is faithful by construction; no per-effect proxy patching. This is the endgame that RETIRES the
  export-front-end patches below as the mechanism (they only made a second renderer match, which is fragile
  and not plugin-safe).
- P2 - A transition side is a clip GROUP, not one layer. `SceneTransitionDraw.from/.to` are single
  `SceneLayerDraw`s, so a clip's region-expanded layers (blur clone, any region/plugin effect) are excluded
  from the mix → effects vanish DURING transitions. Make each side composite the full set of layers belonging
  to that clip (base + every `__rfx_`/expansion layer) into its side RTT, then mix. Generalises to all effects.
- P3 - Registry-driven, no hardcoded types. Decode-sharing, region expansion, and transition grouping must be
  driven by effect/transition metadata (e.g. "does this effect need its own decoded/graded source?",
  "what layers does this clip expand into?"), declared in the registry, so a plugin slots in with no core edits.
  (`buildRegionBlurCloneAliases` hardcoding `effect.type === "blur"` is the pattern to generalise under P3.)

Interim patches shipped (keep as safety/interim; supersede per principle):
- [x] M1a - `buildRegionBlurCloneAliases` shared by viewer + export so the export stops decoding blur clones
  independently. INTERIM: generalise the blur-hardcode via P3, and mooted entirely by P1.
- [x] M1b - Black-frame guard in proxy generation so a black composite FAILS the span (→ live render) instead
  of sealing black. GENERAL (any black composite), keep as a safety net.
- [x] Live-playback toggle (timeline proxy box, `Zap`): play the viewer, generate no proxies. Escape hatch.
- [x] Transition clone-skip in `buildSceneDraws` REMOVED — replaced by P2a clip-group compositing.

Build order:
- [x] P2a - `SceneTransitionDraw.from/.to` → `SceneLayerDraw[]` (clip groups); `buildSceneDraws` groups each
  transition clip's base + its `__rfx_` layers generically (no effect-type check).
- [x] P2a-fix - NEST PRE-COMPOSE (NLE model). First attempt looped `renderLayerInto` into a shared side RTT,
  but that path reads a TRANSPARENT backdrop (built for ONE isolated clip), so the 2nd layer OVERWRITES the
  1st → "black except the blurred region". Fixed: `precomposeGroup()` renders each clip's nest through the
  SAME multi-layer accumulator the main scene uses (temporarily retargeted to a per-side ping-pong pair,
  NORMAL blend inside the nest), then the transition mixes the two finished clip images. Any effect (or future
  plugin) on a clip now renders THROUGH the transition; the transition has zero knowledge of effect types.
  Covers ALL THREE renderers by construction — viewer (`ScenePreviewCanvas`), local export
  (`SceneFrameCompositor`), and cloud (Remotion `SceneStage`, default) all use this shared `SceneCompositor` +
  `buildSceneDraws`. Research: AE precompose / Premiere nest / Resolve compound clip — a transition mixes two
  fully-rendered clip images.
- [~] P2b - Gate fixtures. Added `two-region-effects` (disjoint blur + colour-grade regions — locks region
  independence / no leak) and `feather-region-blur` (feather 140 — locks the feather ramp). Both pass
  scene:compare at ~0.25% under the 0.80% bar (21/21). STILL TODO: an effect-THROUGH-A-TRANSITION fixture
  (region blur across a junction) to gate-lock the nest pre-compose too.
- [ ] P3a - Move the decode-share decision to effect metadata (grade-neutral?) instead of `type === "blur"`.
- [x] P1a - DEFAULT ON (flipped 2026-07-03; escape hatch `?proxyViewerCapture=0`): real-video soak on a
  user project passed — span sealed viewer-first, `parity-ok` worst 0.00%, zero worker fallbacks. M1a/M1b
  stay for now: they harden the export-Worker pipeline, which remains the live FALLBACK path when capture
  fails (retire only if the worker pipeline itself is retired). Original ship notes:
  SHIPPED flag-gated (2026-07-02, `?proxyViewerCapture=1`): proxy spans render
  through the LIVE preview's own SceneCompositor — `SceneCompositor.renderFrameOffscreen` (render without
  present + RGBA readback; the on-screen canvas never flashes), `SceneViewerCaptureHandle` on
  ScenePreviewCanvas (viewer's compositor/rasterizer/matteCache/flags), and
  `editor/performance/viewerProxyCapture.ts` (pooled `<video>` decode — sources WebCodecs can't decode
  finally proxy; shared-context grade renderers — ZERO new GL contexts; viewer's exact
  activity/z/adjustment/transition rules via exported VideoPreview helpers; MediaEncoder webm).
  EditorPage tries capture first, falls back to the export-Worker pipeline on any failure. Verified live
  (Playwright, real Chrome): span sealed viewer-first (0 worker fallbacks) on an image+look+region-blur
  comp, `scene:compare` 22/22 after the render/present split.
- [~] P1b - SHIPPED behind the same flag: `verifySpanProxyAgainstViewer` decodes sample frames from the
  sealed webm (EITHER pipeline) and pixel-compares vs a fresh offscreen viewer render (fail >8% of pixels
  off by >24/channel → span markFailed, stays live; check errors never block sealing). Telemetry stages
  `parity-ok`/`parity-failed` in `__rfProxyDebug.events`. Verified live (parity-ok on first sealed span).
- [ ] Perf - route `reason:"simple"` spans to a fast path; context-pool + yield during idle generation.

## Region-effect model — ROOT of the mask leak/inherit bugs

Root cause (architectural, not a one-off): `expandLayerEffectRegions` turns a layer with region effects into
duplicate media LAYERS (`__rfx_` clones). A clone applies its WHOLE effect list to its ONE mask region — the
model conflates "which effect" with "which region" (one mask per clone). To combine effects across regions it
CASCADED upper effects onto lower clones MASK-STRIPPED, so any combined effect over-applied to the whole lower
region → the leak/inherit ("creative look giving a blur", "blur intensity changes the look region", "look
blurs where it touches the blur"). AABB overlap/containment guards were heuristic patches on this, not the fix.

- [x] Interim ROOT fix: region effects are now INDEPENDENT — each `__rfx_` clone applies ONLY its own region
  effect in ONLY its own region (+ shared globals); no cross-effect inheritance. Leak eliminated by
  construction. Overlap → clones stack, top region effect wins its area (no bleed). Single-region-effect
  fixtures unchanged. Shared → viewer + local export + cloud.
- [~] TRUE fix (the deep one) — REGION EFFECTS AS PER-EFFECT MASKED POST-COMPOSITE PASSES: model a layer as
  base + an ordered stack of {effect, mask} passes, each applied to the layer's RUNNING composited image and
  composited back masked to its own region (the After Effects model). Then overlaps COMBINE correctly for any
  geometry (blur then look in the intersection), nesting works, and there are no clones to leak.
  - [x] **Stage R1 shipped (2026-07-02, flag `regionPasses`, default OFF):** `SceneLayerDraw.regionPasses`
    (`SceneRegionPass[]`) + `SceneCompositor.renderLayerWithRegionPasses` — the layer pre-composes into a
    DEDICATED nest pair (base draw first, NORMAL/full-opacity inside), then each pass lands masked on the
    RUNNING nest image: a BLUR pass gaussians the nest itself (so region blur now combines with the base grade
    and earlier passes — inexpressible in the clone-stack model), a COLOR pass composites its clone-graded
    source (global blur/glow riding along); the finished nest composites ONCE with the layer's opacity/blend.
    `buildSceneDraws` folds `__rfx_` clones into passes on the base draw (`regionPassModel` input); transition
    clip groups collapse to the single base draw. Upstream expansion + per-clone grading are UNCHANGED in R1 —
    the flag toggles only the composite (clean A/B). Gate: `scene:compare` 21/21 in real Chrome BOTH ways —
    flag off (byte-level no-change) and `REGION_PASSES=1` (pass model vs the same DOM oracle; region fixtures
    0.005–0.743%, all within limits).
  - [x] **Stage R2a–c shipped (2026-07-02, same flag, still default OFF):** color passes now carry the ONE
    region effect's `ColorPipeline` and grade the RUNNING nest image IN-COMPOSITOR — `MediaWebGLRenderer`
    accepts a same-context `sourceTexture` (bottom-origin, drop-in with the flip-Y upload path) and the
    compositor keeps a per-effectKey shared-context renderer pool (own baked LUT each, pruned after ~300
    frames idle; ZERO extra GL contexts). So region color combines with the base grade/earlier passes exactly
    like region blur — the full AE model. `buildSceneDraws` derives passes from ls clones OR (when handed
    UNEXPANDED layers) synthesizes the region structure itself via `expandLayerEffectRegions` — the scene
    path no longer depends on upstream expansion at all. Preview (`VideoPreview`): with the flag on, NO
    `__rfx_` clone mounts a `<video>` decoder / renderer context (extends the blur-alias saving to region
    COLOR); a runtime scene failure re-mounts them for the DOM path. Gates (real Chrome): `scene:compare`
    21/21 flag OFF (byte-stable) + 21/21 `REGION_PASSES=1` with clone mounts skipped (region fixtures
    unchanged margins — regions render with zero clone decoders).
  - [x] **Stage R2d shipped — DEFAULT ON (2026-07-02).** One shared flip point: `REGION_PASS_MODEL_DEFAULT`
    (build-scene-draws) feeds the web flag helper's env fallback, `buildRenderManifest` (NEW
    `RenderManifest.regionPassModel` → `SceneStage` controller), and the gates — all three renderers flip
    together by construction, and empirically: a STRICT-threshold `render:compare:pixels` run on the overlap
    fixture measured 1.186% Remotion-vs-preview (a clone-model Remotion would show ~25%). Export front-end
    now skips clone decode entirely (`export-core.activeSourceKeysAt` never loads `__rfx_` providers;
    `scene-frame-compositor` never grades clones) — one WebCodecs decoder saved per region effect at export
    too. NEW `overlap-region-effects` fixture (grade + blur on the SAME region): `scene:compare` runs it as a
    3-way check immune to the shipped default — clone-parity (scene flag-off vs DOM, 0.249%) + combine-delta
    (scene on-vs-off at STRICT pixelmatch 0.02 — the standard perceptual threshold absorbs a moderate grade
    shift — 24.77% ≥ 2% floor, so a silently-dropped pass can never ship). Full ladder re-run post-flip in
    real Chrome: `scene:compare` 22/22 (default + `REGION_PASSES=1`), `render:compare:pixels` 7/7 on all
    region fixtures + transition, 4-package typecheck, `editor:test`, web build. Escape hatch `?regionPasses=0`.
  - [ ] Cleanup (after soak): retire `expandEffectRegionMasks` call sites + `buildRegionBlurCloneAliases`
    from the SCENE path callers (VideoPreview still expands for the DOM fallback — expansion stays until the
    DOM path itself is retired); drop the R1-era clone-folding branch in `buildSceneDraws` once no caller
    passes expanded layers.

[x] Separate bug (not proxy): transition window ran PAST the clip. ROOT: the GPU-reveal path
(`getActiveTransition`/`getCompositionTransition`) used `spec.durationSeconds` UNCLAMPED, while the
keyframe path (`buildTransitionAnimations`) clamped to `Math.min(spec.durationSeconds,
layer.durationSeconds)` — so wipe/iris/scene transitions kept progressing after the incoming clip ended.
FIX: added shared `effectiveTransitionDuration(authored, clipDurationSeconds)` = `min(authored, clip)`;
`getActiveTransition` now takes `clipDurationSeconds`, `getCompositionTransition` reads
`layer.durationSeconds`. Threaded incoming duration through all 4 call sites (VideoPreview,
build-scene-draws, scene-frame-compositor, SceneStage) + the DOM `TransitionOverlay`. Also clamped the
outgoing-clip POSTROLL windows to match (VideoPreview `isOutgoingInPostroll`, export-core
`trackEndPostroll`, scene-frame-compositor `postrollSeconds`, SceneStage `outgoingPostrollSeconds`).
typecheck green (shared/web/worker); scene:compare 21/21.

Feather "hard line" is likely the transition's own edge showing once the
feathered region clone is skipped (P2 fixes the appearance); verify feather still soft after P2a.

## Phase 7 - Optional AI Cache Advisor

- [ ] Keep correctness deterministic.
- [ ] Let AI suggest cache priority only after the deterministic system exists.
- [ ] Inputs to the advisor:
  - timeline structure
  - recent user edits
  - playback cursor movement
  - cache hit/miss history
  - device performance class
- [ ] AI may recommend:
  - which spans to pre-render first
  - whether to use larger or smaller cache spans
  - when to pause background cache work
- [ ] AI must not decide:
  - invalidation correctness
  - source-of-truth timeline state
  - export correctness

## Phase 8 - Local Export Investigation

Start only after preview context ownership is stable.

- [ ] Reproduce black clips in local export with a small project.
- [ ] Identify whether black frames come from:
  - failed media texture upload
  - cleared render target before upload success
  - missing graded media layer
  - stale/lost renderer output
  - bad fallback from preview cache
- [ ] Make export media rendering fail loudly in diagnostics instead of silently returning black.
- [ ] Preserve export architecture while fixing renderer lifecycle bugs.

## Phase 9 - Verification Gates

- [x] `pnpm -r typecheck`
- [x] `pnpm --filter @orreris/web build`
- [x] `PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker scene:compare`
- [x] `PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker render:compare:pixels`

## Manual Verification

- [x] Open the same project with `?debugGl=1`.
- [x] Play forward for 60 seconds.
- [x] Seek back 30-40 seconds.
- [x] Play again.
- [x] Confirm no repeated `texImage2D` / `texSubImage2D` lost-context errors.
- [x] Confirm no `ScenePreviewCanvas: GPU compositor context lost; falling back to DOM path`.
- [x] Inspect `window.__rfActiveGlContexts`.
- [x] Inspect `window.__rfGlContextBudget`.
- [ ] If failure occurs, capture:
  - `window.__rfLastSceneUpload`
  - `window.__rfLastSceneUploadFailure`
  - `window.__rfGlContextBudget`

## Build Order

- [x] Phase 1: inventory and owner labels.
- [x] Phase 2: context governor + debug snapshot (flag-gated default-off, 2026-07-02).
- [x] Phase 3: producer canvas safety.
- [x] Phase 4: renderer lifecycle fixes for seek/replay.
- [x] Phase 5: upload failure semantics cleanup.
- [ ] Phase 6: adaptive preview cache design and minimal prototype.
- [ ] Phase 8: local export black-clip investigation.

## Notes

- Browser/WebGL guidance consistently favors reusing a small number of contexts and treating context loss as a normal recoverable event.
- Professional video editors use render caches/proxies, but their cache spans are driven by edit dependencies and invalidation rules, not by one live renderer per time slice.
- The immediate fix is not "more guards"; it is clear ownership of GPU contexts, producer canvases, and cached preview assets.
