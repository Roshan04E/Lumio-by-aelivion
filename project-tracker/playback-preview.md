# Playback / preview

## v1 — "Plays ~4s then freezes" in the production build, Auto quality (2026-07-06)
**Problem:** On `:4173` (build), Auto/½/¼ playback froze after a few seconds (transport kept moving,
picture stuck); dev `:5173` played fine; fixed "1" quality fine. Occasionally whole-page
"unresponsive".
**Root cause:** Ingest-proxy transcodes ran ON THE MAIN THREAD and only suspended at full quality —
on the build origin (separate, cold OPFS) a transcode started the moment play did and starved the
live layers. The proxy overlay also revealed the live compositor INSTANTLY at span exit, exposing
whatever silently-wedged frame it produced while hidden.
**Fix:** Builds suspend during ANY playback; transcode moved to `sourceProxy.worker.ts`; span-exit
hold + `requestLiveReprime()` (ProxyPlaybackLayer → WebglMediaLayer); SW chunk caching CacheFirst →
NetworkFirst; cold-origin toast. Telemetry: `__rfSpanExitReprimes`.
**Verify:** typecheck/editor:test/build; later superseded — see v2–v4 (same symptom, other causes).

## v2 — Same symptom persisted: corrupt v2 ingest proxies (2026-07-06)
**Why v1 wasn't enough:** the proxy FILES on the build origin were built by the old engine while
playback starved it — the freeze was baked into the media, so fixing the scheduler didn't fix files.
**Fix:** `SOURCE_PROXY_VERSION` 2 → 3 (force rebuild through the worker).
**Verify:** user: "yes it did play".

## v3 — Same symptom on a just-added clip: WC preview decode of sparse-GOP originals (2026-07-06)
**Why v2 wasn't enough:** a newly added clip has no proxy yet; the WebCodecs preview pool decoded
the ORIGINAL (1 sync frame / 250 samples), ground whole GOPs in software, and the hold/pan machinery
showed a frozen picture. HUD showed 75fps while still — the compositor was fine, one layer's frame
source was stale; frame-rate telemetry cannot see this state.
**Fix:** `preferNativeDecode` (VideoPreview → WebglMediaLayer): original-bytes sources skip the WC
pool and play via the native `<video>` element (hardware, forward playback is its strength); the
layer upgrades to WC automatically when the proxy lands (src flips). Watchdog gained SELF-HEAL 3
(element >1s behind while playing → re-seek+resume, `__rfElementNudges`) and SELF-HEAL 4 (no paint
for 1s while playing → forced draw, `__rfStaleDrawKicks`).
**Verify:** Playwright harness — cold-cache run played the 45.8s project end-to-end; warm-proxy run
likewise. User confirmed fixed.
**Gotcha for next time:** two "not fixed" reports were a STALE BUNDLE served by the old service
worker — always check the `index-*.js` hash in the console first.

## v4 — Same symptom, new trigger: fragmented MP4s frozen at a constant timestamp (2026-07-06)
**Why v3 wasn't enough:** Pexels downloads are FRAGMENTED MP4s. `demuxIndex()` accepted the sample
table available at `onReady` as the whole movie — for fMP4 that's only the first fragment (~8–10s).
`chunkIndexForMicros` clamps to the last indexed sample, so playback froze at exactly the fragment
boundary (user matrix: 8.5s/8.8s/10.4s/16.8s depending on variant) AND proxy builds baked the frozen
tail into the proxy file (a clamped frame isn't null, so the frozen-tail guard never fired).
Clipchamp re-encodes (classic single-moov) were fine at any length — the user's encoding hypothesis
was correct; it was never size or duration.
**Fix:** `demuxIndex` keeps following mp4box's next-parse positions to EOF when `info.isFragmented`,
so every fragment's samples land in the index (offsets are absolute → existing streaming blob window
works unchanged). `SOURCE_PROXY_VERSION` 3 → 4 to rebuild poisoned proxies. Transient cost ~1× file
size in RAM during the one-time index build.
**Verify:** Node demux probe (beach.mp4: 250 → 1108 samples, 10.4s → 46.17s coverage); harness played
the user's 47.2s Pexels project end-to-end on rebuilt v4 proxies.

## v5 — DIAGNOSIS ONLY: ingest-proxy playback motion is choppy (~11–25fps feel) while HUD shows 65–72fps (2026-07-06)
**Problem:** With ingest proxies active (Auto/½/¼), motion looks massively frame-dropped even though
the browser is responsive and the HUD reports 65–72fps. Originals (pre-proxy) and green span-proxy
segments play smooth. Resolution drop during proxy playback is BY DESIGN (paused = full-res settle
frame); the frame-rate feel is not.
**Root cause (confirmed by code walk, no fix shipped yet):** the proxy FILE is fine — 854-long-edge,
`min(source fps, 30)`, 1:1 frame mapping. The choppiness is in how its frames are SERVED. Ingest
proxies play through the WebCodecs preview provider (`preferNativeDecode=false`), whose rAF request
loop computes the target time from `wcTimeRef` → `props.currentTime` → the COMMITTED playback clock,
and EditorPage commits that clock every `playbackCommitIntervalMs` = 16ms ("1") / 40ms ("½") /
90ms ("¼") (EditorPage.tsx:1026). So the requested source time only advances 25×/s (½) or ~11×/s
(¼/degraded-Auto): the same frame is re-served between commits. Original files and span proxies
don't have this ceiling because a native `<video>` element plays itself continuously and
rvfc presents every decoded frame — the clock never gates them. The HUD measures the compositor
loop, which redraws (the stale texture) at full rate — that's the 65–72fps vs still-picture split.
**Fix direction (deferred, do-not-code-yet per user):** feed the WC request path from
`getLivePlaybackTime()` (anchor-derived, sub-commit precision — exists for the audio-master gate)
instead of the committed clock prop, making proxy motion `min(proxy fps, decode rate)` like the
element path. Alternatively play ingest proxies through the element path too (they're ordinary
1s-GOP H.264 MP4s) and keep WC for scrubbing.
**Related:** ½ vs ¼ look identical on proxy sources because the 480p ingest proxy is the resolution
bottleneck; their real difference is compositor render scale + the 40ms vs 90ms commit cadence
(¼ actually FEELS worse in motion for this reason).

## v6 — FIX for v5: WC frame requests ride the live clock (2026-07-06)
**Problem:** v5's diagnosis (proxy motion capped at the 40/90ms clock-commit cadence).
**Fix:** `requestWcFrame` (WebglMediaLayer.tsx) derives its target from `getLivePlaybackTime()`
(anchor-derived, sub-commit precision) while playing, guarded by
`WC_LIVE_CLOCK_MAX_DIVERGENCE_S = 0.35`: the live value is only trusted when it agrees with the
layer's committed `currentTime` prop within one commit interval — other VideoPreview mounts
(SmartFollowTextToolPanel, PreviewFixturePage) run their own transport, and the editor's
module-global clock would be a foreign playhead there (they fall back to the old prop behavior,
as does >0.35s-divergent fast shuttle). Paused behavior unchanged (committed prop).
**Verify:** typecheck + editor:test + build clean; in-page rAF cadence probe on the user's real
project (:4173, warm v4 proxies): ½ = 22.5 distinct frames/s, ¼ = 22.7/s — EQUAL across tiers
(broken behavior was tier-bound ~25 vs ~11) at the sources' ~24fps. WC-path attribution probe
(max __rfWcPool.active during sampling) run as follow-up.

## v7 — GPU compositor context-loss recovery ladder was broken (2026-07-06)
**Problem:** User console: "GPU compositor context lost; controlled rebuild 1/3 in 150ms" followed
by "GPU compositor init failed — falling back to DOM path: gl-context: shader compile failed:
unknown". Also "black frames when stepping backward/forward" — the viewer went black on a lost
context and stayed on the (slower) DOM path.
**Root cause:** two stacked defects. (1) `getContext("webgl2")` on a canvas whose context was lost
returns the SAME dead context (documented in releaseContextIfDetached, and the trap it warns about
is exactly what the rebuild did) — so rebuild attempt 1 compiled shaders on a still-lost context.
(2) Compile on a lost context fails with an EMPTY info log → "shader compile failed: unknown",
which `isContextLostError` didn't recognize → the 3-attempt retry ladder was short-circuited to a
permanent DOM fallback on its very first attempt.
**Fix:** (a) `compileShader`/`linkProgram` (gl-context.ts) and media-renderer's `compile` now throw
the context-loss sentinel (`GL_CONTEXT_LOST` / `MEDIA_RENDERER_CONTEXT_LOST`) when
`gl.isContextLost()`; ScenePreviewCanvas's `isContextLostError` matches the new sentinel.
(b) ScenePreviewCanvas keys its `<canvas>` on `recoveryTick` — every recovery attempt REMOUNTS a
fresh canvas element (fresh context), and the contextlost/restored listener effect re-attaches per
tick (with `[]` deps it kept watching the discarded element).
**Verify:** typecheck (shared+web), governor:test, editor:test all pass; build clean. Field signal
to watch: "controlled rebuild N/3" should now be followed by a successful rebuild, not the DOM
fallback, unless the GPU is genuinely gone.

## v8 — Phase 5 SHIPPED behind flag: GPU-first single-context preview (`orreris.singleCtxPreview`, default OFF) (2026-07-07)
**Problem:** In scene mode every media clip still ran its own `MediaWebGLRenderer` context/canvas:
2 GPU uploads per layer per frame (raw→per-clip canvas, canvas→compositor texture), one WebGL
context per clip (governor churn, context-loss storms at the browser's ~16 cap), extra VRAM. The
export already solved this (`exportSingleContext` grades in-context on ONE context).
**Fix (plan Phase 5, converging preview onto the export architecture):**
- `WebglMediaLayer`: when handed a `sceneMediaSink` (new prop), creates NO GL context — publishes a
  raw frame-source descriptor (`scene-media-source.ts`: element / held WC VideoFrame clone / settle
  frame / still bitmap + live pipeline/matte/effects/amount/bakedOpacity) and pokes a recomposite
  per new frame. All frame-DRIVING machinery (WC provider + holds, watchdogs, live-clock, settle
  frame, matte lease) unchanged — only the terminal draw became a publish (`selectVideoDrawSource`
  is the shared source-selection for both modes).
- `ScenePreviewCanvas`: `getMediaGraded` seam now grades the raw frame in-context via pooled
  shared-context `MediaWebGLRenderer` + `RenderTarget` on the compositor's own WebGL2 context
  (the `regionGradeRenderers` / export-single-context precedent), returning a `SceneTextureSource`
  (sampled directly, no upload). Re-grade skip keyed on frameVersion+grade keys keeps static stills
  at ZERO uploads (probe: 1 grade + 29 skips over a settle window). Blur-clone alias + `_copy_`
  fallback mirrored from the canvas path. Telemetry `window.__rfSingleCtxPreview` {grades, skips}.
- Scopes readback: new `SceneCompositor.readCompositeThumbnailAsync` — PBO + fence, non-blocking
  `clientWaitSync(0)` harvest one tick later — replaces the synchronous GPU-drain `readPixels`
  while the flag is on (OFF keeps the exact sync path). PIXEL_PACK_BUFFER unbound in `finally` so
  an exception can never poison later client-buffer readPixels.
- Scene-failure fallback hardened: the renderer-create effect keys on the mode so a runtime scene
  GL failure (flag ON) re-arms own-renderer mode with listener + immediate repaint.
**Gate evidence (all on final code):** typecheck 5/5 pkgs; editor:test; governor:test;
`scene:compare` (chrome) OFF 22/22 AND `SINGLE_CTX_PREVIEW=1` 22/22 with ZERO threshold changes —
media-fixture diffs byte-identical between flag states; `render:compare:pixels` 23/23 at 0.000%
twice. Engagement proven (not silent-fallback): `__rfSingleCtxPreview.grades>0` flag-on,
untouched flag-off.
**Also fixed (harness, flagged to user for sign-off):** `render-pixel-comparison.ts` screenshot
raced the scene compositor's first paint → randomly captured a BLACK canvas (~88% diff on
arbitrary fixtures per run; failing web captures meanLuma≈0 vs remotion≈110). Added the same
250ms settle its sibling `scene-compositor-compare.ts` always had. Capture-sync only.
**Flip procedure:** soak with `localStorage.setItem("orreris.singleCtxPreview","1")` on :4173 →
watch `__rfSingleCtxPreview`, `__rfGlContextBudget` (media contexts should drop to ~0),
`__rfLiveFreeze` → then default ON in `getSingleCtxPreviewEnabled` (render-engine.ts).

## v9 — singleCtxPreview soak bug: black flicker on ruler clicks (2026-07-07)
**Problem:** With `orreris.singleCtxPreview=1` on :4173, clicking the playhead around the ruler
flickered the viewer black (~11 flickers over 19s of scrubbing). Playback itself was clean
(377 grades / 596 skips, `__rfLiveFreeze` clean).
**Root cause:** behavioral gap vs the own-canvas path. Mid-seek, a `<video>` element drops
`readyState` below HAVE_CURRENT_DATA for a few frames. The old path implicitly held the layer's
graded CANVAS (stale pixels persist through the seek); the single-ctx path re-samples the raw
source per composite → `snapshot().frame` null → layer dropped from the draw list → background
flash until the seek landed.
**Fix:** `gradeMediaInContext` (ScenePreviewCanvas) now HOLDS the last graded RenderTarget when the
live source is transiently unready (`entry.lastW/lastH` recorded per draw) — the exact semantics
the graded canvas provided. Never-drawn layers still return null (poster covers first paint).
**Verify:** web typecheck; `SINGLE_CTX_PREVIEW=1 scene:compare` 22/22 re-passed; rebuilt
(`index-CU6xWbj_.js`); user re-scrub test pending.
**Update (2026-07-07, later):** user re-verified on the rebuilt :4173 — scrubbing clean, no
flickers; soak signed off ("done happy"). Flag stays OFF by default; flip = one line in
`getSingleCtxPreviewEnabled()` after a longer real-editing soak.

## v10 — DEFAULT FLIPPED: `orreris.singleCtxPreview` ON (2026-07-07)
**Decision:** user go ("we should flip.. we are ready") after the v8 gate ladder + v9 soak fix.
**Change:** `getSingleCtxPreviewEnabled()` env fallback `false` → `true` (render-engine.ts) + doc.
**Gate ladder re-run on the flipped default (plain runs now exercise the single-ctx path):**
typecheck 5/5 · editor:test · governor:test · `scene:compare` (chrome) 22/22 ·
`render:compare:pixels` 23/23 — the in-context-graded preview is pixel-aligned with the Remotion
export at 0.000%. Rebuilt: `index-CGNM5ptK.js` on :4173.
**Escape hatches (permanent):** `?singleCtxPreview=0` per session, localStorage
`orreris.singleCtxPreview="0"`, or `VITE_SINGLE_CTX_PREVIEW=0`. The per-clip-context path stays
intact (DOM-compositor mode still uses it) — rollback is the same one line back to `false`.
**Watch in the field:** `__rfSingleCtxPreview` {grades, skips}; `__rfGlContextBudget.owners`
media-renderer count ~0; `__rfLiveFreeze` stays clean; no "Too many active WebGL contexts".

## v11 — Stylize effects hardening: grain pattern reset, non-aspect vignette, green-only chroma keyer (2026-07-13)
**Problem:** Three shipped WebGL stylize effects were "real shaders" but not pro-grade: film grain
visibly RESET its noise pattern every whole second (seed was `fract(u_time)`); vignette was a UV-space
circle (elliptical on 9:16/16:9 frames, no feather control, darkened highlights linearly); chroma key
used Euclidean RGB distance (dark/bright shades of the key color keyed differently) with a hardwired
green-only 0.6 desaturate spill fix — useless on blue/orange screens, no choke, no matte view.
**Root cause:** v1 implementations in the shared `MEDIA_FRAGMENT_SHADER` (media-shader.ts) were
minimal branch blocks; params were never extended past the initial amount/size/tolerance set.
**Fix:** all in the ONE shared shader so preview/browser-export/Remotion stay aligned by construction:
grain seed → `mod(u_time, 61.7)` (long non-integer period, no repeat) + new `size` param (25–400%,
100 = legacy grid); vignette → aspect-corrected via new `u_aspect` + `roundness` param (0 = legacy UV
circle), `feather` (100 = legacy fall-to-corner), `highlights` protection (0 = legacy multiply) — all
defaults bit-equal to the old math; chroma key → BT.709 CbCr-plane normalized distance (any key color,
luminance-robust), key-direction despill with luma-preserving reconstruction (`despill` default 60 ≈
old 0.6 desaturate), `choke` matte erosion (default 0 = identity), `matteView` boolean (first boolean
registry param). Files: media-shader.ts, media-renderer.ts, effects.ts, composition-style.ts,
color/types.ts. New pixel fixtures `vignette` / `grain` / `chroma-key` (keys the fixture's ORANGE hill
— proves non-green keying) in render-comparison-fixture.ts.
**Accepted deltas:** grain pattern re-rolls once (statistically identical); existing chroma-key edges
shift slightly (metric change, generally better). Vignette defaults are exactly the old output.
**Verify:** `render:compare:pixels` (chrome) plain-image/blur 0.000% (no default drift), vignette
0.000%, grain 0.001%, chroma-key 0.001%; `scene:compare` on the same fixtures; typecheck 5/5.

## v12 — DOM-fallback transition: transformed clips snapped at the window boundary (2026-07-13)
**Problem:** with scene preview OFF (`?singleCtxPreview=0` escape hatch), a scaled/positioned/rotated
clip visibly JUMPED at a junction transition's start/end — the mix rendered both clips full-frame
(only object-fit remapped in the shader), then the clip snapped back to its real transform when the
window ended.
**Root cause:** the DOM `TransitionOverlay` (TransitionLayer.tsx) feeds the two-texture
`TransitionCompositor` the clips' GRADED canvases — which are PRE-transform images; in normal frames
the transform is applied as CSS on the element (`getCompositionMediaStyle`), so the overlay's mix
never saw it. The scene-compositor path (default preview + export + Remotion) was already correct via
P2a nest pre-compose (sides pre-composed with full transforms, fit hardcoded (1,1)) — this bug was
FALLBACK-ONLY, so exports were never wrong.
**Fix (minimal, fallback-contained — user decision over retiring the overlay):** the overlay now
PRE-BAKES each side through exactly the DOM element's CSS geometry (comp-sized box at `x%,y%`,
centered, rotate, scale, object-fit inside the box, box-clipped) into a reused comp-sized 2D canvas,
then mixes with fit "fill" — the same pre-baked-sides architecture as the scene path, without
touching the shared shader harness or `TransitionCompositor`. Identity transforms skip the bake
(byte-identical to before, and the pixel-gate `transition` fixture uses identity transforms).
Keyframed transforms evaluate per frame via the shared `getCompositionTransform`. Accepted
fallback-only limits, matching what the DOM element path itself renders outside the window: 3D tilt
approximated by its 2D part; content pan/zoom/crop not applied (the DOM style doesn't apply it
either — adding it in the window would CREATE a boundary jump). Also fixed the stale
transition-compositor.ts header claiming export/Remotion still use that class.
**Verify:** typecheck clean; scene path untouched (grep: no scene-compositor/build-scene-draws
changes). Manual: `?singleCtxPreview=0`, right clip scaled 50% + offset + rotated, crossDissolve →
blend stays in place through the window, no snap at either boundary.

## v13 — Frozen LAST ~1s on every clip: ceil-to-Int asset durations overshot the media (2026-07-13)
**Problem:** user report: "the last one sec is frozen in all" clips — every clip's tail held its
final frame for up to ~1s. "We added a guard but it's not working."
**Root cause (two stacked, neither seen by the existing guards):**
1. `SourceAsset.durationSeconds` was a Postgres **Int**; the API CEILED every upload
   (`assets.routes.ts`, also `stock.routes.ts` and the sync promoter). The web `createAsset` DID
   guard this — it restored the real fractional duration on its response (`withRealDuration`) — but
   only for that session: nothing persisted the real value, so every reload/`listAssets` returned
   the ceiled Int and every clip added afterwards was authored up to ~1s past the decodable media.
