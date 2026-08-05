# ADR-018 — Evidence Corrections

- Status: **Accepted**
- Normative: Yes (A1–A5, B1–B5, C1 — stated as amendments to E·, D·, I·, U· clauses)
- Date adopted: 2026-08-04

```
Depends on:
  ADR-014 (Experience Stream: append-only, immutable rows, producer boundaries, provenance
           outranks retention, observations over classifications)
  ADR-015 (Decision Evidence: what one producer's payload preserves)
  ADR-016 (Evidence Integrity: the admission test, and what must be true of the machinery
           that applies it)
  ADR-017 (User Action Observation: the editor producer, and the outcome prohibition)
  ORIS_CALCULUS.md (L11 witnessed-or-derived; L12 every derivation names its policy)
  ORIS_ARCHITECTURE.md (ORIS-7 portable psyche, ORIS-17, ORIS-18, ORIS-19)

Scope: corrections to ADR-014, ADR-015, ADR-016 and ADR-017, arising from applying ADR-016's
       admission test to the two ADRs that predate it and to ADR-016 itself. Amends clauses;
       supersedes nothing.

Status of the amended ADRs: ADR-014, ADR-015, ADR-016 and ADR-017 remain **Accepted and
       normative** throughout. Per ADR-012's closeout, status vocabulary describes the
       decision, not the programme: an ADR whose clauses are amended is still in force, and
       marking any of them superseded would read as "no longer applies."

Renumbering: the expression contract moves to ADR-019. Corrections land first so its
       dependency header cites a corrected substrate rather than routing around a known
       defect.

Precedent for extension: ADR-011 extended ADR-010's closed question set by exactly one
       question without superseding it. C1 does the same to ADR-016's clause set (I15).

Implements: nothing. This is document work. Implementation of anything settled here waits
       behind ADR-013 Phase 0, which keeps the implementation front.

Revisions: Revision 1 (2026-08-04) amended A1, A2, B1, B2, B3, B4, C1 and Consequences after a
       review pass; clause numbering unchanged. Revision 2 (2026-08-04) added A5 (sequencing)
       and fixed B1's upgrade condition. Revision 3 (2026-08-04) added two non-normative notes
       (B3, A2) after approval; no clause or ruling changed. See the Revision record at the end.

Locked: approved at Revision 2. Later revisions are notes only unless the corpus is still empty
       and a defect is found in a ruling, in which case the amendment discipline this ADR
       applies to ADR-014/015/016/017 applies to it.
```

## Context

ADR-016 was written after ADR-014 and ADR-015, and its rules were never run against them.

That is the whole justification for this document. ADR-016 introduced an admission test, a
per-field scope for it, and a set of rules about where a value may sit — and then applied them
forward, to ADR-017 and everything after. The two documents that defined the envelope and the
first payload were drafted under weaker rules and were never re-examined. I1 states that a
producer admitted under weaker rules cannot be retroactively strengthened. It did not observe
that the *substrate* has the same property.

There is a precedent for exactly this operation, in ADR-014 itself. The envelope was unfrozen
once, deliberately, on the day it was set, because the admission test was applied to the
envelope and rejected two of its fields — `episodeId` and `openedEpisode`. The correction was
recorded in the text rather than hidden, and the implementation followed: schema v4 removed
both fields and deleted the write-time episode state machine outright, leaving segmentation as
a read-time policy with no privileged status in the corpus.

This ADR is that operation performed a second time, with a fuller test and against a wider
surface. It is timed rather than opportunistic: **the corpus is empty.** Every correction below
is a free edit today and a migration on populated evidence tomorrow, and E14 forbids envelope
changes for new producers — so the first row written under the current envelope converts all of
Part A from editing into archaeology.

Five of the brief's factual premises were contradicted by the code. Each is recorded at the
clause it affects rather than softened, per ADR-017's precedent, whose design was wrong in
three places and where every error was found by measurement rather than review.

## Decision

### Part A — Structural corrections

**A1 — Recorder identity is recorded at session scope, and is required to be unique rather
than durable.**

*Amends ADR-014 E3, in service of ADR-016 I7. Adds `recorderId` to `SessionPayload`.*

**Correction to the premise.** The envelope is not missing recorder identity outright.
`SessionPayload` already carries `seatId`, every row carries `sessionId`, and ORIS-17 pins the
session row for the lifetime of any row referencing it — so recorder identity is already
recoverable from any row by a join that cannot dangle. I7's structural obligation is
*formally* satisfied today. The defect is narrower and worse than "no field exists."

**The actual defect.** A seat is not a recorder. `seatId` answers *whose corpus this is*;
I7 requires *which recorder wrote this row*, and those diverge in the case the architecture
explicitly intends. ORIS-7 makes the psyche volume portable. A volume copied to a second
machine carries its `seatId` with it, both machines then write under one seat identity into
two diverging sequence spaces, and no field in the corpus records that the fork occurred. The
merge is not merely hard to order afterwards — under I7 it is permanently unorderable, and the
corpus cannot even state that it lost the entitlement.

**The ruling.** A `recorderId` is minted at the moment a runtime installation first writes to a
volume, is stored in that volume, and is compared on every load against an **install-local
identity held outside the volume**. A mismatch mints a fresh `recorderId` and continues the
existing sequence. Sequence remains monotonic across the whole corpus; **it is authoritative
only within one `recorderId` run**, which is precisely what I7 says and what nothing currently
records.

The second operand is stated because without it the mechanism cannot detect the case it exists
for: an identity held *only* inside the volume travels with the copy, both machines read the
same value, the comparison matches, and no fork is ever recorded.

**The false-boundary case, argued rather than left implicit.** Browser storage clears
partially, so the install-local slot can vanish while the volume survives, minting a spurious
`recorderId` on one machine. This is safe, and the asymmetry that makes it safe is worth
naming: **a false ordering boundary costs reuse; a false ordering entitlement costs
correctness.** A spurious mint makes the corpus claim *less* than it is entitled to — some rows
that could have been globally ordered are treated as only within-run ordered. Nothing is
corrupted; some analysis is foregone. That is ADR-010 §6's must/must-strive asymmetry arriving
in a third place, and it is the direction a mint-on-doubt rule should fail in.

