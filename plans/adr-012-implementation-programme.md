# ADR-012 — Implementation Programme

- Status: **Accepted** (2026-08-01)
- Governs: migration from the current Flarex runtime to full ADR-012 conformance
- Companion documents: `project-tracker/adr/012-flarex-runtime-kernel.md` (the constitution) · `FLAREX_IMPLEMENTATION_GOVERNANCE.md` (the guardrail)
- Evidence base: `FLAREX_RUNTIME_AUDIT.md`, `FLAREX_OWNERSHIP_REVIEW.md`

28 slices, 8 phases. Every slice compiles independently, preserves functionality, is reviewable in isolation, and leaves the repository releasable.

---

## 0. Programme principles

1. **Every slice compiles and ships.** The repository is releasable at every commit.
2. **Flag-first.** Each behavioural slice lands behind a flag, defaulting off, with the old path intact. Flags are removed only in Phase 7.
3. **The oracle precedes the migration.** Phase 0 exists because three of four Critical findings are currently unmeasurable, and two prior performance conclusions were drawn through instruments blind to the relevant path.
4. **Atomic groups are named, not discovered.** Three groups must land together (S4.4–S4.6, S5.2, S6.1). Everything else is independently revertible.
5. **Preserved verbatim throughout**: the lowering body, `SceneDraw`, the wrap-collapser, the affine retime model, compositor rasterization. No slice modifies how a node becomes a draw.

**Flag naming**: `orreris.kernel.<slice>`, following the existing `?flag=0|1` → localStorage → default convention.

---

## 1. Slice Catalogue

### PHASE 0 — Observability & Harness

#### S0.1 — Diagnostics sink, single identity namespace
| | |
|---|---|
| **Objective** | One record for degradations, denials, write-offs, cache stats, resource pressure, keyed on one identity. |
| **Rationale** | P19/I-29. Eight `window.__rf*` globals key on four schemes; the audit had to join them by hand. Every later slice reports through this. |
| **Depends on** | — |
| **Affects** | new kernel-diagnostics module in `packages/shared`; call sites in `ScenePreviewCanvas`, `compile-flarex`, `preview-frame-pool`, `useFlarexCompProxies`, `scene-compositor` |
| **Invariants after** | none new (foundation) |
| **Risks** | instrumentation perturbing the hot path — prior evidence exists (`tmp/flarex-observer-effect.ts`) |
| **Rollback** | flag off; existing globals untouched throughout Phase 0 |
| **Testing** | assert zero allocation on the recording path when sampling is disabled; A/B frame-time comparison with sink on/off |
| **Done when** | every existing `__rf*` producer also writes the sink; one query answers "what degraded this frame and why" |
| **Flag** | `kernel.diagnostics` (default **on** — additive) |

#### S0.2 — Degradation out-channel
| | |
|---|---|
| **Objective** | The compiler *reports* every degrade (`ended`, `pending`, `null`, host-substituted, unimplemented) without changing what it returns. |
| **Rationale** | I-29/I-34. Today eight null sites and two substitutions are indistinguishable and unobservable. Makes S4.5's deletion measurable before it is attempted. |
| **Depends on** | S0.1 |
| **Affects** | `compile-flarex.ts` (out-channel param, mirroring the existing `onLayerNotReady` precedent); `build-scene-draws.ts`; preview call site |
| **Invariants after** | none — deliberately behaviour-neutral |
| **Risks** | out-channel changing lowering output. Mitigated by the documented precedent: `onLayerNotReady` never changes what `buildSceneDraws` returns |
| **Rollback** | omit the channel — the compiler is unchanged |
| **Testing** | `render:compare:pixels` **byte-identical** on all fixtures with the channel attached and detached |
| **Done when** | host-clip substitutions are counted and attributed per node in real projects |
| **Flag** | none (additive) |

#### S0.3 — Presented-frame ledger
| | |
|---|---|
| **Objective** | Record each presented frame's effective time, participant set and degraded set; detect non-monotonic presents. |
| **Rationale** | I-2 has no instrument at all today. Establishes the coherence baseline S4.6 must beat. |
| **Depends on** | S0.1 |
| **Affects** | `ScenePreviewCanvas` present path |
| **Invariants after** | I-2 *observable* (not yet enforced) |
| **Risks** | low |
| **Rollback** | flag off |
| **Testing** | scripted scrub/play sequences produce a ledger; known-bad cases (proxy playback) show detectable incoherence |
| **Done when** | a baseline incoherence rate exists for the projects the migration will be judged on |

#### S0.4 — Headless conformance harness
| | |
|---|---|
| **Objective** | Drive lowering + draw-build with synthetic time, synthetic media and a null renderer, outside a browser. |
| **Rationale** | I-37 is the property that pays for the whole design. Converts audit findings into failing tests. |
| **Depends on** | — (parallel with S0.1) |
| **Affects** | new harness under the `apps/worker` tsx-script convention (matching `animation:test` / `caption:qa`) |
| **Invariants after** | none; enables assertion of all others |
| **Risks** | harness drifting from real call sites — mitigate by driving the *same* `buildSceneDraws` entry point |
| **Rollback** | n/a (additive, test-only) |
| **Testing** | reproduces at least three known audit findings as failing assertions (C1 loader misclassification, C6 un-retimed matte time, C9 cache-key collision) |
| **Done when** | conformance assertions for currently-satisfiable invariants run in CI |

