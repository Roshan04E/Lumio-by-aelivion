# Scope note — ADR-013's invariants and contracts, read against what ADR-020's slices actually built

- Status: note, not a plan. No code, no runs. Governor (subsystem 3.26, I-45/I-46/I-52, C17/C18) is
  explicitly **out of scope** — it is untouched by ADR-020's premise correction and gets its own pass.
- Basis: `project-tracker/adr/013-media-acquisition-scheduling.md` (definitions), `project-tracker/adr/
  020-acquisition-premise-correction.md` (premise correction, §6 "what does not change"), and this
  session's actual delivered work — slice A (§6.11 recovery / starvation reporting, `2a73d05` and the
  real-denial follow-up), slice E (release-path eligibility grant, closes OQ11), slice D and slice F
  (both rejected — see `project-tracker/architectural-debt.md`, DEBT-013, 2026-08-07).
  **CORRECTED 2026-08-08:** slice B (F2, virtual-source contribution) **shipped**, partially, at `38b9c73`
  (pre-repair hash `cd6fdf8`) — cross-host/cross-comp discrimination. The earlier version of this note
  said "proposed and unimplemented," sourced from a stale DEBT-012 paragraph never checked against git
  log. The unshipped remainder (within-comp/sibling discrimination) is renamed **slice B2** to stop the
  collision — see `project-tracker/architectural-debt.md`, DEBT-012, 2026-08-08.

## ADR-013 status ledger

Three entries, appended and never rewritten. Each names the evidence that moved it, so a reader can see
which claim rests on which measurement instead of only the current verdict. **The trajectory is the
record**: entries 1 and 2 are marked superseded in place below, not removed.

| # | Date | Status | What moved it |
|---|---|---|---|
| 1 | 2026-08-08 | **complete as scoped** | The 19-item tally below — 5 satisfied · 6 dissolved · 1 deferred by trigger · 2 deliberately unmeasured · 5 Governor-deferred. Carried one unmeasured constant (the `> 1` threshold) with a falsifier pre-registered against it. `023c605`, `fb435f1`. |
| 2 | 2026-08-08 | **REOPENED — "complete as scoped" WITHDRAWN** | The real-project measurement, 3 cold arms at `14b66dc`. Scope C falsified 3/3: off a clean baseline (`capMisses 0`, `starvedSources 0` at t≈76.78), the lone-loader regime showed `F1_capMissOnset = 2` and `F4_starvedOnset = 1` with `activeSoftware = 0` throughout. Read as `37ed422` having **created** the starvation; C16/I-44 satisfaction withdrawn, I-44 returned to unsatisfied. `54bcd0e`. |
| 3 | 2026-08-08 | **complete as scoped — entry 2's PREMISE is FALSIFIED** | The counterfactual arm entry 2 itself pre-registered: same fixture at the old `> 0`, 3 cold arms, vacuity guard passed 3/3 (`activeSoftwareInRegime = [1]`). It reproduces the same signature — `capMisses` 1/0/1 against 2/2/2, and the host clip on `element` in **6 of 6 runs across both conditions**. `37ed422` amplifies a pre-existing defect; it does not create one. Decision: **KEEP `> 1`**, not reverted. `e448b0d`. |

**What entry 3 restores, and what it does not.** It restores C16/I-44 to satisfied-under-I-44a and returns
the document to *complete as scoped* — the same words as entry 1, reached the other way round, and now
with the constant's cost **measured** (about one additional cap miss, more consistently, in a three-host
project) rather than unmeasured. It does **not** restore entry 1's confidence. The pre-registered
falsifier fired and its counters stand as taken; what the counterfactual overturned is the **attribution**,
not the reading. A status that travelled complete → reopened → complete is not the same artifact as one
that was never disturbed, and this ledger exists so it cannot be read as one.

