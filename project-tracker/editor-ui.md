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

## v5 — Position/Anchor labels in permanent ellipses (grid packing, not label width) (2026-07-18)

**Problem:** In the Transform panel, "Position" and "Anchor" always rendered as "Posi…" /
"Anc…" — the two rows sat side by side fighting for the panel width (user screenshot).

**Root cause:** single-value rows (`NumberControl`) carry `.number-row` with
`grid-column: 1 / -1`, spanning the full inspector width — but `PropertyRowGroup`
(Position X/Y, Anchor X/Y, tilt) never got an equivalent rule. Inside `.control-grid`'s
`repeat(auto-fill, minmax(88px, 1fr))` the two groups packed into one line, and the
group's label column (`minmax(52px, 0.32fr)`) ellipsized at half-panel width no matter
how wide the panel was.

**Fix:** `.property-row-group { grid-column: 1 / -1 }` (global.css, next to its existing
grid-template rule) — one group per line like every other row; the label fits and X/Y
share the line to its right, flex-wrapping only when the panel is genuinely narrow.
All three `PropertyRowGroup` call sites are TransformPanel rows that want full width.

**Lesson (pattern):** any new row shell rendered into `.control-grid` must decide its
span explicitly — auto-fill packs unspanned items into skinny columns silently.

## Scopes everywhere — multi-pane layouts + three hosts (2026-07-21)

**Change:** `ColorScopes` refactored into a multi-pane analyzer: layouts `single` (tabs), `two`
(pair with per-pane selects), `grid` (2×2 all four), `column` (all four stacked); one frame sample
per tick shared by every pane; per-host persistence via `storageKey` (localStorage
`orreris.scopes.<host>.*`). Live during playback via its own 10Hz loop (cold clock stays suspended
— doctrine). Hosts: (1) bottom-workspace drawer (default `two`), (2) LEFT PANEL full-height view —
`panelTab: "scopes"` renders it in the media-pool column (default `column`), (3) inspector Color
tab — collapsible "Scopes" row above the Lumetri sections with a PanelLeftOpen pop-out button that
calls `openScopesLeftPanel`. Canvas backing stores track pane size via ResizeObserver (caps
1280×480); vectorscope stays round in any aspect (circle centered on min(cx,cy)).

## Viewer border + media pool height chain + button rhythm (2026-07-21)

- Viewer "white border": `.editor-viewer .phone-frame` stacked a 1px `--editor-border-strong`
  border WITH the 0.24-alpha boundary ring (2026-07-12 canvas-vs-matte differentiation) — a
  visible double white line. Border dropped, ring reduced to 0.07 alpha: still a findable edge on
  pure-black comps, no longer reads as a frame.
- Media pool "half cut": `.panel-tab-content` is a grid whose single row was implicitly `auto` —
  the asset bin's height:100% resolved circularly and collapsed to content height; the CSS-columns
  masonry then overflowed HORIZONTALLY (cut tiles + h-scrollbar mid-panel). Fixed with
  `grid-template-rows: minmax(0, 1fr)` on the visible-bin :has rule.
- `.fit-canvas-actions` buttons 30px/900-weight → 24px/600 to match the inspector's 24px row rhythm.
Open design-audit candidates (not yet done): media-pool tab labels truncate at narrow widths
("Sear…") instead of collapsing to icons; bottom filter strip mixes chip sizes; topbar toggles vs
panel tab pills use different radii; "Open Graph Editor" affordance differs from sibling sections.

### Media-pool controls onto the shared flat button language (2026-07-21)

Resolved two of the open design-audit candidates. The source tabs (Search/Local/AI/Brand/Used) and
the bottom filter/view chip strip were the "old" heavy look: every chip its own bordered box with
900-weight text, and the two clusters overflowed into a horizontal scrollbar that half-hid the
filters. Restyled onto the viewer toolbar's language (`.preview-tools`): flat borderless buttons in
a subtle segmented container, neutral hover (`--nle-panel-3`), accent tint only when active
(`--editor-accent-bg`), 22–26px heights, lighter weight. Overflow fixed by letting the control
strip + left cluster WRAP (`flex-wrap: wrap`) instead of scrolling — no hidden-scroll traps; the
lighter labels also truncate less. Standalone actions (New bin, Upload) share the same flat
icon-button footprint. Still open: tab labels can still truncate to icons-only at very narrow
widths (needs JS, not just CSS); topbar toggle vs panel-pill radii; graph-editor row affordance.

## v7 — Flarex node-param keyframes: inspector diamonds shipped, GraphEditor drawer adapter deferred (2026-07-21)