2. Past the last sample, `getFrame` CLAMPS to the final frame — **never null** — so (a) the live
   path froze the tail, and (b) proxy builds trusted the metadata duration and BAKED the repeats in;
   the null-based frozen-tail guard (v2) and the fMP4 index fix (v4) both can't see clamped frames
   (v4's own text called this trap out).
**Fix (three layers):**
- Root: `SourceAsset.durationSeconds` Int → **Float** (migration `source_asset_duration_float`);
  de-ceiled all four write sites (assets route, stock route, web `createAsset`, sync
  `serverCreateAsset`). New uploads persist the exact probed decodable end.
- Defense: `FrameProvider.decodableEndSeconds` (last sample timestamp+duration from the demux
  index); BOTH proxy build loops (worker + main-thread) clamp their frame loop to it — a frozen
  tail can never bake into a proxy again regardless of metadata. `SOURCE_PROXY_VERSION` 4 → 5 to
  rebuild v4 proxies encoded without the clamp.
- Heal: legacy Int rows can't be un-ceiled server-side (real value unknown there), so the proxy
  transcode — which demuxes the truth anyway — reports it and `healAssetDurationSeconds` PATCHes
  the asset (downward-only, server-enforced) + the local record. Assets heal progressively as
  proxies build.
**Residual (by design, not silent):** clips ALREADY placed with a ceiled length keep their frozen
tail until the user re-trims them or deletes+re-adds after the asset heals — auto-shortening
placed clips would silently change timeline layout.
**Verify:** typecheck 5/5, editor:test all pass, migration applied. Runtime float writes need the
Prisma client regenerated with the dev server STOPPED (`prisma generate` EPERM-locks on the running
API's engine DLL) — flagged to the user.
**Why v2/v4 weren't enough:** both guards keyed on the decoder (null runs, missing fragments); this
overshoot produces perfectly valid clamped frames. The new clamp keys on the sample table itself.

## v14 — "Stacked identical layers flash visible for a frame" — diagnosis only, unverified (2026-07-17)

**Problem (roadmap item, unreproduced).** Report: two visually-identical stacked clips (same asset,
same on-screen position, on different tracks or via duplicate) each flash briefly visible for one
frame. No repro steps existed; this session did static analysis only — no browser repro was run, so
treat the mechanism below as a STRONG SUSPECT, not confirmed.

**Suspected root cause.** `isLayerActive` (`apps/web/src/components/VideoPreview.tsx:5254-5256`):
```ts
export function isLayerActive(layer: TimelineLayer, currentTime: number) {
  return currentTime >= layer.startSeconds && currentTime <= layer.startSeconds + layer.durationSeconds;
}
```
Both ends are INCLUSIVE (`>=` ... `<=`). This is the base eligibility filter feeding the actual
editor visual pipeline: `activeVisualLayerEntriesRaw` (~L772-782) → `activeVisualLayerEntries` →
`renderVisualLayerEntries` → `renderedLayerEntries` → `sceneLayers` (~L1082-1101) → what
`ScenePreviewCanvas`/`buildSceneDraws` actually composites. At the exact instant
`t = clipA.startSeconds + clipA.durationSeconds`, clipA is STILL active (closed upper bound) — and if
another clip clipB starts exactly there (the common back-to-back-cut case, or two stacked clips on
different tracks sharing a boundary), clipB is ALSO active at that same instant. For that one frame
both are eligible and both draw; if they don't fully occlude each other (different track z-order
gap, transparency, or simply two SEPARATE layers rather than one continuous clip) the extra frame
reads as a flash.

By contrast, the export-side scene filters (`apps/web/src/export/scene-frame-compositor.ts:614` and
`apps/worker/src/remotion/SceneStage.tsx:597`) use a HALF-OPEN window (`t >= start - preroll && t <
start + duration + postroll` — note the strict `<`), so exports likely do NOT reproduce this; it may
be editor-preview-only, which would match "unreproduced" reports being inconsistent.

**Why not fixed this session.** `isLayerActive` is a widely shared eligibility gate (also drives
`activeAudioLayerEntriesRaw`, the mask overlay's mount gate, and transition pre/post-roll math via
`isOutgoingInPostroll`). Flipping the upper bound to strict `<` risks the OPPOSITE regression — a
clip's true last frame (the one currently rendered exactly AT `start + duration`) disappearing one
frame early — unless something else already guarantees the last sampled frame time never lands
exactly on that boundary (frame-quantization elsewhere might already prevent it, but this needs a
live repro to verify either the bug or the fix, not more static reading). Needs an actual two-
identical-clips repro (record playhead scrub across the shared boundary, screenshot-hash every
frame — see the Playwright repro pattern in this file's README) before touching a function this
widely depended on.

**Next step:** build the repro harness first; only then decide whether the fix is a boundary-
exclusivity change to `isLayerActive`, or a dedupe pass in `sceneLayers`/`buildSceneDraws` that
collapses genuinely-identical simultaneous draws instead (safer — leaves `isLayerActive`'s other
callers untouched).

## v15 — "Speed ramp hangs the browser" — diagnosis only, likely already mitigated (2026-07-17)

**Problem (roadmap item).** Report: an aggressive speed ramp hangs the tab. No repro steps or date on
the original report; this session did static analysis only — no browser repro was run.

**What's already fixed (dated 2026-07-16, same file).** `apps/web/src/components/VideoPreview.tsx`
~L2766-2788, the ramp-follow effect, carries an explicit incident comment: a per-tick `video.currentTime`
write on a PLAYING element "flushes/re-primes the decoder and hangs the tab." The fix throttles the
drift-correction seek to a ~500ms cadence (tight 0.08s threshold only at the checkpoint, loose 0.25s
between checkpoints) instead of correcting every tick — this specific "seek-storm" mechanism reads as
already closed.

**Unverified remaining theory (from the roadmap wording).** "Ramp compresses many source seconds into
few timeline seconds" suggests a DIFFERENT mechanism: not seek FREQUENCY but seek MAGNITUDE — a high
ramp value (e.g. 8-16x, `MAX_LAYER_SPEED` in `packages/shared/src/timeline.ts:197`) means even one
500ms-cadence correction can jump `video.currentTime` by many seconds of source. Single large seeks are
normally cheap for browsers (not a "loop"), so this theory is weaker than it reads, but wasn't ruled
out — `syncVideoTime` (~L2728-2742) has no `video.seeking` guard, so an in-flight seek could in theory
overlap with a following one if a resync fires before the previous seek settles.

**Why not fixed this session.** The known/confirmed mechanism already has a shipped fix; the
"compresses many seconds" theory is speculative and unconfirmed. Without a live repro (aggressive ramp,
e.g. 1→16x over 0.5s, played back with devtools performance/hang recording) there's nothing concrete to
patch, and guessing at a fix for an already-mitigated bug risks papering over a report that predates
the 2026-07-16 fix and no longer reproduces.

**Next step:** repro with an extreme ramp on current `main`/this branch first. If it still hangs, check
for overlapping seeks (`video.seeking` before writing `currentTime`) and consider `requestVideoFrameCallback`-
gated correction instead of the wall-clock 500ms timer. If it no longer hangs, close the roadmap item.

## v16 — Speed-ramp hang: root cause found by code audit, fixed (2026-07-17)

**Follow-up to v15's "next step".** Two concrete mechanisms found and closed, no live repro needed —
both are provable from the code + browser spec:

1. **`playbackRate` below Chrome's floor THROWS.** Chrome's supported HTMLMediaElement.playbackRate
   range is [0.0625, 16]; assigning outside it throws NotSupportedError (it does not clamp). Our
   `MIN_LAYER_SPEED` is **0.05** — below the floor — and the ramp-follow effects write the rate on
   EVERY clock tick. One ramp point at 5–6% speed ⇒ an uncaught exception per tick on a playing
   element ⇒ the reported "hang". Fix: all 7 element-rate writes (VideoPreview video+audio ×2 each,
   WebglMediaLayer source catch-up + matte, MaskedVideoLayer matte) now go through
   `playback/media-rate.ts # setMediaPlaybackRate` — clamps to [0.0625, 16], skips no-op writes,
   try/catches for narrower engines. Display-only: at 5% the element free-runs a hair fast and the
   throttled seek corrector (exact shared mapping) pulls it back each checkpoint.
2. **The audio ramp path never got the 2026-07-16 seek-storm fix.** The video ramp-follow throttles
   drift-correction seeks to a ~500ms cadence; the AUDIO ramp effect still called `syncAudioTime`
   (fixed 0.08s threshold) on every tick while playing — on a curved ramp that trips virtually every
   tick ⇒ per-frame `currentTime` writes on a playing element, the same decoder-flush storm. Fix:
   same 500ms checkpoint cadence (`lastAudioRampSyncMsRef`).

Also hardened per v15's theory: `syncVideoTime`/`syncAudioTime` now skip issuing a new seek while
`element.seeking && !element.paused` (overlap guard) — paused scrubbing keeps latest-wins writes.

**Verify:** ramp 1x→5% and 1x→16x over ~0.5s on a video+audio pair, play through, devtools console
must stay clean (no NotSupportedError) and the tab responsive. Roadmap item can close on that pass.

## v17 — Ingest-proxy quality "not workable" + silent builds read as a timeline hang (2026-07-18)

**Report:** busy street footage (Tokyo crosswalk) unusably soft on proxy playback while "some clips
get really good quality" — those clips had SKIPPED proxying (<12MB or ≤854px long edge) and were
playing the sharp original. Separately: during a cold origin's initial build burst there was no
user feedback, and ingest jank made the timeline read as frozen/hung.

**Root causes:**
1. Quality: the v1 recipe (854px long edge, 0.1 bits/pixel/frame ≈ 1.2 Mbps H.264 @ 480p30) is
   below usable for detail/motion-dense content. The variance the user saw was proxied-vs-skipped,
   not per-clip luck.
2. Feedback: the only signal was the ONE-SHOT cold-origin notice (v1 era, `firstBuildListener`) —
   nothing during the minutes of building; combined with main-thread costs at ingest
   (`blob.arrayBuffer()` full-file copy + `decodeAudioData` + PCM plane copies before the worker
   handoff), silence + jank = "it froze".

**Fix (recipe v6):**
- `PROXY_LONG_EDGE` 854 → 1280, `PROXY_BITS_PER_PIXEL_FRAME` 0.1 → 0.18 (≈5 Mbps @ 720p30 —
  Premiere's proxy tier). `SOURCE_PROXY_VERSION` 5 → 6 forces rebuild of all 480p proxies.
  Storage ~4× (~37 MB/min) — fine for OPFS.
- Live progress: worker posts `{type:"progress"}` every 30 frames (protocol + main-thread fallback
  loop both); engine steps it to 5% increments (`setSourceProxyProgressListener`, null = queue
  drained) with queue depth; EditorPage mirrors into the notice line ("Optimizing media — 45%
  (+2 more queued)…" → "finished" close-out). CRITICAL detail: the engine's worker `onmessage` used
  to `cleanup()` (terminate!) on ANY message — progress is now handled non-terminally.
- Ingest jank: audio pre-decode parks behind the suspension gate + yields after; big copies never
  land mid-interaction.

**Verify (user):** reload → proxies rebuild with visible % notice; after rebuild, ½-quality playback
on the crosswalk clip should be judgeably sharp at fit zoom; no frozen-timeline feel during the
rebuild burst. If 720p proxies still feel soft on 4K sources at 100% zoom, the next lever is a
per-source ladder (proxy = min(1280, half the source long edge)) — NOT more bitrate.

## v18 — Proxy playback "fps is very down" at ½ quality (2026-07-19)

**Report:** at ½ quality playback feels heavily fps-dropped; "in Premiere quality decreases but
never fps". Full quality (originals) felt smooth-motion by comparison.

**Root cause:** recipe v6's `PROXY_FPS = 30` CAP. ½/¼/Auto substitute the ingest proxy
(`resolvePlaybackUrl`), so any >30fps source (60fps phone/action footage) played at HALF its
frame rate whenever quality wasn't "1" — a motion loss no hardware or render-scale could fix.
The adaptive-quality ladder was innocent: it only caps render SCALE; the missing frames were
never in the proxy file. Premiere's proxy model = lower resolution, NEVER lower motion.

**Fix (recipe v7):**
- `PROXY_FPS` 30 → 60. Sampling still follows the source's own cadence (`min(cap, nominalFps)`),
  so 24/30fps sources re-encode byte-identically to v6 — only >30fps sources change.
- Unknown-cadence fallback (`nominalFps` null, the `<video>` provider) now assumes 30, NOT the
  cap — a 60 grid would have duplicated every frame of typical 30fps footage (both worker and
  main-thread sites).
- Sublinear bitrate law at both encode sites: `× min(1, √(30/fps))` — consecutive frames at high
  fps compress better, so 60fps proxies land ~√2× the v6 size (~7 Mbps @ 720p60), not 2×.
- `SOURCE_PROXY_VERSION` 6 → 7: one-time rebuild (with the v17 % notice) to catch every >30fps
  proxy encoded at half rate.

**Verify (user):** reload → rebuild notice runs once; then play a 60fps clip at ½ quality — motion
should feel identical to full quality, only softer. If ½ STILL feels low-fps on a 24/30fps source,
that's a different bug (render loop, not proxy cadence) — read the debug HUD's Frame ms while it
happens and start from there; do NOT bump PROXY_FPS further.

## v19 — Play start: runs ~300–500ms, then jumps back and replays from the start (2026-07-21)

**Report:** pressing play sometimes shows ~a second of black, and/or plays 300–500ms then the
playhead yanks back to the start and replays. Third occurrence of the "playhead jumps backward at
play start" lineage (2026-07-03 ×2 → distance gate + advancement gate + live-time reader).

**Root cause:** a crack BETWEEN the two prior fixes' thresholds. The audio-master authority gate
(`AUDIO_MASTER_GATE_S = 0.5`) admits any element whose mapped time is within 0.5s of the live
playhead; the anchor servo hard-resyncs when |drift| > `HARD_RESYNC_S = 0.25`. A cold-starting
audio element with a play() startup latency in (0.25s, 0.5s) — i.e. exactly 300–500ms — passes the
advancement gate the moment its currentTime first moves, passes the wide authority gate, gets
elected master reporting time ~its latency BEHIND the clock, and the hard resync yanks the shared
anchor backward by that amount. Every derived consumer (playhead, video elements via the jump/drift
correctors) replays. The forced seeks flush video decoders → the black flash.

**Fix (VideoPreview.tsx audio-clock reader):** first election uses the NARROW servo-zone gate — a
per-registration `wasAuthoritative` flag; until it has been authoritative once the reader returns
null unless |mapped − live| ≤ `HARD_RESYNC_S`. In the crack the element stays non-master, the 500ms
non-master corrector seeks it FORWARD onto the wall clock, and it then becomes master smoothly
(this was always the documented intent of the gate). Established masters keep the wide gate so
genuine mid-play stalls still hard-resync.

**Verify:** typecheck; user re-test — watch `window.__rfAudioClock.driftMs` / HUD A/V drift at play
start: it must never report a negative drift > 250ms in the first second. Kill switch unchanged:
`?audioClock=0`.

## v20 — Pre-roll anchor: residual ~50–80ms catch-up at play start (2026-07-21)

**Report (after v19):** the 300–500ms replay is gone, but a smaller ~50–80ms "pulls back / catches
up" remains right at play start (a startup latency INSIDE the servo zone now converges via the
4ms/tick servo — a brief visibly-slow playhead).

**Fix (pro-NLE pre-roll, EditorPage tick + audio-clock.ts):** until the FIRST master election the
tick HOLDS the playhead at its start position (slides the anchor each frame — no time accrues),
then anchors EXACTLY to the master's first report: the startup latency is swallowed before the
playhead ever moves, so there is nothing to servo/catch up. Guards: no candidate sources (silent
region — readers only exist for audio clips under the playhead) → immediate wall-clock start, no
added latency; `AUDIO_PREROLL_MAX_MS = 350` cap → a stalled element can only delay start by that
much; a master electing LATER (first audible clip mid-timeline) enters through the normal servo,
never an anchor jump. Kill switch unchanged (`?audioClock=0`).

**Still open:** user reports a brief BLACK FLICKER at play start. Not yet root-caused (proxy
overlay reveal is guarded, src does not flip on play, GL layer holds last frame). If it persists
after v20, capture whether it coincides with a playhead jump and what the HUD Frame ms / A/V drift
rows show in the first second.

### v20 addendum — black-flicker forensics (2026-07-21)

Flicker persists after v19+v20 (start of playback only; mid-play/pause clean). Static analysis
cleared the proxy overlay, src flips, and the settle-frame drop (single-ctx holds the last graded
frame on transient nulls). Remaining candidate paths that can composite a HOLE are now counted in
`window.__rfMediaHoles` (ScenePreviewCanvas): "escape-hatch" (NOT_READY_HOLD_MS=300 expired while
playing — composited with the hole), "no-frame" (snapshot null with nothing held), "no-descriptor"
(media layer had no registered frame source). Repro once, read the object, and the moved counter
fingers the mechanism. Prime suspect: escape-hatch (play-start source warmup > 300ms → bounded
black by design — fix would be a longer/adaptive hold once confirmed).

## v21 — Black flicker at play start ROOT-CAUSED + fixed (2026-07-21)

**Evidence (the v20 forensics did their job):** after one repro `window.__rfMediaHoles` read
`{ "no-frame": 2 }` with "escape-hatch" at zero. Translation: exactly 1–2 composites hit a media
layer whose single-ctx snapshot had NO frame and NO previously-graded texture to hold — and those
composites PRESENTED the hole instead of engaging the R1 present-hold, because the hold was
playing-gated and they ran at the play flip before/while the playing flag propagated (paused
composites were exempt by design). The source landed within ~2 frames (hence no escape-hatch),
so the visible artifact is a 1–2 frame black hole: the reported play-start flicker.

**Fix (ScenePreviewCanvas):** the not-ready present-hold now also engages while PAUSED when the
not-ready layer is MEDIA (video/image). Text/shape keep the paused exemption (R1 scrub-lag
rationale: a pending text raster mid-typing must not freeze the viewer). Media not-ready while
paused is only ever the first-frame or source-handoff case, where holding the last picture is
exactly right. The escape hatch (NOT_READY_HOLD_MS = 300, untouched) still bounds a genuinely
broken source; it now records __rfMediaHoles "escape-hatch" whenever it composites a real hole.

**Verify:** user re-test play start — no black; `__rfMediaHoles` may still count "no-frame" (the
counter sits at the snapshot, before the hold) but nothing black should PRESENT. If a flicker
somehow remains, "escape-hatch" moving is now the discriminator.

## v22 — Flicker round 3: descriptor-gap dispose + media-length hold (2026-07-21)

**Evidence (second __rfMediaHoles trace, v21 in place):** one play-start flicker produced
`{ no-descriptor: 4, no-frame: 2, escape-hatch: 3 }`. Chain: the PROXY-ARRIVAL REMOUNT (mediaUrl
original→proxyUrl flips the layer key seconds after project load) unregisters the scene-media
descriptor before the new mount registers its own → composites in the gap saw "no-descriptor" →
the dispose-on-unconsumed prune DESTROYED the held graded texture on the first gap composite →
follow-up composites had nothing to hold ("no-frame") → the 300ms hold expired while the new
element was still decoding → 3 "escape-hatch" composites presented the hole = the visible black.

**Fix (ScenePreviewCanvas):**
1. Descriptor gap: `getMediaSingleCtx` now serves the LAST-GRADED texture (and keeps its renderer
   alive) when the descriptor is missing but a held frame exists — the remount gap composites the
   previous frame instead of a hole.
2. `NOT_READY_HOLD_MEDIA_MS = 1500` (text/shape keep 300): a truly cold media source freezes the
   last picture up to 1.5s — never black — before the escape hatch may composite the hole.

Also added this round: `__rfPlayStartLuma` presented-pixel probe (16×16 center readback for 1.5s
after each play start; { samples, min, minAtMs, dark }) — objective confirmation that nothing
black PRESENTS; remove the probe + __rfMediaHoles counters once the fix is user-confirmed.

## v23 — Adjustment-layer masks ignored (color baked full-frame; export never stamped) (2026-07-21)

**Report:** drawing a mask on an adjustment layer did nothing — the adjustment's effects (curves/
color, blur) kept applying to the WHOLE frame below instead of being confined to the mask region.

**Root cause (two independent gaps):**
1. `getCompositionColorPipeline` (shared composition-style.ts) had NO masked-skip rule. Its siblings
   `getEffectCss`/`getCompositionFilterEffects` skip effects carrying renderable region masks (those
   render via region clones/passes), but the COLOR pipeline baked them anyway. In the clone model this
   never surfaced (expansion strips masks upstream), but adjustment-merged effects
   (`effectsWithLayerRegionMask` → `applyActiveAdjustmentEffects`) join AFTER `expandEffectRegionMasks`
   runs, so their stamped masks reached the grade bake — and the whole frame got graded. The scene
   builder's draw-time expansion (`buildLayerDrawWithPasses`) built the correct masked region passes,
   but they applied ON TOP of the already-fully-graded media canvas → mask visually ignored.
2. Local export (`scene-frame-compositor.ts` `mergedLayer`) merged raw `a.layer.effects` without
   `effectsWithLayerRegionMask` — the adjustment's mask never even stamped in export (preview and
   worker SceneStage both stamped; export was the odd one out).

**Fix:** (1) masked-skip added to `getCompositionColorPipeline`'s effect loop — one shared point, so
preview grade (WebglMediaLayer), export grade, worker grade, and the SVG filter path
(`getCompositionColorFilter` wraps the same pipeline) all stop baking region-masked color at once;
the scene region passes are then the only application, correctly matte-clipped. (2) export
`mergedLayer` now stamps via `effectsWithLayerRegionMask`, matching preview + SceneStage.

**Semantics note:** an "Add" mask = effect INSIDE the shape; for a "hole" (effect everywhere EXCEPT
the shape) use the mask's Invert. A lone Subtract mask acts as Add (first matte layer composites
source-over by design, same as clip masks). Glow/stylize/fragment effects on adjustment layers still
apply full-frame (region-eligible = color + blur), unchanged documented limitation.

**Verify:** scratch repro through the exact preview pipeline (expand → merge → buildSceneDraws,
regionPassModel on): grade-bake pipeline now null, region passes carry masked blur + color pipeline.
color.test.ts, editor.test.ts, typecheck all green; render:compare:pixels run for parity.

## v23 — v20 pre-roll REVERTED (it caused the yank + black frame); forward-only start sync (2026-07-21)

**Evidence (luma trace):** presented ring showed bright → ONE ~black frame (luma 8) ~230ms after
play-from-0 → bright; media ring showed no fresh grade at that instant (held texture serving); and
the user-visible regression "plays ~300ms, jumps backward, replays" returned WITH v20 active.

**Root cause — the v20 pre-roll was self-defeating:** while the anchor held waiting for the audio
master, the VIDEO elements kept free-running; after anchoring, the picture sat up to ~350ms AHEAD
of the clock, the video drift corrector seeked it BACKWARD (picture jump-back + replay), and the
seek flushed the decoder (the black frame). It recreated both original symptoms.

**New design (nothing moves backward at play start, ever):**
- Pre-roll hold removed from the EditorPage tick (back to the v19 wall-clock start + servo shape).
- `AUDIO_FIRST_ELECTION_GATE_S = 0.06` (~2 frames): an element only ELECTS master once nearly
  aligned — real startup latency keeps it non-master (v19 used the 0.25 servo zone here, which let
  a ≤250ms latency elect and drag the playhead into the ~50–80ms catch-up).
- Session-tightened non-master audio corrector (VideoPreview): first ~2s of a session corrects at
  `AUDIO_SESSION_START_TOLERANCE_S = 0.05` with an extra first check at 250ms — the late element
  is seeked FORWARD onto the clock, then elects with negligible drift. Steady state stays 0.15 /
  500ms (no seek storms). Video corrector untouched.

**Verify:** Home+Space repro — playhead monotonic, no picture jump-back, and the presented-luma
ring (`__rfPlayStart.presented`) should show NO ~luma-8 dip. Probes stay in until confirmed.

## v24 — ROOT CAUSES: span-capture races live playback; cold-start servo direction (2026-07-21)

**Bug 1 (play-start black frames) — the background viewer-capture proxy generator.** It renders
span frames through the SAME SceneCompositor instance as the on-screen preview and only runs while
paused — but its abort on play was fire-and-forget (an effect, one commit late), so an in-flight
capture frame kept going after play began: it seeked pooled <video> elements to span times AND
called renderFrameOffscreen → renderFrameCore → ensureSize, which RESIZES THE VISIBLE CANVAS
(canvas.width = … clears it to black) whenever the capture size (paused scale 1) differs from the
playing size (renderScale 0.5/0.25). Head spans are pending right after load and playhead-at-0
priority makes them the ones being captured → the flash concentrated at the timeline start.
renderFrameOffscreen's own doc comment promised "the on-screen canvas keeps its last presented
image untouched" — the race violated it.

Fixes (four independent layers):
1. Gesture-time abort: `startEnginePlayback()` aborts `proxyGenAbortRef` BEFORE `setIsPlaying(true)`
   (togglePlayback, L-key start, transport "play").
2. viewerProxyCapture: `throwIfAborted` immediately before every element seek and before
   `capture.renderOffscreen`.
