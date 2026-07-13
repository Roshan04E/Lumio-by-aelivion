# Timeline

## v1 — Deliberate non-idiomatic performance architecture (standing, 2026-07-04)
**Problem:** Timeline gestures/selection/playhead re-rendered the 10k-line editor tree per event.
**Fix (DO NOT "FIX" BACK):** imperative gesture previews (trim/move write DOM directly, React
re-enters at commit only), playback clock tiers (hot leaves ride the clock store; cold panels ride
throttled <ColdTime>; NO EditorPage `currentTime` state — ref + clock only), startTransition
selection, no-op-click guard. Any agent tempted to re-Reactify these: read the
`timeline-perf-architecture-do-not-touch` memory first.

## v2 — Stale-transport gotcha for per-frame consumers (2026-07-06, near-miss)
**Problem class:** any per-frame consumer that reads the playhead from RENDER-time props freezes
when the render diet stops per-frame renders. `WebglMediaLayer.wcTimeRef` is set during render;
during clock-driven playback the layer still re-renders per clock COMMIT (16–90ms cadence), so it
currently stays fresh — but this was a prime suspect during the freeze hunt and is fragile.
**Rule:** per-frame machinery must read `getLivePlaybackTime()` / the clock store imperatively, not
props, if it ever needs sub-commit freshness or could outlive a render pause.

## v3 — Junction transition UX: params popover + drag-tile-to-cut + shared junction actions (2026-07-13)
**Problem:** transition parameters were unreachable where editors expect them — the on-cut junction
element only drag-resized duration and double-click-removed; the gallery emitted an
`application/x-kimera-transition` drag payload that NOTHING consumed; and the junction apply/remove
reducers lived as EditorPage-local functions the AI action surface couldn't call.
**Fix:**
- **Shared lift:** `applyJunctionTransition` / `removeJunctionTransition` / neighbor finders /
  `isJunctionTransitionKind` / `DEFAULT_CROSS_DISSOLVE_SECONDS` moved verbatim from EditorPage into
  `packages/shared/src/timeline-actions/actions/transition.ts`, plus two NEW registered actions:
  `setJunctionTransition` (open-union kind, validates the pair is touching neighbors) and
  `removeJunctionTransition` — AI/voice can now edit cuts through the one approved gate (`runReplace`
  wraps the immutable-return reducer).
- **Params popover** (`JunctionTransitionPopover.tsx`): a MOTIONLESS pointerup on the junction element
  opens it (drag still resizes — `CrossDragState.moved` 3px slop; double-click still removes and the
  popover SELF-CLOSES because it re-derives the spec from `composition` per render and clears itself
  when `transitionIn` disappears). Controls are schema-driven off `getTransition(kind).params`
  (never a kind switch — plugin transitions get params for free) with legacy-field folding: defs
  declaring `direction`/`reverse`/`softness`/`dipColor|flashColor|leakColor` edit the TOP-LEVEL
  `spec.direction/mode/softness/color` (and clear the raw override) via the new shared
  `resolveSpecParams` (composition-style.ts) so specs stay legible. Perf doctrine kept: all
  scrub-time state is popover-local draft; commits on release/change only → one
  `onAddCrossDissolve` → one undo step; zero strip re-renders during a slider scrub.
- **Drag-to-cut:** lane `dragover/drop` now consume the transition MIME. `getTrackCuts` derives ALL
  adjacent-pair cuts (junctionsByTrackId only lists cuts that already HAVE a transition — wrong set
  for drop targets). Nearest cut within a zoom-aware ~24px radius; highlight state is REF-GUARDED
  (setState only when the target cut changes, never per dragover event); drop builds the spec with
  the registry default duration and replaces any existing junction transition; plugin tiles pass
  their `manifest` through a new optional 4th arg on `handleAddCrossDissolve` (registered in the
  same `updateComposition`, mirroring `applyTransitionToClip`). Gallery `TransitionThumb` tiles are
  now draggable (`dragPayload` prop) — the tree rows already were.
**Verify:** typecheck 4/4 (shared/web/worker/api), shared `actions:test` all pass, web `editor:test`
all pass. Manual: click junction → popover; drag → resize only; dbl-click → removed + popover closes;
tile drag → indicator snaps to nearest cut only; occupied junction drop replaces.
