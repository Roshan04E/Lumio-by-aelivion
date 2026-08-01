# Flarex — Architecture Ownership Review & Runtime Redesign Blueprint

**Companion to** [FLAREX_RUNTIME_AUDIT.md](FLAREX_RUNTIME_AUDIT.md) (runtime reconstruction, failure discovery).
**This document** answers a different question: *who should own what*, where the current implementation puts ownership in the wrong place, and what the runtime should be rebuilt into.

**Method**: the correct architecture is derived first, from compositor-engine principles, without reference to the implementation. Only then is the implementation compared against it. Every mismatch is traced to code.

**Status of the prior audit**: findings C1–C16 re-verified. **Three corrections and two new findings** are recorded in §0.

---

## 0. Corrections and Additions to the Previous Audit

### 0.1 CORRECTION — the staleness reference clock is the committed clock, not the live one

The previous audit raised a concern that `stalenessSeconds` might be measured against a different clock than the composite. **It is not.** `computeStalenessSeconds` reads `wcTimeRef.current.currentTime` ([WebglMediaLayer.tsx:641](apps/web/src/components/WebglMediaLayer.tsx#L641)), which is assigned from `props.currentTime` ([:614](apps/web/src/components/WebglMediaLayer.tsx#L614)) — the **committed** clock, the same one `ScenePreviewCanvas` builds the draw list from. The docstring's phrase "the LIVE playhead" is imprecise; the value is correct.

**The clock split is therefore confined to the comp proxy** ([useFlarexCompProxies.ts:397](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L397), `getLivePlaybackTime()`), exactly as C2 scoped it. The previous report's C2 stands; no other source is affected.

### 0.2 CORRECTION — a virtual loader measures staleness against a *different* time than the gate that ends it

Two independent notions of "where is this loader" exist and they do not agree:

| Consumer | Time used | Site |
|---|---|---|
| the loader's own staleness | `vTime = min(currentTime, holdEnd)` — **clamped to media end** | [VideoPreview.tsx:2018](apps/web/src/components/VideoPreview.tsx#L2018) → `props.currentTime` |
| the `"ended"` gate in `resolveSourceDraw` | `localT = max(0, t − layer.startSeconds)` — **unclamped** | [build-scene-draws.ts:822](packages/shared/src/scene/build-scene-draws.ts#L822) |

Past a short source's end the loader reports *coherent* (it is serving the clamped request correctly) while the compiler reports *ended* (produce nothing). Both are individually defensible; together they mean the coherence instrument records a healthy source for a node that is drawing nothing. This is a **minor** finding but it is a clean example of the systemic disease: two subsystems each own half of "where is this media", and neither owns the whole.

### 0.3 NEW — graph structural validity is owned by a React canvas component

Two separate compiler comments assert an invariant that is not enforced where they say it is:

> `// to-socket → edge (a socket accepts at most one wire; the healer enforces endpoint validity).` — [compile-flarex.ts:461](packages/shared/src/flarex/compile-flarex.ts#L461)
> `// to-socket → from-node (a socket accepts at most one wire; the healer enforces this).` — [content-hash.ts:65](packages/shared/src/flarex/content-hash.ts#L65)

`healFlarexRegistry` ([registry.ts:110-141](packages/shared/src/flarex/registry.ts#L110)) validates **only** that both endpoints exist and that socket *types* match ([isValidFlarexEdge, :48](packages/shared/src/flarex/registry.ts#L48)). It contains no cardinality check whatsoever. The one-wire-per-input rule is enforced at exactly one place in the codebase:

```ts
// apps/web/src/editor/flarex/FlarexNodeCanvas.tsx:1144
const edges = current.edges.filter((e) => !(e.to.nodeId === edge.to.nodeId && e.to.socket === edge.to.socket));
return { ...current, edges: [...edges, edge] };
```

— a **UI drag handler**. The other two edge-creating paths in the same file do not dedupe: [:1235](apps/web/src/editor/flarex/FlarexNodeCanvas.tsx#L1235) (`edges: [...next.edges, edge]`) and [:1355](apps/web/src/editor/flarex/FlarexNodeCanvas.tsx#L1355) (paste). `node-graph-intent.ts` ([:173-183](packages/shared/src/flarex/node-graph-intent.ts#L173)) is a third writer — the AI/intent surface — which filters only edges into MediaOut.

**Consequence when the invariant breaks** (paste of an overlapping selection, an AI-generated graph, a hand-edited project file, a merge):

| Consumer | Behaviour with two edges into one socket |
|---|---|
| `compile-flarex.edgeInto` | Map — **last edge in array order wins** |
| `content-hash.edgeInto` | Map — same, so the hash agrees with the compiler |
| `compile-flarex.fanout` | counts **both** → can trigger a materialization that dedupes nothing |
| `time-transform.resolveFlarexMediaInRetimes.incoming` | array — **visits both**, so the retime walk sees a graph the compiler does not ([time-transform.ts:106-112](packages/shared/src/flarex/time-transform.ts#L106)) |

The retime resolver and the compiler therefore disagree about the graph's shape, which means the **loader's rate** and the **evaluation-context time** can be derived from different edges. That is exactly the picture/params divergence ADR-011 exists to prevent, reachable through an unenforced invariant.

**Ownership verdict**: graph well-formedness is a **model** responsibility that has been left to a **view**. It is unowned in every non-interactive path — load, paste, AI generation, import, undo.

### 0.4 NEW — the content-addressed artifact cache is live in the worker and dead in the browser

The previous audit established (C10) that `sourceVersion` is always `undefined` on the single-context preview path, because `markTexImageSourceProducer` is only ever called on a `MediaWebGLRenderer`'s own canvas ([media-renderer.ts:304](packages/shared/src/color/media-renderer.ts#L304)) and single-ctx hands out a fresh `{texture,width,height}` literal instead.

Verifying the other two renderers:

- **Remotion worker** — `SceneStage` grades through `new MediaWebGLRenderer(document.createElement("canvas"))` ([SceneStage.tsx:236](apps/worker/src/remotion/SceneStage.tsx#L236)) and resolves media as `gradedById.get(id)` ([:352](apps/worker/src/remotion/SceneStage.tsx#L352)) — **own-canvas path, producer info marked, `sourceVersion` defined.**
- **Local single-context export** — `scene-frame-compositor.ts` contains **no** reference to `sourceVersion` or `getTexImageSourceProducerInfo`; it grades into shared-context RTTs like the preview, so it inherits the preview's `undefined`.

So `scanSourceIdentity` marks media subtrees `dynamic` (uncacheable) in preview and local export, and **not** in the Remotion worker.

**This inverts the risk profile of C9.** The cache key that omits evaluation-context time is *inert* in the browser precisely because the cache never populates there — and *live* in the worker, which is the renderer that must be byte-exact. A retimed comp with a materialized node under a TimeSpeed can, in the worker, hit a cache entry stamped with a hash computed at the wrong time ([compile-flarex.ts:490](packages/shared/src/flarex/compile-flarex.ts#L490) computes hashes once at `ctx.timeSeconds`; [:648](packages/shared/src/flarex/compile-flarex.ts#L648) stamps them regardless of `activeTimeSeconds`).

**This is an ADR-007 parity violation of a new kind**: not a rendering-path difference, but a *caching* difference that changes which pixels each renderer produces. It is the precise counterexample to the invariant "a cache must never change correctness" (§6, I-19).

### 0.5 What the previous audit got right and this one confirms

C1 (loader misclassification), C2 (proxy bypasses gates), C3 (proxy unmounts decoders), C4 (decoder budget < graph capacity), C5 (`tolerateLag` + paused-only barrier), C6 (three un-retimed time reads), C7 (`materialize` wraps not tags), C8 (per-frame `VideoFrame` textures) — all re-verified against code, unchanged.

---

# Part 1 — Responsibility Matrix

Verdict key: **OK** · **SPLIT** (two+ owners, no arbiter) · **MISSING** (nobody owns it) · **DUP** (duplicated implementation) · **WRONG** (owned by a subsystem that shouldn't) · **INTERFERE** (another subsystem reaches in).

| # | Responsibility | Owner today | Should own | Verdict | Evidence |
|---|---|---|---|---|---|
| 1 | **Timeline ownership** | `ProjectGraph` / timeline actions | Document model | **OK** | `stampFlarexComp` write-through seam ([registry.ts:42](packages/shared/src/flarex/registry.ts#L42)) |
| 2 | **Graph structural validity** | `FlarexNodeCanvas` drag handler | Document model (registry/healer) | **WRONG + MISSING** | §0.3; [registry.ts:110](packages/shared/src/flarex/registry.ts#L110) has no cardinality check |
| 3 | **Playback clock** | `playback-clock` module singleton | Transport | **SPLIT** — 4 clocks: committed, live, cold, per-loader `vTime` | [playback-clock.ts:19](apps/web/src/playback/playback-clock.ts#L19), [:137](apps/web/src/playback/playback-clock.ts#L137); [VideoPreview.tsx:2018](apps/web/src/components/VideoPreview.tsx#L2018) |
| 4 | **Frame scheduling** (which frame to attempt) | `ScenePreviewCanvas` rAF + 600ms settle timer | Frame Scheduler | **WRONG** — a presentation surface decides what work happens | [ScenePreviewCanvas.tsx:716](apps/web/src/components/ScenePreviewCanvas.tsx#L716), [:1330](apps/web/src/components/ScenePreviewCanvas.tsx#L1330) |
| 5 | **Evaluation scheduling** | — | Evaluation Scheduler | **MISSING** | evaluation is a synchronous call inside a draw builder inside a rAF |
| 6 | **Node lifecycle** | — | Evaluator | **MISSING** — nodes have no runtime existence | [compile-flarex.ts:1054](packages/shared/src/flarex/compile-flarex.ts#L1054) |
| 7 | **Graph traversal** | `compileFlarexComp` (memoized DFS) | Evaluator | **OK** — the one cleanly-owned responsibility | [:1013](packages/shared/src/flarex/compile-flarex.ts#L1013) |
| 8 | **Dependency tracking** | split: `def.dependencies` (fragment registry) + `scanSourceIdentity` (draw walk) + `edgeInto` (wiring) | Evaluator | **SPLIT** — three notions of "what does this depend on", none complete | [:497](packages/shared/src/flarex/compile-flarex.ts#L497), [:538](packages/shared/src/flarex/compile-flarex.ts#L538), [:468](packages/shared/src/flarex/compile-flarex.ts#L468) |
| 9 | **Dirty propagation** | — | Evaluator | **MISSING** — `comp.version` is whole-comp, and re-lowering is unconditional anyway | [source-draw-cache.ts:43](packages/shared/src/flarex/source-draw-cache.ts#L43) |
| 10 | **Graph invalidation** | React dependency arrays | Evaluator | **WRONG + INCOMPLETE** — `flarexComps` absent from the redraw deps | [ScenePreviewCanvas.tsx:722](apps/web/src/components/ScenePreviewCanvas.tsx#L722) |
| 11 | **Media admission** (which sources get to decode) | `preview-frame-pool` first-come + priority | Source Admission (evaluator-driven) | **WRONG** — a pool allocator makes a compositing decision with no graph knowledge | [preview-frame-pool.ts:850](apps/web/src/playback/preview-frame-pool.ts#L850) |
| 12 | **Decoder ownership** | React `<PreviewLayer>` mount + pool lease | Decode Coordinator | **SPLIT + WRONG** — lifetime is a React reconciliation outcome | [VideoPreview.tsx:2003](apps/web/src/components/VideoPreview.tsx#L2003) |
| 13 | **Media readiness** | `snapshot().awaitingFrame` + `onLayerNotReady` + `staleIds` | Readiness Barrier | **SPLIT (3 channels)** and one is blind to loaders | [scene-media-source.ts](apps/web/src/components/scene-media-source.ts); [ScenePreviewCanvas.tsx:1204](apps/web/src/components/ScenePreviewCanvas.tsx#L1204) |
| 14 | **Texture ownership** | `SceneCompositor.srcTextures` (object-identity Map) + `sharedMediaRenderersRef` (React ref) + `ContentArtifactCache` | Resource Manager | **SPLIT (3 owners)** | [scene-compositor.ts:985](packages/shared/src/color/scene-compositor.ts#L985); [ScenePreviewCanvas.tsx:587](apps/web/src/components/ScenePreviewCanvas.tsx#L587) |
| 15 | **GPU resource lifetime** | prune-by-`frameCounter` in compositor + prune-by-`liveMediaSourceIds` in React | Resource Manager | **SPLIT + INTERFERE** — the React prune is gated by a *presentation* decision | [ScenePreviewCanvas.tsx:1272](apps/web/src/components/ScenePreviewCanvas.tsx#L1272) |
| 16 | **Materialization decision** | `shouldMaterialize` in the compiler | Evaluator | **WRONG LAYER (but right shape)** — the compiler is meant to be a pure lowering, per ADR-007 | [compile-flarex.ts:978](packages/shared/src/flarex/compile-flarex.ts#L978) |
| 17 | **Materialization mechanism** | `materialize()` wraps a new group | Evaluator (tag, not wrap) | **VIOLATES ADR-008 rule 2** | [:628](packages/shared/src/flarex/compile-flarex.ts#L628) |
| 18 | **Evaluation cache** | per-frame `memo` Map, discarded | Evaluator | **MISSING cross-frame** | [:912](packages/shared/src/flarex/compile-flarex.ts#L912) |
| 19 | **Artifact cache** | `ContentArtifactCache` in the compositor; key built by compositor from compiler-supplied hash | Evaluator owns key; Resource Manager owns storage | **SPLIT + inert in browser, live in worker** | §0.4; [scene-compositor.ts:2647](packages/shared/src/color/scene-compositor.ts#L2647) |
| 20 | **SceneDraw construction** | `build-scene-draws` + `compile-flarex` | Lowering layer | **OK** — clean, pure, shared by all three renderers | [build-scene-draws.ts:948](packages/shared/src/scene/build-scene-draws.ts#L948) |
| 21 | **SceneDraw lifetime** | GC (one function call) | Lowering layer | **OK by triviality** — nothing retains one | — |
| 22 | **Presentation scheduling** | `ScenePreviewCanvas` rAF | Presentation Scheduler | **CONFLATED with #4** — one loop owns both "compute" and "present" | [ScenePreviewCanvas.tsx:1330](apps/web/src/components/ScenePreviewCanvas.tsx#L1330) |
| 23 | **Presentation barrier** | two gates in `drawFrameImpl` | Presentation Barrier | **SPLIT + INCOMPLETE** — blind to proxies, misclassifies loaders | [:1209](apps/web/src/components/ScenePreviewCanvas.tsx#L1209) |
| 24 | **Temporal coherence** | `temporal-coherence.ts` (pure) driven by `ScenePreviewCanvas` | Presentation Barrier | **PARTIAL** — paused only, by design | [temporal-coherence.ts:254](apps/web/src/playback/temporal-coherence.ts#L254) |
| 25 | **Synchronization** | 3 boundaries total (2 hold gates + capture/playback gate) | Frame Scheduler | **LARGELY MISSING** — the pipeline is dirty-mark + timer | §8 of prior audit |
| 26 | **Frame completion** | — | Frame Scheduler | **MISSING** — there is no "this frame is done" signal anywhere | — |
| 27 | **Error handling** | try/catch → `fail()` → DOM fallback | Diagnostics + Frame Scheduler | **PARTIAL** — catches GL failures, silent for graph failures | [ScenePreviewCanvas.tsx:695](apps/web/src/components/ScenePreviewCanvas.tsx#L695) |
| 28 | **Soft degradation** | `compile-flarex` return values (8 null sites) | Evaluator, with a *reported* degraded state | **WRONG** — degradation is a policy, encoded as a return value | [compile-flarex.ts:1078](packages/shared/src/flarex/compile-flarex.ts#L1078), [:1108](packages/shared/src/flarex/compile-flarex.ts#L1108), [:1414](packages/shared/src/flarex/compile-flarex.ts#L1414) |
| 29 | **Fallback policy** (host-clip substitution) | `compile-flarex` | Nobody — should not exist | **WRONG + DANGEROUS** | [:1112](packages/shared/src/flarex/compile-flarex.ts#L1112) |
| 30 | **Node preview generation** | `SceneViewerCaptureHandle.renderFlarexNodeThumbnail` | Evaluator (a re-rooted evaluation) | **WRONG LAYER** — the presentation surface owns it | [ScenePreviewCanvas.tsx:1575](apps/web/src/components/ScenePreviewCanvas.tsx#L1575) |
| 31 | **Thumbnail rendering** | same handle, shares live caches | Resource Manager (scratch scope) | **INTERFERE** — bumps shared matte versions, resizes shared accumulators | [:1483](apps/web/src/components/ScenePreviewCanvas.tsx#L1483); [scene-mask-matte.ts:230](packages/shared/src/scene/scene-mask-matte.ts#L230) |
| 32 | **Capture rendering** (proxy generation) | same handle | Offline Render Service | **INTERFERE** — same shared pools, gated only by `isPlaying` | [ScenePreviewCanvas.tsx:1537](apps/web/src/components/ScenePreviewCanvas.tsx#L1537) |
| 33 | **Export rendering** | `export-core` / `scene-frame-compositor` / `SceneStage` | Offline Render Service | **OK structurally** — all three re-enter the same lowering | [build-scene-draws.ts](packages/shared/src/scene/build-scene-draws.ts) |
| 34 | **Resource budgeting** | 4 independent budgets: WC sessions, GL contexts, content-cache bytes, texture TTL | Resource Manager | **SPLIT (4)** — no global VRAM/session view | [preview-frame-pool.ts:53](apps/web/src/playback/preview-frame-pool.ts#L53); [scene-compositor.ts:767](packages/shared/src/color/scene-compositor.ts#L767) |
| 35 | **Memory reclamation** | prunes on the presented-frame clock | Resource Manager (wall clock) | **WRONG CLOCK + gated by presentation** | [scene-compositor.ts:2854](packages/shared/src/color/scene-compositor.ts#L2854), [:2881](packages/shared/src/color/scene-compositor.ts#L2881) |
| 36 | **Performance policy** (render scale, quality tier) | `VideoPreview` props + adaptive controller | Performance Governor | **SPLIT** — scale is a prop, tier is elsewhere, proxy eligibility is a third hook | [useFlarexCompProxies.ts:174](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L174) |
| 37 | **Proxy management** | `useFlarexCompProxies` (React hook: eligibility + decode + publish + loader suppression) | split between Evaluator (substitution) and Decode Coordinator (decode) | **WRONG + DUP** — a hook owns four different responsibilities | [useFlarexCompProxies.ts](apps/web/src/editor/flarex/useFlarexCompProxies.ts) |
| 38 | **Virtual layer management** | `collectFlarexVirtualLayers` (pure) + `VideoPreview` useMemo + proxy filter | Evaluator (source declaration) | **SPLIT** — derivation is pure, but *which ones exist* is a React memo filtered by rendering policy | [virtual-layers.ts:265](packages/shared/src/flarex/virtual-layers.ts#L265); [VideoPreview.tsx:1364](apps/web/src/components/VideoPreview.tsx#L1364) |
| 39 | **React integration** | pervasive — React owns decoder lifetime, cache lifetime, virtual-layer set, proxy state | should be a *view* of runtime state only | **WRONG** — the deepest structural problem | §2.6 |
| 40 | **WebGL integration** | `SceneCompositor` + `MediaWebGLRenderer` + per-layer contexts + governor | Resource Manager + Compositor | **PARTIAL OK** — the single-context migration largely fixed this | [gl-context.ts:266](packages/shared/src/color/gl-context.ts#L266) |
| 41 | **Worker interaction** | none on this path (BullMQ/Remotion is a separate process) | Offline Render Service | **N/A for preview** — and worth noting: **zero worker parallelism in the preview runtime** | — |

### Summary of the matrix

- **41 responsibilities. 6 cleanly owned.** (#1, #7, #20, #21, #33, and #40 partially.)
- **7 are entirely unowned** (#5, #6, #9, #26, and #2/#25/#34 in their non-interactive paths).
- **11 are split with no arbiter.**
- **8 are owned by the wrong layer**, of which 5 are owned by React or by a React-rendered presentation surface.

The single strongest signal in this matrix: **the two things that are cleanly owned (graph traversal, SceneDraw construction) are the two things that live in `packages/shared` as pure functions.** Everything owned by the app layer is split, missing or misplaced. That is not a coincidence — it is the shape of a system where a rendering *surface* grew into a runtime *kernel*.

---

# Part 2 — Ownership Violations, Ranked

### V1 — **Critical** · Presentation policy controls resource lifetime

**Pattern**: *rendering policy changes resource lifetime.*

Three instances, all live:

1. **Proxy serving unmounts decoders.** `servingCompIds` (a *rendering* decision: "may a cached frame stand in?") filters `activeFlarexVirtualLayers`, which unmounts `<PreviewLayer>`s, which releases pool sessions ([VideoPreview.tsx:1364](apps/web/src/components/VideoPreview.tsx#L1364)). The hook's own docstring defends this as load-bearing.
2. **The presentation hold skips all reclamation.** Both hold gates `return` before the renderer prune, the compositor prune and `evictToBudget` ([ScenePreviewCanvas.tsx:1249](apps/web/src/components/ScenePreviewCanvas.tsx#L1249)) — while `gradeMediaInContext`, which runs *before* the gates, keeps allocating.
3. **All GPU TTLs are denominated in presented frames.** `frameCounter` advances only inside `renderFrameCore` ([scene-compositor.ts:2854](packages/shared/src/color/scene-compositor.ts#L2854)). A viewer that is holding, idle or hidden never ages a single cache entry.

**Why dangerous**: it creates a **positive feedback loop**. Sources are slow → frames are held → nothing is reclaimed → VRAM climbs → the driver evicts a context → `webglcontextlost` → every RTT and cache is destroyed ([ScenePreviewCanvas.tsx:602](apps/web/src/components/ScenePreviewCanvas.tsx#L602)) → every source restarts cold → sources are slow. The system's recovery mechanism is also its amplifier. No amount of timeout tuning breaks a loop of this shape.

---

### V2 — **Critical** · React owns runtime state

**Pattern**: *React owns runtime state.*

| Runtime state | React construct that owns it |
|---|---|
| which media sources exist | `useMemo` → `activeFlarexVirtualLayers` |
| decoder session lifetime | component mount/unmount + `key` |
| graded RTT lifetime | `useRef<Map>` + a prune inside a draw callback |
| matte / source-draw cache lifetime | `useRef` + effect cleanup |
| proxy decode state | `useRef<Map<string, ActiveProxy>>` + `useState` |
| when evaluation happens | `useEffect` dependency arrays + a 600ms timer |
| whether the graph re-evaluates after an edit | **incidental array identity** ([:722](apps/web/src/components/ScenePreviewCanvas.tsx#L722)) |

**Why dangerous**: React's reconciler is a *view* scheduler. Its guarantees are about DOM consistency, not about resource continuity, ordering or completion. Concretely:

- A memo recompute is a **decoder teardown**. Nothing about `useMemo` promises stability, and nothing warns when it churns.
- There is no ordering guarantee between "publish the new proxy frame" and "unmount the old loaders" — C3's re-warm hole is exactly a missing ordering constraint that React cannot express.
- A future optimization (memoizing `sceneLayers`) silently breaks paused graph editing, because invalidation currently rides on that array's identity.

This is the deepest violation in the system. Every other one is easier to fix and several become trivial once runtime state moves out of React.

---

### V3 — **Critical** · No system owns "is this frame complete?"

**Pattern**: *no system owns the responsibility.*

There is no frame-completion signal anywhere in the runtime. What exists instead is `requestDraw()` — "keep compositing for 600ms and hope" ([ScenePreviewCanvas.tsx:716](apps/web/src/components/ScenePreviewCanvas.tsx#L716)). Consequences:

- Convergence is a **timer**, not a state. `SCENE_SETTLE_MS = 600`, `NOT_READY_HOLD_MS = 300`, `NOT_READY_HOLD_MEDIA_MS = 1500`, `STALE_HOLD_MAX_MS = 1500`, full-res debounce ~300ms — five independent timeouts standing in for one missing predicate.
- "Preview sometimes recovers without graph changes" is this violation observed from outside: recovery is a *side effect* of a timer expiring after something happened to land.
- Nothing can be *awaited*. Export, capture and thumbnails all reimplement "is it ready yet" differently.

**Why dangerous**: a system with no completion predicate cannot be made deterministic by any amount of local correction. Every fix is a timeout adjustment, and every timeout adjustment trades one symptom for another.

---

### V4 — **Critical** · The compiler owns runtime policy

**Pattern**: *the compiler owns runtime policy.*

ADR-007 defines `compileFlarexComp` as a **pure deterministic lowering** — that is the whole basis of parity-by-construction. It currently also owns:

| Policy | Site |
|---|---|
| materialization decision (fanout + cost budget) | [:978](packages/shared/src/flarex/compile-flarex.ts#L978) |
| materialization mechanism (wrap, not tag) | [:628](packages/shared/src/flarex/compile-flarex.ts#L628) |
| cache identity construction | [:644-656](packages/shared/src/flarex/compile-flarex.ts#L644) |
| **degradation policy** — 8 distinct "produce nothing" decisions | [:1025](packages/shared/src/flarex/compile-flarex.ts#L1025), [:1078](packages/shared/src/flarex/compile-flarex.ts#L1078), [:1108](packages/shared/src/flarex/compile-flarex.ts#L1108), [:1131](packages/shared/src/flarex/compile-flarex.ts#L1131), [:1414](packages/shared/src/flarex/compile-flarex.ts#L1414) … |
| **fallback policy** — substitute the host clip | [:1112](packages/shared/src/flarex/compile-flarex.ts#L1112) |
| a pipeline-cache side effect on module state | [:441](packages/shared/src/flarex/compile-flarex.ts#L441) `flarexEffectListCache` |

**Why dangerous**: policy in the lowering layer is policy that **cannot be observed, overridden, or reported**. `resolveSourceDraw → null` becomes "show the host clip" three call-frames deep inside a pure function with no channel to say so. The user sees a valid graph rendering the wrong asset, and no instrument in the system records that a substitution occurred.

It also means every renderer inherits the policy identically — which sounds like parity, and is actually how a wrong picture becomes *consistently* wrong across preview and export. The `flarex-generators` pixel gate going 0.000% → 86.895% when the fallback was removed ([:1096](packages/shared/src/flarex/compile-flarex.ts#L1096)) is the system reporting that its parity test was passing *because* both renderers substituted the same wrong frame.

---

### V5 — **Critical** · Media admission is owned by an allocator with no graph knowledge

**Pattern**: *no system owns the responsibility* (admission), plus *interference*.

`reserveSession` ([preview-frame-pool.ts:850](apps/web/src/playback/preview-frame-pool.ts#L850)) grants decoder sessions on arrival order + a two-level priority, under `MAX_WC_TOTAL_SESSIONS = 4`. It knows nothing about: which MediaIns are reachable from MediaOut, which contribute visible pixels, which are behind a disabled node, which are under a Merge whose opacity is 0, or which the user is currently looking at.

**Why dangerous**: the losing MediaIn does not fail — it **succeeds at showing the wrong thing** (V4's fallback). A resource shortage is thereby converted into a correctness failure with no error path. And because the winner is decided by mount order, the same project renders differently between sessions.

---

### V6 — **High** · The renderer owns scheduling

**Pattern**: *the renderer owns scheduling.*

`ScenePreviewCanvas` — a React component whose stated job is "render one `<canvas>`" — owns: the rAF loop, the settle window, the not-ready gate, the coherence gate, the full-res rendezvous, resource pruning, the capture/thumbnail API, GL-context recovery, and the export-suspend check. It is 1613 lines and is the de-facto kernel.

**Why dangerous**: every one of those responsibilities is now **scoped to a canvas**. A second viewer (tool page, Flarex page, fixture) gets a second scheduler, a second barrier, a second set of caches — competing for one global decoder pool and one GL-context budget that neither can see. The scoping comments in the file ([:247-253](apps/web/src/components/ScenePreviewCanvas.tsx#L247)) argue this is correct for *coherence*, and they are right; it is wrong for *scheduling and resources*, which are inherently global.

---

### V7 — **High** · The compositor owns graph state

**Pattern**: *the compositor owns graph state.*

`SceneCompositor` holds `ContentArtifactCache` — entries keyed on a **node content hash** ([scene-compositor.ts:2647](packages/shared/src/color/scene-compositor.ts#L2647)), with a retention policy that reasons about probation/protected tiers and cross-frame reuse ([:787-824](packages/shared/src/color/scene-compositor.ts#L787)). That is an evaluation cache living inside a rasterizer.

ADR-008 rule 4 is explicit that the compositor "knows *no graph*". It currently knows: node content hashes, dependency version payloads, evaluation keys, and a `CONTENT_CACHE_CONTRACT_VERSION`.

**Why dangerous**: the cache's *validity* is determined by information the compositor cannot see (evaluation-context time — C9/§0.4), while its *storage* is determined by information the evaluator cannot see (VRAM budget). Neither side can reason about correctness alone. §0.4 shows this has already produced a live correctness hazard in the worker.

---

### V8 — **High** · UI decisions change evaluation

**Pattern**: *UI decisions change evaluation.*

| UI decision | Evaluation effect |
|---|---|
| view dot (`previewNodeId`) | **persisted**, re-roots preview **and export** ([compile-flarex.ts:1470](packages/shared/src/flarex/compile-flarex.ts#L1470)) |
| opening the Flarex page | `soloLayerComposition` withholds every other layer ([virtual-layers.ts:49](packages/shared/src/flarex/virtual-layers.ts#L49)) |
| opening the Flarex page | `flarexProxyPlayback` off → different substitution behaviour ([VideoPreview.tsx:573](apps/web/src/components/VideoPreview.tsx#L573)) |
| generating node thumbnails | re-roots a compile, bumps shared matte versions, resizes shared accumulators ([ScenePreviewCanvas.tsx:1483](apps/web/src/components/ScenePreviewCanvas.tsx#L1483)) |
| selecting a mask node | swaps the mask editor's target layer ([VideoPreview.tsx:1044](apps/web/src/components/VideoPreview.tsx#L1044)) |

The view dot is the sharpest case: a *viewing* affordance is persisted project state that changes **delivered output**. The code acknowledges this ("intentionally — it's persisted state the user toggles off before delivery", [types.ts:151](packages/shared/src/flarex/types.ts#L151)). Fusion's view dot does not survive into a render; this one does.

**Why dangerous**: it makes "what am I looking at" and "what will be delivered" the same variable. A user who forgets to clear a view dot ships a render of an intermediate node, and no gate in the export path questions it.

---

### V9 — **High** · Three duplicated readiness notions

**Pattern**: *duplicated responsibility.*

| Channel | Question answered | Blind to |
|---|---|---|
| `onLayerNotReady` → `notReadyIds` | "does this layer have a texture?" | staleness; misclassifies loaders (C1) |
| `snapshot().awaitingFrame` | "does this video have a frame for this time?" | non-single-ctx path; proxies |
| `snapshot().stalenessSeconds` → `staleIds` | "is this the right frame?" | proxies; null for time-invariant sources |

Three overlapping predicates, three separate clocks (`notReadySince`, `staleSince`, `holdStart`), three escape hatches, and one source class (proxies) invisible to all three.

**Why dangerous**: overlapping predicates with independent budgets do not compose. The prior audit's C1 is precisely a case where a source falls between two of them. Adding a fourth channel for proxies would make it worse; the answer is one channel.

---

### V10 — **High** · The graph owns rendering state

**Pattern**: *the graph owns rendering state.*

`FlarexComp.previewNodeId` (V8) and `FlarexNode.ui` are persisted. `ui` is correctly fenced ("editor-only — never read by the lowering compiler", [types.ts:110](packages/shared/src/flarex/types.ts#L110)) and the fence holds. `previewNodeId` is **not** fenced and is read by the compiler.

There is also a subtler instance: `comp.version` is a **cache key** stored in the document model ([source-draw-cache.ts:43](packages/shared/src/flarex/source-draw-cache.ts#L43), [useFlarexCompProxies.ts:186](apps/web/src/editor/flarex/useFlarexCompProxies.ts#L186)). A runtime invalidation concern is persisted, transmitted to the worker, and incremented by undo.

---

### V11 — **Medium** · Four unreconciled clocks

Committed / live / cold / per-loader-clamped (§0.1, §0.2, matrix #3). Only the proxy actually crosses them wrongly today, but nothing structurally prevents a fifth consumer from picking the wrong one — the previous audit had to read four files to establish which clock each consumer used.

---

### V12 — **Medium** · Four unreconciled resource budgets

WC sessions (4), GL contexts (governor target + hard cap), content-cache bytes (~12 artifacts at 1080p), texture TTL (120 presented frames). No component can answer "how much GPU memory is this project using" or "should I evict a texture or refuse a decoder". C8's 1 GB texture accumulation is invisible to all four.

---

### V13 — **Medium** · Scratch render paths share live caches

Thumbnails and capture share `matteCacheRef`, `nestMatteCachesRef`, `flarexSourceDrawCacheRef`, `gradeRenderersRef`, `groupTargets` and the accumulators with the live frame, separated only by an `isPlaying` gate and a `"thumb:"`/`"capture:"` key prefix on *one* of the six pools ([ScenePreviewCanvas.tsx:1405](apps/web/src/components/ScenePreviewCanvas.tsx#L1405)).

---

### V14 — **Medium** · Graph well-formedness is enforced in a drag handler

§0.3. Unowned on load, paste, AI generation and import.

---

### V15 — **Low** · Module-level mutable caches inside a "pure" compiler

`flarexEffectListCache` ([compile-flarex.ts:441](packages/shared/src/flarex/compile-flarex.ts#L441)) is module-global, cleared wholesale on overflow, and shared across every comp, viewer and renderer in the process. Correct today (keyed on serialized content) but it is process-global mutable state inside the layer whose defining property is purity.

---

# Part 3 — The Ideal Runtime

Derived from first principles; compared to the implementation afterward.

```
   ┌───────────────┐
   │   TRANSPORT   │  authoritative time; audio master
   └───────┬───────┘
           │ proposedTime
   ┌───────▼─────────────┐
   │  FRAME SCHEDULER    │  owns the frame lifecycle; the ONLY thing that says "begin"/"done"
   └───────┬─────────────┘
           │ FrameRequest{ id, targetTime, quality, purpose }
   ┌───────▼─────────────┐
   │ EVALUATION SCHEDULER│  what must be computed for this frame, in what order
   └───────┬─────────────┘
           │ EvaluationPlan{ dirty set, required sources, materialization set }
   ┌───────▼─────────────┐
   │  SOURCE ADMISSION   │  which sources may hold a decode session, ranked by contribution
   └───────┬─────────────┘
           │ AdmissionDecision{ granted[], denied[] (explicit, reported) }
   ┌───────▼─────────────┐
   │ DECODE COORDINATOR  │  owns decoder sessions; converts requests into frames
   └───────┬─────────────┘
           │ SourceFrame{ sourceId, servedTime, handle, generation }
   ┌───────▼─────────────┐
   │ READINESS BARRIER   │  is the input set complete AND coherent for targetTime?
   └───────┬─────────────┘
           │ ResolvedInputSet{ effectiveTime, frames[], degraded[] }
   ┌───────▼─────────────┐
   │  GRAPH EVALUATION   │  pure: (graph, evalContext, inputSet) → node results
   └───────┬─────────────┘
           │ NodeResults (values + materialization requests)
   ┌───────▼─────────────┐
   │  MATERIALIZATION    │  which results become artifacts; cache lookup/store
   └───────┬─────────────┘
           │ ArtifactHandles
   ┌───────▼─────────────┐
   │ SCENEDRAW CONSTRUCT │  pure lowering → the shared renderer contract  ◀── PRESERVE
   └───────┬─────────────┘
           │ SceneFrameSpec
   ┌───────▼─────────────┐
   │   GPU SUBMISSION    │  rasterize; owns contexts, RTTs, textures
   └───────┬─────────────┘
           │ CompletedFrame{ frameId, effectiveTime, surface }
   ┌───────▼─────────────┐
   │ PRESENTATION BARRIER│  may this completed frame be shown?
   └───────┬─────────────┘
   ┌───────▼─────────────┐
   │  CANVAS PRESENT     │
   └─────────────────────┘

  ┌──────────────────────────────────────────────────────────────────┐
  │  CROSS-CUTTING (not pipeline stages — services with own lifetime) │
  │   RESOURCE MANAGER · PERFORMANCE GOVERNOR · DIAGNOSTICS           │
  └──────────────────────────────────────────────────────────────────┘
```

### Stage contracts

---

**1. Transport**
- **Inputs**: user gestures, audio clock.
- **Outputs**: a single authoritative `proposedTime` + play state.
- **Owner**: Transport service (process-global, one per document).
- **Guarantees**: exactly one authoritative time exists; every other time value in the system is *derived* from it and labelled with its derivation.
- **Failure modes**: audio-clock drift; a hidden tab suspending the clock source.
- **vs today**: **SPLIT** — four clocks, no derivation labelling (V11).

---

**2. Frame Scheduler**
- **Inputs**: `proposedTime`, invalidation events, quality tier, viewer visibility.
- **Outputs**: `FrameRequest { frameId, targetTime, quality, purpose: live|thumbnail|capture|export }`; and, at the end, a `FrameComplete` or `FrameAbandoned` event.
- **Owner**: Frame Scheduler (one per document; viewers are *subscribers*, not owners).
- **Guarantees**: at most one live frame in flight; every frame terminates in exactly one of complete/abandoned; frames are totally ordered; `purpose` determines resource scope so a thumbnail can never touch live pools.
- **Failure modes**: starvation under continuous invalidation (mitigated by coalescing to the newest request).
- **vs today**: **MISSING** (V3). Replaced by a rAF loop + a 600ms timer inside a canvas component (V6).

---

**3. Evaluation Scheduler**
- **Inputs**: `FrameRequest`, graph version, dirty set, previous frame's evaluation records.
- **Outputs**: `EvaluationPlan { nodesToEvaluate, requiredSources, materializationSet, expectedCost }`.
- **Owner**: Evaluator.
- **Guarantees**: the plan is a **superset** of what is dirty and a **subset** of what is reachable from the active root; it is computed without touching GPU or media.
- **Failure modes**: an over-conservative dirty set (correct, slow); an under-conservative one (**wrong pixels** — the only failure here that must be impossible by construction).
- **vs today**: **MISSING**. There is no plan; the whole graph is re-lowered every frame.

---

**4. Source Admission**
- **Inputs**: `requiredSources` (ranked by visible contribution), the decode budget, current session assignments.
- **Outputs**: `AdmissionDecision { granted[], denied[] }` — **denial is a first-class, reported outcome**.
- **Owner**: Source Admission service, driven by the Evaluator's ranking, bounded by the Resource Manager's budget.
- **Guarantees**: the granted set fits the budget; ranking is deterministic given the same plan; a denied source produces a *declared absence*, never a substitution.
- **Failure modes**: thrash if the ranking flips frame to frame → requires hysteresis and a minimum residency.
- **vs today**: **WRONG OWNER** (V5). A first-come pool allocator with no graph knowledge; denial is invisible and becomes a host-clip substitution.

---

**5. Decode Coordinator**
- **Inputs**: granted source set, `targetTime` per source (after retime), session budget.
- **Outputs**: `SourceFrame { sourceId, servedTime, handle, generation }` — **every frame carries the time it represents**.
- **Owner**: Decode Coordinator (owns sessions, sharing, eviction, priority).
- **Guarantees**: session lifetime is independent of any UI or rendering decision; a session is released only on eviction by budget or on source removal from the plan; sharing is transparent.
- **Failure modes**: seek latency on sparse-GOP originals; a wedged decoder (needs a liveness watchdog + declared write-off).
- **vs today**: **SPLIT + WRONG** (V1.1, V2). Lifetime is a React mount, and a rendering decision (proxy serving) unmounts it.

---

**6. Readiness Barrier**
- **Inputs**: `targetTime`, the admitted source set, each source's latest `servedTime`, each source's declared degraded state.
- **Outputs**: `ResolvedInputSet { effectiveTime, frames[], degraded[] }` or `NotReady { waitingOn[] }`.
- **Owner**: Readiness Barrier (**one** service — replaces all three of today's channels).
- **Guarantees**: **every frame in the set represents `effectiveTime`**; `effectiveTime ≤ targetTime`; a source that cannot serve `effectiveTime` is either waited for or *declared degraded and recorded*, never silently held.
- **Failure modes**: a permanently starved source (bounded by a declared write-off that appears in `degraded[]`).
- **Key design point**: this returns an `effectiveTime`, not a boolean. That single change converts "hold or don't" into "render the latest coherent moment", which is what makes coherence achievable **during playback** as well as paused.
- **vs today**: **SPLIT ×3, INCOMPLETE, paused-only** (V9, C1, C2, C5).

---

**7. Graph Evaluation**
- **Inputs**: graph, `EvaluationContext { effectiveTime, resolution, workingSpace, quality }`, `ResolvedInputSet`.
- **Outputs**: node results (image / matte / data values) keyed by `(nodeId, evaluationContext)`.
- **Owner**: Evaluator.
- **Guarantees**: **pure and deterministic** given its inputs; topological order; no GPU, no media, no clock access; identical results in preview, local export and worker.
- **Failure modes**: cycles (degrade to a declared error result, not to null); missing upstream (same).
- **vs today**: **the traversal is OK and is the system's strongest asset**; the *context* is impure (three sites read the wrong clock — C6) and degradation is unreported (V4).

---

**8. Materialization**
- **Inputs**: node results + their content identities, cost estimates, artifact-cache state, GPU budget.
- **Outputs**: artifact handles; cache lookup/store decisions.
- **Owner**: Evaluator decides *what* and *when*; Resource Manager owns *storage and eviction*.
- **Guarantees**: identity fully determines pixels — `(ContractVersion, ContextVersion, NodeContentHash)` where **ContextVersion includes evaluation time**; a cache hit is bit-identical to a miss; materializing never changes output, only cost.
- **Failure modes**: an incomplete identity → stale pixels (**the unforgivable failure**, ADR-009 §6 — live today per §0.4).
- **vs today**: decision and mechanism both in the compiler (V4); mechanism violates ADR-008 rule 2 (C7); identity omits evaluation time (C9); storage in the compositor (V7).

---

**9. SceneDraw Construction**
- **Inputs**: node results / artifact handles + the host clip's presentation.
- **Outputs**: `SceneFrameSpec`.
- **Owner**: the lowering layer (`build-scene-draws` + `compile-flarex`), unchanged.
- **Guarantees**: **the same draws reach preview, local export and Remotion** — ADR-007 parity-by-construction.
- **Failure modes**: none intrinsic; it is pure.
- **vs today**: **OK. Preserve verbatim.** This is the single best-engineered part of the system and every redesign proposal here is arranged around not disturbing it.

---

**10. GPU Submission**
- **Inputs**: `SceneFrameSpec` with **handles**, not raw pointers.
- **Outputs**: `CompletedFrame { frameId, effectiveTime, surface }`.
- **Owner**: Compositor; textures/RTTs owned by the Resource Manager.
- **Guarantees**: the compositor knows **no graph**; resolving a stale handle yields a declared empty texture *and a diagnostic*, never a silent wrong sample; context loss is recoverable without correctness loss.
- **Failure modes**: context loss; texture-size limits; OOM.
- **vs today**: raw `WebGLTexture` pointers in draws with no liveness check on the `SceneTextureSource` path (prior audit §6); the compositor holds graph state (V7).

---

**11. Presentation Barrier**
- **Inputs**: `CompletedFrame`, the currently presented frame, viewer policy.
- **Outputs**: present / withhold.
- **Owner**: Presentation Barrier — **per viewer** (a present is atomic per canvas; this scoping in today's code is correct and should be kept).
- **Guarantees**: **never presents a frame whose `effectiveTime` is older than the currently presented one** (monotonicity — an invariant the current runtime does not have); never presents a frame containing sources at differing times, because stage 6 made that impossible upstream.
- **Failure modes**: none — by this point the frame is already coherent. The barrier degenerates to an ordering check, which is the sign the architecture is right.
- **vs today**: the barrier is doing stage 6's job at stage 11, on incomplete information, with escape hatches.

---

**12. Canvas Present** — trivial once 1–11 hold.

---

### Cross-cutting services

**Resource Manager** — one per document. Owns every GPU texture, RTT, decoder session slot and CPU raster cache, under **one** budget with **one** wall-clock aging policy. Answers "how much are we using" and "what should be evicted". Nothing else may allocate or free a GPU resource.

**Performance Governor** — owns render scale, quality tier, proxy eligibility, materialization budget. Reads Resource Manager and frame-timing telemetry; writes *policy* only. **Never touches resource lifetime** (the V1 firewall).

**Diagnostics** — the single sink for degraded states, denials, write-offs and cache statistics. Today this is eight `window.__rf*` globals keyed on four different identities; the audit needed to join them by hand.

---

# Part 4 — Runtime State Machines

Each machine names its **owner** and the transitions that must be *observable*. Where today's runtime has no state (only an implicit condition), that is marked.

### 4.1 Media Source — owner: Decode Coordinator

```
 UNLOADED ──declared by plan──▶ REQUESTED ──admitted──▶ ACQUIRING ──session──▶ WARMING
     ▲                              │                       │                     │
     │                          denied│                  refused│              first frame
     │                              ▼                       ▼                     ▼
     │                          DENIED ◀──budget──── (reported, not substituted)  READY
     │                              │                                              │
     │                              └──────────re-plan──────────────────────┐  serving
     │                                                                      │      ▼
 RELEASED ◀──evicted / removed from plan──── PARKED ◀──idle──── ACTIVE ◀────┴── (serves servedTime)
     ▲                                          │                 │
     │                                          │            lag > budget
     │                                          │                 ▼
     └────────────unrecoverable─────── FAILED ◀─┴──watchdog── DEGRADED ──recovers──▶ ACTIVE
```
**Today**: DENIED, DEGRADED and FAILED **do not exist as states**. Denial is an absent virtual layer; degradation is a `null` return that becomes a host clip; failure is a `failedKeysRef` Set in a React hook. PARKED exists in the pool as idle-session reuse. RELEASED is a component unmount.

---

### 4.2 Node — owner: Evaluator

```
 DECLARED ──in plan──▶ SCHEDULED ──inputs ready──▶ EVALUATING ──▶ EVALUATED
    ▲                      │                            │             │
    │                  blocked                       error       materialize?
    │                      ▼                            ▼             ▼
    │                   WAITING ──inputs land──▶ …    ERRORED      MATERIALIZED
    │                      │                            │             │
    │                   timeout                         │        cache store
    │                      ▼                            │             ▼
    └──graph edit── DIRTY ◀──dependency changed──────────┴──────── CACHED
                       │                                              │
                       └──────────── invalidate ──────────────────────┘
```
**Today**: **no state at all.** Every node is re-evaluated from scratch each frame; DIRTY, CACHED, WAITING and ERRORED are inexpressible. `aiMatte` returning unconditional `null` ([compile-flarex.ts:1414](packages/shared/src/flarex/compile-flarex.ts#L1414)) is an ERRORED/UNIMPLEMENTED state encoded as "produces nothing".

---

### 4.3 Texture — owner: Resource Manager

```
 UNALLOCATED ──▶ ALLOCATED ──upload──▶ RESIDENT ──referenced──▶ IN_USE
                     ▲                    │  ▲                    │
                     │                    │  └────released────────┘
                  resize              age out
                     │                    ▼
                     └──────────────── EVICTABLE ──evict──▶ FREED ──▶ (handle generation++)
                                                               │
                                            context lost ──────┴──▶ INVALIDATED (all handles stale)
```
**Today**: RESIDENT/IN_USE are not distinguished — there is no reference counting. Eviction is a TTL on the **presented-frame** counter (V1.3). INVALIDATED is handled by defensive checks at the consumption site for canvases ([scene-compositor.ts:2059](packages/shared/src/color/scene-compositor.ts#L2059)) and **not at all** for `SceneTextureSource`.

---

### 4.4 Evaluation (one frame's) — owner: Evaluation Scheduler

```
 IDLE ──FrameRequest──▶ PLANNING ──▶ AWAITING_INPUTS ──▶ EVALUATING ──▶ LOWERING ──▶ SUBMITTED
   ▲                        │              │                  │            │            │
   │                        │          timeout            error            │        completed
   │                        │              ▼                  ▼            │            ▼
   │                        │        DEGRADED_PROCEED ────────┴────────────┘        COMPLETE
   │                        │              │                                            │
   └────────── ABANDONED ◀──┴──superseded──┴────────────────────────────────────────────┘
```
**Today**: PLANNING and AWAITING_INPUTS do not exist; the pipeline goes straight to LOWERING and discovers missing inputs *during* it. ABANDONED does not exist — a superseded frame simply isn't started, because there is no frame identity.

---

### 4.5 Render Target — owner: Resource Manager

```
 POOLED ──acquire(depth,size)──▶ BOUND ──render──▶ POPULATED ──read by shell──▶ RELEASABLE ──▶ POOLED
                                                        │
                                                   persist (cache store)
                                                        ▼
                                                    ARTIFACT ──eviction──▶ POOLED
```
**Today**: correctly implemented for `groupTargets` — the `freeGroupDepth` discipline ([scene-compositor.ts:2716](packages/shared/src/color/scene-compositor.ts#L2716), [:2796](packages/shared/src/color/scene-compositor.ts#L2796)) is a genuine, well-reasoned ownership handoff and is one of the better pieces of the codebase. The ARTIFACT branch (`blitFramebuffer` into a persistent entry, [:2773](packages/shared/src/color/scene-compositor.ts#L2773)) is also correct in mechanism.

---

### 4.6 SceneDraw — owner: lowering layer

```
 BUILDING ──▶ BUILT ──submitted──▶ CONSUMED ──▶ DISCARDED
```
Deliberately trivial and **must stay that way**. A SceneDraw is a value, not an object with a lifetime. The one change needed: it must reference **handles**, so `CONSUMED` cannot dereference a freed resource. Today it holds raw pointers.

---

### 4.7 Graph — owner: Document model

```
 LOADED ──heal──▶ VALID ──edit──▶ MUTATING ──stamp(version++)──▶ VALID
   │                 │                                              │
   │              invalid                                      structurally
   └──▶ REPAIRING ◀──┴───────────────────────────────────────────── broken
```
**Today**: `VALID` is not actually established — the healer checks endpoint existence and socket type but not cardinality (§0.3), and three writers bypass it. There is no `REPAIRING` state and no way to report "this graph was repaired on load".

---

### 4.8 Playback — owner: Transport

```
 STOPPED ──▶ STARTING ──▶ PLAYING ──▶ PAUSING ──▶ PAUSED ──▶ SCRUBBING ──▶ PAUSED
                             │                                    │
                        under-run                             seek settle
                             ▼                                    ▼
                        THROTTLED (quality drop)             CONVERGING ──▶ PAUSED
```
**Today**: `isPlaying` is a boolean, and **six subsystems change behaviour on it** (prior audit §10). STARTING is the play-start black-flicker window that five separate mechanisms exist to paper over. CONVERGING exists implicitly as a coherence hold episode. Making these real states would collapse several of those mechanisms into one.

---

### 4.9 Proxy — owner: Performance Governor (eligibility) + Decode Coordinator (decode)

```
 ABSENT ──render──▶ STORED ──key match──▶ ELIGIBLE ──decoder──▶ WARMING ──first frame──▶ SERVING
    ▲                  │                     │                                            │
    │              key stale                 │                                    out of span /
    │                  ▼                     ▼                                    key change
    └──────────── INVALID              UNAVAILABLE (pool full / decode failed)          │
                                                                                        ▼
                                      SERVING ◀──re-enter──── SUSPENDED ──loaders warm──┘
```
**Today**: the `SUSPENDED` state does not exist — serving-off is immediate and simultaneous with the loaders being asked back (C3). `UNAVAILABLE` is `failedKeysRef`, a Set with no expiry other than a key change.

---

### 4.10 Virtual Layer — owner: Evaluator (source declaration)

```
 DECLARED (from graph) ──▶ ADMITTED ──▶ BACKED (session) ──▶ SERVING
        │                     │                                 │
   asset missing          denied                          source exhausted
        ▼                     ▼                                 ▼
   UNRESOLVED            DENIED (reported)                    ENDED
```
**Today**: `UNRESOLVED` is a silent `continue` in `collectFlarexVirtualLayers` ([virtual-layers.ts:302](packages/shared/src/flarex/virtual-layers.ts#L302)) that becomes a host-clip substitution. `DENIED` does not exist. `ENDED` exists and is correct.

---

# Part 5 — Scheduler Audit

**Does Flarex need each of these?**

| Scheduler | Needed? | Owns | Why |
|---|---|---|---|
| **Frame Scheduler** | **YES — build first** | frame identity, lifecycle, coalescing, purpose scoping, the complete/abandon signal | Without frame identity there is nothing to attach ordering, completion or cancellation to. Every one of the five timeouts in the current runtime is a substitute for this. It is also the cheapest to build and unblocks the rest. |
| **Evaluation Scheduler** | **YES** | the dirty set, the evaluation plan, materialization budget, node-result cache lifetime | This is the missing ADR-008 layer. It is what makes incremental evaluation, async nodes, node previews and a correct cache possible at all. Everything ADR-008 lists as deferred is deferred *on this*. |
| **Decode Scheduler** (admission + coordination) | **YES** | session assignment, ranking, hysteresis, retime-aware requests, write-off policy | The decode budget (4) is smaller than the graphs the product invites. Without a scheduler, shortage becomes silent wrongness (V5). This is the direct fix for the largest visible symptom class. |
| **GPU Scheduler** | **NO — not as a separate scheduler** | — | The compositor is single-threaded, synchronous, and driver-ordered. A GPU scheduler adds a queue with nothing to reorder. What is actually needed is *resource ownership* (below), not scheduling. Revisit only if WebGPU + compute nodes land. |
| **Resource Scheduler / Manager** | **YES** | all GPU textures, RTTs, decoder slots, CPU raster caches; one budget; wall-clock aging | Four independent budgets today, none aware of the others; C8's 1 GB accumulation is invisible to all four. This is also the V1 firewall: once the Resource Manager owns lifetime, presentation *cannot* control it. |
| **Presentation Scheduler** | **YES, but small** | per-viewer present cadence, vsync alignment, monotonicity | Must be separate from the Frame Scheduler: one document can feed several viewers. Today they are the same rAF loop, which is why a second viewer duplicates the entire kernel (V6). |

**Four schedulers, not six.** The GPU case is worth stating explicitly because it is the one a rewrite would be tempted to build and should not.

---

# Part 6 — Architectural Invariants

Numbered for the compliance table in Part 7. **MUST** = a violation is a correctness bug.

### Time and coherence
- **I-1** A presented frame MUST represent exactly one effective time across every source contributing to it.
- **I-2** Presented effective time MUST be monotonic under forward playback.
- **I-3** Every frame delivered by a decoder MUST carry the time it represents.
- **I-4** Exactly one authoritative clock MUST exist; every other time value is a labelled derivation of it.
- **I-5** Evaluation context time MUST be threaded to every time-dependent read — parameters, mattes, tracks, generators, and cache identity alike.
- **I-6** Coherence MUST NOT depend on transport state.

### Ownership
- **I-7** Every GPU resource MUST have exactly one owner.
- **I-8** Every visible pixel MUST have exactly one ownership path from source to screen.
- **I-9** A node MUST NOT own a GPU resource.
- **I-10** A renderer MUST NOT mutate graph state.
- **I-11** The compositor MUST NOT know the graph.
- **I-12** The evaluator MUST NOT know node types.
- **I-13** The graph MUST NOT carry rendering or runtime state.
- **I-14** The compiler MUST NOT own runtime policy.
- **I-15** The view layer MUST NOT own runtime state.

### Determinism
- **I-16** Evaluation MUST be deterministic: identical (graph, context, inputs) ⇒ identical output.
- **I-17** All three renderers MUST consume the same lowered draws (ADR-007).
- **I-18** Graph well-formedness MUST be established by the model, on every entry path.
- **I-19** A cache MUST NOT change correctness — a hit is bit-identical to a miss, on every renderer.
- **I-20** Cache identity MUST fully determine the produced pixels.

### Policy separation
- **I-21** Presentation policy MUST NOT change resource lifetime.
- **I-22** Performance policy MUST NOT change output.
- **I-23** UI state MUST NOT change delivered output.
- **I-24** Resource scarcity MUST NOT be resolved by substituting different content.

### Observability and failure
- **I-25** Every degradation MUST be a declared, observable state — never a silent substitution.
- **I-26** Every frame MUST terminate in exactly one of complete/abandoned.
- **I-27** Every hold MUST be bounded and its expiry MUST be reported.
- **I-28** A scratch render (thumbnail/capture) MUST NOT mutate live-frame state.
- **I-29** Resource reclamation MUST NOT depend on frames being presented.
- **I-30** An unrepresentable state (missing asset, denied session, unimplemented node) MUST be distinguishable from a valid empty result.

---

# Part 7 — Compliance Against the Current Runtime

| # | Invariant | Status | Why |
|---|---|---|---|
| I-1 | one effective time per frame | **VIOLATED** | proxies bypass all gates (C2); loaders unheld while paused (C1); no coherence while playing (C5) |
| I-2 | monotonic presented time | **VIOLATED** | no frame identity, no presented-time record; a late settle/capture frame can regress the surface |
| I-3 | frames carry their time | **PARTIAL** | `servedSourceTime` exists in `snapshot()`, but is **dropped** at `gradeMediaInContext` — `SceneTextureSource` carries no time; proxies never had one |
| I-4 | one authoritative clock | **VIOLATED** | four clocks (V11); only the proxy crosses them wrongly today |
| I-5 | context time threaded everywhere | **VIOLATED** | three sites read `ctx.timeSeconds` instead of `activeTimeSeconds` (C6); content hashes computed once at the un-retimed time (C9) |
| I-6 | coherence independent of transport | **VIOLATED** | `shouldHoldForCoherence` returns false whenever playing, by design ([temporal-coherence.ts:254](apps/web/src/playback/temporal-coherence.ts#L254)) |
| I-7 | one owner per GPU resource | **VIOLATED** | three texture owners; RTT pool shared across live/thumbnail/capture (V13) |
| I-8 | one ownership path per pixel | **VIOLATED** | media pixels reach the screen via own-canvas, single-ctx RTT, proxy `VideoFrame`, or raster — four paths with different versioning semantics |
| I-9 | nodes own no GPU resources | **SATISFIED** | trivially — nodes have no runtime existence. Worth preserving deliberately once they do. |
| I-10 | renderer doesn't mutate graph | **SATISFIED** | verified: no write path from compositor or draw builder into `flarexComps` |
| I-11 | compositor doesn't know the graph | **VIOLATED** | `ContentArtifactCache` keyed on node content hashes, with evaluation-key bookkeeping (V7) |
| I-12 | evaluator doesn't know node types | **VIOLATED in letter, honoured in spirit** | `lowerNode` is a 40-arm type switch — but that is the *compiler*, which is allowed to. The parts ADR-010 calls the evaluator (`shouldMaterialize`, `estimateDrawCost`, `content-hash`) are genuinely node-blind. **This is a real success.** |
| I-13 | graph carries no runtime state | **PARTIAL** | `ui` correctly fenced; `previewNodeId` read by the compiler; `comp.version` is a persisted cache key (V10) |
| I-14 | compiler owns no policy | **VIOLATED** | materialization, degradation, fallback, cache identity all in the compiler (V4) |
| I-15 | view owns no runtime state | **VIOLATED** | decoder lifetime, cache lifetime, source set, proxy state, invalidation — all React (V2) |
| I-16 | deterministic evaluation | **SATISFIED for the lowering** | given identical inputs, output is structurally identical. Non-determinism enters only via inputs. **The system's strongest property.** |
| I-17 | all renderers share lowered draws | **SATISFIED** | preview, `scene-frame-compositor`, `SceneStage` all re-enter `buildSceneDraws` |
| I-18 | model establishes well-formedness | **VIOLATED** | cardinality enforced in a drag handler; healer does not check it (§0.3) |
| I-19 | caches don't change correctness | **VIOLATED** | the artifact cache is live in the worker and dead in the browser (§0.4), and its key omits evaluation time (C9) — a hit and a miss can differ, *and* differ per renderer |
| I-20 | identity determines pixels | **PARTIAL** | the two-axis design (semantic deps + source versions) is correct in shape; incomplete because evaluation time is absent and `sourceVersion` is undefined on the shipped path |
| I-21 | presentation ≠ resource lifetime | **VIOLATED** | three instances (V1) |
| I-22 | performance policy ≠ output | **VIOLATED** | proxy substitution changes which pixels are produced and unmounts decoders (C2, C3) |
| I-23 | UI state ≠ delivered output | **VIOLATED** | the persisted view dot re-roots the export (V8) |
| I-24 | scarcity ≠ substitution | **VIOLATED** | pool exhaustion → host-clip fallback (C4 + V4) — arguably the single most damaging violation in the list |
| I-25 | degradations are declared | **VIOLATED** | 8 silent null sites + 2 silent substitutions in the compiler |
| I-26 | frames terminate | **VIOLATED** | no frame identity exists |
| I-27 | holds bounded and reported | **SATISFIED** | genuinely well done — two clocks, two hatches, attributed separately, with an honest instrument ([temporal-coherence.ts:225-241](apps/web/src/playback/temporal-coherence.ts#L225)) |
| I-28 | scratch ≠ live state | **VIOLATED** | shared matte/source-draw/grade pools and accumulators; version churn (V13) |
| I-29 | reclamation ≠ presentation | **VIOLATED** | all prunes gated behind the present (V1.2, V1.3) |
| I-30 | unrepresentable ≠ empty | **VIOLATED** | `"ended"`, `"pending"`, denied, unresolved and `aiMatte`-unimplemented all collapse to "produces nothing" or "host clip" |

**Score: 6 satisfied, 4 partial, 20 violated.**

The six satisfied invariants are worth naming because they are the foundation a rewrite stands on: **I-9, I-10, I-12, I-16, I-17, I-27**. Four of them are properties of the pure `packages/shared` layer, and the fifth (I-27) is the one place the app layer got a hard problem right.

---

# Part 8 — Redesign Blueprint

## 8.1 Subsystems and ownership boundaries

```
┌─────────────────────────────────────────────────────────────────────────┐
│  DOCUMENT MODEL          owns: graph, comps, timeline, well-formedness   │
│                          exports: immutable snapshots + version tokens   │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ GraphSnapshot (immutable, validated)
┌──────────────▼──────────────────────────────────────────────────────────┐
│  RUNTIME KERNEL  (framework-free; no React, no DOM, no GL)              │
│  ┌────────────────┐ ┌──────────────────┐ ┌───────────────────────────┐  │
│  │ Frame Scheduler│ │ Evaluator        │ │ Decode Coordinator        │  │
│  │  frame identity│ │  plan, dirty set,│ │  sessions, admission,     │  │
│  │  lifecycle     │ │  node records,   │ │  retime-aware requests,   │  │
│  │  coalescing    │ │  materialization │ │  write-off policy         │  │
│  └────────────────┘ └──────────────────┘ └───────────────────────────┘  │
│  ┌────────────────┐ ┌──────────────────┐ ┌───────────────────────────┐  │
│  │Readiness Barrier│ │ Resource Manager │ │ Performance Governor      │  │
│  │  effectiveTime │ │  ONE budget,     │ │  policy only — may never  │  │
│  │  degraded set  │ │  wall-clock aging│ │  free or allocate         │  │
│  └────────────────┘ └──────────────────┘ └───────────────────────────┘  │
│                        ┌──────────────┐                                 │
│                        │ Diagnostics  │  single sink, one identity      │
│                        └──────────────┘                                 │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ SceneFrameSpec (handles, not pointers) + effectiveTime
┌──────────────▼──────────────────────────────────────────────────────────┐
│  LOWERING LAYER   (pure — PRESERVED VERBATIM)                            │
│     compile-flarex · build-scene-draws · virtual-layers · time-transform │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────────┐
│  RASTERIZER      SceneCompositor — knows no graph; resolves handles      │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ CompletedFrame
┌──────────────▼──────────────────────────────────────────────────────────┐
│  VIEW LAYER (React)   subscribes to kernel state · owns NO runtime state │
│     ScenePreviewCanvas → a surface. VideoPreview → a layout.             │
└─────────────────────────────────────────────────────────────────────────┘
```

**The one-sentence rule**: *React may read runtime state and render it; it may never own it.* Every current violation in Part 2 is a corollary.

## 8.2 The models

**Time model.** One authoritative transport time. Every derived time is a labelled value carrying its derivation (`committed`, `live`, `retimed(node)`, `clamped(media)`). The evaluation context carries `effectiveTime`, and every time-dependent read takes it as a parameter — **not** a mutable cursor. The three C6 sites become compile errors rather than silent misreads.

**Evaluation model.** Pull-based, memoized, incremental. Node records keyed `(nodeId, evaluationContext)` persist across frames. Dirty propagates forward from an edit through the wiring. The plan names what to evaluate; the evaluator evaluates only that. Materialization is decided by the evaluator (fanout × cost × budget) and executed by **tagging** the existing group per ADR-008 rule 2.

**Media model.** Sources are declared by the graph, ranked by the evaluator, admitted by the coordinator, and always carry `servedTime`. **There is no fallback content, ever.** A source that cannot be served yields a declared absence; the frame either waits or renders with a recorded degradation. The host-clip substitution is deleted.

**Presentation model.** The barrier answers with `effectiveTime`, not a boolean. Playback presents the latest coherent moment at a declared, bounded lag behind wall clock; pause presents the exact requested time once converged. **Both transport states run one mechanism** — this is what retires the six `isPlaying` behavioural switches.

**Cache model.** Two caches, clearly split:
- *Evaluation cache* (evaluator-owned): node results keyed `(ContractVersion, ContextVersion including effectiveTime, NodeContentHash)`.
- *Artifact cache* (resource-manager-owned): GPU storage for materialized results, keyed by the evaluator's identity, evicted by the one global budget.

The evaluator owns *validity*; the resource manager owns *residency*. Neither can violate the other's invariant.

**Synchronization model.** Message-passing between kernel services; one frame in flight; explicit completion. The kernel is framework-free and therefore testable headlessly — which is, separately, the thing that would have caught most of the findings in both audits.

## 8.3 How the systems communicate

- **Document → Kernel**: immutable `GraphSnapshot` + version token. One direction. No mutation path back.
- **Kernel → Lowering**: `(GraphSnapshot, EvaluationContext, ResolvedInputSet)` → `SceneFrameSpec`. Pure call, no state.
- **Kernel → Rasterizer**: `SceneFrameSpec` with resource **handles**. The rasterizer resolves handles through the Resource Manager and reports unresolvable ones.
- **Kernel → View**: an observable runtime-state store (frame state, degraded set, resource pressure, per-node evaluation state). The view subscribes; node badges, proxy indicators and the profiler all read the same store.
- **View → Kernel**: intents only (seek, play, select, re-root preview). Never resource operations.
- **Everything → Diagnostics**: one sink, one identity namespace, replacing eight `window.__rf*` globals keyed four ways.

## 8.4 What must be preserved

1. **ADR-007 parity-by-construction.** The lowering emits `SceneDraw` and nothing else; all three renderers consume it. Do not touch it. Every proposal above sits in front of, behind, or beside it.
2. **The wrap-collapser.** Folding consecutive ops into one shell is what makes grade chains usable on integrated GPUs.
3. **Node-blind evaluator machinery** (`shouldMaterialize`, `estimateDrawCost`, `computeFlarexContentHashes`). ADR-010 compliance here is real and hard-won.
4. **The two-axis cache identity design** (semantic dependencies + source content). The *shape* is right; only the terms are incomplete.
5. **The bounded-hold discipline** (two clocks, two hatches, attributed separately). This is the correct pattern for every barrier in the new design.
6. **The `freeGroupDepth` RTT handoff** in `renderGroupInto` — a correct, explicit ownership protocol worth using as the model for handle ownership.
7. **`virtual-layers.ts` / `time-transform.ts` as pure derivations.** The affine-composition retime model is sound; only its threading is broken.

---

# Part 9 — Migration Strategy

**Principle**: each phase must be independently shippable, independently verifiable, and must reduce ambiguity for the next. **No phase may touch the lowering layer.**

### Phase 0 — Make the invisible visible *(days)*
Do this before anything else. Add nothing but observability:
- Report every degradation (`"ended"`, `"pending"`, denied, unresolved, host-substituted) into one diagnostics sink with one identity.
- Instrument the host-clip fallback: count it, name the node, surface it in the UI.
- Record presented `effectiveTime` per frame and detect regressions (I-2).

**Why first**: three of the four Critical findings are currently unmeasurable. Every performance conclusion drawn so far — including the `MATERIALIZE_MIN_PASSES` calibration and the "cache doesn't pay for itself" reading — was taken through instruments that could not see the relevant path. The last audit's own §0.4 correction is an example of what this phase surfaces.

**Untouched**: everything else.

### Phase 1 — Fix ownership of graph validity *(days)*
Move cardinality enforcement into the healer and the registry write seam. Make every entry path (load, paste, AI intent, import, undo) go through it. Delete the drag-handler's dedupe once the model owns it.

**Why here**: it is small, self-contained, closes §0.3, and establishes the "model owns model invariants" precedent that Phase 3 depends on.

### Phase 2 — Frame Scheduler *(weeks)*
Introduce frame identity and lifecycle. Initially it wraps the existing rAF loop and changes nothing about *what* is computed — only that every frame has an id, a target time, a purpose, and terminates in complete/abandoned.

**Why here**: it is the attachment point for everything after it, and it can coexist with the current runtime unchanged. Its immediate payoff is retiring `SCENE_SETTLE_MS` guessing in favour of explicit completion.

**Coexists with**: the current settle timer, until Phase 5.

### Phase 3 — Runtime state out of React *(weeks)*
Move decoder lifetime, source declaration, proxy state and cache lifetime into a framework-free kernel module. React subscribes. **Do not change behaviour** in this phase — it is a relocation, verified by the Phase 0 instruments showing identical degradation counts.

**Why here**: V2 is the enabler for V1, V5, V6 and half of V13. Nothing downstream is tractable while a `useMemo` can tear down a decoder.

**Removed**: `activeFlarexVirtualLayers`' proxy filter (replaced by an admission decision with hysteresis — closes C3).

### Phase 4 — Decode Coordinator + Source Admission *(weeks)*
Give the evaluator the ranking and the coordinator the budget. **Delete the host-clip fallback** in the same change, once denial is a declared state (I-24, I-30).

**Why here**: this is the direct fix for the largest visible symptom class (C4, C5's root, D7). It requires Phase 3's kernel and Phase 0's instruments to be safe.

**Expected**: the `flarex-generators` pixel gate will regress when the fallback is removed, exactly as recorded at [compile-flarex.ts:1096](packages/shared/src/flarex/compile-flarex.ts#L1096). That regression is the *correct* outcome and is fixed by Phase 5, not by restoring the fallback. Plan for the two phases to land together behind one flag.

### Phase 5 — Unified Readiness Barrier + `effectiveTime` *(weeks)*
Collapse the three readiness channels into one. Propagate `servedTime` through `SceneTextureSource` and the comp proxy. Return `effectiveTime` instead of a boolean. Enable it for **both** transport states, retiring `tolerateLag` and the paused-only gate.

**Why here**: it needs Phase 4's declared degradation to distinguish "waiting" from "will never arrive". It closes C1, C2, C5 and I-1/I-3/I-6, and it is what makes Phase 4's fallback deletion safe across renderers.

**Removed**: `NOT_READY_HOLD_MS`, `NOT_READY_HOLD_MEDIA_MS`, `tolerateLag`, and the coherence hold's two clocks — replaced by one bounded convergence policy.

### Phase 6 — Resource Manager *(weeks)*
One budget, one wall-clock aging policy, handle-based texture references, reference counting. Fold in the four current budgets. Move the artifact cache's *storage* here while leaving its *key* with the evaluator.

**Why here**: closes V1 (the feedback loop), C8, C12, I-7/I-21/I-29. It needs Phase 3 (state out of React) and Phase 2 (frame identity, so "in use this frame" is well-defined).

**Untouched until now**: the compositor's internal RTT pooling, which is already correct.

### Phase 7 — Evaluation Scheduler *(months)*
The actual ADR-008 engine: node records, dirty propagation, incremental evaluation, correct cache identity **including evaluation time**, materialization by tagging.

**Why last among the builds**: it is the largest, and it is the only one whose benefit is primarily *performance* rather than *correctness*. Doing it earlier would mean building an incremental evaluator on top of a runtime that cannot tell it what changed.

**Fixes on landing**: C6 (context threading becomes structural), C7 (tag not wrap), C9 + §0.4 (identity includes time), C10 (versioned handles from Phase 6), C11 (real dirty propagation).

### Phase 8 — Retire the old paths *(last)*
Remove `ScenePreviewCanvas`'s kernel responsibilities, the settle timer, the capture handle's shared-pool access (V13, I-28), and the compiler's remaining policy. `ScenePreviewCanvas` becomes what its docstring already claims: a surface that renders one canvas.

### Roadmap summary

| Phase | Builds | Removes | Depends on | Risk |
|---|---|---|---|---|
| 0 | diagnostics sink | — | — | none |
| 1 | model-owned graph validity | drag-handler dedupe | — | very low |
| 2 | Frame Scheduler | — | 0 | low |
| 3 | kernel state module | proxy→loader coupling | 2 | medium |
| 4 | Decode Coordinator + Admission | **host-clip fallback** | 0, 3 | high — land with 5 |
| 5 | unified barrier, `effectiveTime` | 3 readiness channels, `tolerateLag`, 2 hold caps | 4 | high |
| 6 | Resource Manager | 4 budgets, presented-frame TTLs | 2, 3 | medium |
| 7 | Evaluation Scheduler | per-frame full re-lowering | 5, 6 | high, but well-specified by ADR-008/009/010 |
| 8 | — | the old kernel-in-a-canvas | all | low |

**Never touched**: `compile-flarex.ts`'s lowering body, `build-scene-draws.ts`'s draw construction, the wrap-collapser, `time-transform.ts`'s affine model, `SceneCompositor`'s rasterization. Phases 4, 5 and 7 change what is *handed to* the lowering layer and what *policy* sits around it — not how a node becomes a draw.

**Coexistence**: Phases 2–6 each ship behind a flag alongside the current path, with the Phase 0 instruments as the equivalence oracle. Phases 4+5 are the one pair that must land together, because deleting the fallback without `effectiveTime` trades a wrong picture for a missing one.

---

## Closing Assessment

The Flarex runtime has an unusually clean core surrounded by an unusually confused shell. The lowering compiler, the draw builder and the retime model are pure, deterministic, node-blind, and shared by three renderers — a standard most commercial compositors do not meet between their viewer and their render farm. **That core is not what is broken and must not be rewritten.**

What is broken is that the layer which should surround it — the evaluation engine ADR-008 specifies — was never built, and a React presentation component grew into its place. Every Critical finding in both audits is a consequence of that single substitution: a view framework cannot express frame identity, resource ownership, admission control, or completion, so each of those responsibilities was either dropped, duplicated, or encoded as a timeout.

The migration above is therefore not a rewrite. It is **extracting a kernel that already has a well-defined boundary** — the pure `packages/shared` layer proves the boundary is real — and giving it the responsibilities the presentation surface is currently holding on its behalf.
