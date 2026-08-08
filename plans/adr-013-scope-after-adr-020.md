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
| **C15** | Still needed | `AcquisitionRequirement{rank computed upstream}` has no Scheduler to receive it — subsystem 3.25 was never built. Purpose-class threading (pre-ADR-020, `3531972`) anticipates its shape but is a different, earlier piece of work, not attributable to A/B/E. |
| **C16** | Still needed | No Scheduler/backend-grant abstraction exists. The current pool's `preferSoftware` option still names a backend at the call site (the exact pattern ADR-013 §4.2 names as an I-44 violation), untouched by A/D/E/F. |
| **C17** | Still needed | Governor-owned endpoint (`QualityDirective`, Governor→Scheduler). Deferred to the Governor's own pass. |
| **C18** | Still needed | Governor-owned endpoint (`AcquisitionPressure`, Scheduler→Governor). Deferred to the Governor's own pass. |

## Invariants

| ID | Verdict | Why |
|---|---|---|
| **I-40** | **Dissolved** | Its operative case — repeated, rank-ordered reordering under contention — has nothing to apply to (0 post-mount admission decisions across 30s, ADR-020 §1). The one new post-mount admission path this programme built, slice E's release-path grant, iterates `deniedWaiters` in insertion order, not rank — it doesn't satisfy I-40 either; there's simply no live reordering event for the invariant to govern. |
| **I-41** | **Satisfied** | Structural, not vacuous: the recovery/re-acquire mechanism (slice D/E) has no code path into `EvaluationContext` or node evaluation — it lives entirely in the playback/pool layer. A negative constraint with no path to violate it is a legitimate satisfaction, not an untested one. |
| **I-42** | Still needed | No adaptive decision is threaded into evaluation as an input at all — the clause has no subject yet. |
| **I-43** | **Dissolved** | Its stated form — one budget *per frame*, derived from *that frame's deadline* — presupposes per-frame contention to plan against. None exists (ADR-020 §1). The budget that does exist is a flat constant (K=4), which is I-54's shape, not I-43's. |
| **I-44** | Still needed, actively unmet | `preferSoftwareDecode`/`preferSoftware` still select a backend from source identity at the call site — the named example in ADR-013 §4.2 itself. Untouched by A/D/E/F. |
| **I-45** | Still needed | Governor-owned (§3.26, "owns the quality ladder"). Deferred. |
| **I-46** | Still needed | Governor-owned (§3.26, "restoration is collective and rendezvoused"). Deferred. |
| **I-47** | **Satisfied** | Structural: recovery is pool-internal (idle-sweep tick, release-path grant) and has no code path through a present. Same basis as I-41 — no pressure *loop* exists yet for the rule to be tested against, but nothing built has a route through presentation either. |
| **I-48** | Still needed, partially corrected | **CORRECTED 2026-08-08:** slice B shipped (`38b9c73`) and fixed the cross-host case — a virtual layer now inherits its host's real transform instead of a fabricated identity one, discriminating correctly between comps on different hosts. Still defeated in substance for the within-comp case: siblings on one host still score identically. That remainder needs a per-node contribution channel TimelineLayer doesn't have today (the shipping commit's own words) — renamed **slice B2**, unimplemented. |
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
