# Preview WebGL Context Budget Tracker

Goal: stop preview WebGL context loss during normal playback, backward seek, and replay by replacing ad hoc context ownership with a small, explicit context budget system plus adaptive preview caching.

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
- [ ] GPU preview recovers through a controlled reset path instead of console spam.
- [ ] Existing render comparison fixtures remain unchanged.

## Architecture Decision

- [ ] Use a deterministic context governor as the source of truth for preview WebGL ownership.
- [ ] Keep the governor local to preview/editor code first.
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

## Phase 2 - Context Governor

- [ ] Add a preview-only `GlContextGovernor`.
- [ ] Configure a conservative preview budget:
  - target active contexts: 2-3
  - hard cap: 4
- [ ] Make the governor responsible for:
  - allocating preview contexts
  - tracking ownership
  - disposing inactive renderers
  - refusing nonessential context creation over budget
  - logging the oldest/least valuable context before eviction
- [ ] Prefer shared-context renderers where possible.
- [ ] Keep one root `SceneCompositor` context for final preview composition.
- [ ] Avoid per-layer WebGL contexts for clips that are outside the active lookahead window.
- [ ] Do not let backward seek create duplicate renderers for the same layer/time range.

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

- [ ] Build a deterministic dirty interval model.
- [ ] Split cache spans by real dependency boundaries, not fixed 10 second windows.
- [ ] Add long-timeline proxy/render-cache mode to keep old timeline ranges as media assets, not live WebGL producers.
- [ ] Choose cache span length adaptively from:
  - source clip duration
  - effect density
  - overlay density
  - transition boundaries
  - recent seek/playback behavior
  - device performance and available storage
- [ ] Use one active live-preview GPU window around the playhead and nearby edit range.
- [ ] Keep distant clean ranges as decoded proxy video/image spans.
- [ ] Never allocate one WebGL context per cached span.
- [ ] Store proxy spans as files/blobs with metadata:
  - timeline fingerprint
  - source dependency ids
  - time range
  - render scale/quality
  - invalidation version
- [ ] Use larger spans for simple continuous clips.
- [ ] Use smaller spans around dense edits, transitions, overlays, and effects.
- [ ] Store cached spans as browser-managed media assets:
  - OPFS or IndexedDB-backed blobs
  - LRU eviction by size and recency
  - metadata keyed by timeline fingerprint
- [ ] Positive edits should invalidate only affected overlay/composite spans where possible.
- [ ] Negative edits, trims, deletes, or time shifts should invalidate the affected base span and downstream dependency spans.
- [ ] Preview playback should prefer:
  - valid cached span
  - live GPU render for active edit range
  - DOM fallback only as last resort
- [ ] Cache playback must not allocate one WebGL context per span.
- [ ] Background cache renderer must obey the same context governor as preview.
- [ ] Cache writer must pause when active preview contexts reach the target budget.
- [ ] Cache writer may resume when preview is idle or under budget.

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
- [x] `pnpm --filter @reelforge/web build`
- [x] `PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @reelforge/worker scene:compare`
- [x] `PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @reelforge/worker render:compare:pixels`

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
- [ ] Phase 2: context governor skeleton and debug snapshot.
- [x] Phase 3: producer canvas safety.
- [x] Phase 4: renderer lifecycle fixes for seek/replay.
- [x] Phase 5: upload failure semantics cleanup.
- [ ] Phase 6: adaptive preview cache design and minimal prototype.
- [ ] Phase 8: local export black-clip investigation.

## Notes

- Browser/WebGL guidance consistently favors reusing a small number of contexts and treating context loss as a normal recoverable event.
- Professional video editors use render caches/proxies, but their cache spans are driven by edit dependencies and invalidation rules, not by one live renderer per time slice.
- The immediate fix is not "more guards"; it is clear ownership of GPU contexts, producer canvases, and cached preview assets.
