# ADR-012 — Completion report

**Status:** complete. **Branch:** `method-3-gpu-compositor`. **Date:** 2026-08-04.

The Flarex runtime kernel is now the runtime. There is one execution path, no rollout flags, and no
rollback branches. This document is the closing record: every slice, every flag removed, the final
regression results, and the four things the programme learned that outlived it.

---

## 1. What shipped, by slice

Thirty-three slices across eight phases. Every one landed with its own conformance assertions; the
invariant numbers below are the ADR-012 Part 12 identifiers enforced by `pnpm --filter @orreris/worker
kernel:conform`.

### Phase 0 — Instruments before changes
| Slice | What it did |
|---|---|
| S0.1 | Diagnostics sink with a single identity namespace — one `kernelDiagnostics.record` seam |
| S0.2 | Degradation out-channel: a degraded frame reports *why*, not merely that it happened |
| S0.3 | Presented-frame ledger (`__rfFrameStats`) |
| S0.4 | Headless conformance harness — the gate every later slice was written against |

### Phase 1 — Model
| Slice | What it did |
|---|---|
| S1.1 | Graph cardinality enforced by the model rather than by convention |
| S1.2 | The view dot becomes preview-only routing (editor-only; it never reaches a render) |

### Phase 2 — Scheduling
| Slice | What it did |
|---|---|
| S2.1 | Frame Scheduler skeleton |
| S2.2 | Explicit frame completion — the viewer can finally say when a frame is DONE |
| S2.3 | Purpose-scoped resource scopes (I-32): a thumbnail stops charging the live frame for its work |

### Phase 3 — Media and decoders
| Slice | What it did |
|---|---|
| S3.1 | Kernel session + State Registry — a lifetime, a store, and a lock on the door |
| S3.2 | Media Manager owns source declaration; a source stops disappearing when something declines to render it |
| S3.3 | Decoder Manager owns session lifetime; a re-render stops being a decoder teardown |
| S3.4 | Kernel owns derived-cache lifetime; reclamation stops when the picture stops |
| S3.5 | Proxy becomes a media source — a proxy stops deleting the sources it stands in for |

### Phase 4 — Time and capacity
| Slice | What it did |
|---|---|
| S4.1 | Time provenance — a time that cannot say where it came from stops compiling |
| S4.2 | `servedTime` propagation end-to-end; a texture becomes pixels-at-a-moment |
| S4.3 | Source Admission — capacity granted by contribution, not by mount order |
| S4.4 | The readiness barrier answers with a *moment*, not a boolean (additive; shipped alone) |
| S4.5 + S4.6 | **Atomic pair.** Withhold a stand-in, not the source itself + one unified coherence barrier |
| S4.7 | Session satisfaction — a borrow must not degrade the service it joins |

### Phase 5 — Resources
| Slice | What it did |
|---|---|
| S5.1 | Resource Manager, observe-only |
| S5.2 | **Atomic.** Handles with generations; a scene draw stops carrying a pointer it cannot check |
| S5.3 | Wall-clock aging — caches age on the clock, not on frames that reach the screen |
| S5.4 | Proxy onto the shared-context grade path: one target per comp, not one texture per decoded frame |

### Phase 6 — Incremental evaluation
| Slice | What it did |
|---|---|
| S6.1 | **Atomic.** `EvaluationContext` as an explicit parameter — evaluation time stops being ambient |
| S6.2 | Versioned texture sources; cache identity includes evaluation time |
| S6.3 | Materialize by tagging; threshold recalibrated |
| S6.4 | Node evaluation records — a node starts leaving something behind |
| S6.5 | Dependency tracker + dirty propagation |
| S6.6 | Incremental evaluation planning — a clean node stops being re-evaluated |
| Phase 6 host | Host integration: the incremental evaluator stops being latent |

### Phase 7 — Retirement
| Slice | What it did |
|---|---|
| S7.1 | `ScenePreviewCanvas` becomes a surface — scheduling, readiness, resource and capture responsibilities all leave the viewer |
| S7.2 | Every rollout flag and compat branch deleted (below) |

---

## 2. Flags removed

Eleven rollout flags, deleted in six families, each family its own commit with its own gates.

| Family | Commit | Flags removed |
|---|---|---|
| 1 | `0758224` | `kernelScopes`, `kernelProxyUpload`, `kernelIncremental` |
| 2 | `dc1319d` → reverted `92ce73b` → retried `86d2f3f` | `kernelWallClockTtl`, `kernelProxySource` |
| 3 | `5389709` | `kernelSessionSatisfaction`, `kernelSourceAdmission` |
| 4 | `15d615b` | `kernelFrames` |
| 5 | `366860c` | `coherenceUnified` (and the paused-only barrier it selected) |
| 6 | `c6c6bd8` | `kernelResources`, `kernelDecoderLifetime` |

