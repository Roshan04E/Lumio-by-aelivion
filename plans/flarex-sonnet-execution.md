# Flarex — Sonnet 5 execution plan (Phase 1.5 completion)

> **Who this is for**: Claude Sonnet 5 executing the remaining Flarex work. Read `FLAREX.md`
> (repo root) first for the full architecture — this doc only tells you WHAT to build next,
> in exact steps, with the traps marked. Decisions in FLAREX.md are settled; do not re-plan.
>
> **Hard fence — DO NOT ATTEMPT (reserved for a stronger model, see the last section):**
> anything inside `packages/shared/src/color/scene-compositor.ts`, the Phase 2 interpreter /
> per-node RTT caching, `SceneFragmentPass.auxInputs` / Displace, Text node lowering, the
> aiMatte node, multi-clip MediaIn, the Tracker node, and ANY playback-performance work.
> If a task below seems to require touching those, STOP and leave a note in
> `project-tracker/` instead of improvising.

## How to work (non-negotiable repo rules)

- Verification loop after EVERY task: `pnpm --filter @orreris/shared typecheck`,
  `pnpm --filter @orreris/web typecheck`, `pnpm --filter @orreris/worker typecheck`,
  `pnpm --filter @orreris/shared flarex:test`. AI-routing tasks additionally:
  `pnpm --filter @orreris/web brain:eval`. There is no eslint — typecheck IS lint.
- Every comp mutation goes through ONE seam: build the next `FlarexComp`, then
  `onUpdateGraph({ ...stampFlarexComp(graph, next), version: graph.version + 1 })`
  (see `FlarexWorkspace.tsx` `updateComp`). Never mutate `graph.flarexComps` directly,
  never forget the version bumps (comp.version is the render dirty key).
- One user gesture = ONE `updateComp` commit (= one undo step). Drafts stay local state.
- Rendering changes must hold 3-renderer parity (preview / local export / Remotion). All
  Flarex rendering flows through `compileFlarexComp` → existing SceneDraw primitives — if
  you stay inside `packages/shared/src/flarex/`, parity is automatic. That is the point.
- `architecture.md`: add an `[x]` entry when you ship a task. Recurring problems:
  append (never rewrite) to the matching `project-tracker/` file.
- Never "fix" code that looks odd but ships (repo directive). The timeline's non-idiomatic
  perf patterns are deliberate.

## Task S1 — LumaKey in the palette (warm-up, ~15 min)

The `lumaKey` node def, its lowering, and the `flarex.lumaKey` fragment builtin ALL exist
and are tested. It is only missing from the UI palette.

1. `apps/web/src/editor/flarex/FlarexWorkspace.tsx` → `PALETTE_GROUPS` → add `"lumaKey"`
   to the "Key/Mask" group after `"chromaKey"`.
2. `apps/web/src/editor/flarex/FlarexInspector.tsx` → check the `RANGES`/`ENUMS` maps
   cover lumaKey's params (`low`, `high`, `softness` all 0..1 sliders; `invert`,
   `matteOnly` bools). Add rows only if missing — mirror the chromaKey entries.

Done when: LumaKey appears in the toolbar, adds a node, params edit, and wiring
in → out keys the clip in the viewer (test on any footage: high ≈ 0.9 knocks out
brights). No shared-package changes should be needed.

## Task S2 — Keyframe UI for node params (the big one)

Everything below the UI already exists: keyframe scope `"flarexNode"` (`effectId` slot
carries the NODE id, `property` the param key), evaluator `evaluateFlarexNodeParam` in
`packages/shared/src/animation.ts`, and the compiler samples every numeric param
keyframe-aware via its `num()` helper at comp-local time (`ctx.timeSeconds` =
`playhead − layer.startSeconds`). Keyframes live in `FlarexComp.animations`
(`TimelineKeyframeV2[]`). You are building ONLY the write/read UI.

### S2a — Inspector diamonds

1. Study the canonical pattern first: `apps/web/src/editor/inspector/controls/KeyframeButtons.tsx`
   and its use in `apps/web/src/components/EffectSliderControl.tsx` (diamond + prev/next/clear;
   this exact affordance is a repo-wide invariant — do not invent a new one).
