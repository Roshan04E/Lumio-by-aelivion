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
