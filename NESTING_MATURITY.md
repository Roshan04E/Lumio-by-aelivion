# Nesting Maturity — Audit + Plan (Blocks 2–6)

Status update 2026-07-17 (same day): **Blocks 2, 3, 4 (a+b+c) and 5 are IMPLEMENTED** — see
"Shipped" at the bottom. Block 6 (tails) remains open.

Date: 2026-07-17. Follows [NESTING.md](NESTING.md) (design, Premiere semantics — still authoritative) and
[NESTING_BLOCK1_PLAN.md](NESTING_BLOCK1_PLAN.md) (renderer wiring, shipped + reviewed 2026-07-05).
Trigger: user report — "group doesn't support text/transitions/effects", "no timelines in the media pool",
"refresh inside a group loses the main composition".

## Part 1 — Audit: what nesting ACTUALLY supports today

The render side is further along than it looks from the editor. Verified by reading
`packages/shared/src/nesting.ts`, `packages/shared/src/scene/build-scene-draws.ts`,
`packages/shared/src/color/scene-compositor.ts`, `EditorPage.tsx` (nest handlers ~3688–3848, load ~1071),
`TimelineStrip.tsx` (double-click open, context menu), and the fixture registry.

### Works today (pixel- or unit-gated unless noted)

| Capability | Status |
| --- | --- |
| Media / **text** / shape children inside a nest | ✅ render in all 3 renderers, built against the NEST's own w/h (editor.test, 10 checks) |
| Child↔child **transitions inside** a nest | ✅ (R2 step 3 / D4) — pixel fixture `nested-transition` in the 30-fixture sweep |
| Region effects on nested children | ✅ fold into per-child `regionPasses` uniformly |
| Track mattes (nested member as source, compound clip as source) | ✅ (D1) |
| On the group clip itself: transform/opacity keyframes, fit, blend, **mask**, blur, glow, 3D tilt, content pan/zoom/crop | ✅ via `buildShellPresentation` shell on the group RTT |
| Trim / constant speed on the group clip (children time-remapped exactly, incl. child speed ramps) | ✅ closed-form, unit-tested |
| Trim clamp to nest length | ✅ `getLayerMaxDuration(…, graph.compositions)` wired in EditorPage + TimelineStrip |
| Two instances of one nest | ✅ namespaced ids → distinct decoders/proxies/rasters |
| Nests-in-nests **rendering** | ✅ recursive groups, depth cap 8, cycle guard |
| Group / Ungroup actions, double-click to open, one-level breadcrumb | ✅ (Phase B minimal) |
| Editing INSIDE an open group | ✅ full editor — it IS the active composition (add text, effects, transitions all work while inside) |

So "supports nothing" is mostly a perception produced by the four REAL holes below — especially №1/№2
(silent no-ops on the group clip) and №4 (the stranded-refresh state making everything look broken).

### Real gaps (the audit findings)

1. **Color/grade effects on the group clip are a silent no-op.** Media layers get graded per-layer by
   `WebglMediaLayer` → `getMediaGraded(id)`; a compound clip mounts no media layer, and
   `SceneGroupDraw.shell` (`buildShellPresentation`) carries NO color pipeline — so brightness/curves/LUT/
   any color effect applied to a group does nothing. The inspector happily lets you add them → "effects
   don't work". Blur/glow/mask/blend DO work (they're shell fields).
2. **Region effects on the group clip are a no-op** for the same reason: `expandEffectRegionMasks` runs
   AFTER nest expansion, by which point the compound clip is removed from the tracks — it never gets region
   clones, and the shell is emitted without `regionPasses`.
3. **Junction transitions on a group clip hard-cut** (Block 1 Task 7, never done). The transition fold's
   `buildClipGroup(baseId)` looks the id up in the EXPANDED layer list, where the compound clip no longer
   exists → empty side → falls through to a cut. You can SET the transition in the popover; it just doesn't
   mix → "transitions don't work".
