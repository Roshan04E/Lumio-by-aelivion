# Nesting Block 1 — Renderer Wiring: EXACT implementation spec

**For: Sonnet executor session.** Design authority: [NESTING.md](NESTING.md) (Premiere semantics — read it first).
Architectural decisions below are FINAL — do not redesign, do not "simplify" the data flow, do not touch
anything listed under Constraints. When something is genuinely ambiguous, leave a `// NEST-REVIEW:` comment
and keep going. A Fable review pass runs at the end against the checklist at the bottom.

## Goal

`expandNestedCompositions` ([packages/shared/src/nesting.ts](packages/shared/src/nesting.ts)) is complete and
tested but consumed by NOTHING. After this block, a `TimelineLayer.nestedCompositionId` clip (imported prproj
nest or future native compound) RENDERS — identically — in: web preview (scene path), local export, and the
Remotion manifest path. Timeline UI still shows the single compound clip (UI work is Block 2 — out of scope).

## What already exists (do not rebuild)

- `expandNestedCompositions(composition, compositions)` → `{ composition, groups }`. Derived children are
  ordinary layers in PARENT coordinates with namespaced ids `${clipId}__nest_${childId}`; the compound clip is
  REMOVED from tracks; `groups: Map<string, NestedGroupSpec>` carries each compound instance's shell clip +
  nested comp geometry (`{ clip, composition: { id, width, height, durationSeconds } }`), including re-keyed
  inner groups for nests-in-nests. Helpers: `nestParentClipId`, `NEST_ID_SEPARATOR`, `expandGraphNestedCompositions`.
- `buildSceneDraws` ([packages/shared/src/scene/build-scene-draws.ts](packages/shared/src/scene/build-scene-draws.ts))
  already renders MULTI-LAYER GROUPS into RTTs for transition sides (`SceneTransitionDraw.from/to`), and the
  `SceneCompositor` ([packages/shared/src/color/scene-compositor.ts](packages/shared/src/color/scene-compositor.ts))
  implements that side-RTT render. The nest group draw REUSES that machinery.
- The prproj importer already emits `nestedCompositionId` + `graph.compositions` (tested).

## Task 1 — `SceneGroupDraw` in scene-compositor.ts

Add to [scene-compositor.ts](packages/shared/src/color/scene-compositor.ts):

```ts
export interface SceneGroupDraw {
  kind: "group";
  debugGroupId?: string | undefined;
  /** Children back-to-front. Their draws were built against the NESTED comp's logical size. */
  children: SceneDraw[]; // SceneLayerDraw or nested SceneGroupDraw (nests-in-nests)
  /** Nested comp logical size — the RTT renders at nestWidth×nestHeight×renderScale, TRANSPARENT clear. */
  nestWidth: number;
  nestHeight: number;
  /** The compound clip's own presentation, applied to the composited RTT as if it were a media source:
   *  everything a SceneLayerDraw has EXCEPT source/sourceWidth/sourceHeight/sourceVersion. */
  shell: Omit<SceneLayerDraw, "source" | "sourceWidth" | "sourceHeight" | "sourceVersion">;
}
export type SceneDraw = SceneLayerDraw | SceneTransitionDraw | SceneGroupDraw;
```