**Concurrent recorders — ruled on, because the case is live today and worse than ordering.**
Two browser tabs on one origin share storage. Both hydrate, both match the install-local
identity, both write. Mint-on-mismatch cannot catch it, because neither is a mismatch.

The review frames this as one `recorderId` over two interleaved sequence spaces. **The code is
worse than that.** Persistence serialises and writes the *whole* module state under a single
key, and hydration reads it once at first use. Two tabs therefore do not interleave — the
second tab's write **replaces the first tab's entire corpus**, and nothing coordinates them: no
`storage` event listener, no lease, no single-writer discipline anywhere in the module.

So the finding is not an ordering defect but a **silent data-loss defect at the persistence
layer**, and it is a live I9 violation: the corpus becomes quietly smaller than it reports, by
exactly the mechanism I9 exists to forbid, without any refusal being counted.

The ruling follows from that and not from ordering policy: **a volume has one writer at a
time.** Concurrent attachment is a defect to be closed by implementation, not a case for
ordering policy to absorb — no `recorderId` scheme can rescue a corpus whose last writer
overwrites the others, because the lost rows are gone before ordering is a question. Until
single-writer discipline exists, **the corpus's only ordering entitlement is within-session**,
and that is stated here rather than left to be assumed from the presence of a monotonic `seq`.

This is recorded as a present defect in shipped code rather than as a future risk. The copy
case A1 was written for is gated on a portability feature that does not exist yet; this one
reproduces by opening a second tab.

**On durability, because this is where the clause will be attacked.** Recorder identity must
*not* be derived from anything stable across machines — device fingerprint, hardware id,
account. I7 does not require a durable identity; it requires that rows written by different
recorders be distinguishable. A cleared identity that mints fresh satisfies that: the new value
differs, so the boundary is visible. An identity that *survives a copy* fails it, because two
recorders then share one label. The requirement is **uniqueness, not durability**, and a
randomly minted value satisfies I7 where a fingerprint actively defeats it. This inverts the
usual intuition and is the reason the clause states it explicitly.

**Absent values.** The corpus is empty, so no production rows lack this field. Development and
eval corpora do exist, and for them the reading is I12's: `recorder.identity` absent from a
session's coverage means that build could not label its recorder, and rows from such a session
are entitled to within-session ordering and nothing more. The absence is coverage, not a hole.

---

**A2 — τ and dτ are removed from the envelope. `tauInputs` and `tauPolicy` remain.**

*Amends ADR-014 E13, under ADR-016 I3/I4/I6.*

τ is computed from `tauInputs` under `tauPolicy`. Two honest observers running different τ
policies disagree about its value while both being correct, which is I2's stated signature of a
derivation. The envelope's own comment concedes this in terms — it names τ "a DERIVATION, not
an observation" and cites L12 — and then stores it anyway. E13's defence is that the terms are
stored alongside, so history is re-derivable. That answers I8, which asks whether a derivation
is reproducible. It does not answer I4, which asks where a derivation may sit, and I4 is
categorical: a derived value carried on an evidence row is a defect, not an optimisation.

**dτ inherits the same status and worse.** It is arithmetic on two derived values. I6 rules
that arithmetic on two *observations* yields a derivation; arithmetic on two derivations cannot
be better. dτ goes with τ, and the fact that it is the more useful of the two is not an
argument under I4.

**The ruling: τ and dτ are removed from the row.** The envelope retains `tauInputs` and
`tauPolicy`, whose meaning is amended: it names the policy under which the *inputs* were
captured, not the value that was computed from them.

**This ruling is about storage location only. Runtime τ is unaffected.** τ governs decay,
recency and consolidation, and those are live behaviours that need a live accumulator. Nothing
here removes it; what is removed is the *stamped copy on each evidence row*. An implementer
reading "τ moves to the read path" as "τ ceases to exist" would be reading it wrongly, and the
distinction is stated because the clause is otherwise easy to act on incorrectly.

**`surprise` is admissible, and owes its own policy.** `base` and `consequence` are properties
of the recording act. `surprise` is not — it will be a derivation from the Prediction Ledger,
and under I4 leaving it unexamined would reproduce the same defect one level in.

I5 supplies the rescue: *a timestamp is not the time, it is an observation of what an
instrument reported.* `surprise` recorded as **what the ledger reported at the moment of
append** is witnessed on identical grounds — the recorder witnesses the reading, not the truth
of it, and two honest observers cannot disagree about what the instrument said.

But a reading owes its instrument's attribution the way τ owed `tauPolicy`. Without it the
field reads *`surprise = 0.4`, according to… something* — the exact L12 violation that got the
original τ field rejected in v4. **`tauPolicy`'s amended meaning covers it**: it names the
policy under which the inputs were captured, and the ledger's policy identifier is part of that
capture. A separate field is not required, and would fragment one attribution into two.

> **Note (Revision 3, non-normative) — `tauPolicy` now carries two attributions that will
> version independently.** Folding the ledger's identifier into `tauPolicy` is economical and
> correct on present evidence, because the Prediction Ledger does not exist and `surprise` is
> honestly null. It is recorded here that the two attributions are not one thing: a τ-input
> capture policy and a ledger policy revise on different schedules, and a single identifier
> cannot express which of them moved. Two corpora bearing different `tauPolicy` values will not
> say whether the capture changed, the ledger changed, or both.
>
> **The first ledger revision forces the question**, and that is the moment to split the field —
> not before, when a second identifier would be a distinction invented ahead of its
> observations, and not after rows exist under an ambiguous one. The asymmetry is Part A's own:
> recording the anticipation costs this paragraph; discovering it on populated evidence costs a
> migration.

**Read-path cost.** Stated rather than assumed: **the read path already exists.**
`recomputeTau` was written to re-derive the whole stream's τ under a different model, which is
exactly the fold this ruling requires, and it is already the mechanism by which H2 is intended
to be tested against an existing corpus. Moving τ off the row deletes the write-time
accumulation and keeps a function that is already there — the same shape as the v4 episode
removal, which also net-deleted code.

