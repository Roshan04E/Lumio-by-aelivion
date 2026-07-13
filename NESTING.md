# Nesting / Compound Clips — Design (Premiere-architecture-aligned)

Status: **design approved-pending, Phase A starting** (2026-07-03). Owner: Claude. Tracker: NLE_ANALYSIS §4/§6.3.

## Why this shape

Kimera already imports Premiere projects and **preserves nested sequences** (`external-timeline-adapter.ts` emits
`TimelineLayer.nestedCompositionId` + `ProjectGraph.compositions`). Native nesting must therefore be the SAME
mechanism — an imported Premiere nest and a user-created compound are one feature, one data model, one renderer
path. No parallel "compound clip" concept.

## Premiere semantics we replicate (researched 2026-07-03)

1. **A nest is a real sequence** used as a clip. It lives at project level; the clip is a *reference*.
   Kimera: nested sequence = `TimelineComposition` in `ProjectGraph.compositions`; `graph.composition` stays the
   root/active deliverable. The clip is a `type:"video"` layer with `nestedCompositionId` (matches the importer).
2. **Live reference**: editing the source sequence updates every instance. (By-reference storage gives us this.)
3. **The nested clip behaves like any clip**: trim (`sourceInSeconds`/`durationSeconds`), constant `speed`,
   transforms, effects, masks, blend modes, transitions — all apply to the **composited output** of the nest.
   Its "media length" = the nested sequence's duration.
4. **Duration is not live**: shortening the source sequence does NOT shrink placed clips — the overhang renders
   as empty (Premiere: black/silence; Kimera: transparent + silence, see §Alpha). Lengthening the source doesn't
   auto-extend clips; the user trims to reveal (max duration = nested comp duration via `buildLayerMaxDurations`).
5. **Alpha is preserved** (nesting a title stays transparent over lower parent tracks). The nested comp's
   `backgroundColor` applies only when it is opened/rendered as the root — as a clip source it composites with
   a TRANSPARENT background.
6. **Nest command**: selection → moved into a NEW sequence (t=0-based, relative positions + track structure
   preserved) → replaced in place by ONE nested clip spanning the selection; the new sequence is a first-class
   project item (openable, reusable).
7. **Self-nesting forbidden**: no cycles (direct or indirect). Guard at action time + a visited-set/depth cap
   (8) at render time so a corrupt graph degrades instead of hanging.
8. **Open to edit**: double-click a compound clip opens its sequence as the active timeline (breadcrumb back).

## Rendering architecture: derived-layer expansion + group composite

All three renderers converge on shared `buildSceneDraws` + `SceneCompositor` (editor `ScenePreviewCanvas`,
local-export `SceneFrameCompositor`, Remotion `SceneStage`). Nesting lands there once, following the repo's
existing derived-layer precedent (`expandEffectRegionMasks` / `__rfx_` clones):

**`packages/shared/src/nesting.ts` — `expandNestedCompositions(composition, compositions)`**
- For each layer with `nestedCompositionId`, emit **derived child layers** mapped into parent-timeline
  coordinates, ids namespaced **`${clipId}__nest_${childId}`** (two instances of the same nest get distinct ids
  → distinct decoders/proxies/rasters/caches for free — same reason `__rfx_` ids work).
- Time mapping is the exact inverse of `layerSourceTimeSeconds` for constant clip speed:
  `childStart_parent = clipStart + (childStart − clipSourceIn) / clipSpeed`, durations ÷ clipSpeed, child speed
  × clipSpeed (child `speedKeyframes` scaled). Children clipped to the clip's `[sourceIn, sourceIn+duration]`
  window (partial overlap → trim + advance child `sourceInSeconds`). **v1 constraint: speed *ramps* on the
  compound clip itself are rejected by validation (constant speed fine) — Premiere allows it; deferred.**
- Recursion with visited set + depth cap for nests-in-nests.
- Audio children expand the same way; nested track static gain/pan fold into the derived layer volume
  multiplied by the compound clip's own volume. (Nested-track *automation* v1: evaluated… deferred — documented.)
- Track semantics inside the nest (solo/mute/lock) applied at expansion.

**Group composite (compound-level effects/masks/transform):** children can't just be inlined — the clip's
transform/effects/masks/blend/transitions apply to the *composited* nest output. `buildSceneDraws` folds each
clip's `__nest_` children into a **group draw** (like transition side groups): children render back-to-front
into an RTT at the nested comp's dimensions (transparent clear, ×renderScale), then that RTT is the source of a
standard `SceneLayerDraw` carrying the compound clip's fit ("cover" default), content transform, masks,
blur/glow, color pipeline (via the existing in-context pipeline pass), blend and transform. Transition sides
must accept group draws so compound↔clip junction transitions work.

**Per-renderer integration** (children are normal layers in parent coordinates, so existing per-layer source
mounting works untouched — the expansion just has to run before layer enumeration):
- Web preview: expand in `EditorPage`/`VideoPreview` render path (timeline UI keeps the UNexpanded comp — the
  user sees one compound clip; only renderers see children).
- Local export: expand in `export-core.ts` next to `expandEffectRegionMasks` (before source creation).
- Cloud: `buildRenderManifest` expands the same way; `RenderManifest` gains the group structure so `SceneStage`
  composites identically. Manifest carries what SceneStage needs (children reference assets as usual).

## Editor UX (Phase B)

- **Nest** (right-click selection / shortcut): timeline action creating the new composition (named
  "Nested Sequence NN"), replacing the selection in place. Needs graph-level access → the action returns the
  new composition alongside the edited one; EditorPage owns `graph.compositions` writes (8 write-sites, one
  helper).
- **Open**: double-click compound clip → `activeCompositionId` state; the editor edits
  `graph.compositions[id]` through the same one helper; breadcrumb `Root › Nest name` returns. Undo history
  spans both (compositions ride the same `projectGraph` snapshots).
- **Un-nest**: inline the nest's layers back (only when the clip is untrimmed/unsped or with a confirm),
  keeping the sequence in the project.
- Compound clips get a distinct timeline appearance + duration clamped to nest length.

## Gates (Phase D)

- `scene:compare` fixture: nested comp (media + text child, child transition) under compound transform+grade —
  scene vs DOM parity. DOM fallback path renders nests via the same expansion (derived layers are ordinary
  layers to it) — group-level effects on DOM degrade the same way region effects do there.
- `render:compare:pixels` nested fixture for Remotion parity; `editor:test` covers expansion math (time map,
  trim windows, speed folding, cycles, two-instance id separation).

## Explicitly deferred

Speed ramps ON compound clips; nested-track automation; multicam; per-instance nest overrides (Premiere has
none either); "render-in-place"/flatten-bake.

Sources: [Adobe — About nested sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-nested-sequences/about-nested-sequences.html),
[Adobe — Nest a sequence in another sequence](https://helpx.adobe.com/uk/premiere/desktop/edit-projects/edit-nested-sequences/nest-a-sequence-in-another-sequence.html),
[Premiere nesting guides: Motion Array](https://motionarray.com/learn/premiere-pro/premiere-pro-nesting-tutorial/),
[PremiumBeat](https://www.premiumbeat.com/blog/sequence-nesting-in-premiere-pro/),
[charlescabrera.com](https://charlescabrera.com/nest-and-unnest-sequences-in-premiere-pro/).
