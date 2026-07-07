# Lumio — Consolidated Gaps & Missing Work

> Reference index of what is **still missing / deferred** across all plan docs, as of 2026-07-02.
> Source docs: [architecture.md](architecture.md), [todo.md](todo.md), [COLOR_SYSTEM_PLAN.md](COLOR_SYSTEM_PLAN.md),
> [EDITOR_REFACTOR_PLAN.md](EDITOR_REFACTOR_PLAN.md), [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md),
> [MASKS.md](MASKS.md), [MEDIA_LIBRARY.md](MEDIA_LIBRARY.md), [PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md).
> This file does not replace those docs — it aggregates their open items so nothing is lost.

## 1. Preview stability & adaptive cache  ← ACTIVE BRANCH (`method-3-gpu-compositor`), least complete
Doc: [todo.md](todo.md). Shipped: producer-canvas safety (P3), lifecycle fixes (P4), upload semantics (P5),
cache manifest + ruler UI (P6 partial). **Mostly landed 2026-07-02:**
- ✅ **Context governor** — built, flag-gated default-off (`getGlGovernorEnabled`; enforcement in `gl-context.ts`:
  `requestContextSlot`/`touchContext`/`registerContextDisposer`). LRU-idle eviction, root-protected; `MediaWebGLRenderer`
  reserves a slot, `WebglMediaLayer` lazily recreates. Gate: `pnpm --filter @lumio-by-aelivion/shared governor:test`.
- ✅ **GPU reset/recovery** — bounded auto-rebuild on a fresh context (de-spammed); DOM only after retries exhaust.
- ✅ **Persistent proxy cache** — verified already-built + wired + active by default (OPFS blobs, LRU, content-signature
  invalidation, double-buffered `<video>` playback, background Worker generator). Playback proxies are export-grade.
- ✅ **Phase 8 export black clips** — fixed (guard + probes). No longer a gap.

- ✅ **Governor default ON (2026-07-02)** — the required GPU preview-contention stress gate is built and green:
  `governor:stress` (`GovernorStressPage.tsx` + `apps/worker/src/governor-stress.ts`; enforced peak 7 bounded,
  12 evictions, clean recreation, preview alive, settles to hard cap 4; control run unbounded 13). Escape hatch `?glGovernor=0`.

- ✅ **OPFS rehydration on reload (2026-07-02)** — persisted per-span index (`proxy-span-index.json`, id + base
  signature + content signature + bytes) in the proxy OPFS dir; on open, `rehydratePersistedProxies`
  (EditorPage) seals matching spans through `markSpanReady`'s own staleness validation (stale → blob deleted).
  Blobs are no longer wiped on unmount (URL release only); foreign-signature records age out after 24h.