The magnitude is bounded by the corpus ceiling and is otherwise unmeasured. Per ADR-013's
precedent, the ceiling is therefore **configuration until proven**, not a constant to be
guessed at now: if the fold turns out to be expensive at ceiling, the response under I4 is to
cache the derivation explicitly and name it as a cache, never to restore it to the row.

The second admissible outcome from the brief — τ retained as an explicitly-named cached
derivation — is **rejected on sequencing, not on merit.** It is the correct answer to a
measured cost problem, and no cost has been measured. Adopting it now would preserve the field
on the strength of a cost nobody has observed, which is how the field got there.

---

**A3 — A decision is recorded as two rows: begun and ended, joined by `refs`.**

*Amends ADR-015 D8, under ADR-016 I5.*

D8 records start and finish as a pair rather than a duration, so that temporal overlap
survives. The pair is preserved and the overlap is lost anyway, by a route D8 did not
anticipate: one row written at completion places the entire decision at a single `seq`, and
under I5 sequence — not the timestamp — is the ordering authority. Nothing can be shown to have
interleaved with a decision that occupies one sequence position, because there is no position
between *n* and *n+1*. The timestamps still describe an interval; the corpus's ordering
authority does not, and I5 says which one an analysis is entitled to use.

This is D8's own rule reaching further than its original statement. I6 already noted the
convergence from the opposite direction; this is the third arrival at the same asymmetry.

**The ruling.** `decision.begun` and `decision.ended`, the ended row referencing the begun row
through `refs`. A decision then occupies a seq *range*, and any row landing inside that range
is provably concurrent with it — which is what D8 wanted and could not express.

**What the begun row carries, and nothing more:** `prompt` and `situation`. D2 requires the
situation to be snapshotted at the moment of decision, and the moment of decision is the start;
capturing it at completion has always recorded the situation *after* the decision's own effects,
which is a quieter version of the same defect. Everything else in `DecisionPayload` —
`route`, `zeroTokens`, `notes`, `steps`, `applied`, `failed`, `factsConsulted`, `owner`,
`confidence`, `actions`, `candidates` — is knowable only at the end and belongs to the ended
row. The split is not a convenience; **anything on the begun row that was not witnessed at
start is a D2 violation taken to make the split cheap**, and the list above is exhaustive for
that reason.

This aligns with a seam that already exists: `beginDecision` already opens a fact scope at the
start of a decision and already refuses facts observed with no scope open.

**An unterminated begun row is an honest record of a decision that did not complete, and must
not be repaired.** No synthetic ended row, no timeout-generated close, no write-time
reconciliation pass. Under E11 the incompleteness *is* the observation. A reader that wants
"decisions that did not finish" derives it under a named policy from the absence of a
referencing ended row. This is a capability the corpus gains rather than a cost it pays: today
a crash mid-decision records nothing at all, and is indistinguishable from a decision that was
never begun.

---

**A4 — `strength` is removed from `BoundarySignal`.**

*Amends ADR-014 E11. Not in the brief; added under the brief's own rule that a named defect
left unruled is worse than one never named.*

The stream module already carries this defect in its own text, classifies it correctly, and
defers it: `strength` is a prior about how much a signal kind matters, not a property of the
occurrence; two honest observers disagree about whether a project switch is "strong"; it
belongs on the policy, not the row. The module declines to act because removing it changes the
envelope, and states that it is "deliberately left for an explicit governance decision rather
than taken silently."

**This ADR is that decision.** `strength` fails I2 exactly as `episodeId` did, it sits in the
same class as τ under I4, and it is free to remove today for the same reason everything else in
Part A is. Segmentation policies that want a strength ordering define it over
`BoundarySignalKind`, where it can be versioned and compared.

Recording the deferral was correct and is why this took one paragraph instead of an
investigation.

---

**A5 — No new write defined by this ADR is wired until single-writer discipline over a volume
exists.**

*Sequencing clause. Governs A3's split rows, B1's coverage kind, B2's failure-occurrence rows
and B3's judgement kind. Added in Revision 2, on ADR-011's extend-by-one precedent.*

This ADR does two things that are safe apart and unsafe in the wrong order. A1 records that
concurrent writers destroy rows today — silently, uncounted, by whole-state overwrite. B3
admits into the corpus a signal that ships and is currently captured elsewhere. Wiring the
second before closing the first means a judgement row can be lost with nothing refusing it and
nothing counting the loss, which is precisely the I9 violation this ADR exists to close,
committed by the clause that closes it.

The asymmetry that decides the order is I9's own, restated one level up. **A signal not yet
captured is a known, bounded, visible absence; a signal captured into a lossy substrate is an
unknown, unbounded, invisible absence** — and the second is the one that devalues the rows
around it, because nothing downstream can tell a corpus that lost a judgement from one that
never received it. Waiting costs observations that are already being captured elsewhere and
will still be capturable later. Not waiting costs the ability to trust anything the new
producers write, permanently, for the window in which the defect stood.

**The ruling.** Single-writer discipline is a precondition for wiring any new write settled
here, not a follow-up to it. The mechanism is unspecified — lease, lock or election is an
implementation decision — and the precondition is satisfied when concurrent attachment to one
volume either cannot occur or is refused loudly under I9, never when it is merely made
unlikely.

This costs nothing today. Nothing settled here is wired, ADR-013 Phase 0 holds the
implementation front, and the corpus is empty. The clause exists so that the ordering is a
recorded decision rather than an accident of which work happened to be picked up first.

### Part B — Clause corrections

**B1 — Coverage is recorded as it changes, not once per session.**

*Amends ADR-016 I12 and its placement under ADR-014 E12. Adds a `coverage` row kind.*

I12 requires coverage to be recorded "as it changes"; E12 places facts at the scope within
which they are constant; the implementation records coverage once, on the session row. Those
are reconcilable only if coverage is constant within a session, and it is not. Several
observation capabilities load lazily and asynchronously — the transcription pipeline is the
repo's stated reference pattern for exactly this, and TTS, local ASR and face detection follow
it. Before each finishes loading, a class of observation cannot occur. A session-scope snapshot
therefore asserts, for the whole session, a capability the build acquired partway through it.