---

### PHASE 1 — Model Integrity

#### S1.1 — Graph cardinality enforced by the model
| | |
|---|---|
| **Objective** | One-wire-per-input enforced in `healFlarexRegistry` and the `stampFlarexComp` write seam; every entry path routed through it. |
| **Rationale** | I-18/I-20. Currently enforced only in a drag handler (`FlarexNodeCanvas.tsx:1144`); paste, AI intent, import and load bypass it. `edgeInto` (last wins) and `resolveFlarexMediaInRetimes.incoming` (visits all) then disagree about the graph. |
| **Depends on** | S0.1 (report repairs) |
| **Affects** | `packages/shared/src/flarex/registry.ts`; `node-graph-intent.ts`; `FlarexNodeCanvas.tsx` (remove local dedupe once the model owns it) |
| **Invariants after** | **I-20 satisfied** |
| **Risks** | a healed graph differing from what a user had on screen. Mitigate: repair is reported, deterministic (last edge wins, matching the compiler), applied on load only |
| **Rollback** | revert the healer clause; drag-handler dedupe still covers the interactive path |
| **Testing** | extend `flarex.test.ts` healer cases; assert compiler and retime-resolver agree on every healed graph |
| **Done when** | a hand-authored duplicate-socket graph heals identically on load, paste and intent generation |
| **Flag** | none (pure correctness, no output change on valid graphs) |

#### S1.2 — View dot becomes preview-only routing
| | |
|---|---|
| **Objective** | Implement ADR-012 §0.5. Compiler roots at the runtime preview root only; viewer supplies it per comp. |
| **Rationale** | I-26. A viewing affordance must not change delivered pixels. |
| **Depends on** | S0.1 (notice surfacing) |
| **Affects** | `compile-flarex.ts:1470`; `time-transform.ts:134-135`; `build-scene-draws.ts` (`flarexPreviewRootNodeId` scalar → **per-comp map**); `ScenePreviewCanvas.tsx:1474`; `EditorPage.tsx` scope view |
| **Invariants after** | **I-26 satisfied** |
| **Risks** | **user-visible**: projects saved with a view dot change their export output. Also the scalar→map change — a scalar would re-root every comp in a multi-comp frame |
| **Rollback** | restore the `?? comp.previewNodeId` fallback (one line) |
| **Testing** | export a comp with a view dot set — output is MediaOut, not the dot; preview still shows the dot; `render:compare:pixels` unchanged for comps without a dot; multi-comp frame roots each comp independently |
| **Done when** | export output is provably independent of view-dot state; one-time notice appears on affected projects |
| **Flag** | **Atomic, no flag.** Flagging would mean two export semantics coexisting — worse than the change |

---

### PHASE 2 — Frame Identity

#### S2.1 — Frame Scheduler skeleton
| | |
|---|---|
| **Objective** | Frame identity, target time, purpose and lifecycle, wrapping the existing rAF loop. Changes *nothing* about what is computed. |
| **Rationale** | P8/I-30. The attachment point for ordering, cancellation, accounting and every later slice. |
| **Depends on** | S0.1, S0.3 |
| **Affects** | new kernel module; `ScenePreviewCanvas` loop delegates to it |
| **Invariants after** | I-30 *partially* (frames identified; completion in S2.2) |
| **Risks** | double-scheduling if both the new scheduler and the settle window drive draws — **the flag must be exclusive, not additive** |
| **Rollback** | flag off; original loop path intact |
| **Testing** | frame ledger shows one id per composite; no duplicate composites; frame-rate parity with flag on/off |
| **Done when** | every composite carries a frame id and a declared purpose |
| **Flag** | `kernel.frameScheduler` (exclusive) |

#### S2.2 — Explicit frame completion
| | |
|---|---|
| **Objective** | `FrameComplete` / `FrameAbandoned` signals; consumers stop inferring readiness from the settle window. |
| **Rationale** | I-30/I-31. Five independent timeouts currently substitute for one missing predicate. |
| **Depends on** | S2.1 |
| **Affects** | frame scheduler; `ScenePreviewCanvas` settle window; capture and thumbnail call sites |
| **Invariants after** | **I-30 satisfied**; I-31 partially |
| **Risks** | a consumer that silently relied on the 600ms window never receiving a signal → stuck. Mitigate: keep the settle timer as a *backstop* that logs when it fires, so reliance is visible |
| **Rollback** | flag off |
| **Testing** | assert every requested frame terminates; assert the backstop never fires in steady state |
| **Done when** | export, thumbnail and capture all await the same signal instead of reimplementing readiness |

