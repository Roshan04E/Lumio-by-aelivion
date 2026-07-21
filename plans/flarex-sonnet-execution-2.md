# Flarex — Sonnet 5 execution plan, round 2 (Phase 1.5 polish + depth)

> Same ground rules as `plans/flarex-sonnet-execution.md` (read its "How to work" section and the
> FENCE list first — both still apply verbatim; S2b GraphEditor adapter, aiMatte, Text node,
> Tracker, multi-clip MediaIn, Phase 2 interpreter, and everything in `scene-compositor.ts` stay
> OFF-LIMITS). Round 1 (S1–S6) is complete and committed. Verification loop after every task:
> shared/web/worker typecheck + `flarex:test`; AI tasks add `brain:eval`; render tasks add
> `render:compare:pixels`.

## N1 — Filter node: registry-driven pro UI (highest value)

The `filter` node today takes a raw `effectId` string + `effectParams` JSON — unusable. Make it
first-class:

1. In `FlarexInspector.tsx`, when `node.type === "filter"`: render `effectId` as a select of the
   registered single-clip fragment builtins — `listFragmentEffects()` (grep the registry for the
   exported list function; exclude the two `flarex.*` keyers and multi-pass stylize if it looks
   wrong in a chain) showing `def.name`, grouped by `def.category`.
2. When an effect is chosen, render its param rows FROM `def.params`
   (`FragmentEffectParam { name, type, default, min, max, step, label }`): float → the same
   `EffectSliderControl` row (min/max/step from the def), bool → checkbox row, vec3 → color
   swatch (convert hex ↔ [r,g,b] 0..1), vec2 → two number fields. Values read/write into the
   node's `effectParams` JSON param (keep the storage contract — the compiler already parses it).
3. Changing `effectId` resets `effectParams` to "{}" (defaults re-apply downstream).
4. Add 2 flarex:test checks: filter node with a params JSON override lowers with those resolved
   values; unknown effectId still passes through (no throw).

## N2 — Curves + Hue/Sat nodes lower for real

`colorCurves`/`hueSat` defs exist (phase 1.5, params = JSON payloads in the effect-param
convention) but do NOT lower — they pass through.

1. In `compile-flarex.ts`, mirror the `colorCorrect` case: build a synthetic
   `TimelineEffect` of the matching type (`colorCurves` / the hue-sat effect type — grep
   `timelineEffectRegistry` in `packages/shared/src/effects.ts` for the exact type ids and the
   param key each expects), stuff the node's JSON param into it, and run the SAME
   `getCompositionColorPipeline`-based `pipelineFor` wrap the colorCorrect case uses. Masked
   input (the `mask` socket) must follow whatever colorCorrect does with its mask socket today.
2. Inspector: reuse the EXISTING curve editors — grep how the Edit page's Color tab mounts its
   curves UI (`HueSatCurves.tsx` is the hue/sat one) and mount the same component(s) in the
   inspector body when those nodes are selected, writing the JSON back through `setParam`. If the
   Edit-page curve components are too entangled with layer props, fall back to the textarea row
   and note the deferral — do NOT fork a parallel curve editor.
3. Pixel fixture: extend `render-comparison-fixture.ts` with a comp using colorCurves (a strong,
   visible S-curve) so the parity gate covers the pipeline path. Same background-LAYER rule as
   `flarex-key-glow` (SceneStage hardcodes its clear color — tracker editor-ui v8).

## N3 — Node clipboard: copy / paste / duplicate

1. Canvas-level keydown (same capture-phase listener pattern as Delete, same input-field guard):
   Ctrl+C copies the selected nodes (minus MediaIn/Out) + the edges BETWEEN them to a module-level
   clipboard (object, not system clipboard); Ctrl+V pastes with fresh ids, positions offset
   +24/+24, internal edges remapped, selection = the new nodes; Ctrl+D = copy+paste in one step.
2. Paste is ONE `onUpdateComp` commit. Nothing crosses comps in v1 (clipboard clears when the
   active comp id changes) — note that limitation in the code comment.
3. flarex:test: pure-function the remap (export a `cloneFlarexNodes(nodes, edges, idPrefix)`
   helper in `flarex-canvas-model.ts` or shared registry) and test id remapping + edge
   preservation + MediaIn/Out exclusion.

## N4 — Frame-ruler keyframe ticks + badge navigation

1. `FlarexFrameRuler` (in `FlarexWorkspace.tsx`): when exactly one node is selected, draw a small
   amber diamond per keyframe time of that node's params (union across params;
   `comp.animations` filtered by nodeId, times are comp-local seconds). Clicking a diamond seeks
   exactly to it. Keep it DOM (absolutely-positioned spans) — the ruler is not perf-critical.
   The ruler needs the selected node id — thread `selectedNodeIds` (already in workspace state).
2. Timeline fx badge: double-click on a clip's "fx" chip switches to the Flarex page for that
   clip (grep how `TimelineStrip` raises events to EditorPage — reuse the existing event/callback
   idiom; EditorPage sets `editorPage` state + selection). Single-click keeps current behavior.

## N5 — Splice tests + keyframed pixel fixture (round-1 leftovers)

1. flarex:test checks for `spliceFlarexNodeIntoEdge` (listed in plan 1 S5 item 2): valid splice
   produces 2 valid edges and removes the original; matte-only node on an image wire → null;
   already-wired input → null; edge endpoint = the node itself → null.
2. Keyframed-param pixel fixture: a comp with keyframed blur sigma rendered at 2–3 timestamps
   through `render:compare:pixels` (follow how the harness picks its sample times; if it renders
   a single frame per fixture, add the fixture at a mid-animation time so a broken evaluator
   path shows up as a diff).

## N6 — Small wins (any order, optional)

1. `Ctrl+P` (Fusion) toggles enabled/pass-through on selected nodes (guard input fields).
2. Marquee + Shift = ADD to existing selection instead of replace.
3. Palette buttons show the node's group accent color as a left border strip (visual match with
   canvas nodes).
4. Empty-state "Create Flarex comp" button also reachable via double-clicking the fx-less clip's
   context? SKIP if it needs timeline context-menu surgery — note and move on.

## Definition of done (whole round)

Every task: typecheck (3 packages) + flarex:test green; N2/N5 also `render:compare:pixels` (the
two pre-existing stylize failures are known/fenced — do not touch them, do not let them block);
N4's badge work re-runs nothing special. Update `architecture.md` with one [x] entry for the
round and append tracker notes only for real problem/solution learnings.