That is I12's own failure one level down, and in the more dangerous direction: the snapshot
does not merely fail to distinguish two causes of absence, it actively licenses the wrong
reading. Under I12 a coverage token *present* is what makes a null field readable as "did not
happen" rather than "nothing was watching." A token present from the session's first row
licenses that reading across a window where nothing was, in fact, watching.

**The ruling.** The session row's `coverage` is retained and its meaning is amended: it is the
**opening** snapshot — what the build reported it could observe when the session began.
Subsequent changes are recorded as rows of a distinct `coverage` kind, carrying the tokens
gained or lost and the reason, owned by the `system` producer that already writes session rows.
Coverage at time T becomes a fold of the opening snapshot over the change rows up to T: a
derivation, under a named policy, which is the correct location for it.

**The opening snapshot is a declaration, not an observation, until C1 is satisfied.** An
earlier draft of this clause called it witnessed. C1, two clauses below, establishes that the
value is constructed by copying a hand-maintained constant and then asserted equal to that same
constant, with nothing proving the seams behind it are reachable. Calling it witnessed while
separately proving it unchecked is the contamination I3 exists to catch, committed by the
document that is meant to be applying I3.

So it is labelled under I12 for what it is: a claim by the build about its own capability, read
as a declaration rather than an observation.

**The upgrade condition, stated precisely, because "once C1 is satisfied" is ambiguous and C1
has two halves.** The opening snapshot upgrades to an observation on **C1's runtime tripwire,
not on its static proof.**

C1 now concedes that a module-graph proof establishes *a seam was not deleted*, not *a seam
runs*. Put the static proof to I2's test and it fails: two honest observers can disagree about
whether a build could observe X when the only evidence is a call site — one reads the site as
capability, the other reads the condition guarding it as never taken, and the shipped
`kernelDiagnostics` case shows the second reading is sometimes the correct one. A token
exercised during a session admits no such disagreement.

The static proof is still worth having and is not merely a way-station: it kills the drift
case, where a seam is deleted and its token silently survives, which is the failure that
compounds. So the sequence is **unchecked declaration → checked declaration → observation**,
and only the last step clears I2.

What the interim costs, per the standard B5 sets: every coverage-licensed read-time derivation
rests on a declaration until then. That includes U6's — *undeclared at a committed write
licenses "not AI-initiated"* — which is the reading that makes ADR-017's honest `null` usable
rather than a hole. Analyses depending on it are entitled to it, and are obliged to say they
took it on a declaration.

A distinct kind rather than a field on an ordinary row, because coverage is an observation
about the recorder rather than about the world, and E6 keeps those boundaries visible.

**On volume, because the brief anticipates a sampling answer.** There is none, and none is
needed. Coverage changes are bounded by the number of lazily-loaded capabilities — single
digits — each loading at most once per session. The volume is O(capabilities), not
O(observations). **The recursive problem I12 would otherwise create does not arise here**: had
sampling been necessary, the sampling policy would itself have to be recorded as coverage,
which the ADR would then owe an account of. It is worth stating that this was checked rather
than avoided.

One case must explicitly not be sampled or debounced if the volume assumption ever fails: a
capability that *flaps* — loading, being evicted under memory pressure, reloading — is the most
informative coverage signal available, and it is precisely the pattern a naive rate limit would
erase.

---

**B2 — I9 extends to persistence failure.**

*Amends ADR-016 I9.*

I9 governs a record that fails admission. It is silent on one that passes every test and then
fails to be written — quota rejection, serialisation failure, a write during teardown. The
reflexive response is a `catch` that logs and continues, which produces exactly what I9
forbids: a corpus quietly smaller than it reports, with size and coverage feeding every
conclusion drawn from it.

This is predicted rather than exceptional. The corpus persists to browser storage, and E9's
provenance pinning may push the stored set past `MAX_EVENTS` by design — the ceiling yields to
provenance, which is correct under E9 and which makes quota exhaustion an expected operating
condition rather than an error.

**The ruling.** A persistence failure is counted, surfaced, and never repaired. Specifically:
no silent trimming to fit. Dropping rows to satisfy quota is the I9 violation in its purest
form, because it is the corpus editing itself to conceal that it could not hold what it was
given. The current implementation already refuses to trim and says so in terms; this clause
makes that a rule rather than a comment.

**On the recursion — whether the failure is itself recorded.** It is not recorded as a row *at
the moment of failure*. Under I2 a failed write is plainly an admissible observation about the
recorder, but recording it as a row requires the write path that just failed, and a
quota-exhausted store rejects the row reporting quota exhaustion. **The failure is therefore
reported out-of-band: an in-memory buffer surfaced through the same statistics seam that
already counts refused rows, and a console warning on the same pattern as the malformed-row
refusal.**

**What is written on recovery is occurrences, never a sum.** An earlier draft persisted the
*count* with the next successful write. A count over occurrences is arithmetic, and this ADR
removes `dτ` two clauses earlier for exactly that — Part B may not spend what Part A refuses to.
So on the next successful write the recorder emits **one row per buffered failure occurrence**,
and the count becomes a read-time fold, exactly as coverage does under B1.

The buffer is bounded, because an unbounded in-memory buffer is the same hazard in RAM that
quota exhaustion is on disk. When it caps it emits an **explicit overflow marker** rather than
dropping silently — the I9 rule applied to the mechanism that reports I9 failures.

This is the honest answer and it is worth naming its cost: **the count does not survive a
session that ends without a successful write.** A corpus that could not persist at all leaves
no durable trace of having failed. That is a real hole, it is forced by the recursion rather
than chosen, and it is the reason the out-of-band channel must be noisy at the moment of
failure — the failure is observable while the process lives or not at all. I13's stronger form
applies directly: where silence is ambiguous, arrange that failure is loud, rather than that
success is well-reported.

---

**B3 — U1 is narrowed to derived outcomes. An explicit user judgement is a witnessed action.**

*Amends ADR-017 U1. Adds a `judgement` kind to the editor producer.*

U1 rules that outcomes are interpretations with no natural observer, and that no outcome
producer will exist. That is correct for the derived outcome classes it was written against —
accepted, rejected, ignored, good — and is one of ADR-017's strongest results.

