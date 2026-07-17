# Timeline

## v1 — Deliberate non-idiomatic performance architecture (standing, 2026-07-04)
**Problem:** Timeline gestures/selection/playhead re-rendered the 10k-line editor tree per event.
**Fix (DO NOT "FIX" BACK):** imperative gesture previews (trim/move write DOM directly, React
re-enters at commit only), playback clock tiers (hot leaves ride the clock store; cold panels ride
throttled <ColdTime>; NO EditorPage `currentTime` state — ref + clock only), startTransition
selection, no-op-click guard. Any agent tempted to re-Reactify these: read the
`timeline-perf-architecture-do-not-touch` memory first.

## v2 — Stale-transport gotcha for per-frame consumers (2026-07-06, near-miss)
**Problem class:** any per-frame consumer that reads the playhead from RENDER-time props freezes
when the render diet stops per-frame renders. `WebglMediaLayer.wcTimeRef` is set during render;
during clock-driven playback the layer still re-renders per clock COMMIT (16–90ms cadence), so it
currently stays fresh — but this was a prime suspect during the freeze hunt and is fragile.
**Rule:** per-frame machinery must read `getLivePlaybackTime()` / the clock store imperatively, not
props, if it ever needs sub-commit freshness or could outlive a render pause.

## v3 — Junction transition UX: params popover + drag-tile-to-cut + shared junction actions (2026-07-13)
**Problem:** transition parameters were unreachable where editors expect them — the on-cut junction
element only drag-resized duration and double-click-removed; the gallery emitted an
`application/x-kimera-transition` drag payload that NOTHING consumed; and the junction apply/remove
reducers lived as EditorPage-local functions the AI action surface couldn't call.
**Fix:**
- **Shared lift:** `applyJunctionTransition` / `removeJunctionTransition` / neighbor finders /
  `isJunctionTransitionKind` / `DEFAULT_CROSS_DISSOLVE_SECONDS` moved verbatim from EditorPage into
  `packages/shared/src/timeline-actions/actions/transition.ts`, plus two NEW registered actions:
  `setJunctionTransition` (open-union kind, validates the pair is touching neighbors) and
  `removeJunctionTransition` — AI/voice can now edit cuts through the one approved gate (`runReplace`
  wraps the immutable-return reducer).
- **Params popover** (`JunctionTransitionPopover.tsx`): a MOTIONLESS pointerup on the junction element
  opens it (drag still resizes — `CrossDragState.moved` 3px slop; double-click still removes and the
  popover SELF-CLOSES because it re-derives the spec from `composition` per render and clears itself
  when `transitionIn` disappears). Controls are schema-driven off `getTransition(kind).params`
  (never a kind switch — plugin transitions get params for free) with legacy-field folding: defs
  declaring `direction`/`reverse`/`softness`/`dipColor|flashColor|leakColor` edit the TOP-LEVEL
  `spec.direction/mode/softness/color` (and clear the raw override) via the new shared
  `resolveSpecParams` (composition-style.ts) so specs stay legible. Perf doctrine kept: all
  scrub-time state is popover-local draft; commits on release/change only → one
  `onAddCrossDissolve` → one undo step; zero strip re-renders during a slider scrub.
- **Drag-to-cut:** lane `dragover/drop` now consume the transition MIME. `getTrackCuts` derives ALL
  adjacent-pair cuts (junctionsByTrackId only lists cuts that already HAVE a transition — wrong set
  for drop targets). Nearest cut within a zoom-aware ~24px radius; highlight state is REF-GUARDED
  (setState only when the target cut changes, never per dragover event); drop builds the spec with
  the registry default duration and replaces any existing junction transition; plugin tiles pass
  their `manifest` through a new optional 4th arg on `handleAddCrossDissolve` (registered in the
  same `updateComposition`, mirroring `applyTransitionToClip`). Gallery `TransitionThumb` tiles are
  now draggable (`dragPayload` prop) — the tree rows already were.
