# ADR-012 — Flarex Runtime Kernel & Evaluation Engine Specification

- Status: **Accepted** (governing specification; normative for all Flarex runtime work)
- Normative: Yes
- Date drafted: 2026-08-01
- Date accepted: 2026-08-01 (with the product clarification recorded in Preamble §0.5)
- Governed by: `FLAREX_IMPLEMENTATION_GOVERNANCE.md` · programme in `plans/adr-012-implementation-programme.md`

```
Depends on:
  ADR-007 (lowering to SceneDraw — parity-by-construction)
  ADR-008 (content-addressed materialization substrate)
  ADR-009 (completeness rules R1–R3)
  ADR-010 (node capability contract — the closed question set)
  ADR-011 (evaluation context transform)

Amends:
  ADR-007 §"Soft-degrade, never black"  — see Preamble §0.3
  ADR-007 §"Dirty key: comp.version"    — see Preamble §0.4
  ADR-007 §"Pull evaluation" (view dot) — see Preamble §0.5

Supersedes: (none)
Implemented by: Phases K0–K8 (Part 14)
Evidence base: FLAREX_RUNTIME_AUDIT.md, FLAREX_OWNERSHIP_REVIEW.md (2026-08-01)
```

---

## 0. Preamble

### 0.1 Numbering

This document was requested as "ADR-010". **That slot is occupied by a Frozen, Normative ADR** (Node Capability Contract, adopted 2026-07-23) which this specification *depends upon and must not contradict*. ADR-011 is likewise taken. This is therefore **ADR-012**. Any reference elsewhere to "the runtime kernel ADR" means this document.

### 0.2 What this document is

This is the **constitution of the Flarex runtime**. It specifies the layer that ADR-008 identified as missing — "the architectural layer between lowering and the compositor that owns node identity" — and the kernel that layer must live inside.

It is binding in the following sense: an implementation that violates a Part 12 invariant is non-conforming regardless of how well it performs. Parts 1–11 and 13 are architecture; Part 12 is the enforceable contract.

**Scope boundaries, per the founding constraints.** This document does **not** redesign:
- the lowering compiler (ADR-007) — assumed correct;
- the `SceneDraw` model — assumed correct;
- compositor rasterization — assumed correct.

These three are the system's proven core. The kernel is designed *around* them. Where a boundary must move, it is named explicitly as an amendment (§0.3, §0.4) rather than assumed.

### 0.3 Amendment to ADR-007 — "soft-degrade, never black"

ADR-007 states:

> **Soft-degrade, never black:** a broken graph (cycle, dangling input, matte-only chain) returns `null` → the caller falls back to the plain clip draw; only an intentionally unwired MediaOut renders transparent.

This clause conflates two categorically different failures, and the conflation is the direct cause of the most damaging class of defect found in audit (a graph rendering a *different asset* while reporting success).

**ADR-012 splits the clause:**

| Failure class | Cause | Correct behaviour | Rationale |
|---|---|---|---|
| **Structural failure** | cycle, dangling input, matte-only chain, unwired MediaOut — the *graph itself* is not evaluable | soft-degrade to a **declared empty result** (transparent), reported | The graph is the user's own authored artifact; showing nothing is honest and the user can see the wiring |
| **Resource unavailability** | source denied a decoder, asset unresolved, decode not yet landed, node unimplemented | **declared absence** — never substituted content — recorded in the frame's degraded set | Substituting the host clip presents a *different shot* as if it were correct. There is no reading under which that is a degrade rather than a lie |

The retained half of the original clause is: **a broken graph must never black out an export.** That still holds — an empty result composites as transparent, and the clip below shows through, which is the correct compositing answer.

**The removed half is the host-clip fallback.** It is deleted, not relocated. See Part 12, I-24 and I-30.

**Known consequence, accepted in advance**: removing the fallback will regress cross-renderer pixel gates until Part 10's readiness model lands, because the two renderers do not become ready on the same frame and the fallback was masking that with a shared wrong answer. The gate regression is the *correct* signal; it is resolved by `effectiveTime` (Part 7), not by restoring the substitution. Migration Part 14 requires these to land together.

### 0.4 Amendment to ADR-007 — "comp.version is the sole invalidation key"

ADR-007 names `comp.version` as **the** dirty key. ADR-012 **refines rather than replaces** it:

- `comp.version` remains the **document-level** invalidation token: coarse, monotonic, persisted, and the correct key for anything outside the kernel (proxy identity, manifest transport, export cache identity).
- Inside the kernel, invalidation is **per node**, derived from ADR-009/ADR-010 folds. A `comp.version` bump is a *sufficient* invalidation signal, never a *necessary* one.

No existing consumer changes. The kernel simply stops being obliged to treat a version bump as "recompute everything".

### 0.5 Amendment to ADR-007 — the view dot is editor-only

ADR-007 states that `previewNodeId` "re-roots preview AND export by design". **This is reversed by product decision (2026-08-01).**

The view dot exists solely to inspect intermediate nodes while editing. It MUST NOT influence export, and it MUST NOT redefine the graph's output. Export always begins from the graph's designated output — MediaOut, or an explicit render-output selection — independent of any preview target.

**Preview routing and render routing are separate concerns.** Preview routing is runtime state supplied per frame by the viewer; render routing is a property of the graph. A viewing affordance that changes delivered pixels is a category error, and it is the concrete violation of I-26 that this specification would otherwise have had to grandfather.

`previewNodeId` remains persisted — editor state that survives a reload is still editor state — and the healer continues to validate it. What changes is that **no renderer reads it.** The lowering compiler's root becomes the runtime-supplied preview root alone; when none is supplied, the root is the graph's output. Because that read is in shared code, one change corrects preview, local export and the worker simultaneously.

**Implementation note.** The runtime preview root must be a **per-comp map** (`compId → nodeId`), not a scalar. Today's `flarexPreviewRootNodeId` is a scalar because thumbnails render one comp in isolation; a live viewer frame can contain several comps, each with its own dot, and a scalar would re-root all of them to one node.

### 0.6 Relationship to ADR-010's closed question set

ADR-010 froze the evaluator against a closed set of *questions* over open registries, and named the one condition that reopens it: a genuinely new evaluator question. **ADR-012 adds no new evaluator question.** It specifies *who asks the questions, when, with what budget, and what happens to the answers* — scheduling, ownership, and lifetime. The evaluator's decision surface is untouched.

This is deliberate. If this specification required a new ADR-010 question, that would be evidence the kernel boundary was drawn wrong.

---

# Part 1 — Runtime Principles

Twenty principles. Each is stated as a rule, with the failure it exists to prevent.

**P1 — Single ownership.** Every runtime responsibility has exactly one owner. Where two subsystems appear to share one, the responsibility has been described at the wrong granularity and must be split until each half has one owner.
*Prevents*: the eleven split responsibilities found in audit, each of which produced a defect at the seam.

**P2 — Deterministic evaluation.** Identical `(graph, evaluation context, resolved inputs)` produces identical output, on every renderer, in every process, forever.
*Prevents*: renderer drift; unreproducible bugs; untestable output.

**P3 — Pure lowering.** The lowering layer is a total function from evaluated values to `SceneDraw`. It holds no state, makes no policy decision, allocates no resource, reads no clock, and has no failure mode of its own.
*Prevents*: policy buried three call-frames deep in a pure function, invisible and unreportable.

**P4 — Immutable graph snapshots.** Evaluation operates on an immutable snapshot. The kernel never observes a mutation in progress and never writes to the graph.
*Prevents*: torn reads; evaluation racing an edit.

**P5 — Renderer independence.** The kernel is agnostic to which renderer consumes its output. Preview, local export, worker render, thumbnail and future backends receive the same product of the same pipeline.
*Prevents*: the "preview is the renderer" coupling that made thumbnails mutate live-frame state.

**P6 — Presentation independence.** Evaluation does not know whether, when, or how many times its output is displayed. Presentation does not know how its input was computed.
*Prevents*: presentation policy controlling resource lifetime — the positive feedback loop identified in audit.

**P7 — Framework independence.** The kernel contains no reference to any UI framework, DOM, or rendering API. It is fully exercisable headlessly.
*Prevents*: runtime state owned by a view reconciler, which cannot express identity, ordering, completion, or cancellation.

**P8 — Explicit scheduling.** Work happens because a scheduler decided it should. There is no work triggered by a timer standing in for a predicate, and no work triggered as a side effect of rendering.
*Prevents*: five independent timeouts substituting for one missing completion signal.

**P9 — Explicit state transitions.** Every runtime object is in a named state. Transitions are events. There is no state inferable only from the absence of something.
*Prevents*: "denied", "degraded", "unimplemented" and "empty" all appearing identically as *nothing*.