It overreaches by one case. A thumbs-down press is not a derivation. Two honest observers
cannot disagree that the button was pressed, so under I2 it is admissible, and its observer is
unimpeachable. U1 as written can be read as foreclosing it.

**The correction is not hypothetical, and the contradiction is already live.** The signal ships
today, and it is already written to a store outside the corpus: per-rule trust counters and a
bounded feedback event log, both in their own localStorage keys, with a drain seam declared for
a future sync worker. **That is the second history E1 exists to forbid, and it exists now.**
Recording it is the point of this clause; U1's overreach is what pushed it there, and leaving
U1 unamended does not prevent the signal from being captured — it only guarantees the capture
happens somewhere the corpus cannot see.

**The ruling.** No producer may record a *derived* outcome; U1 is otherwise unchanged, and the
prohibition it exists to enforce is untouched. An explicit user judgement is an ordinary
witnessed user action and belongs to the **editor producer** — the user-action producer — as a
distinct `judgement` kind, additive under E14. **Gated by A5**: this is the write whose loss
would be least detectable and most costly, so it is the clearest case for closing the
concurrency defect before wiring anything new.

**Not the AI producer, and this is the load-bearing half of the ruling.** The control is hosted
in the AI panel, so the AI producer is the tempting owner. It must not be: the AI producer
would then be recording evidence about how the AI's own output was received, which is
self-witnessing, and the corpus would carry the AI's account of its own reception with no
independent observer. ORIS-18 is satisfied on a technicality by either choice — both witness
something at their own boundary — so the tiebreak is the self-observation trap, and it points
one way. The thing witnessed is a *user action*, and ADR-017's producer owns user actions
regardless of which surface hosts the control.

**The judgement row carries an observed `refs` to the decision it judges.** This is the one
place in the system where the decision↔outcome link is witnessed rather than inferred, and it
is taken here because B3 is the clause that opens it.

U5 calls that link the most valuable signal the corpus could hold and correctly refuses to
fabricate it from undo, because the history stack holds whole-composition snapshots and the
target is not witnessed. U9 states the condition under which a causal reference *is*
admissible — that the attachment itself be observed — and records that nothing meets it today.
**The judgement handler meets it.** One handler receives the press, holds the decision it
refers to, and performs the revert; the attachment is not reconstructed afterwards from
proximity, it is present in the act. A judgement row without the reference would be strictly
less valuable than one with it, and the affordance already exists in shipped code.

Two refinements the code forces, neither of which was visible from the affordance alone:

**A judgement is not one act.** The handler branches on the judged decision's owner. A negative
judgement on a rule-resolved turn records rejection, reverts, *and re-runs the same prompt
through the model*. A negative judgement on a model-resolved turn forgets the cached plan and
reverts but **deliberately does not re-run** — the code's stated reason being that the same
model would repeat itself, so a correction is solicited instead. These are two different acts
with two different consequences, and a row that records only "negative" conflates them. The
judgement kind therefore records *which* judgement was made, not merely its sign.

**The implicit reject path is a derivation and must never be recorded as a judgement.** The
same subsystem treats "undo a brain edit within 60 seconds" as a negative signal. That is a
policy over a window — the 60-second threshold is precisely the kind of value two honest
observers dispute — and under U1's surviving prohibition it is a *derived* outcome. It is
derivable at read time from the judgement rows and the action rows this ADR already provides.
That the shipped code takes care to prevent the implicit and explicit paths from double-counting
is evidence the distinction is real at runtime; here it is the boundary between what may be
written and what may only be computed.

> **Note (Revision 3, non-normative) — what that derivation actually has to work with.** The
> clause licenses the implicit signal as a read-time derivation and should not be read as
> promising it survives at full strength. Attribution is unavailable: U5 records that the
> history stack holds whole-composition snapshots, so an undo does not witness what it
> reversed, and the `human.operationIdentity` gap leaves `actionIds` empty on human commits, so
> it does not witness its content either. What remains is **proximity under a named policy** —
> admissible under I8, and weaker than attribution.
>
> One thing this ADR improves rather than degrades: A3 gives a decision a `seq` *range*, so an
> undo landing inside or immediately after that range is a proximity claim in **sequence**
> rather than in clock time, and under I5 that is the stronger of the two. `undoDepth` and
> `graphVersion` deltas are witnessed and available as corroboration. The derivation is
> therefore better grounded than a 60-second wall-clock window, and it is still proximity. A
> later reader should not assume the implicit signal and the explicit judgement carry equal
> weight; they are different evidence classes, which is why only one of them is written.

---

**B4 — Erasure is volume-level. Row-level erasure does not exist; product-mediated replication
requires a replica register; an unmediated copy is outside erasure's reach and must not be
claimed otherwise.**

*Amends ADR-014 E2/E7 and ADR-016 I11, jointly.*

E2 forbids deletion, E7 forbids in-place correction, I11 forecloses deletion again and replaces
it with read-time quarantine. None addresses a user asking the product to delete what it knows
about them, and the Memory Panel already ships a Forget affordance, so the expectation is set
by shipped UI rather than by anything decided here.

**The ruling.** A user's erasure request is not a claim about a row; it is a claim about the
whole record. Erasure is therefore **volume-level**: the psyche volume is destroyed, along with
the bindings of the policies that read it, and nothing about the destruction is recorded inside
the destroyed volume. Quarantine under I11 covers every case short of that, and row-level
erasure remains foreclosed — a corpus with holes punched in it supports no claim about
development, and the holes are undetectable afterwards.

**On sync, which the brief correctly identifies as the load-bearing assumption.** "Local-first,
so erasure is volume-level" holds only while the corpus is local, and the code says the
direction is not local-only: the experience corpus is localStorage-only today with no sync
path, but memory facts already synchronise to the server — `forgetFact` removes from cache
*and* server — and the feedback event log declares a drain seam for a future sync worker. Two
adjacent stores establish sync as the product's direction.

The ruling is therefore written to survive it: **erasure is volume-level at every replica the
product created.** A forced consequence follows, and it is stated as a rule rather than left to
be discovered — **a volume that has been replicated by the product must be able to enumerate
its replicas, or product-mediated replication is forbidden.** A corpus that can be copied by
the product to a location the product cannot name cannot be erased on request, and that is a
property of the design rather than of any particular deployment.