#### S2.3 — Purpose-scoped resource scopes
| | |
|---|---|
| **Objective** | Thumbnail and capture frames run in scopes that cannot reach live caches, pools or version counters. |
| **Rationale** | I-32. Thumbnails currently bump shared matte versions and resize shared accumulators, invalidating the live frame's caches. |
| **Depends on** | S2.1 |
| **Affects** | `ScenePreviewCanvas` capture handle; `SceneMaskMatteCache` / `FlarexSourceDrawCache` / grade-renderer pools; compositor accumulator sizing |
| **Invariants after** | **I-32 satisfied** |
| **Risks** | scratch scopes duplicating GPU memory. Mitigate: scratch scopes are small (thumbnail resolution) and short-lived |
| **Rollback** | flag off; shared pools restored |
| **Testing** | generate thumbnails continuously while paused; assert live mask/content cache versions are unchanged and hit rates hold |
| **Done when** | a thumbnail pass provably does not perturb live-frame cache state |

---

### PHASE 3 — Kernel Extraction

#### S3.1 — Kernel session + State Registry
| | |
|---|---|
| **Objective** | Framework-free kernel module with a session lifecycle and an observable state store; React subscribes. |
| **Rationale** | P7/I-16/I-36. The container every later slice moves state into. |
| **Depends on** | S2.1 |
| **Affects** | new kernel module; `VideoPreview` and `ScenePreviewCanvas` become subscribers |
| **Invariants after** | I-36 for the new module |
| **Risks** | subscription churn re-introducing React-render coupling. Mitigate: follow the proven `playback-clock` pattern (imperative + coalesced React tiers) |
| **Rollback** | flag off |
| **Testing** | S0.4 harness drives the kernel with zero React present |
| **Done when** | the kernel module has no UI-framework, DOM or GL import |

#### S3.2 — Media Manager owns source declaration
| | |
|---|---|
| **Objective** | Which sources exist derives from the graph in the kernel, not from a React memo filtered by proxy state. |
| **Rationale** | I-16. `collectFlarexVirtualLayers` is already a correct pure derivation — this moves *ownership of the result*, not the logic. |
| **Depends on** | S3.1 |
| **Affects** | `VideoPreview.tsx` virtual-layer memo; kernel media module; `virtual-layers.ts` **unchanged** |
| **Invariants after** | I-16 partially |
| **Risks** | source-set churn causing mount/unmount storms during transition |
| **Rollback** | flag off |
| **Testing** | assert source set is a pure function of graph + timeline; assert identity stability across unrelated re-renders |
| **Done when** | no rendering decision can change whether a source *exists* (only its priority) |

#### S3.3 — Decoder Manager owns session lifetime
| | |
|---|---|
| **Objective** | Sessions acquired/released by the kernel, not by component mount/unmount. |
| **Rationale** | I-24. A `useMemo` recompute is currently a decoder teardown. |
| **Depends on** | S3.2 |
| **Affects** | `VideoPreview.tsx` loader mounts; `preview-frame-pool.ts` (ownership, not caps); `WebglMediaLayer` registration |
| **Invariants after** | I-24 partially |
| **Risks** | **high** — decoder lifetime is the most defect-dense area in the runtime. Session leaks or double-release wedge playback |
| **Rollback** | flag off |
| **Testing** | soak: scrub/play/pause/seek cycles asserting session count never exceeds budget and returns to baseline; leak detection on the pool |
| **Done when** | session count is a function of admission alone, provable across a soak |

#### S3.4 — Kernel owns derived-cache lifetime
| | |
|---|---|
| **Objective** | Matte cache, source-draw cache and grade-renderer pools owned by the kernel with declared scopes. |
| **Rationale** | I-8/I-16. Currently React refs pruned inside a draw callback. |
| **Depends on** | S3.1, S2.3 |
| **Affects** | `ScenePreviewCanvas` ref pools; `SceneMaskMatteCache`; `FlarexSourceDrawCache` |
| **Invariants after** | I-8 partially |
| **Risks** | cache lifetime changes altering hit rates and therefore frame timing |
| **Rollback** | flag off |
| **Testing** | hit-rate parity before/after; memory ceiling assertions |
| **Done when** | no GPU-or-CPU cache lifetime is owned by a React ref |

#### S3.5 — Proxy becomes a media source
| | |
|---|---|
| **Objective** | Comp proxy modelled as a source with a served time; `SUSPENDED` state added; loader-unmount coupling removed. |
| **Rationale** | I-24/I-25. Proxy serving currently unmounts the comp's decoders with no hysteresis, so a dropout leaves the comp with neither proxy nor warm sources. |
| **Depends on** | S3.2, S3.3 |
| **Affects** | `useFlarexCompProxies.ts` (split: eligibility → governor, decode → decoder manager, substitution → media manager); `VideoPreview.tsx` proxy filter **deleted** |
| **Invariants after** | I-24 for the proxy path |
| **Risks** | keeping loaders warm behind a proxy costs sessions — exactly the cost the coupling existed to avoid. Mitigate: loaders demote to `preload` priority rather than unmounting; measure against the 75→35fps regression this coupling originally fixed |
| **Rollback** | flag off |
| **Testing** | playhead exits and re-enters a proxied clip span repeatedly; assert no blank/host-clip flash and no session-count spike |
| **Done when** | proxy transitions are crossfades in resource terms, not cuts |

