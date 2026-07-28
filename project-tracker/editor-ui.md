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

## v9 — Colour wheels: four polish passes rendered nowhere (radial-gradient sizing), plus the size-dependence rule (2026-07-27)

**The bug behind the whole series.** Commits 46efdcf / 7632b5b / 59195c6 / 8625b3f / 92be97b each
described a layered trackball — groove, rim shade, luminance step, vivid outer ring — in careful
comments. **None of it was on screen.** A bare `radial-gradient(circle at center, …)` on a SQUARE
element sizes FARTHEST-CORNER, so its 100% is `r·√2`, not `r`. Structure authored at 86% / 89.2% /
90.4% was painted at 1.22r / 1.26r / 1.28r — outside the disc entirely; the disc edge sits at 70.7%
of the gradient scale. Measured, not inferred (`getBoundingClientRect` + the computed mask string).

Consequences worth remembering:
- The ring was not dim, it was **absent**. Successive passes made it more vivid, which could never
  have worked, and each pass then "fixed" the wrong thing (bezel colour, scrim alpha, label weight).
- The chroma scrim's r² curve was compressed into the inner 70% of its intended range, so the field
  never reached full chroma and the centre was a muddy olive rather than neutral.
- **Every radial-gradient in a circular control must be `closest-side`.** That makes 100% the disc
  radius and makes authored percentages mean what they say.

**Prevention:** geometry now lives in one `GEO` object in `ColorWheels.tsx`, and the ring's mask, the
grain's mask and the field's falloff are all *generated* from it. The original drift was exactly this
class — the mask was authored in one radius scale and the groove in another, in two different files.

**Verification method (reusable).** There is no browser in the test scripts for this, so: esbuild the
real component + the real `global.css` into a static page, screenshot with Playwright (`channel:
"chrome"`, `deviceScaleFactor: 2`) at panel scale and at 2.6× zoom. Two things this caught that
reasoning did not:
1. A *flat grey* ring substituted for the hue conic proved the band is geometrically uniform — the
   apparent thickness variation was pure hue perception (bright yellow/green vs dark blue against a
   dark bezel), not a defect. Isolate the variable before chasing it.
2. esbuild strips types without checking, so a dangling `GEO.grooveIn` after a refactor produced
   `NaN%`, which silently invalidated the whole `background` shorthand and blanked the field. The
   harness is not a substitute for `pnpm --filter @orreris/web typecheck`.

**The rule this pass actually established — SIZE DEPENDENCE.** The wheels ship at ~42px radius (three
columns in a ~332px inspector), not at the 144px the CSS comments assumed. At that size:
- A dark groove between field and ring — however thin — is a **sub-pixel black circle**. It cannot
  resolve as a machined seam; it resolves as a ragged dark halo and reads as noise. Removed. What
  separates the two parts now is the **luminance step alone** (field ~0.58 value → ring full value
  across a hard mask edge). A discontinuity in brightness is a parting line; it need not be dark.
- Same finding killed the ring's dark inner seat and forced the rim vignette late (0.82) and shallow
  (0.30): the eye does not see groove + seat + vignette, it sees **one black frame whose width is
  their sum**.
- Noise has constant amplitude, so its visibility is set by what it lies on. The grain layer vanished
  into the mid-tone centre it exists to dither but was the highest-contrast thing on the near-black
  rim. It is now its own masked element confined to the interior, not a background layer over
  everything.
- A **directional light key across a circular band** makes the band's apparent thickness vary with
  angle (contrast against the bezel sets perceived width). Removed from the ring; the light-from-
  above cue lives on the housing, a wide annulus where it reads correctly. Housing brightness was
  then pulled to just above panel value — on a thin annulus, bright reads as *emitting*, i.e. a glow.

**Other structural changes:** hue conic is luminance-normalised (`v · (0.45/luma)^0.35`, floor 0.62)
so the ring reads as one band instead of an HSV sweep with a glaring yellow arc — the angle→hue map
(`90 − φ`) is untouched, so grading behaviour is identical. Bezel is a real element
(`.color-wheel-housing`) because a box-shadow spread ring is uniform by construction and can only
ever be a flat donut. Accent focus-halo → 3px modified tick (a glow ring is a web focus idiom, and it
put a saturated colour against the one element whose colour must read as true). Added a display-only
tabular readout per wheel — no interaction change, but a grading control that will not state its own
value cannot be used to match a shot.

**Pre-existing, not touched:** `apps/worker/src/flarex-proxy-parity-gate.ts:160` fails typecheck
(`ImageData` / `SharedArrayBuffer` overload). Untouched file, no uncommitted changes; unrelated to
this work. `apps/web` typechecks clean.