**P10 — Cache correctness over cache performance.** A cache that might be stale is deleted, not tuned. A hit is bit-identical to a miss. When identity cannot be completed, the artifact is uncacheable — never cached optimistically.
*Prevents*: ADR-009's "one unforgivable failure".

**P11 — No subsystem may silently change correctness.** Any decision that changes produced pixels is either (a) the user's, (b) declared and observable, or (c) forbidden.
*Prevents*: performance policy (proxies, quality tiers, caches) altering output without record.

**P12 — Scarcity is never resolved by substitution.** When a resource cannot be granted, the answer is a declared absence. It is never different content.
*Prevents*: the single most damaging defect found — resource shortage rendered as a plausible wrong picture.

**P13 — Time is explicit and singular.** One authoritative clock. Every other time value is a named derivation carrying its provenance. No subsystem infers which time it should use.
*Prevents*: four unreconciled clocks; a composite built at one time from frames decoded for another.

**P14 — Coherence is transport-independent.** A presented frame is coherent whether playing, paused, scrubbing or exporting. Correctness is not a function of transport state.
*Prevents*: two renderers in one product, switching on a boolean.

**P15 — Resource lifetime is budget-driven, not event-driven.** Resources are reclaimed because a budget says so, on a wall clock, not because a frame was presented or a component unmounted.
*Prevents*: reclamation gated behind the present; TTLs denominated in presented frames.

**P16 — Failure is a value, not an absence.** Every operation that can fail returns a described failure. Nothing communicates failure by returning nothing.
*Prevents*: the eight silent null sites found in the compiler.

**P17 — Every frame terminates.** A frame reaches exactly one of *complete* or *abandoned*, and says so.
*Prevents*: unbounded convergence; unawaitable pipelines; every consumer reinventing "is it ready yet".

**P18 — Model invariants are enforced by the model.** Structural validity of the graph is established on every entry path — load, edit, paste, import, generation, undo — by the document model, never by a view.
*Prevents*: an invariant that two subsystems rely on being enforced only in a drag handler.

**P19 — Instrumentation is a subsystem, not a convention.** Diagnostics have one sink, one identity namespace, and are part of the contract. A state that cannot be observed cannot be relied upon.
*Prevents*: eight debug globals keyed four different ways; conclusions drawn through instruments blind to the relevant path.

**P20 — The kernel is small; the registries are open.** New node types, artifact kinds, dependencies and backends extend the system by registration. The kernel's decision surface does not grow with the feature set.
*Restates ADR-010 at kernel scope.* Prevents the evaluator accumulating node knowledge.

---

# Part 2 — The Runtime Kernel

## 2.1 Why it exists

Three renderers already share a lowering compiler and a draw model, which is why Flarex has parity. What they do not share is everything *around* lowering: what to evaluate, when, with which inputs, at which time, using which resources, and when the result may be shown. Each renderer improvised that layer, and the preview's improvisation grew inside a React canvas component.

The kernel is that layer, extracted once and shared. It exists because **the questions it answers are renderer-independent and the answers must not differ**:

- Which nodes need evaluating for this frame?
- Which sources may hold a decode session?
- Is the input set complete and coherent for one time?
- Which results become artifacts, and how long do they live?
- Is this frame finished?

## 2.2 Responsibilities

The kernel owns: frame lifecycle, evaluation scheduling, dependency and dirty state, node evaluation records, evaluation context construction, source admission, decoder coordination, readiness determination, materialization decisions, cache identity, resource budget and lifetime, degradation recording, and diagnostics aggregation.

## 2.3 Non-responsibilities

The kernel does **not**: own the document; mutate the graph; know node types; produce `SceneDraw` (it invokes lowering); touch a GPU API; own a canvas; decide *when to display*; know what a React component is; or contain any renderer-specific branch.

## 2.4 Boundaries

```
        ┌──────────────────┐
        │  DOCUMENT MODEL  │  owns the graph; enforces validity
        └────────┬─────────┘
                 │ immutable snapshot + version
        ┌────────▼──────────────────────────────────┐
        │            RUNTIME KERNEL                 │
        │   framework-free · GPU-free · UI-free     │
        └───┬───────────────┬───────────────┬───────┘
            │               │               │
   invokes  │        emits  │      exposes  │
            ▼               ▼               ▼
     ┌────────────┐  ┌─────────────┐  ┌───────────┐
     │  LOWERING  │  │  RENDERER   │  │ OBSERVERS │
     │   (pure)   │  │ (backend)   │  │ (UI, test)│
     └────────────┘  └─────────────┘  └───────────┘
```

The kernel calls *down* into lowering (a pure function) and *out* to a renderer backend through an interface it defines. It never calls up. Observers subscribe; they do not command.

## 2.5 Public API surface (architectural, not language-level)

Six capability groups:

1. **Session** — attach a document, configure budgets and policy, tear down.
2. **Frame** — request a frame for a purpose at a time; observe its lifecycle; cancel it.
3. **Transport** — set play state and time; the kernel derives everything else.
4. **Evaluation query** — ask for a node's state, a node's preview, or an isolated subtree's output.
5. **State observation** — subscribe to runtime state: frames, sources, degradations, resource pressure, per-node evaluation state.
6. **Diagnostics** — read the aggregated record; arm traces.

Everything else is internal. Notably absent: any way for a caller to allocate, free, or reference a GPU resource; any way to write to the graph; any way to present a frame.

## 2.6 Lifecycle

```
CONSTRUCTED → ATTACHED(document) → READY ⇄ RUNNING → DRAINING → DISPOSED
                                     │
                                  DEGRADED (budget exceeded / backend lost)
```

The kernel outlives every frame, every viewer, and every renderer backend. Backend loss is a kernel state, not a kernel death: resources are invalidated, evaluation records that depend on GPU artifacts are dropped, and the kernel returns to READY on a fresh backend. Evaluation records that are backend-independent survive.

## 2.7 Guarantees

- **G1** Deterministic evaluation (P2).
- **G2** Every frame terminates and reports (P17).
- **G3** Every presented input set is temporally coherent, or its incoherence is recorded (Part 10).
- **G4** No cache changes output (P10).
- **G5** Resource consumption stays within declared budgets, or the excess is reported.
- **G6** Identical behaviour under React, headless export, worker render, thumbnail generation and future native hosts.

G6 is the load-bearing one: it is what makes the kernel testable without a browser, which is the single highest-value structural property of this design.

---

# Part 3 — Subsystems

Twenty-four subsystems. Format: **Owns / In / Out / Lifecycle / Fails by / Talks to**.

---

### 3.1 Transport
**Owns** the authoritative time and play state; seek, play, pause, rate, loop.
**In** user intent; audio master clock.
**Out** `TransportState { authoritativeTime, playState, rate }`.
**Lifecycle** one per session, kernel-lived.
**Fails by** audio-clock loss → falls back to a wall-derived clock and records the demotion.
**Talks to** Playback Clock (sole consumer of its authority), Frame Scheduler.
*Note*: audio remains master. This subsystem does not gate on render completion; that negotiation belongs to the Presentation Scheduler (Part 6.9).

---

### 3.2 Playback Clock
**Owns** derivation and distribution of every time value; the provenance labelling in Part 7.
**In** `TransportState`.
**Out** named, labelled derived times; subscriptions at declared rates.
**Lifecycle** kernel-lived.
**Fails by** never — a derivation is total. Cannot fail; can only be asked for a derivation that does not exist, which is a contract violation.
**Talks to** every subsystem that needs a time, and is the *only* source of one.
*Rule*: no subsystem may hold a time it did not obtain from here, labelled.

---

### 3.3 Frame Scheduler
**Owns** frame identity, admission, coalescing, deadlines, cancellation, and the terminal signal.
**In** transport ticks, invalidation events, viewer requests, purpose declarations.
**Out** `FrameRequest { id, targetTime, purpose, deadline, quality }`; `FrameComplete` / `FrameAbandoned`.
**Lifecycle** kernel-lived; one live frame in flight per session, plus purpose-scoped background frames.
**Fails by** deadline expiry → abandons the frame with a recorded reason; never silently drops.
**Talks to** everything. It is the kernel's spine.
*Rule*: a subsystem may not begin frame work without a `FrameRequest`. This is what makes cancellation and accounting possible at all.

---

### 3.4 Evaluation Scheduler
**Owns** the evaluation plan: which nodes to evaluate, in what order, within what budget.
**In** `FrameRequest`, graph snapshot, dirty set, prior evaluation records, materialization budget.
**Out** `EvaluationPlan { nodes, requiredSources, materializationSet, estimate }`.
**Lifecycle** per frame.
**Fails by** budget exhaustion → produces a reduced plan with a declared quality reduction, never a wrong one.
**Talks to** Dependency Tracker, Dirty Propagation, Media Manager (source requirements), Materialization Manager, Node Evaluator.
*Rule*: the plan is a superset of the dirty set and a subset of the reachable set. Under-approximation is a correctness bug; over-approximation is only slow.

