# Flarex — Decode Scheduling Architecture Review

- Date: 2026-08-01
- Scope: **one question** — does preview decoding require its own scheduler, separate from ADR-012's Evaluation Scheduler?
- Status: review complete. **Verdict: C** (see §8). Resulting specification: `project-tracker/adr/013-media-acquisition-scheduling.md`.
- Not an implementation task. Not an audit. No slice is implemented or re-planned by this document.

> **Superseded in part by the ADR, r2 (2026-08-01).** This review argued the case; ADR-013 is the
> normative outcome and six things were tightened in review. Where they differ, **the ADR wins**:
> the subsystem is the **Media Acquisition Scheduler** (decode is one job kind, not the definition);
> grants express a **desired capability**, never an engine; the quality ladder is defined by
> **outcome** (L0–L5), not by mechanism; the scheduler **never computes rank** (I-48); acquisition
> work must be **cancellable**, and expired work may not consume future budget (I-49); and
> **reservations** are elevated as the mechanism that prevents background work from starving
> playback. This document is kept for its evidence, which is unchanged.

---

## 0. Summary

**The premise is correct.** The failures under investigation are not evaluation failures. Evaluation is
pure, total and deterministic; it cannot starve, cannot thrash, and cannot decide who gets hardware.
Every symptom traced in this review terminates in a decision about a scarce, stateful, asynchronous
resource — and no subsystem owns that decision.

But the gap is narrower and sharper than "ADR-012 forgot about decoding". ADR-012 §6.3 specifies
decode scheduling *policy* in some detail (rank by visible contribution, damp by residency, age for
fairness). §6.5 specifies one budget. §6.9 specifies quality-before-coherence backpressure. The
policies are there.

**What is missing is an owner for them, and a separation the policies quietly assume.**

1. ADR-012 Part 3 has **no subsystem entry for decode scheduling**. Source Admission owns *who holds a
   session*. Decoder Manager owns *session lifetime*. Neither owns *what an admitted session does with
   its next 24 milliseconds*. Admission is a bin-packing problem over sessions; scheduling is a
   deadline problem over frame requests. The runtime currently conflates them, and so does ADR-012's
   Part 3 — §6.3 is a policy with no address.

2. ADR-012 names a **Performance Governor** three times (§6.5, Part 14 twice) and **specifies it zero
   times**. It is the only actor in the document without a Part 3 entry. It is also, precisely, the
   thing that would own the quality ladder — and the quality ladder is where the observed failures
   actually get decided.

So the answer to the headline question is **yes**, but for a reason worth stating exactly: decode
needs its own scheduler **because it lives in a different time domain from evaluation**, not because
evaluation is inadequate. Details in §5.

---

## 1. Responsibility

### 1.1 What the code shows today

The evidence is not ambiguous. `apps/web/src/playback/preview-frame-pool.ts` (1065 lines) already
implements a substantial part of a decode scheduler — caps, priorities, preemption, session sharing,
warm parking, watchdogs. It is genuinely good work. It is also:

- a **module-global singleton** (`activeLeases`, `idle`, `sharedSessions`, `activeSessions` are file
  scope mutable state) — ambient by construction, regression **G2**;
