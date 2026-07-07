# Assets / media

## v1 — Ingest proxy recipe history (2026-07-04 → 2026-07-06)
**Problem:** Live playback decoded original camera files (sparse-GOP 4K) against ~2-3 hardware decode
sessions — the root of the seek-catch-up/starvation/wedge family.
**Fix:** Per-SOURCE ingest proxies (Premiere model): H.264 ≤854px, source-fps capped 30, 1s GOP, AAC,
OPFS `lumio-source-proxies/`. `SOURCE_PROXY_VERSION` chronicle:
- v1: could bake a frozen tail (encoder kept last canvas after decoder death) + hardcoded 30fps judder.
- v2 (2026-07-05): frozen-tail guard + source-fps sampling.
- v3 (2026-07-06): invalidated everything the pre-worker engine built mid-playback (starved decoder).
- v4 (2026-07-06): invalidated proxies decoded from PARTIAL fragmented-MP4 indexes (frozen tail baked
  in with no null frames — the guard can't see clamped frames). Demux fix in webcodecs-decoder.ts.
**Invariants:** exports + freeze-frames read ORIGINAL bytes, never `proxyUrl`; viewer modal plays the
original; `proxyUrl` is a session blob URL — never persist it.

## v2 — Pexels/stock files are fragmented MP4s (2026-07-06)
**Problem:** Stock-tab and pexels.com downloads froze at a constant per-file timestamp (8.5–16.8s);
Clipchamp re-encodes of the SAME footage played fine at any length.
**Root cause:** fMP4/CMAF layout — sample table spread across `moof` fragments; our demuxer indexed
only the first fragment (see playback-preview.md v4 for the full mechanism).
**Fix:** fragmented-aware `demuxIndex` walk; proxy v4 rebuild.
**Note for the future:** any NEW decoder/probe that reads mp4box sample tables must handle
`info.isFragmented` — partial tables look completely valid (offsets/sizes present).

## v4 — HEVC (H.265) sources: WebCodecs rejected, slow main-thread proxy builds (2026-07-06, diagnosis)
**Problem:** Console showed `[export] VideoDecoder config unsupported → <video> fallback,
codec="hvc1.1.6.H120.b0"` plus mp4box `BoxParser` warnings (`size 1751411826` = the ASCII bytes
"hint" misread as a length — non-fatal atom-parse stumble in the same file).
**Root cause:** Chrome's WebCodecs only decodes HEVC with a platform hardware decoder and often
rejects High-tier configs. Designed fallback chain: proxy worker (WebCodecs-only) throws
`WEBCODECS_REQUIRED_NO_DOM` → engine re-runs the build on the MAIN THREAD with the hidden-<video>
seek-per-frame decoder → build succeeds but at ~real-time-or-slower, gated to paused/idle by the
background gate. Exports with HEVC sources take the same element fallback (correct, slower).
Once built, the proxy is H.264 → playback/scrub normal.
**Not a bug — platform limit.** Future nicety: "HEVC clip — optimizing takes longer" badge in the
media bin. The `[export]` log tag is just the shared decoder module's home, not an actual export.

## v3 — Thumbnail/waveform caches unbounded (2026-07-06)
**Problem:** Filmstrip data-URL strips, posters, and hi-res audio-peak arrays were cached in Maps
that never evicted; the shared AudioContext lived forever. Long sessions never plateaued in memory.
**Fix:** Bounded LRUs (200 strips / 200 posters / 100 peak arrays), extraction + decode gated behind
the background-work gate (see background-tasks.md v1), AudioContext closed after 30s idle.

## v5 — v4 field-confirmed on the :4173 production build (2026-07-07)
**Observation:** same signature as v4 on the built app — `sourceProxy.worker` rejects
`hvc1.1.6.H120.b0` (107B hvcC) → `<video>` fallback message from both the worker and the shared
`source-decoder` module, plus the BoxParser ASCII-as-length stumble (this file: `"hear"` =
1751411826; v4's was `"hint"`). Fallback chain engaged as designed, no freeze/regression — occurs
identically with `lumio.singleCtxPreview` on or off (decode pipeline, unrelated to Phase 5).
No action; v4's "HEVC clip — optimizing takes longer" badge remains the future nicety.