---

### 3.5 Dependency Tracker
**Owns** the *declared* dependency graph — ADR-010 local and shared dependencies, plus wiring topology (ADR-009 R3).
**In** graph snapshot; node declarations.
**Out** per-node dependency sets; the reachability relation; fan-out counts.
**Lifecycle** rebuilt on graph version change; incrementally maintained within a version.
**Fails by** a node declaring a dependency with no registered provider → that node is **uncacheable**, recorded, never optimistically cached (ADR-009 R2).
**Talks to** Dirty Propagation, Evaluation Cache (identity folds), Evaluation Scheduler.

---

### 3.6 Dirty Propagation
**Owns** the dirty set and its forward closure.
**In** graph edits, dependency version-token changes, context axis changes, cache evictions, backend loss.
**Out** the dirty node set for the next plan.
**Lifecycle** continuous.
**Fails by** in doubt, marking dirty. Conservatism is the only permitted error direction.
**Talks to** Dependency Tracker (the closure relation), Evaluation Scheduler.
*Rule*: dirt propagates **forward** along wiring (ADR-009 R3) and **per-axis** along shared dependencies (ADR-009 R2) — never as a global invalidation.

---

### 3.7 Node Evaluator
**Owns** graph traversal, node result production, evaluation records.
**In** `EvaluationPlan`, `EvaluationContext`, `ResolvedInputSet`.
**Out** node results keyed by `(nodeId, evaluationContext)`; materialization requests.
**Lifecycle** per frame, with records persisting across frames.
**Fails by** returning a **described failure result** (cycle, unresolved upstream, unimplemented, input denied) — never `null`, never a substitute.
**Talks to** Evaluation Cache, Materialization Manager, SceneDraw Builder.
*Rule (ADR-010)*: contains no node-type branch. It asks the closed question set and folds answers.
*Note*: the existing lowering compiler's `switch` on node type is **not** this subsystem. Lowering is a separate, permitted, node-aware layer (Part 3.18).

---

### 3.8 Evaluation Context
**Owns** the immutable context an evaluation runs under: effective time, resolution, working space, quality, purpose, and the ADR-011 context transform.
**In** `FrameRequest`, readiness resolution, node context transforms.
**Out** an immutable context value, threaded to every evaluation.
**Lifecycle** per evaluation; nested contexts under a transform.
**Fails by** cannot — it is a value.
**Talks to** Node Evaluator, Evaluation Cache (identity), Media Manager (retimed source requests).
*Rule*: this is a **value passed as a parameter**, never ambient state and never a mutable cursor. Every time-dependent read takes it explicitly. A site that forgets it must be structurally incapable of compiling.

---

### 3.9 Media Manager
**Owns** the declaration and ranking of sources; source state; the mapping from graph sources to decode requests.
**In** graph snapshot, evaluation plan, context transforms (retimes).
**Out** ranked source requirements; per-source state; degraded set contributions.
**Lifecycle** kernel-lived; sources tracked across frames.
**Fails by** declaring a source `UNRESOLVED` (asset missing) or `DENIED` (admission refused) as observable states.
**Talks to** Decoder Manager, Source Admission, Readiness Barrier, Evaluation Scheduler.
*Rule*: a source's existence is derived from the graph, never from a rendering decision. Whether a proxy is serving may change a source's *priority*; it may never change whether the source exists.

---

### 3.10 Source Admission
**Owns** which sources hold decode sessions, under the decode budget, with hysteresis.
**In** ranked requirements, budget, current assignments, residency clocks.
**Out** `AdmissionDecision { granted, denied }` — denial is first-class.
**Lifecycle** re-evaluated per plan, damped by minimum residency.
**Fails by** denying, explicitly and reportably.
**Talks to** Media Manager, Decoder Manager, Resource Manager, Diagnostics.
*Rule (P12)*: a denial never becomes substituted content.

---

### 3.11 Decoder Manager
**Owns** decoder sessions: acquisition, sharing, priority, eviction, watchdogs, write-off.
**In** admission decisions, per-source requested times (post-retime), session budget.
**Out** `SourceFrame { sourceId, servedTime, handle, generation }` — **every frame carries its time**.
**Lifecycle** sessions outlive frames; bound by budget and residency, never by UI lifecycle.
**Fails by** watchdog write-off → source enters `DEGRADED`, recorded, still eligible for recovery.
**Talks to** Media Manager, Readiness Barrier, Resource Manager.
*Rule*: no session is created or destroyed as a side effect of anything outside this subsystem.

---

### 3.12 Resource Manager
**Owns** *every* runtime resource under *one* budget: decoded frames, textures, render targets, GPU memory, CPU rasters, artifact storage, session slots.
**In** allocation requests, budget configuration, wall-clock aging, pressure signals.
**Out** resource handles; pressure state; eviction events.
**Lifecycle** kernel-lived; survives backend loss by invalidating handle generations.
**Fails by** refusing allocation under pressure, with a recorded reason. Never over-commits silently.
**Talks to** everything that consumes a resource; nothing else may allocate or free.
*Rule (P15)*: aging is wall-clock. Reclamation never depends on frames being presented.

---

### 3.13 GPU Resource Manager
A *sub-domain* of Resource Manager, not a peer. Owns the GPU-specific view: texture residency, render-target pools, backend context lifetime, handle generation on context loss.
**Rule**: it enforces that **no `SceneDraw` ever carries a raw device pointer** — only handles the renderer resolves through it. An unresolvable handle yields a declared empty texture *and a diagnostic*, never an arbitrary sample.

---

### 3.14 Materialization Manager
**Owns** the materialization decision and the artifact identity.
**In** node results, cost estimates (ADR-010 `EvaluationEstimate`), fan-out, budget, `requiresMaterialization` declarations, debug overrides.
**Out** materialization directives; cache identities.
**Lifecycle** per evaluation; artifacts persist under Resource Manager.
**Fails by** declining to materialize under budget — a performance outcome, never a correctness one.
**Talks to** Node Evaluator, Artifact Cache, Resource Manager.
*Rules*: (a) ADR-008 rule 2 — materialize by **tagging** the existing group, never by wrapping a second one; (b) ADR-008 rule 3 — the evaluator decides; nodes declare constraints only.

---

### 3.15 Evaluation Cache
**Owns** node results keyed by ADR-009's `CacheKey = (ContractVersion, applicableContext, NodeContentHash)`, where **`applicableContext` includes effective time whenever the node is time-dependent**.
**In** evaluation records, dependency folds, context folds.
**Out** hits/misses; validity decisions.
**Lifecycle** across frames; bounded by Resource Manager.
**Fails by** declaring a result **uncacheable** whenever identity cannot be completed (ADR-009 R2, P10).
**Talks to** Dependency Tracker, Node Evaluator, Materialization Manager.
*Rule*: this subsystem owns **validity**. It does not own storage.

---

### 3.16 Artifact Cache
**Owns** *storage* of materialized artifacts under the Resource Manager's budget, with tiered retention.
**In** identities from Evaluation Cache; artifacts from the renderer; budget pressure.
**Out** residency; eviction.
**Lifecycle** across frames.
**Fails by** evicting — always safe, since eviction only forces recomputation.
**Talks to** Evaluation Cache (validity), Resource Manager (budget), Renderer Interface (artifact production).
*Rule*: the split with 3.15 is constitutional. **Validity is evaluator-owned; residency is resource-owned.** Neither may decide the other's question. This is the direct fix for the audit finding that a rasterizer held graph state.

---

### 3.17 Presentation Scheduler
**Owns** per-viewer present cadence, vsync alignment, and presented-frame monotonicity.
**In** completed frames; viewer visibility and policy.
**Out** present commands.
**Lifecycle** one per viewer; many per kernel.
**Fails by** skipping a present (never regressing one).
**Talks to** Frame Scheduler (subscribes; does not command), Presentation Barrier.
*Rule*: separate from the Frame Scheduler because one document can feed many viewers. Conflating them is what made a second viewer duplicate the entire runtime.

---

### 3.18 Presentation Barrier
**Owns** the decision to display a completed frame.
**In** `CompletedFrame { frameId, effectiveTime, degradedSet }`, currently presented frame.
**Out** present / withhold.
**Lifecycle** per viewer.
**Fails by** withholding, bounded and reported.
**Talks to** Presentation Scheduler only.
*Rule*: by this point the frame is **already coherent** — coherence was established upstream by the Readiness Barrier. This subsystem degenerates to a monotonicity and policy check. **If it ever needs to reason about source staleness, the architecture has failed upstream.**

