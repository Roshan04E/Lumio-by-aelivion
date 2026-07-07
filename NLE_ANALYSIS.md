# Lumio vs Professional NLEs — Engineering Analysis (v2)

> **Re-analyzed 2026-07-03; status refreshed 2026-07-04.** The v1 baseline (2026-07-02) drove the
> P0→P3 roadmap; this rewrite replaces it with the current state so the comparison stays honest:
> every item is marked ✅ SHIPPED (with its gate), ⏳ PARTIAL, or ❌ OPEN. Progress detail lives in
> `architecture.md` and the `AGENTS.md` changelog; live open items in `GAPS.md`; the proxy/cache
> architecture block has its own tracker in `PREVIEW_PIPELINE.md` (P1–P3 shipped, P4–P5 open).
> Benchmarks unchanged: Premiere Pro / DaVinci Resolve (desktop bar), CapCut Web / Clipchamp (browser peers).
>
> **2026-07-04 delta:** preview-cache trust chain completed (P1 build-time render fingerprint, P2
> still proxies, P3 provably-complete span signatures + always-on span-verification gate); nesting
> Phase A (shared Premiere-aligned expansion core, `packages/shared/src/nesting.ts` + NESTING.md);
> Premiere-style media management (bin tree, nested-bin drag/drop, multi-select + batch ops, color
> labels asset→timeline with per-clip override, hover-scrub thumbnails); 30-min user soak clean;
> rewind catch-up hold made wall-clock-bounded; borderless shade-based UI pass.

**One-line verdict (updated):** the rendering architecture was always the moat; the two killer gaps
from v1 — per-clip decoders and the missing pro editing floor — are now closed or flag-ready. Lumio
is roughly **~90% of a social-video editor and ~70% of a pro NLE** today. What separates it from
"fully professional" is no longer playback or timeline craft; it's the **cloud path not being real
end-to-end**, a handful of pro conveniences (source monitor/3-point, nesting, export presets,
stabilization/scene-detection), and color-pipeline maturity (linear/10-bit).

---

## 1. THE MOAT (keep; grown since v1)

| Area | Why it's strong |
|---|---|
| **Method-3 SceneCompositor** | One WebGL2 context composites everything (media/text/shapes/transitions/16 blend modes/3D/masks). Export IS the preview (same `buildSceneDraws` + compositor in preview, worker export, Remotion). |
| **Render-manifest contract + gate ladder** | `scene:compare` (22 fixtures), `render:compare:pixels`, `export:worker-scene` (worker export parity, maxDiff 0%), `export:stress`, `governor:stress`, `wc:gate` (decoder), `audio:postmix:test`, `editor:test` (138). For a 3-renderer product this ladder is the spine — it caught/localized every regression this week. **All browser gates need `PIXEL_BROWSER_CHANNEL=chrome`.** |
| **Unified decode pipeline** *(new since v1)* | ONE WebCodecs provider (`createFrameProvider`) serves preview pool AND export: streaming demux from disk-backed Blobs (RAM = one GOP window, not the file), hard 3-session cap, playhead>preload priority with preemption, reverse-shuttle frame cache (76 vs ~450 decodes measured), `<video>` fallback everywhere. |
| **Color page** | Curves, wheels, hue-sat curves, HSL secondary, .cube LUTs, looks + real scopes (waveform, parade, vectorscope w/ skin line, histogram). Ahead of every browser peer. |
| **Audio pillar** *(new since v1 — was "~5% built")* | Track mixer with faders + pan + live meters, fader/pan keyframe automation, clip EQ/compressor/gate/limiter as ONE shared DSP in all three renderers, sidechain auto-ducking, volume keyframes + DaVinci corner fades. |
| **Local WebCodecs export** | Decode→GPU composite→encode→mux in a Worker; H.264/AAC + VP9/Opus; level selection, backpressure, watchdogs, black-frame guard, bt709 tagging (±1/255 measured). |
| **Adaptive proxy cache** *(trust chain completed 07-04)* | Viewer-capture proxies (the LIVE compositor renders spans; parity self-check before sealing), OPFS spans, reload rehydration, background generation. Validity is now AUTOMATIC end-to-end: build-time render fingerprint (P1 — any render-code change invalidates, nothing hand-bumped), whole-layer content signatures incl. z-order/track state (P3, test-locked), and an always-on span-verification gate (frozen/black/undecodable blobs can never seal; `__rfSpanVerify`). Still proxies for 4K images (P2, WebP tiers, OPFS). Open: P4 generation scheduling, P5 single-context preview grading. |
| **Editing craft** *(new since v1)* | JKL shuttle, I/O, frame-step, Q/W ripple trims, roll/slide/slip/rate-stretch/extend-edit, snapping, markers (named/colored, in the data model), paste-attributes, effect presets, speed ramps (linear v1, exact integral, tri-renderer). |
| **Keyframes/masks** | V2 keyframe model, bezier graph editor, motion paths; vector masks w/ boolean modes, feather, shape keyframes, tracking. |
| **Real browser ML** | MediaPipe/RVM segmentation, LaMa inpainting, transformers.js transcription — local, degradable. |
| **Perf self-defense** *(new since v1)* | Context governor (hard cap, LRU eviction, recovery), adaptive quality (auto res drop/recover on dropped frames) + ¼/½/1/A transport radio, FPS/dropped-frame HUD, shader/LUT pre-warm, crash-recovery OPFS checkpoints. |