**Replication is defined, because an earlier draft left the term undefined inside a rule stated
as absolute — and as drafted it forbade the case A1 is engineered to detect.**

- **Mediated replication** — a copy the product created: sync to a server, an export the
  product performed, a device-to-device transfer it brokered. The product knows the copy exists
  because it made it. The register requirement above applies here and only here.
- **Unmediated copy** — a copy the product did not make: a file copy, a profile clone, a disk
  image, a filesystem backup. Nothing can enumerate these, and no rule stated by this ADR can
  make them enumerable.

The two clauses are complementary rather than contradictory, and the earlier draft obscured
that by using one word for both: **A1 exists to make an unmediated copy *detectable*; B4
constrains mediated ones so they remain *erasable*.** Detection and erasure are different
obligations over disjoint cases.

For an unmediated copy the honest ruling is that **erasure does not reach it**, and the product
must not claim otherwise. What the product owes is the truthful scope of the guarantee — that
erasure covers the volume and every copy the product made, and that a copy the user or their
operating system made is outside its reach, exactly as it would be for any local file. Stating
this is better than discovering it under a user request or a regulatory one.

---

**B5 — U4 stands. Declared preference changes are admissible and deferred, and what is lost by
deferring is named.**

*Amends ADR-017 U4 by scope clarification only. No reversal.*

U4 rules that interaction not changing the composition produces nothing, and that this is a
measured fact about the seam rather than a filtering policy. That stands, and is right for
transport, scrubbing and selection.

**Correction to the premise.** The brief treats workspace and theme changes as silently
excluded by U4 and therefore unadmitted. They are not unadmitted: `workspace-change` is already
in the boundary-signal vocabulary and is already classified as **written** — witnessed at an
emitter — rather than derived. Admissibility was settled when that vocabulary was drawn up. The
gap is emission, not admission, and it is wider than one signal: `noteBoundarySignal` has no
production call sites at all, so every witnessed signal kind in the vocabulary is currently
unemitted.

**The ruling.** U4 is unamended. A *declared* preference change is admissible from the command
plane under E5/E6, is already in the vocabulary, and its emission is **deferred** to the later
producer that will own the command plane. Deferral is permitted; the brief requires that what
is deferred be named, and it is:

A user's chosen workspace is the clearest available signal of where they sit on the
beginner-to-professional curve, and the product's stated direction is that the control surface
expands as competence grows. Because these changes are non-destructive they will be handled by
the command plane rather than the registry, so they never reach the composition write choke
point — meaning **every day this is unwired is a day of curve data that no later producer can
recover.** Unlike a derived outcome, which can be recomputed from evidence whenever the policy
improves, an unwitnessed preference change is gone. That is the cost of the deferral, it is
being incurred deliberately rather than by accident, and this clause exists so the next reader
knows which.

### Part C — The verifier

**C1 — A coverage token is proved by the verifier, not declared to it. (New clause: ADR-016
I15.)**

*Extends ADR-016's clause set by one, on ADR-011's precedent. Governed by I13 and in scope
under I14.*

**The finding.** The eval suite cannot distinguish a seam that is wired and produced nothing
from a seam that was never wired. Its coverage checks compare two hand-maintained constants:
the session row's `coverage` is constructed by copying `BUILD_COVERAGE`, and the suite then
asserts that the row's coverage equals `BUILD_COVERAGE`. That assertion cannot fail. The
remaining checks assert that specific tokens are present or absent in the same constant, and
the producer-boundary checks compare a producer table against the suite's own expectations of
it. Nothing in the suite reaches a production call site.

The asymmetry matters. The suite does have a real tripwire in one direction: wiring
`setSituation` without adding its token would fail the check asserting the token is absent. In
the other direction it is blind. If the sole production call site of `appendEditCommit` were
deleted, `editor.commit` would remain in `BUILD_COVERAGE`, the session row would keep claiming
it, every coverage check would keep passing, and the corpus would assert a coverage it does not
have — which is the exact fabrication I12 exists to prevent, produced by the machinery
certifying that I12 holds.

This is I13's failure mode inside the module ADR-016 governs, and I14 places it in scope: a
suite that is not itself checked is an unverified assertion about the trusted computing base.
ADR-012's closeout is the strongest available support for treating this as load-bearing rather
than as a tooling chore — its verification standard caught a defect the entire correctness gate
set was blind to, on a shipped subsystem, at scale.

**The ruling.** A coverage token is a claim that a seam is reachable in the shipped build, and
under I13 the verifier must produce positive proof of it — a structural artefact that cannot
exist unless the seam is wired. A token whose seam cannot be reached fails the suite loudly.
The proof obligation runs in the direction the current suite lacks: **claiming coverage that
does not exist must fail, not merely wiring coverage that is not claimed.**

The mechanism is not specified here and is deliberately left to implementation, because I13
constrains the property rather than the technique. What is normative is that the artefact be
structural — derived from the shipped module graph rather than from a list someone maintains —
since a hand-maintained proof reproduces the ambiguity one level up, which I13 forecloses by
construction.

**What a module-graph proof establishes, stated exactly.** It proves *a seam was not deleted*.
It does not prove *a seam runs*. Code can be statically reachable and dead in fact, and this
repo has a shipped example: after ADR-012's closeout exactly one kernel flag survives —
`kernelDiagnostics`, an observability control that selects nothing — and it guards 25 audited
call sites. Every one of those sites is in the module graph and none executes while the flag is
off. A graph-reachability proof would certify them all.

*(A review draft cited ADR-012 as closing with eight live flags, five defaulting OFF. That was
the pre-closeout state; the programme removed all eleven rollout flags in S7.2 and the module
now says so in terms. The argument survives the correction and the example is stronger for it,
because `kernelDiagnostics` is not a leftover — it is a flag the closeout deliberately kept.)*

**The stronger form is identified and deferred.** I13's operational reading — arrange that
failure is noisy — points past static reachability to a runtime tripwire: a coverage token
claimed but never exercised during a session is observable at session end, and observing it is
the direction the suite lacks entirely. That is a runtime change, this ADR ships none, and
ADR-013 Phase 0 holds the implementation front.

