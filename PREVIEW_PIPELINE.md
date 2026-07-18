# Preview Pipeline — proxy/cache + rendering architecture review

Status: **active block** (agreed 2026-07-03 late night, mid-soak). Owner: Claude. Companion trackers:
NLE_ANALYSIS §6, AGENTS.md changelog. Principle (user): *"the ultimate goal is preserving quality and
providing smoothness"* — proxies/caches are preview-only; the original media and the full-quality
composite are what exports. Premiere's model throughout: conform/proxy for the editing experience,
originals for the render.

## 1. Case file — what the 2026-07-03 soak proved

1. **Stale proxies replayed a broken renderer.** The adaptive span cache served proxy mp4s generated
   before the decoder warmup-wedge fix — frozen video baked into the file, replayed faithfully for
   exactly the span, "recovering" at its boundary. Invalidation keyed on a HAND-BUMPED constant
   (`PREVIEW_PROXY_RENDER_VERSION`) that nobody bumped alongside the decoder fix. *Lesson: cache
   validity must be derived from the render pipeline's actual code identity, not from human
   discipline.* → Phase P1.
2. **A broken span can ship silently.** Nothing checks a generated span against the live composite;
   the first QA is the user's eyeballs. → Phase P3.
3. **Generation competes with playback.** Span generation runs the same WebCodecs decoder budget +
   GL context pool the live preview uses; the only throttle today is `isGlBudgetOverTarget()`
   (GL-side, and only when the governor is enabled) inside `proxyWorkerClient`. Decoder-pool
   contention and "am I playing right now" are not inputs. → Phase P4.
4. **GL context per live clip is the scaling wall.** ~1 context per live media layer (grade
   renderer); soak hit **GL ctx 15** on an image-heavy section — one clip from Chromium's ~16
   force-loss (which kills the OLDEST context, possibly the scene compositor → GPU preview silently
   drops to DOM). Mitigated now (governor budget 8/12, recoverable eviction) but the architecture is
   the problem. → Phase P5.
5. **4K stills.** File format is irrelevant to GPU cost: a 4096px image ≈ 64–90MB RGBA in GPU memory
   from any container. User confirmed empirically: replacing 4K with full-HD sources fixed playback
   entirely. The existing 2560px preview cap didn't save the section — count × (bitmap + graded
   canvas + texture) still overwhelms an iGPU. → Phase P2.
6. Span-boundary behaviors (hold windows, swap alignment in `ProxyPlaybackLayer`) reviewed during
   the freeze hunt — the two-buffer front/back design is sound; keep, and let P3's verification
   cover its inputs.

## 2. Target architecture (Premiere-aligned)

- **One validity root**: every derived artifact (span proxies, still proxies, future audio waveforms
  conform) carries `renderFingerprint + contentSignature`. `renderFingerprint` is computed AT BUILD
  TIME as a hash of the render-critical sources (decoder, compositor, draw builder, effects/style
  evaluators) — a code change that can alter pixels flips it automatically; nothing to remember.
- **Preview-only derived media**: originals are immutable; export/cloud always consume originals
  through the full-quality path. Still proxies (P2) and span proxies are the preview's working set,
  both living in the SAME OPFS store with the same eviction + invalidation.