---

## 2. CORRECTNESS LEDGER (v1 "implemented but fragile" — 9 of 11 closed)

| # | v1 item | Status |
|---|---|---|
| 2.1 | Region-effect clone expansion | ✅ TRUE fix: per-effect masked post-composite passes, default ON in all 3 renderers (`?regionPasses=0` escape). Cleanup of legacy expansion call sites still pending post-soak. |
| 2.2 | Governor default OFF | ✅ ON behind `governor:stress` |
| 2.3 | Proxy = second pipeline | ✅ proxy captures the live viewer compositor (P1a/P1b) default ON |
| 2.4 | Wall-clock playback | ✅ audio-master clock + start gate; video elements drift-corrected (500ms/0.15s) — fixed the paused≠live frame jump |
| 2.5 | Transitions ignore transform keyframes in the window | ❌ OPEN — last correctness item; a scaled/moved clip still jumps at a junction |
| 2.6 | Snapshot undo memory churn | ✅ re-examined: history is structurally shared — a NON-issue |
| 2.7 | OPFS matte URIs browser-local | ❌ OPEN — masked layers cannot cloud-export until mattes upload to http(s) |
| 2.8 | First-frame shader/LUT stall | ✅ pre-warm shipped |
| 2.9 | No OPFS proxy rehydration | ✅ persisted span index, validated on open |
| 2.10 | EditorPage/ToolDetailPage monoliths | ⏳ PARTIAL — inspector registry, stores, panels extracted; the pages are still large and remain the re-render risk zone |
| 2.11 | Cloud render mock-wired | ❌ OPEN — the single biggest architectural gap (see §6.1) |

**Correctness work found & fixed during the 2026-07-03 soak** (why the gate ladder exists):
- Hardware H.264 decoder **wedge** on burst-fed short clips → frozen clips in export (pre-existing;
  warmup queue capped at 12; both failure directions now fixture-locked in `wc:gate`).
- Static stills re-uploaded **full-res every composited frame** (46MB/frame for a 4K photo) →
  freeze-play-freeze near photo overlays; fixed via producer-version dedup + async decode +
  2560px downscale cap.
- Images exported **upside down** (`texImage2D` ignores `UNPACK_FLIP_Y` for ImageBitmap) → bitmaps
  pre-flipped in preview + export, orientation gate-locked. Rule: any new ImageBitmap draw source
  must pre-flip.