- **first-come among equals**. `reserveSession` ([preview-frame-pool.ts:850](apps/web/src/playback/preview-frame-pool.ts#L850)) evicts idle
  parks and preempts `preload` leases. When every slot holds a `playhead` lease it returns `false`.
  **There is no arbitration between playhead leases at all** — the fourth arrival loses because it
  arrived fourth, and "which of these four matters most to the picture" is a question the pool cannot
  ask, because it does not know the graph;
- fed a priority **chosen by the caller**, in a React component
  ([WebglMediaLayer.tsx:766](apps/web/src/components/WebglMediaLayer.tsx#L766)), from mount-time visibility.

And the quality decision — the one that determines whether a source gets the hardware block at all —
is computed **inside a JSX prop expression**:

```tsx
// VideoPreview.tsx:3498
preferSoftwareDecode={
  (flarexSwDecodeOverride() ?? true) && isFlarexVirtualLayerId(layer.id) && flarexLoaderRate(layer) <= 1
}
```

This is the single most diagnostic line in the subsystem. It says: *decode quality is a function of
what kind of layer you are, and how fast you are playing.* It is **not** a function of how scarce the
resource is right now, how much of the picture this source contributes, or whether anything is
actually contended. Policy is encoded as **identity**.

That is also why the `rate <= 1` clause exists. The comment above it records the failure honestly:
software decode is a throughput compromise that is comfortable at 1× and breaks at 2×, so a hardcoded
rate threshold was added. The identity did not change; the *cost* changed. A policy keyed on identity
cannot see cost, so the cost had to be re-encoded as another identity predicate. **That is the shape
of a missing negotiation.**

### 1.2 The frame budget has no owner — demonstrably

Two independent constants both named `frameBudgetMs` exist, and they have never been connected:

| Where | Value | Who sets it | Who reads it |
|---|---|---|---|
| `previewQuality.ts:28-30` | 16 / 24 / 33 | **the user**, via Quarter/Half/Full | resolution scale only |
| `preview-frame-pool.ts:791` | **hardcoded 24** | nobody | every decoder session |

The user's playback-quality control drives `resolutionScale` and never reaches the decoder. Meanwhile
the decoder budget is **per provider, not per frame**: four sessions may each spend up to 24 ms, and
nothing anywhere sums them against the 33 ms frame interval. There is no object in the runtime that
represents "this frame's decode budget." The 33 ms in the question statement is a *display* budget
that the decode path has never been told about.

This is not a tuning error. It is the absence of a subsystem: a budget with no owner is a constant.

### 1.3 Recommended ownership

| Responsibility | Owner | Why not elsewhere |
|---|---|---|
| **Hardware vs software engine allocation** | Acquisition Scheduler (new) | Requires the *global* contention picture. Decoder Manager sees one session; Media Manager sees sources, not engines. |
| **Decoder preemption** | Acquisition Scheduler decides · Decoder Manager executes | Preemption is a scheduling verdict; tearing down a session is a lifetime operation. Today both live in `reserveSession`. |
| **Decoder priorities** | Source Admission computes the rank · Acquisition Scheduler consumes it | Rank is a property of *visible contribution* (ADR-012 §6.3), which only Media Manager + graph reachability can compute. A React component cannot. |
| **Frame budgets** | Frame Scheduler declares · Acquisition Scheduler apportions | The deadline belongs to the frame (ADR-012 §6.8). Apportioning it across sources is scheduling. |
| **Decode QoS** | **Performance Governor** (new: policy) | See §4. Mechanism/policy split, matching the Evaluation Cache (validity) / Artifact Cache (residency) precedent. |
| **Decode starvation** | Source Admission (aging, §6.11) · reported by Diagnostics | Starvation is an admission-fairness property, not a decode-ordering one. |
| **Admission control** | Source Admission — **unchanged, ADR-012 3.10 is correct** | No change needed. |
| **Playback quality decisions** | Performance Governor | Currently split across ≥6 owners (§4.1). |

**Nothing moves out of the Evaluation Scheduler.** It never had these.

---

## 2. Scheduling Layers

### 2.1 Does Flarex need multiple schedulers?

Yes — **four**, and it already has four; three are unnamed. The test for "is this a separate
scheduler" is not organisational tidiness. It is: *does it schedule over a different resource, on a
different time base, with a different unit of work and a different failure mode?*

| Scheduler | Resource | Time base | Unit of work | Preemptible? | Failure mode |
|---|---|---|---|---|---|
| **Frame Scheduler** (3.3, specified) | the frame pipeline | vsync / request | a `FrameRequest` | at checkpoints | abandonment |
| **Evaluation Scheduler** (3.4, specified) | CPU/GPU within one frame | **synchronous, intra-frame** | a node evaluation | between nodes | budget exhaustion → fewer nodes |
| **Acquisition Scheduler** (**missing**) | decode sessions + engines | **asynchronous, multi-frame** | a frame request against a session | only between operations | starvation / stale service |
| **Presentation Scheduler** (3.17, specified) | the display surface | vsync, monotonic | a present | no | dropped present |

The Acquisition Scheduler row is the one with no address in ADR-012, and its distinguishing column is
**time base**. Evaluation completes inside a frame or it is cut short. A decode **cannot be**: a seek
on sparse-GOP 4K media is documented in this repo as taking 1–3 seconds
([full-res-rendezvous.ts:34](apps/web/src/playback/full-res-rendezvous.ts#L34)). A unit of work spanning ~90 frames cannot be
scheduled by a scheduler whose entire budget is one frame. They are not the same scheduler with
different parameters; they are different schedulers.

### 2.2 The two candidates I reject

**GPU Scheduler — rejected**, consistent with the prior ownership review. WebGL/WebGPU do not expose
queue submission or preemption; a GPU scheduler in this runtime would be a fiction that could only
observe. GPU *memory* is a Resource Manager budget, which is real.

**Resource Scheduler — rejected as a scheduler; retained as an allocator.** ADR-012 §6.5's "one
budget" is correct and does not need to order work in time. Resource Manager grants and reclaims;
schedulers ask it. Making it a scheduler would give it two jobs and re-create the coupling this whole
programme exists to remove.

**Transport Scheduler — rejected.** Transport is authoritative and audio-mastered (ADR-012 3.1, §6.9).
It is a clock, not a scheduler. Making it schedule would let render completion gate the clock, which
3.1 explicitly forbids.

### 2.3 Contracts between them (no implementation)

```
Transport ──(authoritative time)──▶ Frame Scheduler
                                      │
                        FrameRequest{id, targetTime, purpose, deadline}
                                      ▼
        ┌──────────── Acquisition Scheduler ◀──── AdmissionDecision (Source Admission)
        │                   │                        ▲
        │                   │                 ranked requirements
        │        DecodeGrant{sourceId, engine, quality, byDeadline}
        │                   ▼
        │            Decoder Manager ──▶ SourceFrame{sourceId, servedTime, handle, generation}
        │                   │
        │                   └──────────────────▶ Readiness Barrier
        │                                              │
        │                                     effectiveTime + degraded set
        │                                              ▼
        │                                    Evaluation Scheduler  (deterministic, given the above)
        │                                              ▼
        │                                    Presentation Scheduler
        │
        └── QualityDirective{ladderRung, per source} ◀── Performance Governor ◀── pressure (Resource Manager)
```

Four contracts are new; all four are **declarations, not commands**:

- **C15 `AcquisitionRequirement`** — Media Manager → Source Admission: what each source needs at the target
  time, with its visible contribution.
- **C16 `AcquisitionGrant`** — Acquisition Scheduler → backend: this source, at this time, needing this
  **capability** and this **quality level**, wanted by this deadline. It names no engine — mapping a
  capability onto hardware/software/element/network is the backend's decision, which is what keeps the
  backend replaceable (ADR-013 §4.2, I-44). A grant is not a guarantee; missing it is reported, not fatal.
- **C17 `QualityDirective`** — Performance Governor → Acquisition Scheduler: the ladder rung each source
  may use. Advisory downward only: the Governor may *lower* quality, never raise it past the budget.
- **C18 `AcquisitionPressure`** — Acquisition Scheduler → Performance Governor: observed contention, missed
  deadlines, starvation age. The signal that closes the loop.

**The loop must not close through presentation.** That is regression **G7**, and it is the exact
feedback loop the ownership review named: presentation gating resource decisions makes recovery the
amplifier. Pressure flows Resource Manager → Governor → Acquisition Scheduler, never through a present.

---

## 3. Decode Budget — who gets hardware, and why

### 3.1 The concrete case

3 hardware sessions (`MAX_WC_SESSIONS`), 4 total (`MAX_WC_TOTAL_SESSIONS`), 1 hardware slot reserved
(`HARDWARE_RESERVED_SLOTS`), 4 competing layers, a 33 ms interval.

**Today the answer is: whoever mounted first, unless it is a Flarex virtual layer, in which case it is
pre-emptively demoted to software by a predicate on its id.** The reserved hardware slot exists
because that demotion once starved the host clip — the 2026-07-27 "host frozen, loaders playing"
report, which the pool's own header documents as the inverse of the bug the demotion fixed.

That history is the argument. Each fix was correct locally and redistributed scarcity globally,
because no participant could see the whole allocation. The repo has already learned this — the
`decoder-contention-immunity-rule` states it as doctrine: *making one source class unstarvable
guarantees another loses.* A rule of that shape is a scheduler-shaped hole.

### 3.2 What should decide, and why

**Source Admission ranks; Acquisition Scheduler assigns engines; Resource Manager holds the budget.**

Rank is ADR-012 §6.3's ordering — reachability from the active root, contributed area, opacity and
blend contribution, disabled/zero-weight branches — damped by minimum residency and aged for fairness
(§6.11). This is exactly right and needs no change. What it needs is a consumer.

Engine assignment is the new decision, and the principle is:

> **Hardware goes to the highest-ranked *lag-intolerant* participant. Software is a quality rung, not a
> class of source.**

Lag tolerance is currently `tolerateLag`, set from `isFlarexVirtualLayerId` — identity again. It
should be a **declared property of a source's role in the frame**: a source whose contribution is a
background element behind a blur tolerates lag differently from one carrying the subject. That
property is derivable from the graph, which is precisely why the decision cannot live in the pool.

### 3.3 Architectural representation

A **reservation over a ranked, aged, hysteretic ordering** — not a per-layer flag, and not a cap.

The distinction matters because the current design represents the decision as **two independent caps
that happen to sum**, and the pool's own header records what that cost: splitting hardware and
software into separate caps silently raised concurrency from 3 to 7 and killed the renderer under
scrubbing. `MAX_WC_TOTAL_SESSIONS` was then added on top. *Two caps that merely sum are not a budget* —
their words, and the correct diagnosis. A budget is a single quantity apportioned by a ranking. Three
constants tuned against each other is what you build when nothing owns apportionment.

---

## 4. Quality of Service

### 4.1 It already is a runtime decision — made in at least six places

QoS is not a thing to introduce. It exists, as a ladder with roughly ten rungs, distributed across at
least six owners with no shared view:

| Rung | Mechanism | Current owner |
|---|---|---|
| hardware WebCodecs | default | pool, implicitly |
| software WebCodecs | `preferSoftware` | **a JSX expression** in `VideoPreview` |
| session sharing | `canAttachToSession` | pool |
| `<video>` element | cap-miss fallback | `WebglMediaLayer` mount |
| permanent element condemnation | `wcBailedSources` | **a module-global Set**, no recovery path |
| ingest source proxy (~854 px) | `setIngestProxyPlaybackEnabled` | `EditorPage` |
| comp proxy (pre-rendered) | `useFlarexCompProxies` | eligibility hook |
| render resolution 0.25/0.5/1 | `previewQualityProfiles` | user setting |
| full-res settle (upward) | `full-res-rendezvous` | compositor, 3000 ms budget |
| coherence sacrifice | `tolerateLag` | **a JSX expression** |
| denial | `null` lease | pool |

Ten rungs, six owners, three independent timeout budgets (1500 ms coherence, 3000 ms rendezvous,
24 ms decode), and **no ordering between them**. Nothing in the runtime can answer "we are over
budget — what is the cheapest thing to give up?" because no single component knows the rungs exist.

`wcBailedSources` deserves a specific mention: a source that bails is condemned to the element path
**for the session**, globally, with no aging and no recovery. That is a permanent quality decision made
by a transient condition, which is the definition of a policy that needs an owner.

### 4.2 Answer: yes, explicitly — and the Performance Governor owns it

The ladder must become **one ordered, declared list**, and giving up quality must be an ordered walk
down it. ADR-012 §6.9 already fixes the first ordering rule: *reduce quality before coherence*. Today
`tolerateLag` does the exact opposite — it sacrifices coherence *first*, as a per-layer default, before
any quality rung has been tried.

The Governor is the right owner and it is already half-named in ADR-012 (§6.5, Part 14). It must be
specified, and it must be **policy only**:

- it reads pressure and rank; it emits `QualityDirective`;
- it **may never allocate, decode, evaluate, or present**;
- it may only ever *lower* quality — raising is a rendezvous, owned by the presentation side, because
  raising must be atomic across participants (the lesson `full-res-rendezvous.ts` already encodes).

That last constraint is not obvious and is worth preserving explicitly: **degradation may be
per-source, but restoration must be collective.** Sources that degrade independently look busy;
sources that *recover* independently look broken — which is the "clips fill in one at a time" symptom,
and the rendezvous module exists because of it.

---

## 5. Relationship to Evaluation — can evaluation stay deterministic?

**Yes, and the mechanism is already in ADR-012.** This is the question whose answer decides whether a
separate scheduler is coherent at all, so it is worth being exact.

Evaluation is deterministic over `(graph, context, inputs)` — ADR-012 I-18, and rule T4: evaluation
time is an explicit parameter, never ambient. The word doing the work is **`context`**.

Adaptive decoding does not make evaluation adaptive, provided every adaptive choice is **resolved
before evaluation begins and enters as part of the context**:

```
adaptive, asynchronous          │  quantised          │  deterministic, synchronous
────────────────────────────────┼─────────────────────┼──────────────────────────────
Acquisition Scheduler   ─┐           │                     │
Performance Governor├──────────▶│  EvaluationContext  │──────▶ Node Evaluator
Source Admission   ─┘           │  { effectiveTime,   │        (pure, total, replayable)
                                │    resolved sources,│
                                │    quality rungs,   │
                                │    degraded set }   │
```

Everything left of the boundary is adaptive, stateful and timing-dependent. Everything right of it is
a pure function. The boundary is the `EvaluationContext`, and determinism means: **given the same
context, the same output — always, on every renderer.** It does *not* mean the context is the same
every frame. It never was.

Two consequences that must be stated as rules, because violating either silently destroys I-18:

1. **Evaluation may never observe decode state.** Not "is this loading", not "did this miss its
   deadline", not "which engine served this". A node that can see decode state is a node whose output
   depends on machine timing, and ADR-007 parity dies with it — the worker would decode differently
   from the browser and both would be "correct".

2. **The context must be recordable and replayable.** If a frame's context can be captured, the frame
   can be reproduced headlessly — which is I-37, and which is what makes the whole adaptive layer
   testable. An adaptive system you cannot replay is one you cannot debug.

This is also why the trio S4.4/S4.5/S4.6 was correctly identified as atomic. `effectiveTime` **is** the
quantisation boundary. Without it there is nowhere to put the adaptivity, which is why the current
runtime leaks it into the renderer as substituted content.

---

## 6. Relationship to Presentation — who drives whom?

**Neither. Both are wrong, and the current runtime demonstrates both failures.**

- **Pure pull** (presentation requests frames synchronously) is today's model: `getFrame` is called on
  the draw path with a 24 ms budget. It produces the documented `MAIN THREAD BLOCKED ~2.6s` — because
  a pull cannot express a deadline it is willing to miss, so it either blocks or lies.
- **Pure push** (decode publishes and presentation follows) produces the staggered-fill symptom:
  N sources push independently, each present shows whoever arrived, and the picture assembles itself
  on screen. Push has no backpressure and no notion of a set.

The correct model is **declared demand, published supply, reconciled by a barrier** — which is what
ADR-012 already specifies, with the pieces in the right places:

| Stage | Who | What |
|---|---|---|
| drives | **Transport** | authoritative time, audio-mastered (§6.9) |
| declares demand | Frame Scheduler → Acquisition Scheduler | "these sources, this target time, by this deadline" |
| publishes supply | Decoder Manager | `SourceFrame{servedTime, handle, generation}` — **every frame carries its time** |
| reconciles | Readiness Barrier | `effectiveTime` + degraded set |
| presents | Presentation Scheduler | monotonic, drops but never reorders (§6.4) |

**Transport drives. Decode publishes. The barrier decides what moment the frame is.** Presentation
never requests a decode, and decode never triggers a present. Both of those edges are the coupling
that produces the failures, and removing them is what makes the loop breakable.

---

## 7. Architectural Model

**Leases for capacity; deadline-scheduled jobs for work; reservations for the frame in flight.**
Three mechanisms, because there are three genuinely different lifetimes.

| Model | Applies to | Lifetime | Why |
|---|---|---|---|
| **Lease** | a decode session | seconds — spans many frames | A session is expensive to create (demux, index, GOP window) and must survive frame boundaries. Leases carry priority, minimum residency, aging and **preemption with notice** — the pool's `onPreempted` is already exactly this and is the best-designed part of the subsystem. |
| **Scheduled job** | one frame request against a leased session | one frame, possibly missed | Jobs carry a deadline, a rank and cancellation. This is the layer that does not exist today: `getFrame` is an unranked, uncancellable, per-provider blocking call. |
| **Reservation** | budget held for the frame under construction | one frame | ADR-012 §6.5's "declared reserves". Stops a background proxy build from consuming the slot the live frame is about to need. |

**Rejected models, with reasons:**

- **Pure pull** — cannot express a deadline it is willing to miss; §6 above.
- **Pure push** — no backpressure, no set semantics; §6 above.
- **Jobs alone (no leases)** — would re-create a session per request. Sessions cost a demux index and a
  GOP window; this is what Stage 1/Stage 2 of the pool exist to avoid.
- **Leases alone (today)** — a lease grants *capacity* but says nothing about *ordering within it*. This
  is precisely the gap: four leases, all "playhead", all calling `getFrame` with their own 24 ms, no
  ordering, no shared deadline. **Leases without jobs is the current architecture, and its failure mode
  is the reported one.**

The pool has already built the lease layer, well. It has never had the job layer, and no amount of cap
tuning substitutes for one.

---

## 8. Does ADR-012 change?

> ### **C. ADR-012 is missing a fundamental subsystem.**

Specifically, it is missing **two**, and they are mechanism and policy for the same concern:

1. **Acquisition Scheduler** — ADR-012 §6.3 specifies decode-scheduling policy but Part 3 assigns it to no
   subsystem. Source Admission owns *who holds a session*; Decoder Manager owns *session lifetime*;
   nothing owns *what an admitted session decodes next, in what order, against what deadline*.

2. **Performance Governor** — referenced in §6.5 and twice in Part 14, specified nowhere. It is the
   only named actor in ADR-012 without a Part 3 entry, and it is the owner the ten-rung quality ladder
   has been missing.

**This is an addition, not a correction.** Nothing in ADR-012 is wrong. The invariants stand, the
contracts stand, and — importantly — §6.3, §6.5, §6.9, §6.10, §6.11 already contain most of the policy
these subsystems need. ADR-013 gives those policies an owner and adds the mechanism/policy split.

`project-tracker/adr/013-media-acquisition-scheduling.md` specifies **only these two subsystems**:
their responsibilities, contracts C15–C18, invariants I-40…I-49, and their boundaries against the
existing 24. It does not redesign the runtime, does not touch Tier A, and does not alter any existing
invariant.

The deeper outcome is not the two subsystems but the separation of four responsibilities the runtime
blends today: **admission** (who may consume scarce capacity), **scheduling** (what admitted capacity
does next, and by when), **lifetime** (how a session is created, shared, parked, destroyed), and
**policy** (how quality is traded against pressure). ADR-013 §0.1 records that split.

### 8.1 Consequence for the programme — flagged, not applied

Per governance §2, this is a **Level 3** change (a new subsystem), and it lands as an ADR. Three
programme slices now have an owner they were going to have to invent:

| Slice | Was | Should become |
|---|---|---|
| **S3.3** Decoder Manager | session lifetime + implicitly all scheduling | session lifetime only; scheduling splits out |
| **S4.3** Source Admission | ranked admission | unchanged — ADR-012 3.10 was already correct |
| **S3.5** Proxy as a media source | eligibility → "governor" | eligibility → the **specified** Performance Governor |

I have **not** edited `plans/adr-012-implementation-programme.md`. Re-planning is a separate decision
and it is yours to make; the review's job was to determine whether the gap is real.

**The specific reason this review was worth stopping for**: S3.3 as written would have moved session
lifetime into the kernel while leaving engine selection in a JSX expression and the frame budget as a
hardcoded 24. That is a slice that satisfies its own completion criteria and leaves the defect intact —
the most expensive kind to discover afterwards.