## v10 — Grading felt 1–1.5s behind: the spline was re-solved 180,000 times per slider tick (2026-07-27)

**Problem:** dragging a colour control (tint) updated the scopes, but ~1–1.5s late; `perfDiagnostics`
reported `MAIN THREAD BLOCKED` stalls of 1.0s / 1.7s / 1.9s / 3.9s. Sampled culprits named
`evaluateHermite ← evaluatePeriodicCurve ← evalCurveAt ← applyHueSatCurves ← applyDisplayStage`
alongside React re-renders of `EditorPage` / `TimelineStripImpl` / `AssetBinImpl`.

**Root cause — measured, not inferred.** Every grade tick re-bakes the whole pipeline into a 3D LUT
(`setPipeline` → `bakePipelineToLut3d`), which is 33³ = **35,937 CPU pixel evaluations**. Each of
those hit up to five hue/sat curves, and `evaluateCurve` / `evaluatePeriodicCurve` re-derived the
**entire spline per sample**: sanitize (sort + dedupe + allocate), tile three periods for the periodic
hue path, solve all Fritsch–Carlson tangents, then linear-scan for the segment. ~180,000 full spline
solves and ~1M array allocations per tick, all synchronous on the main thread. Benchmarked
(`tmp/bench/bakebench.ts`, 5 runs each):

| pipeline | before | after |
|---|---|---|
| controls only, no hue/sat curves | 37.2 ms | 30.1 ms |
| + 1 hue/sat curve | 163.0 ms | 42.9 ms |
| + all 5 hue/sat curves | 389.8 ms | 50.7 ms |

**Fix.** Split solve from evaluate in `packages/shared/src/color/curve.ts`: `buildHermite()` produces a
`HermiteSpline` (typed arrays) once, `evalHermite()` samples it with a binary search. Solved splines are
memoized in a `WeakMap` keyed on the control-point array's identity **plus a value snapshot** — identity
alone would go stale if a caller mutated a point in place (a curve editor dragging `point.y` is exactly
such a caller), and a stale grade is a far worse bug than a slow one. Re-verifying 2n floats is free next
to re-solving, so the cache can only be skipped, never wrong.

Two second-order fixes in `ColorScopes.tsx`. Scope canvases now take `willReadFrequently` (Chrome was
warning about the `paintAccum` readback unprompted). And the paused edit-watch was rebuilt: it re-ran on
every tick of a drag and sampled synchronously on each one, unbounded, where a sample is a GPU readback
plus a full-frame accumulation and a getImageData/putImageData round trip **per open pane**.

**A first attempt at that second fix was wrong and is worth recording.** Adding a rate floor to the
immediate sample looked sufficient, but the watch `setInterval` was owned by the effect — so a drag tore
it down and recreated it every ~16ms, faster than its own 90ms period, meaning **it could never fire at
all**. The loop only ever worked because the effect also sampled unconditionally on every tick; the rate
floor removed that cover and would have frozen the scopes mid-drag. The timer now lives outside the
effect and each change EXTENDS a deadline ref it reads, giving a steady 90ms cadence regardless of tick
rate, with unmount as the one owner of teardown and a `sampleRef` so the long-lived timer can't close
over a stale sampler.

**Verify.** Bit-identity is the load-bearing claim, since `curve.ts` backs `render:compare:pixels`.
`tmp/bench/equiv.ts` compares the new evaluator against a verbatim copy of the old one over **419,544
samples** across 51 curves — decreasing, flat-segment (`delta === 0`), near-duplicate x, unsorted,
out-of-range, single-point, empty, and tangent-limiter-triggering — sampling 4097 points plus **every
control-point x** (the boundaries where a binary search could legitimately pick a different segment) and
x±1e-12. Result: exact `Object.is` match on every sample, plus an in-place-mutation check proving the
cache is not stale. `color:test`, `flarex:test`, `editor:test` pass; `shared` + `web` typecheck clean.

`render:compare:pixels`: every colour-path fixture at 0.000% — `nested-grade`, `flarex-curves`,
`flarex-color-chain`, `flarex-unified-color`, `flarex-filter-stack`. The run still ends non-zero on the
two PRE-EXISTING stylize failures (`stylize-ink` 7.857%, `stylize-subject` 8.014%, first recorded in v8),
whose percentages are unchanged to three decimals from the baseline run taken before this work — which is
itself the evidence they are untouched. **Note for whoever runs this next:** piping the gate through
`tail` reports exit 0 even when pnpm exits 1. Read the output, not the exit code.