---

### PHASE 4 — Media Truth (highest risk)

#### S4.1 — Time provenance
| | |
|---|---|
| **Objective** | Every time value carries a label per ADR-012 Part 7; unlabelled times become unrepresentable. |
| **Rationale** | I-4. Four unreconciled clocks today; the audit needed four files to establish which consumer used which. |
| **Depends on** | S3.1 |
| **Affects** | `playback-clock.ts`; every consumer of `currentTime` / `getLivePlaybackTime` |
| **Invariants after** | **I-4 satisfied** |
| **Risks** | wide, shallow change touching many call sites |
| **Rollback** | labels are additive; revert is mechanical |
| **Testing** | assert the proxy pump and the composite read the *same* labelled derivation (the one known live crossing) |
| **Done when** | no subsystem holds a time it did not obtain labelled from the clock |

#### S4.2 — `servedTime` propagation end-to-end
| | |
|---|---|
| **Objective** | Every delivered frame carries its time all the way to the draw — including through `SceneTextureSource` and the comp proxy. |
| **Rationale** | I-3. Time currently *exists* in `snapshot()` and is **dropped** at `gradeMediaInContext`; `FlarexCompProxyFrame` never had one. |
| **Depends on** | S4.1 |
| **Affects** | `scene-media-source.ts`; `ScenePreviewCanvas` grade path; `SceneTextureSource` shape; `FlarexCompProxyFrame` shape; `useFlarexCompProxies` |
| **Invariants after** | **I-3 satisfied** |
| **Risks** | shape change to a type consumed by export and worker — must stay optional until all producers supply it |
| **Rollback** | field is additive and ignorable |
| **Testing** | assert every media draw carries a time; assert proxy frames carry theirs |
| **Done when** | the readiness barrier in S4.4 can compute coherence for **every** participant, proxies included |

#### S4.3 — Source Admission
| | |
|---|---|
| **Objective** | Ranked admission with hysteresis and aging; denial as a first-class reported state. **Fallback still present.** |
| **Rationale** | I-27 precondition. Today first-come allocation with no graph knowledge decides which MediaIn wins. |
| **Depends on** | S3.3, S0.2 |
| **Affects** | kernel admission module; `preview-frame-pool.ts`; media manager |
| **Invariants after** | none yet — **temporarily still violates I-27** until S4.5 |
| **Risks** | ranking thrash; a wrong ranking starving a visible source |
| **Rollback** | flag off |
| **Testing** | comps with 5–8 MediaIns: assert the visible-contribution ranking is stable and deterministic; assert denials are reported |
| **Done when** | denial is observable in diagnostics for over-budget comps |

#### S4.4 / S4.5 / S4.6 — **ATOMIC TRIO**

These three must land in one deployment. Splitting them trades a wrong picture for a missing one.

**S4.4 — Readiness Barrier returning `effectiveTime`**
| | |
|---|---|
| **Objective** | Collapse three readiness channels into one; answer with `effectiveTime` + degraded set, not a boolean. |
| **Rationale** | I-1/I-6. "Hold or don't" cannot be coherent during playback; "latest coherent moment" can. |
| **Affects** | `temporal-coherence.ts` (pure functions **move unchanged**); `ScenePreviewCanvas` two gates; `onLayerNotReady`; `awaitingFrame`/`stalenessSeconds` consumers |
| **Fixes** | C1 (loader misclassification — participant kind now travels with the record), C2 (proxy participates) |

**S4.5 — Delete the host-clip fallback**
| | |
|---|---|
| **Objective** | `resolveSourceDraw → null` means no picture, never someone else's. Declared absence per ADR-012 §0.3. |
| **Rationale** | I-27/I-34 — the single most damaging construct in the runtime. |
| **Affects** | `compile-flarex.ts:1112` and the `"pending"` branch at `:1108` |
| **Expected regression** | cross-renderer pixel gates **will** regress (the fallback masked a readiness race with a shared wrong answer). Resolved by S4.4's `effectiveTime`, **not** by restoring the fallback |

**S4.6 — Unified coherence across transport states**
| | |
|---|---|
| **Objective** | Retire `tolerateLag` and the paused-only barrier; one mechanism for both states. Declare the playback lag budget. |
| **Rationale** | I-6. Six `isPlaying` behavioural switches collapse into one. |
| **Affects** | `VideoPreview.tsx` tolerateLag site; `temporal-coherence.ts`; `NOT_READY_HOLD_MS` / `NOT_READY_HOLD_MEDIA_MS` retired |
| **Open input** | the lag magnitude is ADR-012 Open Question 2 — must be measured on the integrated-GPU target before it becomes normative |

**Trio-level**