---

### 3.19 SceneDraw Builder
**Owns** invocation of the existing pure lowering (ADR-007) and nothing else.
**In** node results / artifact handles, host presentation, evaluation context.
**Out** `SceneFrameSpec` carrying **handles**.
**Lifecycle** per frame; output is a value, discarded after submission.
**Fails by** cannot — total function over evaluated inputs.
**Talks to** Node Evaluator (in), Renderer Interface (out).
*Rule*: **preserved verbatim.** This subsystem is a thin invocation seam that exists so the kernel does not import the lowering layer's node knowledge into itself.

---

### 3.20 Renderer Interface
**Owns** the abstract contract every rendering backend satisfies.
**In** `SceneFrameSpec`; resource handles.
**Out** `CompletedFrame`; artifact production; backend capability declaration.
**Lifecycle** attachable and replaceable at runtime.
**Fails by** declaring backend loss; the kernel invalidates handles and recovers.
**Talks to** SceneDraw Builder, GPU Resource Manager, Frame Scheduler.
*Rule*: backends declare capabilities; the kernel adapts policy, never correctness. A WebGL2 and a WebGPU backend must produce the same pixels or the difference is a defect, not a tier.

---

### 3.21 Export Interface
**Owns** deterministic, deadline-free frame production for delivery.
**In** a frame range, output configuration.
**Out** completed frames in order.
**Lifecycle** per export job.
**Fails by** failing the job explicitly; **never** by degrading silently.
**Talks to** Frame Scheduler (with `purpose: export`).
*Rules*: (a) export frames have **no deadline** — they wait for full readiness; (b) export **never** consumes a proxy or any lossy derivative; (c) export uses the same kernel and the same lowering as preview. This is ADR-007's parity, now extended to scheduling.

---

### 3.22 Thumbnail Interface
**Owns** isolated, re-rooted, low-resolution evaluations for node previews and scopes.
**In** node id, host clip, target size.
**Out** a rendered sample.
**Lifecycle** per request; **scratch-scoped resources**.
**Fails by** returning "not available"; never by mutating live state.
**Talks to** Frame Scheduler (`purpose: thumbnail`), Resource Manager (scratch scope).
*Rule (P5)*: a thumbnail runs in a resource scope that **cannot touch live-frame caches, pools or version counters**. The audit found thumbnails invalidating the live frame's mask and content caches; the scope boundary makes that structurally impossible.
*Rule*: re-rooting is a **runtime** parameter. It never touches persisted graph state.

---

### 3.23 Instrumentation & Diagnostics
**Owns** the single record: frame timelines, source states, degradations, denials, write-offs, cache statistics, resource pressure, eviction causes.
**In** events from every subsystem.
**Out** queryable state; traces; reports.
**Lifecycle** kernel-lived; bounded ring buffers.
**Fails by** dropping oldest samples; never by perturbing the measured path.
**Talks to** everything (receives only).
*Rules*: (a) **one identity namespace** — every record keys on the same source/node identity, so no consumer must join across schemes; (b) instrumentation is always-on for state, opt-in for sampling; (c) an unobservable state is a specification violation (P19).

---

### 3.24 Error Recovery, State Registry, Configuration
- **Error Recovery** owns backend loss, decoder wedge, budget exhaustion and plan failure. Recovery is bounded, reported, and never silently degrades correctness. It owns the retry ladders currently scattered across the preview.
- **State Registry** owns the observable runtime state that UI subscribes to. It is the *only* channel through which runtime state reaches a view (P7).
- **Configuration** owns budgets, policy defaults, and flags. Configuration changes policy; it may never change correctness (P11), and a flag that alters output is by definition not a configuration value.

---

# Part 4 — Runtime Contracts

Format: **Owns / Allowed / Forbidden / Guarantees / On failure**.

### C1 — Transport → Playback Clock
**Owns**: Transport owns authority; Clock owns derivation.
**Allowed**: Transport pushes authoritative time; Clock derives named values.
**Forbidden**: any other subsystem writing time; Clock inventing authority; Transport deriving.
**Guarantees**: exactly one authority; every derived value labelled with provenance.
**On failure**: audio-master loss → wall-derived fallback, recorded demotion.

### C2 — Frame Scheduler → Evaluation Scheduler
**Owns**: Frame owns identity and deadline; Evaluation owns the plan.
**Allowed**: a plan request bearing a `FrameRequest`.
**Forbidden**: planning without a frame; a plan outliving its frame; the plan altering the frame's target time.
**Guarantees**: every plan belongs to exactly one frame; cancellation propagates.
**On failure**: unplannable frame → abandoned with a reason.

### C3 — Evaluation Scheduler → Node Evaluator
**Owns**: Scheduler owns *what and when*; Evaluator owns *how*.
**Allowed**: the plan, the context, the resolved input set.
**Forbidden**: the Evaluator expanding its own plan; the Evaluator requesting media; the Evaluator reading a clock.
**Guarantees**: the Evaluator is pure over its three inputs (P2).
**On failure**: node failure is a described result; the plan completes with a degraded set.

### C4 — Node Evaluator → Materialization Manager
**Owns**: Evaluator owns results; Materialization owns artifact decisions.
**Allowed**: a result plus its identity and cost declaration.
**Forbidden**: the Evaluator allocating an artifact; Materialization inspecting node type (ADR-010).
**Guarantees**: materialization is pixel-neutral (ADR-008).
**On failure**: declined materialization → the result stays folded; output unchanged.

### C5 — Materialization → Evaluation Cache → Artifact Cache
**Owns**: Evaluation Cache owns **validity**; Artifact Cache owns **residency**.
**Allowed**: identity flows down; residency flows up.
**Forbidden**: Artifact Cache judging validity; Evaluation Cache pinning memory.
**Guarantees**: a hit is bit-identical to a miss, **on every renderer** (P10, G4).
**On failure**: incomplete identity → uncacheable, recorded (never optimistically cached).

### C6 — Media Manager → Source Admission → Decoder Manager
**Owns**: Media owns declaration and ranking; Admission owns grants; Decoder owns sessions.
**Allowed**: ranked requirements down; source frames and states up.
**Forbidden**: anything outside this chain creating or destroying a session; admission consulting rendering policy for *existence* (priority only); substitution on denial.
**Guarantees**: granted set fits the budget; every delivered frame carries `servedTime`.
**On failure**: `DENIED` / `DEGRADED` states, recorded (P12).

### C7 — Decoder Manager → Readiness Barrier
**Owns**: Decoder owns frames; Barrier owns the completeness judgement.
**Allowed**: `SourceFrame` with `servedTime` and generation.
**Forbidden**: a frame without a time; the Barrier requesting a decode; the Decoder deciding readiness.
**Guarantees**: the Barrier can always compute coherence, because time is always present.
**On failure**: a source with no frame is `waitingOn` or, past its budget, `degraded` — never invisible.

### C8 — Readiness Barrier → Evaluation Context
**Owns**: Barrier owns `effectiveTime`; Context carries it.
**Allowed**: a resolved input set with one effective time and a degraded set.
**Forbidden**: evaluation beginning on an unresolved input set; the context adopting a time the barrier did not resolve.
**Guarantees**: **every source in an evaluation represents one effective time** (Part 12, I-1).
**On failure**: the frame proceeds with a recorded degraded set, or is abandoned — the scheduler's choice by purpose (live degrades; export waits).

### C9 — Node Evaluator → SceneDraw Builder
**Owns**: Evaluator owns values; Builder owns lowering invocation.
**Allowed**: evaluated values and artifact handles.
**Forbidden**: the Builder evaluating; the Builder making policy; the Builder failing.
**Guarantees**: lowering is total and pure (P3); ADR-007 parity preserved.
**On failure**: not applicable — inputs are already resolved.

### C10 — SceneDraw Builder → Renderer Interface
**Owns**: Builder owns the spec; Renderer owns rasterization.
**Allowed**: a `SceneFrameSpec` of handles.
**Forbidden**: **raw device pointers in a spec**; the renderer reading the graph; the renderer mutating anything but its own resources.
**Guarantees**: the renderer knows no graph (ADR-008 rule 4).
**On failure**: unresolvable handle → declared empty texture + diagnostic; backend loss → handle-generation invalidation and bounded recovery.

### C11 — Renderer → Presentation Barrier → Canvas
**Owns**: Renderer owns completed frames; Barrier owns display permission.
**Allowed**: a completed frame with `frameId`, `effectiveTime`, degraded set.
**Forbidden**: the renderer presenting on its own; the barrier reasoning about source staleness (already settled upstream); presenting a frame older than the one displayed.
**Guarantees**: monotonic presented time (I-2); atomic present per canvas.
**On failure**: withhold, bounded, reported.