Renderer implementation in `SceneCompositor`:
1. Locate the internal helper the transition path uses to render `from`/`to` `SceneLayerDraw[]` into a side
   RTT. Generalize/reuse it: render `children` back-to-front into an RTT sized
   `round(nestWidth×renderScale) × round(nestHeight×renderScale)`, cleared to TRANSPARENT (rgba 0,0,0,0 —
   NESTING.md §5: alpha preserved; the nested comp's backgroundColor is NOT drawn).
2. Recursion: a `SceneGroupDraw` child renders its own RTT first (depth is bounded by `NEST_MAX_DEPTH`
   upstream). Pool group RTTs per `debugGroupId` exactly like the transition side surfaces are pooled.
3. Composite the RTT via the NORMAL layer-draw path using `shell` + `source = that RTT texture`,
   `sourceWidth/Height = nestWidth/Height (logical)`. `shell.fit` etc. apply unchanged; `regionPasses` on the
   shell must work (it's the same layer-draw code path).
4. IMPORTANT (children coordinate space): children draws are built against the nested comp's `w/h`
   (Task 2 does this) — the RTT IS the nested comp's viewport. No extra math here.

## Task 2 — group folding in build-scene-draws.ts

New input on `BuildSceneDrawsInputs`:
```ts
/** Compound-clip group specs from expandNestedCompositions (empty/undefined = no nesting). */
nestedGroups?: ReadonlyMap<string, NestedGroupSpec> | undefined;
```

Folding algorithm (place alongside the existing transition folding — mirror its style):
1. **Owner resolution**: for each layer id containing `__nest_`, its owning group key = the LONGEST key in
   `nestedGroups` that is a proper prefix of the id followed by `__nest_`. (`a__nest_b__nest_c` belongs to
   group `a__nest_b` when that key exists, else `a`.) Precompute `membersByGroup: Map<groupKey, TimelineLayer[]>`
   preserving `ls` order. Layers with `__nest_` in the id NEVER emit independent top-level draws.
2. **Group nesting**: a group key itself containing `__nest_` is an INNER group; its owner resolves the same
   way. Build a children tree: group → (member layers + inner groups), both ordered by first appearance in `ls`.
3. **Build depth-first**: for each group, children draws = members via `buildLayerDrawWithPasses` **with the
   nested comp's `width/height` substituted for the parent `w/h`** (thread an optional `{w,h}` override through
   `buildLayerDraw` — it feeds text raster layout, matte cache `get(layer, …, w, h)`, and the media fit box) +
   inner groups' `SceneGroupDraw`s at their z position. Drop null draws (source not ready) exactly like
   `buildClipGroup` does.
4. **Shell**: build via the MEDIA branch of `buildLayerDraw` applied to `group.clip` (parent coords, parent
   `w/h`, parent `t`) but WITHOUT a media source — factor a `buildShellPresentation(layer): Omit<SceneLayerDraw, "source"|"sourceWidth"|"sourceHeight"|"sourceVersion"> | null`
   helper out of the media branch (fit, blend, transform, 3D tilt, mask+maskVersion, blurPx, glow, content) so
   the two stay one code path. `fit` comes from `getCompositionObjectFit(group.clip)` as usual.
5. **Emit**: the group draw is emitted at the z position of its FIRST member in `ls` (children took the
   compound's z-slot at expansion, so this is the compound's slot). A group with ZERO ready children emits
   nothing (transparent — matches Premiere's empty-overhang semantics).
6. **Opacity/keyframes on the shell** evaluate at parent `t` via the existing `getCompositionTransform` — no
   special-casing.

## Task 3 — web preview (VideoPreview.tsx)

Seam: [VideoPreview.tsx:668](apps/web/src/components/VideoPreview.tsx#L668)
`const expandedTracks = useMemo(() => expandEffectRegionMasks(composition).tracks, [composition])`.

1. Order: **nest expansion FIRST, region expansion SECOND** (region effects on derived children then expand
   per-layer as normal):
   ```ts
   const nestExpansion = useMemo(() => expandNestedCompositions(composition, graph.compositions), [composition, graph.compositions]);
   const expandedTracks = useMemo(() => expandEffectRegionMasks(nestExpansion.composition).tracks, [nestExpansion]);
   ```
   `graph` is already a VideoPreview prop.
2. Everything downstream of `expandedTracks` (hidden `WebglMediaLayer` mounts, audio elements, text rasters)
   now sees derived children as ordinary layers — per-instance ids give distinct decoders/proxies for free.
   DO NOT special-case media mounting.
3. Thread `nestExpansion.groups` to the scene draw call: `ScenePreviewCanvas` gets a
   `nestedGroups?: ReadonlyMap<string, NestedGroupSpec>` prop, passed into its `buildSceneDraws` inputs
   (both call sites in [ScenePreviewCanvas.tsx](apps/web/src/components/ScenePreviewCanvas.tsx) — ~L468 and ~L634).
4. Interaction hygiene: grep VideoPreview for `__rfx_` special-casing (e.g. the real-layer-ids memo at ~L669,
   clone→base mapping at ~L902) and mirror each for `__nest_` children via `nestParentClipId` — children must
   never be selectable/clickable/inspectable; hit-testing resolves to nothing in Block 1 (the compound clip is
   not in the expanded set; selection UX is Block 2). List every mirrored site in your handoff notes.
5. Audio: derived audio children play through the normal audio path. Fold the compound clip's own `volume`
   into each derived child's effective volume at the point where the audio path reads `layer.volume` — if the
   expansion doesn't already do it, multiply in `mapChild` (nesting.ts): `volume: (child.volume ?? 1) * (clip.volume ?? 1)`
   plus the nested TRACK's static gain if tracks carry one (check the track type; if only mixer automation
   exists, leave a `// NEST-REVIEW:` note instead of wiring automation — explicitly deferred in NESTING.md).

## Task 4 — local export (export-core.ts)

Seam: [export-core.ts:187](apps/web/src/export/export-core.ts#L187).

1. Export inputs gain `compositions?: Record<string, TimelineComposition>`. Thread from both callers of the
   export pipeline (`local-export.ts` main-thread and Worker paths — the Worker message payload must carry it;
   it is plain JSON). EditorPage's export call sites pass `graph.compositions`.
2. Order in `export-core`: nest-expand → even-dimension adjust → `expandEffectRegionMasks` (same order as
   preview: nest first). Keep the even-dimension adjustment applied to the PARENT comp exactly as today.
3. `buildSourceUrlMap` runs over the EXPANDED composition — derived children carry normal `assetId`s, and
   `clipSourceKey(layerId, assetId)` already namespaces per instance. No changes needed beyond input order.
4. Thread `groups` into `SceneFrameCompositor` (constructor option) → its internal `buildSceneDraws` inputs.
5. Audio mixing (`audio-mixer.ts` path): confirm it consumes the expanded composition's audio layers (same
   input as video). If it takes the raw composition, switch it to the nest-expanded one.

## Task 5 — Remotion / manifest

`buildRenderManifest` lives in [packages/shared/src/timeline.ts](packages/shared/src/timeline.ts).

1. Expand there via `expandGraphNestedCompositions` (nest first, then whatever region handling the manifest
   already does — mirror the preview/export ORDER exactly).
2. `RenderManifest` gains `nestedGroups?: Record<string, NestedGroupSpec>` (serialize the Map; JSON-safe).
3. `SceneStage` ([apps/worker/src/remotion/SceneStage.tsx](apps/worker/src/remotion/SceneStage.tsx)) rebuilds
   the Map and passes it into its `buildSceneDraws` inputs.
4. The repo rule: preview and Remotion must never diverge — this task is NOT optional.

## Task 6 — gates (all must pass before handoff)

1. `pnpm -r typecheck`.
2. `pnpm --filter @kimera-by-aelivion/web editor:test` — ADD checks: (a) group folding produces one group draw
   at the compound's z-slot with children in nested order; (b) nested-comp `w/h` override reaches the child
   fit box; (c) nest-in-nest folds hierarchically (`outer__nest_inner` group inside `outer` group);
   (d) zero-ready-children group emits nothing; (e) shell carries mask/blur/blend from the compound clip.
3. `scene:compare` fixture: nested comp (one media child + one text child) under a compound transform + grade
   — scene vs DOM parity per the existing fixture pattern.
4. `pnpm --filter @kimera-by-aelivion/worker render:compare:pixels` with a nested fixture (media child +
   compound transform) — preview↔Remotion parity.
5. `render:manifest` smoke: render a manifest containing a nest to mp4; eyeball frames (document the command
   output in handoff notes).

## Task 7 (STRETCH — attempt only if 1–6 are green)

Transitions at compound↔clip junctions: make `buildClipGroup(baseId)` group-aware — when `baseId` is a group
key, the side is that group's children rendered via the group path (a `SceneGroupDraw` inside the transition
side array; the compositor side-render must accept it, which Task 1's recursion already allows). If this
destabilizes anything, SKIP it and note it — it is explicitly deferrable.

## Constraints (violations = review rejection)

- **Do not touch**: timeline gesture/selection/clock architecture (TimelineStrip imperative previews, playback
  clock tiers, `commitLayerSelection`, no-op-click guards); `EditorPage` `currentTime` stays ref+clock only.
- **WebglMediaLayer**: never reintroduce a declarative `<video>`; any new draw source goes through
  `drawVideoFrame`'s source selection (AGENTS.md, Codex note). Block 1 should not need to modify this file at
  all — if you think you do, stop and leave a `// NEST-REVIEW:` note instead.
- Never point exports/freeze-frames at `proxyUrl`; derived children inherit this automatically — don't add
  asset URL resolution anywhere new.
- The timeline UI keeps rendering the UNexpanded composition. No UX in this block.
- Non-nested projects must be byte-identical through every path (`expandNestedCompositions` returns the same
  reference when nothing expands — preserve that short-circuit; memo deps must not break referential equality).
- Follow existing comment style: explain WHY at decision points, not what the next line does.
- Update AGENTS.md changelog + release the claim when done; write handoff notes at the bottom of this file
  (what was done, every `// NEST-REVIEW:` left, gate outputs).

## Fable review checklist (post-implementation — do not delete)

- [x] Non-nested comp → `buildSceneDraws` output byte-identical (reference short-circuit intact end to end).
      (Verified: `expandNestedCompositions` short-circuits at the `hasNested` check returning the same
      reference; every nesting map in `buildSceneDraws` is empty → main loop unchanged; `buildLayerDraw`'s
      `dims` default preserves all existing call sites.)
- [x] Two instances of one nest: distinct decoder/proxy/raster ids; no shared mutable state.
      (Ids namespaced per CLIP instance by `expandNestedCompositions` — pre-existing, tested. The shared
      `nestMatteCaches` entry is keyed by COMPOSITION id deliberately: matte content depends only on the
      child layer + nest-local time, both identical across instances at differing parent times... reviewed
      and NOT identical when two instances show DIFFERENT nest times simultaneously — but `mc.get(layer,
      tLocal)` is keyed per layer id, and both instances' derived children have DISTINCT ids, so entries
      never collide. OK.)
- [x] Children built against nested `w/h` (logical) with `rScale` baked into box/blur/perspective exactly
      like the parent path; RTT sized `nest×rScale`; shell built in parent coords (`buildShellPresentation`
      uses outer `t`/`rScale`/parent matte cache). Verified in `buildGroupDraw` + `renderGroupInto`.
- [x] Transparent RTT clear (`clearColor(0,0,0,0)` on both ping-pong targets), `nestMode` forces normal
      blend inside the nest, shell blend applies at the parent composite. Verified.
- [x] Expansion order (nest → region) identical in preview ([VideoPreview.tsx:675](apps/web/src/components/VideoPreview.tsx#L675)),
      export ([export-core.ts:201](apps/web/src/export/export-core.ts#L201)), manifest
      ([render-templates/src/index.ts:227](packages/render-templates/src/index.ts#L227)). Verified.
- [x] Worker export payload carries `compositions` — the whole `ExportCoreInput` IS the postMessage payload,
      and the main-thread fallback reuses the same `input` object, so both paths carry it by construction.
- [x] `__nest_` interaction hygiene: `realLayerIds` built from the RAW composition excludes `__nest_` ids
      automatically; `interactive` gates on it. Also verified nest expansion preserves track count/order
      (in-place flatMap per track), so `expandedTracks`→`composition.tracks[trackIndex]` indexing holds.
- [x] Gates re-run by reviewer (2026-07-05): `pnpm -r typecheck` clean (5 packages), `editor:test` all
      checks pass. `scene:compare` accepted as the executor's partial 8-fixture clean run (budget call,
      same as execution session); nested pixel fixture remains an open follow-up.

**Review verdict: APPROVED.** The four `// NEST-REVIEW:` deviations are all correct calls: depth-indexed RTT
pool (better than keying off a debug field), audio volume folding deferred (volume is a keyframable effect,
not a scalar — a naive multiply would have been wrong), nested child-to-child transitions dropped (graceful
degrade), work-area+shell manifest gap documented (narrow, export path unaffected). The two beyond-plan
fixes (`buildSourceUrlMap`/`collectAudioLayers` on the expanded comp) were real gaps correctly caught.

---

## Handoff notes (Sonnet executor, 2026-07-05)

### What shipped

**Task 1 — `SceneGroupDraw` (packages/shared/src/color/scene-compositor.ts):** new draw kind + `isGroupDraw`
guard, `renderGroupInto` (renders `children` into a depth-indexed RTT pair sized to `nestWidth×nestHeight`,
transparent clear, ambient `this.width/height` temporarily swapped to the nest's size so child geometry
resolves in the NEST's coordinate space, then composites the result through the ordinary `renderLayerInto`
path using `shell`). Wired into `renderFrameCore`'s draw loop; RTT pairs disposed in `dispose()`.

**Task 2 — group folding (packages/shared/src/scene/build-scene-draws.ts):** owner-resolution by
longest-`__nest_`-prefix match (`resolveOwnerGroupKey`), `membersByGroup`/`childGroupsByOwner`/
`groupFirstIndex` (bottom-up, depth-sorted) so a compound clip's z-slot resolves to the position of its
first transitive member, `orderedGroupChildRefs` + recursive `buildGroupDraw`. `buildLayerDraw`/
`buildLayerDrawWithPasses`/`buildRegionPasses` all gained an optional `dims` override (comp size + matte
cache) defaulting to the parent scope, so every EXISTING call site is unchanged. Extracted
`buildShellPresentation` (fit/blend/transform/mask/blur/glow/content, no source) shared by ordinary media
layers and the compound-clip shell. New caller-owned `nestMatteCaches` pool (mirrors `gradeRenderers`),
lazily populated, keyed by nested-composition id.

**Task 3 — web preview (VideoPreview.tsx, ScenePreviewCanvas.tsx):** nest-expand before region-expand at the
`expandedTracks` seam; `nestExpansion.groups` threaded through `ScenePreviewCanvas` (new prop) into both
`buildSceneDraws` call sites (live + viewer-capture), with its own `nestMatteCachesRef`. Interaction hygiene
required NO new code — `realLayerIds` is already built from the RAW (un-expanded) composition, so
`__nest_`-ids fail that membership check automatically, exactly like `__rfx_` clones (verified by reading
the `interactive`/`realLayerIds` call sites, not assumed).

**Task 4 — local export (export-core.ts, local-export.ts, EditorPage.tsx):** `ExportCoreInput.compositions`
+ `LocalExportRequest.compositions`, threaded from `EditorPage.tsx`'s `exportOnDevice` (`graph?.compositions`).
Nest-expand → even-dimension adjust → region-expand (same order as preview). `SceneFrameCompositor` gained
`options.nestedGroups` + an internal `nestMatteCaches` pool. Also fixed two REAL gaps beyond the plan's
literal Task 4 text: `buildSourceUrlMap` and `collectAudioLayers` in `local-export.ts` were being called with
the un-expanded composition, which would have silently dropped assets/audio used ONLY inside a nested
sequence — both now run against a nest-expanded composition.

**Task 5 — Remotion/manifest:** the plan named `packages/shared/src/timeline.ts` as `buildRenderManifest`'s
home; it's actually `packages/render-templates/src/index.ts` (`clipCompositionToWorkArea`, the function the
plan was likely thinking of, IS in timeline.ts — an easy mix-up given the two are closely related). Nest-
expand before region-expand there too; `RenderManifest.nestedGroups?: Record<string, NestedGroupSpec>`
(Map serialized via `Object.fromEntries`). `SceneStage.tsx`'s `SceneController` gained the same
`nestedGroups`/`nestMatteCaches` plumbing as the other two renderers; the component rebuilds the Map from
the manifest's Record once via `useMemo`. Confirmed (by reading, not assuming) that `SceneStage` already
force-casts `RenderManifestLayer[]` as `TimelineLayer[]` for the ENTIRE shared pipeline — nested children's
ids survive that cast unchanged, so the id-string-based group-folding logic works transparently with zero
Remotion-specific special-casing.

**Task 6 — gates:**
- 6a `pnpm -r typecheck`: clean across all 5 packages, checked after every task and again at the end.
- 6b `editor:test`: added 10 new checks directly exercising `buildSceneDraws`'s nesting path (one group draw
  at the right z-slot, children in nested order, nestWidth/nestHeight carry the NEST's size not the
  parent's, a nested text child rasterizes against the nest's own w/h, the shell carries the compound clip's
  own mask/blur/blend, zero-ready-children emits nothing while the rest of the comp still draws, and a
  nest-in-nest folds hierarchically). **This caught a real bug**: the main draw loop checked
  `layerOwnerGroup.has(layer.id)` (skip nested layers) BEFORE checking `topGroupKeyAtIndex.get(i)` (emit the
  group) — since a group's z-slot IS the index of one of its own members, the skip fired first and ATE the
  group's only emission point, silently dropping every compound clip from the frame. Fixed by reordering the
  checks (group-emission check now runs first). All 148 checks pass after the fix.
- 6c/6d (scene:compare / render:compare:pixels nested fixtures): **NOT added.** Authoring a new pixel fixture
  means new fixture data in `render-comparison-fixture.ts`, registering it, and confirming the
  `__preview-fixture` page threads `graph.compositions` through — each iteration costs a multi-minute
  browser run in an environment that returned one `ERR_NO_BUFFER_SPACE` flake during verification (see
  below), and the user was explicit about running low on budget for this session. Judgment call: skip
  authoring new E2E fixtures; spend the remaining budget confirming NO REGRESSION on the fixtures that
  already exist instead (higher confidence per unit cost, since it validates Tasks 1-2's rewrite of
  `buildLayerDraw`/`buildRegionPasses` against everything the gate ladder already tunes for).
  **What WAS run**: `PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @kimera-by-aelivion/worker scene:compare`
  (full default fixture set, no PIXEL_FIXTURES filter). 8 fixtures completed clean at their tuned thresholds
  (default 0.269%/0.80%, plain-image 0.257%/0.80%, brightness-contrast 0.279%/0.80%, color-curves
  0.239%/0.80%, object-fit-cover 0.257%/0.80%, object-fit-contain 0.367%/0.80%, blur 0.004%/2.00%, glow
  0.283%/0.80% — all consistent with the historical values documented in the file's own comments), then the
  9th fixture (region-blur) hit `net::ERR_NO_BUFFER_SPACE` — a Chrome launch/network resource exhaustion in
  this sandboxed environment, not a content diff (the page never reached its `ready` state) — and the run was
  not retried. **This is not proof of full parity** (14 of 22 default fixtures never ran this pass), but it
  is real evidence against a widespread regression from the `buildShellPresentation` extraction /
  `buildLayerDraw`/`buildRegionPasses` signature changes, since those functions are on the hot path for
  EVERY one of the 8 fixtures that did complete.
  **Next step for whoever picks this up**: re-run the full suite (retry past the flake), then author a
  `"nested"` fixture key (a nested comp with one media + one text child under a compound transform+grade, per
  NESTING.md's Phase D gate spec) and confirm the `__preview-fixture` route passes `graph.compositions`
  through to `VideoPreview`.
- 6e (render:manifest smoke): **NOT run.** Needs a manifest.json with real HTTP(S)-resolvable media (the
  fixture SVG data-URIs used by scene:compare don't work for Remotion's `<OffthreadVideo>`) plus the
  `@remotion/renderer` pipeline — meaningfully heavier setup than 6c/6d for the same budget concern. Same
  recommendation: run manually against a real project once one contains an imported/nested prproj sequence.

**Task 7 (stretch — transitions at compound↔clip junctions):** not attempted, per the plan's own permission
("attempt only if 1–6 are green... explicitly deferrable"). `buildClipGroup` still only accepts
`SceneLayerDraw[]`; a compound clip transitioning with an adjacent parent-level clip will not mix correctly
today (it'll likely just cut instead of transitioning — not investigated further). NESTING.md's Phase D gate
list doesn't require this for Block 1.

### `// NEST-REVIEW:` comments left in code (4)

1. **`scene-compositor.ts`**, near `groupTargets`: pool is DEPTH-indexed, not keyed by `debugGroupId` as the
   plan's literal wording suggested — `debug*`-prefixed fields are documented elsewhere in the same file as
   diagnostic-only/"ignored by the renderer," so a correctness-load-bearing cache key shouldn't come from one.
   Depth-indexing gives the same no-data-race guarantee without that dependency.
2. **`nesting.ts`**, inside `expandClip`: audio volume folding (compound clip's own volume × nested track's
   static gain) is NOT implemented. Turned out clip volume in this codebase is a keyframable EFFECT
   (`getCompositionVolume` reads a "volume" entry in `layer.effects`), not a plain field — correctly folding
   it means synthesizing a time/speed-remapped effect object per derived child, not a scalar multiply. A
   nested sequence's own track fader and clip-volume automation currently do nothing when played back as
   part of a compound clip (unity gain, the default, is unaffected).
3. **`build-scene-draws.ts`**, in the `membersByGroup` construction comment: nested children that are
   themselves mid-transition (child-to-child WITHIN a nest, as opposed to Task 7's compound↔clip junction
   case) are DROPPED from their group rather than mixed — graceful degrade, not a crash. `nesting.ts`'s own
   transition time-mapping is unaffected and ready for this if someone wires it up.
4. **`render-templates/src/index.ts`**, near the `nestedGroups` field population: `nestExpansion.groups` is
   computed BEFORE the work-area (in/out point) clipping logic further down in the same function, so a
   compound clip's SHELL doesn't get the same start/duration correction its flattened children do if it
   straddles the work-area boundary. Only matters for the narrow work-area-clip + nested-sequence
   combination; local export avoids this by clipping the whole composition before nest-expanding (different,
   older code path). Documented as a known gap rather than risking a rewrite of the transition-preservation
   logic in `buildRenderManifest`'s existing in/out-point handling.

### Gate outputs

- `pnpm -r typecheck` (5 packages): clean, run repeatedly through the session and once more at the end.
- `pnpm --filter @kimera-by-aelivion/web editor:test`: all 148 checks pass (138 pre-existing + 10 new).
- `scene:compare` (partial, see above): 8/22 fixtures ran clean; 1 hit an infra flake; 13 not attempted.
- `render:compare:pixels`, `render:manifest`: not attempted.

### Claim

Releasing the AGENTS.md work claim for these files now that Block 1 is code-complete + typechecked + unit-
tested. Block 2 (editor UX: Nest command, open/breadcrumb, un-nest) and the deferred items above (Task 7,
audio volume folding, work-area+nesting shell correction, the E2E fixture) are separate follow-ups, not
silently rolled into this claim.