| | |
|---|---|
| **Depends on** | S4.1, S4.2, S4.3, S0.2, S0.3 |
| **Invariants after** | **I-1, I-6, I-27, I-29, I-34 satisfied**; I-31 satisfied |
| **Risks** | **highest in the programme.** Playback smoothness regression if the lag budget is wrong; visible gaps where the fallback used to hide a wrong picture (correct, but users will report it) |
| **Rollback** | single exclusive flag reverting all three together — never partially |
| **Testing** | S0.3 ledger: incoherence rate → ~0 in both transport states; `render:compare:pixels` on all Flarex fixtures; soak on 4–8-source comps; **explicit sign-off that new gaps are readiness gaps, not regressions** |
| **Done when** | the ledger shows zero incoherent presents playing and paused, and no substituted content anywhere |
| **Flag** | `kernel.readiness` (exclusive, all-three) |

---

### PHASE 5 — Resources

#### S5.1 — Resource Manager (observe-only)
| | |
|---|---|
| **Objective** | One accounting view over GPU memory, sessions, caches and rasters. Reports; does not yet own. |
| **Rationale** | I-8 precondition. Four budgets today, none aware of the others — the ~1 GB texture accumulation was invisible to all four. |
| **Depends on** | S3.1, S3.4 |
| **Affects** | kernel resource module; instrumentation in compositor and pool |
| **Invariants after** | none yet — **temporarily still violates I-8** |
| **Risks** | none (observational) |
| **Rollback** | n/a |
| **Testing** | proxy playback soak reproduces the measured accumulation in the accounting view |
| **Done when** | one query answers "how much is this project using, and who owns it" |

#### S5.2 — Handles with generations — **ATOMIC**
| | |
|---|---|
| **Objective** | `SceneDraw` carries handles, never raw device pointers; stale generations resolve to a declared empty resource plus a diagnostic. |
| **Rationale** | I-17/I-9. The `SceneTextureSource` path has **no** liveness check; only statement ordering prevents use-after-dispose. |
| **Depends on** | S5.1 |
| **Affects** | `SceneTextureSource` shape; `scene-compositor.ts` sampling; every draw producer (preview, `scene-frame-compositor`, `SceneStage`) |
| **Invariants after** | **I-17 satisfied**; I-9 satisfied |
| **Risks** | touches all three renderers simultaneously — cannot be flagged per-renderer without two texture models coexisting |
| **Rollback** | single revert; the shape change is the whole slice |
| **Testing** | `render:compare:pixels` byte-identical on every fixture; forced context-loss test asserts stale handles resolve empty + report |
| **Flag** | **Atomic, no flag** |

#### S5.3 — Wall-clock aging; reclamation decoupled from presentation
| | |
|---|---|
| **Objective** | One budget, wall-clock TTLs; prunes no longer gated behind the present. |
| **Rationale** | I-21/I-33. **This breaks the positive feedback loop**: slow sources → held frames → no reclamation → VRAM climbs → context eviction → all caches destroyed → slow sources. |
| **Depends on** | S5.1, S5.2 |
| **Affects** | `scene-compositor.ts` `frameCounter` TTLs; `ScenePreviewCanvas` prune sites; hold-gate early returns |
| **Invariants after** | **I-21, I-33 satisfied** |
| **Risks** | over-aggressive reclamation causing re-upload churn |
| **Rollback** | flag off |
| **Testing** | sustained scrub soak: assert VRAM plateaus rather than climbing; assert no context-loss events across a long session |
| **Done when** | held/idle/hidden viewers age their caches normally |

#### S5.4 — Proxy onto the shared-context grade path
| | |
|---|---|
| **Objective** | Proxy frames upload once into a per-comp render target instead of allocating a texture per decoded frame. |
| **Rationale** | I-8. The proxy is the only path handing a fresh per-frame object to `SceneLayerDraw.source`; `srcTextures` is keyed by object identity with a 120-frame TTL. |
| **Depends on** | S5.2, S3.5 |
| **Affects** | `useFlarexCompProxies` publish path; `applyFlarex` proxy branch in `build-scene-draws.ts` |
| **Invariants after** | I-8 for the proxy path |
| **Risks** | low — it moves the proxy onto the path every other source already uses |
| **Rollback** | flag off |
| **Testing** | proxy playback soak: texture count constant; VRAM flat; `PROXY_HIGHFPS_FREEZE_REPORT.md` scenario re-run |
| **Done when** | proxy playback allocates O(1) textures, not O(frames) |

---

### PHASE 6 — Evaluation Engine

#### S6.1 — `EvaluationContext` as an explicit parameter — **ATOMIC**
| | |
|---|---|
| **Objective** | Kill the ambient `activeTimeSeconds` cursor. Evaluation time becomes a threaded parameter (ADR-012 T4). |
| **Rationale** | **The single most consequential rule in ADR-012.** Three sites currently read the un-retimed clock (matte rasterization, tracker sampling, content hashing). T4 makes that class structurally unrepresentable rather than merely fixed. |
| **Depends on** | S4.4 (effective time exists to thread) |
| **Affects** | `compile-flarex.ts` (`num`/`str`/`lowerNode`/`rasterizeMatte`/tracker/`computeFlarexContentHashes` signatures); `content-hash.ts`; `time-transform.ts` |
| **Invariants after** | **I-5 satisfied**; fixes C6 |
| **Risks** | wide signature change inside the preserved lowering body — the one slice that touches it. **Structure only: no lowering logic changes.** A missed site becomes a compile error, which is the point |
| **Rollback** | single revert |
| **Testing** | `render:compare:pixels` byte-identical on non-retimed fixtures; **new** retimed fixtures asserting mattes and tracks follow the retime |
| **Flag** | **Atomic, no flag** — a partially-threaded context is worse than either state |