2. In `FlarexInspector.tsx`, for each NUMERIC param row whose key is in the node def's
   `keyframeable` list (`flarexNodeDefs[node.type].keyframeable`), render `KeyframeButtons`.
3. State the buttons need, computed from `comp.animations` filtered to
   `target.scope === "flarexNode" && target.effectId === node.id && target.property === key`:
   has-any-keyframes, is-on-keyframe-at-current-time, prev/next keyframe times.
4. You need the comp-local current time in the inspector. `FlarexWorkspace` currently gets
   `{ graph, layer, onUpdateGraph }` from EditorPage. Extend the seam with ONE prop:
   `timeSeconds` (the shared transport playhead, already available where
   `<FlarexWorkspace/>` mounts in `apps/web/src/pages/EditorPage.tsx` — grep how
   `BottomWorkspace` gets its time there and pass the same value). Comp-local time =
   `Math.max(0, timeSeconds - layer.startSeconds)`. Do NOT add more props than this.
5. Writes (all through `updateComp`, one commit per click):
   - **Toggle diamond on**: append a `TimelineKeyframeV2` at comp-local time with the
     param's current value (copy the shape from any producer of keyframes — grep
     `TimelineKeyframeV2` producers in `apps/web/src`; default easing same as they use).
   - **Toggle off / on-keyframe click**: remove the keyframe at that time (tolerance
     ±1/60s, matching keyframeUtils conventions).
   - **Clear**: remove all keyframes for that (nodeId, param).
   - **Prev/next**: seek the SHARED transport to `layer.startSeconds + keyframeTime` —
     seeking goes through whatever seek command EditorPage already exposes; if the seam
     has no seek, pass one more prop `onSeek(seconds)` wired to the existing transport
     seek used by other panels (grep for how BottomWorkspace/keyframe rows seek).
6. **Slider write rule (the animated-edit bug, already solved once on the Edit page)**:
   when a param HAS keyframes and the user drags its slider, the drag must write/update a
   keyframe at the current time — NOT the base param. Mirror the `apply*ValueAtTime`
   rule described in the auto-keyframe memory: if keyframes exist for (nodeId, key) →
   upsert keyframe at current comp-local time with the dragged value; else → write
   `node.params[key]` as today.

### S2b — Graph editor drawer adapter (only after S2a works)

`apps/web/src/editor/graph/BottomWorkspace.tsx` hosts the curve GraphEditor;
`apps/web/src/editor/inspector/keyframeUtils.ts` is the reflection layer that turns
scopes into graph targets. Add `"flarexNode"` support so selected-node params appear as
curves while the Flarex page is active:

1. Read `keyframeUtils.ts` end to end. Find where scopes/targets are enumerated for the
   selected clip and how `animations` arrays are located per scope.
2. The flarexNode twist: animations live in `comp.animations` (NOT on the layer), and
   edits must round-trip through `stampFlarexComp`. Follow the existing write path for
   other scopes and branch where the animations array is read/written.
3. Keep it read+edit for existing keyframes only (add/remove stays in the inspector) if
   the write plumbing gets deep — a read-only curve view that edits VALUES/EASING of
   existing keyframes is an acceptable first landing; note what you deferred.
4. **Un-gate the drawer on the Flarex page** (user ask 2026-07-21): EditorPage renders
   `BottomWorkspace` only when `bottomWorkspaceOpen && editorPage === "edit"` (grep
   `editorPage === "edit"` near the BottomWorkspace mount). Once flarexNode targets
   exist, drop the `editorPage` condition (and make Shift+G work while the Flarex page
   is active) so curves open under the node editor too. Do NOT un-gate before the
   targets exist — an empty drawer on the Flarex page is worse than none.

Done when: diamond a Transform node's `x` at two times → scrubbing animates the node in
the viewer; export (local) shows the same motion; `flarex:test` still green; typecheck
green. Add a small `flarex:test` block: build a comp with a keyframed blur sigma, call
`compileFlarexComp` at t=0 and t=2, assert the lowered `blurPx` differs and matches the
evaluator's values.