**Verify:** typecheck 4/4 (shared/web/worker/api), shared `actions:test` all pass, web `editor:test`
all pass. Manual: click junction → popover; drag → resize only; dbl-click → removed + popover closes;
tile drag → indicator snaps to nearest cut only; occupied junction drop replaces.

## v4 — Multi-select: right-click preserved selection + group vertical move (2026-07-14)
**Problem (two bugs, one gesture surface):**
1. **Right-click collapsed a multi-selection.** Right-clicking a clip that was part of a
   multi-selection ran the full drag lifecycle — `startDrag` on pointerdown, then the motionless
   pointerup in `finishDrag` hit the `movedLayerIds.length > 1` branch and narrowed the selection to
   just the clicked clip. The context menu opened on the same gesture, so "Nest N clips" (and any
   `selectedLayerIds`-based group op) saw a single clip and vanished/misfired.
2. **Group vertical move collapsed onto one lane.** `getDragTrackPreview` clamped the shared
   `familyDelta` against only the PRIMARY clip's bounds, then re-clamped EACH clip's target lane
   independently to `[0, len-1]`. The moment any member hit the top/bottom track, that member pinned
   to the boundary lane while others kept moving → the group piled onto a single visual layer on
   release (also reproducible on a nominally-horizontal drag with a little vertical drift).
**Fix (`TimelineStrip.tsx`):**
- `startDrag` now bails on `event.button !== 0` — right/middle-click never enters the drag lifecycle,
  so the collapse-on-motionless-release path can't fire for a context-menu gesture.
- `handleClipContextMenu` owns selection for right-clicks: a clip already IN the selection keeps the
  whole group (group ops intact); a clip OUTSIDE it is focused (replace) first — Premiere/Resolve
  behavior. `selectionCount` is computed before the replace so it stays correct.
- `getDragTrackPreview` GROUP-clamps the vertical delta: intersect every moved clip's
  `[-index, len-1-index]` allowed range (per audio/video family) into one `[groupMin, groupMax]`,
  clamp the shared `familyDelta`/`visualDeltaPx` to it, then apply that single delta to all — no more
  independent per-clip re-clamp, so relative track spacing is preserved and one shared translateY
  keeps the group visually locked while dragging.
**Verify:** web typecheck clean. Manual: multi-select → right-click keeps group + "Nest N clips"
present; drag group up/down stays spaced and stops as a unit at the track edge; right-click an
unselected clip focuses just it.

