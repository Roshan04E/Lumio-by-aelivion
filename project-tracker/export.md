# Export

## v1 — Seed pointers (2026-07-06)
No new export problems logged since the tracker started. Known history lives in AGENTS.md /
memories; headline invariants:
- Exports read ORIGINAL bytes, never `proxyUrl`.
- Black export clips historically trace to WebCodecs decoder warmup/flush lifecycle, not the
  encoder/codec — debug with `orreris.exportDecodeDebug`.
- Encoder wedges mid-export are recovered gaplessly via `EncoderStallRecoveredError` (re-render from
  the last muxed frame).
- The fragmented-MP4 demux fix (playback-preview.md v4) also applies to export decodes — fMP4
  sources exported before 2026-07-06 could truncate/freeze past the first fragment.

## v2 — "Failed to load image source for export" on vector graphics (2026-07-15)
**Problem.** Local export of any project containing a vector-graphic layer failed with
`Failed to load image source for export`. Remotion export of the same project worked, which
misdirects: it makes the graphic data look fine and the export pipeline look broken.

**Root cause.** Graphics resolve to `data:image/svg+xml` URLs. `createImageSource` decoded every image
with `createImageBitmap(blob)` — which **cannot rasterize an SVG blob without a layout engine**. It
throws inside the export Worker (no DOM) and fails on SVG blobs in Firefox/Safari even on the main
thread. Remotion was unaffected only because it rasterizes SVG through a real Chromium `<img>`.

**Fix.** Two layers (`local-export.ts`, `source-decoder.ts`):
1. Pre-rasterize SVG sources to PNG on the MAIN THREAD before dispatching to the Worker, so the
   Worker decodes a plain bitmap and never has to fail-then-fall-back.
2. Safety net in `createImageSource`: with a DOM, decode SVG via `<img>` (`createSvgBitmapViaImage`);
   without one, throw `SVG_REQUIRES_DOM`, which the existing catch turns into a main-thread retry.

**Invariants / next time.**
- `createImageBitmap(blob)` is NOT a universal image decoder — SVG needs a DOM `<img>`. Anything the
  export Worker must decode has to be a raster format by the time it crosses the postMessage boundary.
- "Remotion works but local export doesn't" ⇒ suspect a DOM/Worker capability gap, not the data.
- Same-shaped trap: `flipY` must be applied on BOTH decode paths or graphics export upside-down
  (see the `imageOrientation` note in `source-decoder.ts`).

## v3 — Animated (SMIL) graphics were frozen, not played (2026-07-15)
**Problem.** Animated icon packs (line-md, …) rendered as a single static frame everywhere. Users see
the animation flash once as the raw `<img>` decodes, then it's replaced by the frozen texture.

**Root cause (deliberate, not a bug).** `settleSvgAnimations` baked each animation's FINAL value and
stripped the SMIL, at import AND bake. It existed because those icons hide their base state
(`fill-opacity:0` / dash-hidden strokes) and draw themselves in — a static raster of the BASE state
paints nothing ("graphic doesn't render"). Settling to the completed look was the workaround.

**Fix.** Play them live via the **SMIL deep-link**: rewrite every animation's `begin="-Ts"` (+
`repeatCount="indefinite"`) so an `<img>` renders frame T at load, independent of the document clock.
Deterministic under Remotion's frozen clock; capturable via `drawImage` right after `decode()` on the
main thread. One shared `graphicAnimationFrame` (clip-local time → frame index) drives preview
(pre-baked bitmaps), local export (main-thread-rasterized PNG frame sequence → `createAnimatedGraphicSource`),
and Remotion (per-frame `src`). Gate scripts: `graphic:test`, `graphic:render`.

**Invariants / next time.**
- The DOM-less export Worker can never run SMIL. Anything time-varying and SVG-shaped must be baked
  to frames on the main thread BEFORE the Worker sees it.
- `scene-frame-compositor` passed `sourceTime = 0` for every non-video layer — any time-varying
  non-video source needs CLIP-LOCAL time threaded there first, or it silently renders frame 0 forever.