**Rule:** when a per-pixel function takes a *description* of a function (control points, matrices,
kernels) rather than the solved form, check whether it re-solves per call. The cost is invisible in the
code — it looks like one call — and only shows up multiplied by the pixel count. The general shape of the
fix is to hoist the solve, and memoise it on the input's identity *with* a value check, never identity
alone.

**Left alone deliberately:** `TimelineStrip` and `AssetBin` are already `memo()`-wrapped, so their
re-renders in the stall trace mean props genuinely changed (composition identity changes per tick) —
that is the timeline perf architecture, which is under a standing do-not-touch directive.
Also spotted but NOT changed (flagging, per the same directive): `scene-compositor.ts:2419` and `:2721`
key their re-bake on a raw `JSON.stringify(pipeline)` **every frame**, while `pipeline.ts:314`
`colorPipelineCacheKey` exists specifically to memoize that byte-identically. Same bug class, already
diagnosed once in this repo.

## Flarex node insertion: placement and drag-to-place (2026-07-28)

**Two gaps, both user-reported.** `insertNodeFromMenu` always placed the new node at the MENU
position — the cursor. For a keyboard-driven add (Tab, type a name, Enter) that dropped it wherever
the pointer happened to be resting, frequently on top of existing nodes and rarely near the node it
had just been auto-wired to. And the searchable browser was click-only, while the toolbar palette
beside it had been draggable since it shipped.

**Placement.** `placeAfterNode` puts the node to the RIGHT of a single selected node — the direction
the graph reads and the direction the auto-wire already runs (source output → new input). Priority is
explicit drop point → right-of-selection → cursor, so a deliberate drop still wins and the old
behaviour survives as the fallback when nothing is selected.

Occupied slots step DOWN, not right: several nodes added off one source is a fan-out, and a fan reads
as a column — stepping right would draw a chain the graph does not have. Overlap is judged on the node
BODY rather than its origin, so a near-miss counts as occupied instead of stacking two nodes while
reporting the slot free.

**Drag.** Browser entries route through the SAME `flarexPaletteDrag` channel the toolbar palette
already uses, rather than a second drag protocol with its own MIME. The canvas resolves that channel
into a drop AND a wire-splice when released over an edge, so a node found by SEARCH now splices
exactly like one that happened to earn a toolbar icon — inherited rather than reimplemented, and
therefore unable to drift out of sync with it.

*Rule: before adding a second mechanism, check whether the first one already reaches where you need
it.* The first draft here invented a custom drag MIME and a parallel drop handler; the canvas already
had both, plus splice-on-wire behaviour the new path would have lacked.

**Gate.** `placeAfterNode` is pure, so the placement rule is tested without a canvas —
`flarex:align:test` +6 assertions covering direction, level-with-source, the downward step, near-miss
overlap, non-interference from distant nodes, and a null for an unknown source id.

## TimeSpeed + Tracker: design note before code (2026-07-28)

`plans/flarex-timespeed-tracker.md`. The evaluation engine is frozen (ADR-008/009/010) and reviews ask
"does this satisfy ADR-010?", so both nodes were analysed against the closed question set BEFORE any
code. They land on opposite sides of it, which is the useful finding:

- **Tracker satisfies ADR-010 as it stands.** `TrackingData` is already in the ArtifactKind registry
  and ADR-010 already names `tracker` among the types the evaluator must not know about. v1 CONSUMES
  the `TrackingPathArtifactData` the person-extraction path already produces rather than computing a
  new track — a declaration exercise, buildable now, and the natural consumer of a real analyser's
  baked output later.
- **TimeSpeed does not, in the general case.** It does not read time, it rewrites the time its upstream
  subtree is evaluated at — and no question in the closed set lets a node say "evaluate my inputs at a
  different t". That is a new evaluator DECISION, which is exactly and only what reopens ADR-010.

Recommended: lower TimeSpeed at compile time scoped to MediaIn source sampling (no new question, covers
"play this clip at 50%", which is what the node usually means), name it honestly for that limit, and
save the ADR reopen for a case that genuinely needs whole-subtree retiming. Explicitly rejected:
declaring it `stateful` to borrow the temporal lane — retiming is pure, the declaration would be a lie,
and using §7 as a general escape hatch is how a frozen contract rots.

**Awaiting a decision before code.** The two options are not nested: they differ in node name, socket
shape and inspector copy, so the narrow one cannot be quietly widened later. Shipping the narrow one
while letting people believe they have the general one is the v32i merge-blend mistake again — two
constructs sharing a lowering shape do not share its semantics.

## Tracker v1 — match-move against an existing track (2026-07-28)

