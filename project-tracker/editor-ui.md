# Editor UI responsiveness (panels, inspector, toasts — not playback)

## v1 — Whole-editor re-render on every toast/selection/edit (2026-07-06, Phase 3 "UI fast pass")
**Problem:** Clicks, toasts, and inspector edits felt sluggish: every EditorPage render (each of
~106 `setNotice` toast sites, every selection, every modal) re-rendered the entire tree — the
4.3k-line TimelineStrip with all clips, the inspector column, every panel.
**Root cause:** (a) `notice` was EditorPage useState — a toast string re-rendered 10k lines;
(b) TimelineStrip was unmemoized and received ~50 identity-unstable inline handlers, defeating the
existing per-clip TimelineClip memo; (c) LayerInspector/InspectorHost unmemoized, with fresh
`panelIds` array literals and a fresh `{width,height}` object per render; (d) per-render
`JSON.stringify` of pipeline/effects/transition in every WebglMediaLayer; (e) per-frame
`texImage2D` full GPU realloc per video layer in MediaWebGLRenderer.
**Fix:** `noticeStore.tsx` module store + `<NoticeToast/>` leaf (setNotice keeps its signature —
call sites unchanged; seq-keyed so repeat toasts restart the fade); `useStableHandlers` grouped
useEvent hook (useStableHandler.ts) + `memo(TimelineStrip)` with all ~50 callbacks frozen and
`markers` memoized; TimelineStrip body memos (rulerMarks, per-track junction map, hoisted
SHAPE_SELECT_OPTIONS); `memo(LayerInspector)` + `memo(InspectorHost)` + hoisted panelIds constants
+ memoized composition size + `inspectorHandlers` block; useMemo'd the three stringify keys;
texSubImage2D in-place upload when the source's intrinsic size matches the texture's allocation
(uploadedTexSizes map, full realloc on any size change).
**Deliberately unchanged:** the imperative gesture/clock architecture (see timeline.md v1 — the
memo work sits AROUND it, never re-Reactifies it); `currentTime={currentTimeRef.current}` still
refreshes the strip on cold commits.
**Verify:** `pnpm -r typecheck` clean; web `editor:test` all pass; `color:compare` pixel gate
0.000% diff (0/2,073,600 px — proves texSubImage2D is pixel-identical); production build clean.

## v2 — Brain FAQ answered "effect params can''t be keyframed" about a SHIPPED feature (2026-07-13)
**Problem:** asking the AI "can I keyframe the blur amount" returned an instant "honest limit: not
supported yet" — but effect-param keyframes shipped long ago and evaluate in all three renderers
(preview / browser export / Remotion, via `evaluateTimelineEffectParam`). The B5 capability-gap
pre-check in `ai/brain/faq.ts` was written when the gap was real and never updated; its eval test
(router-eval.test.ts) ASSERTED the stale answer, so `brain:eval` protected the lie.
**Root cause:** hardcoded FAQ answer text + eval assertion drifted from the registry reality; nothing
tied the answer to `effects.ts` `keyframeable` flags.
**Fix:** the pre-check now derives the answer from the registry per effect: keyframeable number params
→ affirmative how-to (diamond on the slider, Shift+G graph editor); none (audio dynamics, graph-param
color effects) → honest "static per clip". Eval flipped + a new "keyframe the eq" static case. Stale
docs fixed (AI_ARCHITECTURE.md failure table).
**Verify:** `brain:eval` all checks pass (B5 section reworded).
**Lesson:** never hardcode a capability CLAIM in a fast-path answer — derive it from the registry that
owns the capability, or the FAQ will outlive the gap it describes.

