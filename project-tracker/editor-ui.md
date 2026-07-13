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