#### S6.2 — Versioned texture sources; cache identity includes evaluation time
| | |
|---|---|
| **Objective** | `SceneTextureSource` carries a content version; cache identity folds evaluation time. |
| **Rationale** | I-21/I-22. Two defects cancel today: the cache is **dead in the browser** (`sourceVersion` always undefined) and **live in the worker** — so a hit and a miss can differ *per renderer*, and the key omits evaluation time. Fixing either alone activates the other. |
| **Depends on** | S6.1, S5.2 |
| **Affects** | `ScenePreviewCanvas` grade path (`entry.lastKey` already computes the needed value); `build-scene-draws.ts:645`; `compile-flarex.ts` materialize identity; `scene-compositor.ts` cache key |
| **Invariants after** | **I-21, I-22 satisfied** |
| **Risks** | **must land together** — enabling the browser cache without the time axis activates the collision that is currently latent |
| **Rollback** | flag off (cache disabled entirely) |
| **Testing** | cross-renderer: assert hit and miss produce identical pixels **on both preview and worker**; retimed multi-instance fixture asserts no collision; cache hit rate becomes non-zero in the browser |
| **Done when** | the artifact cache behaves identically in all three renderers |

#### S6.3 — Materialize by tagging; recalibrate the threshold
| | |
|---|---|
| **Objective** | Tag the existing group per ADR-008 rule 2 instead of wrapping a second one; re-measure `MATERIALIZE_MIN_PASSES`. |
| **Rationale** | ADR-008 compliance. Group-valued materialization currently costs two RTTs, and the cost threshold was calibrated **against that violation** — it must not be carried forward. |
| **Depends on** | S6.2 |
| **Affects** | `compile-flarex.ts:628` `materialize`; `:964` threshold |
| **Invariants after** | ADR-008 rule 2 satisfied |
| **Risks** | materialization becoming profitable at lower cost changes RTT counts and timing broadly |
| **Rollback** | flag off |
| **Testing** | `flarex:perf` scorecard re-run on both the light branch-and-merge and dense 100-node comps; pixel gates unchanged (materialization is pixel-neutral by construction) |
| **Done when** | threshold is re-derived from measurement on the conforming implementation |

#### S6.4 — Node evaluation records
| | |
|---|---|
| **Objective** | Per-node records keyed `(nodeId, evaluationContext)` surviving across frames. |
| **Rationale** | The precondition for dirty propagation, incremental evaluation, async nodes and node state (ADR-012 5.4). |
| **Depends on** | S6.2 |
| **Affects** | kernel evaluator; `compile-flarex` memo becomes a kernel-owned store |
| **Invariants after** | I-34 for node states |
| **Risks** | record store growth; must be budgeted under the Resource Manager |
| **Rollback** | flag off (per-frame memo restored) |
| **Testing** | assert identical output with records enabled/disabled; assert bounded growth |
| **Done when** | a node has an observable state between frames |