Per `plans/flarex-timespeed-tracker.md` §1 and ADR-010. **The node was already declared** in
`node-defs.ts` (image in → image out, `trackingPathId`) and lowered to `passthrough` — declared for the
palette surface, never wired. v1 is its lowering, not its design.

**Scope: consume, do not analyse.** It follows a `TrackingPathArtifactData` the person-extraction path
already produces. Computing a track is a tracking algorithm — a different project with a different risk
profile, and what "make our trackers advanced" means later. That analyser will declare `stateful` + a
seek contract and bake to exactly this artifact, so this node becomes its consumer unchanged.

**ADR-010: satisfied by declaration alone.** No new evaluator question, no new ArtifactKind —
`TrackingData` was already in the registry and ADR-010 already named `tracker` among the types the
evaluator must not know about. Contrast TimeSpeed, which needed ADR-011.

**The parity decision, which drove the whole design.** The obvious shape is "reference the track by id".
It is wrong here: `editableFields` lives on `ProjectGraph`, which the RENDERER NEVER RECEIVES. A
by-id-only Tracker would follow the track in the preview and sit still in the export — silently, and
only on a real render. So the track is EMBEDDED in node params as JSON (the flat-params convention for
complex payloads), which puts it in the manifest that both renderers read. `trackingPathId` survives as
provenance for re-link, not as what renders. An optional `resolveTrackingPath` adapter exists for
callers that have a store, but it is deliberately the fallback: if it ever became primary it would have
to reach Remotion too.

*Rule: before referencing data by id, check that every consumer can resolve the id.* The renderer's
input is the manifest and nothing else — anything not in it does not exist at export time.

**Lowering.** A shell transform at `STAGE_TRANSFORM`, like the Transform node, but COMPOSED rather than
assigned: a Tracker downstream of a Transform must follow the track on top of the user's framing, so it
adds to `x`/`y`, multiplies `scale`, adds `rotation`. Transform overwrites because it *is* the framing;
this is a delta.

**Sampling is relative to the track's first point.** `sampleTrackingPathAt` returns an offset, so
attaching a tracker leaves the picture where the user put it and then follows. Absolute output would
make every Tracker node a jump cut on insertion. Scale composes as a RATIO (a track that doubles the
subject doubles the attached element regardless of base scale); rotation as a difference. Endpoints
hold outside the track's duration, as every NLE does when a clip outlives its track.

**Soft-degrade, never blank.** Missing track, empty points, or corrupt JSON → pass through. A comp whose
track was deleted must still render un-tracked, and a per-frame lowering on the playback hot path must
never throw.

**Gates.** `flarex:test` +12 assertions: identity at the track's own start, linear interpolation, the
ratio/difference composition rules, endpoint holding at both ends, the empty track, the embedded path
driving the shell while the input child stays untouched, the adapter path, a bare id with no adapter
passing through, and corrupt JSON not throwing. Shared + web typecheck clean; `wcpool` 69/69,
`coherence` 5666/5666, `fullres` 203/203, `gop` 26/26, `flarex:align` green.

**Left open deliberately.** No inspector UI for choosing a track yet — the node renders from data but
nothing populates that data from the editor. That is the next slice, and it is UI work rather than
contract work.

**Drag-from-menu did nothing on first ship (2026-07-28, user-reported).** Two independent faults, either
of which alone was fatal:

1. **The click-away backdrop swallowed every drop.** `.flarex-menu-backdrop` is `position: absolute;
   inset: 0; z-index: 40` — while a menu is open it blankets the entire canvas. The drag worked; the
   drop landed on a div with no drop handler. The canvas never saw it.
2. **Closing the menu on `dragstart` aborted the drag.** That close was written deliberately — the menu
   is anchored at the cursor and would otherwise cover the drop target — but unmounting the drag SOURCE
   mid-drag cancels the drag in Chrome. The fix for the second problem caused a third.

Both now use one `menuDragging` flag: the menu and the backdrop stay MOUNTED and take
`pointer-events: none` for the duration, and the menu closes on `dragend`, by which time the drop has
been delivered. Applied to the canvas add-node menu and the toolbar Browse popover, which had the same
pair of faults.

*Rule: an overlay that exists to catch clicks will also catch drops.* A full-bleed backdrop is
invisible in every sense — it does not appear in the UI, it does not appear in the component you are
debugging, and it silently owns every pointer event over the surface you think you are targeting. The
palette buttons worked from day one because the toolbar has no backdrop over the canvas; the identical
code failed from the menu for reasons entirely outside it.

*Second rule, cheaper: this could not have been caught by a typecheck or a unit test, and I shipped it
saying so.* Drag-and-drop across two stacking contexts is exactly the class of change that needs a
human to try it once before it counts as done.
