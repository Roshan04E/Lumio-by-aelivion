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
