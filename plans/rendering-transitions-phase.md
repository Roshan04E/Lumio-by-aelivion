# Phase: Rendering & Transitions — execution plan

Written 2026-07-16 for execution by a code agent (Sonnet 5). Root causes were traced in source by
an exploration pass — re-verify anchors with grep before editing (lines drift).

## Mission (user-reported, in priority order)

1. **R1 — Stacked-layer frame flash**: identical images stacked on 3 tracks each become visible for
   a fraction of a second during playback; only the top layer should ever show.
2. **R4 — Speed ramp hangs the browser** during playback.
3. **R2 — Nested clips don't render transitions (and possibly texts)** — user says "check as you go".
4. **R3 — Transition timing model**: transitions start exactly AT the cut (inside clip B) instead of
   spanning it; growing the duration freezes-then-replays the outgoing clip; some kinds appear to
   show clip A after the cut. Adopt the Premiere centered-on-cut model.
5. **R5 — Speed-ramp graph lane** with duration readout.
6. **R6 — Optical-flow time interpolation**: DEFERRED (plug sites noted at bottom).

## Hard constraints

- **Render parity**: web preview, local export, and the Remotion worker must stay pixel-aligned.
  Anything touching `packages/shared/src/scene/build-scene-draws.ts`,
  `packages/shared/src/composition-style.ts`, or transition math requires
  `pnpm --filter @orreris/worker render:compare:pixels` (expected 27/27 ≤0.001%) and,
  for R3, a real `render:manifest` inspection of a transition fixture.
- **Do not touch** the timeline's imperative gesture patterns (protected user directive).
- Effects/transitions are real WebGL — never CSS fakes (repo doctrine).
- After every task: `pnpm -r typecheck`. One task per commit.

## R1 — Stacked-layer frame flash (do first)