3. ScenePreviewCanvas.renderOffscreen: returns null while `isPlaying` — playback owns the compositor.
4. scene-compositor.renderFrameOffscreen: refuses specs whose size ≠ current size (an offscreen
   path may NEVER resize/clear the visible canvas). Export/Remotion untouched (they don't call it).

**Bug 2 (playhead moves backward right as play starts).** With the v23 first-election gate
(≤60ms), a master electing slightly behind made the anchor servo drag the playhead BACKWARD
~4ms/tick for ~15 frames — a visible backward crawl before the picture got moving. Fix: the servo
is FORWARD-ONLY for the first AUDIO_SESSION_START_WINDOW_MS (2s) of a session; negative drift is
ignored (the session-tight audio corrector seeks the element forward instead; residual ≤60ms
converges via the servo after the window). Steady-state behavior unchanged.

**Forensics in tree (remove after user confirms):** __rfMediaHoles, __rfPlayStart (presented +
media luma rings), __rfClockJumps (backward committed-clock moves), __rfHardResyncs,
__rfVideoSeeks (backward seeks on playing video elements, tagged sync/jump/drift).

**Verify:** Home+Space ×3 → no black, no backward playhead; __rfClockJumps empty during plays;
__rfPlayStart.presented has no dip <16; __rfVideoSeeks empty at start; coverage-bar live trail
continuous. Paused ~15s → pending spans still seal (capture unaffected when idle).

## v24 — Adjustment-layer mask: fragment effects (radial blur etc.) leaked past the mask (2026-07-21)

**Report (follow-up to v23):** Radial Blur on a masked adjustment clip applied full-frame below —
the ellipse mask ignored. Same for any fragment-pass effect (directional blur, pixelate, sharpen,
chromatic aberration, sketch/oldTv/glitch/halftone/posterize/stylize, custom shaders).

**Root cause:** `effectsWithLayerRegionMask` only stamped the adjustment's masks onto
region-ELIGIBLE effects (color + gaussian blur). Fragment effects rode along unstamped →
`buildFragmentPasses` built an UNMASKED pass on the merged layer below. The harness itself already
supports per-effect masks natively (it builds its own matte from `effect.masks`) — only the stamp
was missing. Bonus latent bug: `expandLayerEffectRegions`' global-effect `strip()` removed masks
from EVERY non-region effect, so a directly-masked fragment effect lost its mask whenever the same
layer also carried a region color effect.

**Fix (all in shared/clip-masks.ts):** canonical `FRAGMENT_PASS_EFFECT_TYPES` set +
`isFragmentPassEffectType` (pluginShader included) now live in clip-masks; build-scene-draws
imports it (was a private duplicate list). `effectsWithLayerRegionMask` stamps masks onto
region-eligible OR fragment-pass effects; `strip()` preserves masks on fragment-pass effects.
Glow remains the only unmaskable adjustment effect (outward bloom would be clipped — deferred).

**Verify:** repro (expand → merge → buildSceneDraws, pass model): merged radialBlur carries the
mask and emits `fragmentPasses: [{ key: adj_radial, hasMask: true }]`; typecheck ×3, color +
editor tests green; render:compare:pixels 41/41 passed post-change with diffs identical to the pre-change baseline run.

## v25 — CAUGHT RED-HANDED: the servo itself was the backward writer; clock is now forward-only (2026-07-21)

**Evidence:** __rfClockJumps with stack capture. Every pathological write came from the playback
tick: `{from:0, to:-0.158}` at play-from-0 (NEGATIVE committed time), and mid-play rewinds of
150–450ms every ~2s (`2.876→2.721`, `3.931→3.777`, `6.026→5.581`). The user's asset streams from
a REMOTE Pexels URL on a slow link (their console showed a thumbnail decode timeout on the same
URL) — the audio element repeatedly stalls BEHIND the clock, and the servo/hard-resync responded
by dragging the whole timeline backward to match. Elements' mapped time can also be NEGATIVE
(ct < sourceIn), which the anchor happily adopted.

**Fix (structural, three layers):**
1. Reader behind-demotion (VideoPreview audio-clock reader): a master that falls > 0.15s BEHIND
   the live playhead loses authority (returns null); the non-master corrector seeks IT forward and
   it re-elects aligned. Ahead-drift keeps the wide 0.5 gate.
2. Tick servo is FORWARD-ONLY (EditorPage): hard resync only for drift > +HARD_RESYNC_S (audio
   genuinely ahead = clock stalled); negative drift is bounded by the ±4ms/tick servo — the
   timeline can never visibly rewind because audio hiccuped. (Replaces the v24 2s-window guard.)
3. Absolute floor: the tick clamps nextTime to ≥ 0 — a negative committed clock (observed) can
   corrupt downstream source lookups and is now impossible.

**Note:** slow/remote media now degrades as it should — audio skips forward to stay with the
picture instead of the picture rewinding. Local-first imports (the product default) never hit this.

**Verify:** fresh-bundle check (`__rfVideoSeeks` prints [] not undefined), then Home+Space and
long plays: __rfClockJumps must gain NO tick-stack entries (scrub entries are user-initiated and
fine); no black frames; no backward playhead. Probes removed once confirmed.

## v26 — Found it: TimelineStrip's playhead DOM writer, not the clock (2026-07-21)

**Evidence:** user reported the visible backward step (~80–100ms) survives v25 on EVERY play press
despite `__rfClockJumps` no longer showing pathological tick entries for it — meaning the COMMITTED
clock was fine and the regression was in an imperative DOM writer that doesn't go through
`setPlaybackClock` at all.

**Root cause:** `TimelineStrip.tsx`'s playback-follow effect (~line 1402) initializes the playhead
element's `--playhead-percent` CSS var to `playbackStart.timeSeconds` — the anchor's ORIGIN — on
mount, then starts its own rAF (`animate`) that computes the true elapsed-time position. But this
effect is a REACT EFFECT: it commits ~1-2 frames (up to ~100ms) after `setIsPlaying(true)`, by
which point the paused playhead writer and the hot preview clock have already advanced the visible
needle forward via the session's first clock commits. Snapping to the stale origin on mount
therefore visibly stepped the needle BACKWARD, and the very next rAF (`animate`) immediately
caught it back up to the correct position — "moves back a little then moves forward, every play".

**Fix:** initialize to the anchor-DERIVED current time (`playbackStart.timeSeconds + elapsed`),
not the anchor's origin — the same math `animate`'s first frame would produce, just computed
synchronously at mount so there is no backward step to begin with.

**Also added:** `notePlaybackClockContext` — the tick now publishes its internals (anchor, elapsed,
audio master state, drift) each iteration; any recorded `__rfClockJumps` entry carries a `ctx`
field with the exact arithmetic that produced it, no more guessing from bare before/after numbers.

**Verify:** Home+Space repeatedly — no visible playhead step-back at any play press. `__rfClockJumps`
should show no tick-context entries with negative `to` deltas that aren't a genuine audio-ahead
hard resync (check `ctx` if any appear).

### v26.1 — Residual ~20ms needle step (2026-07-21)

The v26 init fix left a ~20ms backward step: the first `animate` rAF timestamp can be up to one
frame EARLIER than the mount-time `performance.now()` used for the initial needle write (rAF
timestamps are vsync times, not call times), and the forward-only servo may still nudge the anchor
back ≤4ms/tick. Fix: the needle is now MONOTONIC within one anchor lifetime (`monotonicFloor` in
the TimelineStrip playback-follow loop, seeded by the initial write). A backward mid-play seek
replaces the anchor and re-runs the effect, resetting the floor — user seeks unaffected.

## v27 — Live-coverage trail artifacts: bridged marks + pause settle (2026-07-21)

**Report:** two visible artifacts in the ruler coverage strip: (1) hairline orange slivers INSIDE
the blue "watched live" trail, (2) the trail head stops a beat short of the parked playhead.

**Root cause (one mechanism, two symptoms):** `markFrameRendered` stamped each rendered frame as a
single 1/fps-wide island, but frame notifications arrive at the CLOCK-COMMIT cadence (16/40/90ms
by quality tier) — so the marks were 33ms islands spaced up to 90ms apart. The un-marked cracks
between islands rendered as orange slivers, and the final island (plus the playing-gated
notification — the paused settle composite never marks) left the head short of the playhead.

**Fix (EditorPage):** BRIDGED marking — each notification marks [previousMark, t + 1/fps]; every
moment between two consecutive rendered frames was visually covered by the earlier frame, so the
bridge is truthful coverage, not decoration (backward or >0.5s jumps = seek → no bridge). And
`bridgeLiveMarkTo(stopped)` on both stop paths (pause + end-of-playback) extends the trail to the
exact settle position — the settle composite has that frame on screen.

## v28 — Playback saga CLOSED; all forensic probes removed (2026-07-21)

User confirmed every playback-start symptom fixed (black frames, backward playhead, coverage-trail
artifacts). Removed the full probe set in one pass, keeping every fix: __rfClockJumps + stack/ctx
capture + notePlaybackClockContext (playback-clock.ts), __rfHardResyncs ring (EditorPage tick),
__rfVideoSeeks recorder (VideoPreview), __rfMediaHoles counters + __rfPlayStart luma probes
(ScenePreviewCanvas). Fixes retained: v19 narrow first-election gate, v21/v22 media present-holds +
held-texture serves, v23/v25 behind-demotion + forward-only servo + non-negative clock, v24
capture-race fences (gesture abort, seek guards, renderOffscreen playing/size guards), v26/v26.1
needle init + monotonic floor, v27 bridged live marks.

## v29 — Flarex multi-source freeze: a memo froze the layer CLOCK, not the decoder (2026-07-26)

**Report (recurring, 2 sessions / 4 shipped fixes):** in a Flarex comp with a host clip + asset-source
`MediaIn`s, the host plays smoothly but every asset-source loader freezes. Originally read as an
fps ceiling (60fps froze, 30fps didn't), then as WebCodecs session contention. Neither was it: the
SAME 30fps asset plays fine as the host and freezes as a virtual loader.

**Why 4 fixes missed it (methodology).** Every measurement used GLOBAL counters — `__rfWcPool`,
`__rfWcHeals`, `__rfWcDecoder` — which cannot attribute behavior to one frozen source. The reading
`{hardReset:7, forwardSkip:5}` over 634 frames was taken as proof the decoder was starved; it is
actually the *signature of the real bug* (see below). Each round then changed enough to invalidate
the previous measurement. The per-source signal that would have named it in one run already existed:
`frameProfiler.noteMediaSource` → `?flarexProfile=1` Media section (`media STALLED: <id>`).

**Root cause — `arePreviewLayerPropsEqual` (VideoPreview.tsx), Playback Jank Patch 1.** The memo
skips the `currentTime` compare when `isPlaying && !selected && hideVisual`. Its doc comment says
"Media is deliberately NOT skipped", but the guard only tested `hideVisual` — never the layer type.
Timeline layers get `hideVisual` only for text/shape (`sceneOverlayIds`), so the host was exempt by
accident; Flarex Phase 2 virtual loaders pass a BARE `hideVisual`, opting VIDEO layers into it. Their
other props are identity-stable during playback (`useStableList`, the same jank patch), so nothing
else busts the memo → the loader's `PreviewLayer` never re-renders while playing → its `currentTime`
prop is pinned at the last pre-play render.

`requestWcFrame` then rides `getLivePlaybackTime()` only while it agrees with that prop within
`WC_LIVE_CLOCK_MAX_DIVERGENCE_S` (0.35s). Past that the live clock is REJECTED and the stale prop is
used → one constant `sourceTime` forever → the same frame decodes forever.

**Why it was invisible to every self-heal:** `lastFrameLagSeconds = max(0, requested − served)`, and
the decoder serves exactly the frozen request ⇒ lag ≈ 0. No catch-up hold, no `WC_DIVERGE`/sustained
bail, no `busyWedge` (decode is instant), no `nullFrames`, no `__rfLiveFreeze` entry (watchdog
`behind` IS that lag), and a constant time crosses no GOP ⇒ no `resetTo` — hence the flat reset
counters that were misread as starvation. It also explains "played once then froze forever" (≈0.35s
of motion) and "on pause it catches up at higher quality" (pause ⇒ memo compares time again ⇒
re-render + full-res settle).

**Fix:** `canIgnoreTime` additionally requires `layer.type !== "video" && !== "image"` — the type
test, not `hideVisual`, is what keeps media out. Text/shape overlays keep the jank patch.

**Hardening shipped with it:**
- `recordWcStaleTime(src)` → `window.__rfWcStaleTime` counts live-clock REJECTIONS per source. The
  guard's behavior is unchanged (rejecting a foreign playhead is correct on tool pages/fixtures);
  this only makes a stale-clock freeze a one-console-read diagnosis instead of a two-session hunt.
- `wcBailedSources` is module-global and keyed by media URL, so a host clip's bail poisoned any
  virtual loader on the same asset (comps routinely load one file as both host and MediaIn source) and
  sent it to a native `<video>` → the ~16-context cap → permanent freeze. `tolerateLag` layers now
  ignore the bail list.

**Kept, unproven:** `tolerateLag` + the `busyWedge`/`nullFrames` native-bail guards (independently
justified — comp sources must never take a native element). `preferSoftwareDecode` for virtual loaders
was shipped on the disproved contention theory and costs a CPU H.264 decode each; re-evaluate against
the profiler now that the real cause is out.

**Rule:** a freeze whose lag reads ~0 is a CLOCK bug, not a decode bug. Check whether the layer's
`currentTime` prop is still advancing before touching the decoder.

---

## v30 — 2026-07-27: the HOST froze and the loaders played (the exact inverse of v29)

**Symptom (user):** "now the host dont play rest play.. host even dont update when paused."

**Why the "even when paused" clause is the whole diagnosis.** A stalled *clock* (v29) still updates on
scrub, because pausing re-enables the memo's time compare. A source that does not update while PAUSED
is not lagging — its decode is dead. That single word ruled out the entire v29 class on sight and sent
this straight at the decoder pool instead of costing another four rounds.

**Root cause — mode-blind warm reuse in `preview-frame-pool.ts`.** Parked providers were matched by URL
alone:

```ts
const idleIndex = idle.findIndex((entry) => entry.url === url);   // ← no decode mode
```

A Flarex comp routinely loads ONE file as both the host clip and a MediaIn source. The loader creates a
**software** decoder for that URL (`preferSoftware`, v29's contention fix), parks it on release, and the
**host** — same URL — warm-reused it. The host is lag-INtolerant by design, so a software decode of a
full-res source blew past `WC_HOLD_LAG_S` → freeze-hold → sustained-hold bail → `wcBailedSources` →
native `<video>` for the rest of the session. The mirror leak is just as bad: a loader inheriting the
host's hardware provider lands back on the contended block `preferSoftware` exists to avoid.

**Second, structural cause — software sessions charged to the hardware cap.** `MAX_WC_SESSIONS = 3` is
documented as "≈ the hardware decode sessions an integrated GPU has", but software decoders run on CPU
threads and occupy none of them. A host + 2 loaders filled all 3 slots, so whichever source acquired
last was refused and fell to a native element. Loaders are immune to that fallback (`tolerateLag`,
never freeze-hold, never bail), so **the loser was structurally guaranteed to be the host.** v29 made
the loaders unstarvable without giving the host any protection at all.

**Fix:**
- Warm reuse matches `(url, software)`. Lifted to an exported pure `findWarmIdleIndex` so it is testable
  — a mode-mismatched reuse is otherwise invisible: it counts as a healthy cache HIT.
- Hardware and software sessions get separate counts, caps (`MAX_WC_SESSIONS` 3 / `MAX_WC_SOFTWARE_SESSIONS`
  4), idle pools, eviction and preemption victims. No number of loaders can now refuse the host a slot.
- `window.__rfWcMode` — per source, which path it ACTUALLY took (`wc-hw` / `wc-sw` / `element`). Both
  multi-source freezes were mis-diagnosed for rounds because this was unanswerable from the console.
- `__rfWcPool` gained `activeSoftware`; `capMisses` is now read against the mode that ran out.

**Gate:** `pnpm --filter @orreris/web wcpool:test` — 22 assertions, mutation-verified (reverting the
predicate to a URL-only match fails exactly the 3 mode-mismatch assertions and nothing else).

**Rule (generalises v29's):** when a fix makes one class of source unstarvable, ask which source is now
guaranteed to lose. Immunity is not free — it is redistributed. Both of these freezes were one side of a
contention model where only the other side had an escape hatch.

### v30a — same day: the mode split silently raised the ceiling 3 → 7

**Symptom (user):** the loaders DID come back ("initially it was showing multiple mediain in the
previewer"), then rigorous scrubbing on the edit page turned the whole browser window **white**, after
which no asset-source MediaIn appeared at all — only the host clip, everywhere.

**Cause — my own fix.** Splitting hardware/software into two independent caps (3 and 4) fixed the
starvation but raised total concurrency to **seven** live decoders. Each pins a decoder plus a GOP
window of encoded samples; scrubbing makes all of them reset and re-buffer at once. The renderer died
(white page), and once the GPU process is gone the loaders can never re-acquire a provider — so
`resolveSourceDraw` returns null and every MediaIn takes its documented soft-degrade to the host. That
is why the failure LOOKED like the original bug returning.

**Fix:** the real resource is total sessions, so that is what is capped. `MAX_WC_TOTAL_SESSIONS = 4`
across both modes, plus `HARDWARE_RESERVED_SLOTS = 1` that software leases may never occupy — the
reservation, not a bigger software pool, is what actually guarantees the host a slot. Admission is now
one `reserveSession(software, priority)` that enforces the mode ceiling AND the total, freeing idle
parks (other mode first — this mode's parks may still be warm-reused) then preempting preload shells.
`parkOrDispose` enforces the total too, since a lease released mid-init stops counting as active
immediately but still parks a real decoder when its init resolves.

**Rule:** two caps that merely SUM are not a budget. When splitting a shared limit, the aggregate is the
invariant to assert — `wcpool:test` now asserts exactly that (`sessionCap(false) + sessionCap(true) >
MAX_TOTAL`, i.e. the per-mode caps oversubscribe on their own, so the total is what bounds concurrency).

### 2026-07-27 — cloud export: local↔cloud asset resolution is not coordinated (OPEN)

Three defects found while chasing "cloud export does nothing". Two fixed, two structural ones open.

**Fixed.** (1) `collectAssetIds` (lib/sync.ts) walked only `composition.tracks`, so Flarex asset-source
`MediaIn` assets were never uploaded and never remapped local→server — the worker then 404'd on a local
id. Canonical `collectFlarexSourceAssetIds` / `remapFlarexSourceAssetIds` now live in
`packages/shared/flarex/virtual-layers.ts`; export-core's private duplicate re-exports them (two
definitions silently disagreeing is how it shipped). Confirmed by china_view appearing in the worker's
manifest list. (2) The worker presigned R2 DIRECTLY and had no read-through fallback, unlike the API's
`/storage` route — so a legacy pre-R2 key (`uploads/<file>`, flat, local-disk only) was a hard 404 that
failed the whole export. It now retries via the API URL and reports both causes.

**OPEN — the real issue.** `manifest.assets` is built from EVERY project asset
(`render-templates/src/index.ts:537`), not the ones the render actually references. A 3-asset project
localized **19** assets: a dozen orphaned `mask_browser_*.webm` tool artifacts plus unrelated library
media, each downloaded in full before frame 1. Consequences: every cloud export pays minutes of
unnecessary transfer, and ANY stale/broken library asset fails an export that does not use it. The media
pool is a LIBRARY; the manifest treats it as the render input set. These need separating — the manifest
should carry only assets reachable from the composition + its Flarex comps (the collectors above already
compute exactly that set).

**Also open:** THREE coexisting storage key conventions (`uploads/<file>` flat = local disk only;
`uploads/u_<user>/…` = R2; `u_<user>/video/…` = R2 current). The R2 migration moved the newer two and
left the flat ones behind, so local and cloud disagree about where an old asset lives. The worker
fallback masks this; it does not resolve it. A migration or a canonical resolver is the real fix.

**Open (correctness):** Remotion still has no asset-source `MediaIn` support — `SceneStage` passes
`flarexComps` but never `flarexVirtualLayers`, so a cloud render draws the HOST clip where the preview
and local export draw the real source. Design is settled and needs no manifest change: `manifest.assets`
already carries id → fileUrl/fileType/durationSeconds, so SceneStage can build the loaders with the
shared `collectFlarexVirtualLayers`, mount a VideoGrabber/ImageGrabber per active loader (keyed by the
virtual id), grade them like any clip, and pass `flarexVirtualLayers` + their graded frames into
`buildSceneDraws`. This is the last thing making cloud export render a DIFFERENT PICTURE than preview.

### v31 (2026-07-27) — fast scrub froze the editor: the decode time-box was off exactly when it was needed

**Symptom (user):** scrubbing fast froze the page for 3–4s, sometimes long enough for Chrome's
"page isn't responding" dialog. Self-recovered. Predates Flarex — Flarex only makes it easier to hit
(a comp puts several sources through the same path and adds compile cost per frame).

**Ruled out first**, all already solved and worth not re-litigating: React re-render storm (clock
notifies React subscribers once per rAF, and the timeline playhead is imperative — zero renders per
seek); unbounded in-flight requests (one `getFrame` per layer, latest-wins); decoder over-concurrency
(that was v30a's white page, capped since at `MAX_WC_TOTAL_SESSIONS`).

**Cause 1 — the budget's own precondition.** `getFrame`'s catch-up loop breaks on `frameBudgetMs`,
but only `if (current || queue.length)` — "never applied while there is nothing to show". `resetTo()`
closes `current` and empties the queue, so **immediately after a seek the guard is false and the loop
is unbounded**. A fast scrub calls `resetTo` on nearly every tick in BOTH directions (backward jump;
forward past the current GOP), so the budget was off for the entire gesture. The loop yields per round
via MessageChannel, so it is not one long task — it is an unbounded chain of yield-tasks, which starves
input and paint just as effectively. Worst case is in the decoder's own comment: a rewind on a
sparse-keyframe source (4 keys / 935 frames) re-decodes hundreds of chunks. The shuttle cache that
would absorb it arms only after **two consecutive** backward jumps, and erratic scrubbing — the actual
gesture — never builds it.

**Cause 2 — a zero-delay retry (self-inflicted, same day, commit 4d58fe1).** The `tolerateLag`
stale-bail set `wcRerequestRef`, which the SAME `.then()` consumes ~90 lines later and acts on
synchronously. That is a recursion, not a retry: paused, on a source that cannot converge, it spins.
The null branch had the same shape at a flat 150ms forever.

**Fix.** `resetTo` retires `current` to `staleHold` instead of closing it, and `staleHold` counts as
"something to show" — the seek returns the previous frame with its real lag and the next call continues
the catch-up. That is the contract `getFrame` already documented for the mid-GOP case; it simply could
not reach it after a reset. `staleHold` is served ONLY on budget expiry, so warmup bail / drain-flush /
decode failure still return null and the null-count → `<video>` escape is unchanged. Retries go through
`scheduleTolerantRetry()` — 100ms doubling to a 1s ceiling, reset when a frame presents.

**Export is unaffected by construction:** `staleHold` is populated only when `frameBudgetMs` is set,
and `preview-frame-pool.ts` is its only caller. Export blocks until decoded and must return null on
failure so the caller can fall back — handing it a pre-seek frame would silently render the wrong
picture, so it keeps closing.

**Rule:** a resource guard whose PRECONDITION is destroyed by the very event it guards against is not a
guard. `(current || queue.length)` read as "don't return nothing" but functioned as "switch off on every
seek". When a budget has an eligibility condition, ask which code path clears that condition — the
answer is usually the exact path that needs the budget most.

**Status:** committed, typecheck clean, wcpool:test 22/22. NOT yet browser-verified — `getFrame` needs a
real `VideoDecoder`, so there is no automated gate. Confirm by scrubbing with `__rfWcDecoder` open:
`hardReset` should still climb with scrub speed, the stall should not. If it does not improve, next
suspects are the per-reset `decoder.reset()`+`configure()` IPC cost and the shuttle cache's
two-consecutive-jumps arming condition.

## v31 — 2026-07-28: a Flarex comp's sources "filled in" one at a time (temporal coherence)
**Problem:** On a low-end machine, a Flarex comp with three `MediaIn` loaders visibly updated one
source at a time — media 1, then ~200ms later media 2, then ~200–300ms later media 3. Reported as a
scheduling problem: "can we update all in a single go, like the timeline's scene compositor?"

**What the diagnosis was NOT.** The proposed cause — nodes presenting independently, no frame
barrier — was already false. A decoded frame never draws: `publishSceneFrame()` → `onFrame()` →
`requestDraw()` only sets a dirty timestamp, and one persistent rAF loop does a single
`buildSceneDraws` → `compileFlarexComp` → `renderFrame` → `presentFrame()`. The present is atomic and
a hold gate already existed. Three rounds of "there is a barrier" vs "I can SEE them stagger" were
both correct, because they were about different properties.

**Root cause — presentation BATCHING is not temporal SYNCHRONIZATION.** The barrier's readiness
predicate was existence-only: `!mediaSource || width === 0 || height === 0` (`build-scene-draws.ts`,
the only two `onLayerNotReady` sites). And `gradeMediaInContext` deliberately HOLDS a source's last
graded texture when its frame hasn't landed — the 2026-07-07 black-flicker fix, still correct. So a
source that had decoded ONCE was "ready" forever however stale, and the gate could never fire on
staleness. `ScenePreviewMediaSnapshot` carried `frameVersion` (a counter) and **no time at all**; the
real PTS existed one layer down (`webcodecs-decoder.ts` reduces it to `lastServedLagSeconds`) and was
never forwarded. A property that is never checked is not guaranteed: the composite mixed source A at
t with source B at t−0.2, which is not a real frame of the comp.

**Fix.** Snapshots now carry `stalenessSeconds` — how far the held frame is from the one the live
playhead asks for, in TIMELINE seconds. Stale sources join the existing hold gate, which withholds
the whole present. Pure decision logic lives in `playback/temporal-coherence.ts` (framework-free, so
it can move to the evaluation engine when ADR-008 scheduling lands, rather than being reimplemented).

**Scoped to paused/scrubbing.** The transport clock is wall-clock servoed to audio and advances
regardless of render completion, so under playback the target keeps MOVING while you wait for the
slowest source — a strict barrier there starves rather than synchronizes. Coherent playback means
gating the transport, a separate decision about the playback model. Playing stays byte-identical:
`tolerateLag` keeps owning it.

**Two traps, both found by the gate rather than by review:**

1. **The tolerance was measuring frame rate, not staleness.** `getFrame` serves the frame whose
   interval CONTAINS the request (`consumeDecodedUpTo` walks to the last sample with
   `timestamp <= requested`), so raw lag is uniformly [0, framePeriod) — 0…41.7ms on 24fps — even on
   perfect delivery. The first tolerance (half a frame at 24fps) would have marked correct 24fps media
   stale about half the time: holding constantly, falling through the escape hatch on every scrub,
   adding latency while fixing nothing. Staleness now subtracts one source frame period, so 0 means
   "showing the correct frame" at any rate and sources of different rates are comparable — which
   matters because a comp routinely mixes 24/30/60fps. Needed `nominalFps`, which
   `serializeFrameProvider` was silently erasing — the exact failure its own comment warns about.
2. **One escape hatch is not enough; the two failure modes are mutually exclusive.** Per-source
   budgets bound nothing (staggered onsets chain: A's window expires while B's is open and C just
   started — the 5-source stress ran an episode to 1652ms against a 1500ms cap). An episode cap alone
   strands a permanently starved source (59 presents vs 3941 holds — a viewer updating once every
   1.5s, forever). Both now apply: a source stale past its own budget is written off, AND the
   contiguous episode is capped.

**Rule:** "is it ready?" and "is it ready FOR THE FRAME I AM PRESENTING?" are different questions, and
a readiness flag can only answer the first. When a gate holds a value across time, the value needs a
timestamp or the gate is asserting something it cannot see. Corollary: the same reasoning applies to
any future async node (ADR-010's `schedulingMode`) — a result cached without the time it was computed
for is indistinguishable from a fresh one.

**Verification:** new `pnpm --filter @orreris/web coherence:test` — 5652 assertions, including a
randomized 3/4/5-source scrub storm with CPU-starved decoders asserting that no present ever contains
mixed generations except through a declared hatch, that the barrier both engages and releases, and
that the viewer stays responsive (>33% of composites present) with a permanently dead source.
Measurement probe: `window.__flarexCoherence` (paused-capable, unlike `frameProfiler`).

**Status:** Track A (correctness) complete. Track B (convergence latency — re-measure
`preferSoftwareDecode`, comp proxies while paused on the Flarex page, decoder budget) not started;
Track A makes the update atomic, not fast, so the ~300ms convergence is still there — it now happens
all at once. NOT yet browser-verified on the low-end machine.

### v31a — 2026-07-28: the coherence barrier was correct and useless (browser verification)
First browser run of v31 on the low-end machine, 3-`MediaIn` comp, 33 scrubs. **The barrier did not
remove the symptom and it cost half a second per scrub.** Recorded numbers: avg hold 518.2ms, worst
1509.9ms (pinned at the ceiling), 957/2769 composites withheld, **47 escape-hatch activations of which
44 were per-source WRITE-OFFS**, worst staleness **24 300ms**. Sources still filled in one at a time.

**Why.** v31 was built on v30's "PAUSED = COHERENT" finding — paused, the race does not exist, every
loader can converge on the exact requested time. That is false on this machine. Sources routinely
never converged inside their 1.5s budget, and one was 24.3 SECONDS adrift. The barrier therefore
withholds, times out, writes the slow source off — and a written-off source stops blocking, so the
remaining sources resume presenting as they arrive and the stagger returns. It converted the first
1.5s into a freeze and then reproduced the original behaviour.

The same session named the real bottleneck, which no amount of presentation policy can fix:
`[perf] MAIN THREAD BLOCKED ~2.6s`, sampled `77× getFrame < requestWcFrame`. The host clip also
appeared in `offenders` (702 holds), which it never should — the host is lag-intolerant by design.

**Fix:** hold gated behind `?flarexCoherence=1` (default OFF). Staleness is still computed and
reported to `window.__flarexCoherence` with the flag off — losing that would make Track B unmeasurable.

**Rule:** a barrier is only worth building when the thing it waits for reliably arrives. Verify the
CONVERGENCE assumption before building a synchronization mechanism on top of it — "the race does not
exist while paused" (v30) was true of the race it was describing and false as a general claim about
convergence time, and nothing in the design caught the difference because the unit tests model
convergence as an input. A gate that passes 5655 assertions can still rest on a false premise: the
tests validated the DECISION, and the premise lives in the DATA.

**Corollary for Track B:** the target is not the assumed 200–300ms stagger. It is multi-second
non-convergence plus a 2.6s main-thread block in `getFrame`/`requestWcFrame`. B1 (`preferSoftwareDecode`)
and B2 (paused comp proxies) may be too small to matter against that.

## v32 — Flarex staggered media: the stall is React DEV shipped in the production build (2026-07-28)

**Problem.** Flarex comps with 3 `MediaIn` sources fill in one source at a time on a low-end machine.
Four diagnoses were built and falsified in sequence (frozen-tail overshoot: 13 ms against a 350 ms
threshold; idle provider churn: nothing moves at rest; element-path staleness ≈ 0: measured 20596.7 ms;
provider use-after-dispose: zero in the build trace). Track A (temporal coherence barrier) shipped,
passed 5655 assertions, and did **not** fix the symptom — 332/1039 composites withheld, 49 escape
hatches. See v31/v31a.

**Root cause.** `vite.config.ts` sets `envDir: repoRoot` so one `.env` serves web+api+worker. Root
`.env` line 1 is `NODE_ENV=development`. Vite promotes `NODE_ENV` out of env files into
`process.env.NODE_ENV` when the shell has not set it, so `pnpm build` builds with
`isProduction = false` and bundles `react-dom.development.js`. Proven by control build
(`NODE_ENV=production npx vite build`): `react.dev/errors` 0→1, `createTask` 3→0,
`react_stack_bottom_frame` 4→0, `Invalid hook call` 3→0, index chunk −21%, EditorPage chunk −29%.

A DEV React commits with the passive-effect subtree bailout defeated under `ProfileMode`
(`recursivelyTraversePassiveMountEffects` continues when `actualDuration !== 0`). 29 of ~62 samples in
a 3152 ms stall were that traversal; 12 more were React DevTools mirroring the tree and forcing layout
via `get scrollX`. Multi-second commit blocks freeze every `<video>` and decoder, sources drift seconds
apart, and they reconverge at different wall times. **The stagger is downstream of the stall.**

**Instrument that finally worked.** Four `markHotSpot` probes in the live single-context draw path
(`ScenePreviewCanvas.tsx`: `scene-draw-build` / `scene-media-grade` / `scene-composite` /
`scene-draw-total`). Whole session: 7 events, worst 309 ms, none coincident with a stall. The draw
pipeline was exonerated by measurement rather than argument.

**Rules.**
1. *Verify the build is the build before trusting any build-mode measurement.* Chunk size and one
   DEV-only string cost seconds to check. Every number in this investigation was taken against an
   instrumented React while being treated as the control.
2. *A diagnostic that has never fired is not evidence of health.* `__rfHotSpots` read `undefined`
   because all three probes sat behind the `singleCtx` early return, dead since the 2026-07-07 flip
   (v?? single-ctx default). Absence of an instrument reads identically to absence of a problem.
3. *`envDir: repoRoot` makes `NODE_ENV` in `.env` a build-mode override, not documentation.* Any env
   file Vite reads must not contain `NODE_ENV` unless the build genuinely wants that mode.

**Left open.** Rebuild with a real production React and re-measure the symptom before starting Track B
— B1/B2 target decode contention, which the evidence no longer supports as the constraint. Track A's
hold remains gated OFF behind `?flarexCoherence=1`; its staleness measurement stays on as the
instrument. Unexplained side-finding: remount storms of all three layers, 3× in 61 s, `mediaType` the
only dep that explains the `layer:effect · unknown` re-run — plausibly StrictMode, which a correct
build will settle.

**Fix applied (same day).** `NODE_ENV` removed from root `.env` and `.env.local`; a build-mode
assertion added to `apps/web/vite.config.ts` that throws when `command === "build" && mode ===
"production" && !isProduction`. `pnpm --filter @orreris/web build` now emits bytes identical to a
forced `NODE_ENV=production` control (`index` 999,228 → 787,555 B; `EditorPage` 1,018,160 → 725,224 B).

**Rule 4 — assert the property, not the cause; the assertion finds the causes you missed.** The guard
fired on the very first build after `.env` was cleaned: `.env.local` (gitignored, therefore invisible
to `git grep` and absent on every other machine) *also* began `NODE_ENV=development`, and vite reads it
at higher precedence. Fixing the cause I had proven would have left the bug fully intact while
appearing resolved — and the next measurement would have been another confounded run. A fix that
cannot detect its own incompleteness is not a fix.

## v32a — after the build fix: two stall classes, and a broken staleness measurement (2026-07-28)

**Symptom now.** User: "it got faster than before, but they take time for every clip is different i can
see the difference." Improved, not gone.

**Two distinct stall classes, only one of which v32 fixed.**
- *Class 1 — sampled, React commit.* A 3152 ms stall resolved to `commitPassiveMountOnFiber` /
  `recursivelyTraversePassiveMountEffects` plus React DevTools' tree walk. **Gone** with the
  production build.
- *Class 2 — unsampled.* `STALL 8502ms — no JS samples in window`, and a 7493 ms one before the fix.
  **Still present.** No JS ran, so it is GC, layout/style, or a synchronous browser API — all three
  invisible to the JS self-profiler by construction. Hot spots stay quiet through it (worst 119 ms),
  so it is not in build/grade/composite either.

**The staleness instrument was measuring the wrong thing.** With attribution fixed to run on the
non-held path, the offenders came back as *every* source at once — both Flarex `MediaIn` nodes, the
host layer, and an unrelated timeline layer, 11–19 s each. Four simultaneous decoder deaths were never
plausible. Cause: `WebglMediaLayer::mapSourceTime` clamps the LOW end (0, −preroll) but has no
ceiling, so once the playhead passes a clip's material the requested source time climbs forever while
the decoder correctly serves the last decodable frame. The difference was reported as staleness.

Fixed by clamping the request to `FrameProvider.decodableEndSeconds` (or the element's `duration`) —
the same value `scene-frame-compositor.ts` already treats as the asset's media end. Absent end skips
the clamp, so no path is made worse. Gated: `coherence:test` 5655 → 5665.

**Rule.** *A clamped mapping must be clamped at BOTH ends before a difference against it means
anything.* The module's own doc comment argued that comparing in source space is safe **because** the
mapping clamps — true of the low end, false of the high end, and the asymmetry went unnoticed because
the low end was the one with a comment explaining it.

**Instrument added.** The stall watchdog now samples `performance.memory` on its 500 ms heartbeat and,
on a no-JS-samples stall, reports the heap delta across the blocked window: a fall of >8 MB is
consistent with a major GC, >80 % of the limit points at memory pressure, and a flat heap rules GC out
and sends the investigation to layout or a synchronous browser API. This is the fifth instrument this
investigation has had to repair before it could be believed.

## v32b — the paused stagger is the full-res SETTLE swap, not decoder starvation (2026-07-28)

**User observation that resolved it:** "the media updates instantly when playback is on; it only
updates with a time difference when paused — and it reminded me that pause always shows full quality."

Correct, and it names the mechanism. The FULL-RES SETTLE FRAME path (`WebglMediaLayer.tsx`, user rule
2026-07-05):

- runs **paused only** — `if (isPlaying || hidden || !fullResSrc ...) return`, so playback is proxy-fed
  and coordinated, which is why playback updates in one go;
- waits a **300ms debounce** after the transport settles;
- then leases the **ORIGINAL** bytes (not the ingest proxy) from the element pool and does a **native
  seek per source**, presenting on `seeked`;
- each `present()` calls `drawVideoFrameRef.current()` → bumps `frameVersion` → `requestDraw` → its
  own composite.

Seek latency on original media is a function of GOP structure, resolution and codec, so it differs
**per clip** — exactly the "every clip is different" the user reports. The path's own comment already
predicted the magnitude: *"a sparse-GOP 4K original may take 1–3s to sharpen in."* Telemetry:
`window.__rfSettleSwaps`.

**Why Track A could never have fixed this.** The coherence barrier gates TIME. Both the proxy frame
and the settled full-res frame represent the SAME requested time — the swap is a QUALITY change, and
staleness reads ~0 on both sides of it. The barrier is invisible to the thing the user is watching.
That is the real reason the 2026-07-28 verification failed, and it is a stronger falsification than
the latency argument recorded in v31a: the barrier was not too slow, it was measuring a different
axis.

**Rule.** *Match the barrier's axis to the axis of the symptom.* "Sources appear at different times"
was read as a temporal-coherence problem for the whole investigation. It was a progressive-enhancement
problem: N independent best-effort upgrades, each presenting the moment it lands. A time barrier
cannot serialize a quality transition.

**Proposed (NOT implemented — the settle path is deliberate shipped behaviour under a user rule).**
Coordinate the swap: hold each source's settle present until every participating source in the same
viewer has its full-res frame ready, then swap them in one composite. Paused-only, already best-effort,
and delay only postpones sharpening — no transport or playback impact. Needs the same escape hatch
doctrine as every other hold here (a source whose original never seeks must not block the others).

**Still open — the more serious one.** Scrubbing vigorously WHILE PLAYING freezes the tab
(unresponsive, no Chrome unresponsive prompt); scrubbing while paused is smooth. Class-2 stalls
(`no JS samples`, 7493ms / 8502ms) are unattributed pending the new heap readout.

## v32c — the playback-scrub freeze: getFrame duty cycle, not getFrame cost (2026-07-28)

**Reproduction (user):** scrubbing while PAUSED is smooth; scrubbing vigorously while PLAYING freezes
the tab — unresponsive, with no Chrome unresponsive prompt.

**First sampled evidence, from a correct production build.** `STALL 2641ms — sampled culprits`:

```
88×  getFrame (preview-frame-pool) < u (VideoPreview:47)
60×  u (VideoPreview:47)
10×  (anonymous/native)
 2×  dt (source-decoder)
```

`u` is `requestWcFrame`. ~163 samples at 10ms ≈ 1.6s of JS inside a 2.6s window, almost all of it
`getFrame`. This is JS, on the main thread, and it is the block.

**Mechanism — the budget bounds ONE CALL, not the DUTY CYCLE.** `preview-frame-pool.ts` creates
preview providers with `frameBudgetMs: 24` so no single `getFrame` blocks for seconds. But
`WebglMediaLayer.tsx` re-enters immediately from inside the resolved promise:

```ts
if (wcRerequestRef.current) { wcRerequestRef.current = false; requestWcFrameRef.current(); }
```

A scrub tick arriving while a request is in flight sets `wcRerequestRef`; the `.then()` consumes it
and re-requests across a MICROTASK, so the next ≤24ms decode starts without the event loop getting a
turn. Back-to-back 24ms decodes across 3–4 concurrent sources is ~100% main-thread occupancy — the
timer heartbeat starves and reports "MAIN THREAD BLOCKED" while every individual call is inside
budget.

The file already documents this exact failure and fixed it for TWO branches only — the `tolerateLag`
stale-bail and the null-frame march both back off geometrically, with a comment naming
"a zero-delay recursion, not a retry" as "a large share of the 'page isn't responding' stall". The
general `wcRerequestRef` consumption at the end of the same `.then()` was left unpaced.

**Rule.** *A per-call budget is not a rate limit.* Time-boxing one unit of work bounds latency, not
occupancy; a system that re-enters on completion needs a YIELD between units (`yieldTask()` already
exists in this codebase), otherwise N sources × budget = the whole thread. Read a "we already
time-boxed this" comment as a claim about one call, and check what re-enters it.

**Explains the asymmetry.** Paused scrubbing runs the settle path — one native `<video>` seek per
source, decoded off the main thread — so it stays smooth. Playing + scrubbing drives continuous
`getFrame` on every source AND sets `wcRerequestRef` on nearly every tick.

**Not implemented — awaiting a call.** The fix is to route the re-request through a yield instead of a
microtask. That is shipped playback behaviour with real history attached (v29/v30 lineage), so it is
proposed, not applied.

**Still unattributed.** A separate class remains: `STALL 5010ms` / `17510ms`, **no JS samples, heap
FLAT at 23–24MB (1% of a 4192MB limit)**. GC and memory pressure are both excluded by measurement.
Layout/style or a synchronous browser API; DevTools Performance is the only remaining instrument.

**Instrument fix (sixth this investigation).** Three consecutive stalls of 59500/59498/59493ms were
BACKGROUND TAB THROTTLING, not freezes — Chrome clamps hidden-tab timers to ~1/minute, which is
indistinguishable from a non-JS freeze in this watchdog (no JS samples, flat heap). A genuine freeze
does not land on the same duration three times. The watchdog now tracks `visibilitychange` and reports
those as "timer late while the tab was HIDDEN — background throttling, not a freeze (ignored)".

**Fix applied (v32c).** `apps/web/src/playback/yield-task.ts` (new; a local MessageChannel macrotask
yield — deliberately NOT imported from `export/webcodecs-decoder.ts`, which is listed in
`RENDER_FINGERPRINT_SOURCES` and would invalidate every cached proxy span for a change that alters no
pixels). `WebglMediaLayer::requestWcFrame` now re-arms via `scheduleWcRerequest()`, which yields one
macrotask and coalesces behind a pending flag so several re-request sources produce ONE follow-up
rather than a queue. Coalescing loses nothing: `requestWcFrame` reads the LIVE playhead when it runs,
so the single follow-up asks for the newest time — which is what a scrub wants anyway.

Gates: `typecheck` clean, `wcpool:test` 22/22, `coherence:test` 5665/5665, `flarexproxy:test` pass.
Awaiting the low-end re-measure; the prediction to falsify is that `STALL … 88× getFrame` disappears
while playback fps is unchanged.

**Verified (2026-07-28, low-end machine).** 3-`MediaIn` Flarex comp + 10 timeline layers, playback with
vigorous scrubbing: **smooth, no freeze, no `[perf] STALL` output at all** — on a heavier scene than
the one that originally wedged the tab. The `88× getFrame < requestWcFrame` signature is gone and
playback fps is unaffected, which is the prediction that was put up to be falsified. One macrotask
between decodes was the whole difference between "inside budget" and "the loop never idles".

## v32d — ATOMIC FULL-RES SWAP: the original symptom, actually fixed (2026-07-28)

**The invariant restored:** a paused viewer sharpens ALL of its media sources in one composite, or
none of them. This is the "preview should present one frame after every MediaIn has decoded" rule the
whole investigation started from.

**Change of ownership, not of mechanism.** The settle path is unchanged — it still leases the original
bytes and native-seeks them per source. What changed is who decides when the result goes on screen:

- `ScenePreviewMediaSnapshot` gains `fullResFrame` (the upgrade, OFFERED) and `fullResPending` (an
  upgrade is expected but has not landed). `frame` stays the always-safe proxy/WC frame.
- `WebglMediaLayer::selectVideoDrawSource(includeSettle)` — the legacy own-canvas path passes `true`
  and keeps applying its own settle frame; the single-context path passes `false` and publishes the
  settle frame separately, because there the swap is a viewer-wide decision.
- `ScenePreviewCanvas` tallies pending/ready across the participating set and commits via
  `decideFullResRendezvous` (`playback/full-res-rendezvous.ts`, pure + gated, transportable to the
  ADR-008 engine like `temporal-coherence.ts` beside it).

**Three details that would each have been a bug:**
1. *The cache key must carry the choice.* The proxy and full-res frames can share a `frameVersion` —
   the swap is the COMPOSITOR's decision, not a new publish — so the re-grade skip key gained `|frN`.
   Without it the cached proxy-graded texture would be reused forever and the upgrade would never
   appear.
2. *Withdrawal must be as atomic as the swap.* A one-way latch would leave stale full-res pixels from
   the old playhead on screen after a scrub. Any source going pending withdraws the commit for all.
3. *The decision is made one frame late, deliberately.* `gradeMediaInContext` is invoked lazily by
   `buildSceneDraws` as it walks layers, so no point before the draw has seen every participant.
   Deciding after the draw and re-arming costs one composite and is genuinely atomic; deciding
   mid-walk could not be.

**Why this one ships ON while the coherence hold ships OFF:** nothing is ever WITHHELD. The proxy
frame is on screen throughout, so waiting costs only staying soft slightly longer — no held present,
no frozen viewer, no added latency. The coherence hold withholds frames, which is why it stayed
flagged.

Escape hatch `FULL_RES_RENDEZVOUS_MAX_MS = 3000`, sized from the settle path's own documented worst
case ("a sparse-GOP 4K original may take 1–3s to sharpen in"): a shorter budget would routinely hatch
on exactly the heavy material the rendezvous exists to keep in step.

Gates: new `pnpm --filter @orreris/web fullres:test` 203/203 (asserts the swap happens ONCE, not once
per source; both give-up paths; that withdrawal is atomic; that a new episode does not inherit the old
budget), `typecheck` clean, `coherence:test` 5665/5665, `wcpool:test` 22/22, `flarexproxy:test` pass.
Telemetry: `__rfSingleCtxPreview.fullResSwaps` / `.fullResHatch`.

## v32e — the coherence barrier WORKS once its environment is fixed (2026-07-28)

**User confirmation:** "yes all are landing late but simultaneously now." The invariant holds — a
paused/scrubbed Flarex comp presents one frame across every MediaIn, or none.

**v31a's falsification was environmental, not architectural.** The barrier was gated OFF because
measurement showed sources routinely never converging (669ms avg, 47 write-offs, 24.3s staleness). All
three inputs to that verdict were broken at the time: DEV React caused multi-second commit stalls
(v32), the `getFrame` duty cycle saturated the main thread (v32c), and staleness had no tail clamp so
it reported 15-25s of fake lag (v32a). Re-measured after those fixes, armed:

```
composites 2100 (392 withheld) · convergence 16 · avg 339.2ms · worst 1513.0ms
escape hatches 144 (3 episode-cap, 141 write-off)
```

**Rule.** *Do not retire a mechanism on a measurement taken in a broken environment.* The barrier was
correct the whole time; three unrelated defects made its premise look false. When a design fails
verification, establish that the test rig is sound before concluding the design is wrong — the cost
here was treating a working correctness fix as a dead end for the length of the investigation.

**The correct-but-different fix stays.** v32d's atomic full-res swap addressed a REAL second stagger
(quality upgrades landing per-source) but not the reported symptom — the screenshots showed different
IMAGES, not soft vs sharp, i.e. base frames arriving at different times. Two staggers on two axes;
both now closed.

**Track B has a real target for the first time.** 141 of 144 hatches are per-source WRITE-OFFS, so the
"late" the user reports is the barrier timing out at `STALE_HOLD_MAX_MS` rather than converging: most
scrubs converge in ~339ms, a minority never do inside 1.5s. Worst staleness stays ~21s on the host
layer and the first flarex source despite the tail clamp, which points at the ELEMENT FALLBACK in
`selectVideoDrawSource` (settle → WC → element): when no WC frame exists the layer draws a pooled
`<video>` parked wherever it was last left, which can be tens of seconds away. That is a genuinely
stale picture, not a measurement artifact, and it is what the barrier is withholding on.

**Open question for Track B (measure before changing):** is the right fix to make the WC frame arrive
faster, or to stop falling back to an element that is arbitrarily far from the requested time? The
second is cheap to test — treat a wildly-stale element as NOT READY rather than as a frame — but it
trades a stale picture for a held one, so it needs the before/after numbers the user asked for.

## v32f — coherence hold DEFAULT ON + stale fallback-element refusal (2026-07-28)

**1. The hold defaults ON** (`?flarexCoherence=0` is the escape hatch; localStorage
`orreris.flarexCoherence` still overrides). It shipped OFF for one day on a verdict produced by three
unrelated defects, none of them the barrier — see v32e. Re-measured after those fixes: 339ms average
convergence, 1513ms worst, and the user-visible invariant holds. Pinned by
`coherence:test` (5666) so the default cannot drift back silently.

**2. Stale fallback elements are refused.** `selectVideoDrawSource` picks settle → WC → element. A
pooled `<video>` sits wherever its last owner left it, and when a WC provider exists that element is
only a stopgap — yet it was being drawn while 21.0s from the requested time. That is not "slightly
behind", it is a different shot, and it produced **141 of the 144 per-source write-offs**: the barrier
correctly refused to call it coherent, waited the full 1.5s budget, and gave up. Refusing the frame
routes it to the not-ready path instead, which HOLDS the last graded texture (2026-07-07 anti-flicker
behaviour) and is something the barrier can wait on productively.

Bound is `ELEMENT_FALLBACK_MAX_LAG_S = 1` — deliberately loose. This is a "clearly the wrong shot"
test, not a coherence test; coherence is decided by `stalenessSeconds`, which subtracts a frame period
and tolerates only float noise. A tight bound would reject frames during ordinary seek transients,
when the element is the nearest thing to correct available, converting brief softness into a brief
hole. Applied ONLY when a WC provider exists: with no provider the element IS the primary decode path
(`wcDecode` off remains the default) and refusing its frames would blank the layer permanently.

**Prediction to falsify on the next run:** `escape hatches` should fall sharply from 144 (141
write-offs) and `worst staleness` should drop from ~21s toward the sub-second range, because the
21-second readings were the refused frames. If write-offs stay high, the stale element was not their
cause and the next suspect is WC frame arrival itself (B1/B2).

Gates: `typecheck` clean, `coherence:test` 5666/5666, `fullres:test` 203/203, `wcpool:test` 22/22,
`flarexproxy:test` pass.

## v32g — the residual stagger: a source that is neither stale NOR not-ready (2026-07-28)

**Found by tracing ONE ruler click**, not by inference. `__flarexCoherence.trace()` records every media
source per composite — including the coherent ones — plus which gate withheld the frame.

The trace exonerated the barrier completely. Click 1: 8 composites HELD (`coherence`) while sources
read 4433/4433/4450ms, converging one at a time, then `shown` at **117ms** with all three at 0.
Click 2 the same shape at **82ms**. **Every `shown` row had staleness 0** — no mixed-generation frame
ever reached the screen. Convergence latency is fine and the hold is doing its job.

The signal was in a column that read `—`: source `n_mrzusqg4_99w3` had NULL staleness across those
same composites.

**The gap.** `stalenessSeconds` is null when a source cannot say where it is, and null NEVER gates a
present — correct for a still or a generator, which are right at every playhead. A video with no
decoded frame is the opposite case: it is definitely NOT showing the requested moment. And
`gradeMediaInContext` returns that layer's CACHED PREVIOUS texture (the 2026-07-07 anti-flicker hold)
instead of null, so it does not register as not-ready either.

Neither stale nor not-ready → invisible to both gates → the composite presents with that one source
still showing the PREVIOUS playhead's picture, then updates alone when its decode lands. That is the
residual "one clip changes, then the other".

**Fix:** `ScenePreviewMediaSnapshot.awaitingFrame` — true when a VIDEO source has no frame for the
requested time. The compositor treats it as stale (it gates) but keeps it out of the staleness
statistics (it does not measure — there is no served time to difference against, and those numbers are
the Track B latency instrument). Bounded by the same `STALE_HOLD_MAX_MS` write-off as any stale
source, so a decoder that never delivers degrades rather than freezing the viewer.

**Rule.** *"Cannot answer" and "the answer is no" are different, and collapsing them into one null is
how a gate acquires a blind spot.* The null was documented as safe on the grounds that a frameless
source "is already covered by the existing not-ready path" — it was not, because the anti-flicker hold
had quietly made that path unreachable for exactly this case. Two correct mechanisms, each assuming
the other was covering.

**Also revised:** v32f's stale-element refusal (`ELEMENT_FALLBACK_MAX_LAG_S`) did NOT reduce write-offs
— they rose 144 → 271 with worst staleness unchanged at ~21s, so that prediction is falsified and
recorded as such. It is kept because it is now load-bearing in a way it was not before: refusing a
21s-off element produces `awaitingFrame`, which now GATES, where previously it produced exactly the
invisible hole described above.

Gates: `typecheck` clean, `coherence:test` 5666/5666, `fullres:test` 203/203, `wcpool:test` 22/22.
Trace now prints `WAIT` for an awaiting video, distinct from `—` for a time-invariant source.

## v32h — hidden-tab confound in the coherence stats + hold clocks (2026-07-28)

A soak report showed 6170 escape hatches (6153 write-offs) over 14713 composites, alongside three
`tab was HIDDEN` throttle notices, one of 29.7s. A background tab has its media decode suspended, so
no source CAN converge while hidden — those write-offs were inevitable and measured nothing about the
barrier. Same class of error the stall watchdog had hours earlier, in a different instrument (the
seventh this investigation).

Not only a reporting bug. The per-source write-off clocks and the episode clock kept running across
the hidden stretch, so the first composite after returning found every budget already spent, fired the
hatch immediately, and presented the sources independently — the exact symptom the barrier exists to
prevent, reappearing precisely when the user looks at the tab again. That matches the reported
"after ~5 minutes it starts presenting independently".

Fix: `noteCoherence` skips composites while `document.visibilityState === "hidden"`, and a
`visibilitychange` listener clears `staleSince` / `notReadySince` / the coherence episode clock / the
full-res pending clock on becoming visible. **Elapsed wall time is only a fair budget when it was time
the source could have used.**

**Decoder churn is EXCLUDED as a cause** of the soak degradation, by measurement: after five minutes of
hard scrubbing `__rfWcPool` read `created: 14, reused: 32, initFailures: 0, preemptions: 0,
capMisses: 2`. A degraded-session trace of a single ruler click was still fully coherent (5 composites
HELD, then `shown` at 61ms with every source at 0), so the residual write-offs belong to CONTINUOUS
rapid scrubbing — where the playhead keeps moving and the hatch firing is the designed degradation —
not to a broken gate.

## v32i — Flarex merge blend modes were silently discarded (2026-07-28)

**Symptom (user):** a `screen` merge over a black smoke plate drew an opaque black rectangle; no blend
mode had any effect.

**Cause.** `SceneCompositor.renderGroupInto` sets `nestMode = true` before rendering a group's
children, and `nestMode`'s only effect is forcing every child to `blendMode: "normal"`. That is the
PRECOMPOSE model and it is correct for a compound clip — a nested clip's blend describes how the
finished nest meets the OUTER scene, not how its own layers meet each other. A Flarex `merge` compiles
to exactly the same shape (`group{ children: [bg, fg] }` with the blend on `fg`), but there the blend
IS the node's operation between its two inputs, so suppressing it degraded every merge to `normal`.

**Fix.** `SceneGroupDraw.preserveChildBlend`, set only by the Flarex compiler on merge groups;
`renderGroupInto` uses `nestMode = !draw.preserveChildBlend`. Timeline nests, transition precompose
and the per-layer pass nests all keep precompose semantics, so export output is unchanged everywhere
except Flarex merges — which were wrong.

**Rule.** *Two constructs sharing a lowering shape do not share its semantics.* Reusing
`SceneGroupDraw` for both a precomposed nest and a merge was right; inheriting the nest's blend policy
with it was not. When one IR node serves two intents, the intent has to travel with it.

**Gate.** `flarex:test` now asserts `out.preserveChildBlend === true` on a merge group — the opt-out
itself, not just the blend value it protects, since the value was already being set correctly and
thrown away downstream. NOT verified at pixel level here: `render:compare:pixels` needs a browser
channel, and the `flarex-merge-blend` fixture PNGs in `tmp/render-comparison/` were regenerated while
this bug was live, so they may encode the broken output and need re-baselining before that gate means
anything.

## v32j — the ingest proxy that was never built: file size is not decode cost (2026-07-28)

**Symptom.** In a 4-source Flarex comp, one `MediaIn` (a 45s 1080p smoke overlay) freeze-played during
playback while every sibling ran clean. `__rfSourceMap` — the node-id ↔ asset ↔ decode-path join built
for this hunt — showed it was the ONLY source on `decode: 'element'`; the others were `wc-hw`/`wc-sw`.
`__rfWcPool` read `capMisses: 0, initFailures: 0`, i.e. it had never even asked for a decoder session.

**Chain, all in code.** `VideoPreview.tsx` sets `preferNativeDecode = mediaUrl !== asset.proxyUrl` —
true exactly when the asset has NO ingest proxy. `WebglMediaLayer` then refuses a pooled WebCodecs
lease outright for such a source, so it falls to the `<video>` element path, which the code comment
immediately above that line already names as a freeze for a virtual loader. The Source Viewer badge
read `proxy: skipped` — a SETTLED outcome, distinct from `failed` and from `none`. So the engine had
queued the asset (`EditorPage` scoping does include Flarex `mediaIn` sources — that part was fine),
looked at it, and deliberately declined.

**Cause.** `buildFromBlob`'s first gate: `blob.size < MIN_SOURCE_BYTES (12MB)` → skip "source small
enough", justified by the constant's own comment, *"below this the original is already cheap to
decode"*. That is an INFERENCE of decode cost from file size, and for low-frequency footage — smoke,
fog, light leaks, gradient overlays — it inverts. That content compresses enormously, and the encoder
buys the compression with long GOPs and heavy inter-frame prediction. The file is small BECAUSE
seeking it is expensive. The same flaw sat in the second gate (`already proxy-sized`), which reads
resolution and size but never keyframe density.

**Fix.** `apps/web/src/editor/performance/gop-probe.ts`: read the first video track's sync flags from
the MP4 sample table (metadata only, nothing decoded) and compute keyframe-to-keyframe distances in
FRAMES — frames, not seconds, for the same reason `PROXY_KEYFRAME_EVERY_N_FRAMES` is a frame count
(v7: 1-second GOPs froze 60fps proxies). Both size gates now consult it before skipping. The threshold
`MAX_TOLERABLE_GOP_FRAMES = 24` is anchored to the recipe's own numbers: 2× what we ourselves write
(12), well under the 60 the v7 note records as un-grindable. The decision metric is p95, not max, so a
single tail run or scene-cut GOP cannot conscript a healthy source. Probed lazily — files past the
size gate build regardless and never pay for it. `SOURCE_PROXY_VERSION` deliberately NOT bumped: the
recipe is unchanged, only which sources qualify, and a bump would invalidate every existing proxy.

**Fails closed.** `null` (unparseable container, no `stss`, oversized) → do NOT build. Per ISO
14496-12 an absent sync-sample table means every sample IS a sync sample, so all-false flags are the
opposite of sparse; reading them as "sparse" would rebuild the world. The regression being guarded is
v29's "+22 queued" storm, where over-eager building starved playback.

**Rule.** *A cheap proxy for an expensive property is only safe while the correlation holds — and the
skip path must not be silently load-bearing.* Size stood in for decode cost, which is defensible; what
made it a freeze rather than a soft loss is that "no proxy" ALSO silently selected the element decode
path, with nothing checking whether a skipped source was actually safe there. Two independent
decisions, one implicit dependency.

**Gate.** `pnpm --filter @orreris/web gop:test` — 26 assertions, both directions asserted (missing a
sparse source = the freeze; over-triggering = the build storm), plus the boundary, the p95-vs-max
outlier case, and the recipe's own 12-frame cadence (re-proxying our own output would be a loop).

**Open.** The element-path hand-off itself is untouched: an asset whose GOP probe returns `null` and
is genuinely sparse still lands there. Now that seek cost is actually measured, `preferNativeDecode`
could consult it instead of inferring from `proxyUrl` — deferred, not attempted here.

## v32k — one latch for two stall types: RECOVERED/STALLED alternating every frame (2026-07-28)

**Symptom.** With `?flarexProfile=1` during playback, the console filled with `media RECOVERED` /
`media STALLED` pairs for the same source on consecutive frames, each carrying a `heldFrames` count
that kept CLIMBING (20f → 21f → 22f). GPU 1.3ms / CPU 3.3ms throughout — the frame itself was fast.

**Cause.** `noteMediaSource` warns about two different stall types and latched both on ONE
`stallWarned` flag. Their end conditions are not the same:

  - version-HELD stall — the decoder delivers frames but the same `frameVersion`. Ends when the
    version advances.
  - NO-FRAME stall (`LOST SOURCE`) — the decoder delivers nothing. Ends when a frame arrives.

The recovery branch sat under `if (hasFrame)` and cleared the shared latch. But `hasFrame` is TRUE
for the entire duration of a version-held stall — that is what distinguishes it from the no-frame
case — so every frame it un-latched a stall that had not ended, and the re-warn fired ~15 lines
later in the SAME invocation, since `heldFrames` was never reset. A self-sustaining log loop.

**Fix.** Two latches. `stallWarned` recovers where the version-held run actually ends — the
`frameVersion !== lastVersion` branch, which already resets `heldFrames`. `lostWarned` recovers on
`hasFrame`, gated on `noFrameFrames > 0` so it can only speak about a no-frame run.

**Rule.** *A latch belongs to the condition that ends it, not to the code that noticed it.* One flag
serving two predicates is safe only while the predicates share a terminator; these never did, and
the failure was invisible until a source stalled long enough to cross the 20-frame threshold while
still delivering frames — exactly the case a proxied-but-starved decoder produces.

**Note.** The underlying stall this exposed is REAL and separate: `heldFrames` climbing means a
source genuinely served no new version for ~360ms. Diagnosis of that continues; this entry is only
about the instrument that was making it unreadable. Not fingerprint-affecting —
`frame-profiler.ts` is not in `RENDER_FINGERPRINT_SOURCES`, so no proxy is invalidated.

## v32l — one file, two doors, two decoders: shared decoder sessions (2026-07-28)

**Symptom.** The stall v32k made readable. `console.table(__rfSourceMap)` on a 4-source Flarex comp:
asset `65ff9c00` (`forest_1080p_30fps.mp4`) appeared TWICE — host clip `layer_…_1_1` as `wc-hw` at
staleness 427ms, and node `n_mrzuss81_mszw` as `wc-sw` at 394ms. The other two sources, each owning
its own asset, sat at staleness 0. Both forest nodes read `Source In Seconds 0.0`, `Freeze: Off`.

**Cause.** A Flarex comp reads one file through two doors: the host clip's `MediaIn` (empty
`sourceAssetId` → the host timeline layer) and a pool-asset `MediaIn` pointing at the same file. The
pool keyed providers by `(url, software)` and matched only for WARM PARK reuse, so two LIVE
consumers of one file always meant two decoder sessions. Identical file, identical timestamp,
identical pixels — one read, decoded twice.

Nothing registered as a cap miss (`capMisses: 0`) because four consumers fit `MAX_WC_TOTAL_SESSIONS
= 4` EXACTLY. That is the trap: the budget was not exceeded, it was fully spent, and one of the four
slots was pure duplication. A pool statistic cannot report waste that fits.

**Why the obvious version does nothing.** A URL-keyed share refuses exactly this case: the host is
`wc-hw` and the loader `wc-sw`, and v30's mode-matching rule (the 2026-07-27 "host frozen, loaders
playing" bug) forbids the match. Sharing had to cross the mode boundary to be worth building.

**Fix.** Crossing it is safe in ONE direction, and that asymmetry is the whole design. The 2026-07-27
rule exists because N sessions contend for one hardware block; a single SHARED session is not
contention, it is one decode feeding two consumers. So `canAttachToSession(sessionSoftware,
wantSoftware) = sessionSoftware === false || wantSoftware === true`: a hardware session accepts
anyone, a software session accepts only a consumer that ASKED for software. The host's guarantee is
preserved byte-for-byte.

Acquisition order is warm reuse → attach → reserve. Sessions initializing are attachable, which is
the point: two layers mounting in the same tick is the common case, and without it the dedupe misses
the exact scenario it exists for.

**The constraint that shaped it.** `FrameProvider.getFrame` returns a frame "provider-owned, valid
until the next call/dispose". With two consumers on one provider, B's call silently invalidates the
frame A is still holding. So the contract is reproduced PER LEASE: each attached lease gets a thin
wrapper owning exactly one outstanding clone (`VideoFrame.clone()` — refcounted, no pixel copy, the
trick `WebglMediaLayer.setWcHeldFrame` already used), closed when the next call supersedes it. Every
consumer sees precisely the semantics it saw before.

**Invariant, and everything is a consequence of it.** *Exactly one `SharedSession` owns a
`FrameProvider`. Every lease merely leases access.* Disposal, `bumpActive`, parking and preemption
are the owner's business alone; a lease may close only the clones it made.

**Divergence.** Two decoders thrash far less than one decoder dragged between two playheads, so a
share can give up: after `SHARE_DIVERGENCE_STRIKES` consecutive diverged frames the later-joined
lease is detached and notified exactly like a preemption. Tolerance is `SHARE_DIVERGENCE_FRAMES /
nominalFps` — a FRAME count, because a fixed 100ms is ~2.4 frames at 24fps and ~12 at 120fps, the
same lesson that made `PROXY_KEYFRAME_EVERY_N_FRAMES` a frame count. A detached session is marked
unshareable for good, so the split consumer cannot re-attach and oscillate.

**Ordering is contract, not implementation.** On preemption every member's `onPreempted` fires
BEFORE the shared provider is disposed. Notify-then-dispose: a member reacting synchronously must
never observe a half-torn session.

**Bug found by the gate, not by review.** `joinedAt` was `Date.now()`. Two layers mounting in the
same tick attach in the same millisecond, so the "later joiner" comparison tied and the divergence
detach picked whichever the `Set` iterated first — the HOST. The exact detach-the-wrong-one inversion
this file keeps relearning. Now a monotonic sequence.

**Telemetry.** `__rfWcPool` gains `shared` / `sharedActive` / `shareDetaches` / `sharedFramesServed`
/ `sharedFrameHits`. The first three say sharing EXISTS; only `sharedFrameHits / sharedFramesServed`
says it saves work — a share whose members never land on the same timestamp is bookkeeping with no
payoff and would look identical without the ratio. Same lesson as the mode-mismatched warm reuse that
"looks like a perfectly healthy cache HIT". `__rfSourceMap` should now show both forest rows on ONE
mode instead of `wc-hw` + `wc-sw`.

**Gate.** `pnpm --filter @orreris/web wcpool:test` — 59 assertions. The load-bearing ones: the
software→hardware refusal (the 2026-07-27 bug gets an explicit test, not a code comment); the
INITIALIZATION RACE (two acquisitions in one tick → exactly one provider created, one session
reserved, `sharedActive === 1`) which a sequential-only test would pass through a regression;
`decodes === 1` for both concurrent and sequential same-timestamp pairs, because a dedupe that never
collapses a call is trivially correct and worthless; and re-acquire-after-detach creating its own
session. Needed a narrow `__setFrameProviderFactoryForTests` seam — node has no WebCodecs.

**Risk.** This is the file that killed the renderer once (concurrency 3 → 7). Sharing can only ever
LOWER the session count; the caps are untouched. Kill switch `?wcShare=0` restores the previous
behaviour exactly (the lease is handed the serialized provider unwrapped). No `packages/shared`
change, and `preview-frame-pool.ts` is not in `RENDER_FINGERPRINT_SOURCES` — no cached proxy is
invalidated, export/worker output byte-identical.

**Open.** Upgrading an existing software session to hardware when a host arrives LATER is out of
scope: if a software loader mounts first, the hardware consumer creates its own session, which is
the status quo and no regression. In practice the host mounts first. Plan:
`plans/decoder-session-sharing.md`.

**Verified live (2026-07-28).** Both rows of the duplicated asset read `wc-hw` / `shared: 1` /
`staleMs 0` — the loader asked for software, attached to the host's hardware session, and got
hardware frames. `created: 3` where it was 4, `shareDetaches: 0`. Over 20s of playback:
`sharedFramesServed: 12568`, `sharedFrameHits: 11816` → **752 real decodes**, i.e. ~one decode per
source frame (30fps × 20s ≈ 600, plus seek catch-up) feeding two consumers.

The 94% hit rate is far above the (N−1)/N = 50% ceiling predicted from "one call per member per
timestamp" — that model was wrong. The rAF loop and the coherence gate RE-POLL the same timestamp
while a frame is held, so a member issues several calls per presented frame and every repeat is a
hit. The memo therefore absorbs ~11.8k redundant provider calls per 20s on top of freeing the slot,
which was not the stated goal and is the larger share of the win.

**Instrument that had to be fixed first.** Two readings were taken before this could be judged, and
neither could answer the question: `__rfWcMode`/`__rfSourceMap` derived `decode` from
`preferSoftwareDecode` — the REQUEST. A loader attached to a hardware session asks for software and
gets hardware, so a working share still printed `wc-hw` + `wc-sw`, identical to a broken one. A
consumer cannot know its own decode mode; it asks, the pool decides. The lease now exposes the real
session live, plus `sharedWith`. *Rule: an instrument that reports the input to a decision cannot
verify the decision.*

A third reading was lost to a stale bundle — `'shared' in __rfWcPool` was false, i.e. the running
build predated the change. Same lesson as the react-dom.development episode: check the build IS the
build before interpreting a measurement, and prefer a presence test for a symbol the new code adds.

## v32m — the pixel gate has no baselines: it proves parity, never correctness (2026-07-28)

**Task.** v32i shipped unverified at pixel level, on the belief that the `flarex-merge-blend` artifacts
in `tmp/render-comparison/` predated the fix and therefore "baselined the bug" — a fixture that would
pass on wrong output and fail once someone fixed it. Re-baselining was queued as the next job.

**The premise was wrong, and wrong in the direction that matters.** `render:compare:pixels` is not a
golden-image gate. Every run renders BOTH sides fresh — the Remotion still via `renderManifestStill`,
then the web preview through Playwright — and diffs them against each other. The PNGs are outputs of
the last run; nothing ever reads them back. There was no baseline to be stale, and no way for the
fixture to fail because someone fixed the renderer.

**What was actually true is worse.** The v32i fix lives entirely in `packages/shared`
(`scene-compositor.ts` `preserveChildBlend`, set by `compile-flarex.ts`) — the compositor BOTH
renderers consume. So the bug was symmetric: preview and Remotion agreed perfectly on `normal` where
the comp said `multiply`, the diff read 0.000%, and the gate was green on wrong output. Re-running it
after the fix also reads 0.000%. Neither number says anything about correctness.

**Rule.** *A gate that renders both sides from one shared implementation can only detect DIVERGENCE,
never ERROR.* Its silence about a bug in `packages/shared` is structural, not a gap to be tightened
away. To verify a fix in shared code, diff ONE renderer ACROSS the change — the fixture's own history,
not its two halves against each other.

**Applied.** Pre-fix PNGs preserved, sweep re-run, then same-renderer pre/post diff at the gate's own
threshold: web preview **1.433%** changed (29708/2073600), Remotion still **1.457%** (30204/2073600).
Both moved, by near-identical amounts — the signature of a shared-compositor change, and itself
corroboration that the fix reached both paths. Visual check confirms the intent: the fixture is
`merge{blend: multiply, opacity: 0.7}` over `colorCorrect(exposure 1.5, contrast 0.3)` of the same
plate; pre-fix rendered lifted and washed (a 70% lerp toward the brightened grade — i.e. `normal`),
post-fix reads darker and more saturated. That is multiply.

**Sensitivity finding, OPEN.** The entire visual footprint of the merge-blend fix is 1.43% against
`PIXEL_MAX_DIFF_RATIO = 0.035`. Had the fix landed in only ONE renderer, the fixture would have read
1.43% < 3.5% and PASSED. This fixture cannot presently catch the asymmetric form of the exact bug it
exists to catch. Tightening the bar for the Flarex fixtures is a change to a shipped gate — deferred
to the user, not done here.

**Full sweep.** 53/53 pass. Closest to the bar is `advanced-transition` at 3.131% — 89% of the budget
spent, pre-existing, worth watching before anything else raises it. `flarex-generators` 0.691%, the
stylize family 0.049–0.068%, everything else at or near zero.

**The web-preview capture is not byte-deterministic.** A full sweep rewrites ~55 tracked PNGs, but the
Remotion stills are stable (only `remotion-flarex-merge-blend.png` changed). Measured on the `default`
fixture, two runs of the same unchanged code differ by 233642 channel samples with a max delta of
8/255 — real GPU raster/AA jitter, below pixelmatch's perceptual threshold, so the cross-renderer diff
still reads 0.000%. Consequence for review: a diffstat on `tmp/render-comparison/` after a sweep
carries almost no signal. Read `summary.json` and the same-renderer pre/post comparison instead.

**Harness bug, OPEN.** A scoped `PIXEL_FIXTURES=<one>` run REPLACES `summary.json` with only the
fixtures it ran rather than merging into the existing results — one scoped run silently discards the
other 52 entries. Cost one such loss this session.

## v32n — closing v32m's two open items: per-fixture bars, and a summary that merges (2026-07-28)

**1. The bar was sized for the worst fixture, so it protected none of the good ones.** One global
`PIXEL_MAX_DIFF_RATIO = 0.035` has to accommodate `advanced-transition` (3.131%) and
`flarex-generators` (0.691%), which leaves 3.5% of slack in front of fixtures that actually measure
0.000%. v32m quantified what that costs: the merge-blend fix's whole footprint is 1.43%, so the
ASYMMETRIC form of that bug — the fix reaching one renderer and not the other — sails under the bar
on the very fixture built to catch it.

`fixtureMaxDiffRatio` now gives the eleven Flarex fixtures that measure 0.000% a 0.5% bar; everything
else keeps the global default. Bars are set from an observed sweep WITH headroom, never just above the
reading — 0.5% against 0–3 differing pixels is ~10000 pixels of slack, so the non-deterministic
web-preview capture (v32m: max channel delta 8/255, below pixelmatch's perceptual threshold) cannot
make it flaky. `flarex-generators` and `advanced-transition` are deliberately left loose rather than
quietly exempted: they need the slack for reasons nobody has investigated, and that debt should stay
visible. An explicit `PIXEL_MAX_DIFF_RATIO` still overrides everything, for a machine whose GPU
rasterizes differently enough to need it.

**Proved against real pixels, not arithmetic.** Diffing the PRE-fix web preview against the POST-fix
Remotion still reconstructs exactly the asymmetric regression: **1.644%** — over the new 0.5% bar
(caught), under the old 3.5% one (missed). The gate now fails on the bug it was written for.

**Rule.** *A tolerance sized for the loosest case is not a tolerance.* When one bar covers a whole
sweep, its value is set by the worst fixture and every other fixture silently inherits slack it never
needed. Per-fixture bars cost a table; a shared bar costs the gate's entire purpose on the tight ones.

**2. A scoped run discarded the sweep it was narrowing.** `PIXEL_FIXTURES=<one>` rewrote
`summary.json` with only the fixtures it ran, dropping the other 52 entries — and it looked exactly
like a legitimate summary afterward, just a much shorter one. The write now merges: entries this run
re-measured win, entries it never touched survive. A `rendererMode` change still starts clean, since
old results describe a different render path and merging them would be a lie. Any unreadable or
malformed summary yields `[]` rather than failing the gate.

**Verified.** Scoped `PIXEL_FIXTURES=flarex-merge-blend` run: passes at the tight bar, `summary.json`
still holds all 53 entries, and the entry records `maxDiffRatio: 0.005` — the bar actually applied,
not the global default it was previously reporting regardless.

## v32o — preferSoftwareDecode: measured at last, and it earns its keep (2026-07-28)

**Status change.** v30 shipped `preferSoftwareDecode` on Flarex virtual loaders on a decoder-contention
theory that was later disproved, and the tracker has carried it as "kept, unproven" since. It costs a
CPU H.264 decode per loader. It is now KEPT ON EVIDENCE.

**Why it became measurable.** Session sharing (v32l) narrowed the question into something a single comp
can answer. An ATTACHED loader receives the host's hardware session whatever it asked for, so the flag
can only still affect loaders that did NOT attach — two in the reference comp. `?flarexSwDecode=0/1`
was added purely to A/B it; absent the param the behaviour is unchanged.

**Result, one paired 20s run on the same comp.** Arm A (flag on): `activeSoftware: 2`, every source
`ok`, `staleMs 0`, no watchdog entry, no heals, `WcHolds 3263`. Arm B (flag off, all hardware):
`active: 3` / `activeSoftware: 0`, and the pipeline broke —

```
Live-freeze watchdog: 1 total · worst ∞ (no-source) behind
  ⚠ 26c6cf60 — wc ∞ behind @ t=16.15s · playing=true
WebCodecs heals: busyWedge 1
Element reloads/seeks: SettleSwaps 2 · StaleDrawKicks 5 · WcHolds 16272
```

`26c6cf60` is `n_mrzusqg4_99w3` — one of the two loaders under test. A source went infinitely behind
with NO frame at all while playing, and the pool had to fire a `busyWedge` heal. That is the
multi-source freeze symptom, reproduced on demand by turning the flag off. **The user's independent
report matches the instruments exactly: "playback was smooth [with sw], and it was lagging when
swdecoder was false."** Perception and counters agreeing on the same run is worth more than either
alone — the instrument could be measuring the wrong thing; the eye cannot be talked out of a stutter.

**What this data does NOT support.** `__flarexProfile.report` is a snapshot of ONE frame (659 vs 740),
so the CPU 3.30 vs 4.90 ms and `resolveSourceDraw` 1.50 vs 3.10 ms are single samples and no cost
figure may be quoted from them. Only the cumulative counters — watchdog, heals, StaleDrawKicks,
WcHolds — accumulate across the run and mean anything. n=1 per arm; the wedge is strong evidence, not
proof. What would overturn it: repeated OFF runs with a clean watchdog.

**Rule.** *A flag kept "just in case" is a flag nobody can remove.* This one sat unproven for a month
because the code offered no way to turn it off — the measurement was impossible, so the debt was
permanent. A behavioural flag should ship with the switch that lets someone later decide it was wrong.

**Instrument failure that preceded the result, worth more than the result.** The first A/B was VOID: the
build was verified with `'shared' in __rfWcPool`, which tests the session-sharing commit from earlier
the same day. It was true, so a bundle with no toggle in it at all passed the check, and `=0` read as a
null result rather than an absent feature. Confirmed after the fact by grepping the served
`index-BH_BXbzF.js` for `flarexSwDecode` — zero occurrences. `__rfFlarexSwDecode` is now published
unconditionally (null / true / false) so absence and off are distinguishable. *A build check must test
the symbol the measurement depends on, not a neighbouring one* — the same shape as v32l's decode column
reporting the request instead of the session, and the third time this file has recorded a measurement
round lost to a stale bundle.

**Unblocks.** Item 3 (`preferNativeDecode` inferring decode cost from `mediaUrl !== proxyUrl`) was
deliberately gated behind this decision.

## v32p — the last inference: "no proxy" was standing in for "expensive to seek" (2026-07-28)

**The pattern, third occurrence.** v32j killed a file-SIZE heuristic that concluded "small ⇒ cheap to
decode" and skipped the proxy; smoke footage inverts it, because the file is small BECAUSE the encoder
bought that size with long GOPs. The replacement MEASURES seek cost (`gop-probe.ts`). But one layer
down, `VideoPreview` was still inferring the same quantity from a different proxy variable:

```ts
preferNativeDecode={mediaUrl !== asset.proxyUrl}
```

"No proxy, therefore expensive to seek, therefore force the `<video>` element decoder." That inference
inverts on exactly the sources the probe exists to classify. A small keyframe-dense clip has no proxy
*precisely because it was measured cheap* — and this line then pushed it onto the element path, which
for a Flarex loader is the freeze `WebglMediaLayer` warns about. The probe already knew the answer and
had nowhere to put it: the engine computed the verdict, used its negative half to decide the build, and
discarded the positive half.

**Fix.** `measuredDenseGop` retains the positive verdict; `hasMeasuredDenseGop(assetId)` exposes it;
`preferNativeDecode` now requires BOTH no-proxy AND not-measured-dense. Membership needs a POSITIVE
measurement — a `null` profile (WebM, oversized, no `stss` box) never lands in the set, so unprobed and
unmeasurable sources keep the conservative element decoder exactly as before. Nothing is relaxed on a
guess; the set only ever ADDS permission to use the pooled decoder, mirroring the probe's own doctrine
that it only ever adds a reason to build.

**The async hole, closed deliberately.** A dense verdict changes NO url — no proxy is built, so the
graph is untouched and nothing remounts. `preferNativeDecode` is computed during render, so the verdict
would have been read before it existed and then never re-read, correct only by luck of an unrelated
re-render. `setSourceProxyDenseGopListener` bumps one counter per newly-measured asset; the set is
monotonic so it cannot loop. *A value that arrives asynchronously needs a way to announce itself, or it
is not a value, it is a race.*

**Rule.** *When a measurement replaces a heuristic, hunt every OTHER consumer of the quantity the
heuristic was estimating.* Deleting the heuristic at its original site left a second copy of the same
bad inference one layer down, phrased differently enough to look unrelated — size at ingest, url at
render, both standing in for seek cost.

**Gates.** `gop:test` 26/26, `wcpool:test` 59/59, `coherence:test` 5666/5666, `fullres:test` 203/203,
web typecheck clean. None of the three touched files is in `RENDER_FINGERPRINT_SOURCES`, so no cached
proxy span is invalidated and export output is unchanged.

**NOT yet verified in a browser.** The path this fixes needs a source that SKIPS its proxy on a dense
measurement; the reference comp builds all 6, so it never exercises the new branch. Someone should
confirm with a small keyframe-dense clip that `__rfSourceMap` shows `wc-*` rather than `element` for a
skipped source.

## v32q — instruments that outlive what they describe (2026-07-28)

**`__rfWcMode` was write-only.** Keyed by source URL, never pruned. One asset legitimately changes url
mid-session — the original plays until its ingest proxy lands, then `mediaUrl` becomes the proxy blob
and the layer remounts — so the ORIGINAL's row stayed in the table beside the proxy's, both reading as
current. One asset, two rows, one of them describing a decoder that no longer exists. It had already
produced one wrong diagnosis: the dead `element` row read as a live source stuck on the fallback path.

Now refcounted. Refcounted rather than delete-on-unmount because two layers can legitimately share one
url (the same clip twice on the timeline) and the last one out must clear it. `__rfSourceMap`'s half of
this was fixed in `7a5efb4`; this was the other half.

**`__rfSourceMap.asset` was never an asset.** `sourceLabel` is the tail of the media url — a FILENAME
for a library asset, but an opaque `createObjectURL` UUID for anything OPFS-backed, regenerated every
page load and joinable to nothing. For a project whose sources are all proxied blobs, the column shows
a completely fresh set of meaningless ids on every reload.

That cost a round THIS SESSION: the changing ids were read as assets being re-created per session,
which would have meant no proxy could ever survive a reload — a far more serious bug than anything
actually present, and entirely an artifact of the column's name. `assetLabel` now carries the real
`fileName`, with the url tail as fallback.

**Rule.** *A column named for a thing must contain that thing.* `asset` holding a url tail was
defensible when every source was a library file with a filename in its path; it became a lie the moment
sources were blobs, and it went on being read as an asset id because that is what it is called. The
failure mode is not that the value is wrong — it is that the NAME is a promise the value stops keeping,
silently, when the surrounding system changes.

Both are the same family as v32l (a column reporting the request instead of the session) and v32o (a
build check testing a neighbouring symbol): the instrument answered a question adjacent to the one
asked, and read identically to one that answered correctly.

**Gates.** `wcpool` 59/59, `coherence` 5666/5666, `fullres` 203/203, `gop` 26/26, typecheck clean.
Telemetry only — no decode, playback or render behaviour is touched, and no file here is in
`RENDER_FINGERPRINT_SOURCES`.

## v32r — v32p/v32q verified live (2026-07-28)

**Method.** The reference comp builds all six proxies and so never reaches the dense-GOP branch. Built
a fixture instead: 10s 1280x720 `testsrc2`, `-g 12 -keyint_min 12 -sc_threshold 0`, 3.7 MB — under the
12 MB size gate and denser than `MAX_TOLERABLE_GOP_FRAMES`. Confirmed against the real probe before
handing it over rather than assuming the encoder honoured the flags: `sampleCount 300, keyframeCount
25, maxGapFrames 12, p95GapFrames 12, needsProxy false`.

**v32p result.** `dense-gop-test.mp4` reads **`wc-hw`**. Pre-fix that clip has no `proxyUrl`, so
`preferNativeDecode` would have forced the `<video>` element path; it is now on the pooled decoder
because the probe measured it cheap. `__rfDenseGop` carries `gop p95 12f / max 12f over 300f`.

**v32q result.** The table now reads `forest_1080p_30fps.mp4` / `china_view_1080p_60fps.mp4` /
`smoke.mp4` / `dense-gop-test.mp4` where it previously showed rotating `createObjectURL` UUIDs.

**The presence test earned itself.** `__rfDenseGop` read `[]` before the import and `[{…}]` after —
proving the build was current BEFORE any measurement existed. Without that, an `element` reading would
have been ambiguous between "fix not working" and "fix not present", which is precisely how the first
`flarexSwDecode` A/B was lost. Third instrument in three days whose value was in distinguishing absent
from idle.

**Open.** `dense-gop-test.mp4` read `state: stale, staleMs: 415` while every other source read `ok / 0`
— the only stale row, and it is the clip on the new path. Plausibly a just-added clip off the playhead
with a warming decoder, but unconfirmed. Follow-up: does it settle to `ok` under sustained playback?

## v32s — preferSoftwareDecode CLOSED at n=3, and two details the confirmation exposed (2026-07-28)

**Closed.** Two further `?flarexSwDecode=0` runs plus the user's direct report ("its lagging very much
in this gate"). Every hardware-only arm reproduced the wedge; no software arm ever has. v32o's n=1
caveat is discharged — this flag is not to be revisited without new evidence.

```
run 2: Live-freeze watchdog 1 · ∞ (no-source) behind @ t=16.15s · playing=FALSE
       busyWedge 1 · StaleDrawKicks 3 · WcHolds 5260
run 1: same wedge @ t=16.15s · playing=TRUE
```

**Detail 1 — the second wedge happened while PAUSED.** `playing=false`. The keep decision does not
depend on the mechanism, and the ON arm never wedges either way, so the conclusion stands. But
"hardware-block contention between playing streams" does not explain a wedge with nothing playing, and
the tracker already carries the rule that *frozen while PAUSED is a dead decode, not a stale clock*.
The flag is doing something real; the STORY attached to it since v30 may still be wrong. Recorded so
nobody later cites this entry as proof of the contention theory — it is proof of the effect only.

**Detail 2 — both wedges fired at t=16.15s exactly.** Two runs, two sessions, identical timeline
position to the centisecond. Stochastic decoder contention does not repeat to that precision. That
points at something content-addressed — a specific GOP boundary, a seek target, a clip edge at that
position — and it is a far more tractable lead than "contention" because it is reproducible on demand.
NOT chased here.

**Instrument gap this exposed, fixed.** The watchdog's one job is naming the frozen source, and it
printed `r.src` — a url tail, i.e. an opaque per-session blob UUID for anything OPFS-backed. The same
wedge in two runs printed `26c6cf60…` and `49ded0d0…`, which read as two unrelated sources when they
may well be one. v32q fixed this column in `__rfSourceMap` and missed the watchdog line; it now uses
`assetLabel` too. *Fixing an instrument means fixing every place it reports, not the one you were
looking at.*

## v32t — the one unbounded link: a getFrame that never settles (2026-07-28)

**Not an observed bug.** Every wedge in the v32s readings drained on its own (`busyWedge` stayed at 1
rather than climbing, which is what a permanently stuck chain would produce). This closes a latent
hazard found while tracing that intermittent freeze, and the honest status is: never seen in the wild.

**Why it was worth closing anyway.** Every bound in the playback path sits ABOVE the decode and cannot
interrupt one already in flight — `WC_INIT_TIMEOUT_MS` 4000 covers init, `WC_BUSY_WEDGE_MS` 3000
DETECTS a stuck call, the catch-up hold caps at 5000, the decoder's flush races a 5s timeout.
`serializeFrameProvider` then chains every later call behind the stuck one. So a single non-settling
promise blocks that provider forever, and the `busyWedge` heal cannot recover it: the re-request it
issues queues behind the very call that is stuck. The counter increments, the layer clears its busy
flag, and the picture stays dead — **a freeze that reports itself as handled**, which is the same
disease as the three instrument failures this file recorded this week, except the user is looking at it.

**v32l widened the blast radius, uncosted at the time.** Members of a shared session await the same
`session.pending` promise. One wedged decode therefore takes the host clip and the Flarex loader
together — the whole comp, not one node. Sharing was a clear win and remains one; this is the part of
its cost nobody priced.

**Fix.** `guardWedge` bounds one decode at 10s and resolves `null` (never rejects — every caller
already handles a null frame, and a rejection would surface as an unhandled error in the rAF loop).
The GUARDED promise is what goes into `session.pending`, so bounding it bounds every sharer at once;
storing the raw promise would protect the one member who tripped it and leave the joiners hanging,
which is worse than no backstop because the pool would still read healthy.

On timeout the session is torn down as a PREEMPTION, reusing the one teardown that already gets
ordering right (notify-then-dispose). A decoder that has not answered in 10s is broken, not slow —
parking it warm would hand the next lease the same wedged decoder.

**10s is deliberately far above every bound above it.** This must fire only when all of them have had
their chance and failed. A >3s decode that later recovered has been observed in the wild; firing on
merely-slow media would tear down healthy sessions to fix nothing. It is a last resort, not a latency
control.

**Rule.** *A retry that queues behind the thing it is retrying is not a recovery.* The `busyWedge`
heal was written as one and counted itself as one for a month. Any self-heal must be checked against
the question "can this run while the fault is active?" — if it shares a lock, a chain or a queue with
the stuck work, it is a counter, not a cure.

**Gates.** `wcpool:test` 59 → **69** assertions: the timeout resolves null rather than hanging, the
SHARER awaiting the same pending promise also comes back, the count is per session not per member,
every member is notified, the dead decoder is disposed rather than parked, and a re-acquire builds a
fresh working session. `coherence` 5666/5666, `fullres` 203/203, typecheck clean. New counter
`__rfWcPool.wedgeTimeouts`, expected 0 forever — a non-zero reading is the interesting one.

## v32u — "Full quality" was a freeze switch for comps (2026-07-28)

**User report.** "full quality preview as 1, 1/2 or 1/4 — in 1, that is different from 1/2 or 1/4
right... for flarex its very laggy. check how professional NLEs do that."

**Correct, and the difference is not resolution.** `1` did two unrelated things. `resolutionScale` is
the honest half (render surface scale during playback; paused is always 1 regardless). The other half:
`fullQualityPlayback = previewQuality === "quality" && !adaptiveResOn` flipped
`setIngestProxyPlaybackEnabled(false)`, so `resolvePlaybackUrl` returned the ORIGINAL `fileUrl` instead
of `proxyUrl`.

**The chain that made it a freeze.** `preferNativeDecode` is `mediaUrl !== asset.proxyUrl`. Once
`mediaUrl` is the original that is true for EVERY source, and `preferNativeDecode` skips
`acquirePreviewFrameProvider` outright — no pooled lease at all. So selecting "1" moved every source in
a Flarex comp onto the `<video>` element path in one step, through the browser's ~16
hardware-decode-context cap.

`WebglMediaLayer` states the invariant forty lines below that gate: *virtual loaders must NEVER take the
`<video>` path* — but enforced it as `!props.tolerateLag` on the BAILED branch only. The
`preferNativeDecode` branch had no such guard. The rule was written down, tested by nothing, and
bypassed by the control most likely to trip it.

**Fix 1 — the invariant, enforced where it was stated.** `forceElementPath` now requires
`!props.tolerateLag` for BOTH conditions. For a loader the choice was never element-vs-pool but which
failure: a sparse-GOP original on the pool seeks slowly, and `tolerateLag` exists precisely to present
advancing frames through that. The element path has no degradation mode — it hits a cap and freezes.
*A slow source is a degradation; a capped one is an outage.*

**Fix 2 — split the axes, as every pro NLE does.** Premiere: Playback Resolution (¼/½/Full, plus a
separate PAUSED resolution) vs the Toggle Proxies button. Resolve: Timeline Proxy Mode vs Prefer
Optimized Media. Avid: Video Quality vs Dynamic Relink. All three keep them orthogonal because the
useful combinations are diagonal — a colorist checking grain wants Full WITH originals; an editor on a
12-source comp wants Full WITH proxies. One bundled control can express neither.

`1/½/¼/A` is now purely resolution. Media source is its own `Orig` toggle, persisted, default OFF for
everyone including users whose stored quality was `quality` — the point is that Full stops being a
trap, and anyone who wants original pixels can now ask for exactly that.

**Also removed:** `PreviewQualityProfile.useProxy`, false on `quality`. Never read by anything — the
real substitution went through `setIngestProxyPlaybackEnabled` — so it was pure documentation of a
coupling that no longer exists. *A field describing a policy nobody consults is a future reader's false
lead.*

**Rule.** *A control that silently changes a second variable will eventually be blamed for the wrong
thing.* Users reported "full quality is laggy" and every instinct pointed at resolution cost, which was
innocent; the damage came from a media swap the label never mentioned. Bundle two axes into one control
and you lose the ability to attribute the failure, not just the ability to express the combination.

**Open — likely the same root.** The user's guess that this connects to "broken frames for different
media that update at different times when paused" is plausible and untested: on the element path every
source seeks independently, and v32b already traced the paused stagger to the full-res settle swap,
which is dormant under fixed full quality. Worth re-checking now that Full no longer forces elements.

**Gates.** `wcpool` 69/69, `coherence` 5666/5666, `fullres` 203/203, `gop` 26/26, typecheck clean.
NOT verified in a browser: this is a UI/behaviour change and needs a human to drive it.

**Verified live (2026-07-28).** User on the reference Flarex comp at `1` with `Orig` off: "yes its far
smooth than before". The freeze was the element-path cap, not render cost — resolution was never the
expensive part of "full quality", which is why every previous attempt to explain the lag in terms of
GPU load went nowhere.

## v32v — the paused stagger closed as a SIDE EFFECT of the quality split (2026-07-28)

**User, unprompted, after v32u:** "frames now update simultaneously.. no lag.. i mean it takes little
bit of time like 700-900ms to update sometimes but they do all at once it feels one frame now."

**The stagger is gone, and it was never its own bug.** This file has chased "different media update at
different times when paused" across v32a–v32h — the coherence barrier, the write-off clocks, the
hidden-tab confound, the atomic full-res swap. All of that was real and all of it shipped. But the
symptom kept coming back for one reason nobody connected: at fixed full quality every source was on the
`<video>` element path, where each element seeks on its own schedule and no barrier can make them
arrive together. The barrier was working; it was being handed sources it could not synchronise.

The USER made this connection, not the instruments: *"maybe fixing that fixes our broken frames for
different media that updates in different time when paused."* It did.

**Rule.** *When a symptom survives every fix aimed at it, suspect the environment the fix runs in.*
Four correct fixes to the coherence machinery could not close this, because the machinery was never the
problem — the media path underneath it was. A fix that is right and does not help is evidence about
where you are looking, not about the fix.

**New, smaller, open.** 700–900ms to settle after a pause. That is the barrier doing its job — holding
until every source converges, then presenting one coherent frame — but the convergence itself is slow.
Now that the sources are pooled rather than element-driven, this is a decode-latency question
(first-frame seek cost per source at the paused position), not a synchronisation one. It is a
materially better problem than the one it replaced: a uniform wait reads as "loading", where a stagger
read as "broken".

## v32w — a retimed loader is the one consumer session sharing cannot serve (2026-07-29)

**Reported:** "its lagging so much while timespeed is added."

**Mechanism, known by construction rather than found by measurement.** A promoted host MediaIn
(v-TimeSpeed, see editor-ui) reads the HOST'S OWN url — `resolvePlaybackUrl` keys off the asset, so
host and loader resolve byte-identically, including the same ingest proxy. Same url, same session key.
The pool therefore attaches them: `canAttachToSession(hardware, wantsSoftware) === true`, which is
correct and deliberate for an un-retimed loader (v32l — one decode feeding two consumers).

Under a retime it inverts. The two members ask for `t` and `t·S + O`, which are seconds apart. Neither
`session.pending` nor `session.lastServed` can match for either of them, so BOTH fall to the else
branch and force a fresh `getFrame` on ONE decoder — a seek, and at far-apart timestamps a seek is a
whole GOP. Two full seeks per frame, on the shared hardware session, with the host on it.

`noteDivergence` does catch this: four consecutive diverged frames and the later joiner is detached.
But four frames of double-seeking is already a visible stall, and the toll is paid AGAIN every time the
session is rebuilt — seek, preempt, quality change, remount — which under scrubbing is continuous.

**Fix: declare it.** `AcquireOptions.exclusive` skips `findAttachableSession` and marks the created
session `shareable = false`. Both directions, because skipping the join only stops this consumer taking
someone else's session — leaving its own shareable would let the host attach from the far side and
reproduce the identical divergence. Set by `VideoPreview` for a virtual loader with a non-unit
`speed`/`speedKeyframes`; un-retimed loaders share exactly as before.

*Rule: when a runtime detector exists for a condition you can know statically, declare the condition —
do not let it be discovered.* `noteDivergence` is a good backstop for a divergence that EMERGES. A
0.5× loader of the host's own file is not emergent: it asks for `t/2` precisely because the host asks
for `t`, and that is knowable before the first frame is decoded. Paying four frames of thrash per
session lifetime to rediscover a fact the graph already states is a design error, not a tuning problem.

**Gated.** `wcpool:test` 75/75 (+4): an exclusive acquisition never joins, nothing attaches TO it, and —
the guard against over-correcting — an UN-retimed loader still shares one decode with its host.

**Not yet measured, and stated plainly:** this removes a collision that is certain from the code. The
OTHER cost of promotion is inherent and unmeasured — a retimed host MediaIn decodes and grades the
clip a second time (the copy carries the host's effects deliberately: a retime must not strip the
shot's grade). If lag survives this fix, that doubling is the next suspect and `?flarexProfile=1` plus
`__rfWcPool` is what distinguishes them. Shipping the feature without measuring its cost was the
mistake; the fix for that is a measurement, not another guess.

## v32x — the frame pipeline was never the problem: decode demand scales with retime rate (2026-07-29)

**The measurement ended two wrong theories at once.** Profiler across ~60 frames with a TimeSpeed live:
GPU 15.7–17.8 ms, CPU 2.3–5.9 ms. That is the *ordinary* floor (v-flarex-performance: "GPU 15–19 ms is
the real floor"). So the compile side is not elevated and neither is the composite — **the doubled
decode-and-grade of a promoted host MediaIn, which I named as the prime suspect, costs nothing
visible.** Whatever is wrong is not frame COST.

What is wrong is in the same report: `media LOST SOURCE — no frame for 6f / 125ms (decoder
dropped/preempted)`, `RECOVERED after 7f / 181ms`. And the founder's symptom, which is the whole
diagnosis in one sentence: *"even in the speed of 2x or 10x it plays at 1x, but jitters and updates its
time in between."*

**That is starvation, and it is what `tolerateLag` looks like from the outside.** A loader that cannot
keep up presents the latest advancing frame rather than freeze-holding (v30, deliberate). Under a
retime that reads as: picture crawls at roughly real time, then jumps when a seek finally lands. The
node is not being ignored — the decoder is being outrun.

**Why it is outrun: decode demand is multiplied by the rate.** A seek-on-demand provider decodes from
the nearest keyframe to the requested time. At rate R the requested times are R× further apart every
frame, so it decodes ~R× the frames per displayed frame. This is not a constant overhead that
optimization removes; it is the shape of the work.

`__rfWcPool` says the loader was carrying that alone, in software: `active: 1, activeSoftware: 1` —
the single live WC session is the SOFTWARE one, so the host was not on WebCodecs at all (element path,
which means `preferNativeDecode` was true, which means `mediaUrl !== proxyUrl` — **the host is playing
the ORIGINAL, no ingest proxy**). So the actual configuration was: software H.264 decode, of an
original full-res file, seek-on-demand, at 2–10× real time. That cannot work, and no amount of
compositor work would have made it work.

**Fix: stop paying a throughput compromise on the one consumer that cannot afford it.**
`preferSoftwareDecode` exists to keep the hardware block free for the host — a trade of throughput for
non-contention that was measured fine at 1×. It is now applied only at rate ≤ 1. A retimed loader takes
hardware, and it is already `exclusive` (v32w), so it is one extra stream, not a share.

Loaders at 1× — every loader that existed before TimeSpeed — are bit-identical to before, which is the
guard against re-opening the multi-source freeze this flag was built for.

`__rfFlarexLoaderRate` publishes the per-loader rate, declared EAGERLY at module scope: empty = this
build knows about rates and saw none, absent = the build predates them. The same presence-test
discipline that a voided A/B round taught this file.

*Rule: a symptom that scales with a parameter is a budget problem, not a bug.* "Lags with TimeSpeed"
invited a hunt for something newly wrong. "Plays at 1× at both 2× and 10×" says the consumer is
saturated and the rate is the axis. The second sentence was worth more than the whole profiler dump —
and it came from the founder, not the instrument.

**Still open, and named honestly:** at high rates on long-GOP ORIGINAL media this will not be real time
even on hardware — every NLE answers that with optimized media, and ours is the ingest proxy, which
this asset does not appear to have. Whether that is "no proxy was built" or "a proxy exists and the
retimed loader is not using it" is the next question, and `__rfSourceMap` answers it.

## v32y — the residual stutter was a retry loop with no bound, not decode and not GPU (2026-07-29)

**Decode is fixed and verified.** Post-rebuild `__rfFlarexLoaderRate` = `{loaderA: 1, loaderB: 2}` (so
the bundle IS the bundle), and the 2× loader moved `element`/**stale** → `wc-hw`/**ok**, staleMs 0, all
three sources advancing, no `LOST SOURCE`. The 1× loader stayed `wc-sw`, untouched, as intended.

**Two theories died on the way here, both mine.** The doubled decode-and-grade of a promoted host
MediaIn: GPU 15.8–18.6 ms, CPU 3–5 ms, compile 2 ms of a 20 ms frame — invisible. Long-GOP originals:
`__rfSourceProxy.recent` says the only skipped asset is `source small enough (gop p95 12f / max 12f
over 300f)`, which is keyframe-DENSE and correctly skipped. Both were plausible and both were wrong.

**What the data actually said, in a column I nearly scrolled past.** Per-source frame versions across
62 composites: host v41→v95, the 1× loader v54→v116 — exactly one new frame per composite each. The 2×
loader: **v1820 → v6154, about 70 per composite.**

It is not decoding 2× faster, it is publishing 70× more. Every publish bumps `frameVersion` and calls
`sceneSink.onFrame()`, which re-arms a scene recomposite. That is the stutter.

**Why it never converges.** A seek-on-demand provider trails its request by roughly one decode; at rate
R that trail is R× further in SOURCE seconds. So a 2× loader sits permanently above `WC_HOLD_LAG_S`,
and the lag-tolerant branch — correctly, per v30 — presents and re-arms *every* pass. The re-arm was
paced by a macrotask (v32-era fix, microtask → macrotask), which bounds latency but not RATE: the loop
then runs as fast as the event loop will turn it.

**Fix: pace a SELF-DRIVEN retry to the display.** A layer can show one frame per composite; a retry
that outruns the display is manufacturing frames nothing will ever see. `wcRerequestPaceRef` marks a
re-arm as `"frame"` (rAF) when the layer is re-asking on its own behalf, `"task"` when an outside
request arrived mid-decode. Never freeze-hold is intact — it still pulls continuously and still
presents the latest advancing frame, once per display frame. A converging source never sets the flag.

**Scoped to the playing lag-tolerant branch only.** The two catch-up HOLD branches re-arm identically
and `__rfWcHolds` climbs ~11/composite in the same capture — but they do not present per pass, so they
churn nothing, and they are the paused-recovery path where an rAF pace would stall in a hidden tab.
Named here, not "fixed" on the strength of a neighbouring diagnosis.

*Rule: a bounded budget is not a bounded rate.* The macrotask yield was the right fix for main-thread
occupancy during a scrub and it is still right. It just never claimed to limit how OFTEN a self-driven
loop re-enters — and for a consumer that can never converge, "as fast as the loop allows" is the same
spin the yield was introduced to stop, one level up. Whenever a retry can be permanently unsatisfiable,
pace it to the thing that consumes its output.

## v32z — the hold policy measured lag in SOURCE seconds and compared it to a viewer tolerance (2026-07-29)

**Report:** one comp, two MediaIns on the SAME file — right plume at 1× smooth, left plume at 2×
"freeze play". Same asset, same decoder mode, same everything except the rate. That control is the
whole diagnosis: nothing about the file, the proxy, the GPU or the compositor can differ between them.

`lastFrameLagSeconds` is measured in **source** seconds — requested source time minus the served
frame's own timestamp. `WC_HOLD_LAG_S` (0.35) is a tolerance for how far behind **the viewer** the
picture may fall. Those are the same quantity only at rate 1. At rate R a physically identical delay of
one decode reads R× larger, so the 2× loader crossed a 0.35s bar at 0.175s of real lateness, sat
permanently on the lag-tolerant branch, and presented stale-but-advancing frames forever — which is
exactly what "freeze play" looks like from the outside.

`stalenessSeconds` in `temporal-coherence.ts` already states this rule and applies it: *"Playback rate;
converts source seconds to timeline seconds so sources are comparable."* The hold POLICY never got the
same treatment, and there was no reason to notice: until TimeSpeed, no preview source ran at a rate
other than its own clip's, so the file's own `speedFactor` had nothing to disagree with.

`lag` is now normalized by `|speed|` for every THRESHOLD comparison. `sourceLag` stays raw and is the
only value allowed near `servedSourceTimeRef` — that ref is a source time and feeds `stalenessSeconds`,
which divides by the rate itself; stamping it normalized would divide twice and under-report staleness
to the coherence gate. A gate that reads clean while the picture is wrong is worse than no gate.

*Rule: when a constant is compared to a measurement, check they are in the same UNITS — especially when
a neighbouring file already documents the conversion.* The correct treatment was written down, tested
and shipped one directory away; this site simply never needed it, so the mismatch sat dormant until a
node made rate a per-source property. New feature, old latent bug, and the feature is only the thing
that made it reachable — the retime did not break the hold policy, it revealed that the hold policy had
never been rate-aware.

**Also from this round:** `__rfWcHolds` is `undefined` in a fresh session, confirming the non-tolerant
hold branches (v32y, deliberately left alone) are not firing at all here. The earlier count of ~11 per
composite came from a session that had been scrubbed. Nothing to chase there yet.

## v33a — the lag was manufactured by an unclamped request, and the retry loop turned it into a stall (2026-07-29)

**Founder, correctly: "first diagnose confirm and tell me the reason, do not assume."** Three rounds
had each fixed something real and left the symptom. This one is confirmed by three independent
instruments agreeing, before any code changed.

1. `[perf] STALL 1582ms — 53× scheduleWcRerequest`, 7× `requestWcFrame < fire`, 5× `getFrame`. The
   main-thread block IS the retry loop; the profiler named it.
2. `Element reloads/seeks: WcHolds 658265`. Six hundred fifty-eight THOUSAND hold decisions.
3. `Live-freeze watchdog: worst 18.47s behind · ⚠ smoke.mp4 — wc 6.07s behind @ t=3.03s · phase=hold
   playing=false`.

**Root cause: `mapSourceTime` has no ceiling.** It floors at 0 and at −preroll, but nothing clamps the
top. Once the playhead passes a clip's material the requested source time keeps climbing while the
decoder — correctly — serves the last decodable frame forever. `lastFrameLagSeconds` is the difference
between those two, so it grows without bound on a source that is showing exactly the right picture.
**The picture was never wrong. The error signal was.** The hold policy then did precisely what it
should with a permanently-huge lag: hold, re-arm, forever.

`temporal-coherence.ts` had already found and fixed this — for the staleness INSTRUMENT — and wrote
down the rule: *"a request outside the material in EITHER direction is served by the nearest real
frame, and that frame is correct."* Its own header records the same false reading (every source
"11–19s stale at once", diagnosed as "four simultaneous decoder deaths were never plausible; one
missing clamp was"). The REQUEST path never got the clamp, so the instrument read clean while the
policy fed by the same quantity spun. Now clamped at `decodableEndSeconds` — same value, same source
of truth, applied where the lag is generated.

**Why a retime found it:** at rate R a clip runs off the end of its material R× sooner. 2× reached in
seconds what 1× needs minutes of tail to reach. TimeSpeed did not create this bug; it made it fast.

**Second fix, now evidence-backed:** the catch-up HOLD branches are rAF-paced too. v32y left them on
task pacing with the explicit note "I have not measured them doing harm" — the stall profile is that
measurement. Not presenting per pass is not the same as not costing. With the clamp in place this is
defence in depth: a future non-convergent state degrades to one retry per displayed frame instead of
saturating the main thread.

### How real NLEs avoid this class entirely (founder asked; researched rather than assumed)

Avid's off-speed playback patent describes the shape: read at least one complete GOP into a
**compressed data buffer**, build a **frame ring** describing each image in it, and play from the
ring — plus a SECOND stateless single-frame decoder used specifically for off-speed playback, distinct
from the sequential decoder used at 1× or slower. Resolve/Premiere are the same family: decode ahead
into RAM, play out of a buffer.

The structural difference is not the decoder, it is the direction of control. Ours is PULL: the
compositor asks for a frame at time t, one decode in flight, and when the answer is late the layer
retries. A retime multiplies the demand that design was tuned for, and every failure mode becomes a
retry loop. A read-ahead ring is PUSH: the decoder runs ahead on its own schedule and playback reads
whatever is in the ring, so being late costs a repeated frame, never a retry storm — there is nothing
to retry against.

That is a real architectural gap and it is worth naming as one rather than patching around forever.
The four fixes in v32w–v33a are all correct and all necessary, but they are each "make the pull path
survive one more condition". A read-ahead ring for preview sources would delete the CLASS.

*Rule: when the picture is right and the metric is wrong, fix the metric — and check every consumer of
that metric, not just the one that reported.* The clamp existed. It had been reasoned about, written
down, and shipped for the instrument. Nobody asked which OTHER code paths consumed the same
unclamped quantity, and the hold policy did.

**Gated:** coherence 5666/5666, wcpool 75/75, fullres 203/203, gop 26/26.

## v33b — "same playhead, different host": the fall-back was showing a different MOMENT (2026-07-29)

**The report was a correctness bug, not a performance one**, and it explains why four rounds of decoder
work never landed. Two screenshots of one clip at one playhead showed two different frames of the
shot — sun in frame in one, not in the other. No amount of decode tuning produces that; only drawing
the wrong time does.

**Mechanism, confirmed in code.** `compile-flarex.ts`'s `mediaIn` ends with an unconditional
`return cloneImage(ctx.hostSourceDraw)` whenever the resolver answers null. `buildLayerDraw` returns
null on exactly one relevant condition — *the graded canvas has not landed yet* (it is one of only two
`return null` sites, and the file names them). So on every frame the promoted loader's canvas was late,
the MediaIn drew the HOST at the PLAYHEAD instead: an un-retimed frame, spliced into a retimed clip.
Two moments alternating at decode-jitter frequency. That is the judder.

**Fix: a third resolver answer.** `"pending"` = a loader OWNS this node and has no picture yet, as
distinct from null = no loader owns it. `build-scene-draws` can tell them apart (it looks the virtual
layer up before building) and now says which. Under a transform, `"pending"` produces NOTHING.

**Scoped to a transformed context, and the pixel gate is why the first version was wrong.** Dropping
the fall-back for EVERY unready loader is what a purist would do. It is also wrong: the two renderers
do not become ready on the same frame, and without a retime the host draw is the SAME MOMENT — a
genuine soft-degrade that holds them together. `activeTimeSeconds !== ctx.timeSeconds` is exactly the
question "is `hostSourceDraw` from the context I am evaluating in?", needs no new plumbing, and is
true only under a transform.

**`flarex-generators` is FLAKY — bisected, not assumed.** It read 86.895% after this change, which
looked like the scoping failure above. It reads 86.895% at `0e6792a`, before any TimeSpeed work
existed, and 0.000% twice in a row with the change in place. 86.9% is the whole frame: one side has
the generator, the other does not — a raster-readiness race in the harness. Recorded here rather than
chased, and NOT to be read as a signal next time it flickers.

*Rule: when a symptom survives every performance fix, stop asking why it is slow and ask whether it is
correct.* "Freeze play" sounded like a decode budget and got four rounds of decode work — all of which
were real bugs, none of which was THIS one. The founder's screenshot pair asked a different question
("why are these two frames different?") and it took one code read to answer. A symptom described in
performance language is not evidence that the cause is performance.

**Gated:** flarex:test (+3), pixel gate flarex fixtures 0.000% (generators 2×), compproxy, cache-gate,
coherence 5666/5666, both typechecks.


## v33c — the playhead lies during PLAYBACK; pause is only where the truth arrives (2026-07-29)

**Founder report:** "when I pause, the playback is paused but after a fraction of a second it tries to
render 5-6 frames later… one playhead should not lie, it should always render the exact frame." Present
since the beginning, assumed to be by design until browser NLEs and Premiere/Resolve were checked and
none of them do it. Both the editor and the Flarex viewer.

**The framing that unlocked it: nothing is wrong at the pause edge.** Paused, every source converges on
the exact requested time — that part already worked, and it is *why* the jump exists. Three independent
slacks let the presented picture sit BEHIND the transport during playback, all of them forward-biased,
and pausing collapses all three at once. The correction is the visible event; the error is upstream of
it. This file's own v30 states the policy outright ("PLAYING = SMOOTH, PAUSED = COHERENT") and
`VideoPreview.tsx:3129` already documents the 2026-07-03 version of the same report — the fix that
shipped then BOUNDED the error at 0.15s rather than removing it, which is why it came back.

The three, with the numbers that were actually measured this round:

1. **WC served frames presented while behind** — `WC_HOLD_LAG_S = 0.35` (≈10 frames at 30fps),
   unbounded for `tolerateLag` loaders, which is why Flarex is the worse of the two pages.
2. **`<video>` element free-run** — corrected only past 0.15s, and only every 500ms.
3. **Pause committed the raw wall-clock anchor** — up to one `playbackCommitIntervalMs` (40ms
   balanced / 90ms performance) ahead of the last time the viewer had rendered, and **off the frame
   grid**: pause was the ONLY transport path that never quantized. Measured live at 39.9ms of commit
   lag, parking at 3.354700s — between frames 100 and 101.

**Shipped: #3 only, because only #3 is defect.** #1 and #2 are trade-offs bought with real scar tissue
(v30's host-starvation freeze, the 2026-07-16 seek-storm tab hang), and tightening either on a hunch is
how this file fills up. `quantizeToFrameGrid(t, "nearest" | "current")` now owns both grids: a SCRUB
takes the frame nearest the pointer (unchanged), a STOP takes `floor(t·fps)` — the frame that was on
screen, since rounding parks on a frame the user never saw. `parkTransportAt` is now the single stop
authority; the playback effect's `!isPlaying` branch used to park at the COMMITTED clock while the
spacebar path parked at the LIVE anchor, two authorities that could disagree by a commit interval.

**A/B, same media, same session:** without the fix, parked 3.354700s, off-grid, commit lag 39.9ms. With
it, parked 4.300000s = frame 129 exactly, and the commit/live split at the stop reads 0.0ms. The gate
FAILS on the old code and PASSES on the new — a gate never seen to fail is not evidence.

**New instrument: `pnpm --filter @orreris/worker pause:gate`** (`pause-coherence-gate.ts`), plus
`window.__rfClock` (committed + live at full precision — the on-screen readout is `toFixed(2)`, which
cannot resolve a frame at 30fps, so nothing outside React could check grid alignment at all).

*It asserts on two axes and refuses to conflate them,* which is v-full-res-rendezvous' lesson applied a
second time: a pure pixel diff across the pause edge sees the full-res settle (300ms–3s, by design) and
the time jump in one number and can never separate them. So TIME is asserted with the resolution-blind
instrument (`__flarexCoherence` staleness, recorded regardless of the hold flag) and pixels are a
reported artifact, not the bar.

**Residual, named honestly.** Worst staleness during playback measured 79.5ms (2.4 frames) on the
`[element]` path in one run, 29.3ms in another, 0.0ms in a third — n=3, high variance, freshly-created
projects. That is a distribution to gather, not a threshold to act on, and Phase 2 (tightening #1/#2)
is deliberately blocked on it. The pixel axis read 0.000% in every run, which proves LESS than it
looks: the capture starts after the pause click round-trip, by which time the correction has landed.

**Two blind spots in the new instrument, stated before they mislead someone.** `maxStalenessSeconds`
excludes `awaitingFrame` sources — a source with NO decode for the requested time has no served time to
subtract, so it scores 0ms while being the worse state. One run read "0.0ms worst" beside
`escapeHatches=54/58`; the gate now says so out loud instead of letting the headline read clean. And
62% escape hatches in a healthy-looking run means **most frames presented during playback are not the
frame the playhead names** — the barrier is off by design, so this is the policy working as written,
which is exactly the thing worth deciding about rather than discovering.

*Rule: when a correction is visible, suspect the state it corrects, not the correction.* Four separate
rounds treated the pause snap as the bug and bounded it; it is a symptom of a playback model that
presents frames the playhead does not name. Bounding a lie makes it smaller, not true.

**Open, and requiring a decision rather than more code:** #1 and #2 cannot be removed by moving the
playhead — the pixels are stale relative to ANY transport time. Real-time playback off a
seek-on-demand decoder is structurally offset (request T, decode 100ms, present at T+100ms). The escape
is read-ahead into a presentation queue so lag degrades into DROPPED frames (correct time, judder)
instead of OFFSET frames (smooth, wrong time) — which is what Premiere and Resolve actually do, and it
would retire `tolerateLag` entirely. That is an ADR, not a patch.

## v33d — the residual, measured: p50 ≈ 4 frames, tail ≈ 20 (2026-07-29)

**Supersedes v32y's residual estimate.** That entry reported n=3, "79.5 / 29.3 / 0.0 ms, high variance,
a distribution to gather". It was gathered. The gate now runs N play→pause cycles in ONE warm session
(`PAUSE_GATE_CYCLES`), walking the timeline so each cycle samples different material instead of
replaying one warm second.

Two independent runs, different media, 16 cycles each, same box, same session shape:

| | p50 | p90 | max | hatches |
|---|---|---|---|---|
| 26MB source | 163.6ms (**4.9f**) | 407.0ms (12.2f) | 527.7ms (15.8f) | 71% |
| 107MB source | 128.1ms (**3.8f**) | 348.1ms (10.4f) | 684.6ms (20.5f) | 65% |

**The founder's "5-6 frames… or 3-4, I can't exactly tell you" is the p50, and the reason it could not
be pinned is the spread.** Both runs agree to within a frame at the median and disagree by 5 frames at
the tail, which is the shape of a stall distribution, not a constant offset. 32/32 parks landed on the
frame grid (unambiguously 30fps), and the parked commit/live split read 0.0ms every single cycle — the
v32y fix holds across the timeline, on both sources, warm and cold.

**The offender is the ELEMENT path in both runs, and the tail exceeds every documented bound.** 527ms
and 684ms are past `WC_HOLD_LAG_S` (350ms) and 3–4× the element corrector's 0.15s threshold. That is
not a contradiction, it is the mechanism: **0.15s is not a bound on drift, it is a bound on drift AT
SAMPLE TIME.** The corrector is a 500ms `setInterval`; between samples nothing bounds anything, so a
single ~0.5s decode stall lands whole and is only clipped at the next tick. A threshold sampled at 2Hz
cannot bound a transient shorter than its own period.

*Caveat that decides what this data can be used for:* both runs were freshly uploaded originals with
**no ingest proxy built yet**, so `preferNativeDecode` was true and the host sat on `<video>` (the
v32x configuration). This characterises the ELEMENT path. The WC path — where `WC_HOLD_LAG_S` is the
actual governor — is NOT characterised by these numbers, and a project whose proxies exist may sit in a
different regime entirely. `PROBE_EDITOR_URL` points the gate at a real project for exactly that.

**Gate semantics split, deliberately.** GRID fails hard forever (it guards what shipped). TIME is
advisory by default with a banner, `PAUSE_GATE_STRICT=1` to enforce. Failing the whole run on a
residual we knowingly deferred would conflate "you regressed" with "the known baseline is still there",
and would make the gate useless for catching a GRID regression in the meantime. Flip the default when
Phase 2 lands.

**Three bugs in the instrument, found by using it — worth recording because each one flattered the
result.** (1) `gridFps` returned the FIRST matching rate, and 3.500000s sits on the 24, 25, 30, 50 and
60fps grids at once — it reported 24fps and converted 156ms into "3.8 frames" when the honest answer
was 4.7. Fixed by intersecting candidate sets ACROSS cycles; only the true rate divides every park.
(2) The pixel phase clicked Pause after playback had already auto-stopped at the composition end, and
waited out a 30s timeout on a transport that was already parked. (3) A fixed 6s wait for the upload
metadata probe was enough for 26MB and not for 107MB, surfacing 40s later as an unexplained navigation
timeout. All three are the same error: *guessing at a state instead of waiting for it.*

*Rule: an instrument's first job is to fail. Three runs that all passed said nothing; the run that
resolved 32 cycles said the median is 4 frames and the tail is 20.*

## v33e — Phase 2: faster detection buys the BODY and costs the TAIL (2026-07-29)

**Change.** The element drift corrector (`VideoPreview.tsx`) did detection and correction on one
500ms `setInterval`, so its 0.15s threshold was only ever a bound on drift AT SAMPLE TIME (v32z).
Split them: SAMPLE at 100ms (`video.currentTime` is a free numeric read, no decoder involvement),
SEEK no more often than every 500ms (`MIN_CORRECTION_INTERVAL_MS` — the old rate, now explicit
instead of inherited from the sample period). The 0.15s trigger is UNCHANGED: v32z measured p50
drift sitting right on it, so it is exercised bound, not headroom. Telemetry `__rfDriftCorrections`.

**Measured, before → after, worst staleness per cycle:**

| source | p50 | p90 | max |
|---|---|---|---|
| 26MB (n=16) | 163.6 → **124.6** | 407.0 → **345.3** | 527.7 → **387.2** |
| 107MB (n=16) | 128.1 → **91.9** | 348.1 → **192.7** | 684.6 → *878.8* |
| 107MB (n=32, ×2) | → 107 / 149.7 | → 207 / **209.1** | → *939 / 751.7* |

**The body improved and the tail got worse, and both are reproducible.** p90 on the heavy source fell
from 348ms to ~200ms across THREE post-change runs (193/207/209 — tight), and p50 improved or held on
both sources. But the heavy source's max went 685 → 752/879/939 across those same three runs. That is
not one noisy extreme; it is consistent.

**Why, and it is the interesting part.** `__rfDriftCorrections` says the corrector is nowhere near
seek-storming: **0.09–0.21 seeks/sec** over 48–96s windows, with the min-interval floor refusing 0–10.
So the change did NOT add seek pressure — the 2026-07-16 tab-hang failure mode is not in play. But the
corrector also reports the worst drift it SAW at 790–981ms, i.e. it watched drift an order of magnitude
past its own threshold without acting on it, because the effect returns early on
`video.seeking || readyState < 2` — **it is blind exactly while a correction is in flight, and a seek
on a heavy long-GOP original takes a long time to land.** Detect sooner ⇒ seek sooner ⇒ more time
inside blind windows on the material where seeks are slowest. We bought the body with the tail.

*Rule: a corrective seek is not free feedback — it is a blind interval whose length scales with the
media it is correcting.* Sampling faster improves anything the corrector can fix quickly and worsens
anything it cannot, so on hard sources faster detection is a tail RISK, not a tail fix.

**This is Phase 3's argument, arrived at empirically rather than by reasoning.** Seeking is the wrong
correction primitive for staying aligned during playback: every correction costs a blind window
proportional to decode difficulty. Read-ahead into a presentation queue removes the need to correct at
all, and it is the only thing that can take the tail down. `WC_HOLD_LAG_S` was NOT touched — v32z's
data characterises the element path only, and there is still no WC-path measurement to justify moving
it.

**Kept, not reverted, and the trade stated plainly:** the typical pause (p50/p90 — what the founder
actually reported) is meaningfully better on both sources; the rare worst case on heavy originals is
worse. Reverting is a two-constant change if that trade is judged wrong.
## v33f — S0 built; the verdict is DEFICIT and it does not yet decide anything (2026-07-29)

**Built** `apps/web/src/playback/readahead-probe.ts` — slice S0 of `plans/preview-readahead-ring.md`,
whose own gate reads: *"if headroom is already negative on the founder's machine, a ring buys
ordering, not smoothness, and that changes the pitch."* Inert unless `?previewRing=probe`.

**Hooked at the COMPOSITE, not at `getFrame`, and that choice was load-bearing.** The obvious seam is
`requestWcFrame`'s completion — but v33d found the editor's host clip on the `element` path the whole
time (fresh original, no ingest proxy, `preferNativeDecode` wins). Instrumenting `getFrame` would have
measured an empty seam and reported a confident zero. `ScenePreviewMediaSnapshot` is the one layer
where both decode paths look alike, so `frameVersion` advancing IS a frame delivered, whoever decoded
it. Verified rather than assumed: on the element path rvfc → `drawVideoFrame` → `publishSceneFrame`
bumps the version once per presented frame.

**Measured (headed, 107MB original):** delivered **6.8/s** against demand **48/s** → headroom
**−41/s**, worst lead −0.939s, 69% empty reads. Lead is ≤0 by construction in a pull design — nothing
is decoded before it is asked for — and making it positive is the ring's entire purpose, so that is
the right before-picture even though the number is trivially signed.

**HEADLESS WAS INFLATING EVERYTHING, including v33d and v33e.** Playwright launches headless by
default and headless Chrome has no GPU, therefore no hardware video decode. Same source, same cycles:
headless delivered 3.9/s and p50 135ms; headed delivered **6.8/s** and p50 **83ms**. Nearly double the
delivery and nearly half the staleness. Every figure published in v33d/v33e was taken headless and
**overstates the real problem** — `PAUSE_GATE_HEADED=1` added, and those runs need repeating before
anyone quotes them. Third instrument-trust failure in this sequence, and the same shape as the
`react-dom.development` one: *verify the harness is the thing you think it is before believing its
output.*

**The verdict does not decide anything yet, and saying otherwise would be the real error.** DEFICIT
was measured on a freshly uploaded original with **no ingest proxy** — the exact configuration v32x
already concluded "will not be real time even on hardware". Real projects run on proxies. So S0
currently says *"a ring cannot fill on unproxied originals"*, which nobody doubted, and it says
nothing about the steady state. **S1 is NOT justified by this run.** What would justify it: S0 on
proxied media, and S0 on a Flarex comp (the `tolerateLag`/WC half, still uncharacterised).

*Rule: a gate slice that returns the answer you could have predicted has not run yet — it has run on
the wrong input.*

D1 (byte budget), D2 (thread), D3 (ownership) remain open founder decisions per the plan §3; nothing
has been built that presumes any of them. Live checklist: `PAUSE_COHERENCE_TODO.md`.

## v33g — S0 on the PROXIED/WC path: the premise is closer than the element runs suggested (2026-07-29)

**The run v33f said was missing.** `PAUSE_GATE_WAIT_PROXY=1` waits for the decode path to leave
`element` (polling `__rfSourceMap`, nudging with a paused seek because proxy builds suspend during
playback), so the gate finally measured the STEADY STATE instead of the import. Source came up
`wc-hw` — the first WebCodecs-path measurement in this whole sequence.

**Proxied/WC vs unproxied/element, same media, headed:**

| | element (no proxy) | **wc-hw (proxied)** |
|---|---|---|
| empty reads | 69–79% | **6%** |
| escape hatches | 59–88% | **10%** |
| delivered | 3.9–6.8/s | **21.3/s** |
| staleness p50 | 83–135ms | 190.7ms |
| p90 / max | 574 / 939ms | **292 / 292ms** |
| element corrector | 0.28–0.40 seeks/s | **0** (correctly — not that path) |

**Two things flip at once, and they point opposite ways.** Coherence transforms: empty reads collapse
from ~70% to 6%, hatches from ~88% to 10%, and the tail from 939ms to 292ms — the alarming figures in
v33d/v33e were substantially a measurement of *unproxied originals*, not of the product as used.
But p50 staleness gets WORSE (83–135 → 190.7ms), and the tail, while far tighter, still sits at 8.8
frames. A proxied source is far more CONSISTENT and not obviously more current.

**A flaw in my own probe, stated because it changes the verdict's magnitude.** `demandFps` is the
COMPOSITE rate (40.5/s), but a 30fps source can never deliver more than 30 new frames/sec — the extra
composites redraw a frame that is still correct. So headroom against composite rate overstates the
deficit: 21.3 vs 40.5 reads −19.2/s, while the honest shortfall against the source's own 30fps ceiling
is **−8.7/s**. Still negative, so the verdict does not flip — but "can't keep up by a factor of two"
and "delivers 21 of a possible 30" are different claims, and only the second is true. Carrying nominal
fps onto the snapshot would make this exact; documented in `SourceHeadroom.demandFps` as the follow-up.

**Verdict, honestly: still DEFICIT, but narrowly, and on one source.** A ring cannot fill from a source
already 8.7fps short of its own ceiling — it would inherit the deficit. What a ring would still buy is
what v33f said: ORDERING and BOUNDED failure, which the 6% empty-read figure suggests is a smaller
prize on proxied media than the element numbers implied. **S1 is still not justified**, and the reason
has moved: not "the decoders are hopeless" but "on the configuration users actually run, the pull path
is already at 90% coherence and the remaining 10% is a decode shortfall a ring cannot manufacture
frames to cover."

*Rule: measure the configuration users run before designing for the one they don't.* Four rounds of
alarming numbers came from freshly imported unproxied originals — a state that exists for seconds.

**Not yet measured, and the last real gap:** a Flarex comp (multi-source, `tolerateLag`, where
`WC_HOLD_LAG_S` actually governs and lag is presented unbounded). One source on `wc-hw` is not the
contention case the ring plan was written for.

Instrument note: `worstLead −13.5s` in that run is an artifact — the probe accumulates across the
proxy-wait phase, whose seeks are legitimate transport jumps, not decode deficits. Reset the probe
after the wait before reading lead.

## v33h — the S0 verdict flipped twice before the instrument was right (2026-07-29)

**Do not read v33f/v33g's headroom figures. They were wrong in two independent ways**, and the
sequence is worth keeping because each error looked like a result:

| # | delivery counted as | demand measured as | verdict |
|---|---|---|---|
| 1 (v33f/g) | publishes | composite rate | −19.2/s DEFICIT |
| 2 | publishes | min(composite, source fps) | **+13.5/s SURPLUS** |
| 3 (this) | distinct frames on the source grid | min(composite, source fps) | **−9.9/s DEFICIT** |

**Reading 2 is the instructive one: it flipped the plan's gate to GO on a number that was impossible
on its face** — 43.5 delivered/s from a 30fps source. Nothing can deliver more frames than it has.

**Error A — demand was the COMPOSITE rate.** The compositor runs at ~57/s; a 30fps source cannot
deliver more than 30 distinct frames/sec no matter how often it is asked, and the composites in
between redraw a frame that is still correct. Fixed by carrying `nominalFps` onto
`ScenePreviewMediaSnapshot` and capping demand at `min(composite, source fps)`.

**Error B — delivery was PUBLISHES, not frames.** `frameVersion` increments on every publish, and the
WC path republishes on each completed request including ones that returned the frame it already held.
Carrying `servedSourceTime` fixed only half of it: that value is stamped `sourceTime - lag`, and both
terms drift continuously, so the same decoded frame reports a slightly different served time every
republish — still 39.1/s. Only bucketing the served time to the source's own frame grid (`round(t ·
fps)`) made "a different frame" mean a different FRAME.

**Error C — `worstLead` was measuring the ruler, not the decoder.** It read −13.4s, which was the
gate's own Home keypress: rewind 13s and every source is instantly "13s behind" with no decoder at
fault. Gating the jump composite alone did nothing (the source stays legitimately behind for many
composites while it re-decodes, and none of THOSE are jumps), so the lead statistic is now suppressed
for a 1.5s settling window after any transport discontinuity.

**The corrected reading, and why it is believable this time.** Proxied `wc-hw`, headed, n=12:
delivered **20.1/s** against a **30/s** ceiling → **−9.9/s DEFICIT**; empty reads 5%, hatches 11%,
staleness p50 193ms / p90 250ms / max 305ms. Two independent sanity checks now pass that failed
before: delivered ≤ nominal fps, and `worstLead` (−0.305s) equals `max staleness` (305.4ms) exactly —
two quantities computed by different code paths agreeing to the millisecond.

**Verdict: DEFICIT, and S1 is still not justified.** The source delivers 20 of a possible 30 frames
per second on the configuration users actually run. A ring cannot manufacture the missing 10 — it
would inherit the shortfall. What it would still buy is ORDERING and BOUNDED failure, and at 5% empty
reads that prize is smaller than the element-path numbers implied.

*Rule: a verdict that flips when you fix the instrument was never a verdict. Sanity-check the
measurement against physics — "delivered > source fps" is impossible, and it sat in the output for
two rounds being read as good news.*

## Phase-0 baseline — the first measured coherence numbers (2026-08-01)
Captured on a real multi-source Flarex project (smoke.mp4 + subject, Channel Boolean → Merge → MediaOut)
with `?kernelDiagnostics=1`, via the ADR-012 S0.3 ledger and S0.2 degradation channel. **These are the
numbers every later slice is compared against — do not re-baseline without saying so.**

    __rfPresentLedger    presented 1575 · coherent 1398 · incoherent 177
                         incoherenceRate      0.1124      ← 1 present in 9 disagrees
                         worstPresentedStaleness 0.183s   ← 5.5 frames @30fps
                         nonMonotonicPresents 0           ← I-2 already holds
                         holdRate 0.0187 · held-coherence 30 · held-not-ready 0
    __rfFlarexDegradation substitutedTotal 27 across 2 nodes

**What the shape says, beyond the headline rate:**
- `held-not-ready: 0` — the not-ready gate NEVER fired. Every hold was a coherence hold, and those are
  paused-only by design. So during playback nothing is withheld at all: the 177 incoherent presents ARE
  `tolerateLag`, finally measured rather than argued about. This is exactly what S4.6 replaces, and the
  bar it has to beat is 11.24% → ~0 in BOTH transport states.
- `nonMonotonicPresents: 0` is a genuinely useful negative: I-2 needs no repair, so S4.6 can be judged
  purely on coherence without also having to prove it did not introduce reordering.
- 183ms worst-case is well past the point a viewer reads it as "that layer arrived late", which is the
  reported symptom this whole programme started from.
- `substitutedTotal: 27` on 2 nodes confirms the host-clip fallback fires in ordinary use — S4.5 is
  deleting a live construct, not a theoretical one.

**Method note:** the ledger classifies from the stale set itself rather than trusting the caller, and
records holds alongside presents, so a future "improvement" that reaches coherence by simply withholding
more frames is visible as a rising `holdRate` instead of hiding inside a falling `incoherenceRate`.

### Baseline correction + causal chain, second capture (2026-08-01)
A longer session materially changed one conclusion and demonstrated the sink's main design goal.

**CORRECTION — paused incoherence is NOT negligible.** The first 20s capture read 103
`incoherent-present-playing` vs **1** paused, which read as "paused is already coherent". At session
length it is 1918 playing vs **508 paused**. The earlier reading was a short-sample artifact. Cause is
known and expected: the coherence barrier ships OFF (`?flarexCoherence=1`) because the 2026-07-28 soak
found sources routinely fail to converge inside the 1.5s budget, so a stale paused frame is simply
presented. **S4.6 must move both transport states**, and the paused half cannot be assumed solved.

**Causal chain, visible for the first time.** Two degradation rows, same node-comp, same count (51),
same `firstAt` to 0.1ms:

    source-ended    node n_msaigz2p_ojcl   count 51   firstAt 534478.3
    input-missing   node n_msaiha2g_c7yb   count 51   firstAt 534478.3

The smoke MediaIn (16s asset) ran past its own duration inside a longer comp and produced nothing; the
node downstream reported a missing input. That is the DESIGNED soft-degrade for a short clip in a long
comp — correct behaviour, and the first time the cause and its consequence have been joinable at all.
Exactly the join the audit had to do by hand across four keying schemes.

**Reviewer note:** `input-missing` is a CONSEQUENCE here, not an independent fact. A reader scanning
the summary could chase the downstream node when the cause is the source ending. Degradations do not
carry causality today; adding it is a real improvement and deliberately out of scope — noted so nobody
mistakes the derived row for a second bug.

---

## v33 — the 62% incoherence baseline is REAL, and the cause is a documented trade-off (2026-08-01)

**Problem.** A real session moved the Phase-0 coherence numbers hard: `incoherenceRate` 0.112 → **0.623**
and `worstPresentedStalenessSeconds` 0.183 → **43.19**. A 43-second coherence error is not credible as
lag, and every Phase 4 slice is judged against these numbers. Suspicion (mine): the media-end clamp had
stopped applying, exactly as in v31a, so a playhead past the material would accrue staleness without
bound — an instrument fault, not a runtime fault.

**That suspicion was wrong, and the way it was killed is the point.** The ledger recorded the clamp's
OUTPUT and never its INPUT, so "the instrument is broken" and "the decoder is wrong" were
indistinguishable in the data. Adding `ScenePreviewMediaSnapshot.mediaEndSeconds` — the same value
`stalenessSeconds` clamps against — made it decidable in one console read.

**What the data showed.** Two populations, not one:

| target | served | staleness | reading |
|---|---|---|---|
| 0.51 | 35.58 | 35.04 | source 35s **AHEAD** — a backward seek still holding its old frame |
| 20.9 | 5.36 | 15.50 | source **pinned** for ~50 consecutive composites, playhead parked |

The arithmetic closes exactly on both, which is itself the evidence the mapping is trustworthy:
`35.580 − 0.512 − 0.0334 (1/29.97) = 35.035` vs 35.0352 reported, and `20.9 − 5.36 − 0.04 (1/25) = 15.50`
vs 15.50 reported — the asset is 25fps, so the frame period that closes the second row is the right one.

**`mediaEnd: 55.08`** on the parked source, with `decode: "element"`. The clamp had a real value, well
past the 20.9 request, so it correctly did not apply. **The artifact hypothesis is dead: the 62% is
real.** The preview genuinely presented frames ~15s away from the requested moment.

**Root cause, and it is deliberate.** `selectVideoDrawSource`'s stale-element guard
(`ELEMENT_FALLBACK_MAX_LAG_S`) is wrapped in `if (wcProviderRef.current)`. With no WC provider the
element IS the primary decode path (`wcDecode` off is still the default), so the guard is skipped by
design — `temporal-coherence.ts` states the reason outright: refusing its frames "would blank the layer
permanently rather than briefly". A pooled element sits wherever its last owner left it, so a warm
lease hands back a frame from another shot until the seek lands, and with no provider nothing refuses it.

**Why this is not a bug to fix here.** The trade-off is real and the alternative (blank the layer) is
worse. It is precisely the construct ADR-012 §0.3 names: scarcity resolved by substituted content
rather than declared absence. **S4.5 deletes it, S4.4 replaces "hold or don't" with `effectiveTime`, and
S4.6 makes both transport states coherent.** The 62% is therefore the honest bar those three must beat,
not a number to be explained away.

**The lesson, which is the same one as v31a with the sign flipped.** There it was a broken rig producing
a false verdict against a sound barrier. Here the rig was sound and the alarming number was true. Both
times the resolution was the same move: **record the INPUT of a computation beside its output.** A
measurement you cannot attribute is not evidence in either direction — it only feels like evidence when
it agrees with you.

**Left open, named rather than fixed:** the element path reported `servedSourceTime: null` at rest while
still reading `state: ok`, and a null served time means `stalenessSeconds` returns null, which never
gates. So a source on the element path is intermittently invisible to the coherence gate. Not chased —
it belongs with S4.2 (`servedTime` end-to-end), where every participant is required to carry one.

## v34 — the fixture that could not fail: co-location is not a cut (2026-08-03)

**Problem.** S4.7 (session satisfaction) shipped flag-off with a *done when* of "zero `noteDivergence`
firings across a soak". Three consecutive A/B runs reported `detaches 0 · refusals 0` in **both** arms —
including the arm with the flag OFF, which still contains the defect. That reads as a pass and is not
one: **a criterion satisfied by the unfixed arm is an absence of evidence, not evidence.**

**Two fixture defects, both silent, both found by looking at the DOM rather than the numbers.**

1. **The second clip was not a second clip.** `addSecondClipOfSameAsset` used the asset bin's
   `Add video only`, which puts the new clip on a **new track starting at zero**. Geometry read back
   from the page: two `.timeline-clip` elements, *both* at `left: 124`, `width: 1599`, differing only
   in `top`. That is one asset playing the same instant twice — **co-location**, the case sharing was
   built for and which by construction can never diverge. The fixture reported a healthy `shared 5`
   while the harm it existed to reproduce was arithmetically impossible.
2. **The run never went near the boundary anyway.** Reachable is not visited. Playback started at t=0
   and the pre-roll shell mounts ~1.2s before a cut, so the crossing sat outside every sample window.

**Fix.** `cutClipAtFraction` — park the playhead inside the clip, select it, `Split at playhead (S)` —
and `seekBeforeCut`, which parks the playhead a fixed lead before the boundary *per arm* (a reload
resets it to 0, so it belongs to the arm, not the fixture). The split's success check is that the two
clips' **left edges differ**, which is exactly what the old helper would have failed.

`seekBeforeCut` does not reimplement the timeline's x↔time mapping; it **calibrates against the editor**
— click the ruler at two known x, read `__rfClock.committed` each time, take the slope. Right even if
the zoom defaults change, and self-checking if the mapping ever stops being affine.

**What the corrected fixture shows.** Two independent runs that actually visited the crossing:

| run | flag | shared | detaches | refusals |
|---|---|---|---|---|
| 18s | OFF | 10 | **2** | 0 |
| 18s | ON  | 6  | **0** | 3 |
| 10s | OFF | 10 | **1** | 0 |
| 10s | ON  | 5  | **0** | 2 |

The asymmetry the slice claims, in both: the defect **reproduces** with the flag off, and the predicate
refuses 2–3 borrows to get detaches to zero. The cost is visible too — shares granted roughly halve.

**Not established, and stated as such.** One run showed p50 fps 37.3 → 70.0 (+88%) with `mediaFps`
1.7 → 27.1 in favour of the flag. **That number is not claimed.** A reverse-order repetition landed
`shared 0` in both arms — the crossing was not visited at all, the probe's own guard voided it, and
media barely decoded in either arm. Run-to-run variance on this fixture is currently larger than the
effect, so the *counters* are evidence and the *frame budget* is not yet.

**Two instrument fixes fell out.**
- The run outlived its material: playback reached the end, `isPlaying` went false, and
  `playbackRenderScale` (`isPlaying ? profile : 1`) snapped to Full while the compositor kept
  repainting the last frame at display rate. Those idle samples mixed a second resolution into an arm
  pinned to Half and fired the comparability guard. The sampler now **stops when the transport does**.
- A fourth VOID guard: if neither arm ever detached *or* refused, say so loudly instead of printing two
  tidy zeroes. That guard is what caught the reverse run.

**Rule.** A fixture must be checked for whether it can *express* the defect, not just whether it runs.
Both failures here produced plausible, healthy-looking numbers — `shared 5`, `detaches 0` — from an
arrangement in which the measured quantity could not have been non-zero.

## v34a — the decoder is not contended, it is ABSENT (2026-08-03)

**Context.** v34's corrected fixture made S4.7's asymmetry visible. It also made something larger
visible, which was not what anyone was looking for.

**The number that redirected the programme.** `mediaFps` across four *identical* runs of one project,
same machine, minutes apart: **45.7 · 27.1 · 8.0 · 1.7**. The compositor held 60–70fps throughout. Decode
collapsed 25× run to run while the picture kept repainting — which is exactly the user's report ("FPS 37,
Media ~50, freeze-play, struggling very hard"), reproducing on demand for the first time.

The budget probe could not say why, because it kept `served` from `__rfSourceMap` and discarded every
field beside it. Decode path, supply state and await reason were already published per composite. The
answer was in the page and not in the report.

**Per-source, one arm (10s, 35 samples):**

| source | decode | state | wcProvider |
|---|---|---|---|
| A | `element` | stale 97–100% | **0%** |
| B | `wc-hw`/`element` | stale 60% · AWAITING 24% · ok 14% | **23%** |

**What this rules out.** The working assumption behind ADR-012 Phase 4 — S4.3 admission, S4.4–S4.6
readiness — is that consumers *compete* for a scarce decoder. Source B has no provider for 77% of
playback and source A never gets one at all. **A slice that arbitrates contention cannot help a source
with no session to contend for.** S4.3 remains a real architectural slice; it is unlikely to move this
symptom.

**One honest deduction about the evidence.** `wcBusy 0%` was initially reported as independent
confirmation that the decoder is not saturated. It is not independent: `awaitReason` is assigned
`wcBusy ? "WC_DECODE_IN_FLIGHT" : "WC_NO_FRAME"`, so `WC_NO_FRAME 24%` and `wcBusy 0%` are one
measurement stated twice. The finding rests on `wcProvider 23%` and `decode element`, which are
separate fields and do stand alone.

**Correction to v34.** A fourth run had the flag-**ON** arm detach once (`detaches 1 · refusals 2`).
S4.7's done-when ("zero divergence firings across a soak") is therefore met in **3 of 4** runs, not
uniformly. The predicate reduces detaches; it has not been shown to eliminate them. The flag stays off.

**Direction (agreed with the user, 2026-08-03).** ADR-012 fixes decoder *correctness*; this is decoder
*availability*, and they are different problems. Finish ADR-012 cleanly, keep S4.7 flagged until its
soak is clean, and do **not** assume the freeze symptom is solved by completing the programme. The next
investigation is provider lifetime: was one never created, created and released, demoted, refused by
proxy selection, reclaimed by retention — or did the source simply stay on `<video>` forever? Those are
lifecycle questions, not scheduling ones.

## v34b — CORRECTION to v34a: a never-deleted diagnostic row is not a sample (2026-08-03)

**v34a's headline claim was wrong, and the error is instructive.** It read:

> One source sits on `element` with NO provider for 97–100% of the arm.

`__rfSourceMap` is written per composite and **never deleted** — `(w.__rfSourceMap ??= {})[id] = {…}`,
with no removal anywhere in the tree. A source that leaves the draw set leaves its last row behind
permanently, and the budget probe read the whole map every 250ms and counted that corpse as a live
sample.

The run parks at 7s with the cut at 11s and plays 10s, so the FIRST clip is past its out-point for most
of the sampled window. It was not starved of a decoder. **It was not in the scene.** The row was frozen
at its last graded value, and 100% of a frozen row reads exactly like 100% of a starved one.

**What survives.** The second clip — the one that IS live across the cut — held a WebCodecs provider in
21–22% of samples. That figure is now also suspect for the same reason (it is inactive before the cut),
and the corrected instrument must re-measure it before anything is concluded.

**The discriminator, and why it needs no app change.** A row still being graded is rewritten every
composite, and `staleMs` is recomputed against an advancing playhead — so *something* in it moves even
when the source is stuck. A row byte-identical to the previous sample is not being written at all. The
probe now drops those and reports `graded n/total` beside every percentage, so "12 of 40 samples" can
never again be read as if it covered the arm.

**The pattern, third occurrence this session.** `mediaFps` reading 0 on the WebCodecs path; `wcBusy` and
`WC_NO_FRAME` counted as two facts when they are one; and now a diagnostic map with no delete. Every one
produced a confident, plausible, wrong number. **The instrument is part of the system under test, and it
gets audited before its output becomes a finding** — especially when the output is the finding you were
hoping for.

**Status of the v34a direction.** The "decoder availability, not contention" hypothesis is NOT
withdrawn — it was never resting on the first clip's row alone, and `shared`/`detaches`/`refusals` come
from `__rfWcPool`, which is unaffected. But it is now **unproven** rather than evidenced, and needs a
re-measurement on the corrected instrument before it directs any work.

## v34c — the evidence pipeline was tied to repository state, not revision state (2026-08-03)

**FREEZE.** ADR-012 is implementation-blocked at the S4.3 producer boundary. Not architecture-blocked:
nothing about the design is in question, and no architectural review is reopened when it lifts.

**What was found.** `preview-budget-probe.ts` (committed) reads `wcProvider`, `wcBusy` and `why` from
`__rfSourceMap`. Those three fields are published by a diagnostics block in `ScenePreviewCanvas.tsx`
that **exists in no commit** — uncommitted working-tree state belonging to a third session, alongside
its producers in `WebglMediaLayer.tsx` and its type in `scene-media-source.ts`.

So the v34a measurement that produced `wcProvider 23%` — the number behind the "decoder availability,
not contention" hypothesis — **cannot be reproduced from a clean checkout.** It was measured against
code that is not in the repository. That is the 2026-07-28 "verify the build IS the build" lesson in a
new costume: there, the build was not the source; here, the source is not the revision.

**What was verified, rather than assumed:**

| check | result |
|---|---|
| commits touching the four blocked files | all are ADR-012 slices from this session; the colour session touched none |
| last write to all four | the same second, `00:13:45`, untouched 11h — one atomic write, not a live edit |
| web typecheck with the changes present | clean — the work compiles, it is not mid-edit |
| `HEAD` versions of the three files | publish **zero** of the fields (`WebglMediaLayer`'s 10 matches at HEAD are all internal `wcBusyRef`) |
| committed consumers of the fields | only the probe, and only through an untyped runtime read |

The last two together are the important ones: **`HEAD` is self-consistent.** A clean checkout compiles
and runs; the probe simply reports `NOT REPORTED BY THIS BUILD`. The repository is reproducible — what
was not reproducible was the *evidence*.

**Instrument fixed first.** The probe coerced the three fields with `!!`, so a build without that block
would print `wcProvider 0%` for every source — indistinguishable from a source that never got a decoder,
which is precisely the finding shape it would have been believed as. Absent now prints as absent. Fourth
instrument correction this session, and the same shape every time: **a missing input rendering as a
confident value.**

**Resolution, in order (decided with the user):**

1. The owning session commits the four runtime files as its own atomic commit — authorship preserved,
   baseline reproducible, evidence pipeline restored.
2. Only then does S4.3 resume, at the exact blocked point: `visibleContribution` onto
   `WebglMediaLayer`'s props → `acquirePreviewFrameProvider`, with `VideoPreview` computing it.

**A stash is not a substitute for a commit.** Private state cannot found reproducible evidence, and
stashing this particular work would silently break a committed probe. A stash is correct only if the
owning session decides to *abandon* the work.

**Standing until then:** no measurement may rely on those fields; S4.7 stays flag-off pending its R2
soak; S4.3 stays observability-only.

## v35 — a discarded frame was never re-asked for, so a paused loader stayed dark forever (2026-08-15)

**Problem:** on a Flarex comp with 12 asset-source `MediaIn`s moved onto ADR-021's pull seam, only 1-3
of 12 loaders showed a picture even though every one of them held a live provider and the provider's own
books said frames were being served. The source map read `state=AWAITING · why=WC_NO_FRAME · busy=false`
on the rest — provider present, nothing in flight, no picture — while the compiler's host-substitution
census climbed to 1854. Paused, it never recovered.

**Root cause:** `WebglMediaLayer.requestWcFrame`'s `if (wcProviderRef.current !== provider) return;`
guard. Discarding the frame is correct — it belongs to a provider the layer no longer holds, after a
remount or a `src` flip to the ingest-proxy variant — but the exit **re-asked for nothing**. The layer
had spent its one request and now waited for another, and the only thing that re-issues one during
normal operation is the per-frame rAF loop, which is gated on `isPlaying` (`WebglMediaLayer.tsx:1765`).
PAUSED there is no loop at all, so the loader waited forever.

Two things had kept this invisible. **The loader ceiling was hiding it:** under the session pool the 9
losing loaders were denied a provider and took the `<video>` path, so they never got far enough to lose
this race — removing the admission ceiling is what made it reachable at scale. And **the two books
count different events:** `__rfFlarexProviders.framesServed` increments when the façade's `getFrame`
RESOLVES with a picture, while `__rfSourceMap.served` is stamped only in `presentFrame`. Reading
`framesServed 23` beside `served: null` as "a frame reached the layer and went unreported" was an
inference across that gap, and it is wrong in the other direction too: `servedSourceTimeRef` (`:2446`)
and `wcFrameRef` (`:2452`) are written by the same function and cleared together (`:692`), so a layer
holding a picture it does not report is unreachable by construction. `served: null` always meant no
picture.

**Fix:** a pre-registered disposition counter (`__rfFramePresent` — `presented` / `providerChanged` /
`heldNotPresented` / `nullFrame` / `threw`) to name which exit consumes a served frame, then a paced
`scheduleWcRerequest()` on the `providerChanged` exit. On the CONSUMER's path, per DEBT-009's rule —
not by exempting the provider from the identity check. Self-limiting: `scheduleWcRerequest`'s `fire()`
re-checks `wcProviderRef.current`, so a layer genuinely tearing down re-asks nothing.

**Verify:** one-line control, paused arm, single variable, same fixture —

| | rendering | presented | providerChanged | host substitutions |
|---|---|---|---|---|
| without the re-arm | 1 of 12 | 2 | 22 | 1854 |
| with the re-arm | **12 of 12** | 42 | 18 | 79 |

With it, all 12 paused loaders read `state=ok · staleMs 0` — a coherent comp. Under playback the
acceptance probe reports 3 → 12 concurrently rendering loaders against the session-pool arm's ceiling
(`capMisses 29`), 0 denials, 0 evictions, 706 MB peak of a 768 MB budget.

**Honest limit:** 12 sources ACQUIRE and present; they do not stay coherent while PLAYING. In the
playing arm only 3 of 12 read `ok`, the other 9 `stale` by up to 1728 ms. Twelve concurrent software
1080p decoders do not hold rate on this machine, and ADR-021 §7 says so in advance — this step fixes
acquisition, and acquisition was not the slow thing.

## v35a — the probe was clicking "Playback stats", so every run measured a paused editor (2026-08-15)

**Problem:** `flarex-loader-ceiling-probe.ts` reported loader-rendering counts that were meant to be
about decoding under playback. They were about an editor sitting still at t=0.

**Root cause:** `playAndSettle` located the transport with
`button[title*="Play"], button[aria-label*="Play"]` and took `.first()`. That substring **also matches
`VideoPreview.tsx`'s "Playback stats (FPS / dropped frames / render scale)" toggle**, which comes first
in DOM order. The editor's transport control is `EditorPage.tsx`,
`title={isPlaying ? "Pause (Space)" : "Play (Space)"}`.

The tells were in the numbers and went unread for two sessions: **12 loaders over a 9 s settle produced
`pulls 29`** — roughly one per loader, where playback produces thousands — and every rendering loader
read `served=0.00`, a playhead that never left zero. The click itself was wrapped in
`.catch(() => undefined)`, so landing on nothing looked identical to succeeding.

**Fix:** exact selector `button[title="Play (Space)"]`, plus a `transportAdvance()` precondition that
reads `__rfClock.live` before and after 1.2 s and **VOIDs the run** when it did not move. Also
`PROBE_NO_PLAY=1`, which settles deliberately paused — the arm that can see a dropped request, because
the rAF loop is not there to paper over one.

**Verify:** after the fix the same probe reports `transport advanced : 1.64s in 1.2s` and
`presented` rises from 4 to 1241 in the pool arm — the per-frame loop running for the first time in this
probe's history.

**Why it matters beyond this probe:** this is `measurement-preconditions` rule 1 applied to the
TRANSPORT rather than the decoder. WebCodecs *was* engaged, `__rfWcMode` *did* read `wc-sw`, and the
build-identity check *did* pass — every precondition the probe knew to assert was green, and the run
was still about a different machine than the one it named.