### C12 — Resource Manager ↔ all
**Owns**: all resource lifetime.
**Allowed**: allocation requests, handle resolution, pressure signals.
**Forbidden**: **any other subsystem allocating or freeing**; lifetime decisions triggered by presentation or by view lifecycle (P15, I-21, I-29).
**Guarantees**: one budget; wall-clock aging; no ambiguous ownership.
**On failure**: refusal with a reason; eviction is always safe.

### C13 — Document Model → Kernel
**Owns**: the document owns the graph and its validity.
**Allowed**: immutable snapshots + version tokens, one direction.
**Forbidden**: **any kernel write path into the graph**; the kernel observing a partial mutation; the view enforcing model invariants (P18).
**Guarantees**: every snapshot is structurally valid (I-18).
**On failure**: repair on load is explicit and reported, never silent.

### C14 — Kernel → Observers (UI, tests, tooling)
**Owns**: the kernel owns state; observers own presentation of it.
**Allowed**: subscription; intents inbound.
**Forbidden**: observers owning runtime state; observers holding resources; observer lifecycle affecting runtime lifetime (P7, I-15).
**Guarantees**: identical kernel behaviour with zero observers attached (G6).
**On failure**: observer failure is isolated and cannot affect a frame.

---

# Part 5 — State Machines

No hidden state. Every named state is observable through Diagnostics.

### 5.1 Runtime
`CONSTRUCTED → ATTACHED → READY ⇄ RUNNING → DRAINING → DISPOSED`, with `DEGRADED` reachable from READY/RUNNING (budget exceeded or backend lost) and returning on recovery.

### 5.2 Media Source
```
UNDECLARED → DECLARED → REQUESTED → ADMITTED → ACQUIRING → WARMING → READY → ACTIVE
                            │           │          │                          │
                            │        DENIED     REFUSED                   lag>budget
                            │           │          │                          ▼
                            │           └──────────┴──────────────────▶  DEGRADED
                            │                                               │
UNRESOLVED ◀── asset missing┘                                        recovers│
                                                                             ▼
RELEASED ◀── evicted / dropped from plan ◀── PARKED ◀── idle ◀────────── ACTIVE
FAILED   ◀── unrecoverable
EXHAUSTED ◀── source ran past its own material (declared, not a failure)
```
`DENIED`, `UNRESOLVED`, `DEGRADED`, `FAILED` and `EXHAUSTED` are **distinct and observable** (I-30).

### 5.3 Decoder
`IDLE → RESERVED → OPENING → OPEN → SERVING ⇄ SEEKING → OPEN`; `SHARED` as a modifier on `OPEN`; `WEDGED` on watchdog trip; `EVICTED`/`CLOSED` terminal. Eviction is always initiated by Admission or Resource Manager, never by a mount.

### 5.4 Node
`DECLARED → SCHEDULED → WAITING → EVALUATING → EVALUATED → MATERIALIZED → CACHED`, with `DIRTY` re-entry from any settled state and `ERRORED` from `EVALUATING`. `SKIPPED` (not in plan) is distinct from `WAITING` (in plan, blocked).

### 5.5 Evaluation (one frame)
`REQUESTED → PLANNING → ADMITTING → AWAITING_INPUTS → EVALUATING → LOWERING → SUBMITTED → COMPLETE`, with `DEGRADED_PROCEED` bypassing `AWAITING_INPUTS` on budget expiry and `ABANDONED` reachable from every non-terminal state.

### 5.6 Texture
`UNALLOCATED → ALLOCATED → RESIDENT → IN_USE → RESIDENT → EVICTABLE → FREED`. `INVALIDATED` on backend loss, bumping handle generation. Reference counting distinguishes `RESIDENT` from `IN_USE`; eviction may only touch `EVICTABLE`.

### 5.7 GPU Resource (generic)
Same shape as 5.6, with `POOLED ⇄ ACQUIRED ⇄ BOUND ⇄ POPULATED ⇄ RELEASABLE`. The existing compositor's depth-pooled render-target handoff is the reference model for this machine.

### 5.8 Materialized Result
`REQUESTED → EVALUATED → PERSISTED → PROBATION → PROTECTED → EVICTED`. Promotion requires reuse on a *later* frame than the one that stored it — a genuinely cross-frame reuse, not intra-frame fan-out.

### 5.9 SceneDraw
`BUILDING → BUILT → SUBMITTED → CONSUMED → DISCARDED`. Deliberately trivial and **must remain so**: a `SceneDraw` is a value, not a lifetime.

### 5.10 Presentation
`IDLE → PENDING → ADMITTED → PRESENTED`, with `WITHHELD → PENDING` on retry and `SUPERSEDED` when a newer frame completes first. `PRESENTED` records `effectiveTime` to enforce monotonicity.

### 5.11 Playback
`STOPPED → STARTING → PLAYING → PAUSING → PAUSED → SCRUBBING → CONVERGING → PAUSED`, with `THROTTLED` as a modifier on `PLAYING`. `STARTING` and `CONVERGING` are **real states**, not windows papered over by timers.

### 5.12 Proxy
`ABSENT → STORED → ELIGIBLE → WARMING → SERVING → SUSPENDED → SERVING`, with `INVALID` on identity change and `UNAVAILABLE` on decode failure. **`SUSPENDED` is mandatory**: a proxy must relinquish gradually, with its sources warm, before it stops serving.

### 5.13 Cache Entry
`ABSENT → COMPUTING → VALID → STALE → EVICTED`, plus `UNCACHEABLE` as a terminal classification for incomplete identity. `STALE` must be unreachable by construction for a complete identity — if an implementation can reach it, the identity is incomplete.

### 5.14 Virtual Layer
`DECLARED → ADMITTED → BACKED → SERVING → EXHAUSTED`, with `DENIED` and `UNRESOLVED` as declared terminals. Existence derives from the graph; only priority derives from policy.

---

# Part 6 — Scheduling Model

**6.1 Purposes.** Every frame declares one: `live`, `export`, `thumbnail`, `capture`, `analysis`. Purpose determines deadline, resource scope, degradation policy and cache scope. It is the mechanism that keeps scratch work from touching live state.

**6.2 Evaluation scheduling.** Plan-driven, dirty-bounded, budget-bounded. Order is deterministic given the plan. Cheap nodes are never deferred (deferral costs more than evaluation).

**6.3 Decode scheduling.** Ranked by *visible contribution*, not arrival. Ranking inputs: reachability from the active root, contributed area, opacity/blend contribution, and whether the node is under a disabled or zero-weight branch. Damped by minimum residency to prevent thrash.

**6.4 Presentation scheduling.** Per viewer, vsync-aligned, monotonic. A viewer that cannot keep up drops presents; it never reorders them.

**6.5 Resource scheduling.** One budget across GPU memory, decode sessions and CPU rasters, with declared reserves (e.g. a reserve for the frame currently being built). Pressure is a signal the Performance Governor reads; it is never a signal that changes output.

**6.6 Background work.** Proxy generation, thumbnail refresh, analysis and pre-warm run at `background` priority in scratch scopes, are preemptible, and are cancelled by any `live` frame.

**6.7 Priority rules.** `live` > `export` (interactive responsiveness wins on a shared machine; export has no deadline and loses nothing by waiting) > `thumbnail` > `capture` > `analysis`. Within `live`: sources contributing more visible area rank higher.

**6.8 Deadlines and cancellation.** `live` frames carry a deadline derived from the target frame interval. Export frames carry none. Every stage is cancellable at a declared checkpoint; cancellation is cooperative and bounded.

**6.9 Backpressure and the playback contract.** When evaluation cannot meet the frame interval, the kernel reduces *quality* (render scale, materialization budget, source count) before it reduces *coherence*. If quality reduction is insufficient, playback presents the latest coherent moment at a **declared, bounded lag** behind the transport. This lag is the architecture's explicit answer to the question the current runtime avoids by disabling coherence during playback. Audio remains master; video declares its lag rather than hiding it.

**6.10 Stall recovery.** Every wait is bounded and reported. Expiry advances the state machine to a *declared degraded* state — never to a silent substitution and never to an unbounded hold.

**6.11 Fairness.** No source may be starved indefinitely: admission ranking includes an aging term so a persistently low-ranked source eventually receives a session or is declared permanently denied.

**6.12 Budgeting.** Budgets are configuration; conformance to them is not. Exceeding a budget is reported, and the excess is attributed to a subsystem.

---

# Part 7 — Time Model

**One authority. Named derivations. No inference.**