**Retained, deliberately: `kernelDiagnostics`.** It is an *observability control*, not a rollout flag.
All 25 runtime guard sites were audited (table in `plans/adr-012-phase3-soak.md`) and every one has the
same shape — the state change happens outside the guard, only `kernelDiagnostics.record(...)` sits
inside it. `rankAdmission` decides admission whether or not anyone is watching; the guard covers the
denial record. Nothing landed in the "changes runtime behaviour" bucket. `kernel-flags.ts` therefore
survives holding exactly one entry.

One nuance worth carrying forward: `admissionDenials` is counted *inside* the guard, so it reads 0 with
diagnostics off. `capMisses` is the unconditional counter beside it and is the one a soak should trust.

### Dead paths deleted alongside the flags
- `shouldHoldForCoherence`, `getCoherenceHoldEnabled`, `getCoherenceUnifiedEnabled` — the paused-only
  barrier and its fifth flag resolver
- `allowHostSubstitution` through `compile-flarex.ts` and `build-scene-draws.ts` — substitution is now
  refused unconditionally (`if (substituting) return null;`)
- The frame-count aging arm in `scene-compositor.ts`, plus `setSceneWallClockTtl`
- The `ColorScopes` paused-edit poll and its watch timers
- `getKernelDecoderLifetimeEnabled` — retention is now whatever the caller asked for

### Conformance suite changes
Assertions that existed to verify *flag-off rollback* were retired or inverted, not preserved
artificially:
- **I-33** re-pointed at the extracted readiness decision
- **I-34** inverted: asserts substitution is refused unconditionally *and* that `allowHostSubstitution`
  no longer appears anywhere
- **I-6** inverted: asserts the paused-only barrier has no callers *and* no definition
- **I-25** (×2) retired with a note pointing at I-6/I-34, which now carry the permanent claim
- **I-29** unchanged in intent — still asserts exactly one flag-resolution path

---

## 3. Final regression results

Closeout tree, all green:

| Gate | Result |
|---|---|
| `pnpm --filter @orreris/worker kernel:conform` | OK — all enforced invariants hold |
| `pnpm --filter @orreris/web typecheck` | clean |
| `pnpm --filter @orreris/worker typecheck` | clean |
| Pixel gate (`render:compare:pixels`) | **53/53** |
| Decoder soak (`preview:budget`, satisfaction arm) | 3/3 runs `detach=0`, `capMisses 0`, `blindSplits: 1`; retention hits 6/7, 6/7, 5/8 |

Retention is reported as a range because the session count is fixture variance, not a runtime property:
one run opened eight sessions rather than seven. The invariants — zero detaches, zero cap misses, and
exactly one blind split proving the fixture still reaches the S4.7 path — held on every run.

S4.7 was additionally re-accepted in the always-on world against its original criterion: **10/10 runs,
zero `approved-as=no-incumbent-demand` detaches**, `capMisses` flat, no new borrow mechanism.

---

## 4. Four things this programme learned

**1. Acceptance evidence does not transfer across a flag removal.** S4.7 passed 10/10 under
`kernelProxySource=0`. Deleting that flag changed the borrowing topology and the same fixture detached
3/3. The flag was not a wrapper around the behaviour; it *was* part of the behaviour. Recorded as a
mandatory rule: **every decoder-topology change requires a decoder soak**, not just conform + typecheck
+ pixel.

**2. The pixel gate cannot see decoder divergence.** 53/53 was green through the entire `dc1319d`
regression. Correctness gates measure the output; this class of defect lives in the *cost and topology*
of producing it.

**3. Every decoder-topology change must be bisectable.** `dc1319d` bundled two flag removals and cost a
five-state bisect to learn that `kernelWallClockTtl` was innocent and `kernelProxySource` was guilty.
The `dc1319d → 92ce73b → 86d2f3f` sequence is the reference example.

**4. Count the reasons; never infer which branch fired.** The S4.7 fix was found by adding a
discriminator (`approved-as` on every detach record) rather than by reasoning about which approval path
was likely. Two earlier sessions were lost to plausible-but-unsupported inference. The corollary shows
up in the fix itself: the blind borrow was *correct at approval time*; the defect was that it was never
re-examined. That is why the correction is `reviseBlindShare` at the declaration seam and **not** a
change to the `sessionSatisfaction` predicate, which remains byte-identical to its pre-S4.7 form.

The five soak rules live in `plans/adr-012-phase3-soak.md` and are the operative playbook for any future
decoder work.