What the deferral costs, per the standard B5 sets: until the runtime tripwire exists, a seam
that is present but never reached — behind a flag, behind an unmet condition, behind a code
path no session takes — is indistinguishable from a live one, and the corpus will claim
coverage it does not have in exactly the case hardest to notice. Static reachability narrows
the gap; it does not close it, and C1 should not be read as claiming otherwise.

## Alternatives considered

**Supersede ADR-014/015 with corrected reissues.** Rejected. The README rule is append-only,
and the reissue would destroy the record of what was believed when the corpus was designed —
which is the same argument I11 makes about rows. ADR-011's precedent covers extension and
ADR-014's own unfreeze covers amendment; neither required a supersession.

**Wait until the corpus has data, so the corrections can be validated against real rows.**
Rejected on cost asymmetry. Every Part A correction is a free edit on an empty corpus and a
migration on a populated one, and E14 forbids the envelope change that a migration would need.
The information gained by waiting is small; the cost is that A1, A2, A3 and A4 become
permanent.

**Retain τ as an explicitly-named cached derivation.** Rejected on sequencing rather than on
merit — see A2. It is the right response to a measured read-path cost, and no cost has been
measured. Adopting it now would preserve the field on the strength of an unobserved cost, which
is how it came to be on the row.

**Give the decision one row and record a `latencyMs` alongside the pair.** Rejected under I6
and A3. It restores exactly the scalar D8 refused, and it does not address the defect, which is
that a single `seq` position admits no interleaving regardless of what timestamps accompany it.

**Wire B3's judgement rows now and close the concurrency defect afterwards; the loss window is
small and the signal is being lost anyway.** Rejected under A5. The premise is true and the
conclusion does not follow: the signal is currently captured *somewhere lossless*, so waiting
loses nothing that is not already recoverable, while wiring early produces rows nobody can
later distinguish from rows that were never written. It also inverts I9's asymmetry — trading a
visible, bounded absence for an invisible, unbounded one — which is the trade every clause in
014–017 refuses.

**Absorb concurrent recorders into ordering policy — give each tab its own `recorderId` and
treat the result as a cross-recorder merge.** Rejected under A1. It is the tempting answer
because it makes the problem an ordering problem, which this ADR has machinery for. It does not
work: the persistence path serialises whole module state under one key, so the second writer
replaces the first writer's corpus outright. The rows are gone before ordering becomes a
question, and a merge policy over surviving rows would produce a confident reading of a corpus
that silently lost half its evidence — I9's failure mode, reached by way of a fix for something
else.

**Derive recorder identity from a device or hardware fingerprint, so it survives clearing.**
Rejected under A1, and it is worse than the field's absence. A fingerprint survives a volume
copy, which is the case I7 is about — two recorders would share one label, and the corpus would
assert an ordering entitlement it does not have. Durability is the wrong property.

**Record coverage changes by sampling, to bound volume.** Rejected under B1, and not needed:
the volume is O(capabilities). Had it been necessary, I12 would require the sampling policy to
be recorded as coverage, which is recursive; the ADR states this to show the branch was checked
rather than avoided.

**Handle persistence failure with a `catch` that logs and continues.** Rejected under B2. It is
the I10 pattern, it always reads as robustness, and it produces the corpus I9 exists to
forbid — one that is quietly smaller than it claims.

**Trim the corpus to fit quota.** Rejected under B2. It is the corpus editing itself to conceal
that it could not hold what it was given, and every rule in 014–017 says the response to a cost
problem is to narrow what is recorded, deliberately and in the open, never to discard silently
at the boundary.

**Let the AI producer own the judgement row, since the control lives in its panel.** Rejected
under B3. It would have the AI recording evidence about its own reception with no independent
observer.

**Reverse U4 so preference changes reach the composition seam.** Rejected under B5. U4 is a
measured fact about a seam, not a policy to be traded; the fix is a producer at the command
plane, which is deferred rather than denied.

**Treat the coverage-check gap as a test-quality issue and fix it outside the ADR set.**
Rejected under I14, which already settled that verification machinery is governed rather than
adjacent. C1 exists because the finding is a corpus defect with a corpus severity.

## Consequences

**The envelope shrinks.** τ, dτ and `strength` leave it; `recorderId` is added at session
scope. The net is fewer fields, and the two removals delete write-time machinery rather than
adding read-time machinery, because the read-time function already exists.

**Decisions cost two rows instead of one, and the second row pins the first.** The row-count
doubling is the smaller half of the effect. An ended row references its begun row through
`refs`, so under E9 **every begun row with a surviving ended row becomes non-evictable** — the
older half of every pair leaves the evictable surface. The corpus therefore does not merely
consume its ceiling twice as fast; it loses the reclaimable space it would have used to absorb
that, and E9 already permits overrun rather than breaking a chain.

The practical consequence is that the corpus runs above `MAX_EVENTS` sooner and more often,
which is the same pressure B2 governs. The two clauses are reasoning about one quota and are
stated together here for that reason: A3 makes the condition B2 calls predicted rather than
exceptional materially more likely. If the ceiling binds, the response under I9's standing rule
is to narrow what is recorded, never to re-merge the rows or to trim silently.

**Coverage becomes a stream rather than a stamp,** and reading it becomes a fold. This is the
same shape as the v4 episode removal and the τ removal: a value that looked constant turns out
to be a derivation over events, and moving it makes the corpus able to state something it
previously could only assert.

**A live second history is brought inside the corpus.** B3 admits a signal that ships today
into a store outside it. Until that lands, the feedback counters remain the authoritative
record of user judgement and the corpus does not see them — a contradiction that is now
recorded and dated rather than latent.

**Replication acquires a precondition.** B4's replica register is a constraint on any future
sync design, and it is cheaper as a constraint than as a retrofit.

**The verification layer gains an obligation it will not satisfy for free.** C1 requires a
structural proof that a seam is reachable, which is more than a suite assertion and will cost
real work. The alternative is a coverage record whose only guarantee is that two constants
agree with each other.