- **Generation is a background citizen**: it yields to playback (hard pause while playing unless the
  span is the playhead's own lookahead), to decoder-pool pressure, and to the GL budget. One
  scheduler owns the queue; priorities: playhead lookahead > visible range > rest.
- **Nothing serves unverified**: a generated span passes a cheap sampled comparison against the live
  compositor (P3) before `resolveProxyPlayback` may return it; failure → span marked unproxiable
  for this signature + telemetry, live path serves it (correctness always has a fallback).
- **One GL context to rule the preview** (P5): media grading moves into the scene compositor's
  context via the injected `gradeOverlay`/RTT pattern the single-context EXPORT already ships.
  Per-layer contexts (and the governor's whole reason to exist) collapse; GL ctx becomes ~2–3
  regardless of clip count. This is the endgame; the governor is the interim safety net.

## 3. Phases

- **P1 — automatic render fingerprint** (this session): vite build-time hash of render-critical
  sources injected as `__ORRERIS_RENDER_FINGERPRINT__`; `baseCompositionSignature` consumes it (the
  hand-bumped constant remains only as the non-vite/test fallback). Whole-store invalidation on any
  render-code change — conservative and correct; regeneration is background work.
- **P2 — import-time still proxies**: per-image preview proxy (long edge ≈ comp long edge × ~1.3,
  device-aware floor 1920), WebP q≈82 with alpha, OPFS via the shared store, decode via
  fetch→Blob→createImageBitmap (**pre-flip `imageOrientation:"flipY"` — the standing rule**).
  Zoom-aware regeneration when a clip's content scale exceeds the headroom. Originals untouched.
- **P3 — span verification gate**: ✅ SHIPPED 2026-07-04 (`spanVerification.ts` + gate in the
  EditorPage generation loop, before `store.put`). Always-on, blob-side: decodes 3 samples
  (10/50/90%) from the produced webm and fails the span on (a) undecodable/unseekable/truncated,
  (b) FROZEN CONTENT — max adjacent-sample diff < 0.12% normalized while a video layer overlaps the
  span (repeat-encoded identical frames decode ~0.02%; even tripod footage carries ≥0.3% sensor
  noise), (c) BLACK while media expected (belt for the worker guard; covers viewer capture, which
  skips the worker). Fail → `markFailed` (terminal until the signature changes) + live compositor
  serves the range. Telemetry: `window.__rfSpanVerify` {ok, failed, lastReason} + `verify-ok`/
  `verify-failed` events in the proxy diagnostics ring. The live-composite comparison remains
  available behind the viewer-capture flag (`verifySpanProxyAgainstViewer`); folding it into the
  always-on gate is P4/P5 work once generation scheduling makes the extra render polite.
- **P4 — generation scheduling**: single scheduler input set = {isPlaying, decoder-pool stats, GL
  budget, playhead distance}; hard-pause during playback except the playhead-lookahead span;
  telemetry for "generation stole a decoder while playing" (should trend to zero).
- **P5 — single-context preview grading**: preview `getMediaGraded` path moves to same-context RTTs
  inside `SceneCompositor` (export Phase-2 `gradeOverlay` pattern generalized to media). Ships
  behind a flag with scene:compare + wc:gate parity before flip, same ladder as every renderer
  change. Retires most of the governor.

Ordering rationale: P1 removes the class of silent wrongness (cheap, immediate); P2 fixes the
worst real-world smoothness cliff the user hit; P3 makes the cache trustworthy; P4 makes it polite;
P5 is the deep fix and rides last because it's the riskiest and the governor holds the line
meanwhile.

## 4. Open soak items this block should explain or fix

- **Rewind fast catch-up pan (3rd report, fixed 2026-07-04)**: the presenter hold in
  `WebglMediaLayer.requestWcFrame` was bounded by a 60-PRESENT cap, consumed at rerequest cadence
  in <1s — a 20–30s rewind on a sparse-keyframe source outlived it and the tail of the key→target
  catch-up presented as the fast-forward pan. Now bounded by WALL CLOCK (hold while served lag
  >0.35s, up to 5s per streak); `window.__rfWcHolds` still counts engagements. 30-min soak on the
  rest of the pipeline was clean (user, 2026-07-04 night).
- **Span content-signature misses transform edits** (2026-07-03, post-P1): user repositioned/rescaled
  4 image clips; proxied playback kept the OLD transform for all of them until a manual in/out
  regeneration. The per-span `contentSignature` (see `compositionCacheLayers`) evidently does not
  cover every render-affecting layer field (position/scale at minimum — audit against
  `getCompositionTransform`/effects/masks inputs). Belongs to P3/P4 work: signatures must be
  provably complete, and span↔live races handled ("be very careful with the races and mixing and
  matching", user).
- **2–3 frame step-back on the lower video at an image-clip boundary** (playhead crossing from one
  image overlay clip to the next): the dome video briefly replayed earlier frames then resumed.
  Suspects: span↔live handoff serving a slightly-behind proxy, or the new rewind-hold interacting
  with the boundary re-seek. Reproduce with `?wcDecode=0` and with the cache badge off vs on to
  split proxy vs decoder.

- Intermittent upper layer not rendered until replay (WC first-frame at activation vs graded-canvas
  version-dedup — instrument in P4/P5 work).
- `probe-decode produced no frame → <video> fallback` with `outputs=14` (fallback worked; cause TBD).
- wcDecode default flip decision happens after a calm soak round on top of this block's P1.
