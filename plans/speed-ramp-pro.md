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

## Phase S1 — bezier-eased ramps (exact math, no approximation) — SHIPPED 2026-07-17 (0477f86)

> Implemented per the design below with ONE deviation: handles are stored in the graph's
> FRACTIONAL convention (dx = fraction of segment span, dy = fraction of value delta) rather than
> absolute (dt, dv) — it plugs straight into the existing handle UI/mirroring and keeps the ease
> shape stable under neighbor retiming (AE behavior). Plus a step the design missed:
> `shiftSpeedKeyframes` does an exact de Casteljau subdivision when a head trim lands inside an
> eased segment. Gated by 7 new editor.test checks (linear-equivalence at 1e-9, split preservation
> at 1e-6). Known convention limit: a dy bulge over EQUAL endpoint values is inexpressible (dy
> scales the value delta) — same as every other graph lane.

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

## Phase S2 — reverse (negative speed) — CORE SHIPPED 2026-07-18 (0459975)

> Implemented per the design. Deviations/notes: (1) audio EXPORT does TRUE reverse (per-sample
> pre-render walks source PCM backward) rather than muting — only PREVIEW audio mutes reversed
> spans (v1). (2) Export VIDEO needed nothing: the WebCodecs decoder's reverse-shuttle cache
> (built for backward scrubbing) already serves backward frame targets. (3) Preview reversed video
> rides the existing R3 edge-hold state (element pauses, per-tick backward seeks) — the seek-per-
> frame shuttle path the design called for. (4) `getLayerSpeed` now returns SIGNED; every magnitude
> consumer (durations, element playbackRate, headroom divisions via new `edgeRateMagnitude`) takes
> `Math.abs`. (5) T4 head-manufacture and nest-level expansion reject/ignore reverse (v1) — a
> reversed COMPOUND needs per-frame nest-time eval (deferred to a would-be S3). 7 new editor.test
> reverse checks (sign, backward source time, signed integral netting through a zero crossing,
> freeze spans, head-trim continuity). STILL RIDING with the parallel nesting batch (inseparable
> shared-file hunks): ClipSpeedControl Reverse button + readout (EditorPage), the reverse tests
> (editor.test), the nesting `|clipSpeed|` guard (nesting.ts). Deferred: reversed span PROXY for
> smooth preview (v2), true reversed preview audio (v2), the clamp-to-asset trim badge.

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

---

## Status + DEFERRED work (2026-07-18)

**Shipped:** S1 eased ramps (0477f86), the ramp-hang root-cause fix (7a6cc79 — so the "fix the hang
first" prerequisite above is DONE), S2 reverse core (0459975), smooth reverse preview (WC path
present-directly). Reverse in/out swap + ClipSpeedControl Reverse UI are done but ride with the
parallel nesting batch (shared EditorPage.tsx) — commit them when that batch lands.

**Deferred — not yet built (pick up here):**

1. **Reversed span PROXY (smooth-preview v2).** Today reverse presents the WebCodecs reverse-shuttle
   cache directly (smooth within a GOP, may drop frames at GOP boundaries on sparse-keyframe
   sources). The Premiere-grade next step: the sourceProxy worker pre-transcodes a REVERSED segment
   for a reversed span and plays it FORWARD, so no playback code sees backward motion at all. Big:
   worker transcode + proxy store record + playback source-swap/time-remap. See
   `editor/performance/sourceProxy.worker.ts` + `proxyMediaStore.ts`.
2. **True reversed PREVIEW audio.** Export already plays true reversed audio (per-sample PCM walk in
   `audio-mixer.ts`). Preview MUTES reversed spans (v1). v2: offline-reverse the decoded PCM span
   (Web Audio) and play that buffer forward during the reversed span — mirrors the export mixer.
3. **Clamp-to-asset trim BADGE for reverse.** The mapping clamps `sourceIn + ∫` to [0, assetDuration]
   silently; surface a badge (like T4's "no head material") when a reversed clip runs past either
   media edge so the user sees why it holds a frame.
4. **Reversed / ramped COMPOUND clip (would-be S3).** `expandNestedCompositions` ignores a compound
   clip's reverse (uses `|clipSpeed|`) and rejects ramps ON the compound — the static child-time
   derivation assumes forward, constant parent time. A reversed/ramped compound needs per-frame
   nest-time evaluation (evaluate each child at the parent's instantaneous mapped nest time), a
   materially bigger change than the affine substitution used today.
5. **Eased-ramp dy-over-equal-endpoints.** The fractional handle convention can't express a value
   bulge between two points of EQUAL speed (dy scales the endpoint delta → 0). Same limit as every
   other graph lane; only matters for an ease that overshoots between equal-rate points.