**Why entry 2 stays.** Its measurement is correct; only its causal claim is overturned, and it was
overturned by an arm entry 2 pre-registered before knowing the answer. Deleting it would erase the
evidence that the process caught its own error, and would leave entry 3 asserting a conclusion with no
visible reason it had ever been in doubt.

**What the reopening left genuinely open — NOT closed by entry 3:** Scope A's junction claim is **VOID**
(`active = 0` across the predicted window, so WebCodecs never engaged and the junction was never tested);
Scope B is weakly supported and **I-48 / slice B2 is NOT dissolved on it**; the host clip on `element` 6/6
is registered as **DEBT-014, PARKED** with named blockers and a trigger; and the ~19× run-to-run spread in
how long Host A's siblings held WebCodecs is an open question rather than noise.

ADR-020 itself asserts "all fifteen invariants stand" and "all four contracts stand" — true as a
statement that nothing is invalidated forever. This note asks a narrower, more current question: of the
work actually shipped since, what does each item's status read as **today**, on this runtime, given
everything learned through slice F's rejection. "Dissolved" below means the invariant's premise — not its
truth — has no live case in this runtime per ADR-020 §1's finding (contention is a mount-storm transient,
not steady-state pressure), not that the invariant is void forever.

A "satisfied" verdict below is held to the same standard the rest of this programme was: a structural
guarantee (a negative constraint with no code path that could violate it) counts; a mechanism that merely
hasn't been observed failing yet does not — that is exactly the shape of vacuous pass DEBT-012 and slice
D's void ruling exist to catch, and this note does not repeat it.

---

## Contracts

| ID | Verdict | Why |
|---|---|---|
| **C15** | **Satisfied (2026-08-08)** | `AcquisitionRequirement{rank computed upstream}` reads as: rank must never be computed downstream of where it enters. `preview-frame-pool.ts` already receives `contribution`/`priority` only as `AcquireOptions` fields and never computes them itself — structurally true, no Scheduler needed to hold it. |
| **C16** | **Satisfied (2026-08-08, `37ed422`)** | Was: the pool's `preferSoftwareDecode` named a backend from `isFlarexVirtualLayerId(layer.id)` (source identity) — the exact I-44 violation ADR-013 §4.2 names. Fixed in `VideoPreview.tsx`: gated on `flarexConcurrentLoaders > 1`, a declared-need signal read from actual decode contention, not from what kind of layer this is. One fix with I-44 (same site, same commit). |
| **C17** | Still needed | Governor-owned endpoint (`QualityDirective`, Governor→Scheduler). Deferred to the Governor's own pass. |
| **C18** | Still needed | Governor-owned endpoint (`AcquisitionPressure`, Scheduler→Governor). Deferred to the Governor's own pass. |

## Invariants