**Root cause (confirmed):** draw builders silently DROP unready layers:
`build-scene-draws.ts:365` (`if (!raster) return null` for text) and `:422-423`
(`getMediaGraded(layer.id)` null → `return null` for media). The Remotion worker gates the frame —
`SceneStage.tsx:493-564` holds `delayRender` until `controller.composite()` returns true (false
when a media frame hasn't arrived, `:142-143`) — but the WEB preview has no equivalent: it
composites whatever is ready this rAF, so while the top image decodes, the layers below show
through bottom-to-top. Export is correct; preview flashes.

**Fix (mirror the worker's gate, with an escape hatch):**
1. Make `buildSceneDraws` (or its web caller) REPORT which active visual layers were dropped for
   unreadiness — simplest additive change: give `BuildSceneDrawsInputs` an optional
   `onLayerNotReady?: (layerId: string) => void` callback invoked at the two `return null` sites
   (thread through `buildLayerDraw`/`buildLayerDrawWithPasses`), OR return draws plus a
   `notReadyIds: string[]` via an optional out-param object. Keep the default behavior identical
   when the hook is absent (worker/export unaffected).
2. In the web scene-preview composite loop (find the caller of `buildSceneDraws` in
   `apps/web/src/components/ScenePreviewCanvas.tsx` — the rAF that calls the compositor's
   `renderFrame`): when any active layer was dropped for unreadiness, SKIP presenting this frame
   (keep the previous canvas contents) instead of compositing a hole.
3. Escape hatch (mandatory — a permanently-failing source must not freeze the preview): track how
   long the same layer id has been blocking (e.g. `Map<layerId, firstBlockedMs>`); after ~300ms,
   composite anyway (current behavior). Clear the map when the layer becomes ready or inactive.
4. Do NOT block during scrubbing-while-paused if it makes seeks feel laggy — gate the hold to
   `isPlaying` if testing shows paused-seek regressions.

**Verify:** 3 identical images stacked on 3 tracks, play across their start — no flash (lower
layers never visible). A deliberately broken asset (rename a file) still renders the rest after
~300ms. `render:compare:pixels` unchanged (worker path untouched).

## R4 — Speed ramp browser hang

**Root cause (confirmed):** the shared ramp math is safe (clamped ≥0.05, sorted, bounded loops —
`packages/shared/src/timeline.ts:214-294`). The hang is a preview seek storm:
`apps/web/src/components/VideoPreview.tsx:2664-2673` fires on EVERY currentTime commit for a
ramped clip and calls `syncVideoTime` (`:2623-2638`), which re-seeks `video.currentTime` whenever
drift exceeds `0.08 * speed`. Between commits the element free-runs at a constant rate while the
ramp is curved, so the threshold trips almost every tick → a `currentTime` write per frame on a
PLAYING `<video>` → decoder flush/re-prime storm → unresponsive tab. (The 500ms drift corrector at
`:2711-2729` deliberately excludes ramped clips, so this per-tick effect is the sole corrector.)

**Fix (make the element free-run, correct rarely):**
1. In the ramped-playback effect (`:2664-2673`): keep updating `video.playbackRate` to the local
   tangent (`getLayerSpeedAt`) each tick — playbackRate changes don't flush the decoder.
2. Throttle the SEEK correction: only call `syncVideoTime` when (a) the drift exceeds a much larger
   tolerance (~0.25s · speed), or (b) at least ~500ms passed since the last correction (mirror the
   non-ramped corrector's cadence), or (c) the playhead jumped (scrub) — the existing jump-resync
   effect at `:2689-2702` already covers jumps; don't duplicate it.
3. While PAUSED, keep the exact-seek behavior (scrubbing accuracy is what the 0.08 threshold is
   for) — only the `effectivePlaying` branch changes.
4. Minor: the effect's dep array includes the whole `layer` object; scope it to the fields used
   (`layer.speedKeyframes`, `layer.startSeconds`, `layer.sourceInSeconds`) via refs or memo ONLY if
   straightforward — do not restructure the effect wiring otherwise.

**Verify:** apply a 0.5×→8× ramp to a long clip, play through it — no hang, audio/video keep
rough sync, CPU stays sane; frame-accuracy is restored at pause (exact seek). Export unaffected
(pull-based, already exact — `scene-frame-compositor.ts:446-465`).

## R2 — Nested clips: transitions (and audit texts)

**Root causes (confirmed):**
- **Expansion drop**: `packages/shared/src/nesting.ts:196-198` — a nested child loses
  `transitionIn` whenever the compound clip head-trims it (`headTrim !== 0 → undefined`).
- **Compositor drop (main)**: `build-scene-draws.ts:771` skips group-owned layers BEFORE the
  transition branch (`:772-784`), so a nested incoming clip never emits its mix; `buildGroupDraw`
  (`:724-749`) does no transition folding (NEST-REVIEW note at `:627-631`). Worse, the top fold
  loop (`:208-224`) still adds nested ids to `foldedIds`, and `membersByGroup` excludes them
  (`:639`) — during a nested transition the outgoing nested clip can vanish from its group.
- **Pair detection unsafe**: expansion collapses all children onto the parent `trackId`
  (`nesting.ts:186`), so `findTransitionPairs` (`composition-style.ts:339-354`) can false-match a
  nested child against an unrelated parent-track neighbour across the nest boundary.

**Fix, in three steps (each independently verifiable):**
1. **Stop the corruption first**: in `build-scene-draws.ts`'s fold loop (`:208-224`), skip pairs
   where either side is group-owned (`layerOwnerGroup.has(id)`) so nested ids never enter
   `foldedIds`/`transitionOutgoingIds` — nested clips then at least render (hard cut) instead of
   vanishing. This alone fixes "nested clips don't render" for transition participants, which is
   also the likely explanation for the reported missing nested TEXTS (a text that is a transition
   participant inside a nest gets folded and dropped today).
2. **Scope pair detection to the nest**: in `findTransitionPairs`, only match two layers when they
   share the same nest prefix (both ids start with the same `${clipId}__nest_` prefix, or neither
   is nested). Use `NEST_ID_SEPARATOR` from `nesting.ts`; add a small helper `nestPrefixOf(id)`.
3. **Render nested transitions inside the group**: in `buildGroupDraw`, detect active pairs whose
   BOTH sides are members of this group (reuse `activeByIncomingId`), and emit the transition mix
   as a member draw of the group at the incoming clip's z-slot (same `from`/`to` group-build logic
   as the top-level branch at `:772-784`, scoped to the nest's dims). If the full mix inside the
   group RTT proves too invasive, ship steps 1-2 (correct hard cuts, no vanishing) and log step 3
   as deferred in `architecture.md` — the user prioritized "renders correctly" over "transition
   plays inside nests".
4. **Expansion**: preserve `transitionIn` under head-trim by shrinking it instead of dropping:
   `durationSeconds - headTrim` when positive, else drop (`nesting.ts:196-198`).
5. **Audit nested texts end-to-end** (user asked): build a manifest with a nest containing a plain
   text child + a transition pair, run
   `pnpm --filter @orreris/worker render:manifest <file>` and inspect frames; also check
   the web preview. Expansion spreads text fields correctly (verified), so any remaining text drop
   is the step-1 folding or the DOM fallback path (`VideoPreview.tsx:1011-1014`) — fix what the
   repro shows.

**Verify:** nest two clips with a cross-dissolve + a text overlay → nothing vanishes at the cut
(step 1), no transition steals a frame from a clip OUTSIDE the nest (step 2), the dissolve plays
inside the nest (step 3, if shipped). `render:compare:pixels` 27/27. Add a nested-transition
fixture to `remotion-scene-compare`/pixel fixtures if practical.

## R3 — Centered-on-cut transition model (the big one — do after R1/R4/R2)

**Current model (confirmed):** `getActiveTransition` (`composition-style.ts:315-332`) and
`getCompositionTransition` (`:213-216`) use a START-ALIGNED window `[cut, cut+D]` — the whole
transition plays inside clip B; at progress 0 the mix shows a full frame of A *after* the cut,
which is why some (back-loaded smoothstep) kinds read as "A shows after the transition"
(`punchZoom :291`, `spin :429`, `shake :408`, `pixelate :557` — the shader from/to conventions are
all consistent; no reversed shaders). The freeze-then-replay: the web outgoing post-roll free-runs
the `<video>` past its material and then yanks it back (`syncVideoTime` clamp at
`VideoPreview.tsx:2630-2637`, play at `:2652-2654`) — there is NO real hold-last-frame.

**Target model (Premiere):** window `[cut - D/2, cut + D/2]`; the outgoing clip renders D/2 past
its out-point from its tail handle; the incoming clip renders D/2 before its in-point from its head
handle; a side without enough handle HOLDS its edge frame (no free-run, no replay).

**Implementation order:**
1. **Shared window math**: change `getActiveTransition`/`getCompositionTransition` to compute
   `start = cutSeconds - duration/2` (callers pass the cut; keep the signature, adjust the passed
   `startSeconds` OR add an explicit `alignment: "centered"` — pick ONE and update every caller:
   grep `getActiveTransition(` and `getCompositionTransition(` across shared, web, worker,
   render-templates). `effectiveTransitionDuration` (`:189-198`) must clamp to
   `2*min(outgoingTailRoom + D/2 …)` — simplest correct rule: `D ≤ 2 * min(left.duration, right.duration)`
   remains, but ALSO clamp the pre-roll to the incoming's head handle and post-roll to the
   outgoing's tail handle at RENDER time (hold the edge frame when short — see step 3).
2. **Activation windows**: the incoming clip must now render (and decode) from
   `startSeconds - D/2`: web preview active/preload filters (`VideoPreview.tsx:739-782` region and
   `isOutgoingInPostroll` `:4994-5012` → add the symmetric `isIncomingInPreroll`), worker
   `outgoingPostrollSeconds` (`SceneStage.tsx:106-118`) → add preroll to the incoming's Sequence
   (start it D/2 early with `trimBefore` reduced, clamped at source 0), and `build-scene-draws`
   active-layer collection. The timeline UI junction element already draws centered on the cut
   (`TimelineStrip.tsx` junction render, `cutSeconds - duration/2`) — UI needs no change.
3. **True edge-hold**: when a side lacks handle material, hold its edge frame. Web: in the
   post-roll/pre-roll branch of `syncVideoTime`, when the target source time clamps, PAUSE the
   element at the clamped time instead of letting it free-run (fixes freeze-then-replay
   independently of the centering). Worker: `OffthreadVideo` clamps already; verify with
   `render:manifest`. Incoming pre-roll with `sourceInSeconds = 0` holds frame 0.
4. **Source-time math**: outgoing during post-roll: `sourceIn + integral(duration..t)` clamped to
   asset tail; incoming during pre-roll: `sourceIn - speed*(start - t)` clamped ≥ 0 (respect speed
   ramps via the existing `layerSourceTimeSeconds` where possible).
5. **Gates**: `render:compare:pixels` (the `transition` fixture WILL change — regenerate/re-baseline
   deliberately and say so), `render:compare`, and a manual `render:manifest` of a cross-dissolve
   with (a) both sides having handles, (b) outgoing at asset tail (must hold, not replay).

**Risk notes:** this changes what renders at the cut for every existing project with junction
transitions — the visual center shifts D/2 earlier. Announce in the commit message. Keep the old
behavior reachable behind a single shared constant/flag ONLY if trivially cheap; otherwise cut
over fully (the old model is considered a bug by the user).

## R5 — Speed-ramp graph lane + duration readout

Current UI is a points list (`ClipSpeedControl`, `EditorPage.tsx:~12042-12181`, `upsertRampPoint`
`:12067`). The graph editor composes lanes from `GraphTarget[]`; the graphic Progress/Duration
lanes (`buildGraphicGraphTargets`, `keyframeUtils.ts:~1003`) are the precedent.

1. New `GraphTarget` kind `"speed"` backed by `layer.speedKeyframes` (NOT `animations`): lane
   evaluate = `getLayerSpeedAt(layer, t)`; keyframes adapter maps `SpeedKeyframe{timeSeconds,value}`
   to the lane's point shape. **Linear-only**: suppress bezier handle creation/drag for this lane
   (the ramp integral is closed-form over linear segments — `integrateRamp`,
   `timeline.ts:256-281` — bezier would break renderer math). Point drag writes through
   `upsertRampPoint`-equivalent logic (extract it from ClipSpeedControl into a shared helper so
   both surfaces mutate identically); value clamped to `MIN_LAYER_SPEED..MAX_LAYER_SPEED`.
2. Duration readout: `integrateRamp(ramp, duration)` gives source-consumed seconds; show
   "plays N.NNs of source over M.MMs" in both ClipSpeedControl and the lane header.
3. Keep `graph:graphic:test` green; add a small lane test mirroring `graphicLanes.test.ts` if the
   harness makes it cheap.

## R6 — Optical flow (deferred; plug sites only)

Frame selection resolves at: web/local export `scene-frame-compositor.ts:465` (`getFrame(sourceTime)`),
WC provider `WebglMediaLayer.tsx:~1407`, worker `SceneStage.tsx:351-357` (`OffthreadVideo`).
A flow interpolator would blend the two bracketing source frames by fractional time at those sites.
Do not start this in this phase.

## Phase gates

1. `pnpm -r typecheck` after each task.
2. `pnpm --filter @orreris/worker animation:test` (R4/R5 touch ramp call sites).
3. `$env:PIXEL_BROWSER_CHANNEL='chrome'; pnpm --filter @orreris/worker render:compare:pixels`
   after R1 (must be unchanged) and R3 (transition fixture re-baselined deliberately).
4. `render:manifest` manual inspection for R2 (nested text+transition) and R3 (edge-hold).
5. Update `architecture.md` shipped/deferred entries at phase end.