## Task S3 — Polygon + Bezier mask nodes

Defs exist (`polygonMask`, `bezierMask` in `node-defs.ts`) but do not lower. Rect/ellipse
lowering (in `compile-flarex.ts`, `case "rectMask"`) is your template: build a vector
`Mask` (`packages/shared/src/clip-masks.ts`), set id/feather/inverted, return a matte
value; rasterization happens via `ctx.matteCache` exactly as rect/ellipse do.

1. Read `clip-masks.ts` for the path-shape model (how the existing bezier/polygon masks
   store points — grep for how the Edit page's mask tool builds path masks; points are
   normalized or px, copy that convention EXACTLY so `SceneMaskMatteCache` rasterizes it).
2. Node params: store points as a JSON string param (repo convention for complex payloads),
   e.g. `points`: `"[[0.2,0.2],[0.8,0.25],[0.6,0.9]]"` in comp fractions; plus `feather`
   (0..1 fraction like rect), `invert` bool. Update the Zod schema in `node-defs.ts`
   (keep `.strict()` + defaults: a sensible default triangle/square so a fresh node shows
   something).
3. Lowering: parse points (soft-fail to default on bad JSON — never throw), scale comp
   fractions → comp px (`ctx.compWidth/Height`), build the path `Mask`, same feather rule
   as rect (`fraction × min(w,h) × 0.5`), `mask.id = "flarex_${comp.id}_${node.id}"`.
4. UI: add both to `PALETTE_GROUPS` "Key/Mask". Inspector: feather slider + invert bool +
   a plain multiline text row for the points JSON (crude but functional — on-viewer point
   editing is explicitly OUT of scope, do not build it).
5. Tests: add flarex:test checks — polygon node lowers to a matte with N points; bad
   points JSON soft-degrades (node passes through / default shape, no throw); matteControl
   combines a polygon matte with a rect matte.

Done when: a polygon mask wired into Blur.mask blurs only inside the polygon in the
viewer, typecheck + flarex:test green.

## Task S4 — render:compare pixel fixture for Flarex

Goal: lock 3-renderer parity for Flarex output with the existing pixel-diff harness so
future changes can't silently break it.

1. Read `apps/worker/src/render-pixel-comparison.ts` (`pnpm --filter @orreris/worker
   render:compare:pixels`) — see how existing scenarios build a composition, render web
   preview vs Remotion, and diff (outputs land in `tmp/render-comparison/`).
2. Add ONE Flarex scenario: a clip whose layer has `flarexCompId` pointing at a comp with
   MediaIn → ChromaKey (green, defaults) → Transform (scale 0.8, x offset) → Glow →
   MediaOut, over a colored background layer. Use whatever synthetic/green-screen source
   the harness already uses (there is a chroma-key test asset — grep the repo's existing
   chroma scenarios; `tmp/render-comparison/web-preview-chroma-key.png` exists, find its
   scenario). Remember the manifest carry: `flarexComps` + layer `flarexCompId` must be in
   the manifest (already wired in `packages/render-templates`); your scenario just sets
   the fields on the graph.
3. Follow the harness's existing threshold conventions. If the diff fails, do NOT tune
   the compositor — investigate the scenario data first; if a real renderer divergence
   appears, STOP (that is fenced work) and log findings in
   `project-tracker/playback-preview.md`.

Done when: the new scenario passes in `render:compare:pixels` and is committed as part of
the fixed suite.

## Task S5 — Node canvas UX batch (independent, any order)

All inside `apps/web/src/editor/flarex/` — no shared-package changes.

1. **Click a wire to select, Delete removes it**: add wire hit-testing to
   `flarex-canvas-model.ts` (distance point→bezier: sample the curve at ~24 points,
   min distance < 6px screen). NOTE: node selection is ALREADY multi-select
   (`selectedNodeIds: string[]` + marquee + shift-click, shipped 2026-07-21) — add a
   separate `selectedEdgeId: string | null` beside it (an edge click clears node
   selection and vice versa). Delete guard for MediaIn/Out stays.