- **Float boundaries bite frame selection**: `((x % c) + c) % c` re-rounds a positive `x`
  (0.6 % 1.2 → 0.5999999999999999) and `floor(ratio*count)` then lands one frame EARLY at exact
  boundaries. Normalize the modulo only when negative and add a `1e-9` epsilon before the floor —
  otherwise renderers that derive time from the index (Remotion) desync from those that bake by index.
- Remotion's matte reuses the layer object (`{...layer, assetUrl: matte.uri}`) — any new source-bearing
  layer field MUST be cleared there or the matte decodes the wrong image.
- **The import path settled the SMIL** (`normalizeGraphicSvg`), destroying the animation before it was
  ever stored — so the whole live-playback pipeline was correct but never engaged, and every graphic
  looked static no matter what the renderers did. The stored svg is the SOURCE OF TRUTH: normalize it,
  never bake time into it. Guarded by `graphic:test` ("imported svg keeps `<animate>`"). Note the render
  gate MISSED this because it built its graphic literal directly and bypassed the import path — when a
  feature has an ingest step, a gate must exercise ingest, not just the renderer.

## v4 — Animated graphic loop semantics (2026-07-15)
**Problem.** Every animated graphic looped forever. For a spinner that's right; for a line-md draw-in it
means the icon blanks out and redraws every cycle — against what the icon author declared.

**Root cause.** `shiftSvgSmilBegin` FORCED `repeatCount="indefinite"` on every animation (added to stop
sub-cycle animations freezing/being removed mid-cycle). That silently overrode the author's
`fill="freeze"`, which declares "play once, hold final".

**Fix.** The SVG declares the intent — read it, don't override it. `graphicAnimationLoopsByDefault`
(any `repeatCount`/`repeatDur` = `indefinite` → loop) feeds `resolveGraphicAnimation`, which the layer's
`LayerGraphic.animation` (`loop: once|infinite`, `durationSeconds`) can override from the Graphic
inspector. `shiftSvgSmilBegin` no longer touches repeat attrs and SHIFTS the author's `begin` delay
instead of clobbering it.

**Invariants / next time.**
- Don't override author intent to paper over an edge case — read the intent and expose an override.
- **Never deep-link a one-shot at EXACTLY `begin+dur`**: Chrome does not reliably freeze at that
  boundary and rendered the BASE (blank) state — at the exact frame a play-once clip then HOLDS. Bake a
  hair inside the active interval (`oneShotEndTime`, 0.1% in). `fill="remove"` would also revert there.
- Loop vs one-shot need DIFFERENT bake domains: `[0, cycle)` for loops (seamless wrap, no duplicated
  endpoint) vs `[0, cycle]` for one-shots (last frame = completed state).
- Two time domains once duration is overridable: `naturalCycleSeconds` (SVG deep-link) vs
  `playDurationSeconds` (timeline selection). Mixing them silently un-scales the animation.
- Test assets lie: a `stroke-dasharray` longer than the path completes the draw early and makes the
  cycle's tail static — which quietly weakened a "coverage grows" assertion into a tautology.

## v5 — Keyframing a CYCLIC animation needs a phase, not a value (2026-07-15)
**Problem.** Make an animated graphic's loop/duration keyframeable.

**Root cause / trap.** The obvious implementation — evaluate `duration(t)` then take `t % duration(t)` —
is WRONG: the phase is discontinuous, so the animation visibly JUMPS at every duration change. A cyclic
animation must be driven by an accumulated PHASE (cycles completed), never by a value sampled at t.

**Fix.** One phase, resolved in precedence order (`graphicAnimationPhase`): `graphicProgress` keys (they
ARE the phase) → a `graphicDuration` ramp integrated as ∫₀ᵗ 1/duration(u) du → the static duration.
Frames are then selected from the phase (`graphicAnimationFrameFromPhase`).

**Invariants / next time.**
- **Rate keyframes need an integral; position keyframes don't.** Prefer exposing POSITION (progress) —
  it's simpler AND strictly more expressive (hold/reverse/ease/N-cycles fall out for free).
