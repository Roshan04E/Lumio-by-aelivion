# Next phase: Keyframes & Graph Editor — execution plan

Written 2026-07-16 for execution by a code agent (Sonnet 5). Root causes below were traced in
source by an exploration pass — file/line anchors were correct at writing time; re-verify with
grep before editing (lines drift).

## Mission

Fix the keyframe/graph-editor bug cluster reported by the user:

1. Multi-select keyframe edit overwrites ALL selected clips with the primary clip's source (data loss).
2. Broken/unresponsive keyframes (drag does nothing; inspector value changes don't apply).
3. Graph editor Y axis feels inverted for some targets; keyframe diamonds visually "detach" from curves.
4. Clicking a keyframe must NOT move the playhead.
5. Graph editor should show faded "ghost" curves for the OTHER selected clips.

## Hard constraints — read before any edit

- **Broadcast-safety rule (the core of this phase):** `inspectorHandlers.onChange` in
  `apps/web/src/pages/EditorPage.tsx` (~line 6635) broadcasts ONE updater to every selected layer via
  `updateLayers`. An updater passed there MUST read exclusively from its `item` argument and return
  `{ ...item, <changed fields> }`. It must NEVER close over the primary layer's concrete values,
  effect ids, keyframe ids, or return a captured layer object. Every fix in this phase either makes
  a write path obey this rule or takes it off the broadcast path entirely.
- **Do not touch** (user directive, `timeline-perf-architecture-do-not-touch` memory): the
  imperative gesture patterns in `TimelineStrip.tsx` (drag previews written to DOM, `startTransition`
  selection, ref mirrors, clock tiers). Nothing in this phase requires changing them.
- **Do not "fix" shipped code that looks off** outside the scope below — flag it instead
  (`dont-touch-shipped-off-code` memory).
- **Render parity:** the animation evaluator (`packages/shared/src/animation.ts`) is shared by web
  preview, local export, and the Remotion worker. If you change ANY evaluator behavior, run
  `pnpm --filter @kimera-by-aelivion/worker animation:test` AND
  `$env:PIXEL_BROWSER_CHANNEL='chrome'; pnpm --filter @kimera-by-aelivion/worker render:compare:pixels`.
  Tasks K1–K7 as specified below do NOT change evaluator behavior.
- After EVERY task: `pnpm -r typecheck` (this repo's lint). One task per commit.
- The graph editor opens with Shift+G / window event `kimera:open-graph-editor` (prefix is
  `kimera:`, not `lumio:`). Files: `apps/web/src/editor/graph/GraphEditor.tsx`, `graph-view.ts`,
  `graph-scene.ts`, `useDraftLayer.ts`, host `apps/web/src/editor/BottomWorkspace.tsx`.

## K1 — Graph editor commits clone the primary onto all selected clips (DATA LOSS — do first)

**Root cause (confirmed):** `useDraftLayer.commitDraft`
(`apps/web/src/editor/graph/useDraftLayer.ts:34-44`) commits with `onChange(() => next)` where
`next` is the primary clip's whole drafted layer object — the updater discards its argument. The
GraphEditor's `onChange` is wired to the broadcasting `inspectorHandlers.onChange`
(`BottomWorkspace.tsx:124` ← `EditorPage.tsx:7850`). With 2+ clips selected, ANY graph-editor drag
(keyframe point or bezier handle) therefore overwrites every selected layer with a clone of the
primary — same `assetId`, source, effects. This is the reported "all clips got identical sources".

**Fix (minimal, no behavior redesign):** take the graph editor OFF the broadcast path. Graph edits
apply to the edited (inspector/primary) layer only:

1. In `EditorPage.tsx`, where BottomWorkspace/GraphEditor gets `onChange={inspectorHandlers.onChange}`
   (~7850), create and pass a dedicated stable handler instead (same `useStableHandlers` block or a
   sibling): it must guard `if (!inspectorLayer) return;` and call
   `void updateLayer(inspectorLayer.id, updater)` — never `updateLayers`.
2. Do NOT change `useDraftLayer.ts` — `onChange(() => next)` is correct once the target is a single
   layer (the draft is that layer).
3. Leave `inspectorHandlers.onChange` itself untouched — other inspector panels rely on broadcast.

**Verify:** two clips with different assets selected → open graph editor → drag a keyframe on the
primary → the OTHER clip keeps its own asset/source (inspect the composition or just look at the
timeline thumbnails). Undo restores in one step. Typecheck.

## K2 — Keyframe diamond toggles broadcast the primary's value / effect id

**Root cause (confirmed):** two toggle paths close over primary-derived data before broadcasting:
- `TransformPanel.tsx:142-164` (`transformKeyframe`): `onToggle` captures `currentValue` computed
  from the PRIMARY's evaluated transform, then broadcasts
  `toggleTransformKeyframe(item, property, layerTime, currentValue)` — every clip gets the primary's
  value. Also `layerTime` is computed from the primary's `startSeconds`; other clips at different
  positions get a wrong-time keyframe.
- `EffectParamControl` (`EditorPage.tsx:~12735-12775`): `onToggle`/`onClearAll`/
  `onChangeInterpolation` capture `animatedValue` (primary-evaluated) AND `effect.id` (the primary's
  effect INSTANCE id). Broadcast recipients get the primary's value under an effect id they may not
  have → keyframe born orphaned (feeds K3/K6).

**Fix pattern (apply per path):** move all evaluation INSIDE the updater so it runs against each
`item`:

```ts
onChange((item) => {
  const itemLayerTime = clamp(absPlayheadSeconds - item.startSeconds, 0, item.durationSeconds);
  const itemValue = /* evaluate the property for THIS item at itemLayerTime, e.g. via
                       evaluateTimelineTransform(item, itemLayerTime) or the effect-param
                       evaluator against item's own effect */;
  const itemEffect = item.effects.find((e) => e.id === effect.id) ?? item.effects.find((e) => e.type === effect.type);
  if (!itemEffect) return item; // no matching effect on this clip → no-op, never write a foreign id
  return toggleEffectParamKeyframe(item, itemEffect.id, param.key, itemLayerTime, itemValue);
});
```

Compute `absPlayheadSeconds` once outside (playhead is global); everything else per-item. The
helpers in `apps/web/src/editor/inspector/keyframeUtils.ts` are already broadcast-safe — do not
modify them; only fix the closures at the call sites.

**Verify:** select two clips with the same effect type but different param values; toggle a keyframe
diamond → each clip gets a keyframe with ITS OWN value at ITS OWN local time under ITS OWN effect
id (inspect `layer.animations`). A clip without the effect is untouched. Typecheck.

## K3 — Deleting an effect leaves orphaned (inert) keyframes

**Root cause (confirmed):** the layer-effect removal path filters the effect out of `layer.effects`
but leaves every `target.scope === "effect", target.effectId === <deleted>` entry in
`layer.animations`. Orphaned keyframes are invisible to the evaluator
(`evaluateTimelineEffectParam` filters by live effectId) and to the inspector's keyframe lookup —
they're the "keyframes don't respond" report's main vector (along with K2's foreign-id writes).

**Fix:** wherever a `TimelineEffect` is removed from a layer (grep `effects.filter` over
`EditorPage.tsx` and the timeline-actions in `packages/shared/src/timeline-actions/` — there are
multiple removal sites; find them all), also strip its keyframes in the same write:
`animations: (layer.animations ?? []).filter((kf) => !(kf.target.scope === "effect" && kf.target.effectId === removedId))`.
If several sites share no helper, add ONE helper `removeEffectWithKeyframes(layer, effectId)` in
`keyframeUtils.ts` (web-only sites) or shared (if a shared action also removes effects) and call it
from each site. Do not write a data migration; just stop creating new orphans.

**Verify:** add an effect, keyframe a param, delete the effect → `layer.animations` has no entries
for that effectId; undo restores both. Typecheck.

## K4 — Keyframe id collisions (same-tick minting)

**Root cause (confirmed):** ids are minted as `kf_${Date.now()}_${property}` in `keyframeUtils.ts`
(`toggleTransformKeyframe` ~352, `toggleEffectParamKeyframe` ~645, preset `makeKeyframe` ~1331, and
sibling togglers). A broadcast toggle runs the minter once per layer in the same millisecond →
identical ids across layers; the graph editor selects/scrubs purely by `kf.id`, so cross-layer
duplicate ids make selection ambiguous (worse once K7 adds multi-layer curves).

**Fix:** in every minting site in `keyframeUtils.ts`, append a random suffix:
`` `kf_${Date.now()}_${property}_${Math.random().toString(36).slice(2, 8)}` ``. Pure id-format
change — nothing parses these ids EXCEPT the transition system, which matches `_transition_` marker
substrings: DO NOT touch id construction in
`packages/shared/src/timeline-actions/actions/transition.ts` (fade keyframe ids are contract).
Grep for consumers of `kf_` before finishing to confirm nothing pattern-matches the old format.

**Verify:** toggle a keyframe on 3 selected clips in one keypress → three distinct ids. Fades still
add/remove correctly (their ids untouched). Typecheck.

## K5 — Graph editor: diamonds detach from curves; Y-direction complaint

**Detach root cause (confirmed):** per-curve normalization is data-driven and recomputed every
render (`graph-scene.ts` `buildCurveScene` ~98-161: `vMin/vMax` from keyframe ∪ sampled values,
10% padding). During a drag the range is frozen via `dragNormsRef`/`fixedRange`
(`GraphEditor.tsx` ~569/614/196) — but `dragNormsRef` is a REF, not a dep of the `scenes` memo
(deps ~200), so the freeze only applies one render late: diamonds are placed with the old range
while the curve uses the new one for a frame → visible detach.

**Fix:** make the freeze take effect in the same render that starts the drag. Prefer the smallest
change: introduce a `dragEpoch` state (number) bumped synchronously in the pointer-down that seeds
`dragNormsRef`, and add it to the `scenes` memo deps so the memo re-evaluates with `fixedRange`
active. Do NOT convert the per-frame drag movement itself to state — only the drag START/END need a
render; moves already draw imperatively.

**Y-direction:** the mapping (`graph-view.ts` `normToPx`/`pxToNorm`, `GraphEditor.tsx` drag delta
`dNorm = -dyPx * span/height` ~697) is algebraically correct (up = increase). The user's report is
likely target-specific (a target whose DOMAIN is inverted, e.g. position.y where up on canvas is
negative). Diagnose before changing anything: log target id + dyPx + dNorm for the first drag frame
on each target type (transform.opacity, position.y, effect param). If position.y is the complaint,
add a per-target `invertY` flag in the graph target definition (`transformGraphTargets` /
`buildEffectGraphTargets`) applied ONLY in `curveNorm`/`curveValue` for that target — never a global
sign flip in `normToPx`/`pxToNorm` (that would invert every other curve). Remove the logging when done.

**Verify:** drag a keyframe up on opacity → value increases; on position.y → clip moves UP in the
viewer (matching Resolve). While dragging, diamonds stay ON the curve at drag start and end.
Typecheck.

## K6 — Clicking a keyframe must not move the playhead

**Confirmed seek sites:**
- `GraphEditor.tsx` `handlePointerUp` ~792-796: a non-moved single-point click calls
  `onSeek(layer.startSeconds + entry.timeSeconds)`. Remove the seek (keep the selection behavior).
  Keep the RULER drag seeks (~559-562, ~675-677) — scrubbing the ruler is intended.
- `TimelineStrip.tsx` `onStartKeyframeDrag` ~2139: seeks on pointer-DOWN; and the keyframe marker
  `onClick` ~5160 seeks again. Remove both seeks. KEEP the seek inside `moveKeyframeDrag` (~2172)
  only if it exists as drag-scrub; if removing the pointer-down seek breaks the drag's time origin,
  the drag must derive its origin from the keyframe's own time, not the playhead.

**Verify:** click a diamond in the graph editor and on the clip face → selection changes, playhead
does not move. Dragging a keyframe still works and still shows its value/time. Typecheck.

## K7 — Ghost curves for other selected clips

**Current state (confirmed):** GraphEditor is single-layer: `EditorPage.tsx:7849` passes
`layer={inspectorLayer ?? null}` through `BottomWorkspace.tsx:123`; `GraphEditorProps`
(`GraphEditor.tsx:108-117`) has no selection awareness.

**Fix:**
1. Add optional prop `ghostLayers?: TimelineLayer[]` to `GraphEditorProps` and thread it from
   EditorPage: the selected layers minus the primary
   (`selectedLayerIds.filter(id => id !== inspectorLayer?.id).map(...)`, memoized).
2. In the canvas draw pass, for each ghost layer build read-only scenes with the SAME
   `buildCurveScene` (it is pure) for the currently VISIBLE targets only, and stroke them at ~0.25
   alpha, no diamonds or with tiny hollow diamonds — pick one, keep it cheap.
3. Ghost scenes are excluded from `hitTestScene` and from `selectedSet` — only the primary's
   keyframes stay interactive. (K4's unique ids make cross-layer id collisions impossible, but do
   not rely on ids: simply never hit-test ghosts.)
4. Perf guard: skip ghosts entirely when more than ~8 layers are selected.

**Verify:** select 3 clips with different opacity keyframes → primary's curve full-strength,
others faded; clicking a faded curve selects nothing; deselect to 1 clip → ghosts gone. Typecheck.

## K8 — Post-fix diagnosis of remaining "dead" keyframes (no code by default)

After K1–K4, previously corrupted projects may still contain orphaned keyframes (foreign effect
ids). Do NOT auto-delete user data. If dead keyframes still reproduce, add a read-only console
diagnostic (dev-only) that lists `animations` entries whose `target.effectId` matches no
`layer.effects[].id`, and report the findings back for a decision on a cleanup affordance.

## Regression gates (run at the end of the phase, in this order)

1. `pnpm -r typecheck`
2. `pnpm --filter @kimera-by-aelivion/worker animation:test`
3. `$env:PIXEL_BROWSER_CHANNEL='chrome'; pnpm --filter @kimera-by-aelivion/worker render:compare:pixels`
   (expected: 27/27 fixtures ≤ 0.001%)
4. Manual smoke: single-clip keyframe toggle/drag/clear; multi-select toggle (values stay per-clip);
   graph-editor drag with 2 clips selected (no source cloning); fades add/remove; undo depth = one
   step per action.
