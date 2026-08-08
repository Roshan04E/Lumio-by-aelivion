# ADR-013 — Media Acquisition Scheduling & the Performance Governor

- Status: **Accepted** (normative; extends ADR-012)
- Normative: Yes
- Date drafted: 2026-08-01
- Date accepted: 2026-08-01, after a four-round architectural pressure-test
- Revision: r4 — hardened under pressure-test 2026-08-01: membership test (§0.3), capability test (§4.2), reservation decay (§4.4), Governor rate boundary (§3), scheduler cost & state bounds (§4.5), non-video walkthroughs (§5.2), deliberate non-generalization (§10), invariants I-50…I-54
- Governed by: `FLAREX_IMPLEMENTATION_GOVERNANCE.md`

```
Depends on:
  ADR-007 (lowering to SceneDraw — parity-by-construction)
  ADR-012 (Flarex Runtime Kernel — the constitution)

Extends:
  ADR-012 Part 3  — adds subsystems 3.25 and 3.26
  ADR-012 Part 4  — adds contracts C15–C18
  ADR-012 Part 12 — adds invariants I-40…I-54

Amends: (nothing — no existing clause changes)
Evidence base: FLAREX_DECODE_SCHEDULING_REVIEW.md (2026-08-01)
Amended by: ADR-020 (2026-08-06, premise correction) — see box below
```

---