**Remaining:** explicit backward-seek renderer dedup. [todo.md:68-83](todo.md#L68)

## 2. Region-effect architecture — TRUE fix SHIPPED, default ON (2026-07-02)
- Region effects are per-effect masked post-composite passes (the AE model) **by default in all three
  renderers** (`REGION_PASS_MODEL_DEFAULT`, threaded to Remotion via `RenderManifest.regionPassModel`;
  escape hatch `?regionPasses=0`). Effects COMBINE in overlaps; no clone decoders in preview OR export.
  Gate ladder: `scene:compare` 22/22 both states incl. the 3-way `overlap-region-effects` fixture;
  `render:compare:pixels` region fixtures 7/7 + a strict-threshold cross-renderer overlap check (1.186%
  vs ~25% if a renderer had stayed on the clone model). **Remaining cleanup (after soak)**: retire
  `expandEffectRegionMasks` scene-path call sites + `buildRegionBlurCloneAliases` (DOM fallback still
  expands). [todo.md](todo.md)
- **P3a** (registry-metadata decode-share) is largely mooted by the pass model — revisit after cleanup.
- **P1a/P1b DEFAULT ON (flipped 2026-07-03)**: proxy spans render through the LIVE viewer compositor
  (offscreen, no present; pooled `<video>` decode; zero new GL contexts) with a parity self-check before
  sealing (either pipeline). Real-project soak: viewer-first seal, parity-ok 0.00%, zero worker fallbacks.
  Escape hatch `?proxyViewerCapture=0`. M1a/M1b kept — they harden the still-live worker FALLBACK path.
  [todo.md](todo.md)
- **P3a**: registry-metadata-driven decode-share instead of `type === "blur"` hardcode. [todo.md:229](todo.md#L229)

## 2b. Preview↔export color parity — FIXED (2026-07-03)
- **Cloud (Remotion) export color blowout FIXED**: `renderMedia` ran without `colorSpace` → ffmpeg wrote
  full-range/untagged YUV that players decoded as limited BT.709 (measured ±19/255 on grays, "punchy"
  saturated look vs preview). Fix: `colorSpace: "bt709"` **plus** `disallowParallelEncoding: true` in
  `apps/worker/src/remotion-renderer.ts` — Remotion's parallel pre-encode converts with BT.601 while
  tagging BT.709 (measured ±39/255 on saturated colors); the ffmpeg stitch path's `zscale=matrix=709`
  converts correctly. Verified: patch-grid manifest → real Remotion render → Chrome decode = ±1/255.
- **Local WebCodecs export measured clean** (±1/255 roundtrip, canvas + WebGL + Worker OffscreenCanvas;
  encoder meta tags bt709 and mp4/webm muxers write it). Known edge: `new VideoFrame(canvas)` premultiplies
  straight-alpha pixels — any composited output pixel with alpha<255 darkens in export (α=0.9 → RGB×0.9).
  Compositor initializes the accumulator opaque, so this only matters if a future path emits alpha<1.

## 3. Export paths not built
- **Browser export renderer** & **local desktop renderer**. [architecture.md:148-150](architecture.md#L148)
- **Server-side matte resolution**: OPFS matte URIs are browser-local; masked layers can't export via Remotion until `matte.uri` is a fetchable http(s) URL. [architecture.md:256](architecture.md#L256)

## 4. Person / AI-tool coherence
- **Cross-tool artifact reuse** (extract once, reuse everywhere). [architecture.md:252](architecture.md#L252)
- Reconcile Extract Person's real path with `tool-runner.ts` adapter dispatch. [architecture.md:250](architecture.md#L250)
- **Cloud adapters** (segmentation, SAM2 + inpainting) are contract-only stubs. [architecture.md:254](architecture.md#L254)
- Real **SAM2 point-prompt + motion tracking** for Remove Person. [architecture.md:278](architecture.md#L278)

## 5. AI capability backlog (AI_ARCHITECTURE Phase 13)
Named-but-unbuilt: **Scene Detection, Speed Ramp, Auto-Reframe, Audio Ducking, Motion Blur**, professional Person/BG Removal,
runner registration for modals that open but can't run (e.g. Remove Background). [AI_ARCHITECTURE.md:131-139](AI_ARCHITECTURE.md#L131)

## 6. Editor refactor & smaller gaps
- **EDITOR_REFACTOR Phase 4-6**: EditorPage (~5.2k LOC) & ToolDetailPage (~2.8k LOC) not yet migrated to Zustand store / inspector registry. [EDITOR_REFACTOR_PLAN.md:136](EDITOR_REFACTOR_PLAN.md#L136)
- **Save/load effect presets** — not built. [architecture.md:176](architecture.md#L176)
- **Transition transform limitation**: per-clip scale/position/rotation keyframes not applied during transition windows. [architecture.md:178](architecture.md#L178)
- **Plugin system**: real `webgl-fragment`/`css-filter`/`composite` execution deferred pending renderer sandboxes; creator-tools authoring pending. [PLUGIN_ARCHITECTURE.md:73](PLUGIN_ARCHITECTURE.md#L73)
- **Color parity gates never run in a real GPU env** — structurally green only; `render:compare:pixels` / `color:compare` / `scene:compare` need a GPU env pass.
- **Doc drift**: architecture.md still flags Grain/Vignette/Chroma as needing render impl, but COLOR_SYSTEM_PLAN E1 shipped them as native shaders — reconcile.

---
*Sequencing recommendation:* finish #1 (active branch) → close server-side matte resolution (#3) → region-effect TRUE fix (#2) before piling on more AI tools.