| ID | Verdict | Why |
|---|---|---|
| **I-40** | **Dissolved** | Its operative case — repeated, rank-ordered reordering under contention — has nothing to apply to (0 post-mount admission decisions across 30s, ADR-020 §1). The one new post-mount admission path this programme built, slice E's release-path grant, iterates `deniedWaiters` in insertion order, not rank — it doesn't satisfy I-40 either; there's simply no live reordering event for the invariant to govern. |
| **I-41** | **Satisfied** | Structural, not vacuous: the recovery/re-acquire mechanism (slice D/E) has no code path into `EvaluationContext` or node evaluation — it lives entirely in the playback/pool layer. A negative constraint with no path to violate it is a legitimate satisfaction, not an untested one. |
| **I-42** | Still needed | No adaptive decision is threaded into evaluation as an input at all — the clause has no subject yet. |
| **I-43** | **Dissolved** | Its stated form — one budget *per frame*, derived from *that frame's deadline* — presupposes per-frame contention to plan against. None exists (ADR-020 §1). The budget that does exist is a flat constant (K=4), which is I-54's shape, not I-43's. |
| **I-44** | **Satisfied under AMENDED wording (I-44a), NOT literally** | Was: `preferSoftwareDecode` selected a backend from source identity — the named example in ADR-013 §4.2. Fixed in `VideoPreview.tsx` (the actual decision site — `WebglMediaLayer.tsx` only consumes the value; a grep hit is not a call site). **Stated plainly: `isFlarexVirtualLayerId(layer.id)` is still a conjunct in the condition.** Identity was not removed; a contention term (`flarexConcurrentLoaders > 1`) was added beside it. Under I-44 as *originally written* ("never of source identity") that is **not** satisfied. It is satisfied under **I-44a** (ADR-013 §6, added 2026-08-08), which distinguishes identity *scoping* a rule from identity *deciding* a backend. The amendment was written because the literal reading forbids any scoped capability rule at all, which was never §4.2's intent — but it IS an invariant reinterpreted to fit shipped code, so it is recorded as an amendment with its test, not applied silently. One fix with C16. |
| **I-45** | Still needed | Governor-owned (§3.26, "owns the quality ladder"). Deferred. |
| **I-46** | Still needed | Governor-owned (§3.26, "restoration is collective and rendezvoused"). Deferred. |
| **I-47** | **Satisfied** | Structural: recovery is pool-internal (idle-sweep tick, release-path grant) and has no code path through a present. Same basis as I-41 — no pressure *loop* exists yet for the rule to be tested against, but nothing built has a route through presentation either. |
| **I-48** | **Partially satisfied; remainder DEFERRED, not scheduled** | slice B shipped (`38b9c73`) and fixed the cross-host case — a virtual layer inherits its host's real transform instead of a fabricated identity one. Still defeated in substance for the within-comp case: siblings on one host still score identically. That remainder (**slice B2**) needs a per-node contribution channel `TimelineLayer` doesn't have today — real, unscoped design work for a defect nobody has shown causes harm (ADR-020's own shape). Not designed here. **Trigger:** the large real-project measurement (see below) — if it shows sibling virtual layers on one host actually contending, B2 gets scoped from that finding; if not, B2 dissolves like I-49/I-50/I-54. |
| **I-49** | Still needed | No job/deadline/cancellation model exists in the admission path. The re-acquire mechanism happens not to carry stale work forward (`noteDenied` resets `eligible` on every re-denial, verified this session) — a property of the current code's shape, not an implementation of I-49's apparatus. |
| **I-50** | Still needed | No reservation mechanism exists. OQ10/OQ11's findings concern the idle-sweep and the release-grant, neither of which is a reservation. |
| **I-51** | **Dissolved** | Matches ADR-020 §3's own OQ5 disposition exactly: this runtime has one purpose class (`live`) through the decode pool, so the purpose-class fairness clause — I-51's actual incremental content over baseline §6.11 — has nothing to apply to. (Source-level fairness, which I-51 references but does not newly require, is ADR-012 §6.11's, and is what slice A addressed.) |
| **I-52** | Still needed | Governor-owned, explicitly named. Deferred. |
| **I-53** | Still needed | No Scheduler subsystem exists. The existing admission path (Source Admission + Decoder Manager, ADR-012, unchanged) is not the thing this invariant is written against. |
| **I-54** | Still needed, honored in spirit by adjacent work | No Scheduler exists in letter. But slice E's release-path grant scan was verified `O(waiters)`, not `O(demand)` (R1: `releaseScanWaiters / releases = 3.0 waiters/release`) — the cost discipline I-54 asks for is already a habit in the one adjacent mechanism that exists, even though its literal subject doesn't. |

## Counts

**19 total. 2 satisfied · 3 dissolved · 14 still needed.**

Of the 14 "still needed": 5 are Governor-owned and were not independently analyzed here (I-45, I-46,
I-52, C17, C18) — deferred whole, per scope. Of the remaining 9, **one correction (2026-08-08): I-48 is
partially attributable to slice B**, which shipped (`38b9c73`), not unimplemented as first stated here —
see the corrected I-48 row above. The other 8 are unaffected by this correction.

**This first-pass count is superseded — see the final tally at the end of the 2026-08-08 Amendment below.**
C15, C16, and I-44 moved to Satisfied the same day (C15 structurally, C16/I-44 by `37ed422`); this section
is kept as a record of what the first pass actually said, not corrected in place.

---

## What is actually left of the Media Acquisition Scheduler

Nothing that ADR-013 specified as the Scheduler was built, and none of what was built needed to become
it. Zero of the four contracts exist as message types between two subsystems, because subsystem 3.25 was
never created — there is no job model, no deadline field, no quality ladder, no reservation, no rank
computed anywhere but where it already was. What shipped is three corrections, all inside the pre-existing
admission path (`preview-frame-pool.ts` / Source Admission), none of them requiring a scheduler to make:
slice A made starvation an observable, truthful state instead of a silent one; slice E synchronized
eligibility-granting with the moment capacity actually frees, closing a real observation gap (OQ11); slice
D and F, which tried to make the re-ask trigger itself fire more reliably, were rejected on direct evidence
that firing rate was never the problem — eligibility and transport boundaries simply don't reliably
coincide (mechanism B), and no amount of clock-driven polling changes that. Two of the fifteen invariants
are structurally satisfied by the shape of what was built (I-41, I-47 — recovery never touches evaluation
or presentation), three are dissolved because their premise has no case in a runtime whose only contention
is a mount-storm transient (I-40, I-43, I-51), and the rest are exactly where they were before this
programme started, waiting on a subsystem that has not been shown to be needed yet.

It has become three fixes to the existing admission path, and that is a legitimate, probably good outcome.
ADR-013 was sized for a runtime under sustained contention that arbitrates an ongoing competition; ADR-020
measured that this runtime doesn't have one. Building the Scheduler now would mean building ranking,
deadlines, a quality ladder and a reservation discipline to arbitrate a competition that occurs once, at
mount, and is over before the first frame presents — machinery sized for a problem this codebase does not
currently have, in service of a defect (a denied source waits forever) that a narrow, in-path fix already
addresses better than a scheduler would. The residual work — DEBT-013 still parked, the eligibility/
boundary coincidence gap, comp-proxy waiter identity — is exactly the same shape: two more targeted fixes
to the admission path, not scheduler work. If ADR-013's Scheduler is ever justified, it will be by §10.3's
own bar (a second real client demonstrating duplicated mechanism), not by finishing this defect.

---

## Amendment (2026-08-08) — the "still needed" count above was conservative; re-tested against ADR-020's
own dissolution grounds

The paragraph above and the count in §Counts say "14 still needed" while also concluding "three fixes."
Those don't fully square: nine of the fourteen are non-Governor and, on the original pass, were left as
undifferentiated "still needed" without asking whether they individually presuppose sustained contention —
the same question that dissolved I-40, I-43 and I-51. Applying it properly, one line each, to the nine:

**Is this needed to handle the mount storm (a bounded, one-time transient), or does it presuppose a
steady state ADR-020 measured does not occur?**

| ID | Verdict | Why |
|---|---|---|
| **C15** | **Storm-needed** | The mount storm is itself a real ranked admission decision (6 sources, 4 slots). "Rank computed upstream, never by the scheduler" governs *who is allowed to compute rank*, which matters for one ranked decision exactly as much as for a continuous stream of them. |
| **C16** | **Storm-needed** | "Capability not backend" is about the shape of a single grant's output. One mount-time admission still needs to express *what* is needed without naming an engine — repetition isn't what makes this matter. |
| **I-44** | **Storm-needed, and live** | The violation (`preferSoftwareDecode` / `isFlarexVirtualLayerId` naming a backend from source identity) happens at the one-time acquire call already. The mount storm alone is sufficient grounds — no steady state required for this to be a real, present defect. |
| **I-48** | **Storm-needed** | Verdict unchanged by the 2026-08-08 correction below; only the description narrows. The remaining live violation (within-comp/sibling discrimination, slice B2, unimplemented — slice B itself shipped, `38b9c73`) occurs whenever the graph is ranked at all — at mount or on a graph edit — not only under sustained contention. |
| **I-49** | **Dissolves** | Its own worked example — stale work carried across a transport jump — is exactly the scrub/seek scenario ADR-020 measured directly (115 samples, `capMisses` +0). No contention exists there for cancellation-vs-carrying to matter, and no job model exists yet to carry anything in the first place. |
| **I-50** | **Dissolves** | Same grounds ADR-020 itself already used for OQ5/OQ6: a reservation protects a live frame from a background acquirer claiming capacity *later*. OQ5's own disposition states this pool has one purpose class today and background work never touches it — nothing to protect a live frame from. |
| **I-54** | **Dissolves** | Its bound is specifically a *per-frame* cost bound, guarding a coordinator that runs every frame against demand scaling with project size. ADR-020 measured 0 admission decisions across 30s of scripted transport — nothing is running per-frame for this to bound. |
| **I-53** | **Ambiguous** | Coordination-only / no-owned-state is a scope-creep guard that applies to any coordinator regardless of how often it decides — the storm/steady-state axis doesn't reach it. **What would decide it:** read `preview-frame-pool.ts`'s actual module-level state (`activeSessions`, `deniedWaiters`, the idle pool, …) against the reconstructible-in-one-frame test. Not run here. |
| **I-42** | **Ambiguous, on different grounds** | It presupposes admission/quality decisions feed into graph evaluation at all. Per I-41 (satisfied — no such path exists), they currently don't, which isn't a contention-duration question. **What would decide it:** whether any planned quality-substitution behavior (an L4 stand-in, say) would ever need visibility to the Node Evaluator for determinism/replay. Not run here. |

**Of the nine: 4 storm-needed, 3 dissolve, 2 ambiguous.**

**Revised total, 19 items:** 2 satisfied · **6 dissolved** (I-40, I-43, I-51 + I-49, I-50, I-54) ·
4 storm-needed · 2 ambiguous · 5 Governor-deferred (unchanged, out of scope). A third of the entire
ADR-013 apparatus dissolves on the same grounds ADR-020 already used for its first three, not a
handpicked few — and every one of the four items that clearly survives is satisfiable by disciplining the
*single existing mount-time admission call* (stop it naming a backend, fix one fabricated rank input,
shape its inputs/outputs to match C15/C16), not by building a job queue, a deadline field, a quality
ladder, or a reservation system. Even in the worst case — both ambiguous items resolve to "steady-state
needed" — that is six non-Governor items, still all satisfiable as targeted fixes to one call site.

**Re-answered: it is a set of fixes, more clearly than the first pass said, and the first pass was
conservative.** Not "probably three" — closer to four or six, none of them requiring anything a scheduler
subsystem would supply. The dissolution test, applied consistently rather than to only the three items
ADR-020 happened to name, doesn't leave room for one. This is a smaller answer than §"What is actually
left" above gives, and it is the more correct one.

---

## Second amendment (2026-08-08) — the four storm-needed items resolved; this is the current tally

The table above (2026-08-08, first pass) classified C15, C16, I-44, I-48 as storm-needed and stopped
there. Same day, all four were actually resolved:

| ID | What happened |
|---|---|
| **C15** | **Satisfied.** `preview-frame-pool.ts` already receives rank as an `AcquireOptions` field and never computes it — the storm-needed classification was correct that the constraint matters at mount, but the constraint was already held. No code changed. |
| **C16 + I-44** | **Satisfied, one fix (`37ed422`).** `preferSoftwareDecode` picked a backend from `isFlarexVirtualLayerId(layer.id)` (source identity, forbidden by I-44) at `VideoPreview.tsx` — not `WebglMediaLayer.tsx`, which only consumes the value; that location error is corrected in `project-tracker/architectural-debt.md`, DEBT-013. Fixed by gating on `flarexConcurrentLoaders > 1`, a contention count, not an identity check. Unmeasured as a behavioral change (see the commit message); the real-project measurement below will exercise it. |
| **I-48** | **Partially satisfied (slice B, already shipped); remainder DEFERRED, not scheduled.** Slice B2 is real design work for a defect nobody has shown causes harm — ADR-020's own shape for something that doesn't get built speculatively. Given a trigger (see the row above and the measurement plan), not a slot on a roadmap. |

**Final tally, 19 items: 5 satisfied** (I-41, I-47, C15, C16, I-44) **· 6 dissolved** (I-40, I-43, I-51,
I-49, I-50, I-54) **· 1 deferred by trigger** (I-48) **· 2 ambiguous, deliberately unmeasured** (I-42,
I-53) **· 5 Governor-deferred, out of scope** (I-45, I-46, I-52, C17, C18). `5+6+1+2+5 = 19`.

(The interim "4 satisfied" figure quoted in conversation the same day undercounted by one — the arithmetic
above is what the table actually supports, checked by addition rather than carried forward from what was
said. Same discipline this note exists to enforce elsewhere.)

## ADR-013 REOPENS (2026-08-08) — "complete as scoped" is WITHDRAWN

> **STATUS ENTRY 2 — SUPERSEDED by entry 3 (see the ledger at the top). Retained in full, deliberately.**
> The readings below are correct and stand as taken. The **attribution** is what was overturned: the
> counterfactual arm this section pre-registered showed the same starvation signature at the old
> threshold, so `37ed422` amplifies a pre-existing defect rather than creating one, and the withdrawal of
> C16/I-44 does not survive. The resolution is recorded inline below, from "RESOLVED by the
> counterfactual".

The real-project measurement ran (3 cold arms, `14b66dc`, plan §5). **Scope C is FALSIFIED, 3/3.** The
`> 1` threshold that `37ed422` shipped — the fix on which C16 and I-44's satisfaction rested — is not
safe in the case it newly created.

**Everything below marked "satisfied" for C16/I-44 is withdrawn pending a fix.** The status of ADR-013 is
**reopened**, not complete.

> **Amended by entry 3.** That withdrawal is **rescinded** — it rested on `37ed422` being the cause, and
> the counterfactual removed that premise. C16/I-44 are satisfied-under-I-44a again. ADR-013's status is
> **complete as scoped** for the third and current time. The sentence above is kept because it is what
> was believed on the evidence available at the time it was written.

**L11 held.** An ADR is a hypothesis until a measurement it could have failed has survived it. This one
could have failed and did. That is the process working exactly as intended — not a setback, and not to be
softened in the retelling. The alternative was shipping the same change with the same confidence and no
measurement, which is what the programme existed to stop.

**The readings** (identical across all three arms; raw data `tmp/adr013-real-project/cold{1,2,3}.json`):
baseline immediately before Host C's regime was clean (`capMisses 0`, `starvedSources 0` at t≈76.78), then
within the `== 1` regime `F1_capMissOnset = 2` and `F4_starvedOnset = 1`, with `activeSoftware = 0`
throughout — i.e. the lone loader did take hardware, as designed, and something starved as a result.

**And the sharper consequence:** every cap miss in the entire 90-second project (`capMisses` 2,
`starvedSources` max 1) occurs inside the lone-loader window. Host A's three siblings produced **zero**.
The only contention this project generated is contention the fix itself introduced.

### The tension this creates, stated because it constrains the fix

**Reverting to the old behaviour (any virtual loader → software) re-breaks I-44a.** A threshold of `> 0`
is always true for a virtual loader, so the count would no longer decide anything — hold identity fixed,
vary the declared need, and the backend does not change. That is precisely the hold-identity-vary-need
test failing, which is what I-44a exists to detect.

**So safety and I-44a currently conflict. Safety wins.** I-44 goes back to **unsatisfied** until a
threshold exists that is both safe AND varies. C16 likewise. Neither is satisfied by a rule that is
correct-by-construction because it never discriminates.

**RESOLVED by the counterfactual (2026-08-08). `37ed422` did NOT create the starvation — and it is KEPT.**

The same fixture at the old threshold (`> 0`, 3 cold arms, vacuity guard passed in all three:
`activeSoftwareInRegime = [1]`, loader genuinely on software) reproduces the same signature:

| | new (`> 1`) | old (`> 0`) |
|---|---|---|
| F1/F4 fire | 3/3 | 2/3 |
| `capMisses` | 2, 2, 2 | 1, 0, 1 |
| loader routing | `wc-hw` | `wc-sw` |
| **host clip routing** | **`element`** | **`element`** |

**The decision: KEEP `> 1`. `37ed422` is not reverted.** It amplifies a pre-existing defect; it does not
create one. Reverting would surrender a real common-case benefit — a lone Flarex clip getting hardware
decode, which is most users most of the time — to recover roughly one cap miss in a fixture carrying
three Flarex hosts, and would re-break I-44a for nothing. A change that amplifies an existing defect gets
a different decision from one that creates it.

**This supersedes the earlier "safety wins, revert or narrow" direction in this note**, which was written
while `37ed422` was still assumed to be the cause. Recorded as a change of direction, not adjusted
quietly.

**Consequently I-44a stands and C16/I-44 are NOT withdrawn on safety grounds** — the safety premise that
withdrew them did not survive the counterfactual. Their status returns to satisfied-under-I-44a, with the
threshold's cost now measured rather than unmeasured: about one additional cap miss, more consistently,
in a three-host project.

**The real subject is elsewhere, and is parked:** the host clip is on `element` in **6 of 6 runs across
both conditions**. The host loses the hardware block at mount regardless of the threshold. That is
pre-existing, matches the 2026-07-27 finding the software-decode rule was built for, and is what every
threshold argument here has been conducted downstream of. Registered as **DEBT-014, PARKED** with named
blockers and a trigger.

**One arm's status, reported rather than resolved.** `old2` is the only arm carrying the "2/3 not 3/3"
reading. Checked directly: its Host C regime is **structurally identical** to `old1`/`old3` — same three
sources, same modes (one `element`, one `wc-sw`), same live counts (`active [0]`, `activeSoftware [1]`),
`sawExactlyOne` true. **It is not void by the "a source never engaged" test.** But it differs
systemically: it created 14 sessions against 15 everywhere else, 10 vs 12 by the regime's start, and
established **no hardware WebCodecs session at all during playback** (its only `wc-hw` source appears at
t=90.3, after the run). So `old2` tested the `== 1` case under systematically lighter decode load. It is
neither clean evidence of safety nor a void arm — it is a lower-engagement run, and it is the same
instability recorded as DEBT-014 blocker 2. The categorical question does not turn on it: the decision
above holds whether `old2` reads 2/3 or 3/3, because both conditions fire and the host-on-element shape
is 6/6.

### What the other two scopes actually support (less than first reported)

- **Scope A: its junction claim is VOID, not "no contention found."** `active = 0` across the entire
  predicted peak window (30.8–34.0s) in all three arms means WebCodecs never engaged there — so
  `capMisses 0` at the junction is evidence the junction *was never tested*, not that it is safe. The
  probe pressed play before routing had flipped; the repo's own standing guidance (`awaitWebCodecsEngaged`,
  read `__rfRouting` first) was not applied. The Scope A counters characterise a **warming system**, not
  an ordinary project.
- **Scope B: weakly supported, NOT settled. I-48/slice B2 is NOT dissolved on it.** The siblings were
  software by design (the `> 1` rule put them there) and `active = 0` says the host was not on WebCodecs
  either, so "siblings did not contend" is partly by construction and partly unmeasured. B2's trigger
  remains open, awaiting the re-run.
- **The one genuine spread, explained rather than waved through.** `samplesWithTwoPlusNonElement` read
  273 / 277 / **143**. Localised entirely to Host A's window: cold1 had 139/146 samples with ≥2 sibling
  loaders off the element path, cold3 had **8/146**. Concurrent 3-loader WebCodecs engagement lasted
  ~17s (30.95→48.02) in cold1 but ~0.9s (30.91→31.8) in cold3 — the loaders engaged and then fell back
  to element — while `activeSoftware` still peaked at 3 in both. **Two nominally identical cold runs
  produced a ~19× difference in how long Host A's siblings held WebCodecs.** That is run-to-run decode
  routing instability, and it further weakens Scope B: in cold3 the siblings were barely ever
  concurrently engaged at all. It is an open question, not noise, and it needs its own look.

---

### Two qualifications on "complete", both load-bearing — STATUS ENTRY 1, superseded twice over

> **Pointer corrected (entry 3).** This section was marked "SUPERSEDED, see the reopening above" while
> entry 2 stood. Entry 2 has itself been superseded, so read this as the record of **entry 1** — the
> original *complete as scoped* verdict and, in qualification (ii), the pre-registered falsifier for the
> `> 1` constant. **That falsifier fired** (entry 2 measured it) and was then **resolved by attribution
> rather than by revert** (entry 3): the threshold is KEPT, and qualification (ii)'s "what is NOT
> measured" is now measured. Qualification (i) — I-44 satisfied under the amended I-44a, not the original
> — is unaffected by either entry and still stands.

**(i) I-44 is satisfied under an amended invariant, not the original one.** `isFlarexVirtualLayerId` is
still a conjunct in `preferSoftwareDecode`; identity was scoped, not removed. See the I-44 row above and
I-44a in ADR-013 §6. An invariant quietly reinterpreted to fit the code is the failure mode this whole
programme exists to catch — so it is written down as an amendment with an explicit test, and anyone who
disagrees with the amendment should read ADR-013 as **not** satisfying I-44.

**(ii) ADR-013's completion rests on ONE UNMEASURED CONSTANT.** Promoting this out of the code comment
where it currently lives (`VideoPreview.tsx`, `37ed422`), because a disclosure buried in a comment is not
a disclosure the programme can act on:

> **The constant:** the `> 1` threshold in `flarexConcurrentLoaders > 1`.
> **What it decides:** whether a Flarex virtual loader gets hardware or software decode.
> **What is measured:** that ≥3 concurrent hardware consumers starve (the 2026-07-27 finding the flag was
> built for). **What is NOT measured:** that a *lone* virtual loader (the `== 1` case) is safe on hardware.
> Before `37ed422` that case took software; it now takes hardware, and nothing has soaked it.
> **Falsifier, stated in advance:** a single-MediaIn Flarex comp playing alongside its host shows decode
> starvation, dropped/held frames, or `capMisses > 0` attributable to that pair — i.e. `== 1` was not
> actually safe and the threshold should be `> 0` (the old behaviour) or the rule needs a different shape.
> **Who resolves it:** `plans/adr-013-real-project-measurement-plan.md` §5, third pre-registered outcome.

Neither qualification is a reason to reopen the other 18 items. Both are reasons not to describe ADR-013
as "done and proven" when it is "done as scoped, with one interpretation stated and one constant pending."

**Is ADR-013 complete as scoped?** Every non-Governor item now has a definitive disposition — satisfied,
dissolved, or explicitly deferred with a stated trigger — except the two deliberately-ambiguous items,
which are unmeasured **by design**, not by omission: ADR-020's whole finding is that this runtime doesn't
warrant building machinery for contention that hasn't been shown to occur. Nothing here is "still needed
and unaddressed." The honest remaining question is not "is there more to build" but "does the one
measurement this program has never run (a real project, not an adversarial synthetic fixture) change any
of these dispositions" — which is exactly what the plan below is for. If it comes back showing no
contention, ADR-013 is finished at this state. If it doesn't, I-48/B2 and the Governor get sized from
what it shows, and nothing else on this list reopens.