#### S6.5 — Dependency tracker + dirty propagation
| | |
|---|---|
| **Objective** | Declared dependency graph; forward dirty closure; per-axis invalidation. |
| **Rationale** | ADR-009 R2/R3. Replaces the 600ms settle guess with an answer, and replaces whole-comp `comp.version` invalidation inside the kernel. |
| **Depends on** | S6.4 |
| **Affects** | kernel dependency/dirty modules; `content-hash.ts` folds |
| **Invariants after** | ADR-009 R2/R3 enforced at runtime |
| **Risks** | **under-approximation is a correctness bug.** Conservatism is the only permitted error direction |
| **Rollback** | flag off (everything dirty every frame — today's behaviour) |
| **Testing** | property test: for random edits, assert the dirty closure is a superset of nodes whose output actually changed |
| **Done when** | an edit dirties exactly its forward closure, provably |

#### S6.6 — Incremental evaluation planning
| | |
|---|---|
| **Objective** | Evaluate only planned nodes; skip clean nodes with valid cached results. |
| **Rationale** | The performance payoff the whole engine exists for. |
| **Depends on** | S6.5 |
| **Affects** | kernel evaluation scheduler |
| **Invariants after** | **I-18, I-23 satisfied** under incremental evaluation |
| **Risks** | plan under-approximation → stale pixels |
| **Rollback** | flag off (full re-lowering) |
| **Testing** | assert full-plan and incremental-plan outputs are byte-identical across a scripted edit sequence; `flarex:perf` improvement |
| **Done when** | a static comp costs ~zero evaluation per frame with identical output |

---

### PHASE 7 — Retirement

#### S7.1 — Retire the kernel-in-a-canvas
Strip scheduling, readiness, resource and capture responsibilities from `ScenePreviewCanvas`; it becomes a surface. **Depends on** all prior. **Risk** low (deleting dead paths). **Done when** the file has no scheduling, resource or readiness logic.

#### S7.2 — Remove flags and compat shims
Delete every `kernel.*` flag and old-path branch. **Done when** one path exists, and ADR-012 Part 12 conformance runs green in CI.

---

## 2. Dependency Graph

```
        S0.1 ──┬── S0.2 ──────────────────────────┐
               ├── S0.3 ──────────────────┐       │
        S0.4 ──┘                          │       │
                                          │       │
        S1.1 (independent)                │       │
        S1.2 (independent, needs S0.1)    │       │
                                          │       │
        S2.1 ──┬── S2.2                   │       │
               └── S2.3 ──┐               │       │
                          │               │       │
        S3.1 ──┬── S3.2 ──┼── S3.3 ── S3.5│       │
               └── S3.4 ◀─┘               │       │
                 │                        │       │
                 └── S4.1 ── S4.2 ────────┤       │
                              S4.3 ◀──────┼───────┘
                                │         │
                                ▼         ▼
                    ┌─────── S4.4 + S4.5 + S4.6 ───────┐   ATOMIC TRIO
                    │                                   │
                    ▼                                   ▼
                  S6.1                          S5.1 ── S5.2 ──┬── S5.3
                    │                                          └── S5.4
                    ▼                                   │
                  S6.2 ◀────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      S6.3        S6.4 ── S6.5 ── S6.6
        │           │        │       │
        └───────────┴────────┴───────┴──▶ S7.1 ──▶ S7.2
```

**Critical path**: `S0.1 → S3.1 → S3.2 → S3.3 → S4.1 → S4.2 → [S4.4/4.5/4.6] → S6.1 → S6.2 → S6.5 → S6.6`

**Parallelisable**: S0.4 with all of Phase 0; S1.1 and S1.2 with anything; Phase 5 with S6.1 after the trio.

## 3. Recommended Order

`S0.1 · S0.4 → S0.2 · S0.3 → S1.1 · S1.2 → S2.1 → S2.2 · S2.3 → S3.1 → S3.2 → S3.3 → S3.4 → S3.5 → S4.1 → S4.2 → S4.3 → **[S4.4+S4.5+S4.6]** → S5.1 → S5.2 → S5.3 · S5.4 → S6.1 → S6.2 → S6.3 · S6.4 → S6.5 → S6.6 → S7.1 → S7.2`

**Rationale for the two non-obvious placements:**
- **S1.2 (view dot) lands early**, despite being a correctness change to export, because it is small, atomic, self-contained and unblocks nothing — deferring it only prolongs a known I-26 violation.
- **Phase 5 lands after the trio, not before**, because handle plumbing (S5.2) touches all three renderers and should not compete for review attention with the highest-risk behavioural change in the programme.

## 4. Flag / Atomicity Summary

| Class | Slices |
|---|---|
| **Flagged, independently revertible** | S0.1, S0.3, S2.1, S2.2, S2.3, S3.1–S3.5, S4.1, S4.3, S5.3, S5.4, S6.2, S6.3, S6.4, S6.5, S6.6 |
| **Atomic, no flag** | S1.2 (two export semantics must not coexist), S5.2 (two texture models must not coexist), S6.1 (a partially-threaded context is worse than either state) |
| **Atomic group, single exclusive flag** | **S4.4 + S4.5 + S4.6** |
| **Additive, no flag needed** | S0.2, S0.4, S1.1, S5.1 |

## 5. Slices That Temporarily Violate Invariants

| Slice | Violates until | Why acceptable |
|---|---|---|
| S2.1 | S2.2 | frame identity exists but completion does not; settle window still backstops |
| S3.1–S3.4 | S5.3 | state has moved to the kernel but presentation still gates reclamation (I-21) |
| **S4.3** | **S4.5** | **admission reports denials while the fallback still substitutes content — I-27 knowingly violated for one slice** |
| S5.1 | S5.2 | resources accounted but not owned (I-8) |
| S6.2 | S6.4 | cache identity correct, but no cross-frame records to exploit it |
| S6.4 | S6.5 | records exist, but everything is still dirty every frame |

Only S4.3's window is behaviourally visible; it must be short, and S4.3 should not ship in a release that does not also contain the trio.

## 6. Milestones & Definition of Done

**Phase 0 — "We can see."** Every degradation reported through one sink with one identity · presented-frame ledger produces a baseline incoherence rate · headless harness reproduces ≥3 audit findings as failing assertions · **zero behaviour change** (`render:compare:pixels` byte-identical).

**Phase 1 — "The model is sound."** Graph cardinality enforced on every entry path · compiler and retime resolver provably agree on every healed graph · export output provably independent of view-dot state · **I-20, I-26 satisfied**.

**Phase 2 — "Frames are real."** Every composite has an id, purpose and terminal signal · settle backstop never fires in steady state · thumbnails provably do not perturb live caches · **I-30, I-32 satisfied**.

**Phase 3 — "The kernel exists."** Kernel module has no UI/DOM/GL import · source set is a pure function of graph+timeline · session count is a function of admission alone across a soak · proxy transitions cause no blank/host flash · **I-36 satisfied for the kernel; I-16, I-24 substantially**.

**Phase 4 — "Media tells the truth"** *(highest risk)*. Ledger shows ~zero incoherent presents in **both** transport states · no substituted content anywhere in the codebase · every participant (proxies included) carries a served time · pixel gates green with new readiness semantics · playback lag budget measured on the integrated-GPU target and recorded in ADR-012 · **I-1, I-3, I-4, I-6, I-27, I-29, I-31, I-34 satisfied**.

**Phase 5 — "Resources are owned."** One budget with one wall-clock aging policy · no raw device pointers in any draw · sustained-scrub VRAM plateaus · proxy playback allocates O(1) textures · zero context-loss events across a long session · **I-8, I-17, I-21, I-33 satisfied**.

**Phase 6 — "The engine evaluates."** Evaluation time threaded explicitly everywhere · retimed mattes and tracks follow the retime · cache hit == miss on **all three renderers** · materialization tags rather than wraps, threshold re-derived · static comps cost ~zero evaluation per frame with identical output · **I-5, I-18, I-21, I-22, I-23 satisfied**.

**Phase 7 — "One path."** No `kernel.*` flags remain · `ScenePreviewCanvas` contains no scheduling/resource/readiness logic · **full ADR-012 Part 12 conformance suite green in CI**.

## 7. Continuously Monitored Risks

| # | Risk | Signal | Response |
|---|---|---|---|
| **R1** | **Observer effect** — instrumentation perturbing what it measures. Prior evidence exists | A/B frame time with sink on/off, every phase | Sampling stays opt-in; state recording must be allocation-free |
| **R2** | **Decoder regression** — the most defect-dense subsystem, touched by S3.3, S3.5, S4.3 | session count, `__rfWcMode` equivalents, freeze reports | Soak before every merge in Phases 3–4; never ship two decoder slices in one release |
| **R3** | **Pixel-gate erosion** — ADR-007 parity is the crown jewel | `render:compare:pixels` on every slice | Any non-zero diff blocks merge unless explicitly justified (only S4.5 has pre-authorised justification) |
| **R4** | **Flag combinatorics** — 18 flags is 2^18 states | flag-state telemetry | Flags are strictly ordered; a later flag requires its predecessors; assert invalid combinations at startup |
| **R5** | **Proxy session cost** — S3.5 keeps loaders warm, the cost the coupling avoided (75→35fps historically) | fps on proxied multi-source comps | If regression returns, demote further rather than reinstating unmount coupling |
| **R6** | **Playback lag budget wrong** — S4.6's declared lag | subjective smoothness + frame-interval telemetry | Measure before normative; treat as configuration until proven |
| **R7** | **Dirty under-approximation** — S6.5/S6.6 stale pixels | property test comparing incremental vs full output | Conservatism only; when in doubt, dirty |
| **R8** | **Cross-renderer cache asymmetry recurring** — the browser/worker split found in audit | cache hit rates reported per renderer | Assert identical hit/miss semantics in all three renderers, not just preview |
| **R9** | **Migration fatigue** — 28 slices over months, parallel session work | slice velocity; stale flags | Each phase must be independently valuable; Phase 0 and 1 deliver standalone value if the programme pauses |
| **R10** | **Scope creep into preserved systems** | diffs touching lowering body / `SceneDraw` / rasterization | Only S6.1 may touch the lowering body, and structurally only |

---

## 8. Verification Strategy

**Per slice**: `pnpm --filter @orreris/web typecheck` + `pnpm --filter @orreris/worker typecheck` · `pnpm --filter @orreris/worker render:compare:pixels` (byte-identical unless justified) · `pnpm --filter @orreris/worker animation:test` · slice-specific harness assertions from S0.4.

**Per phase**: browser soak on a representative multi-source Flarex project (scrub, play, pause, seek, proxy on/off, tab hide/show) with the S0.3 ledger, comparing against the phase-entry baseline · `render:manifest` on a real manifest with manual frame inspection, per CLAUDE.md's guidance to prefer this over trusting typecheck.

**Programme-level**: the ADR-012 Part 12 conformance suite grows monotonically — every satisfied invariant gains an assertion and never loses one. Phase 7 DoD is that suite running green.

---

## 9. Open Items Requiring a Decision Before Phase 4

1. **Playback lag budget** (S4.6) — magnitude must be measured on the integrated-GPU target; ADR-012 leaves it deliberately unfixed.
2. **View-dot migration notice** (S1.2) — confirm the one-time notice wording for projects whose export output changes.
3. **Export-vs-live priority** (ADR-012 Part 6.7) — currently `live` > `export`. If background export becomes a primary workflow this inverts and should become configuration.