**Not yet proven:** that A1's mint-on-mismatch rule actually detects the copy case in practice —
it is reasoned from the volume lifecycle and has never been exercised, because the portability
feature it guards does not exist yet; that the τ fold stays cheap at ceiling, which is
configuration until measured per A2; that coverage-change volume is as bounded as B1 argues,
which assumes capabilities load once and do not flap under memory pressure — the one case B1
forbids sampling away is also the case that would falsify its volume estimate. If any fails,
the response is to narrow what is recorded, never to weaken I2, I9 or I12.

**Known defect, present rather than anticipated:** concurrent recorders on one volume destroy
rows today (A1). This is not in the list above, because that list holds claims awaiting
evidence and this one has it — two tabs on one origin reproduce it, the persistence path
overwrites whole state, and nothing counts the loss. It is recorded here so it is not mistaken
for a risk that has been priced.

**What this ADR does not settle:** any new producer. Attention observation remains a later ADR.
Human operation identity and export boundaries remain ADR-017 implementation increments under
U6/U7/U8 and need no new decision here. The command-plane producer that B5 defers is named but
not specified. C1 states the proof obligation and deliberately not the mechanism, and defers
its runtime half. **A1 requires single-writer discipline over a volume and does not specify the
mechanism** — lease, lock or election is an implementation decision, and the clause settles only
that concurrent writers are a defect rather than a case for ordering policy to absorb. Nothing
here ships a runtime change; ADR-013 Phase 0 keeps the implementation front, and implementation
of everything above waits behind it.

## Revision record

**Revision 1 — 2026-08-04, review pass.** Eight findings; all eight ruled on, none deferred
silently. Recorded rather than applied silently, on the same principle this ADR applies to the
documents it amends.

| # | Clause | Change | Why |
|---|---|---|---|
| 1 | A1 | Named the missing second operand (install-local identity outside the volume); argued the partial-clear false boundary as safe via the must/must-strive asymmetry; **ruled on concurrent recorders** | As drafted the comparison had one operand and could not detect the case it exists for. The concurrency case is live in shipped code, and the code makes it worse than the review's framing — whole-state overwrite, not interleaving |
| 2 | B4 | Defined replication as mediated vs unmediated; scoped the register requirement to mediated; ruled that erasure does not reach an unmediated copy | The undefined term made B4 forbid the case A1 detects. The two clauses are complementary over disjoint cases; one word for both concealed it |
| 3 | B1 | Opening snapshot relabelled a **declaration** until C1 is satisfied | The draft called witnessed a value C1 proves unchecked — the I3 contamination pattern, committed by the document applying I3 |
| 4 | A2 | Stated the ruling is storage-location only and runtime τ is unaffected; admitted `surprise` as an instrument reading under I5 and bound it to `tauPolicy`'s amended meaning | The clause read as "τ ceases to exist" and left a derivation inside `tauInputs` unattributed — the same L12 violation that got τ rejected in v4 |
| 5 | B2 | Recovery emits one row per occurrence with a bounded buffer and overflow marker, replacing a persisted count | A sum is arithmetic; Part B may not spend what Part A refuses `dτ` |
| 6 | Consequences | Added E9 pinning: the begun row of every completed pair becomes non-evictable | The doubling was stated; the loss of evictable surface was not, and B2's quota reasoning depends on it |
| 7 | C1 | Claimed exactly "a seam was not deleted"; substituted the live `kernelDiagnostics` example; deferred the runtime tripwire with its cost named | A module-graph proof cannot establish execution, and the clause implied more than it delivers |
| 8 | B3 | Judgement rows carry an observed `refs` to the judged decision; record *which* judgement, not its sign; the 60-second implicit reject stays a derivation | U9's admissibility condition is met at this one seam. The code shows two distinct negative-judgement semantics and an implicit path that must not be admitted |

**Premises corrected during the pass.** Finding 7 cited ADR-012 as closing with eight live
flags, five defaulting OFF. That was the pre-closeout state: S7.2 removed all eleven rollout
flags and one observability control survives by design. The finding's argument is unaffected
and its example is stronger after correction — recorded here under the same rule that governs
the five premise corrections in the original draft.

**Revision 2 — 2026-08-04, approval pass.** Two changes, both sequencing rather than substance.

| # | Clause | Change | Why |
|---|---|---|---|
| 1 | **A5 (new)** | No new write settled here is wired until single-writer discipline exists. Gates A3, B1, B2, B3 | The ADR admits a live signal (B3) into a substrate it separately proves loses rows silently and uncounted (A1). Wiring before closing commits the I9 violation the document exists to close. Extends this ADR's own clause set by one, on ADR-011's precedent |
| 2 | B1 | Upgrade condition made explicit: the opening snapshot becomes an observation on C1's **runtime tripwire**, not on its static proof | "Once C1 is satisfied" was ambiguous once C1 acquired two halves. The static proof cannot clear I2 — a call site behind a never-taken condition is exactly the disagreement I2 tests for |

Neither changes a ruling made in Revision 1. A5 orders work that was already unscheduled; B1's
amendment tightens a condition that was already conditional.

**Revision 3 — 2026-08-04, notes only. No clause, ruling or status changed.** ADR-018 was
locked at Revision 2; these are non-normative notes recorded against clauses so a later reader
does not have to rediscover them. They are marked as notes in the text and carry no normative
force.

| # | Clause | Note |
|---|---|---|
| 1 | B3 | What the licensed implicit-reject derivation actually has available: proximity under a named policy, not attribution — U5 leaves the undo's target unwitnessed and the `human.operationIdentity` gap leaves its content unwitnessed. A3's `seq` range makes the proximity claim ordinal rather than clock-based, which is stronger under I5, and it remains proximity |
| 2 | A2 | `tauPolicy` now carries a τ-input capture attribution and a ledger attribution that will version on different schedules; one identifier cannot say which moved. The first ledger revision is the moment to split it — not earlier, and not after rows exist under an ambiguous value |

Both were raised at approval and are recorded rather than acted on, per the standing rule that
a named defect left unrecorded is worse than one never named. Neither is a defect in a ruling;
both are limits on what a ruling delivers.
