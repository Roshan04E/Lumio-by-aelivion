# Next phases C + D (planned 2026-07-17)

State when planned: timeline & multi-select batch (plans/timeline-multiselect-phase.md) verified
already shipped; keyframe data-loss cluster closed (single-layer `onGraphChange` routing + clone/split
effect-id remap, commit 4f1802e). What remains splits cleanly by tier.

## Phase C — Fable-tier (deep engineering; do NOT hand to Sonnet)

All designs already grounded in `plans/effects-paint-deferred.md` — read that file first; this doc
only fixes the ORDER and adds T4. Each item touches parity-locked render paths and needs its own
pixel fixture + `render:compare:pixels` gate.

1. **D1 Track matte key** — GPU `matteFrom` RTT + second matte sampler in the layer composite shader
   (alpha/luma/invert). Highest user value; unlocks the classic "clip above as matte" workflow.
2. **D3 Anchor points** — `transform.anchor` percent pivot, moved in lockstep across all four pivot
   sites (GPU quad, canvas-2D text/shape, mask overlay math, viewer gizmos). Premiere semantics:
   `position` = anchor's comp position.
3. **D4 Nested-transition mix (R2 step 3)** — emit the in-group transition mix as a member draw in
   `buildGroupDraw`; completes the nested-clip transition story.
4. **T4 Head-material manufacture** (from plans/transition-alignment-phase.md) — extend "Trim clips
   to create overlap" to shift incoming `sourceInSeconds`; requires the head-trim op's keyframe/marker
   glue so content doesn't slide under local-time keyframes.
5. **D2 Texture paint / fill** — async image resolver injected into the shared rasterizer across all
   three environments; last because it's the most plumbing for the least breadth.

## Phase D — Sonnet batch (parallel-safe; follow ground rules below)

Ground rules: `pnpm -r typecheck` after every item; the timeline's imperative gesture patterns are
deliberate — never re-Reactify; any render-affecting change lands in BOTH web preview and shared
scene builder, gated by `render:compare:pixels`.

Features (designs in `plans/effects-paint-deferred.md` "Smaller follow-ups"):
1. **Speed-ramp graph lane** — `GraphTarget` kind `"speed"` over `layer.speedKeyframes`, linear-only
   (suppress bezier handles; `integrateRamp` closed form must hold), writes via `upsertSpeedRampPoint`.
2. **Pen-shape point editing** — retarget MaskEditorOverlay's select-tool point/tangent drag to
   `shapePath` when the layer is a pen shape (drawing shipped; editing still mask-only).
3. **Lanes view polish** — marquee selection, sync-clock live playhead line, hover value tooltips.
4. **Insufficient-handle zebra on the junction pill** — warn when `resolveTransitionWindowSides`
   shortened a side below D/2 and the other side lacks material.

Bug triage (diagnose FIRST, root cause in project-tracker before fixing):
5. **Stacked identical layers flash visible for a frame** (roadmap, unreproduced) — suspect z/visibility
   churn at clip boundaries in the scene builder; build a minimal two-identical-clips repro.
6. **Speed ramp hangs the browser** (roadmap) — repro with an aggressive ramp; suspect unbounded
   seek/decode loop when ramp compresses many source seconds into few timeline seconds.
7. **Click-keyframe moves playhead** (roadmap, unverified) — check graph editor + keyframe-diamond
   click paths; selecting a keyframe should not seek unless it's an explicit double-click/affordance.
8. **TimelineEffectControl `onUpdate` multi-select gap** (EditorPage.tsx ~13328) — Mix slider, enable
   toggle, reset, and non-numeric params commit via a whole-effect broadcast matched by the PRIMARY's
   effect id → silent no-op on other selected clips. Give it the per-item resolution treatment the
   numeric sliders use (`resolveItemEffect(item)` pattern). No data loss today (ids never collide
   post-4f1802e); this is a consistency fix. Approved by user via this plan.

Explicitly NOT in these phases (stay on the roadmap): optical-flow time interpolation,
adjustment-layer clips, audio sync features, Unsplash, fonts/captions as library items.