- `integrateRamp` (speed ramps) trapezoids a LINEAR integrand — exact there. 1/duration is a HYPERBOLA,
  so a trapezoid is ~21% off over 1s→3s; use the closed form `(1/k)·ln(d(t)/d₀)`. Assert against `ln(3)`
  AND assert it is NOT the trapezoid value, or a silent approximation looks "close enough".
- **V2 keyframes are LAYER-LOCAL**, not absolute (`evaluateTimelineTransform` evaluates at
  `timeSeconds - startSeconds`; panels store `currentTime - layer.startSeconds`). Reading the
  `layer.startSeconds + timeSeconds` at a CALL SITE and concluding "absolute" is the trap — check the
  evaluator. Local storage is also why keys survive a work-area in-point shift untouched.
- A compositor `snapshot()` closure is created once per (mode) — anything that can change under it
  (a resolved plan, the clip start) must be read through a REF or live edits never reach it.
- Don't keyframe MODES (loop once/infinite). A mode isn't a value; "at 2s switch to infinite" has no
  coherent meaning. Expose the mode statically and let a position keyframe supersede it.

## v6 — The bake was racing the SVG's own clock (spinner "renders fewer frames" in export) (2026-07-15)
**Problem.** An animated spinner played smoothly in the PREVIEW but visibly stuttered in the local
export — "like it generated fewer frames". Both paths bake the same `plan.frameCount` frames and pick
them with the same `graphicAnimationFrameAt`, so frame COUNT and SELECTION were provably identical.

**Root cause.** The deep-link primitive itself. `begin="-Ts"` renders frame T **at document time 0** —
but an `<img>`'s SVG clock starts the moment it loads and never stops, so every millisecond between
"loaded" and "we captured it" is ADDED to the baked phase. The bake was a race with the capture:
- **Preview** (`bakeAnimatedGraphicFrames`) bakes SEQUENTIALLY: decode → `createImageBitmap`, ~2ms per
  frame. A uniform ~2ms offset on every frame is an invisible, constant phase nudge. Looked perfect.
- **Local export** (`rasterizeSvgSources`) bakes with `Promise.all`: every frame's `<img>` starts
  loading at once, then each continuation runs a BLOCKING `canvas.toDataURL()` (~15ms per 1024² PNG).
  Frame k is captured ~k×15ms after it loaded — so a 1s spinner's later frames drift by a large
  fraction of a rotation. The baked frames stop being evenly spaced in phase: some land nearly on top
  of each other, others jump. That reads exactly as "fewer frames".

The frames were never dropped — they were SKEWED, progressively, by queue position.

**Fix.** Make a bake time-INVARIANT instead of hoping the capture is fast. `shiftSvgSmilBegin` now
emits `begin="-(T-ε)s" end="εs" fill="freeze"`: the active interval is exactly T long and ends at
document time ε, so the animation freezes on frame T and holds it for all later time. The clock may
run freely; the pixels can't change. ε compensates the begin shift so the freeze lands on T, not T+ε.

**Invariants / next time.**
- **ε MUST be > 0.** `end="0s"` — the obvious form — makes Chrome render the BASE state: an interval
  that ends exactly at the document start is treated as never having applied. `graphic:render` caught
  this instantly (every frame came back at base-state ink), which is the argument for verifying a
  bake primitive against real Chromium rather than reasoning from the SMIL spec.
- A staggered icon whose authored delay hasn't elapsed bakes to `begin > end` ⇒ no active interval ⇒
  its base state, which is the correct frame anyway. The rewrite gets that for free.
- **"Same math, different look" ⇒ suspect the CAPTURE, not the math.** Frame count and selection were
  identical and provably so; the divergence was in how each path physically grabbed the pixels. When
  two consumers of identical shared logic disagree, diff their I/O, not their arithmetic.
- **A fast path can hide a race that a slow path exposes.** The preview wasn't "correct" — it was
  merely quick enough that the bug rounded to zero. Any "renders X at time T" primitive that reads a
  LIVE clock must pin the clock, or it silently encodes whatever latency the caller happened to have.
- Beware of blocking work between decode and capture: `toDataURL` inside a `Promise.all` serializes
  onto the main thread and turns concurrency into a per-item latency ramp.