| Name | Definition | Owner | Consumers |
|---|---|---|---|
| **Authoritative time** | the transport's position; audio-mastered | Transport | Playback Clock only |
| **Timeline time** | authoritative time expressed in composition coordinates | Playback Clock | Frame Scheduler, Media Manager |
| **Target time** | the timeline time a frame *aims* to represent | Frame Scheduler | Evaluation Scheduler, Readiness Barrier |
| **Effective time** | the latest timeline time every admitted source can actually represent; `effectiveTime ≤ targetTime` | Readiness Barrier | **everything downstream** |
| **Evaluation time** | the effective time as transformed by ADR-011 context transforms for a subtree | Evaluation Context | Node Evaluator, all time-dependent reads, cache identity |
| **Decode time** | per-source media time after retime, in-point and clamping | Media Manager | Decoder Manager |
| **Served time** | the media time a delivered frame actually represents | Decoder Manager | Readiness Barrier |
| **Presentation time** | the effective time of the frame on screen | Presentation Barrier | monotonicity enforcement, diagnostics |
| **Proxy time** | the effective time a pre-rendered substitute represents | Media Manager | treated as any other source's served time |

**Rules.**
- **T1** Exactly one authoritative time exists per session.
- **T2** Every time value carries its provenance. A subsystem may not hold an unlabelled time.
- **T3** `effectiveTime` is the **only** time evaluation ever sees. Nothing downstream of the Readiness Barrier may read the transport.
- **T4** Evaluation time is a **parameter**, never ambient and never a mutable cursor. Every time-dependent read — parameters, mattes, tracks, generators, source sampling, cache identity — takes the same value from the same place.
- **T5** Every decoded frame carries its served time; a source that cannot report one is time-invariant by declaration or is treated as not-ready.
- **T6** Cache identity includes evaluation time whenever the node is time-dependent (ADR-009 R2 + ADR-011).
- **T7** A proxy is a source. It carries a time, participates in readiness, and is subject to every rule above.
- **T8** Presentation time is monotonic under forward playback.

T4 is the single most consequential rule in this document. The audit found three sites reading an un-transformed clock through an ambient cursor, and the mechanism that permitted it was the cursor's existence. Under T4 that class of defect is structurally unrepresentable.

---

# Part 8 — Resource Model

**Every resource has exactly one owner: the Resource Manager.** Everything else holds *handles*.

| Resource | Created by | Owned by | Borrowed by | Promoted when | Evicted by | Destroyed by |
|---|---|---|---|---|---|---|
| decoded frame | Decoder Manager | Resource Manager | Readiness Barrier, grade stage | never (transient) | reference release | Resource Manager |
| texture | Renderer backend | Resource Manager | `SceneDraw` (handle) | reused across frames | budget/age | Resource Manager |
| render target | Renderer backend | Resource Manager | evaluation/composite stages | becomes an artifact | pool return | Resource Manager |
| GPU memory | backend | Resource Manager | — | — | pressure | Resource Manager |
| temporary buffer | any stage | Resource Manager (scoped) | that stage | never | scope exit | scope |
| cached artifact | Materialization | Artifact Cache under Resource Manager | evaluation (handle) | cross-frame reuse | tiered budget | Resource Manager |
| materialized output | Node Evaluator | Resource Manager | downstream nodes | on promotion | budget | Resource Manager |
| decode session | Decoder Manager | Resource Manager (slot budget) | one or more sources (sharing) | — | admission/pressure | Decoder Manager |
| CPU raster (mattes, text) | lowering/raster stage | Resource Manager | draws | content reuse | budget/age | Resource Manager |

**Rules.**
- **R1** No `SceneDraw` carries a raw device pointer — handles only.
- **R2** Handles carry a generation; resolving a stale generation yields a declared empty resource **and** a diagnostic.
- **R3** Aging is wall-clock. Reclamation never depends on presentation (I-29).
- **R4** Resource scopes are purpose-derived. A `thumbnail` frame's scope cannot reach a `live` scope's resources (I-28).
- **R5** Sharing is explicit and reference-counted; there is no implicit sharing by object identity.
- **R6** Backend loss invalidates generations wholesale; recovery is bounded and reported; evaluation records that do not depend on GPU artifacts survive.
- **R7** A resource whose identity cannot be described is not cached (P10).

---

# Part 9 — Evaluation Model

**Traversal.** Pull-based, memoized, backwards from the active root — preserved from ADR-007, which is correct.

**Dependency resolution.** ADR-010's two folds: local dependencies fold to `NodeContentHash`; shared dependencies fold, **per node**, to `applicableContext`. No global environment version.

**Dirty propagation.** Forward closure along wiring (R3) and per-axis along shared dependencies (R2). Conservative in the safe direction only.

**Incremental evaluation.** Only planned nodes evaluate. A clean node with a valid cached result is not re-derived. The plan is a superset of dirty and a subset of reachable.

**Materialization.** Evaluator-decided (ADR-008 rule 3), by **tagging** (rule 2). Nodes declare `requiresMaterialization` and a work estimate; the evaluator adds fan-out and budget.

**Cache lookup.** `CacheKey = (ContractVersion, applicableContext, NodeContentHash)`, with evaluation time inside `applicableContext` for time-dependent nodes.

**Cache invalidation.** By dependency version-token change, per axis. Never by wholesale flush except on a ContractVersion bump — the deliberate, visible escape hatch.

**Deterministic ordering.** Topological, with a stable tiebreak that is a function of graph structure only — never of insertion order, map iteration, or wall time.

**Parallel evaluation (future).** Permitted without architectural change: the plan already expresses a dependency partial order, and results are immutable. Parallelism is a scheduling decision inside the Evaluation Scheduler. Determinism is preserved because merge order is topological, not completion-ordered.

**Async nodes (future).** Permitted: a node result may be `PENDING` as a *state* (5.4) rather than an absence. The Readiness Barrier already models waiting; an async node is a source of waiting like any other. This is the capability ADR-008 deferred and is unblocked by node state existing at all.

**Streaming nodes (future).** Permitted: a streaming node declares itself stateful (ADR-010) and produces results per evaluation time; the kernel's per-context records already key on time. What streaming additionally requires is a declared *ordering constraint* on evaluation time, which is a scheduling policy, not a new evaluator question.

None of the three future items changes the kernel's decision surface. That is the test this model was designed to pass.

---

# Part 10 — Presentation Model

**Presentation is downstream of, and independent from, evaluation.** The renderer never decides correctness — only whether and when to display.

**Frame readiness** is decided once, upstream, by the Readiness Barrier, which answers with `effectiveTime` and a degraded set — **not** a boolean. This single change is what makes coherence achievable during playback: instead of "hold or don't", the system renders the latest moment that is coherent.

**Coherence** (I-1) is established before evaluation begins. Consequently the Presentation Barrier has no coherence logic — it enforces monotonicity and viewer policy. *If a future implementation finds itself reasoning about source staleness at presentation time, the upstream barrier has failed and the fix belongs there.*

**Frame completion** is explicit (P17). Every consumer — export, thumbnail, test, proxy generation — awaits the same signal rather than reimplementing readiness.

**Soft degradation** applies to *structural* failure only (§0.3): an unevaluable graph yields a declared empty result. Resource unavailability is never soft-degraded into substituted content.

**Late sources.** A source that arrives after `effectiveTime` was resolved does not retroactively alter the presented frame. It dirties the next frame. Frames are immutable once submitted.

**Missing sources.** Declared absence; the frame renders without them and records the degradation. Downstream compositing produces the honest result (a merge keeps its background).

**Resource starvation.** Reduces quality first, then source count, then declares degradation. **Never** substitutes content, and never blocks indefinitely.

**Timeouts.** Every wait is bounded, and expiry is a *reported state transition*, not a silent fallthrough. Two clocks — per-source and per-episode — because each alone has a failure mode the other covers. This pattern is inherited from the existing coherence hold, which got it right and is preserved as the reference design.

---

# Part 11 — Public Interfaces

Architectural interfaces — capability contracts, not language declarations.

**I/Editor ↔ Kernel.** Editor sends intents (seek, play, select, re-root preview, request thumbnail) and subscribes to runtime state. Editor holds no runtime state, no resources, and no scheduling authority. *Kernel behaviour is identical with the editor absent.*

**I/Kernel ↔ Renderer.** Kernel submits a `SceneFrameSpec` of handles; backend returns completed frames and produces artifacts; backend declares capabilities and reports loss. Backends are replaceable at runtime and must be pixel-equivalent.

**I/Kernel ↔ Media.** Kernel declares ranked source requirements with retimed request times; media layer returns time-stamped frames and source states. The media layer is replaceable (WebCodecs, native decoder, server-side) without kernel change.