**…and during the 2026-07-04 soak** (30-min continuous playback afterwards: clean):
- **Stale spans survived render-affecting edits** (transform edits, track reorders) → signatures
  now hash the whole render-relevant layer + z-order/track state; automatic render fingerprint
  replaced the hand-bumped version constant (P1/P3, editor:test-locked).
- **Duplicate companion-audio layer ids** on asset replace → React remounted the twins every render
  (the "~500ms click lag"); companion now updates in place + `ensureComposition` heals saved
  projects. Rule: layer ids are unique, everything assumes it.
- **Rewind fast catch-up pan** (3rd report): presenter hold was present-count-bounded, consumed in
  <1s; now wall-clock (5s per streak). **Closed-VideoFrame texImage2D race** on paused repaints:
  presenter holds a clone it owns.
- **Batch ops clobbered each other** in the local-asset fallback (read-modify-write of one
  localStorage key) → all local asset mutations serialize through a write lock.
- **Seek path re-rendered the whole editor** (07-04 day, `__rfClickLatency` avg 429ms / worst 788ms):
  every ruler click/scrub move drove React `currentTime` state → 2 full-tree renders per click with
  AssetBin ~240ms of waste each. Now: seeks write ref + clock store synchronously (preview via
  `clockDriven`, timeline playhead via imperative `subscribePlaybackClock`, timecodes as clock
  leaves) and the cold state commit is a 120ms trailing coalesce; AssetBin is `memo`'d behind
  identity-stable handlers (`useStableHandler`). Rule: `currentTime` state is a FOLLOWER of
  `currentTimeRef` — never sync ref from state, handlers read the ref.

---

## 3. LOW-END ARCHITECTURE (v1's five hard problems — all five answered)