2. ~~Insert-on-wire~~ SHIPPED 2026-07-21 (Fable): palette drag-drop + drop-on-wire splice
   via `spliceFlarexNodeIntoEdge` in `packages/shared/src/flarex/registry.ts` and
   `hitTestWire` in `flarex-canvas-model.ts`. Remaining for you: add flarex:test checks
   for `spliceFlarexNodeIntoEdge` (splices blur into in→out edge producing 2 valid edges;
   returns null for a matte-only node on an image wire; returns null when the input is
   already wired; original edge removed).
3. **Drop-on-empty-input affordance**: while dragging a wire, paint type-compatible
   candidate input sockets with a highlight ring (you already have `target` highlighting;
   extend to ALL compatible sockets at lower alpha).
4. **Comp rename**: make the comp name in the toolbar an inline-editable input committing
   through `updateComp` (rename = `{ ...current, name }`).
5. **Fit/Home view**: key `F` (when canvas focused/hovered) fits all nodes in view
   (compute bounds → set pan/zoom). Mind the existing capture-phase Delete handler —
   scope the key listener the same way.

Done when: each behaves in the browser, no new props leak into EditorPage, typecheck green.

## Task S6 — Small AI/routing extensions (optional, only if S1–S5 land)

1. Intent DSL already supports `key.kind: "luma"` — add 2 brain:eval MUST-escalate cases
   for luma phrasings that should NOT hit the chroma reflex ("key out the bright sky").
2. Add a `t2.flarex-key` variant acceptance: "key out the greenscreen" (one word) — check
   the existing regex in `apps/web/src/ai/brain/semantic.ts` `flarexKeyResult` covers it;
   if not, widen `\bgreen\s*-?\s*screen\b` to also match `greenscreen` and add an eval
   case that fires.
3. Rule: NEVER add a reflex without both fire-cases and escalate-cases in
   `apps/web/src/ai/brain/router-eval.test.ts`, and `brain:eval` fully green.

## Fenced off — DO NOT BUILD (reserved, deep engineering)

> **STATUS 2026-07-21: S1–S6 executed by Sonnet — all shipped except S2b (GraphEditor drawer
> adapter), which is hereby MOVED to the fence below: the layer-vs-comp seam mismatch
> (`GraphEditor`/`keyframeUtils` hard-require `TimelineLayer`; the clean fix is an `EditSubject`
> abstraction over a 1487-line perf-sensitive file) is deep-engineering per the tracker v7
> write-up. The stylize-ink/stylize-subject pixel failures found in S4 belong to the P5
> subject-aware landing (committed before this work), not Flarex — also fenced.**

| Item | Why it is fenced |
|---|---|
| S2b GraphEditor `flarexNode` adapter (`EditSubject` refactor + drawer un-gate) | Layer-vs-comp seam redesign of a perf-sensitive 1.5k-line editor (tracker editor-ui v7 has the resumption plan) |
| stylize-ink / stylize-subject `render:compare:pixels` failures (7.9%/8.0%) | P5 subject-aware landing issue (likely mask availability differs across harness renderers) — stylize engine territory |
| Phase 2 `renderNodeGraphInto` interpreter, per-node RTT dirty cache, VRAM LRU | Lives inside `scene-compositor.ts`; GL resource lifetimes + parity-by-pixel-gate work |
| `SceneFragmentPass.auxInputs` + Displace / custom merge math | Compositor extension incl. the export-worker single-context path |
| Text node lowering | Needs a rasterizer hook with byte-identical output across web + worker (font loading parity) |
| aiMatte node | Cross-renderer artifact contract (OPFS artifact-store on web vs durable URIs in the worker via `matte-resolve.ts`) |
| Multi-clip MediaIn (`sourceClipId`), Tracker node | Compiler ctx redesign + tracking data plumbing |
| Playback stutter at overlapping flarex clips | Accepted-for-now; the fix IS the Phase 2 interpreter |
| Anything in `scene-compositor.ts`, `color/pipeline`, proxy/decode/playback systems | Perf + parity land mines; a plausible-looking fix here can corrupt exports silently |

If blocked by the fence, write what you found in `project-tracker/` (append-only, new
version entry) and move to the next task.