**I/Kernel ↔ Export.** Export requests a frame range with `purpose: export`: no deadlines, no proxies, no lossy derivatives, full readiness required. The manifest remains the product contract; export consumes the same kernel and the same lowering.

**I/Kernel ↔ Diagnostics.** One sink, one identity namespace, queryable state, armable traces. Diagnostics are part of the contract, not a debug affordance.

**I/Kernel ↔ Testing.** The kernel is driveable headlessly with synthetic time, synthetic media, a null renderer and deterministic budgets. **A conformance suite asserts Part 12 invariants directly.** This interface is the reason the design is worth its cost: it converts most of the audit's findings into failing tests rather than field reports.

**I/Kernel ↔ Plugins (future).** Third-party nodes register into the open registries (ADR-010): declarations, dependencies, artifact kinds. Plugins never obtain a resource handle, never schedule work, and never access a rendering API. A plugin that cannot express itself in declarations is a signal that a new evaluator question may be needed — a deliberate, visible ADR event.

**I/Kernel ↔ Node SDK (future).** The authoring surface over the same registries: a node declares parameters, sockets, dependencies, capabilities, cost and context transforms. Node authors never see the kernel.

---

# Part 12 — Runtime Invariants (the constitution)

**MUST** — a violation is a non-conformance. Conformance is asserted by the Part 11 test interface.

### Time and coherence
- **I-1** A presented frame MUST represent exactly one effective time across every source contributing to it.
- **I-2** Presented effective time MUST be monotonic under forward playback.
- **I-3** Every delivered media frame MUST carry the time it represents.
- **I-4** Exactly one authoritative clock MUST exist; every other time value MUST carry its provenance.
- **I-5** Evaluation time MUST be threaded explicitly to every time-dependent read, including cache identity.
- **I-6** Coherence MUST NOT depend on transport state.
- **I-7** A frame MUST be immutable once submitted; late inputs dirty the next frame.

### Ownership
- **I-8** Every runtime resource MUST have exactly one owner.
- **I-9** Every visible pixel MUST have exactly one ownership path from source to screen.
- **I-10** A node MUST NOT own a GPU resource.
- **I-11** A renderer MUST NOT mutate graph state.
- **I-12** The renderer MUST NOT know the graph.
- **I-13** The evaluator MUST NOT know node types.
- **I-14** The graph MUST NOT carry runtime or rendering state.
- **I-15** The lowering layer MUST NOT own policy, state, resources, or a clock.
- **I-16** The view layer MUST NOT own runtime state.
- **I-17** No `SceneDraw` MUST carry a raw device pointer.

### Determinism and correctness
- **I-18** Evaluation MUST be deterministic over `(graph, context, inputs)`.
- **I-19** All renderers MUST consume the same lowered draws (ADR-007).
- **I-20** Graph structural validity MUST be established by the model on every entry path.
- **I-21** A cache hit MUST be bit-identical to a miss, on every renderer.
- **I-22** Cache identity MUST fully determine the produced pixels; incomplete identity MUST yield uncacheable.
- **I-23** Evaluation ordering MUST be a function of graph structure alone.

### Policy separation
- **I-24** Presentation policy MUST NOT change resource lifetime.
- **I-25** Performance policy MUST NOT change output.
- **I-26** UI state MUST NOT change delivered output.
- **I-27** Resource scarcity MUST NOT be resolved by substituting different content.
- **I-28** Configuration MUST NOT change correctness.

### Observability and failure
- **I-29** Every degradation MUST be a declared, observable state.
- **I-30** Every frame MUST terminate in exactly one of complete or abandoned.
- **I-31** Every wait MUST be bounded and its expiry reported.
- **I-32** A scratch render MUST NOT mutate live-frame state.
- **I-33** Resource reclamation MUST NOT depend on frames being presented.
- **I-34** An unrepresentable state MUST be distinguishable from a valid empty result.
- **I-35** No operation MUST communicate failure by returning nothing.

### Kernel integrity
- **I-36** The kernel MUST contain no UI-framework, DOM, or rendering-API reference.
- **I-37** Kernel behaviour MUST be identical across every host (React, headless, worker, native).
- **I-38** The kernel's decision surface MUST NOT grow with the node catalogue (ADR-010).
- **I-39** Every subsystem MUST be replaceable behind its Part 4 contract without altering output.

**Thirty-nine invariants.** I-27 and I-34 are the two most frequently violated by the current runtime and are the ones most directly responsible for user-visible wrongness.

---

# Part 13 — Extensibility

Each case must be satisfiable **without changing the kernel's decision surface**. That is the test.

| Extension | Mechanism | Kernel change |
|---|---|---|
| **New node type** | register declarations (params, sockets, dependencies, capabilities, cost) | none (ADR-010) |
| **AI / ML nodes** | declare `isStateful`, an async scheduling mode, a `requiresMaterialization` constraint, and an artifact kind; produce deterministic artifact data all renderers re-derive | none — node state (5.4) and async waiting already exist |
| **Streaming sources** | a source that declares an ordering constraint on evaluation time; readiness already models waiting | none — a scheduling policy |
| **Network media** | a media-layer implementation behind I/Kernel↔Media; latency is a readiness concern already modelled | none |
| **GPU compute nodes** | a new artifact kind + backend executor declaration (ADR-010 §"representation vs backend") | none |
| **Distributed rendering** | frames are independent and identified; purpose-scoped; the frame scheduler partitions a range | none — the kernel is already the unit of a render job |
| **Multi-GPU** | Resource Manager gains device affinity as a budget dimension | Resource Manager internal only |
| **WebGPU / Vulkan backend** | a backend behind I/Kernel↔Renderer declaring capabilities | none — backends must be pixel-equivalent (I-19) |
| **Native runtime** | host the same kernel; replace media and renderer implementations | none (I-37) |
| **Server rendering** | export purpose, no deadlines, headless host | none |

**The extensibility claim is falsifiable**: if any of these requires a new evaluator question, ADR-010's reopening clause applies and this specification's boundary was drawn wrong. That is the intended failure mode — visible, deliberate, and recorded.

---

# Part 14 — Migration Mapping

Classification of every existing subsystem. Derived from the two audits.

### KEEP — architecturally correct, do not touch
| Component | Why |
|---|---|
| `compile-flarex.ts` lowering body | pure, deterministic, ADR-007 parity (I-19) |
| `build-scene-draws.ts` draw construction | the shared renderer contract |
| the wrap-collapser | what makes grade chains viable on integrated GPUs |
| `time-transform.ts` affine retime model | sound; only its threading is broken |
| `virtual-layers.ts` derivation | correct pure derivation of sources from the graph |
| node-blind evaluator machinery (content hashing, cost estimation, materialize decision *shape*) | genuine, hard-won ADR-010 compliance |
| compositor RTT depth-pool handoff | the reference model for Part 8 handle ownership |
| bounded-hold discipline (two clocks, two hatches, attributed) | the reference model for Part 10 timeouts |
| `SceneDraw` model | the product contract |