## v5 — Single move resolver: preview + commit + AI share one pure engine (2026-07-14)
**Problem (root cause behind v4):** the drag PREVIEW (`getDragTrackPreview`/`moveDrag`) and the COMMIT
(`handleMoveLayer`) each computed a group move with subtly different clamps, and the `moveLayer` engine
action was single-clip only — three implementations of "where do these clips land", guaranteed to drift
(v4's track collapse + a horizontal t=0 compression bug both lived in this gap).
**Fix — one resolver, everything visualizes it:**
- **`resolveGroupMove(input)` + `applyGroupMovePlacements(comp, placements)`** (pure, framework-free,
  in `packages/shared/src/timeline-ops.ts`). RIGID on both axes: one shared time delta clamped so every
  affected clip stays ≥ 0 (and ≤ optional per-layer maxStart), one shared whole-row track delta clamped
  to the intersection of every member's `[-index, len-1-index]` family range. Linked companions of a
  member are pulled in as time-only followers (keep track), so A/V sync survives a group move. Returns
  `{ placements, appliedDeltaSeconds, appliedTrackDelta, trackDeltaBounds, valid, reason }`.
- **Engine action `moveLayers`** (`timeline-actions/actions/layer.ts`) wraps the resolver → AI /
  scripting move a multi-selection exactly as a hand drag does. `moveLayer` stays the 1-clip shorthand.
- **UI now only visualizes the resolver.** `moveDrag` calls `resolveGroupMove` for the preview (deriving
  left %, track lane, and one shared translateY from `trackDeltaBounds`); `finishDrag` + the stuck-drag
  window net pass the resolver's exact placements to commit via a new `targetStartByLayerId` arg on
  `onMoveLayer`; `handleMoveLayer` applies them verbatim through `applyGroupMovePlacements` (no delta
  recompute). Deleted `getDragTrackPreview` entirely. Legacy `handleMoveLayer` branches
  (moveLayerAndLinkedCompanions / single-track) remain only for non-drag callers (frame nudge, AI
  `moveLayer`).
- **Architecture note:** the "Edit Operation Engine" already exists as `timeline-actions/` (pure,
  reversible before/after + immer patches, zod-validated, replayable — the sanctioned AI mutation path).
  This slice routes the UI drag onto it instead of building a parallel engine. Trim/slip/slide/ripple
  are the same pattern next; editing policies (overwrite/ripple/reject/collision) belong IN the engine.
**Verify:** shared `resolver:test` (23 checks: group-down no-collapse, t=0 no-compression, linked
follower clamp, cross-family, no-op invalid, locked skip, apply relocates) + `actions:test` pass; web
`editor:test` passes; shared typecheck clean; web typecheck clean for all touched files (pre-existing
unrelated errors remain in GraphicsStackPanel's `selectedLayerId→selectedLayerIds` WIP migration).

## v6 — Trim family joins the operation engine (roll / slide / ripple-trim / slip) (2026-07-14)
**Context:** slice 2 of the "every timeline edit is a pure, registered operation" migration (v5 did move).
**Finding:** unlike move — where the UI had DUPLICATED the mutation inline — the trim family already
shares one source of truth: the editor's drag commit handlers (`handleRollEdit` / `handleSlideLayer` /
`handleRippleTrimAtPlayhead` / `handleSlipLayer`) call the shared pure ops in `timeline-ops.ts`
(`rollEditAtCut` / `slideLayer` / `rippleTrimLayer` / sourceIn set) directly. So there was NO
preview/commit divergence to fix — the gap was only that AI / scripting / undo-replay had no registered
actions for these edits.
**Fix:** added four engine actions in `timeline-actions/actions/clip.ts`, each WRAPPING the same pure op
(reversible before/after + immer patches, zod-validated, replayable):
- `rollEdit` (leftLayerId, rightLayerId, deltaSeconds, +optional trim limits) — rejects a non-touching pair.
- `slideClip` (layerId, deltaSeconds, +limits) — rejects a clip without touching neighbours on both sides.
- `rippleTrimClip` (layerId, atSeconds, side) — rejects an out-of-bounds trim time.
- `slipClip` (layerId, deltaSeconds) — relative source-in shift (floored at 0); complements the existing
  `trimClip`, which sets an ABSOLUTE sourceIn.
Optional `maxDurationsSeconds` / `minDurationSeconds` params thread the UI's per-asset caps through; AI
omits them and the ops fall back to composition length. Registered via `clipActions`.
**Deliberately NOT done:** re-routing the working UI drag handlers through the *registry* — they already
call the shared pure op (same as the v5 move UI calls `resolveGroupMove` directly rather than the
`moveLayers` action), so it's consistent, and churning shipped perf-sensitive trim paths buys no
correctness. Edge trim (`handleResizeLayer`) is left as-is too: it's source-aware + keyframe-squeezing
with no clean extractable op yet, and `trimClip` already covers the AI-facing raw trim. Both are the
natural next steps if/when we want full "UI never edits directly" coverage.
**Verify:** shared typecheck clean; `actions:test` — 15 new checks (roll extend + undo, slide + undo,
ripple shorten + undo, slip sourceIn, plus rejection paths for each) all pass alongside the existing suite.

## v7 — Editing-policy layer: overlap resolution as a policy seam (2026-07-14)
**Context:** roadmap step 3. Geometry (resolveGroupMove / rollEditAtCut / slideLayer / …) answers WHERE
clips go; POLICY is the separate question of whether that's allowed and how conflicts resolve. Pulling
it out means one place owns overlap/lock/link/snap/magnetic rules instead of each resolver growing its
own branches — the foundation for insert edits, overwrite drag, magnetic timeline, drag-drop, paste.
Pipeline: **resolve edit → apply policy → operation.**
**Added (`packages/shared/src/timeline-ops.ts`):**
- `EditingPolicy` type + `DEFAULT_EDITING_POLICY` — the full contract
  (`overlap | lockedTracks | linkedMedia | snapping | magnetic`). Default = today's exact behavior, so
  threading it changes nothing until a caller opts in.
- `applyOverlapPolicy(composition, movedLayerIds, overlap)` (pure): `allow` = no-op (today);
  `reject` = report the collision so the caller aborts; `overwrite` = carve the moved clip's span out of
  the stationary clips it lands on (source/keyframe-aware, via `splitLayerAtTime` reuse — leaves a gap,
  does NOT ripple). Only stationary clips are ever trimmed.
- `commitGroupMove(composition, placements, movedLayerIds, policy)` — the shared seam: place, then apply
  the overlap rule; `reject` returns the ORIGINAL (unmoved) composition.
**Wired:**
- `moveLayers` action gained an optional `overlap` param → routes through `commitGroupMove`; a rejected
  move is a no-op with the summary "Move refused — would overlap".
- EditorPage's drag commit (placements path) now goes through `commitGroupMove(…, DEFAULT_EDITING_POLICY)`.
  With `overlap: "allow"` it's pixel-identical to before — but interactive drag now flows through the SAME
  policy layer the engine/AI use, so future modes light up here for free. **Zero behavior change today.**
**Scope calls:** `overlap` union is `allow|overwrite|reject` — ripple is deferred to the dedicated
insert/ripple-delete operations where its semantics are unambiguous (a free move has no natural ripple).
`lockedTracks`/`linkedMedia` are declared in the type but still enforced geometrically inside
`resolveGroupMove` today (honest docs on the fields); `snapping` lives in the UI gesture layer;
`magnetic` is declared-only. Migrating those into the policy layer is incremental follow-up.
**Verify:** shared typecheck clean; `resolver:test` 31 checks (adds overlap allow/reject/overwrite +
head/tail/interior/fully-covered carves + commitGroupMove incl. reject-returns-original);
`actions:test` (adds moveLayers overlap allow/overwrite/reject); web `editor:test`; EditorPage typecheck
clean (pre-existing unrelated GraphicsStackPanel `selectedLayerId` WIP errors still present).

## v8 — Edge trim extracted into resolveEdgeTrim() (its own primitive) (2026-07-14)
**Context:** roadmap step 4. Edge trim juggles source in/out reveal, the media/compound duration cap,
min clip length, and keyframe/animation timing at once — a distinct primitive, held back from the earlier
slices until it could be extracted cleanly.
**Bug it fixes (real preview/commit divergence):** the drag PREVIEW (`moveResize`) clamped a head drag
only by asset length (`minStart = end − maxDuration`), ignoring how much head material `sourceInSeconds`
actually had, while the COMMIT (`handleResizeLayer`) clamped correctly by the in-point. Dragging the head
of a mid-trimmed media clip left overshot in the preview and SNAPPED BACK on release.
**Extraction (`packages/shared/src/timeline-ops.ts`):**
- `resolveEdgeTrim(layer, { startSeconds, durationSeconds }, { maxDurationSeconds, minDurationSeconds })`
  → `{ startSeconds, durationSeconds, sourceInSeconds?, sourceBound }`. Pure geometry — the EXACT math the
  resize commit always used: source-bound clips (media-with-asset OR nested compound) move `sourceInSeconds`
  with the head edge (never revealing before source-frame 0) and cap duration by material left from the
  in-point; non-source clips (text/shape/image) clamp start/duration to the max length with the left-drag
  pin. Idempotent (feeding a resolved edge back is a fixed point → preview==commit).
- `applyEdgeTrim(layer, resolution)` writes the edges + keyframe/anim patch (source → `trimLayerKeyframesTo`,
  non-source → `squeezeLayerKeyframesTo`).
**Wired:** `handleResizeLayer` (commit) collapsed from ~55 lines of inline math to
`applyEdgeTrim(layer, resolveEdgeTrim(...))`; `moveResize` (preview) now derives desired edges from the
pointer (head drag keeps tail planted at end − 1 frame) THEN clamps through `resolveEdgeTrim` — same
resolver as commit, so no more overshoot/snap-back. Each caller passes its own `maxDurationSeconds`
(preview's is capped at composition length, commit's is not — preview is the tighter bound so the
committed value always passes through unchanged; no snap-back from that residual, and it's pre-existing).
**Deliberately preserved:** the drag resize path stays NON-ramp-aware (uses `oldSourceIn + startDelta`,
exactly as `handleResizeLayer` always did) — NOT unified with the ramp-aware `adjustLayerHead` used by
roll/extend. Unifying ramp handling across the two trim paths is a separate call, not smuggled into this
extraction.
**Verify:** shared typecheck clean; `resolver:test` grows to 45 checks (head-extend cap + idempotency,
head-trim in-point advance, tail-extend cap, non-source squeeze + left-pin, applyEdgeTrim writes);
web `editor:test` passes; web typecheck clean for touched files (pre-existing GraphicsStackPanel
`selectedLayerId` WIP errors remain).

## v9 — Locked/linked rules migrated INTO the policy layer (2026-07-14)
**Context:** v7 built the policy seam but only `overlap` was policy-driven; `lockedTracks` and
`linkedMedia` were still hardcoded inside `resolveGroupMove` (the fields existed on `EditingPolicy` but
nothing read them). This makes the seam load-bearing for those two dimensions.
**Change (`resolveGroupMove`):** now reads its rules FROM an optional `policy` input
(`Pick<EditingPolicy,"lockedTracks"|"linkedMedia">`) instead of dictating them:
- `lockedTracks` — `reject` (default) skips locked clips + keeps a locked destination lane; `ignore`
  moves locked clips and allows landing on locked tracks.
- `linkedMedia` — `moveTogether` (default) pulls linked A/V companions along as time-only followers;
  `allowBreak` skips companion expansion (the link is allowed to break).
Omitting `policy` yields the exact prior behavior, so the UI drag path (which passes no policy) is
unchanged. `moveLayers` action now threads its `policy` into `resolveGroupMove` too, so the action's
policy governs the whole resolve, not just the overlap commit. `EditingPolicy` field docs updated to name
their consumer (`resolveGroupMove` / `applyOverlapPolicy`) instead of "enforced geometrically today".
**Now policy-owned:** overlap (v7), lockedTracks, linkedMedia. Still outside: `snapping` — SHIPPED as a
UI feature (the Magnet/"N" toggle → `snapTimeWithTarget`, snaps to cuts/playhead/markers), just not yet
read from the policy object; and `magnetic` (FCP-style auto-close-gaps timeline) — genuinely unbuilt, and
distinct from the Magnet icon, which is snapping. Both declared on the contract; wire `snapping` through
the policy when AI/scripting need snapped edits, build `magnetic` as a new feature.
**Verify:** shared typecheck clean; `resolver:test` 49 checks (adds lockedTracks default-vs-ignore,
linkedMedia moveTogether-vs-allowBreak); `actions:test` unchanged-green; web typecheck clean for touched
files (the optional `policy` field is backward-compatible; pre-existing GraphicsStackPanel WIP errors
remain).

## v10 — Magnetic timeline (move mode, opt-in toggle) — the last unbuilt policy dimension (2026-07-14)
**Context:** roadmap's remaining genuinely-unbuilt item. Chosen model (user): a **toggle** (like snapping),
NOT a global FCP rebuild — fits the Premiere-style multi-track free-positioning timeline. When ON, a move
compacts the tracks it touched; when OFF, today's free positioning. Note: the existing "Magnet" toolbar
icon is SNAPPING, not this; magnetic gets its own icon/toggle.
**Built:**
- Pure `applyMagneticTracks(composition, trackIds)` (`timeline-ops.ts`): on each named track, lays clips
  end-to-end in time order anchored at the EARLIEST start (never slams to 0) → gaps and overlaps both
  vanish, block keeps its left edge. v1 limitation: a track containing ANY locked clip is skipped
  (locked-anchor flow-around is a follow-up; `resolveGroupMove` already won't move locked clips, so it's
  consistent).
- `commitGroupMove` honors `policy.magnetic`: after placing, compacts the union of destination + original
  tracks of the moved clips; magnetic subsumes the overlap rule (compaction can't leave an overlap).
- `moveLayers` action gained a `magnetic` boolean param (threads into the policy).
- UI: `magneticEnabled` state in EditorPage (persisted `kimera_timeline_magnetic`, **default OFF**), a
  toolbar toggle in TimelineStrip (AlignHorizontalJustifyStart icon, next to the snap Magnet), and the
  drag commit passes `{ magnetic: magneticEnabled }` into `commitGroupMove`.
**Policy scorecard now:** overlap ✅, lockedTracks ✅, linkedMedia ✅, magnetic ✅ (move ops), snapping —
shipped in UI, still not policy-routed (only remaining consistency gap). Follow-ups for magnetic:
ripple-on-delete + insert/drop-push when the toggle is on (this slice is move-only); locked-anchor
flow-around.
**Verify:** shared typecheck clean; `resolver:test` 56 checks (adds gap-close, overlap-remove,
earliest-anchor, locked-skip, scoped-tracks, magnetic commit); `actions:test` adds moveLayers-magnetic
gapless; web `editor:test` passes; web typecheck clean for touched files (pre-existing GraphicsStackPanel
WIP errors remain). NOTE: interactive drag-with-magnetic not yet driven in a live app — logic is
test-covered; needs a manual pass.

## v1 — Work-area export left keyframes behind the content it trimmed (2026-07-15)
**Problem.** Exporting with a work-area IN-POINT that cut into a keyframed clip rendered every keyframe
`trimmedFromHead` seconds LATE. Editor-only playback looked correct, so the bug was export-only and
effectively invisible until you compared an export against the timeline.

**Root cause.** `clipCompositionToWorkArea` (timeline.ts) rebased everything a head trim moves EXCEPT the
keyframes: `sourceInSeconds` ✅ (`layerSourceTimeSeconds`), the speed ramp ✅ (`shiftSpeedKeyframes`),
`animations`/`keyframes` ❌ (never touched). Cutting the head moves the CONTENT, so anything pinned to it
must move too. The correct rule already existed — `trimLayerKeyframesTo` in timeline-ops.ts, which fixed
this exact class for interactive trims back on 2026-07-03 — but the work-area clip lives in timeline.ts,
which CANNOT import timeline-ops (timeline-ops imports timeline; the reverse is a cycle). So the rule was
implemented once, in the module the other caller couldn't reach, and the second caller silently omitted it.

Two time domains made it worse. V2 `animations` are LAYER-LOCAL → they need shifting by −headDelta.
V1 `keyframes` are ABSOLUTE composition time → they don't rebase against the trim at all, but they DO
have to follow the clip's move to the new t=0 origin (−inPoint), which was also missing — including on
the transition-preserving branch, where there's no head trim but the clip still moves.

**Fix.** The rule moved to `trimLayerKeyframeTracks` in timeline.ts, sitting NEXT TO `shiftSpeedKeyframes`
(its exact counterpart — the ramp is just another thing pinned to the content). `trimLayerKeyframesTo` is
now a thin delegate, so both callers share one implementation and the public API is unchanged.
`clipCompositionToWorkArea` calls it with the pre-move start, then shifts surviving V1 keys by −inPoint.

**Invariants / next time.**
- **A head trim moves the CONTENT. Everything pinned to that content moves with it** — source in-point,
  speed ramp, keyframes, and anything added later. When adding a new content-pinned field, grep for
  `shiftSpeedKeyframes`: every call site is a place that must handle it.
- **Import direction decides where a shared rule can live.** `timeline-ops → timeline` is one-way, so a
  rule only in timeline-ops is unreachable from timeline and WILL be re-implemented or forgotten. Put a
  rule at or below the deepest module that needs it.
- Keyframe tracks live in DIFFERENT time domains (V2 layer-local, V1 absolute, ramp local). "Shift the
  keyframes" is never one operation — a fix that treats them alike breaks whichever one it guessed wrong.
- The editor evaluates the UNCLIPPED composition, so work-area bugs never show in preview. Anything that
  only runs on the export path (`clipCompositionToWorkArea`, `expandNestedCompositions`) needs its own
  assertion — `editor:test` now pins this one.

## v2 — Clone/split reminted effect ids but left keyframe targets pointing at the old ones (2026-07-17)

**Symptom.** Duplicate, split (blade), or paste a clip whose effect params are keyframed → the copy plays
the effect STATIC. The keyframes are still on the layer but dead: V2 `animations` address effects BY ID
(`target.effectId`), and `cloneLayerWithNewIds` reminted every effect id (`<newId>_fx_<i>`) without
remapping the targets. Orphans are invisible to the evaluator and (mostly) to the inspector — one of the
"keyframes stopped responding" reports. `splitLayerAtTime` had the bug TWICE: it clones the right half
(orphaning once), then REBUILDS `right.animations` from the original layer's list (orphaning again).

**Fix (timeline-ops.ts).** `clonedEffectIdMap(layer, newLayerId)` + `remapAnimationTarget(target, map)`
— applied in `cloneLayerWithNewIds` (covers duplicate/paste) and in split's right-half rebuild. Remaps
both `scope:"effect"` and `scope:"mask"` targets (mask keyframes also carry `effectId`; mask ids
themselves are not reminted, so they need no map). Contract test: scratchpad `clone-remap-test.ts`
(duplicate + split, positional integrity blur-vs-pixelate, layer-scope targets untouched, left half
keeps original ids).

**Deliberately NOT healed:** orphans already saved in old projects. They are inert (evaluator ignores
them; effect-delete strips its own since 2026-07-16), and any heuristic remap risks animating the WRONG
effect — worse than a static param the user can re-key.

**Invariant.** Reminting an id is only half an operation — every reference to it must move in the same
write. When adding a new id-bearing field to `TimelineLayer`, grep `cloneLayerWithNewIds` AND split's
right-half rebuild: split does NOT inherit the clone's handling for keyframe tracks.

## v1 — "Click-keyframe moves playhead" — audited 2026-07-17, already fixed

**Problem (roadmap item, unverified).** Report claimed clicking/grabbing a keyframe diamond on the
timeline track or in the graph editor seeks the playhead to that keyframe's time, when it should only
select it.

**Audit.** Traced every click/pointerdown path that touches a keyframe diamond:
`TimelineStrip.tsx` `startKeyframeDrag` (pointerdown) and the diamond `<button onClick>` (~L2173,
~L5289) both call `onSelectLayer`/`onSelectKeyframe` only, with explicit "No playhead seek (2026-07-16
user request)" comments — no `onSeek` call. `GraphEditor.tsx`'s canvas point-hit path
(`handlePointerDown`, `hit?.type === "point"`) and the lanes-view diamond (`laneKeyPointerDown`) both
call `selectOne`/`setSelectedIds` + `beginDraft` only. `onSelectLayer` → `selectLayer` →
`commitLayerSelection` touches only `selectedLayerIds` state, no `currentTime` write. The only `onSeek`
calls in these files are the ruler drag/click (intentional scrub) and explicit Prev/Next
keyframe-navigation buttons (`KeyframeButtons.onNext`/`onPrevious`, intentional step affordance) — both
expected to seek.

**Conclusion.** Already fixed (commit dated 2026-07-16, predates this audit). No code change made.
Roadmap entry in `plans/timeline-multiselect-phase.md` "click-keyframe shouldn't move playhead" is stale
and can be dropped next time that file is touched.

**Verify.** Static audit only (all call sites read, no `onSeek` reachable from a keyframe click); no
runtime repro attempted since the fix predates this session.