## v3 — A keyframe at time 0 is falsy: the dead "previous keyframe" button (2026-07-15)
**Problem:** on a keyframed row, the `<` (previous keyframe) button stayed DISABLED even though a
keyframe plainly existed behind the playhead — so you could never navigate back to the first key of a
ramp. Reported on the new animated-graphic Duration row; the same bug was live in the shipped
Transform panel (Position/Scale/Rotate/Opacity/Tilt).
**Root cause:** `find*KeyframeTime(...)` returned `number | undefined` — a keyframe TIME. Keyframes
are LAYER-LOCAL, so the first key of essentially every ramp sits at time **0**, and `Boolean(0)` is
`false`. Call sites that wrote `hasPrevious: Boolean(findTransformKeyframeTime(...))` therefore read a
real hit as "nothing there" and disabled the button. 6 of 8 call sites used `!== undefined` and were
fine; 2 used `Boolean(...)` and were not. `hasNext` was mostly immune only by accident (a "next" time
is always > tolerance, so never 0 — except when the playhead sits BEFORE an un-clamped clip start).
**Fix:** the defect is the API, not the two call sites. The seven duplicated finders (transform,
effect param, content, layer property, style, mask scalar, mask path) now delegate to ONE generic
`findKeyframeIn(keyframes, layerTime, direction)` in `keyframeUtils.ts` that returns the **keyframe**,
never its time. An object is truthy whenever it exists, so `Boolean(...)` — the check callers actually
reach for — is correct by construction; callers wanting the time take `?.timeSeconds`. The rename made
TypeScript flag every site, so nothing converted silently.
**Verify:** new `pnpm --filter @orreris/web keyframe:nav:test` (12 checks, incl. an explicit
"the old time-returning API would have been falsy here" assertion + strictly-before/after tolerance);
`pnpm -r typecheck` clean; `editor:test` + worker `graphic:test` pass.
**Lesson:** never return a nullable NUMBER whose valid value can be `0` when callers' natural question
is "is there one?" — `Boolean(0)`/`if (t)` will silently answer "no". Return the object (never falsy
when present) or a separate predicate. Copy-pasting the finder 7× meant the trap only had to be
stepped on once to ship: an API that's easy to misuse WILL be misused at ~1 site in 4.

## v4 — The Graphics tab's keyframe nav was never wired (optional props fail silently) (2026-07-15)
**Problem:** in the Graphics tab, the prev/next keyframe buttons did nothing — a keyframe plainly
existed, clicking went nowhere. ONLY that tab; Transform/Content/Mask navigation worked. (Chased
past a v3 red herring first: v3's falsy-zero bug was real and stacked on top of this one, so fixing
it only turned a greyed-out button into an enabled button that still did nothing.)
**Root cause:** `EditorPage`'s Graphics `InspectorHost` call site simply omitted `onSeek` — every
other call site passes it. `InspectorHostProps.onSeek` was OPTIONAL, so omitting it compiled clean;
panels then call `onSeek?.(…)`, so at runtime the click hit an optional-call no-op. Optional prop +
optional call = a dead button with no error anywhere. `currentTime` is the same trap one step worse:
a panel that loses it silently evaluates every keyframe against layer-local time 0.
**Fix.** Wire it (`onSeek={onSeek}`), then remove the trap: `currentTime` and `onSeek` are now
NON-OPTIONAL on `InspectorHostProps` — declared `T | undefined` WITHOUT `?`, so the value may be
undefined but the prop must be written out at every call site. Omitting one is a build error; it
immediately caught the second offender (the Text/Warp host). Panel-specific props (composition,
activeMaskId, trackLibrary, autoKeyframe) stay optional — they're meaningful to one panel each.
**Verify:** `pnpm --filter @orreris/web typecheck` (the required-prop guard fails the build
when a site omits either); `editor:test` + `keyframe:nav:test` pass.
**Lesson:** an optional prop is a silent-failure contract. If a panel is USELESS without a prop, the
prop is not optional — `T | undefined` without `?` is the tool: it forces the call site to think while
still allowing "genuinely nothing here". Corollary: `foo?.()` on a handler that must exist converts a
wiring bug into dead UI, which is unfindable by every gate we own — it typechecks, it renders, it just
doesn't work. Symptom-level suspicion ("the finder is wrong") cost a full cycle here; the giveaway was
"only ONE tab is broken" — that's WIRING, not shared logic. Compare the broken call site against its
working siblings FIRST.