| v1 problem | Answer |
|---|---|
| 3a Per-clip `<video>` decoders (the #1 killer) | ✅ element pool (stage 1, ON) + WebCodecs pool (stage 2): 3-session hard cap, streaming demux (disk-backed Blob, sample-table index, ≤24MB chunk window), preload/playhead priority + preemption, reverse-shuttle cache. **Flag `wcDecode` default OFF pending ONE deliberate low-end re-soak with the 07-03 fixes** — that soak+flip is the single remaining step of the low-end track. |
| 3b Proxies help 2nd pass only | ✅ viewer-capture proxies + rehydration. ⏳ import-time proxy generation (user-facing) still open. |
| 3c No adaptive feedback loop | ✅ adaptive quality: dropped-frame detection → auto res drop/recover; user-facing A mode. |
| 3d Zero perf visibility | ✅ Stats HUD (FPS, dropped frames), pool/governor telemetry (`__rfWcPool`, upload debug). |
| 3e Two decode paths | ✅ one provider for preview + export. |

---

## 4. FEATURE FLOOR vs the pros

### Tier A (pro editor rejects without these) — **ALL SHIPPED**
1. ✅ Keyboard editing: JKL, I/O, frame-step, zoom, snap toggle
2. ✅ Trim suite: ripple (Q/W), roll (R), slide (U), slip, rate-stretch, extend-edit (E)
3. ✅ Audio pillar: mixer/pan/meters/automation, clip EQ-comp-gate-limiter, ducking
4. ✅ Markers (named/colored, data model + UI)
5. ✅ Speed ramps v1 (linear segments, exact integral, tri-renderer parity)
6. ✅ Autosave + crash recovery (OPFS checkpoints, restore prompt)

### Tier B (expected soon after) — mostly OPEN, this is the current feature frontier
7. ⏳ Nested sequences / compound clips — **Phase A shipped 07-04**: Premiere-aligned by-reference
   model reusing the importer shape (`nestedCompositionId` + `ProjectGraph.compositions`), shared
   expansion core with exact time/speed mapping + cycle guards (24 editor:test checks, NESTING.md).
   Phases B–D open: editor UX (Nest action, breadcrumb, un-nest), renderer group composite, parity fixtures.
8. ✅ Effect presets + paste-attributes
9. ❌ Stabilization; ❌ motion blur
10. ❌ Scene detection; ❌ auto-reframe
11. ❌ Import-time proxy/optimized-media UI
12. ❌ Render-in-place / selective range render
13. ⏳ Media relink (modal + import-time guards; no auto-detection)
14. ❌ Export presets (platform targets, bitrate ladder, res override) + background export
15. ❌ Source monitor + insert/overwrite **3-point editing** (the biggest single workflow gap)

### Tier C (differentiators)
- ⏳ Color management: Rec.709 export tagging done (±1/255); linear-light internal pipeline,
  float targets, 10-bit/HDR — open (see §7).
- ❌ Multicam; ❌ collaboration/CRDT; ❌ expression scripting
- ⏳ Plugin system: manifests + registry shipped; sandboxed runtime execution open
- ⏳ `.prproj` import (Codex): real object-graph import with nested-sequence foundation — improving

---

## 5. COMPARISON SNAPSHOT (2026-07-03)

| Capability | Lumio | Premiere | Resolve | CapCut Web |
|---|---|---|---|---|
| GPU compositing pipeline | ✅ single WebGL2 pass | ✅ | ✅ | ⚠️ |
| Preview↔export parity | ✅ gate-locked | ✅ | ✅ | ⚠️ |
| Color grading + scopes | ✅ strong | ✅ | ✅✅ | ❌ |
| Color management (linear/10-bit) | ⚠️ Rec.709 tag only | ✅ | ✅✅ | ❌ |
| Proxy/render cache | ✅ viewer-capture + rehydrate | ✅ | ✅✅ | ⚠️ |
| Decoder management | ✅ pooled+capped (flag, soak pending) | ✅ | ✅ | ⚠️ |
| Audio (mixer/meters/FX/ducking) | ✅ | ✅ | ✅✅ Fairlight | ⚠️ |
| Keyboard editing / trim suite | ✅ | ✅✅ | ✅ | ⚠️ |
| Markers | ✅ | ✅ | ✅ | ❌ |
| Media management (bins/labels/multi-select) | ✅ bin tree, drag-nesting, color labels asset→timeline | ✅✅ | ✅ | ⚠️ |
| Nesting / compound clips | ⏳ core shipped, UX open | ✅ | ✅ | ❌ |
| 3-point editing / source monitor | ❌ | ✅✅ | ✅ | ❌ |
| Speed ramp | ✅ v1 linear | ✅ | ✅ | ✅ |
| Stabilization / scene detection | ❌ | ✅ | ✅ | ⚠️ |
| Export presets / background export | ❌ | ✅ | ✅ | ✅ |
| Captions/word-level | ✅ | ✅ | ⚠️ | ✅✅ |
| Browser ML (segment/inpaint/transcribe) | ✅ local | cloud | ⚠️ | ✅ cloud |
| Autosave/crash recovery | ✅ | ✅ | ✅ | ✅ |
| Cloud render end-to-end | ❌ mock-wired | n/a | n/a | ✅ |
| Plugin runtime | ⚠️ manifests only | ✅ | ✅ | ❌ |

---

## 6. NOT SHIPPED — the honest pending list, in priority order

### 6.1 Cloud path end-to-end (biggest architectural gap; "cloud video editor" isn't real yet)
- API→worker render execution production-wired (BullMQ exercised, real job lifecycle + retries;
  today: inline mode + `mockProcessing.service.ts` stands in at the API layer).
- **Server-side matte resolution** — OPFS matte URIs are browser-local; masked layers silently
  can't cloud-render until mattes upload to fetchable URLs at export time.
- Upload/payment providers are mocks (metadata-only pricing stays by design — no enforcement).
- Cloud parity gates have never run in a true production GPU environment.

### 6.2 wcDecode default flip
- Everything is built and gate-green; needs ONE deliberate low-end soak with the 07-03 fixes
  (`?wcDecode=1`), then flip `getWcPreviewDecodeEnabled` default. Keep `?wcDecode=0` escape.

### 6.3 Pro-workflow frontier (ordered by editor impact)
1. Source monitor + insert/overwrite 3-point editing
2. Nesting/compound clips Phases B–D (shared core SHIPPED 07-04 — needs editor UX, renderer group
   composite, parity fixtures)
3. Export presets + background export
4. Speed-ramp v2: bezier curves, on-clip ramp band, pitch-preserving audio
5. Import-time proxy UI; media relink auto-detection
6. Stabilization; motion blur; scene detection; auto-reframe (AI backlog names them)
7. Render-in-place
8. Transitions honoring per-clip transform keyframes (last §2 correctness item)

### 6.3b Preview-pipeline remainder (PREVIEW_PIPELINE.md — P1/P2/P3 shipped 07-04)
- **P4 generation scheduling**: one scheduler over {isPlaying, decoder-pool stats, GL budget,
  playhead distance}; includes the queued boundary reports (2–3 frame step-back at image-clip
  boundaries; video-after-images freeze; 07-04: picture pauses crossing OUT of a ready proxy span —
  live layer frozen under the overlay, `__rfLiveFreeze` watchdog shipped to name the mechanism).
- **P5 single-context preview grading**: media grading moves into the scene compositor's context
  (export Phase-2 pattern); collapses GL contexts to ~2–3 and retires most of the governor.
- wcDecode default flip after one calm low-end soak (§6.2).

### 6.4 Platform/infra debt
- EditorPage (~5k LOC) / ToolDetailPage extraction remainder
- Plugin runtime sandbox (`webgl-fragment` execution in all three renderers)
- Person-extraction adapter reconciliation + cloud SAM2/inpaint adapters (contract-only stubs)
- Doc drift: architecture.md still lists a few items (e.g. effect presets) as unbuilt that shipped

---

## 7. FUTURE DIRECTION

**Near (finish the started arcs):** wcDecode soak→flip; cloud render end-to-end (6.1 — this
converts Lumio from "editor with a cloud renderer in the repo" to a cloud product); source
monitor/3-point; export presets + background export.

**Mid (quality ceiling):** color pipeline maturity —
- internal rendering in **linear color**, float render targets where available
- ONE color transform chain (no double transforms), Rec.709 managed end-to-end
- 10-bit export later; high-bitrate H.265/ProRes-class encodes on the cloud path
- same blend/mask/effect math everywhere (already true — keep it gate-locked)

**Mid:** nesting, speed-ramp v2, stabilization/scene-detection (these are the remaining
"Premiere parity" features users notice), plugin runtime sandbox.

**Long (differentiators):** multicam, collaboration/CRDT, expression scripting, HDR,
AI-native workflows on the existing action-registry (the registry design means AI can only
mutate through validated actions — that's the foundation to build on).

---

## Verification map (what protects what)
- Decode/export correctness: `wc:gate` (streaming, frame accuracy, shuttle cost, pool priority,
  image orientation), `export:worker-scene`, `export:stress`, `export:finish-guard`
- Composite parity: `scene:compare` (22 fixtures; `PIXEL_FIXTURES=<name>` to triage one),
  `render:compare:pixels`, `color:compare`
- Perf: `governor:stress`, `export:live-stress`
- Audio: `audio:postmix:test`; animation/captions: `animation:test`, `caption:qa`
- Editor logic: `editor:test`; types: `pnpm -r typecheck`
- **All browser gates: `PIXEL_BROWSER_CHANNEL=chrome`** (headless Chromium has no H.264 — without
  it they "time out").

## Sources (external research, from v1)
- Resolve proxy/timeline-resolution & low-end guidance: editingtools.io, miracamp.com, proxpc.com, vagon.io
- Premiere vs Resolve playback engine discussions: community.adobe.com, forum.blackmagicdesign.com
- Browser NLE architecture (Clipchamp WebCodecs, WebGPU editors): w3.org media-production workshop, vidstudio.app, byteiota.com