4. **Refresh inside a group strands the project** (user's data-loss report). `handleOpenNestedClip` SWAPS
   `graph.composition` to the nested comp and stashes the root under `graph.compositions[rootId]` — and
   PERSISTS that. The breadcrumb is only React state. On reload, `graph.composition` (= the nest) loads as
   the root, breadcrumb is gone, and nothing in the UI can reach the stashed main comp. **The main comp is
   NOT deleted** — it's in `graph.compositions` — but it is unreachable. Affected projects are recoverable
   (Block 2 ships a load-time healer).
5. **Audio inside a nest ignores the compound clip's volume automation and the nested track's fader**
   (Block 1 `// NEST-REVIEW:` — clip volume is a keyframable EFFECT, not a scalar; folding needs a
   time/speed-remapped synthesized effect per derived child). Unity gain (default) unaffected.
6. **No composition browser.** Compositions are invisible outside the timeline: no media-pool listing, no
   rename (every group is literally named "Group"), no way to place a second instance, no "new empty
   timeline", no delete (removing the last compound clip orphans the comp invisibly in the graph).
7. **One-level navigation only**: opening a nest inside a nest is blocked ("nests-in-nests aren't supported
   yet"); the Group ACTION also refuses to include an existing group in a new group — even though the
   RENDERER fully supports recursive nests.
8. **Un-nest** only works untrimmed/unsped (v1, by design — needs the expansion math to splice correctly).
9. Small v1 leftovers: speed *ramps* ON a group clip rejected; work-area + shell start/duration correction
   gap in `buildRenderManifest` (NEST-REVIEW #4); DOM-fallback preview degrades group-level compositing
   (scene path is default — low priority).

## Part 2 — Plan

Ordering rationale: Block 2 is the data-model foundation (and the data-loss fix) that Block 3's Timelines
folder needs; Block 4 kills the two silent no-ops that read as "nothing works"; Block 5–6 are correctness
tails. Renderer changes land in the shared compositor once → all three renderers by construction; every
render-visible change gets a pixel fixture (repo rule).

### Block 2 — Composition registry + persistent navigation (fixes №4, №7-nav)

**Model:** stop treating `graph.composition` as the only real slot.
- `ProjectGraph` gains `rootCompositionId?: string` and `activeCompositionId?: string`.
- Invariant: `graph.compositions` contains EVERY composition **including the root/main**, keyed by id.
  `graph.composition` REMAINS the active comp (unchanged contract for every existing EditorPage write site,
  api, worker, export — zero churn there).
- One write-through seam: `updateGraph` (EditorPage ~2732) mirrors `nextGraph.composition` into
  `compositions[nextGraph.composition.id]` and keeps the two pointers stamped. No other write site changes.
- **Load migration/healer** (in the project-load path ~1071): missing `rootCompositionId` → if some comp in
  `compositions` references `composition.id` via a `nestedCompositionId` clip, the loaded comp is a NEST —
  adopt the referencing comp as root and restore the breadcrumb state (this HEALS already-stranded
  projects, including the user's); otherwise adopt `composition.id` as root+active and seed the registry.
- Breadcrumb becomes DERIVED state (`activeCompositionId !== rootCompositionId` → path), persisted by
  construction; replace the single-level guard with a **stack** (path of comp ids) so nests-in-nests open;
  lift the Group action's "no groups in a group" exclusion (renderer already handles recursion + cycle
  guard `wouldCreateCompositionCycle` already exists — use it at action time).
- Navigation stays out of undo history (existing, correct choice); history snapshots already carry the
  whole graph so cross-comp undo keeps working.
- Export/render semantics: exporting renders the ACTIVE comp (Premiere-like). Document it in the export UI
  ("Exporting: <comp name>").
- Gates: editor.test — write-through invariant, migration of legacy graphs, healer on a stranded graph,
  multi-level open/return; manual refresh QA inside a 2-deep nest.

### Block 3 — "Timelines" in the media pool (№6)

- Asset bin gains a built-in **Timelines** section (alongside the existing folders in the asset panel,
  EditorPage ~10152): one tile per comp in `graph.compositions` (enumerable now, thanks to Block 2), root
  badged **Main**, root-first ordering. Auto-created — including for existing projects (migration puts main
  in the registry, so the folder is never empty).
- Tile actions: **double-click → open** (same navigation as breadcrumb); **drag to timeline → insert a
  compound clip** referencing it (duration = comp duration, cycle-guarded, uses the standard drop flow);
  context menu: **Rename** (updates comp + instance clip names), **Duplicate** (deep clone, fresh ids),
  **Delete** (blocked while referenced, with "delete and remove N instances" confirm), **New timeline…**
  (empty comp at project dims/fps).
- Group action names sequences uniquely ("Group 01", "Group 02"…) instead of always "Group".
- Deleting the last instance of a group no longer orphan-leaks silently — the comp stays visible (and
  deletable) in Timelines. That's a feature (Premiere project-panel semantics), not a leak, once visible.

### Block 4 — Group-clip render parity (№1, №2, №3)

- **4a Shell color pipeline:** grade the composited group RTT in-compositor before the shell layer-draw,
  reusing the existing in-context region-grade machinery (`regionGradeEntry` pattern — zero new GL
  contexts), keyed per group instance; `buildGroupDraw` threads `getCompositionColorPipeline(spec.clip, t)`
  onto the group draw. Lands once in `SceneCompositor` → preview/local-export/Remotion together.
- **4b Shell region passes:** build `regionPasses` for the shell from the group clip's region effects
  (mirror `buildRegionPasses` against the PARENT matte cache — the shell already renders through the normal
  layer-draw path, which honors `regionPasses`).
- **4c Junction transitions** (old Task 7): make the side builder group-aware — when a transition side's
  base id is a group key, the side is `[buildGroupDraw(key)]` (compositor side-render already accepts any
  `SceneDraw` via Task 1's recursion); the fold must key compound ids off the RAW comp's junctions since
  the clip is absent from the expanded list. Covers group↔clip and group↔group.
- Gates: new pixel fixtures `nested-grade` (LUT + brightness + region blur on a compound clip) and
  `nested-junction-transition`; full sweep; `render:manifest` smoke on a nested manifest (the Block 1
  leftover that was never run).

### Block 5 — Audio correctness (№5)

- In `expandClip` (nesting.ts): synthesize a time/speed-remapped **volume effect** per derived child folding
  the compound clip's own volume automation (same substitution as `mapAnimations`, applied to effect param
  keyframes), and fold the nested track's static fader gain (scalar multiply into the synthesized effect).
- Track-level automation INSIDE nests stays deferred (documented).
- Gates: editor.test on the expansion output (keyframed volume on the compound → child effect values at
  parent times); ear-check QA script note.

### Block 6 — Tails (each independently shippable, lowest priority)

- Un-nest of trimmed/sped groups (reuse the expansion time-mapping to splice real layers back).
- Speed ramps ON a group clip (lift the v1 scalar-only constraint — the substitution needs the integral
  form, not the affine one).
- Work-area + shell start/duration correction in `buildRenderManifest` (NEST-REVIEW #4).
- DOM-fallback preview group parity (scene path is default; document the degrade until then).

### Explicitly still deferred (unchanged from NESTING.md)

Per-instance nest overrides (Premiere has none either), multicam, flatten/render-in-place, nested-track
automation.

## Suggested execution order

Block 2 → 3 are one arc (data model + its UI) and fix the reported data loss first. Block 4 is the
biggest perceived-quality jump ("effects/transitions on groups work now"). 2→3→4→5→6.

## Shipped (2026-07-17)

- **Block 2**: `ProjectGraph.rootCompositionId`/`activeCompositionId` (types.ts); shared
  `stampCompositionRegistry`/`healCompositionRegistry`/`deriveNestBreadcrumb`/`findRootCompositionId`
  (nesting.ts); write-through seam in EditorPage `updateGraph`; load-time healer in `loadProject`
  (restores stranded projects AND the breadcrumb after refresh); breadcrumb is now a multi-level
  STACK (`nestPath`) — nests-in-nests open; the Group action nests compound clips too and names
  sequences uniquely ("Group 01"…). Gates: editor.test `registry:`/`healer:` checks.
- **Block 3**: `TimelinesPanel` in the assets tab above the bin (EditorPage) — every comp listed
  (Main badged, root-first), double-click opens, drag → `application/x-kimera-composition` drop on a
  video lane inserts a compound clip (cycle-guarded `handleInsertCompositionClip`), context menu:
  Open / Place at playhead / Rename (renames instance clips everywhere) / Duplicate / Delete
  (blocked for root/open; confirm removes N instances) / header "+" = New timeline (opens it).
- **Block 4a**: `SceneGroupDraw.pipeline`+`groupKey`; `renderGroupInto` grades the finished nest RTT
  in-context via `regionGradeEntry("group:<key>")` before the shell composite. 4b: `buildGroupDraw`
  derives the group clip's region passes via `expandLayerEffectRegions` + `buildRegionPasses`
  (parent matte cache) and attaches them (+ fragment passes) to the shell. 4c:
  `findTransitionPairsWithGroupJunctions` (composition-style.ts) unions RAW-comp compound junctions
  into the pair scan (wired in VideoPreview, scene-frame-compositor via `rawJunctionLayers` option,
  SceneStage via `RenderManifest.rawJunctionLayers`); `SceneTransitionDraw.from/to` widened to
  `SceneDraw[]`; `buildTransitionSide` pre-composes a compound side as its finished group; group-as-
  incoming emits the mix at the group's z-slot, group-as-outgoing is consumed by the mix. Gates: new
  pixel fixtures `nested-grade` + `nested-junction-transition`.
- **Block 5**: `expandNestedCompositions` folds the compound clip's volume automation (synthesized
  time-remapped `volume` effect per audio/video child, `__nestvol_<clipId>`) and the nested track's
  static fader; a child with its OWN volume effect is scaled by the clip's STATIC gain × fader
  (documented approximation — two keyframed curves can't merge). Gates: editor.test `audio fold:`.
- **Preview nested-audio silence: FIXED.** The preview's audio path read the RAW composition, so a
  compound clip (`type:"video"`, filtered out) played SILENT even though both export paths already
  expand nests and mix nested audio (`collectAudioLayers` on the expanded comp / manifest-flattened
  audio layers). `VideoPreview` now flattens audio from `nestExpansion.composition.tracks` — the same
  expansion the video path uses — restoring preview↔export parity. Block 5's volume fold already
  baked the nested track fader + compound gain into each child, so parent-track gain stays unity (no
  double-count). Two junction fixes below also landed:
- **Trimmed-group junction pre/post-roll: FIXED (same day).** `expandNestedCompositions` widens a
  junction-adjacent compound clip's child window by the transition duration (material-capped by the
  trim's real head/tail handles — asset physics), so the mix reads REAL nest material before/after
  the cut; the derived children anchor on the BASE window (`winStartBase ↔ clip.startSeconds`), and
  `buildSceneDraws` span-gates the group's standalone emission so extended children never render
  outside a mix. Gates: editor.test `junction extension:` (5 checks incl. no-junction no-op) +
  pixel fixture `nested-junction-preroll` (trimmed incoming sampled pre-cut).
- **Follow-ups (same day, user feedback):** Timelines moved from a stacked section to a first-class
  media-pool TAB (Search/Local/AI/Brand/Used/**Timelines**) — zero vertical cost, full-height
  scrollable list, "Unused"/"N×" instance badges (orphaned sequences are now legible + one-click
  deletable). **Trim-handles fix:** TimelineStrip's `getLayerMaxDuration` no longer clamps a clip's
  max duration to the comp's CURRENT length (a grouped sequence is exactly content-sized, so every
  clip inside a nest — any depth — was untrimmable); unbounded layers (text/shape/image) get
  +300s headroom past the comp end in EditorPage's builder; the timeline auto-grows on commit via
  `normalizeCompositionDuration`, and the parent's compound clip picks up the longer nest as new
  tail handle immediately (live registry read).