> ## AMENDMENT (2026-08-08) — the Media Acquisition Scheduler is not being built as specified
>
> This is a consequence of ADR-020's premise correction (2026-08-06), recorded here rather than in a new
> ADR — ADR-020 already carries the decision; this states what it implies for the document below.
>
> **ADR-020 measured that this runtime's contention is a mount-storm transient, not the sustained,
> steady-state pressure this ADR was sized for** (§1). Every one of ADR-013's 15 invariants and 4
> contracts has been re-tested against that finding, one at a time, not asserted in bulk. Full working:
> `plans/adr-013-scope-after-adr-020.md`.
>
> **Of 19 items: 2 satisfied · 6 dissolved · 4 storm-needed · 2 ambiguous · 5 Governor-deferred.**
> "Dissolved" means the invariant's *premise* — recurring contention to arbitrate — has no live case in
> this runtime, not that it is wrong forever; it revives if a real second acquisition client ever
> materializes (§10.3's own bar). The 2 ambiguous items (I-42, I-53) are not decided here — each has a
> named, unrun measurement in the scope note that would settle it either way; the 4-vs-6 storm-needed/
> ambiguous split is robust to both outcomes.
>
> **Subsystem 3.25, as specified — job model, deadlines, quality ladder, reservations, per-frame
> ordering — is not being built.** What remains genuinely needed, outside the Governor, spans four items
> (C15, C16, I-44, I-48) — none of which need it either. Triaged: C15's discipline already holds in the
> existing single-hop admission path (nothing downstream recomputes rank; no fix pending). C16 and I-44
> are one shared violation (a backend named from source identity, not from rank), in one file. I-48 is
> partially corrected already (slice B) with a real, scoped, unshipped remainder (slice B2) — not the
> uniform "four call-site fixes" a first pass suggested. Full triage, including what's currently blocked
> by unrelated uncommitted work: `project-tracker/architectural-debt.md`, DEBT-013, 2026-08-08.
>
> **UPDATE (2026-08-08, later the same day): C15, C16 and I-44 are now satisfied; I-48's remainder is
> deferred behind a stated trigger. Two qualifications travel with that, and neither is decorative:**
>
> 1. **I-44 is satisfied under AMENDED wording, not as originally written.** `isFlarexVirtualLayerId`
>    remains a conjunct in `preferSoftwareDecode` (`37ed422`); identity was *scoped*, not removed. See
>    **I-44a** in §6, added for exactly this case, with the test that distinguishes scoping from deciding.
>    Reject I-44a and this ADR does **not** satisfy I-44.
> 2. **One constant shipped unmeasured** — the `> 1` threshold in `flarexConcurrentLoaders > 1`. That ≥3
>    concurrent consumers starve is measured; that a *lone* loader is safe on hardware is not, and
>    `37ed422` newly created that case. Falsifier and resolution are pre-registered as Scope C of
>    `plans/adr-013-real-project-measurement-plan.md`.
>
> So: **complete as scoped, with one interpretation stated and one constant pending** — not "done and
> proven." The distinction is the point.
>
> **The Governor (3.26) is unaffected by the correction and is explicitly deferred to its own pass — not
> touched here.** One point of care: the closest thing this programme had to empirical support for the
> Governor's necessity — a measured preload-session eviction under playhead-priority contention, which
> would have been a real instance of the quality-tradeoff pressure the Governor exists to arbitrate — was
> **retracted** (confounded by dev-server thermal state, not reproducible; `project-tracker/
> architectural-debt.md`, DEBT-013, 2026-08-07). The Governor is therefore **unmeasured again**, exactly
> where it stood before that finding. Read the deferral as "not yet examined," not as "examined and found
> to need building" — no evidence currently distinguishes those two readings, and stating the deferral
> without this note would let it read as the latter.

---

## 0. Scope

This ADR specifies **two subsystems and nothing else**.

It does not redesign the runtime. It does not alter any ADR-012 invariant, contract, or subsystem. It
does not touch the lowering compiler, `SceneDraw`, `build-scene-draws`, the wrap-collapser, the affine
retime model, or compositor rasterization — all Tier A frozen under
`FLAREX_IMPLEMENTATION_GOVERNANCE.md` §1.

### 0.1 The four concerns this ADR separates

The addition of two subsystems is not the point. The point is that four responsibilities the runtime
currently blends become independently owned:

| Concern | Question it answers | Owner |
|---|---|---|
| **Admission** | who may consume scarce capacity? | Source Admission (ADR-012 3.10 — **unchanged**) |
| **Scheduling** | what should admitted capacity do next, and by when? | **Media Acquisition Scheduler** (3.25, new) |
| **Lifetime** | how is a session created, shared, parked, destroyed? | Decoder Manager (ADR-012 3.11 — **unchanged**) |
| **Policy** | how is quality traded against pressure? | **Performance Governor** (3.26, new) |

### 0.2 Why "media acquisition", not "decode"

Video decode is what this subsystem owns *today*. It is not what it is *about*.

The property that makes this a distinct scheduler is not the codec — it is that the work is
**asynchronous, stateful, and spans many frames**. Everything with that shape belongs here:
image streaming, EXR tile loading, audio analysis, network-backed sources, remote proxy retrieval,
AI-generated frames. Naming the subsystem after its current single job would freeze an implementation
detail into the constitution, and every one of those future sources would then need either a second
scheduler or an exception.

The scheduler must not know it is scheduling video. Its unit of work is an **acquisition job**: a
request for a source's content at a time, with a rank and a deadline. Decode is one kind.

### 0.3 The membership test — what stops this becoming a god scheduler

Generality is a liability without a boundary. "Asynchronous" is not the boundary — most of the editor
is asynchronous. The boundary is **whose deadline the work carries.**

Work is **scheduled** by this subsystem only if **all four** hold:

1. its output is **consumed as source content by a frame currently being built**;
2. it is **rankable by visible contribution** — ADR-012 §6.3's ranking function is meaningful for it;
3. it carries a **frame deadline** — missing it degrades one identifiable frame;
4. it draws on **shared acquisition capacity**.

Applied:

| Work | Verdict |
|---|---|
| video decode · image streaming · EXR tile load · remote media fetch · generated frames | **scheduled** — all four hold |
| transcription, caption generation, analysis passes | **not acquisition** — produces timeline *data*, not source content at a time. Tool work. |
| project save, asset upload, manifest transport | **not acquisition** — no frame consumes the output |
| **proxy generation, thumbnail refresh, pre-warm** | **budgeted, not scheduled** — see below |

The last row is what makes this boundary real rather than decorative. Generating a proxy consumes
decode capacity, so it must be visible to the budget — but nothing in the current frame consumes its
output, so it has no rank and no frame deadline. It fails criteria 2 and 3.

Hence **two tiers of participation**, and the distinction is load-bearing:

- **Scheduled work** — ranked, deadline-bearing, frame-consumed. The scheduler orders it.
- **Budgeted work** — holds a lease, consumes shared capacity, is preemptible by any `live` frame, and
  is **neither ranked nor deadline-bearing**. The scheduler accounts for it; it does not order it.

**Drift detection.** If a proposed job kind has no meaningful rank, that is the subsystem reporting
that the work does not belong to it. Rank is the membership predicate, and it is the one that cannot
be faked — an unrankable job forced into the scheduler must be given a fabricated rank, which is
visible in review.

---

## 1. Context

ADR-012 specifies acquisition-scheduling *policy* — ranking by visible contribution (§6.3), one
resource budget (§6.5), quality-before-coherence backpressure (§6.9), bounded stall recovery (§6.10),
aging for fairness (§6.11) — and assigns none of it to a subsystem. Part 3 defines Source Admission
(who holds a session) and Decoder Manager (session lifetime). Neither owns what admitted capacity does
next, in what order, against what deadline.

ADR-012 also names a **Performance Governor** in §6.5 and twice in Part 14 without ever specifying it.
It is the only named actor in the document with no Part 3 entry.

The runtime shows the consequences. Among `playhead` leases there is no arbitration — the fourth
arrival loses because it arrived fourth. Engine selection is a predicate on a layer id evaluated inside
a JSX prop. The decoder's frame budget is a hardcoded `24` unrelated to the user's playback-quality
setting, charged **per provider**, with nothing summing it against the frame interval. The quality
ladder has roughly ten rungs across six owners, three unrelated timeout budgets, and no ordering.

Full evidence: `FLAREX_DECODE_SCHEDULING_REVIEW.md`.

---

## 2. Decision

Add two subsystems, splitting **mechanism** from **policy** — the same split ADR-012 already applies to
the Evaluation Cache (validity) and Artifact Cache (residency).

> *Numbering note*: **3.25** and **3.26** are their slots in **ADR-012 Part 3's** subsystem list, which
> ends at 3.24. They are not sections of this document.

### 3.25 Media Acquisition Scheduler *(mechanism)*

**Owns** the ordering of asynchronous media-acquisition work: which admitted source is served next, at
what quality level, by what deadline, and what is cancelled when that deadline passes.

**In** `FrameRequest` (target time, purpose, deadline) · `AdmissionDecision` (who holds capacity) ·
`AcquisitionRequirement[]` (what each source needs, **with its rank already computed**) ·
`QualityDirective` (permitted levels).

**Out** `AcquisitionGrant[]` to the acquisition backends · `AcquisitionPressure` to the Performance
Governor.

**Lifecycle** re-planned per frame; grants may span frames. Ordering is stable under an unchanged input
set (no thrash) and damped by minimum residency.

**Fails by** missing a deadline — reported, attributed, surfaced as a degraded participant. Never by
blocking, and never by substituting content.

**Talks to** Frame Scheduler, Source Admission, Decoder Manager, Performance Governor, Resource
Manager, Diagnostics.

**Rules.**
- It never creates or destroys a session (Decoder Manager), never grants budget (Resource Manager),
  never decides *whether* a source exists (Media Manager), and never chooses a quality level (Governor).
- **It never computes rank.** It does not read visibility, reachability, opacity, contributed area, or
  the graph. Rank arrives as an input. *(I-48 — see §6.)*
- It never names a backend. It expresses a **desired capability**; mapping that onto an engine belongs
  to the acquisition backend. *(I-44.)*

### 3.26 Performance Governor *(policy)*

**Owns** the quality ladder: one ordered, declared list of degradations defined by **outcome**, and the
decision of how far down it the runtime currently is, per source.

**In** `AcquisitionPressure` · resource pressure (Resource Manager) · frame-deadline outcomes (Frame
Scheduler) · rank (Source Admission).

**Out** `QualityDirective` — the permitted level per source.

**Lifecycle** continuous; hysteretic. Degradation may be immediate and per-source. **Restoration is
collective and rendezvoused** (§4.3).

**Fails by** holding the current level and reporting that it could not decide. It has no failure mode
that changes output.

**Talks to** Media Acquisition Scheduler, Resource Manager, Presentation Barrier, Diagnostics.

**Rules.** It never allocates, acquires, evaluates, or presents. It may only ever **lower** quality;
raising is a rendezvous owned by the presentation side. Its output is advisory to the scheduler and is
**never read by the Node Evaluator** *(I-41)*.

---

## 3. Why the Governor is not merged into the scheduler

Stated explicitly because it is the merge a future contributor will propose.

A merged subsystem accretes exactly this:

```
if GPU hot        → lower resolution
if decoder misses → switch software
if contention     → proxy
if latency        → hold frame
```

Four unrelated policies, in the component that also decides ordering, with no way to see whether they
contradict each other. That is the coupling ADR-012 exists to remove, and it is how the current
ten-rung ladder came to have six owners. Mechanism and policy stay apart.

### 3.1 The hard boundary is a rate limit, not a list of verbs

A list of forbidden actions drifts, because every addition to it looks like a reasonable exception.
The boundary that holds is structural:

> **The Governor's decision rate is strictly slower than the frame rate.
> A policy that changes every frame is a schedule.**

This is mechanically testable — a conformance assertion that `QualityDirective` changes at most once
per N frames — which makes "the Governor became a second scheduler" a **failing test** rather than a
reviewer's opinion. *(I-52.)*

Two shape constraints follow, and together they make it structurally incapable of scheduling:

- **It emits a ceiling, not an instruction.** The directive states the *highest* level a source may
  use. The scheduler may use less. A subsystem that can only lower a bound cannot drive anything.
- **Its output is per-source and time-stable**, never per-frame and never per-job.

### 3.2 Decisions the Governor is explicitly forbidden from making

All of these follow from §3.1, and are enumerated so a reviewer does not have to re-derive them:

| Forbidden decision | Belongs to |
|---|---|
| which source is served next | Acquisition Scheduler (ordering) |
| which source may hold capacity | Source Admission |
| when work is cancelled or abandoned | Acquisition Scheduler |
| how much capacity exists, or its reclamation | Resource Manager |
| whether a source exists at all | Media Manager |
| when a frame is presented | Presentation Scheduler |
| what `effectiveTime` is, or who is in the degraded set | Readiness Barrier |
| which backend serves a grant | the backend (I-44) |
| **anything at all on a per-frame cadence** | by definition, a scheduler |

---

## 4. Model

### 4.1 Leases, jobs, reservations

Three mechanisms for three genuinely different lifetimes:

| Mechanism | Applies to | Lifetime | Owner |
|---|---|---|---|
| **Lease** | acquisition capacity (today: a decode session) | spans many frames | Decoder Manager, granted per Source Admission |
| **Job** | one acquisition request against leased capacity | one frame; may be missed or cancelled | **Media Acquisition Scheduler** |
| **Reservation** | capacity held for work not yet issued | one frame, or a declared window | Resource Manager (ADR-012 §6.5) |

Leases carry priority, minimum residency, aging, and **preemption with notice**. Jobs carry a rank, a
deadline, and cancellation. Reservations are covered separately in §4.4 — they are the least obvious
of the three and the one that prevents starvation.

**Rejected models.** *Pure pull* — cannot express a deadline it is willing to miss, so it blocks or
lies. *Pure push* — no backpressure, no set semantics; sources assemble on screen independently.
*Jobs without leases* — re-creates capacity per request, discarding the demux index and GOP window.
*Leases without jobs* — **this is the current architecture**: capacity granted with no ordering inside
it, which is exactly why four `playhead` leases have no arbitration.

### 4.2 Capability, not engine

A grant expresses **what is needed**, never **what to use**:

```
AcquisitionGrant {
  sourceId
  requestedTime
  desiredCapability   // e.g. random-access, sustained-sequential, tolerant-of-lag
  desiredQuality      // a level from §4.3, never a mechanism
  byDeadline
}
```

Mapping a capability onto WebCodecs hardware, WebCodecs software, a `<video>` element, a future AV1
path, a GPU decoder, or a network fetch is the **backend's** decision, made with knowledge the
scheduler must not have. Naming an engine in the grant would make the Decoder Manager unreplaceable —
and replaceability across backends is what lets the same kernel run in the browser, the worker, and a
future native host (I-37).

**The test that keeps a capability from becoming an engine name.** A capability describes the shape of
the **demand**, never a property of the **supply**:

> **Could at least two structurally different backends satisfy this capability?**
> If only one can, it is an engine name in disguise and must be rejected.

**The minimal model — three axes, and they are normative.** These are the only three that change a
*scheduling* decision; anything else belongs elsewhere:

| Axis | Values | Why the scheduler needs it |
|---|---|---|
| **access** | `random` · `sequential` | Order-of-magnitude cost difference. Derived from transport state (scrub vs play), not from the backend. |
| **latency class** | `sub-frame` · `multi-frame` · `unbounded` | Determines whether the work can be attempted within this deadline **at all**. |
| **lag tolerance** | `strict` · `tolerant` | May this source be served an older moment? (Carried on C15.) |

`latency class` is normative rather than illustrative because of a case §5.2 makes concrete: for
`unbounded` work, `byDeadline` is meaningless. A grant declaring unbounded latency is **explicitly not
expected to meet the frame deadline**, and the scheduler must not hold a frame waiting for it. Without
this axis the scheduler cannot distinguish "late" from "never going to arrive this frame."

**What is deliberately not a capability**, with its correct owner:

| Property | Not a capability because | Owner |
|---|---|---|
| resolution, bitrate, fidelity | it is *how much* is given up | quality level (Governor, §4.3) |
| alpha, colour space, channel layout | it is a **correctness** requirement, not a scheduling one | source declaration (Media Manager) |
| codec, hardware surface, decoder generation | it is a property of the supply | the backend — never leaves it |

**Achieved level is reported back.** A grant is a request. `SourceFrame` carries the level actually
delivered, not merely the level asked for — otherwise the pressure loop cannot distinguish "served at
L1" from "silently served at L3," and the Governor would be steering on its own intentions rather than
on outcomes.

**Corollary, and the concrete defect this closes**: capability selection is a function of rank and
declared need, never of source identity. The current runtime chooses software decode from
`isFlarexVirtualLayerId(layer.id)` — a decision made from *what kind of thing you are* rather than
*what is scarce right now*. That is forbidden by I-44.

### 4.3 The quality ladder — defined by outcome

The ladder is one ordered list, declared in one place, walked in order. Levels name **what is given
up**, not how:

| Level | Outcome given up | Nothing about mechanism is normative here |
|---|---|---|
| **L0** | nothing — maximum fidelity | |
| **L1** | acquisition cost reduced | *(today: software decode, session sharing)* |
| **L2** | temporal fidelity reduced | *(today: reduced fps, frame reuse)* |
| **L3** | spatial fidelity reduced | *(today: render scale, ingest proxy resolution)* |
| **L4** | the source itself is substituted by a prepared stand-in | *(today: source proxy, comp proxy)* |
| **L5** | the source defers participation — declared absent | *(today: denial; **never** substituted content)* |

The parenthesised mechanisms are **illustrative and non-normative**. They are today's mapping and they
will change; the levels will not. Freezing "hardware / software / element" into the constitution would
freeze one browser's decode stack into a document meant to outlive it.

Two ordering rules are normative:

- **Quality before coherence** (ADR-012 §6.9). Coherence sacrifice is below L5, not above L1. The
  current runtime does the opposite: `tolerateLag` sacrifices coherence *first*, as a per-layer default,
  before any quality level is tried.
- **L5 is absence, never substitution.** A deferred source produces nothing and says so. This is
  ADR-012 §0.3 and I-27; it is the one rung that must never be implemented as "show something else".

### 4.4 Reservations — why they matter most

Leases and jobs are the familiar pair; most systems stop there. This runtime cannot, because it runs
playback, scrubbing, seeking, background proxy generation, thumbnail refresh, analysis and export
**against the same scarce capacity**, and the non-interactive work is often the greediest.

A reservation is capacity **held for work not yet issued**. Its purpose is temporal: it protects the
frame that is about to be requested from the background job that is running now. Without it:

- background proxy generation acquires the session the next live frame needs;
- the live frame is denied, degrades, and reports pressure;
- the Governor lowers quality — while the background job, which caused the pressure, keeps its capacity.

That is starvation with every individual decision locally correct, and it is the same failure the
prior audits found in a different guise. Cap tuning cannot fix it, because the problem is not *how
much* capacity exists but *when* it is claimed.

Three rules:

1. Every purpose class declares a reserve; `live` frames always hold one (ADR-012 §6.5).
2. Background work (`thumbnail`, `capture`, `analysis`, proxy generation) may consume only
   **unreserved** capacity, and is preemptible by any `live` frame (§6.6).
3. A reservation is bounded and reported. An unbounded reservation is indistinguishable from a leak.

#### Over-reservation is the symmetric failure, and it is worse

Reserving *too much* for interactive work starves background work permanently. That is not merely
unfair — it is **self-defeating**, because the background work most likely to be starved is proxy
generation, which exists precisely to reduce future live pressure:

```
live reserves aggressively → proxy generation never runs → sources stay expensive
      → live pressure stays high → live reserves aggressively → …
```

Same shape as the feedback loop the audits found: the mechanism that protects playback becomes the
reason playback never improves. The governing formulation:

> **A reservation without expiry is indistinguishable from a smaller budget.**
> Permanently holding 1 of 4 sessions *is* a 3-session budget, with two extra words.

A reservation is therefore a **time-bounded claim, not a partition**. Four rules:

1. **Bounded and decaying.** A reserve is held for a declared window. Unclaimed at expiry, it is
   released — it does not roll forward.
2. **Sized from measured demand**, not from the theoretical maximum: what the last N `live` frames
   actually consumed, not what they might.
3. **Non-zero background floor.** Background capacity may be squeezed, never to zero, and it **ages**.
   ADR-012 §6.11's fairness term applies to background work, not only to sources — a class that can be
   starved indefinitely will be. *(I-51.)*
4. **Unclaimed reservation is reported as waste**, attributed to whoever reserved it. A reserve nobody
   claims is a budget cut that nobody decided to make. *(I-50.)*

### 4.5 Scheduler cost and state — coordination only

As backends accumulate (decode, cloud media, generated frames, tiled formats), the scheduler is the
one component every acquisition passes through. A coordinator on that path becomes a bottleneck the
moment its cost scales with demand, and becomes a second Resource Manager the moment it starts holding
state. Both are bounded here.

#### 4.5.1 The cost bound, and why it holds

> **The scheduler's cost is a function of admitted capacity, not of requested work.**

Source Admission emits the **ranked, admitted set**. Work beyond capacity never becomes a job — it
becomes a *denial*, produced by Admission (ADR-012 3.10). The scheduler therefore receives `O(K)`
inputs, where **K is the acquisition budget: a machine constant in the single digits**, independent of
project size, source count, node count or timeline length.

| Work | Bound | Driven by |
|---|---|---|
| ordering within the admitted set | `O(K log K)` | **frame** |
| deadline assignment, budget apportionment | `O(K)` | **frame** |
| cancelling expired work | `O(K)` | **frame** |
| requirement-set changes (graph edit, transport jump, admission change, lease grant/revoke, completion, quality directive) | `O(Δ)` | **event** |
| rank computation | not the scheduler's — incremental in Admission via dirty propagation (ADR-012 3.6) | **event** |

**The rule, in testable form: nothing bounded by project size may be frame-driven.** Per-frame ordering
is a full recompute rather than an incremental one, deliberately — recomputing a K-element ordering is
cheaper than maintaining an incremental structure over it, and a full recompute cannot drift.

**The case that threatens this bound, and why it does not break it.** A tiled source (EXR, pyramidal
image, segmented remote media) is one source but many fetches. Treating each tile as a job makes the
job count a function of resolution, and the bound is gone. It is not permitted: **granularity below the
source is the backend's decision.** The grant names a source, a region of interest and a deadline; how
many fetches that decomposes into never reaches the scheduler. This is I-44 — capability, not
mechanism — applied to quantity rather than to engine.

#### 4.5.2 The state bound

The scheduler may hold, for the admitted set only: the current job set, and per job its received rank,
its deadline, its issue time and its state; residency-damping timestamps; and `O(1)` pressure
aggregates. All bounded by K.

It may **never** hold media state (frames, handles, served times), graph state, cache state, session or
decoder state, or backend state. Where it must refer to a session it holds an opaque identifier it does
not dereference.

> **The test: the scheduler's state must be reconstructible from its inputs within one frame.**
> If losing it loses information, it is an owner, not a coordinator.

Two consequences worth stating. It distinguishes the scheduler from the Resource Manager cleanly — the
scheduler **never holds capacity**, it orders work against capacity held as leases elsewhere, and it has
no allocation authority at all. And a coordinator that can be dropped and rebuilt from its inputs is
trivially restartable, which is what Error Recovery (ADR-012 3.24) needs from it.

### 4.6 The pressure loop

Pressure flows `Resource Manager → Performance Governor → Media Acquisition Scheduler`. It **never**
flows through a present. Closing the loop through presentation is regression G7, and it is the
mechanism by which recovery becomes an amplifier.

---

## 5. Contracts

### 5.1 The four contracts

| # | Contract | From → To | Note |
|---|---|---|---|
| **C15** | `AcquisitionRequirement { sourceId, requestedTime, rank, lagTolerance }` | Source Admission → Acquisition Scheduler | **rank is computed here, never downstream** (I-48) |
| **C16** | `AcquisitionGrant { sourceId, requestedTime, desiredCapability, desiredQuality, byDeadline }` | Acquisition Scheduler → backend | names no engine (I-44); a grant is not a guarantee |
| **C17** | `QualityDirective { sourceId, permittedLevel }` | Performance Governor → Acquisition Scheduler | advisory, downward only; levels per §4.3 |
| **C18** | `AcquisitionPressure { contention, missedDeadlines, starvationAge, cancelledWork, unclaimedReserve }` | Acquisition Scheduler → Performance Governor | closes the loop **outside** presentation |

### 5.2 Validation — the contracts against work that is not decode

If C15–C18 need modification to carry a non-video acquisition, then "Media Acquisition Scheduler" is
renamed decode scheduling and §0.2 is a claim rather than a design. Two walkthroughs, neither of which
changes a contract.

#### A. A generated frame (generator node backed by a cloud model)

| Step | Content | Contract change |
|---|---|---|
| Requirement | `C15 { sourceId: gen-node, requestedTime: t, rank: <contributed area, damped — it sits behind a blur>, lagTolerance: tolerant }` | none |
| Grant | `C16 { desiredCapability: { access: random, latency: **unbounded**, lag: tolerant }, desiredQuality: L1, byDeadline: t+16ms }` | none |
| Outcome | **It misses.** Already a first-class outcome: reported, the participant enters the degraded set, and the frame presents without it at **L5 — declared absence**. Nothing is substituted. | none |
| Pressure | `C18 { missedDeadlines: 1, … }` | none |
| Arrival | Lands seconds later, publishes `SourceFrame { servedTime, handle, generation }` — the same shape a decoded frame publishes | none |

The `unbounded` latency class is what makes this correct rather than pathological: it tells the
scheduler *not to hold the frame*, and it tells the Readiness Barrier that this participant's absence
is expected rather than a stall. Quality maps without invention — L1 is fewer steps or a smaller
model, exactly as it is software decode for video.

#### B. Remote / cloud-hosted media (network fetch, then decode)

Two stages, composed **inside the backend**; the scheduler sees one job with a `multi-frame` latency
class. The lease is a connection or range-request session rather than a decoder session — the lease
abstraction is indifferent. The ladder maps directly: **L1** a lower-bitrate rendition · **L3** a
smaller resolution · **L4** the cached local proxy · **L5** defer.

This case is the sharpest test of **I-49**: cancelling an expired range request must free
**bandwidth**, not merely discard the bytes when they arrive. A cancellation that only marks a result
unwanted leaves the scarce resource occupied, which is the same defect as carrying stale decode work
across a transport jump.

#### What the exercise established, and what it forced

Contracts hold unmodified. Two consequences were promoted from example to normative as a result:

1. **`latency class` is a required capability axis** (§4.2). Without it, `byDeadline` is uninterpretable
   for unbounded work and the scheduler cannot distinguish *late* from *not arriving this frame*.
2. **Acquisition capacity is multi-dimensional.** Decode sessions, inference slots and network
   connections are distinct pools that do not substitute for one another. ADR-012 §6.5's single budget
   already spans several dimensions ("GPU memory, decode sessions and CPU rasters"), so this is
   consistent — but it is stated explicitly here because a scalar implementation would look correct
   until the second acquisition kind arrives.

---

## 6. Invariants

Added to ADR-012 Part 12. Total becomes **54**.

- **I-40** Acquisition ordering is a function of rank, deadline and residency — never of arrival order, component mount order, or source identity.
- **I-41** No adaptive acquisition decision is observable by the Node Evaluator. Evaluation reads the `EvaluationContext` and nothing else. *(This is what preserves I-18 and ADR-007 parity under adaptive acquisition.)*
- **I-42** Every adaptive decision is resolved **before** evaluation begins and enters as part of the `EvaluationContext`. The context is recordable and replayable (supports I-37).
- **I-43** There is exactly one acquisition budget for a frame, derived from that frame's deadline. Per-provider budgets that do not sum to it are forbidden.
- **I-44** A grant expresses a desired capability and quality, never a backend. Capability selection is a function of rank and declared need, never of source identity. **(AMENDED 2026-08-08 — see I-44a.)**
- **I-44a** *(amendment to I-44, 2026-08-08)* **Source identity may SCOPE a capability rule; it may never DECIDE the capability.** A predicate that selects *which sources a rule governs* is not a backend decision. A predicate that selects *which backend a governed source receives* is, and remains forbidden. The test: hold identity fixed and vary the declared need — if the chosen backend changes, identity is scoping, which is permitted. If the backend is fixed the moment identity is known, identity is deciding, which I-44 forbids. **Reasoning:** I-44 as originally written admits no way to express "this rule applies to class X," yet every capability rule must have a domain, and a domain is necessarily expressed in terms of what a source *is*. Read literally, I-44 forbids not just identity-driven backends but *any scoped capability rule at all* — which was never its intent; §4.2's own worked example objects specifically to choosing *from* "what kind of thing you are" rather than *what is scarce right now*. This amendment states the boundary that §4.2's reasoning already implies. **Registered against a live case, not in the abstract:** `preferSoftwareDecode` (`VideoPreview.tsx`, commit `37ed422`) retains `isFlarexVirtualLayerId(layer.id)` as a conjunct alongside `flarexConcurrentLoaders > 1`. Under the test above it passes: with identity held fixed (a virtual loader), the backend still varies with contention — hardware when alone, software when contending. Identity scopes; contention decides. It would have failed the test before `37ed422`, when identity alone fixed the backend.
- **I-45** The quality ladder is declared in one place, ordered, and defined by outcome rather than mechanism. Coherence sacrifice is its last rung; L5 is declared absence, never substitution.
- **I-46** Quality restoration is collective: no source raises its level until every participant can.
- **I-47** Pressure never flows through presentation. No present may cause an allocation, a reclamation, or a quality change.
- **I-48** The Acquisition Scheduler never computes rank. It does not read visibility, reachability, opacity, contributed area, or the graph. Rank is an input, computed by Source Admission.
- **I-49** All acquisition work is cancellable, and **no job whose deadline has expired may consume future frame budget**. Work abandoned by a transport jump is cancelled, not carried.

- **I-50** Every reservation is bounded in time and released if unclaimed at expiry. Unclaimed reservation is reported and attributed as waste. A reservation that never expires is a budget reduction, and must be represented as one.
- **I-51** No purpose class may be starved indefinitely. Background acquisition capacity has a non-zero floor and ages; ADR-012 §6.11's fairness term applies to purpose classes, not only to sources.
- **I-52** The Performance Governor's directive changes at a rate strictly slower than the frame rate. Any policy decision made on a per-frame cadence is a scheduling decision and does not belong to the Governor.

**On I-48**: stated separately from I-40 because the failure it prevents is gradual. Ordering that is
*derived* from rank is correct; ordering that *recomputes* rank drifts, because a scheduler that can
see the graph will eventually be asked to make one small visibility judgement, and then another. Rank
lives in one place or it lives in two.

- **I-53** The Acquisition Scheduler is **coordination-only**. It owns ordering and deadlines. It never owns media state, graph state, cache state, session or backend state, and it never holds capacity. Its state must be reconstructible from its inputs within one frame; state that cannot be is owned state, and belongs to another subsystem.
- **I-54** Scheduler cost is a function of admitted capacity, not of requested work. Per-frame work is bounded by the acquisition budget; any work bounded by project size is event-driven. Granularity below the source (tiles, segments, chunks) is the backend's and never enters the job set.

**On I-53 and I-54**: these bound the two ways a coordinator on the hot path degenerates. I-53 is the
ownership bound — a scheduler that accumulates state becomes a second Resource Manager, and the
reconstructibility test detects it without anyone having to judge intent. I-54 is the cost bound, and
it holds only because Source Admission converts excess demand into denials before the scheduler sees
it: demand-side growth lands on Admission, which is incremental by construction, not on the scheduler.

**On I-51 and I-52**: both close holes found in pressure-test, and both are failures of *symmetry*.
I-51 exists because the reservation that protects playback is also the one that can starve the proxy
generation which would have made playback cheap — protection without a floor inverts into the harm it
prevents. I-52 exists because "policy" and "schedule" are not distinguished by their content but by
their **cadence**: the same decision made once a second is policy and made once a frame is a schedule,
so the rate is the boundary and it is the only one that can be tested mechanically.

**On I-49**: the runtime today carries stale work across transport jumps — a seek issued before a jump
completes after it, spending budget on a frame nobody will see, while the frame that *is* wanted waits
behind it. Expiry must free capacity, not merely mark a result unwanted.

---

## 7. Consequences

**Positive.** The four-competing-sources case gains an answer derived from the picture rather than
arrival order. The frame budget acquires an owner and stops being a constant. The ten-rung ladder
becomes one ordered list defined by outcome, so adding a future backend adds a mechanism rather than a
rung. Permanent condemnations (`wcBailedSources`-style) become levels with aging and recovery.
Reservations stop background work from consuming interactive capacity. Evaluation stays deterministic,
provably, because I-41/I-42 name the boundary.

**Negative.** Two more subsystems; the migration grows. Ranking introduces a policy surface needing
tuning, and a wrong ranking starves a visible source — which is why I-40 requires aging and ADR-012
§6.11 already mandates it. Capability-based grants add one indirection between scheduler and backend;
that indirection is what buys backend replaceability, and it is deliberate.

**Preserved.** Nothing in ADR-012 changes. The existing pool's lease layer — priorities, preemption
with notice, session sharing, warm parking — is good work and is retained as the lease mechanism. What
is added is the job layer above it, the reservation discipline beside it, and the policy layer that
was previously spread across six components.

---

## 8. Alternatives considered

- **Name it the Decode Scheduler.** Rejected per §0.2: the defining property is asynchrony spanning
  frames, not the codec. Naming it for video would force every future source kind into an exception.
- **Fold acquisition scheduling into the Evaluation Scheduler.** Rejected: different time base.
  Evaluation completes within a frame; a seek on sparse-GOP 4K media is documented in this repo at
  1–3 seconds. Work spanning ~90 frames cannot be scheduled by a scheduler budgeted for one.
- **Fold it into Source Admission.** Rejected: admission is bin-packing over capacity, scheduling is a
  deadline problem over requests. Merging them is what `reserveSession` does today, and it is why
  playhead leases have no arbitration.
- **Fold policy into the scheduler.** Rejected — see §3.
- **Let the grant name an engine.** Rejected: it makes the backend unreplaceable and re-encodes today's
  browser decode stack as architecture.
- **Define the ladder by mechanism.** Rejected: freezes implementation detail into a constitutional
  document. Outcomes are stable; mechanisms are not.
- **Add a GPU Scheduler.** Rejected, consistent with the prior ownership review: WebGL/WebGPU expose no
  queue submission or preemption. GPU *memory* is a Resource Manager budget and is real.
- **Do nothing; tune the caps.** Rejected on this repo's own record: every cap fix redistributed
  scarcity rather than resolving it (`MAX_WC_SESSIONS` → `MAX_WC_SOFTWARE_SESSIONS` →
  `MAX_WC_TOTAL_SESSIONS` → `HARDWARE_RESERVED_SLOTS`), and the pool's own header records the
  diagnosis: *two caps that merely sum are not a budget.*

---

## 9. Open questions

1. **Rank function weights.** ADR-012 §6.3 names the inputs (reachability, contributed area, opacity/blend, disabled branches) but not their relative weight. Needs measurement; should be configuration before it is architecture.
2. **Lag tolerance derivation.** "A declared property of a source's role in the frame" is the right shape; the exact derivation from the graph is unspecified and should be validated against real comps before freezing.
3. **Level ordering for substitution.** L4 (prepared stand-in) sits below L3 (spatial) on the assumption that a proxy costs more fidelity than a downscale. Needs measurement on the integrated-GPU target — a comp proxy may be cheaper *and* sharper than a heavily downscaled live evaluation.
4. **Governor hysteresis constants.** Deliberately unfixed, for the same reason ADR-012 leaves the playback lag budget unfixed.
5. **Reservation granularity.** Whether a reserve is per-purpose-class or per-source. Per-class is simpler and probably sufficient; per-source is more precise and more to get wrong.
6. **Reservation window and background floor** (I-50, I-51). Both magnitudes need measurement: too short a window and the reserve never protects anything, too long and it becomes the partition §4.4 forbids. The floor has the same shape. Configuration until proven.
7. **Acquisition budget K in practice** (I-54). K is a machine constant, but its *value* is not fixed here: it is currently 4 concurrent sessions on the integrated-GPU target and will differ per host and per acquisition dimension. The bound is architectural; the number is configuration.
8. **Governor cadence bound** (I-52). The *principle* — strictly slower than frame rate — is normative; the multiple is not. It must be slow enough that a directive change is never mistaken for a per-frame response, and fast enough to react to sustained pressure within a user-noticeable interval.

---

## 10. Longevity — this abstraction is deliberately acquisition-specific

A reasonable reader will ask whether the Media Acquisition Scheduler is the final abstraction, or the
first client of a general **Asynchronous Work Scheduler** the runtime will eventually want. The
question is answered here so that a future contributor does not have to guess at intent.

**It is deliberately acquisition-specific. Generalization is out of scope, and doing it now would be
a mistake with a specific, identifiable cost.**

### 10.1 The honest split: the mechanism is general, the boundary is not

| Would generalize cleanly | Is irreducibly acquisition-specific |
|---|---|
| leases · jobs · reservations (§4.1) | **rank as visible contribution** — reachability, contributed area, opacity |
| deadlines, cancellation, expiry (I-49) | the **quality ladder** (§4.3), defined in fidelity outcomes |
| aging, hysteresis, minimum residency | results carrying **`servedTime`** and joining a readiness barrier |
| the coordinator bounds (I-53, I-54) | **L5 as declared absence**, a compositing semantic |

So a future generalization would extract the *mechanism* and leave the *policy surface* behind. That
is a refactor with a known shape — not a redesign — which is exactly the kind of change that should be
driven by a second real client rather than by anticipation.

### 10.2 Why generalizing now would be actively harmful

Not merely premature — **structurally destructive**, and in one specific way.

§0.3's membership test holds because **rank means something**: visible contribution, computed by Source
Admission from the graph. A general scheduler must accept an opaque priority number from arbitrary
clients. The moment rank is opaque:

- **I-48 becomes vacuous.** "Never computes rank" is trivially satisfied by a scheduler that could not
  compute it anyway, so it stops constraining anything.
- **§0.3 dissolves.** Criterion 2 — "rankable by visible contribution" — degrades to "has a number
  attached", which every asynchronous task in the editor satisfies.
- **I-54's bound is lost.** The `O(K)` cost holds because Source Admission converts excess demand into
  denials before the scheduler sees it. A general scheduler has no Admission upstream and must rank its
  own queue, which is precisely `O(demand)`.

In other words, generalizing today would trade the three properties this ADR was hardened to
guarantee for a reuse that has no second client. **The specificity is not an accident of the first
implementation; it is what makes the boundaries mechanically testable.**

### 10.3 The trigger for revisiting

Generalization requires **a separate ADR**, justified by **demonstrated duplication**, never by
anticipation. The bar:

> **Two independent subsystems, each needing deadline-ordered work over scarce capacity, where the
> duplication is in the mechanism — leases, jobs, reservations, cancellation, aging — and not merely in
> the vocabulary.**

And the corresponding rule for whatever is extracted: the general scheduler takes an **opaque
priority**, and each client keeps its own ranking, ladder and result semantics. Anything a client can
push into the shared layer that is not mechanism is drift.

**What is NOT a second client**, because this is the mistake most likely to be made: `export`,
`thumbnail`, `capture` and `analysis` frames are **purposes**, not clients (ADR-012 §6.1). They already
route through this scheduler with different deadlines and scopes. Purpose diversity is evidence the
current abstraction is working, not evidence it needs generalizing.

**The plausible second client, named.** §0.3 excludes transcription and analysis passes as "not
acquisition" — and those are exactly the work that would prove the general case. Today they need no
scheduler: no rank, no frame deadline, no contention with acquisition capacity. If any of them
acquires a deadline — live analysis during playback is the obvious candidate — that is the signal to
open the question, and the evidence to open it with.

Until then: **one client, one scheduler, and a boundary that means something.**

---

*This ADR extends ADR-012 and is governed by the same handbook. It adds subsystems 3.25–3.26,
contracts C15–C18 and invariants I-40…I-54, and changes nothing else.*