### EXTRACT — correct logic, wrong home
| From | To |
|---|---|
| coherence decision functions | Readiness Barrier (3.18's upstream sibling) — already pure, move unchanged |
| full-res rendezvous logic | Presentation/Performance policy |
| GL-context recovery ladder | Error Recovery (3.24) |
| decoder pool caps and sharing | Resource Manager + Decoder Manager |
| proxy eligibility rules | Performance Governor |

### SPLIT — one component holding several responsibilities
| Component | Split into |
|---|---|
| `ScenePreviewCanvas` | Frame Scheduler · Readiness Barrier · Presentation Scheduler · Presentation Barrier · Resource Manager · a canvas surface |
| `useFlarexCompProxies` | Performance Governor (eligibility) · Media Manager (proxy as a source) · Decoder Manager (decode) |
| `SceneCompositor` | rasterizer (keep) · Artifact Cache storage (move to Resource Manager) · **graph knowledge (remove — I-12)** |
| `compile-flarex.ts` | lowering (keep) · **policy: materialization, degradation, fallback, cache identity (move to kernel — I-15)** |
| `VideoPreview` | layout/view (keep) · source declaration and decoder lifetime (move to kernel — I-16) |

### MOVE — correct, wrong owner
| What | From → To |
|---|---|
| virtual-layer set membership | React memo → Media Manager |
| decoder lifetime | component mount → Decoder Manager |
| cache lifetime (matte, source-draw, grade renderers) | React refs → Resource Manager |
| graph cardinality enforcement | UI drag handler → document model healer (I-20) |
| cache identity construction | compiler → Evaluation Cache |
| preview root selection | persisted `comp.previewNodeId` read by the compiler → runtime input supplied per frame by the viewer, per comp (§0.5) |

### REPLACE — right intent, wrong mechanism
| What | With |
|---|---|
| `requestDraw()` + 600ms settle window | Frame Scheduler with explicit completion (I-30) |
| three readiness channels | one Readiness Barrier returning `effectiveTime` |
| four budgets (sessions, contexts, cache bytes, texture TTL) | one Resource Manager budget, wall-clock aged (I-33) |
| presented-frame TTL clock | wall-clock aging |
| raw texture references in draws | generation-carrying handles (I-17) |
| `materialize()` by wrapping | tagging (ADR-008 rule 2) |
| eight `window.__rf*` globals | one Diagnostics sink, one identity namespace |
| four unlabelled clocks | Part 7's labelled derivations |

### DELETE — no place in the target architecture
| What | Why |
|---|---|
| **host-clip fallback** | I-27 — substitutes different content on scarcity. The single most damaging construct in the runtime |
| `tolerateLag` | I-6 — makes coherence a function of transport state |
| proxy-serving → loader-unmount coupling | I-24 — presentation policy controlling resource lifetime |
| six `isPlaying` behavioural switches | I-6 — replaced by one mechanism |
| the compiler's silent null degradations | I-35 — replaced by described failures |
| module-global mutable caches inside lowering | I-15 |
| export re-rooting from `previewNodeId` | I-26 — a viewing affordance must not change delivered pixels (§0.5) |

### Phased order (dependency-aware)

| Phase | Builds | Deletes | Depends on | Risk |
|---|---|---|---|---|
| **K0** | Diagnostics sink; degradation reporting; presented-time recording | — | — | none |
| **K1** | Model-owned graph validity (I-20); preview root as runtime input (I-26, §0.5) | drag-handler dedupe; export re-rooting from `previewNodeId` | — | very low |
| **K2** | Frame Scheduler; frame identity + completion (I-30) | — | K0 | low |
| **K3** | Kernel state module; runtime state out of React (I-16, I-36) | proxy→loader coupling | K2 | medium |
| **K4** | Media Manager · Source Admission · Decoder Manager | **host-clip fallback** | K0, K3 | high — must land with K5 |
| **K5** | Readiness Barrier; `effectiveTime`; time provenance (Part 7) | 3 readiness channels, `tolerateLag`, `isPlaying` switches | K4 | high |
| **K6** | Resource Manager; handles; wall-clock aging | 4 budgets, presented-frame TTLs | K2, K3 | medium |
| **K7** | Evaluation Scheduler; dirty propagation; correct cache identity; tag-not-wrap | per-frame full re-lowering | K5, K6 | high, but fully specified by ADR-008/009/010 |
| **K8** | Retire the old kernel-in-a-canvas | settle window, shared scratch pools | all | low |

**K0 is mandatory and first.** Three of the four Critical audit findings are currently unmeasurable, and two prior performance conclusions were drawn through instruments blind to the relevant path. **K4 and K5 must ship together** — deleting the fallback without `effectiveTime` trades a wrong picture for a missing one.

Every phase ships behind a flag alongside the existing path, with K0's instruments as the equivalence oracle.

---

# Part 15 — ADR Summary

## Context

Flarex lowers a node graph to `SceneDraw` primitives consumed identically by three renderers (ADR-007), and ADR-008/009/010/011 froze the evaluation engine's *contracts*. The engine itself was never built. In its absence, a React presentation component accumulated the responsibilities a runtime kernel should own: frame lifecycle, scheduling, decoder lifetime, resource lifetime, readiness, and cache lifetime.

Two audits (2026-08-01) traced this to concrete, reproducible failures: media disappearing, sources never mounting, playback differing from pause, valid graphs rendering wrong content, and unbounded GPU growth. Of 41 runtime responsibilities, 6 were cleanly owned; 7 were unowned; 11 were split with no arbiter; 8 sat in the wrong layer. Of 30 candidate invariants, 20 were violated.

The failures are not independent bugs. They are the predictable output of a view framework holding responsibilities it cannot express: identity, ordering, completion, ownership and cancellation.

## Decision

Introduce a **framework-free Runtime Kernel** that owns every runtime responsibility, sitting between an immutable document model and the preserved lowering + rasterization layers.

Five constitutional commitments:

1. **Single ownership.** Every responsibility has exactly one owner (Part 3), governed by explicit contracts (Part 4).
2. **One time authority, explicit derivations.** `effectiveTime` is resolved once by the Readiness Barrier and is the only time evaluation sees. Evaluation time is a parameter, never ambient (Part 7, T4).
3. **Scarcity is never substitution.** A denied resource is a declared absence. The host-clip fallback is deleted; ADR-007's soft-degrade clause is amended to separate structural failure from resource unavailability (§0.3).
4. **Correctness precedes performance everywhere.** Caches never change output; presentation never changes resource lifetime; performance policy never changes pixels (I-21, I-24, I-25).
5. **The kernel is host-independent.** Identical behaviour under React, headless export, worker render, and future native hosts — and therefore testable without a browser (I-37).

## Architecture

Document Model → **Runtime Kernel** (Frame Scheduler · Evaluation Scheduler · Dependency/Dirty · Node Evaluator · Media/Admission/Decoder · Readiness Barrier · Materialization · Evaluation Cache · Resource Manager · Presentation · Diagnostics) → **preserved pure lowering** → **preserved rasterizer** → viewers.

The kernel calls down into lowering and out to a renderer backend; it never calls up. Observers subscribe; they do not command.

## Consequences

**Positive.** Ownership violations become structurally unrepresentable. Coherence works in both transport states via `effectiveTime`. Resource growth is bounded by one budget on a wall clock. Degradations are visible. The runtime becomes headlessly testable, converting most audit findings into conformance tests. Incremental evaluation, async/ML nodes, plugins and alternative backends become reachable without further architectural change.

**Negative.** This is a multi-month effort touching every subsystem except the three preserved ones. It introduces indirection (handles, contexts, plans) that a single-purpose renderer would not need. Phase K4/K5 will regress cross-renderer pixel gates before it fixes them.

**Neutral.** ADR-007's parity guarantee is unchanged. The lowering compiler, `SceneDraw` model and rasterization are untouched. ADR-010's closed question set is not reopened.

## Trade-offs

| Chosen | Over | Because |
|---|---|---|
| kernel extraction | incremental patching | the failures are ownership-shaped; each local fix trades one symptom for another |
| `effectiveTime` | boolean readiness | "hold or don't" cannot be made coherent during playback; "latest coherent moment" can |
| declared absence | soft-degrade to substitute | a wrong picture presented as correct is worse than a visible gap |
| one budget | per-subsystem budgets | four budgets could not see the resource growth that crashed the renderer |
| bounded declared playback lag | hiding lag by disabling coherence | a declared lag is a specification; a hidden one is a defect |
| preserve lowering verbatim | rewrite for kernel fit | parity-by-construction is the system's most valuable property and is already correct |
| K0 instrumentation first | build the kernel first | prior conclusions were drawn through blind instruments; the oracle must exist before the migration |

## Future work

Parallel evaluation; async and streaming nodes; plugin/Node SDK surfaces; WebGPU backend; distributed and server rendering; multi-GPU affinity. **All are reachable without changing the kernel's decision surface** — the falsifiable claim of Part 13.

## Open questions

> **The persisted view dot — RESOLVED (2026-08-01, product decision).** The view dot is editor-only. It never influences export and never redefines graph output. Preview routing is runtime state; render routing is graph state. See Preamble §0.5. I-26 is fully satisfiable; no grandfathering required.

1. **`comp.version` as persisted cache key.** Refined by §0.4, but its role in proxy identity and manifest transport still places a runtime concern in the document. Acceptable at document granularity; revisit if finer keys leak outward.
2. **Playback lag budget.** Part 6.9 declares a bounded lag but does not fix its magnitude. Needs measurement on the integrated-GPU target before it becomes normative.
3. **Export-vs-live priority.** Part 6.7 ranks `live` above `export`. If background export becomes a primary workflow, this inverts and should be configuration, not architecture.
4. **Materialization threshold recalibration.** The current cost threshold was measured against the ADR-008-violating wrap implementation. It must be re-measured after tagging lands and must not be carried forward.
5. **Artifact-cache renderer asymmetry.** Audit found the cache live in the worker and dead in the browser, so a hit and a miss can differ *per renderer*. Part 12 I-21 forbids this. Confirm no equivalent asymmetry survives the migration.

---

*This document governs the Flarex runtime. Implementations conform to Part 12 or they do not conform. Amendments follow the ADR process: a numbered successor, with the amended clauses named explicitly — as §0.3, §0.4 and §0.5 name theirs.*
