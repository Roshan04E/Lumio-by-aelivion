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

## v8 — Phase 5 SHIPPED behind flag: GPU-first single-context preview (`kimera.singleCtxPreview`, default OFF) (2026-07-07)
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
**Flip procedure:** soak with `localStorage.setItem("kimera.singleCtxPreview","1")` on :4173 →
watch `__rfSingleCtxPreview`, `__rfGlContextBudget` (media contexts should drop to ~0),
`__rfLiveFreeze` → then default ON in `getSingleCtxPreviewEnabled` (render-engine.ts).

## v9 — singleCtxPreview soak bug: black flicker on ruler clicks (2026-07-07)
**Problem:** With `kimera.singleCtxPreview=1` on :4173, clicking the playhead around the ruler
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

## v10 — DEFAULT FLIPPED: `kimera.singleCtxPreview` ON (2026-07-07)
**Decision:** user go ("we should flip.. we are ready") after the v8 gate ladder + v9 soak fix.
**Change:** `getSingleCtxPreviewEnabled()` env fallback `false` → `true` (render-engine.ts) + doc.
**Gate ladder re-run on the flipped default (plain runs now exercise the single-ctx path):**
typecheck 5/5 · editor:test · governor:test · `scene:compare` (chrome) 22/22 ·
`render:compare:pixels` 23/23 — the in-context-graded preview is pixel-aligned with the Remotion
export at 0.000%. Rebuilt: `index-CGNM5ptK.js` on :4173.
**Escape hatches (permanent):** `?singleCtxPreview=0` per session, localStorage
`kimera.singleCtxPreview="0"`, or `VITE_SINGLE_CTX_PREVIEW=0`. The per-clip-context path stays
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
