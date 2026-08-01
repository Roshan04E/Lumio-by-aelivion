# Flarex Evaluation Engine — Independent Runtime Architecture Audit

**Scope**: the live preview path only (Timeline → Playhead → MediaIn → graph → SceneDraw → SceneCompositor → canvas).
**Method**: implementation-first. Where a doc, ADR or comment disagrees with code, the code is reported as truth and the disagreement is itself listed as a finding.
**Date**: 2026-08-01. **Branch**: `method-3-gpu-compositor`.

Every claim below cites a file and line. Claims I could not verify by reading code are marked **[UNVERIFIED]** with the file that would settle them.

---

## 1. Executive Summary

**Overall architecture health: structurally sound at the *lowering* layer, structurally absent at the *evaluation* layer.**

The single most important finding of this audit is that **there is no evaluation engine.** There is a *lowering compiler* (`compileFlarexComp`) that translates a node graph into timeline draw primitives, and there is a *timeline compositor* (`SceneCompositor`) that renders those primitives. ADR-008 explicitly names the missing layer between them and specifies it; the implementation contains its vocabulary (`evaluationKey`, `contentHash`, `__flarexSealed`, `dependencyVersions`) but not its substance.

Concretely:

- **Nodes are not runtime objects.** They have no lifecycle. There is no creation, mount, allocation, reuse, release or destruction to audit, because a node exists only as a `switch` case inside a pure function that runs from scratch every frame ([compile-flarex.ts:1054](packages/shared/src/flarex/compile-flarex.ts#L1054)). "MediaIn nodes never mounting" is therefore *categorically impossible as stated* — what actually fails is the **virtual media loader** that stands behind a MediaIn, which is a React component in a completely different ownership domain ([VideoPreview.tsx:2003](apps/web/src/components/VideoPreview.tsx#L2003)).
- **The graph's media is owned by React, not by the graph.** Every MediaIn's picture is produced by a hidden `<PreviewLayer>` mounted by `VideoPreview`, keyed by a memo, filtered by proxy state, competing for a global 4-slot decoder budget. The evaluator can only *ask* whether the picture arrived and *degrade* if not. Four distinct degrade answers exist and none is observable to the user.
- **The presentation barrier that exists to enforce temporal coherence does not cover Flarex's own sources on the paused path** — the exact case it was built for. This is a one-line classification bug with wide blast radius (Finding **C1**).
- **The comp-proxy fast path bypasses every gate**, is pumped from a *different clock* than the composite, carries no timestamp, and allocates a new GPU texture per decoded frame that is retained for 120 frames (Findings **C2**, **C3**, **C8**).
- **The content-addressed cache built in Slice 2 is dead on the shipped path** and, where it *is* live, its key omits evaluation-context time — so under TimeSpeed it can serve one node instance's pixels for another (Findings **C6**, **C9**).

The observed symptoms are not one bug. They are the predictable output of **five independent architectural gaps** compounding: no node identity across frames, media ownership split across three unsynchronized subsystems, a soft-degrade lattice that makes "wrong picture" a legal output, a presentation barrier with a hole in it, and two caches keyed on incomplete identity.

**Verdict**: the lowering-compiler design (ADR-007, parity-by-construction) is *correct and should be preserved verbatim*. The layer above it should be built as specified in ADR-008 rather than patched further. The failure modes in §10 are not fixable by tuning timeouts.

---

## 2. Runtime Architecture Diagram — as implemented

```
┌─ REACT / OWNERSHIP DOMAIN A: transport ────────────────────────────────────┐
│  playback-clock.ts                                                          │
│    clockTime (committed)  ──sync──▶ imperative subs (timeline playhead)     │
│                           ──rAF───▶ react subs (VideoPreview)               │
│                           ──120ms─▶ cold subs (inspector/scopes)            │
│    liveTimeReader()  ── anchor-derived, sub-commit ── getLivePlaybackTime() │
└──────────────┬──────────────────────────────────────────┬──────────────────┘
               │ currentTime (COMMITTED)                  │ getLivePlaybackTime()
               ▼                                          ▼
┌─ DOMAIN B: media supply (React) ───────────┐   ┌─ DOMAIN C: comp proxy ─────┐
│ VideoPreview.tsx                            │   │ useFlarexCompProxies.ts    │
│  sceneLayers        ──▶ <PreviewLayer>×N    │   │  own rAF loop (playing)    │
│  activeFlarexVirtual──▶ <PreviewLayer>×M    │   │  own clock-sub  (paused)   │
│      (hidden, non-interactive)              │   │  preview-frame-pool lease  │
│         │ registers ScenePreviewMediaSource │   │         │                  │
│         ▼                                   │   │         ▼                  │
│   mediaSourcesRef[layerId] ─────────────────┼───┼─▶ framesRef[compId]        │
│   (or gradedCanvasesRef[layerId])           │   │   {source, sourceVersion}  │
└──────────────┬──────────────────────────────┘   └────────┬───────────────────┘
               │                                            │
               │        ┌───────────────────────────────────┘
               ▼        ▼
┌─ DOMAIN D: presentation (ScenePreviewCanvas.tsx) ──────────────────────────┐
│  rAF loop  ──▶ drawFrameImpl()                                             │
│    1. build media resolver (getMediaSingleCtx → gradeMediaInContext)        │
│         · uploads + grades raw frame into a per-source RenderTarget         │
│         · collects staleIds / allStaleness  ← COHERENCE INSTRUMENT          │
│    2. buildSceneDraws(...)  ← THE ONLY GRAPH ENTRY POINT                    │
│    3. not-ready hold gate       (notReadyIds, per-type budgets)             │
│    4. coherence hold gate       (staleIds, per-source + per-episode caps)   │
│    5. full-res rendezvous       (atomic swap decision, one frame late)      │
│    6. prune unconsumed grade renderers  ← DESTRUCTIVE, runs only if shown   │
│    7. compositor.renderFrame(spec)                                          │
└──────────────┬─────────────────────────────────────────────────────────────┘
               ▼
┌─ DOMAIN E: draw construction (packages/shared, pure) ──────────────────────┐
│  build-scene-draws.ts                                                       │
│    buildLayerDrawWithPasses(layer)                                          │
│      → buildLayerPreFlarexDraw(layer)   [grade+transform+masks+passes]      │
│      → applyFlarex(layer, draw, dims)                                       │
│           ├─ flarexCompProxies[compId]?  ─▶ RETURN pre-rendered frame ⚠     │
│           └─ compileFlarexComp(comp, ctx)                                   │
│                 ctx.hostSourceDraw     = the layer's own finished draw      │
│                 ctx.resolveSourceDraw  = virtual-loader adapter             │
│                 ctx.matteCache         = SceneMaskMatteCache (shared)       │
└──────────────┬─────────────────────────────────────────────────────────────┘
               ▼
┌─ DOMAIN F: lowering (compile-flarex.ts) — PURE, STATELESS, PER-FRAME ──────┐
│  computeFlarexContentHashes(comp, ctx.timeSeconds)   ← whole graph, once    │
│  memoized backwards DFS from MediaOut (or previewRoot / view dot)           │
│    memo key = `${nodeId}@${t.toFixed(6)}`      (per-frame Map, discarded)   │
│    activeTimeSeconds cursor (ADR-011 TimeSpeed)                             │
│    wrap-collapser folds ops into one SceneGroupDraw shell by STAGE order    │
│    shouldMaterialize() → materialize() → sealed wrap + contentHash          │
│  RETURNS: SceneLayerDraw | SceneGroupDraw | null                            │
└──────────────┬─────────────────────────────────────────────────────────────┘
               ▼
┌─ DOMAIN G: rasterization (scene-compositor.ts) ────────────────────────────┐
│  renderFrameCore → per draw:                                               │
│     renderLayerInto   · srcTextures Map<TexImageSource, tex>  (120-frame TTL)│
│     renderGroupInto   · ContentArtifactCache lookup/store (budgeted LRU+tier)│
│                       · groupTargets[depth] ping-pong RTT pool              │
│     renderTransition  · sideA/sideB pools                                   │
│  presentFrame() → default framebuffer                                      │
└────────────────────────────────────────────────────────────────────────────┘
```

**The critical structural observation**: domains B, C, D, F and G each hold a *different* answer to "what time is it" and *different* state about "is the picture ready", and there is **no barrier that spans all of them**. The coherence barrier (D.4) sees only domain B's single-ctx sources. It cannot see domain C at all, and it misclassifies domain B's Flarex loaders (C1).

---

## 3. Actual Data Flow

### 3.1 The time axis — four clocks, no reconciliation

| Clock | Owner | Update rate | Consumed by |
|---|---|---|---|
| `clockTime` (committed) | [playback-clock.ts:19](apps/web/src/playback/playback-clock.ts#L19) | per `playbackCommitIntervalMs` (16/40/90ms by quality tier) | `VideoPreview.currentTime` → `ScenePreviewCanvas.currentTime` → **the entire draw build** |
| `getLivePlaybackTime()` | anchor-derived reader registered by EditorPage, [playback-clock.ts:137](apps/web/src/playback/playback-clock.ts#L137) | continuous | **comp-proxy decode pump only** ([useFlarexCompProxies.ts:397](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L397)) |
| cold clock | 120ms debounce, [playback-clock.ts:54](apps/web/src/playback/playback-clock.ts#L54) | ≤8Hz, suspended while playing | inspector/scopes |
| `vTime` (per virtual loader) | [VideoPreview.tsx:2018](apps/web/src/components/VideoPreview.tsx#L2018) | derived from committed, **clamped to media end** | that loader's decoder |

A composite built at committed time `t` therefore contains proxy pixels decoded for `getLivePlaybackTime()`, which during playback is **ahead of `t` by up to one commit interval (90ms on the performance tier)**. Nothing anywhere reconciles this. See **C2**.

### 3.2 Time inside the graph

`ctx.timeSeconds = max(0, t − layer.startSeconds)` ([build-scene-draws.ts:801](packages/shared/src/scene/build-scene-draws.ts#L801)) — comp-local.
`ctx.frameTimeSeconds = t` — global, threaded into fragment passes for `uTime` parity.
`activeTimeSeconds` — a **mutable module-local cursor** ([compile-flarex.ts:925](packages/shared/src/flarex/compile-flarex.ts#L925)) set around each `lowerNode` call and restored in `finally`. Under a TimeSpeed it diverges from `ctx.timeSeconds`.

**Three sites read `ctx.timeSeconds` where they should read `activeTimeSeconds`** — see **C6**.

### 3.3 The MediaIn resolution lattice

`ctx.resolveSourceDraw(nodeId, assetId)` returns one of four values ([build-scene-draws.ts:815-830](packages/shared/src/scene/build-scene-draws.ts#L815)):

| Return | Meaning | Compiler action ([compile-flarex.ts:1059](packages/shared/src/flarex/compile-flarex.ts#L1059)) | User sees |
|---|---|---|---|
| `SceneLayerDraw` | loader has a picture | use it | correct |
| `"ended"` | comp-local t past loader duration | **produce nothing** | node vanishes (by design) |
| `"pending"` + retimed ctx | loader owns node, no picture | **produce nothing** | node vanishes (transient) |
| `"pending"` + un-retimed ctx | " | **fall through to host clip** | *wrong shot, silently* |
| `null` (no virtual layer) | no loader owns this node | **fall through to host clip** | *wrong shot, silently* |

Two of five outcomes present a picture from a different source than the graph specifies, with no visual or telemetric signal. This is the single largest contributor to "graph appears valid while rendered output is incorrect". See **C10**.

---

## 4. Node Lifecycle — as implemented

**There is none.** This is the finding, not a preamble to one.

```
                     ┌──────────────────────────────────────┐
   FRAME N BEGINS    │  compileFlarexComp(comp, ctx)        │
        │            │  const memo = new Map()   ← fresh    │
        ▼            │  const visiting = new Set() ← fresh  │
  evalNode(mediaOut) └──────────────────────────────────────┘
        │
        ├─ memo.has(key)? ──yes──▶ return cached FlarexValue   (INTRA-FRAME only)
        ├─ visiting.has(key)? ──yes──▶ return null             (cycle degrade)
        ├─ node = nodes[nodeId];  !node ──▶ return null        (dangling degrade)
        ├─ activeTimeSeconds = timeSeconds        (cursor push)
        ├─ value = node.enabled ? lowerNode(node) : passthrough(node)
        │     └─ recursive: imageInput()/matteInput() → inputValue() → evalNode()
        │        └─ cloneImage(value.draw)   ← SHALLOW copy per consumer
        ├─ activeTimeSeconds = outerTime          (cursor pop, finally)
        ├─ shouldMaterialize(nodeId, draw)?
        │     = ctx.materializeNodeIds.has(id)                      (debug, undefined in prod)
        │     ∨ (fanout(id) > 1 ∧ estimateDrawCost(draw) ≥ 2)
        │     └─ yes ──▶ materialize(): newWrap() + __flarexSealed + contentHash
        └─ memo.set(key, value); return

   FRAME N ENDS  ──▶  memo, visiting, contentHashes, activeTimeSeconds ALL DISCARDED
```

Mapping the requested lifecycle stages onto reality:

| Requested stage | Reality | Owner |
|---|---|---|
| creation | `FlarexNode` is a plain record in `comp.nodes` (persisted project data) | timeline actions / undo stack |
| **mount** | **does not exist** — nothing is instantiated | — |
| evaluation | one `switch` arm, per frame, from scratch | `lowerNode` |
| cache | per-frame `memo` Map, keyed `(nodeId, time)`, discarded at frame end | `compileFlarexComp` local |
| texture allocation | never by a node; only by `SceneCompositor` from the *emitted draw* | `SceneCompositor` |
| GPU upload | never by a node; `uploadSource`/`SceneTextureSource` from the emitted draw | `SceneCompositor` |
| reuse | intra-frame fan-out via `memo`; cross-frame only via `ContentArtifactCache` (mostly dead — **C8**) | mixed |
| release | GC of the memo Map | JS runtime |
| **destruction** | **does not exist** | — |

**Architectural consequence.** A node cannot own a resource, cannot hold async state, cannot be scheduled, and cannot be invalidated — because it does not exist between frames. Every property the audit brief asks about (ownership, lifetime, reuse, release) has been pushed down into the compositor, where it is keyed on *draw structure* rather than *node identity*. That is exactly the ceiling ADR-008 names.

---

## 5. Media Lifecycle — MediaIn reconstructed

This is the only genuine lifecycle in the system, and it lives entirely outside the graph.

```
 (1) GRAPH DECLARATION
     FlarexNode { type:"mediaIn", params:{ sourceAssetId, sourceInSeconds, freeze } }
              │
 (2) VIRTUAL LAYER SYNTHESIS                      [pure, per React render]
     collectFlarexVirtualLayers(hosts, comps, lookupAsset)     virtual-layers.ts:265
       · id = `flarexsrc:${compId}:${nodeId}`
       · startSeconds = host.startSeconds          ← mirrors host
       · durationSeconds = min(host.duration, retimedRemaining)  ← the "ended" gate
       · speed / sourceInSeconds rewritten by applyRetimeToLoaderTiming (ADR-011)
       · empty assetId + non-identity retime ⇒ promoteHostMediaInLoader (copy of host)
       · text/background ⇒ RASTERIZED layer, no decoder at all
              │
 (3) PROXY FILTER                                  VideoPreview.tsx:1364   ⚠ C3
     activeFlarexVirtualLayers = flarexVirtualLayers
        .filter(v => !proxyServedCompIds.includes(compIdOf(v)))
     ── a RENDERING decision (is a proxy serving?) unmounts DECODERS ──
              │
 (4) DECODER MOUNT                                 VideoPreview.tsx:2003
     <PreviewLayer key={vlayer.id} currentTime={vTime} hideVisual interactive={false}
                   tolerateLag={true}          ← never freeze-holds     ⚠ C5
                   preferSoftwareDecode={rate<=1}
                   exclusiveDecode={rate!==1}
                   sceneMediaSink={getSceneMediaSink(vlayer.id)} />
              │
 (5) SESSION RESERVATION                           preview-frame-pool.ts:54-85
     MAX_WC_SESSIONS = 3 (hardware)  MAX_WC_SOFTWARE_SESSIONS = 3
     MAX_WC_TOTAL_SESSIONS = 4       HARDWARE_RESERVED_SLOTS (host protection)
     ── a 4-MediaIn comp CANNOT be fully backed. Excess loaders get no session. ── ⚠ C4
              │
 (6) FRAME PUBLICATION
     layer decodes → sink.onFrame() → requestDraw()  (settle window re-armed)
     descriptor published in mediaSourcesRef[virtualId]
              │
 (7) COMPOSITE-TIME GRADE                          ScenePreviewCanvas.tsx:944
     gradeMediaInContext(id, source):
        snap = source.snapshot()
        staleness/awaiting collected → staleIds        ← COHERENCE INSTRUMENT
        frame missing? → return HELD previous RTT      ← anti-flicker hold
        else upload + grade into per-source RenderTarget, return SceneTextureSource
              │
 (8) DRAW BINDING                                  build-scene-draws.ts:889
     cachedPreFlarexDraw(virtual, dims, comp.version)
        HIT  → reuse frozen template, rebind {source,sourceWidth,sourceHeight,sourceVersion}
        MISS → buildLayerPreFlarexDraw() then Object.freeze() + store
        not ready → onLayerNotReady(virtual.id) → "pending"
              │
 (9) COMPILER CONSUMPTION                          compile-flarex.ts:1068
     4-way lattice (see §3.3) — two branches substitute the HOST clip silently
              │
(10) GPU                                           scene-compositor.ts:2295
     SceneTextureSource → sampled directly, no upload, no srcTextures entry
```

### Where media becomes detached — every site

| # | Site | Mechanism | Symptom |
|---|---|---|---|
| D1 | [VideoPreview.tsx:1364](apps/web/src/components/VideoPreview.tsx#L1364) | proxy starts serving → loader unmounts → decoder released | comp's MediaIns go cold; if the proxy then drops out, nothing is warm |
| D2 | [useFlarexCompProxies.ts:316](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L316) | playhead leaves host span → `setServing(false)` → loaders remount cold | media "reappears after a beat" on re-entry |
| D3 | [preview-frame-pool.ts:850](apps/web/src/playback/preview-frame-pool.ts#L850) `reserveSession` | pool full → no session | MediaIn permanently falls back to host or vanishes |
| D4 | [ScenePreviewCanvas.tsx:1272](apps/web/src/components/ScenePreviewCanvas.tsx#L1272) | `sharedMediaRenderersRef` prune of ids not in `liveMediaSourceIds` | a comp whose compile was skipped (proxy hit) loses its sources' graded RTTs |
| D5 | [ScenePreviewCanvas.tsx:1074-1091](apps/web/src/components/ScenePreviewCanvas.tsx#L1074) | descriptor briefly absent during remount | held-texture fallback covers it *only if* `lastW > 0` |
| D6 | [build-scene-draws.ts:823](packages/shared/src/scene/build-scene-draws.ts#L823) | `localT >= virtual.durationSeconds` → `"ended"` | node produces nothing; correct by design, indistinguishable from failure |
| D7 | [compile-flarex.ts:1112](packages/shared/src/flarex/compile-flarex.ts#L1112) | `null`/un-retimed `"pending"` → `hostSourceDraw` | **wrong picture, silently** |
| D8 | [ScenePreviewCanvas.tsx:625](apps/web/src/components/ScenePreviewCanvas.tsx#L625) | GL context loss → `flarexSourceDrawCache.clear()` + all RTTs disposed | full cold restart of every source |

Eight detachment sites; **three of them (D1, D2, D4) are triggered by a rendering-policy decision rather than by anything about the media.**

---

## 6. SceneDraw Lifecycle

```
BUILT      every composited frame, inside buildSceneDraws → applyFlarex → compileFlarexComp
OWNED      by nothing. A plain object graph, alive for exactly one drawFrameImpl() call.
REBUILT    unconditionally. There is no incremental path, no dirty flag, no reuse of the
           previous frame's draw list. `comp.version` gates only the FlarexSourceDrawCache
           template (source-draw-cache.ts:43), never the lowering itself.
INVALIDATE nothing invalidates a SceneDraw because nothing retains one.
```

**Texture references are DIRECT, not handles.** A `SceneLayerDraw.source` is either:
- a live `TexImageSource` (canvas / `VideoFrame` / `<video>` element), or
- a `SceneTextureSource` `{ texture: WebGLTexture, width, height }` — a **raw GL object pointer**.

There is no indirection layer, no generation counter, no ownership token.

**Can a draw outlive its node's output?** Not across frames — the draw list is discarded. **Within a frame, yes**: `cloneImage` ([compile-flarex.ts:560](packages/shared/src/flarex/compile-flarex.ts#L560)) makes shallow per-consumer copies that share the underlying texture reference. This is safe today only because nothing releases a texture mid-frame.

**Can a draw reference a released GPU resource?** Yes, and there is a guard proving it was hit:
- [scene-compositor.ts:2059](packages/shared/src/color/scene-compositor.ts#L2059) — `producer?.disposed || producer?.contextLost` → returns the previous texture or `emptyTex`.
- [ScenePreviewCanvas.tsx:886](apps/web/src/components/ScenePreviewCanvas.tsx#L886) `isLiveMediaCanvas` — the own-canvas path's equivalent.

Both are *defensive filters at the consumption site*, not lifetime management. **The `SceneTextureSource` path has no such guard**: `renderLayerInto` samples `layer.source.texture` directly ([scene-compositor.ts:2295](packages/shared/src/color/scene-compositor.ts#L2295)) with no liveness check. The only thing preventing a use-after-dispose is that the prune (D4) runs *after* the composite in the same function.

**Stale draw commands**: impossible by construction (rebuilt every frame) **except** through the two caches that survive frames — `FlarexSourceDrawCache` (template only, media always rebound — sound) and `ContentArtifactCache` (see **C9**).

---

## 7. Ownership Matrix

| Object | Creator | Owner (lifetime) | Destroyer | Readers | Writers | Shared? |
|---|---|---|---|---|---|---|
| `FlarexComp` / `FlarexNode` | timeline actions | `ProjectGraph.flarexComps` (persisted) | undo / delete | compiler, editor, exporters | `flarex.*` actions only | yes, immutable to renderers |
| `FlarexValue` (memo entry) | `evalNode` | per-frame `memo` Map | GC at frame end | `inputValue` | `evalNode` | intra-frame, via `cloneImage` |
| `SceneDraw` tree | `buildSceneDraws` | `drawFrameImpl` local | GC | `SceneCompositor` | nobody after build | no |
| virtual `TimelineLayer` | `collectFlarexVirtualLayers` | `VideoPreview` useMemo | memo recompute | `PreviewLayer`, `resolveSourceDraw` | nobody | yes (preview + capture + export) |
| decoded frame / `VideoFrame` | decoder session | `WebglMediaLayer` **[UNVERIFIED — not read]** | producer's next publish | `snapshot().frame` | producer | cloned per consumer |
| comp-proxy `VideoFrame` | `provider.getFrame` | `ActiveProxy.held` (cloned) | `closeHeld` on next frame | `framesRef` → `applyFlarex` | pump | **no** — single held clone |
| per-source graded `RenderTarget` | `gradeMediaInContext` | `sharedMediaRenderersRef` Map | prune on unconsumed id (D4) | draw list, capture handle | grade | yes: live + thumbnail + capture |
| `srcTextures` entry | `uploadSource` | `SceneCompositor` (strong `Map`, 120-frame TTL) | `pruneTextures` | `renderLayerInto` | `uploadSource` | keyed by **source object identity** ⚠ **C8** |
| `ContentArtifactCache` entry | `renderGroupInto` miss | `SceneCompositor`, budgeted | `evictToBudget` | `renderGroupInto` hit | store | keyed by content hash ⚠ **C9** |
| `groupTargets[depth]` | `groupTargetsForDepth` | `SceneCompositor` | `dispose` | nested renders | ping-pong | **pooled by depth — reused across sibling groups within one frame** |
| `SceneMaskMatteCache` | `ScenePreviewCanvas` | `matteCacheRef` | `disposeResources` | compiler + build | `get()` | yes: live + thumbnail + capture at **different times** ⚠ **C13** |
| `FlarexSourceDrawCache` | `ScenePreviewCanvas` | `flarexSourceDrawCacheRef` | `clear()` on rebuild | `cachedPreFlarexDraw` | same | yes: live + thumbnail + capture |
| coherence clocks (`staleSince`, `notReadySince`, `holdStart`) | `ScenePreviewCanvas` | per-instance refs | visibility change / convergence | gates | gates | **per-viewer, correctly scoped** |
| `clockTime` | `setPlaybackClock` | module singleton | — | everything | transport | **process-global** |

**Double ownership found**: the graded `RenderTarget` pool (`sharedMediaRenderersRef`) is written by the live composite *and* read by `renderIsolated`/`renderOffscreen` at other times; `matteCacheRef` and `flarexSourceDrawCacheRef` likewise. The code acknowledges this ([ScenePreviewCanvas.tsx:1556-1559](apps/web/src/components/ScenePreviewCanvas.tsx#L1556)) and argues it "re-hashes, never corrupts". That is true for the matte cache (its key is resolved geometry). It is **not** true for the version counters those caches publish — see **C13**.

**Orphan resources found**: `srcTextures` entries for `VideoFrame` sources — see **C8**.

---

## 8. Synchronization Matrix

| Boundary | Mechanism | Blocking? | Ordering guarantee |
|---|---|---|---|
| transport → committed clock | synchronous callback set | no | none — clock advances regardless of render |
| committed clock → React consumers | `requestAnimationFrame` coalesce ([playback-clock.ts:41](apps/web/src/playback/playback-clock.ts#L41)) | no | ≤1 notify/frame; snapshot read is always live |
| committed clock → cold consumers | 120ms `setTimeout` **debounce** | no | trailing-edge only |
| clock → comp-proxy pump (playing) | **own rAF loop on `getLivePlaybackTime()`** | no | **none — different clock** ⚠ **C2** |
| clock → comp-proxy pump (paused) | `subscribePlaybackClock` (synchronous) | no | one pump per push, "latest time wins" via `pendingTime` |
| decoder → layer | promise / callback **[UNVERIFIED]** | no | per-source only |
| layer → presentation | `sink.onFrame()` → `requestDraw()` → settle window | no | **dirty-mark only; no completion signal** |
| presentation loop | single `requestAnimationFrame`, one draw per frame | no | serialized by construction |
| draw build → compile | **synchronous function call** | yes | total order, single-threaded |
| compile → compositor | synchronous, same call stack | yes | total order |
| compositor → GPU | GL command stream, no fences on the composite path | no | driver-ordered |
| readback (scopes/thumbnails) | `readCompositeThumbnailAsync` (PBO + fence) with sync fallback | partially | fence-gated |
| capture / thumbnail vs playback | **hard gate**: `if (inputsRef.current.isPlaying) return null` ([ScenePreviewCanvas.tsx:1441](apps/web/src/components/ScenePreviewCanvas.tsx#L1441), [:1537](apps/web/src/components/ScenePreviewCanvas.tsx#L1537)) | yes | correct — playback owns the compositor |
| GL context loss | DOM event + bounded rebuild ladder (3 attempts, 150/300/600ms) | no | canvas remounted via `key={recoveryTick}` |
| worker messages / SharedArrayBuffer | **none on this path** | — | — |

**Synchronization boundaries that exist**: 3 (the two hold gates and the capture/playback gate).
**Synchronization boundaries that are needed but absent**: the transport↔decoder barrier (acknowledged as out of scope in [temporal-coherence.ts:216-223](apps/web/src/playback/temporal-coherence.ts#L216)), and any barrier covering the comp proxy.

**The pipeline is a pure dirty-mark system with a settle timer.** `requestDraw()` sets `activeUntilRef = now + 600ms` ([ScenePreviewCanvas.tsx:716](apps/web/src/components/ScenePreviewCanvas.tsx#L716)). There is no notion of "this frame is complete" — only "keep compositing for a while and hope everything lands". Every convergence property in the system rests on that timer.

---

## 9. Architectural Violations — ranked

Severity: **Critical** = produces wrong or missing picture in normal use. **High** = produces wrong picture in a reachable configuration, or unbounded resource growth. **Medium** = design contract violated, latent. **Low** = hygiene.

---

### C1 — **Critical** · Flarex virtual loaders are misclassified by the presentation hold gate

**Likelihood: certain** (deterministic, not a race).

**Files/functions**: [ScenePreviewCanvas.tsx:1204-1211](apps/web/src/components/ScenePreviewCanvas.tsx#L1204) `isMediaLayerId`, `heldIds`; [build-scene-draws.ts:628](packages/shared/src/scene/build-scene-draws.ts#L628), [:918](packages/shared/src/scene/build-scene-draws.ts#L918) `onLayerNotReady`.

**Evidence**:
```ts
const isMediaLayerId = (id: string): boolean => {
  const layer = ls.find((item) => item.id === id);           // ls = TIMELINE layers
  return layer != null && (layer.type === "video" || layer.type === "image");
};
const heldIds = playing ? notReadyIds : notReadyIds.filter(isMediaLayerId);
```
`ls` is `inputsRef.current.layers` = the `layers` prop = `sceneLayers` ([VideoPreview.tsx:1864](apps/web/src/components/VideoPreview.tsx#L1864)). Virtual loaders are passed **separately** as `flarexVirtualLayers` ([VideoPreview.tsx:1879](apps/web/src/components/VideoPreview.tsx#L1879)) and are documented as never entering the composite loop ([build-scene-draws.ts:418-421](packages/shared/src/scene/build-scene-draws.ts#L418)). Yet `onLayerNotReady` is called **with the virtual layer's id** at [:628](packages/shared/src/scene/build-scene-draws.ts#L628) and [:918](packages/shared/src/scene/build-scene-draws.ts#L918).

Therefore for every `flarexsrc:*` id, `ls.find(...)` returns `undefined` → `isMediaLayerId` → `false`.

**Consequences**:
1. **Paused**: `heldIds = notReadyIds.filter(isMediaLayerId)` drops every Flarex loader. A comp whose MediaIn has no frame yet is **never held** — the frame composites immediately with that MediaIn either transparent (`"ended"`/retimed `"pending"`) or showing the **host clip** (un-retimed `"pending"` → D7). When the loader lands, the settle window recomposites and the picture changes. This is precisely *"sources sometimes appear only after pausing"* inverted — the paused viewer presents the incomplete frame first and corrects it.
2. **Playing**: the loader *is* in `heldIds`, but the budget applied is `NOT_READY_HOLD_MS` (300ms) instead of `NOT_READY_HOLD_MEDIA_MS` (1500ms) — the cap written specifically for media that needs to re-prime. A software-decoded loader (D5, `preferSoftwareDecode`) routinely exceeds 300ms at play start.

**Why it breaks**: the not-ready gate's type classification is derived from a list that structurally cannot contain the ids it is asked about. The two halves were designed in different commits against different id spaces.

**Architectural impact**: the readiness barrier — one of only three synchronization boundaries in the system — has a hole exactly on the source class it exists to protect. Every downstream diagnosis of "the decoder is slow" is confounded by this, because the frame was never held long enough to let the decoder be measured.

**Redesign direction**: the layer *kind* must travel with the not-ready report, not be looked up afterward. `onLayerNotReady(layerId, kind)` — or better, the barrier should consume a typed readiness record from a single participant registry that spans timeline layers, virtual loaders and proxies.

---

### C2 — **Critical** · The comp-proxy path bypasses both hold gates and rides a different clock

**Likelihood: certain whenever `flarexProxyPlayback` is on** (EditorPage enables it, [VideoPreview.tsx:573](apps/web/src/components/VideoPreview.tsx#L573)).

**Files/functions**: [build-scene-draws.ts:781-794](packages/shared/src/scene/build-scene-draws.ts#L781) `applyFlarex` proxy branch; [useFlarexCompProxies.ts:305-374](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L305) `pumpOne`; [:393-402](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L393) playback pump; [build-scene-draws.ts:82-87](packages/shared/src/scene/build-scene-draws.ts#L82) `FlarexCompProxyFrame`.

**Evidence**:
- `FlarexCompProxyFrame` has fields `{ source, sourceWidth, sourceHeight, sourceVersion }`. **There is no timestamp.** The consumer cannot ask "is this frame for time t".
- `applyFlarex` returns the proxy unconditionally when present — it never consults `t`, never calls `onLayerNotReady`, never registers in `liveMediaSourceIds`, and never appears in `staleIds`.
- While playing, the pump runs `requestFrames(getLivePlaybackTime())` on its own rAF loop, while the composite is built from the **committed** clock. On the performance quality tier the commit interval is 90ms.

**Consequences**: a proxied comp presents whatever frame most recently landed, from a clock that is systematically ahead of the frame being assembled, and neither the not-ready gate nor the coherence barrier can see it. If the decode is slow the comp simply shows an old frame while every other layer advances — visible as the comp "lagging behind" or "freezing" while playback continues. The `__flarexCoherence` instrument will report the frame as **fully coherent**, because the proxy contributes no staleness row at all.

**Architectural impact**: the coherence barrier's stated invariant ("at a fixed timeline position, a presented frame represents ONE requested timeline time across every media source participating in it") is **false by construction** for proxied comps. The instrument that was used to validate the barrier is blind to the path that most needs it.

**Redesign direction**: a comp proxy is a media source. It must publish the same descriptor contract as any other (`stalenessSeconds`, `awaitingFrame`) and participate in the same rendezvous. It must be driven from the same clock the composite is built from, or carry its own served-time so the gate can compute staleness.

---

### C3 — **Critical** · Proxy substitution unmounts the comp's decoders; a proxy dropout leaves nothing warm

**Likelihood: high** — fires on every playhead exit from a proxied clip's span, every comp edit, every key change.

**Files/functions**: [VideoPreview.tsx:1364-1368](apps/web/src/components/VideoPreview.tsx#L1364) `activeFlarexVirtualLayers`; [useFlarexCompProxies.ts:163-169](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L163) `setServing`; [:196-273](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L196) reconcile effect; [:313-325](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L313) out-of-span drop.

**Evidence**: the hook's own docstring is explicit that this coupling is deliberate and load-bearing ("the whole win depends on those loaders going away"). The transitions are:

```
   loaders warm ──[first proxy frame]──▶ setServing(true) ──▶ loaders UNMOUNT
                                                                    │
   loaders COLD ◀──[out of span / key change / decoder fail]── setServing(false)
```

The code correctly orders the *serving-on* transition (loaders unmount only after the first frame lands) but the *serving-off* transition has no such ordering: `setServing(false)` at [:207](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L207) and [:321](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L321) drops the proxy frame in the same tick that requests the loaders back. React must then mount M `<PreviewLayer>`s, each must acquire a pool session (**C4**), each must seek and decode.

**Consequences**: during the entire re-warm window the comp has **no proxy and no sources**. Every MediaIn resolves `null` or `"pending"` → host-clip fallback (D7) or transparent. Combined with **C1**, nothing holds the frame. Result: the comp visibly flashes to the host clip / goes blank, then fills in.

**Architectural impact**: a rendering-strategy decision (use a cache or evaluate live) is wired directly to a resource-lifecycle decision (hold a decoder session or not), with no hysteresis and no overlap. This is the coupling that makes the proxy an *unstable equilibrium* rather than an optimization.

**Redesign direction**: keep loaders mounted with a lowered priority (`"preload"`) for a hysteresis window after a proxy takes over, and require the proxy to remain valid for N frames before releasing them. The switch must be a crossfade in resource terms, not a cut.

---

### C4 — **Critical** · The decoder budget is smaller than the graphs the product invites users to build

**Likelihood: certain for comps with ≥4 asset-source MediaIns.**

**Files**: [preview-frame-pool.ts:53-85](apps/web/src/playback/preview-frame-pool.ts#L53), [:826-870](apps/web/src/playback/preview-frame-pool.ts#L826) `reserveSession`.

**Evidence**:
```
MAX_WC_SESSIONS           = 3   // hardware
MAX_WC_SOFTWARE_SESSIONS  = 3   // software
MAX_WC_TOTAL_SESSIONS     = 4   // the real budget
HARDWARE_RESERVED_SLOTS         // reserved for the host clip
```
Effective software ceiling = `min(3, 4 − HARDWARE_RESERVED_SLOTS)`. The comment at [:71-77](apps/web/src/playback/preview-frame-pool.ts#L71) documents that a previous split ("two caps that merely sum are not a budget") starved the host and made **every** asset-source MediaIn soft-degrade.

**Consequences**: a comp with four sources cannot be fully backed. The excess MediaIn gets no session, `resolveSourceDraw` returns `null`, and the compiler substitutes the **host clip** ([compile-flarex.ts:1112](packages/shared/src/flarex/compile-flarex.ts#L1112)). The user sees a node that "never mounts" — permanently, deterministically, with no error.

**Architectural impact**: the graph's expressive capacity (unbounded MediaIn nodes) and the runtime's resource capacity (4 sessions) are not connected by any admission-control mechanism. There is no back-pressure from the pool to the evaluator, no way for the evaluator to schedule sources over time, and no way to tell the user the comp exceeds the machine.

**Redesign direction**: this is exactly the "async scheduler" concept ADR-008 rule 4 assigns to the evaluator. The evaluator must own source admission: which MediaIns get a session this frame, in what priority order (visible fan-in first, then by contribution), with an explicit *degraded* state surfaced to the UI rather than a silent host substitution.

---

### C5 — **High** · `tolerateLag` makes Flarex loaders structurally incoherent during playback, by design

**Files**: [VideoPreview.tsx:3481-3485](apps/web/src/components/VideoPreview.tsx#L3481); [temporal-coherence.ts:216-223](apps/web/src/playback/temporal-coherence.ts#L216).

**Evidence**: `tolerateLag={isFlarexVirtualLayerId(layer.id)}` — Flarex loaders never freeze-hold; they present the latest advancing frame. Meanwhile `shouldHoldForCoherence` returns `false` outright when `playing`.

**Consequences**: **while playing, there is no temporal coherence mechanism for Flarex at all.** Each loader presents its own most-recent frame, at whatever lag its decoder has. While paused, the barrier engages and forcibly aligns them. This is a complete, exact explanation of *"behavior changes between pause and playback"* — the two states run **different synchronization models**, and both are documented as deliberate.

**Architectural impact**: correctness is a function of transport state. That is not a bug in either mechanism; it is the absence of a unified one. Making playback coherent requires gating the transport on render completion, which is a playback-model decision the codebase has explicitly deferred.

**Redesign direction**: adopt a presentation-timestamp model — the transport proposes a target time, the evaluator returns the *latest time for which every participant has a frame*, and the compositor presents that. Playback then runs slightly behind the wall clock but is always coherent, which is what every professional NLE does.

---

### C6 — **High** · Masks and Tracker sample `ctx.timeSeconds`, ignoring the ADR-011 evaluation-context cursor

**Files/functions**: [compile-flarex.ts:677-684](packages/shared/src/flarex/compile-flarex.ts#L677) `rasterizeMatte`; [:1443](packages/shared/src/flarex/compile-flarex.ts#L1443) `tracker` → `sampleTrackingPathAt`; [:490](packages/shared/src/flarex/compile-flarex.ts#L490) `computeFlarexContentHashes`.

**Evidence**:
```ts
const rasterizeMatte = (matte, key) => { ... const tex = mc.get(layerLike, ctx.timeSeconds); ... }
// tracker:
const sample = sampleTrackingPathAt(path, ctx.timeSeconds, ...);
// hashes:
const contentHashes = ...computeFlarexContentHashes(comp, ctx.timeSeconds);
```
All three use `ctx.timeSeconds` (the playhead's comp-local time) while the surrounding evaluation may be running at `activeTimeSeconds` (the retimed time). ADR-011 §2 is quoted in this very file ([:927-934](packages/shared/src/flarex/compile-flarex.ts#L927)) to justify putting time in the *memo key* — the same reasoning applies here and was not carried through.

**Consequences**: under a TimeSpeed, an animated mask node's shape and a Tracker's transform **do not retime**. The picture retimes, the matte does not — they slide apart. This is precisely the "silent divergence" class ADR-007 exists to prevent, reintroduced inside the compiler.

Note the mask node's *parameters* (`num()`) *do* read `activeTimeSeconds` ([:477](packages/shared/src/flarex/compile-flarex.ts#L477)), so the mask **geometry** is retimed but the **matte-cache rasterization time** is not. Since `SceneMaskMatteCache.get` keys on resolved geometry and uses `tLocal` only to resolve mask animations ([scene-mask-matte.ts:209](packages/shared/src/scene/scene-mask-matte.ts#L209)), the practical effect is that *mask-track* animation is un-retimed while *node-param* animation is retimed — two halves of one mask on two different clocks.

**Redesign direction**: `activeTimeSeconds` should not be a mutable module cursor. Evaluation time belongs in an explicit, immutable `EvalContext` value threaded as a parameter, so a site that forgets it fails to compile rather than silently reading the wrong clock. The file's own comment ([:920-924](packages/shared/src/flarex/compile-flarex.ts#L920)) argues the opposite — that threading it would risk "a MISSED one, silent" — and the three sites above are exactly that missed case, arrived at by the chosen alternative.

---

### C7 — **High** · `materialize()` wraps instead of tags, contradicting frozen ADR-008 rule 2

**Files**: [compile-flarex.ts:628-658](packages/shared/src/flarex/compile-flarex.ts#L628); [ADR-008 rule 2](project-tracker/adr/008-flarex-evaluation-engine.md).

**Evidence**: ADR-008 states —
> **Materialize by tagging, not wrapping.** A materialized node is an existing `SceneGroupDraw` flagged `__flarexSealed` … The engine tags the group the compiler already emits; **it does not wrap a second group around it.** Group-valued results therefore materialize with **one** RTT, not two.

Implementation:
```ts
const materialize = (draw: FlarexImageValue, nodeId: string): FlarexWrapGroup => {
  const wrap = newWrap(draw);            // ← a SECOND group
  wrap.__flarexSealed = true;
  ...
};
```

**Consequences**: every group-valued materialization costs two render targets and an extra full-frame composite instead of one — precisely the trap the ADR was written to close. This directly undercuts the `MATERIALIZE_MIN_PASSES = 2` budget heuristic ([:964](packages/shared/src/flarex/compile-flarex.ts#L964)), which was tuned *against the wrapping implementation*: the measured "37.5% slower with the cache on" result at [:962](packages/shared/src/flarex/compile-flarex.ts#L962) is a measurement of the ADR violation, not of materialization.

**Architectural impact**: the cost model that gates materialization was calibrated on a non-conforming implementation. Fixing the implementation invalidates the threshold and probably makes materialization profitable at cost 1.

---

### C8 — **High** · Comp-proxy `VideoFrame`s allocate a new GPU texture per decoded frame, retained 120 frames

**Likelihood: certain whenever a comp proxy plays.**

**Files**: [scene-compositor.ts:985](packages/shared/src/color/scene-compositor.ts#L985) `srcTextures`; [:2057](packages/shared/src/color/scene-compositor.ts#L2057), [:2078-2083](packages/shared/src/color/scene-compositor.ts#L2078); [:2138-2146](packages/shared/src/color/scene-compositor.ts#L2138) `pruneTextures`; [useFlarexCompProxies.ts:344-361](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L344).

**Evidence**: `srcTextures` is `Map<TexImageSource, {tex, w, h, version, lastFrame}>` — **keyed by source object identity**, a strong Map. The proxy publishes `source: held` where `held` is a **fresh `VideoFrame` clone per decoded frame**. Therefore:
- `srcTextures.get(source)` misses every frame → `entry = { tex: this.makeTex(), ... }` → `gl.texImage2D` **full allocation**, every frame.
- The declared `sourceVersion: active.version` can never fire the skip at [:2086](packages/shared/src/color/scene-compositor.ts#L2086), because that check requires `!needAlloc`, which requires an existing entry for **this object**.
- `pruneTextures` deletes only at `frameCounter − lastFrame > 120`. At 60fps that is **two seconds of accumulated per-frame 1080p textures ≈ 120 × 8.3 MB ≈ 1 GB VRAM** steady-state, plus 120 strong references to `VideoFrame` objects that the pump has already `close()`d.

Every other single-ctx media path avoids this by handing over a `SceneTextureSource`, which takes the direct-sample branch at [:2295](packages/shared/src/color/scene-compositor.ts#L2295) and never enters `srcTextures`. The comp proxy is **the only path that hands a raw per-frame object to `SceneLayerDraw.source`**.

**Consequences**: sustained VRAM growth and per-frame texture allocation exactly on the path advertised as the playback optimization. On an integrated GPU this drives eviction — and GL context loss is the documented trigger for the full cold-restart in D8. There is an untracked `PROXY_HIGHFPS_FREEZE_REPORT.md` in the working tree; **[UNVERIFIED — I did not read it]**, but this mechanism is a sufficient cause for that symptom class.

**Redesign direction**: the proxy must publish through the same shared-context grade path as every other source (upload once into a per-comp `RenderTarget`, hand out a `SceneTextureSource`), or `srcTextures` must be keyed on a stable identity token rather than object identity.

---

### C9 — **High** · The content-cache identity omits evaluation-context time

**Files**: [compile-flarex.ts:490](packages/shared/src/flarex/compile-flarex.ts#L490), [:628-658](packages/shared/src/flarex/compile-flarex.ts#L628) `materialize`; [scene-compositor.ts:2647](packages/shared/src/color/scene-compositor.ts#L2647) `contentCacheKey`; [content-hash.ts:62](packages/shared/src/flarex/content-hash.ts#L62).

**Evidence**: content hashes are computed **once per compile, at `ctx.timeSeconds`**:
```ts
const contentHashes = ...computeFlarexContentHashes(comp, ctx.timeSeconds);
```
`materialize()` then stamps `wrap.contentHash = contentHashes.get(nodeId)` **regardless of `activeTimeSeconds`**. The memo key correctly includes time (`${nodeId}@${t.toFixed(6)}`) — so the evaluator *knows* two retimed instances of one node are different content — but the value it stamps on both is the **same hash**.

The compositor's key is `(CONTRACT | nestW×nestH | RENDERER_REV | contentHash | dependencyVersions)`. `dependencyVersions` folds `FLAREX_DEPENDENCY_RESOLVERS.time`, which resolves to `ctx.frameTimeSeconds` — also the *un-retimed* global frame time — plus raster `sourceVersion`s.

**Consequences**: two sealed instances of the same node evaluated at different times within one frame produce identical cache keys. The first populates; the second gets a **hit** and composites the first's pixels. ADR-009 §6 names this the "unforgivable" failure. It is currently masked by **C10** (media subtrees are uncacheable, so most sealed groups never cache) — meaning this is a **latent critical** that activates the moment C10 is fixed.

**Redesign direction**: the ContextVersion axis must include evaluation time whenever the subtree is time-dependent. Hashes must be computed *per evaluation context*, not once per compile — i.e. `computeFlarexContentHashes(comp, activeTimeSeconds)` memoized per distinct time, or folded into the hash at the point of stamping.

---

### C10 — **High** · The Slice-2 content-addressed artifact cache is dead on the shipped preview path

**Files**: [build-scene-draws.ts:645](packages/shared/src/scene/build-scene-draws.ts#L645); [gl-context.ts:277-284](packages/shared/src/color/gl-context.ts#L277); [media-renderer.ts:304](packages/shared/src/color/media-renderer.ts#L304); [compile-flarex.ts:530-557](packages/shared/src/flarex/compile-flarex.ts#L530) `scanSourceIdentity`.

**Evidence**:
```ts
sourceVersion: getTexImageSourceProducerInfo(mediaSource as unknown as TexImageSource)?.updatedAt,
```
`markTexImageSourceProducer` is called at exactly one site — [media-renderer.ts:304](packages/shared/src/color/media-renderer.ts#L304), on `this._canvas`. In single-context preview (default since 2026-07-07) the media source is a **fresh object literal** `{ texture, width, height }` built per call at [ScenePreviewCanvas.tsx:1050](apps/web/src/components/ScenePreviewCanvas.tsx#L1050), never registered in the producer `WeakMap`. So `getTexImageSourceProducerInfo` returns `null` and `sourceVersion` is **always `undefined`** for media on the shipped path.

`scanSourceIdentity` then sets `acc.dynamic = true` for any unversioned raster, and `materialize()` refuses to stamp a `contentHash` when `sources.dynamic`. **Every materialized subtree containing any media is therefore permanently uncacheable.**

**Consequences**: the cache built in Slice 2 — with its budget, tiering, promotion and eviction policy ([scene-compositor.ts:767-970](packages/shared/src/color/scene-compositor.ts#L767)) — can only ever serve generator/mask-only subtrees. `contentCacheStats()` will report near-zero hits on any real comp, and that will read as "the cache doesn't pay for itself" rather than "the cache was never asked".

**Redesign direction**: `SceneTextureSource` needs a first-class content version in its own shape (`{texture, width, height, version}`), published by the grader that owns the RTT — it already computes exactly that value as `entry.lastKey` ([ScenePreviewCanvas.tsx:1046](apps/web/src/components/ScenePreviewCanvas.tsx#L1046)).

---

### C11 — **Medium** · No invalidation edge from the graph to the redraw scheduler

**Files**: [ScenePreviewCanvas.tsx:722](apps/web/src/components/ScenePreviewCanvas.tsx#L722).

**Evidence**:
```ts
useEffect(requestDraw, [layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, nestedGroups]);
```
`flarexComps` and `flarexVirtualLayers` are **absent from the dependency list**, though both are live inputs to the draw build ([:1132-1133](apps/web/src/components/ScenePreviewCanvas.tsx#L1132)).

**Consequences**: a node edit (which bumps `comp.version`) does not, by itself, re-arm the 600ms settle window. It works today only because `layers` is a fresh array on every `VideoPreview` render, so an edit that also re-renders the tree incidentally triggers it. That is invalidation **by accident**. Any future memoization of `sceneLayers` silently breaks paused graph editing.

**Architectural impact**: this is the concrete form of a general problem — **the system has no dirty-propagation mechanism.** There is one global "recomposite for 600ms" timer, armed by whoever remembers to arm it. There is no notion of *what* changed, so there is no notion of *what needs recomputing*.

---

### C12 — **Medium** · The destructive resource prune is skipped whenever a frame is held

**Files**: [ScenePreviewCanvas.tsx:1209-1250](apps/web/src/components/ScenePreviewCanvas.tsx#L1209) (both hold gates `return` early), [:1261-1279](apps/web/src/components/ScenePreviewCanvas.tsx#L1261) (prune).

**Evidence**: both hold gates `return` before the pruning of `sharedGradeRenderersRef` and `sharedMediaRenderersRef`, and before `compositor.renderFrame` (which is what advances `frameCounter` and drives `pruneTextures` / `evictToBudget`).

**Consequences**: during a hold episode — up to 1500ms, and re-armed repeatedly during a scrub — **no GPU resource is reclaimed anywhere in the system**, while grading continues to allocate (`gradeMediaInContext` runs *before* the gates). Sustained scrubbing over a heavy comp is therefore the worst case for VRAM, which is also when context loss is most likely, which triggers D8. This couples the coherence mechanism to the resource-exhaustion failure mode it is most likely to be blamed for.

Additionally, `frameCounter` is the clock for *every* TTL in the compositor (`srcTextures` 120, region graders 300, fragment programs 300, content-cache frames). It advances only on presented frames. All TTLs are therefore denominated in **presented frames**, not time — so a held or idle viewer's caches never age.

---

### C13 — **Medium** · Cross-frame caches are shared between the live path and the capture/thumbnail paths at different times and different roots

**Files**: [ScenePreviewCanvas.tsx:1459-1470](apps/web/src/components/ScenePreviewCanvas.tsx#L1459) `renderIsolated`, [:1549-1564](apps/web/src/components/ScenePreviewCanvas.tsx#L1549) `renderOffscreen`; [scene-mask-matte.ts:199-232](packages/shared/src/scene/scene-mask-matte.ts#L199).

**Evidence**: `matteCacheRef`, `nestMatteCachesRef`, `flarexSourceDrawCacheRef` and `gradeRenderersRef` are all passed to all three build paths. The code argues this is safe because the matte cache re-keys on resolved geometry.

**Consequences**: correctness of *pixels* holds. Correctness of *versions* does not: `SceneMaskMatteCache.versionOf` is bumped on every rebuild ([scene-mask-matte.ts:230](packages/shared/src/scene/scene-mask-matte.ts#L230)), so alternating between the live time and a capture time makes every matte's version change every frame. Those versions feed `maskVersion` → `scanSourceIdentity` → `dependencyVersions` → the content-cache key, and `uploadSource`'s skip. So a thumbnail pass **invalidates the live frame's mask texture cache and content cache**, permanently, for as long as thumbnails are being generated.

The `renderIsolated` path is correctly gated off during playback ([:1441](apps/web/src/components/ScenePreviewCanvas.tsx#L1441)) — so this is a paused-editing cost, which is where node thumbnails run.

Also note: `renderIsolated` calls `compositor.renderFrameThumbnail` which goes through `renderFrameCore` → `ensureSize` → **it resizes the shared accumulators and advances `frameCounter`**, then relies on `requestDraw()` to repaint. The playback gate is what makes this safe; there is no other protection.

---

### C14 — **Medium** · `SceneMaskMatteCache` pool is unbounded and never pruned

**Files**: [scene-mask-matte.ts:167-171](packages/shared/src/scene/scene-mask-matte.ts#L167), [:214-218](packages/shared/src/scene/scene-mask-matte.ts#L214).

Entries are added per key, removed only by `resize()` or `dispose()`. Flarex generates a distinct key per mask node **and per masked consumer** (`flarex_${comp}_${node}_mask` at [compile-flarex.ts:775](packages/shared/src/flarex/compile-flarex.ts#L775), [:854](packages/shared/src/flarex/compile-flarex.ts#L854), [:1157](packages/shared/src/flarex/compile-flarex.ts#L1157), [:1238](packages/shared/src/flarex/compile-flarex.ts#L1238)). Each entry is a **full comp-sized 2D canvas** (~8 MB at 1080p). A comp with 20 mask consumers pins ~160 MB of CPU canvas indefinitely, surviving node deletion.

---

### C15 — **Low** · `FlarexSourceDrawCache` key omits nest dimensions

**Files**: [source-draw-cache.ts:43](packages/shared/src/flarex/source-draw-cache.ts#L43); [build-scene-draws.ts:911](packages/shared/src/scene/build-scene-draws.ts#L911).

Key is `(layerId, compVersion, renderScale)`. The `dims` argument (`w`, `h`, `matteCache`) is **not** in the key, but a Flarex host inside a nested composition is built against the nest's dimensions. Today bare loaders emit `fit:"fill"` identity draws so dimensions do not affect the template — the same argument the file makes for `renderScale`, which *is* keyed defensively. Inconsistent; latent if loaders ever stop being bare.

---

### C16 — **Low** · `fanout` counts matte edges and duplicate edges into one socket

**Files**: [compile-flarex.ts:468-471](packages/shared/src/flarex/compile-flarex.ts#L468).

`edgeInto` dedupes per to-socket (last edge wins); `fanout` counts every edge. A graph with two edges into the same socket (which the healer should prevent **[UNVERIFIED — healer not read]**) inflates fanout and can trigger a materialization that buys nothing.

---

## 10. Root Cause Analysis — every observed symptom

### "Media randomly disappearing"
Three independent mechanisms, all live:
1. **C1** — a MediaIn whose loader has no frame is never held while paused; the frame presents with the node transparent (`"ended"` / retimed `"pending"`) and corrects itself later.
2. **C3** — a proxy dropout unmounts the proxy and remounts cold loaders in the same tick; the comp has no picture at all for the re-warm window.
3. **C4** — past the 4-session budget, a MediaIn simply never gets a decoder. It does not "disappear randomly"; it is deterministically absent, and looks random because *which* MediaIn loses depends on mount order and the host's reserved slot.

### "MediaIn nodes never mounting"
Nodes do not mount (§4). The observable is the **virtual loader**. It fails to mount for three reasons: the pool is full (**C4**); the proxy filter removed it from `activeFlarexVirtualLayers` (**C3**); or `lookupAsset` returned null and `collectFlarexVirtualLayers` skipped it silently ([virtual-layers.ts:301-302](packages/shared/src/flarex/virtual-layers.ts#L301)) — after which `resolveSourceDraw` returns `null` and the compiler shows the **host clip**, so the node appears to be working while showing the wrong shot (**D7**).

### "Sources sometimes appear only after pausing"
Exact mechanism: **C5**. While playing, Flarex loaders run `tolerateLag` (present whatever you have, never hold) and `shouldHoldForCoherence` returns `false` unconditionally. The moment the transport pauses, the coherence barrier engages, withholds the frame until every source converges, and presents them together. The picture visibly "assembles" at the pause. This is the barrier working exactly as designed — the problem is that the design only covers half the transport states.

### "Playback loses textures"
- **C8** for proxied comps: per-frame texture allocation, 120-frame retention, VRAM pressure → eviction → `webglcontextlost` → the bounded rebuild ladder (3 attempts) → on exhaustion, a permanent degrade to the DOM path.
- **C12** compounds it: during scrub/hold episodes nothing is reclaimed while grading keeps allocating.
- **D8**: any context loss clears `flarexSourceDrawCache` and disposes every per-source RTT — a full cold restart of the comp's media.

### "Nodes occasionally stop producing output"
The compiler's soft-degrade lattice makes "produce nothing" a first-class, silent result at **eight** sites: unwired input → `null` ([:1155](packages/shared/src/flarex/compile-flarex.ts#L1155), [:1190](packages/shared/src/flarex/compile-flarex.ts#L1190), …), cycle → `null` ([:1025](packages/shared/src/flarex/compile-flarex.ts#L1025)), missing node → `null` ([:1027](packages/shared/src/flarex/compile-flarex.ts#L1027)), `aiMatte` → **unconditional `null`** ([:1414](packages/shared/src/flarex/compile-flarex.ts#L1414)), generator with no backing layer → `null` ([:1126](packages/shared/src/flarex/compile-flarex.ts#L1126), [:1131](packages/shared/src/flarex/compile-flarex.ts#L1131)), `"ended"` → `null` ([:1078](packages/shared/src/flarex/compile-flarex.ts#L1078)), retimed `"pending"` → `null` ([:1108](packages/shared/src/flarex/compile-flarex.ts#L1108)). A downstream Merge then "keeps only the background", which is the correct compositing answer and an invisible failure report.

### "Preview sometimes recovers without graph changes"
The settle window (**C11**) plus the async arrival of any source: `sink.onFrame() → requestDraw()` re-arms 600ms of compositing, which re-runs the *whole* compile with whatever has landed since. Recovery is a side effect of a timer, not of an invalidation.

### "Behavior changes between pause and playback"
Six distinct behavioural switches keyed on `isPlaying`:
| Switch | Site |
|---|---|
| coherence barrier armed / disarmed | [temporal-coherence.ts:254](apps/web/src/playback/temporal-coherence.ts#L254) |
| not-ready hold covers all layers / media only | [ScenePreviewCanvas.tsx:1208](apps/web/src/components/ScenePreviewCanvas.tsx#L1208) |
| `renderScale` 1 / 0.5 / 0.25 | `playbackRenderScale` prop |
| full-res settle swap active / suppressed | [scene-media-source.ts](apps/web/src/components/scene-media-source.ts) `fullResPending` |
| proxy pump on live clock / committed clock | [useFlarexCompProxies.ts:393](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L393) |
| capture & thumbnails hard-gated off | [ScenePreviewCanvas.tsx:1441](apps/web/src/components/ScenePreviewCanvas.tsx#L1441) |

Each is individually justified. Collectively they mean **the paused renderer and the playing renderer are different renderers**, and no gate reconciles them.

### "Graph appears valid while rendered output is incorrect"
The host-clip substitution (**D7**). `resolveSourceDraw → null` and un-retimed `"pending"` both cause MediaIn to emit `ctx.hostSourceDraw` — a real, correct-looking picture from a completely different asset. The graph is valid, the compile succeeds, the output is a lie. The code documents this trade-off at [compile-flarex.ts:1095-1106](packages/shared/src/flarex/compile-flarex.ts#L1095): removing the fall-back took the `flarex-generators` pixel gate from 0.000% to 86.895%, so it was **scoped to retimed contexts only** and retained everywhere else. That is a decision to keep a known-wrong picture because it makes two renderers agree — a parity fix applied to a correctness problem.

### "Why SceneDraw may become inconsistent"
Within a frame it cannot — it is built in one synchronous pass from one `t`. Inconsistency enters through its **inputs**: media textures from four different served times (C1/C2/C5), a proxy frame from a different clock (C2), mattes rasterized at an un-retimed time (C6), and cached artifacts keyed without evaluation time (C9). The draw list is a faithful record of an incoherent input set.

### "Why node outputs may become detached"
Because a node output is not a thing that can be attached. It is a `SceneDraw` sub-tree holding a **raw pointer** to a texture owned by an unrelated React component's `RenderTarget` (§6). Detachment is the prune at D4 or a dispose at D8 running while a draw still references the texture; today this is prevented only by the ordering of statements inside `drawFrameImpl`, not by any ownership discipline.

---

## 11. Comparison Against Modern Node Compositors

| Concept | Fusion | Nuke | Natron | Blender Compositor | **Flarex** |
|---|---|---|---|---|---|
| Evaluation model | pull, per-frame, request-driven | pull, per-frame, **region-of-interest** | pull (Nuke-derived) | push, node-tree flush | **pull, per-frame, whole-graph** |
| Recursion | yes, memoized | yes, memoized | yes | graph walk | yes, memoized **per frame only** ([:1013](packages/shared/src/flarex/compile-flarex.ts#L1013)) |
| Incremental / dirty propagation | yes (per-tool cache invalidation) | yes (hash-based) | yes | yes (node tag dirty) | **NO** — full rebuild every frame |
| Node-level cache | RAM+disk per tool | RAM+disk, hash-keyed | RAM+disk | limited | `ContentArtifactCache`, **dead on shipped path (C10)** |
| Node render target | every tool materializes | every op materializes | yes | yes | **only when sealed** — the wrap-collapser exists to *avoid* it |
| Region of interest / domain of definition | RoI + DoD | RoI + DoD | RoI + DoD | partial | **absent** — every op is full-frame |
| Frame ownership | frame server owns frames | frame owns its buffers | yes | yes | **frames owned by React components** |
| Texture ownership | engine-owned pool | engine-owned | engine-owned | engine-owned | **compositor-owned, keyed by source object identity** |
| Async scheduler | yes (background render) | yes | yes | yes | **absent** — decoders are React children; no admission control (C4) |
| Execution barriers | frame-complete barrier | frame barrier | yes | yes | **two partial hold gates, paused-only (C1/C2/C5)** |
| Cache invalidation | tool hash | node hash | node hash | dependency graph | `comp.version` (coarse, whole-comp) + content hash (partial) |
| Time / retime model | per-tool TimeSpeed with full upstream retime | TimeOffset/Retime, full | yes | limited | affine-only, **static for media, per-frame for params** (ADR-011), three sites un-retimed (C6) |
| Determinism | yes | yes | yes | yes | **yes for lowering** — this is Flarex's genuine strength |

**Missing runtime concepts, ranked by how much they would change the failure profile:**
1. **Async evaluation scheduler with admission control** — would make C4 a scheduling decision instead of a silent failure.
2. **Frame ownership / a frame-complete barrier spanning all producers** — would subsume C1, C2 and C5 into one mechanism.
3. **Dirty propagation** — would replace C11's 600ms guess with an answer.
4. **Retained node state across frames** — the precondition for any per-node cache, async node, or progress reporting.
5. **Region of interest** — the largest available performance win, currently inexpressible.

**Where Flarex is genuinely ahead**: parity-by-construction (ADR-007) is stronger than what Fusion/Nuke offer between their viewer and their render farm. Preview, local export and Remotion consume *the same lowered draws* from *the same compiler*. That property is rare and valuable and **must survive any rewrite**.

---

## 12. Root Cause Ranking

| # | Flaw | Sev | Likelihood | Primary evidence | Symptoms explained |
|---|---|---|---|---|---|
| **1** | Virtual loaders invisible to the not-ready gate's media classification | Critical | Certain | [ScenePreviewCanvas.tsx:1204](apps/web/src/components/ScenePreviewCanvas.tsx#L1204) | disappearing media; appears-after-pause; incomplete frames |
| **2** | Comp proxy bypasses both gates; different clock; no timestamp | Critical | Certain w/ proxy on | [build-scene-draws.ts:781](packages/shared/src/scene/build-scene-draws.ts#L781), [useFlarexCompProxies.ts:397](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L397) | comp lags/freezes while others advance; coherence instrument reads clean |
| **3** | Proxy state unmounts decoders with no hysteresis | Critical | High | [VideoPreview.tsx:1364](apps/web/src/components/VideoPreview.tsx#L1364) | blank/host-clip flash on span exit and comp edit |
| **4** | Decoder budget (4) < graph capacity, no admission control, silent host fallback | Critical | Certain ≥4 sources | [preview-frame-pool.ts:53](apps/web/src/playback/preview-frame-pool.ts#L53), [compile-flarex.ts:1112](packages/shared/src/flarex/compile-flarex.ts#L1112) | "MediaIn never mounts"; wrong shot shown as if correct |
| **5** | Comp-proxy `VideoFrame` → per-frame texture alloc, 120-frame retention | High | Certain w/ proxy on | [scene-compositor.ts:2078](packages/shared/src/color/scene-compositor.ts#L2078) | VRAM growth; context loss; playback "loses textures" |
| **6** | Playback and pause run different synchronization models | High | Certain | [VideoPreview.tsx:3485](apps/web/src/components/VideoPreview.tsx#L3485), [temporal-coherence.ts:254](apps/web/src/playback/temporal-coherence.ts#L254) | behaviour differs pause vs play |
| **7** | Mask/Tracker/hash sample `ctx.timeSeconds`, not `activeTimeSeconds` | High | Certain w/ TimeSpeed | [compile-flarex.ts:681](packages/shared/src/flarex/compile-flarex.ts#L681), [:1443](packages/shared/src/flarex/compile-flarex.ts#L1443) | matte/track slide off retimed picture |
| **8** | Content-cache key omits evaluation time | High (latent) | Activates when #9 is fixed | [compile-flarex.ts:648](packages/shared/src/flarex/compile-flarex.ts#L648), [scene-compositor.ts:2648](packages/shared/src/color/scene-compositor.ts#L2648) | one node instance's pixels served for another |
| **9** | Artifact cache dead on shipped path (`sourceVersion` always undefined) | High | Certain | [build-scene-draws.ts:645](packages/shared/src/scene/build-scene-draws.ts#L645), [gl-context.ts:281](packages/shared/src/color/gl-context.ts#L281) | Slice-2 win absent; misleading perf conclusions |
| **10** | `materialize()` wraps instead of tags (ADR-008 rule 2) | High | Certain | [compile-flarex.ts:628](packages/shared/src/flarex/compile-flarex.ts#L628) | double RTT; miscalibrated cost threshold |
| **11** | No dirty propagation; single 600ms settle timer; graph absent from deps | Medium | Certain | [ScenePreviewCanvas.tsx:722](apps/web/src/components/ScenePreviewCanvas.tsx#L722) | "recovers on its own"; paused edits landing late |
| **12** | All resource reclamation skipped during hold episodes; TTLs in presented frames | Medium | Certain | [ScenePreviewCanvas.tsx:1249](apps/web/src/components/ScenePreviewCanvas.tsx#L1249), [:2854](packages/shared/src/color/scene-compositor.ts#L2854) | VRAM spikes during scrubbing |
| **13** | Caches shared across live/thumbnail/capture at different times → version churn | Medium | High during node preview | [ScenePreviewCanvas.tsx:1459](apps/web/src/components/ScenePreviewCanvas.tsx#L1459) | mask/content caches permanently invalidated while thumbnailing |
| **14** | `SceneMaskMatteCache` pool unbounded, comp-sized canvases | Medium | Certain w/ many masks | [scene-mask-matte.ts:167](packages/shared/src/scene/scene-mask-matte.ts#L167) | CPU memory growth |
| **15** | `FlarexSourceDrawCache` key omits nest dims | Low | Latent | [source-draw-cache.ts:43](packages/shared/src/flarex/source-draw-cache.ts#L43) | — |
| **16** | `fanout` counts matte + duplicate edges | Low | Low | [compile-flarex.ts:470](packages/shared/src/flarex/compile-flarex.ts#L470) | wasted materialization |

---

## 13. Answers to the Direct Phase Questions

**Who evaluates nodes?** `compileFlarexComp`, synchronously, inside `buildSceneDraws`, inside `drawFrameImpl`, inside one rAF loop. Nothing else.

**Pull or push?** Pull. Backwards DFS from MediaOut (or `previewRootNodeId`, or `comp.previewNodeId`).

**Recursive?** Yes — `evalNode → lowerNode → imageInput → inputValue → evalNode`. Depth-unbounded; the only protections are the `visiting` cycle set and `estimateDrawCost`'s `depth > 8` cutoff.

**Incremental?** **No.** Full re-lowering every composited frame. `comp.version` gates only the source-draw template cache.

**Deterministic?** **Yes**, given identical inputs — this is the design's strongest property. Non-determinism enters only through the inputs (which media arrived, what the pool granted, whether a proxy is serving).

**Frame-based?** Yes, and *only* frame-based. There is no sub-frame or cross-frame execution model.

**Can execution race?** Not within the compiler (single-threaded, synchronous). Races exist at the boundaries: decoder arrival vs composite (mitigated by hold gates, with holes C1/C2), capture vs playback (hard-gated), context loss vs draw (guarded defensively).

**Can execution become partially evaluated?** **Yes, routinely, and by design** — the entire soft-degrade lattice. A partially-evaluated graph is indistinguishable from a fully-evaluated one at every consumer.

**Topological order?** Guaranteed by the memoized DFS.
**Deterministic outputs?** Guaranteed given fixed inputs.
**Single ownership?** **No** — see the ownership matrix; three cross-path shared caches and one shared RTT pool.
**Temporal consistency?** **No.** Not while playing (C5), not for proxies (C2 — ever), not for masks/tracks under retime (C6), and not for un-held loaders while paused (C1).

**Does every rendered frame satisfy "all visible nodes correspond to the same playhead time"?** **No.** Violations, with where the timestamp is lost:
- Timestamps *enter* at `snapshot().stalenessSeconds` / `awaitingFrame` ([scene-media-source.ts](apps/web/src/components/scene-media-source.ts)).
- They are *dropped* the moment `gradeMediaInContext` returns — the `SceneTextureSource` carries no time. From that point the draw list has no temporal information whatsoever.
- They **never exist** for comp proxies.
- They are **not consulted at all** while playing.
- **Stale frames become legal** at [ScenePreviewCanvas.tsx:996](apps/web/src/components/ScenePreviewCanvas.tsx#L996) (held-texture anti-flicker) and via both escape hatches (`STALE_HOLD_MAX_MS`, per-source write-off).
- **Future frames become legal** via the proxy's live-clock pump (C2).
- **Mixed timestamps become possible** in every composite containing a proxied comp, and in every composite while playing.

---

## 14. Recommended Architecture

No code. Six structural changes, ordered so each is shippable and each makes the next cheaper.

### R1 — A participant registry: one list of everything that supplies pixels
Today the presentation gate reasons over `layers` (timeline), is handed `flarexVirtualLayers` separately, and cannot see proxies at all. Replace all three with **one registry of frame participants**, each declaring: stable id, kind (timeline media / loader / generator / comp proxy / raster), whether it is time-varying, its served time, and its readiness. The gates then consume typed records instead of doing id lookups against the wrong list.

This alone closes **C1** and makes **C2** expressible. It is the smallest change with the largest symptom coverage.

### R2 — Presentation timestamps, not readiness booleans
Make `SceneTextureSource` (and every draw source) carry the time it represents. The composite then *is* a temporal object: `presentedTime = min over participants of servedTime`. The barrier becomes a query on the draw list rather than a side-channel collected during grading.

This makes the invariant checkable at the point of present rather than reconstructed from an instrument, and it survives into the export path unchanged (where it is trivially satisfied).

### R3 — One synchronization model for both transport states
Replace `tolerateLag` + paused-only barrier with a **presentation-time model**: the transport proposes a target; the evaluator answers with the latest time every participant can serve; the compositor presents that. Playback runs a bounded distance behind wall-clock (an explicit, tunable latency) and is *always* coherent. Audio stays master; the video pipeline tracks it with a declared lag budget rather than a per-source lag tolerance.

This closes **C5** and eliminates the entire class of "differs between pause and play".

### R4 — The evaluator owns source admission and scheduling
Give the evaluator the decoder budget. Before lowering, it walks the graph, determines which MediaIns contribute to the current frame's output, ranks them (visible fan-in, contribution weight, on-screen area), and assigns sessions. Sources it cannot admit are reported as an **explicit degraded state** that reaches the UI — a node badge, not a silent host substitution.

**Delete the host-clip fallback.** `resolveSourceDraw → null` must mean "no picture", never "someone else's picture". The pixel-gate regression that motivated keeping it (`flarex-generators` 0.000% → 86.895%) is a *readiness race between two renderers*, and the correct fix is R2 (both renderers wait for the same declared readiness), not showing the wrong frame in both.

This closes **C4** and **D7**, and makes **C3** a scheduling decision (keep loaders at `preload` priority behind a proxy) instead of an unmount.

### R5 — Node identity that survives a frame
Introduce a retained per-node evaluation record keyed by `(nodeId, evalContext)` where `evalContext` includes evaluation time. It holds the node's content hash, its last artifact handle, its declared dependencies and its dirty state. Three things follow immediately:
- **Dirty propagation** replaces the 600ms settle guess (**C11**): a param edit marks a node dirty, dirt propagates downstream through the wiring, and exactly the affected subtrees recompute.
- **The content cache gains a correct key** — evaluation time is part of the record, closing **C9**.
- **Async nodes become expressible** — a node can be *pending* as a state rather than as a null return.

`evaluationKey` is already the slot identity this record wants. ADR-009's `CacheKey = (ContractVersion, ContextVersion, NodeContentHash)` is already the right key; it just needs ContextVersion to include evaluation time.

### R6 — Texture handles, not pointers
Replace raw `WebGLTexture` references in draws with **handles owned by the compositor**: `{ id, generation }`. A consumer resolves a handle at sample time; a stale generation resolves to the compositor's `emptyTex` and is *reported*, not silently substituted. Version them properly so **C10** stops being invisible:
- `SceneTextureSource` gains a `version` — the grader already computes it (`entry.lastKey`).
- The comp proxy publishes through the same shared-context grade path as every other source, which incidentally closes **C8** (one RTT per comp instead of one texture per decoded frame).
- Resource reclamation moves off the "presented frame" clock onto wall-time, closing **C12**.

### What must not change
- **ADR-007 parity-by-construction.** The compiler emits `SceneDraw` and nothing else. Every change above is either in front of the compiler (R1, R4), behind it (R6), or beside it (R2, R3, R5). No proposal here introduces a preview-only rendering path.
- **The wrap-collapser.** Folding consecutive ops into one shell is what makes a grade chain usable on an integrated GPU. R5 makes materialization *cheaper to decide*, not more frequent.
- **The lowering compiler's purity and determinism.** These are the reason a rewrite of the layer above is tractable at all.

### Suggested order
`R1 → R2 → R4 (delete host fallback) → R3 → R6 → R5`.

R1+R2 are small and close the three Critical symptom classes. R4 converts the remaining Criticals from silent wrongness into visible degradation, which is the precondition for measuring anything honestly. R3 unifies the transport states. R6 and R5 are the actual engine, and both are much cheaper once the first four have removed the confounds.

---

## 15. Uncertainty Register

Claims I could not verify by reading code, and what would settle them:

| # | Open question | File to inspect |
|---|---|---|
| U1 | How `WebglMediaLayer` constructs `snapshot()`, computes `stalenessSeconds`, and publishes `frameVersion` — I read the *contract* ([scene-media-source.ts](apps/web/src/components/scene-media-source.ts)) but not the producer. | `apps/web/src/components/WebglMediaLayer.tsx` |
| U2 | Whether the graph healer truly enforces one edge per to-socket (assumed by `edgeInto` and `content-hash`). | the `flarex.*` timeline actions / healer |
| U3 | Session-sharing and preemption semantics in the pool (`exclusiveDecode`, priority demotion) — I read the caps and `reserveSession`, not the sharing path. | `apps/web/src/playback/preview-frame-pool.ts` |
| U4 | Whether the Remotion/worker path (`SceneStage.tsx`) reproduces C6 and C9 — it goes through the same compiler, so probably yes, but its loader mounting is a `Sequence`-based model I only grepped. | `apps/worker/src/remotion/SceneStage.tsx` |
| U5 | Whether the local-export path (`scene-frame-compositor.ts`) shares the `sourceVersion: undefined` problem (C10) — it has its own grade path. | `apps/web/src/export/scene-frame-compositor.ts` |
| U6 | Measured VRAM behaviour under proxy playback — C8 is derived from code, not from a trace. The untracked `PROXY_HIGHFPS_FREEZE_REPORT.md` in the working tree may already contain it. | a DevTools memory trace with `?flarexProxy=1` |
| U7 | Whether `frameProfiler` instrumentation itself perturbs the hot path (there is a `tmp/flarex-observer-effect.ts` suggesting this was investigated). | `packages/shared/src/color/frame-profiler.ts` |
| U8 | `node-defs.ts` socket ordering guarantees relied on by `content-hash`'s R3 fold. | `packages/shared/src/flarex/node-defs.ts` |
