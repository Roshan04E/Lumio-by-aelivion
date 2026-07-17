# Pro speed ramps: bezier easing + reverse playback (planned 2026-07-17)

User request: pro NLEs ease speed ramps (smooth accel into slow motion) and support reverse
(negative speed, clip plays backward, ramp adapts). Both are Fable-tier — they change the
**time-mapping contract** (`layerSourceTimeSeconds`, timeline.ts:324) that every renderer,
the export pipeline, and all trim/split ramp-glue ops depend on.

## Current contract (why the lane is linear-only today)

- `SpeedKeyframe { timeSeconds, value }`, piecewise-LINEAR; `integrateRamp` (timeline.ts:293) is a
  closed-form trapezoid integral. `layerSourceTimeSeconds = sourceIn + ∫₀ᵗ speed`.
- Everything hangs off that integral being exact + cheap: `layerSourceSecondsConsumed` (duration
  readout), split/trim ramp rebasing (`shiftSpeedKeyframes`), T4 head-advance, the R3.2
  `mapSourceTime` media clamps, export frame mapping.
- The graph speed lane therefore suppresses bezier handles (`hasBezierHandles`, graph-scene.ts).

## Phase S1 — bezier-eased ramps (exact math, no approximation)

Key insight: our graph handles are (time, value) cubic bezier control points. A segment's source
consumption is ∫ y(s)·x′(s) ds over the bezier parameter s — a polynomial of degree ≤5 in s, so it
has an EXACT closed-form antiderivative (degree 6). No numeric integration, no drift, identical in
every environment. Partial-segment evaluation solves x(s)=t (monotonic cubic; fixed-iteration
Newton with bisection fallback — deterministic) then evaluates the antiderivative at s.

1. `SpeedKeyframe` gains optional `outHandle?/inHandle? {dt, dv}` (absolute-time deltas like the
   graph's other handles; absent = linear segment, so old projects are byte-identical).
2. `integrateRamp` + `getLayerSpeedAt` grow bezier branches (shared file, one implementation).
   Monotonicity guard: clamp handle dt into the segment (the graph already does this for other
   curves) so x(s) stays invertible.
3. `invertRamp`/`resolveSourceSeconds`-style inverse lookups (used by preview decode targeting):
   same Newton-on-x pattern.
4. Graph editor: stop suppressing handles for kind "speed" (`hasBezierHandles`); wire handle drags
   to the new fields via `upsertSpeedRampPoint`.
5. Ramp-glue ops (`shiftSpeedKeyframes`, split, T4 advance) must carry handles through (times
   shift; dt deltas are relative → unchanged).
6. Gates: extend `animation:test`/`editor:test` with integral identities (∫ over full clip ==
   sum of segment closed forms; eased ramp with zero-length handles == linear ramp exactly);
   `render:compare:pixels` fixture with an eased ramp (frame-exact preview/export mapping).

## Phase S2 — reverse (negative speed)

Math is free: `value < 0` just makes the integral decrease — mapping, readouts, and S1 all hold.
The engineering is the MEDIA path:

1. Validation/UI: allow negative values in ClipSpeedControl + the graph lane (range −MAX..MAX);
   clamp so `sourceIn + ∫` stays within [0, assetDuration] (surface as a trim badge, like T4).
2. Export/worker: already frame-by-frame via the shared mapping — reverse works as soon as the
   mapping allows it (verify decoder seek-backward performance; the export decode cache should
   treat backward-moving targets as fresh seeks, not "stale future" — audit the warmup/flush
   lifecycle notes in the export-decoder tracker).
3. Web preview: `<video>` cannot play backward. v1: reverse spans play via the existing
   seek-per-frame shuttle path (choppy but truthful); v2 (deferred): reversed span proxy —
   the span-cache/proxy machinery generates a reversed segment so playback is smooth.
4. Audio: v1 mutes reversed spans (Premiere does this for ramps by default); true reversed audio
   is a follow-up (offline reverse of the decoded PCM span).

## Order / prerequisites

The OPEN "speed ramp hangs the browser" bug (project-tracker/playback-preview.md, unverified
suspect: unbounded seek/decode loop under aggressive compression) lives exactly where S2's
preview work goes — fix it FIRST with a repro, or S2 debugging compounds it.

S1 is independent of the hang and can ship alone (eased forward ramps).
