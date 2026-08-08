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
| **I-44** | **Satisfied (2026-08-08, `37ed422`)** | Was: `preferSoftwareDecode`/`preferSoftware` selected a backend from source identity — the named example in ADR-013 §4.2. Fixed in `VideoPreview.tsx` (the actual decision site — `WebglMediaLayer.tsx` only consumes the value; a grep hit is not a call site, same correction as the epoch claim, `project-tracker/architectural-debt.md` DEBT-013). One fix with C16. |
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

**Is ADR-013 complete as scoped?** Every non-Governor item now has a definitive disposition — satisfied,
dissolved, or explicitly deferred with a stated trigger — except the two deliberately-ambiguous items,
which are unmeasured **by design**, not by omission: ADR-020's whole finding is that this runtime doesn't
warrant building machinery for contention that hasn't been shown to occur. Nothing here is "still needed
and unaddressed." The honest remaining question is not "is there more to build" but "does the one
measurement this program has never run (a real project, not an adversarial synthetic fixture) change any
of these dispositions" — which is exactly what the plan below is for. If it comes back showing no
contention, ADR-013 is finished at this state. If it doesn't, I-48/B2 and the Governor get sized from
what it shows, and nothing else on this list reopens.