**Scope:** `plans/flarex-sonnet-execution.md` Task S2. S2a (inspector keyframe diamonds for
node params) shipped: `apps/web/src/editor/flarex/flarex-keyframes.ts` mirrors the effect-param
helpers in `keyframeUtils.ts` (get/toggle/clear/find-prev-next + the four-way
`applyNodeParamValueAtTime` animated-edit rule) but targets `FlarexComp.animations` with
`{ scope: "flarexNode", effectId: nodeId, property: paramKey }` instead of a layer. Wired into
`FlarexInspector.tsx` via `KeyframeButtons` (the canonical diamond+prev/next+clear affordance) for
every numeric param whose key is in the node def's `keyframeable` list; the row's slider/field
now displays the evaluator-sampled value at the shared playhead (`evaluateFlarexNodeParam`), not
the ignored static base, once animated. `FlarexWorkspace` → `EditorPage` thread a `timeSeconds`
(via the same `<ColdTime>` render-prop `BottomWorkspace` uses) + `onSeek` prop for prev/next nav.
New `flarex:test` block: a keyframed blur `sigma` (0→20 over t=0..2) lowers to matching `blurPx`
at t=0/1/2 — locks compiler/evaluator parity.

**Deferred: S2b (GraphEditor drawer adapter).** The plan's own escape hatch: "a read-only curve
view... is an acceptable first landing... note what you deferred" if the write plumbing gets
deep. It does — `GraphEditor.tsx` (1487 lines) + `graph-scene.ts` are built entirely around
`TimelineLayer`-shaped input (`GraphTarget` union has `transform`/`effect`/`sourceText`/`layer`/
`speed` kinds, all reading/writing `layer.animations` or layer-specific fields via
`keyframeUtils.ts` helpers that take a `TimelineLayer` and return a `TimelineLayer`). A
`flarexNode` kind would need: a new `GraphTarget` variant, a fifth branch in every
`keyframeUtils.ts` mutator (`updateGraphTargetKeyframe`, `setGraphTargetInterpolation`,
`updateGraphTargetHandle`, `graphTargetKey`, ...), and `BottomWorkspace`/`GraphEditor` accepting
either a layer OR a comp as their edit target (they currently hard-require `TimelineLayer` and
call `onChange: (updater: (layer) => layer) => void`). That's a layer-vs-comp seam mismatch, not
a small extension — doing it safely means either genericizing `GraphEditor` over "an object with
an animations array + a version-bumping updater" (broad, cross-cutting refactor of a perf-
sensitive file) or forking a parallel Flarex-only curve view (duplication, drifts from the real
one). Left unbuilt; inspector diamonds (S2a) already cover add/remove/scrub/clear end-to-end,
which is the everyday keyframing motion — only bezier-handle curve dragging and multi-property
simultaneous curve viewing are missing for Flarex node params.

**If picked up later:** the cleanest seam is probably a `GraphTarget` variant `{ kind:
"flarexNode", nodeId, property, ... }` plus an `EditSubject` abstraction (`{ animations,
setAnimations }`) that both `TimelineLayer` and `FlarexComp` adapt to, so `GraphEditor` stops
assuming "layer" — sizeable enough to warrant its own plan pass rather than a drive-by inside S2.

## v8 — Flarex S3 (polygon/bezier masks) + S4 (pixel fixture) shipped; pre-existing stylize regression found incidentally (2026-07-21)

**S3:** `polygonMask`/`bezierMask` now lower (`compile-flarex.ts`): points param is a JSON array
of `[x,y]` comp-fraction pairs (soft-fails to a default triangle/quad on bad JSON — never
throws), scaled to comp px and built into a vector `Mask` via the shared `clip-masks.ts` model,
same feather-fraction convention as rect/ellipse. Palette entries + a multiline textarea param
row added (`FlarexInspector.tsx` — later reshaped by a concurrent edit into the `PropertyRow`
shell, textarea handling preserved). New `flarex:test` coverage uses a stub `SceneMaskMatteCache`
that records the `Mask[]` it's asked to rasterize (the real cache needs a GL canvas) — this is
the pattern to reuse for any future mask-node test needing to assert on vector structure without
a browser.

**S4:** new `render:compare:pixels` fixture `flarex-key-glow` (`render-comparison-fixture.ts`):
MediaIn → ChromaKey(hill orange, matching the existing `chroma-key` fixture's convention — no
dedicated green-screen asset exists in this harness) → Transform(scale 0.8) → Glow → MediaOut,
over a full-bleed background **layer** (NOT `composition.backgroundColor` — `SceneStage.tsx:570`
hardcodes the Remotion canvas clear color to `"#000000"` regardless of that field, so it is NOT
cross-renderer reliable; discovered by a false-positive 0% diff where both renderers agreed on
silently skipping the comp). Verified real (not a no-op): sampled the rendered PNG's center pixel
= `[31,94,145]` ≈ the background layer's `#1e6091` — the key genuinely removed the hill and
revealed the composited layer beneath. Passes at 0.000% diff; full suite otherwise unaffected.

**Incidental finding (not fixed, out of scope):** `stylize-ink` (7.857%) and `stylize-subject`
(8.014%) fail the full `render:compare:pixels` sweep, both over the 3.5% bar. Confirmed
pre-existing on this branch (WIP diffs already present in `fragment-effects/builtins.ts` and
`registry.ts` before this session touched anything, from the same-day P5 subject-aware-styling
work per git log) — unrelated to any Flarex change. Left alone per the plan's fence (stylize/
scene-compositor tuning is out of scope for the Flarex work); flag for whoever owns the stylize
P5 landing.
