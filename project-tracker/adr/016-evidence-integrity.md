# ADR-016 — Evidence Integrity

- Status: **Accepted**
- Normative: Yes (I1–I14)
- Date adopted: 2026-08-02

```
Depends on:
  ADR-014 (Experience Stream: append-only, immutable rows, producer boundaries, provenance
           outranks retention, observations over classifications)
  ADR-015 (Decision Evidence: what one producer's payload preserves)
  ORIS_CALCULUS.md (L11 witnessed-or-derived; L12 every derivation names its policy;
           L13 artifacts are outputs; §5.0 the four persistence classes)
  ORIS_ARCHITECTURE.md (ORIS-18, ORIS-19, ORIS-20, ORIS-21)

Scope: the conditions under which a record may be trusted, and what must be true of the
       machinery that establishes them. Applies to every producer, present and future,
       and to the verifiers that certify them.

Renumbering: ADR-014's header reserved 016 for outcome capture. That contract cannot be
       written before this one — a producer defined against an untrustworthy substrate
       inherits the untrustworthiness. Outcome/user-action capture moves to ADR-017.

Implemented by: ORIS Stage A
```

## Context

ADR-014 settled the shape of the journal and ADR-015 the content of its first payload. Both
assumed something neither of them stated: **that a row, once written, means what it says.**

That assumption is doing more work than any decision in either document. Every capability the
programme intends to build — calibration, attribution, consolidation, competence, identity —
is a function over the corpus. A function over corrupt input produces corrupt output with
full confidence and no external symptom. There is no downstream check that can recover from
an upstream fabrication, because nothing downstream can tell a fabricated row from a witnessed
one; that is what makes the row fabricated.

So trust in the corpus is not one property among many. It is the **ceiling** on trust in
everything computed from it, and it is established once, at admission, or not at all.

The governing question is therefore not "is this row useful" or even "is this row correct."
It is:

> **Under what conditions is the organism allowed to trust a piece of evidence?**

Everything below is derived from that question. The derivation is deliberately not organised
around the failures we have already seen — those appear only at the end, as evidence that the
architecture bites.

## Decision

### The root

**I1 — Trust is a property of the process that admitted a record, never of the record
itself.**

A row cannot vouch for itself. Nothing in the content of a well-formed fabrication
distinguishes it from a well-formed observation: both have a producer field, both have a
timestamp, both parse. Content-level validation can detect malformed rows and can never detect
dishonest ones.

Therefore trust must be established *at admission* — the one moment when the recorder, the
occurrence, and the act of recording are all present — and every rule after this one is a
**preservation** rule, protecting a property that can only be created once. This is why
integrity is settled before any new producer exists rather than after: a producer admitted
under weaker rules cannot be retroactively strengthened, and its rows cannot be
distinguished from the rest.

Corollary: the corpus has no repair path. Not "repair is expensive" — there is no operation
that converts an untrustworthy corpus into a trustworthy one, because the information required
to do so is exactly the information that was not captured.

### What may be admitted

**I2 — The admission test is the sole gate on evidence.**

> **Could two honest observers disagree about whether this occurred?**

If no, it happened, and it may be recorded. If yes, it required a policy to establish, and it
is a derivation — computed on read, never written as observation. (Calculus L11; ORIS-19.)

The test is stated in terms of *honest* observers deliberately. It is not about error or
malice; it is about whether the value is a fact about the world or a fact about a policy. Two
observers with different segmentation policies disagree about where an episode begins while
both being entirely honest. That disagreement is the signature of a derivation.

**I3 — Admission is per-field, not per-row.**

A row whose kind is unimpeachably witnessed may still carry fields that are not. The unit of
admission is the smallest independently interpretable value in the record, and the test is
applied to each one.

This is the clause most likely to be skipped, because the row-level question is easy and
almost always passes: *did a decision occur?* Obviously. The interesting question is whether
each field of that decision was witnessed, and the answer is routinely no for at least one of
them. A derived value riding inside a witnessed row is the most dangerous form of
contamination available, because the row's admissibility appears to have been checked.

**I4 — A derived value carried on an evidence row is a defect, not an optimisation.**

Where a value fails I3, it does not become admissible by being convenient, cheap to compute at
write time, or already present. It moves to the read path. If computing it on read is
expensive, that is a performance problem with known solutions; storing it as evidence is an
integrity problem with none.

### Where a record sits

**I5 — Ordering authority belongs to the recorder's sequence, never to a clock.**

The reframing that settles this: **a timestamp is not the time. It is an observation of what
an instrument reported.** The recorder directly witnesses "this is the *n*th thing I have
recorded" — that is a property of its own act, admissible under I2. It does not witness "it is
14:03"; it witnesses that a clock said so, and the clock is an external, uncalibrated,
adversarially-adjustable instrument shared with the operating system, the network, and the
user.

Wall clocks jump. They are corrected by NTP, shifted by timezone and DST changes, frozen
across suspend, and set by hand. None of those events is observable in the reading itself. A
corpus that orders by timestamp is a corpus whose causal structure can be rewritten by a clock
correction, silently and retroactively.

So: **every question about order is answered by sequence. Every question about elapsed wall
time is answered by timestamps, and is a measurement with unknown error.** An analysis that
mixes them must say which it used for what.

**I6 — Any value computed by arithmetic on two timestamps is a derivation.**

Durations, gaps, rates, latencies, idle intervals. Each is a difference of two instrument
readings, and inherits the error of both — including discontinuities the readings cannot
report. Such values are computable, useful, and frequently necessary; they are simply not
evidence, and under I3 they may not be stored on an evidence row.

The pair of raw readings is admissible; their difference is not. This is the same asymmetry
ADR-015 D8 reached from a different direction — there, because a scalar destroys overlap; here,
because a scalar destroys the distinction between a measurement and an inference about a
measurement. Two independent derivations reaching the same rule is mild evidence the rule is
real.

**I7 — Sequence is authoritative only within one recorder.**

A sequence counter is a witnessed property of one recorder's own act. Across two recorders —
two devices, two seats, two profiles — no such witness exists, and there is no clock that can
supply one, by I5. Cross-recorder ordering is therefore a derivation under a named policy, and
must be treated as such however obvious a particular merge looks.

The structural obligation this creates: **recorder identity must be recoverable from the
corpus for every row**, or the corpus cannot even state which orderings it is entitled to. An
unlabelled merged corpus is not merely hard to order; it is permanently unorderable, and no
later analysis can undo the merge.

### Derivations

**I8 — Every derivation names its policy, and every named policy is retained.**

L12 requires the name. This ADR adds the second half, which L12 implies and does not state:
**a policy identifier that no longer resolves to a policy is not a citation, it is a
decoration.** A derivation attributed to `segmentation.v1` is reproducible only while `v1`
still exists somewhere it can be run.

Therefore policy implementations are *superseded, never deleted* — which places them precisely
in the fourth persistence class (Artifact, calculus §5.0/L13): produced by the organism,
immutable, addressable, outside the stream, referenced by the things that used them. That the
classification falls out cleanly rather than needing a fifth class is a point in favour of the
four.

What this buys is the thing the whole derivation discipline exists for: `accepted(policy=v1)`
and `accepted(policy=v2)` may legitimately disagree about the same corpus, and **both remain
runnable**. Without retention, the older answer is unreproducible and the comparison — which
is how we learn the policy improved — cannot be made at all.

### Failure

**I9 — Failed admission is refused at write: loudly, countably, and without repair.**

A record that fails the test is not written, not defaulted, not coerced into a valid shape, and
not silently discarded. It is refused, and the refusal is counted in a place someone looks.

The reasoning is asymmetric and decisive. A refused write loses one observation, visibly. An
admitted-but-wrong write corrupts the corpus invisibly and permanently, and — because nothing
downstream can identify it — devalues every row around it. The costs are not comparable, so
the policy does not need to balance them.

Silent discard is the specific failure this clause exists to forbid. It is the intuitive
defensive-programming reflex, it always looks like robustness, and it converts a loud failure
into a corpus that is quietly smaller than it claims to be. **A corpus that silently shrinks
is worse than one that loudly breaks**, because size and coverage are inputs to every
conclusion drawn from it.

**I10 — Error paths may not fabricate observations.**

A degraded write path records the degradation, or records nothing. It may never substitute a
plausible value for an unavailable one, and it may never let an error be recorded as a normal
occurrence of a different kind.

This is I2 applied to the code path nobody exercises. The admission test does not exempt
exception handlers: if the fallback value is one that two honest observers would dispute, the
fallback is a fabrication regardless of the good intentions of the `catch` block that produced
it. Fabrications born in error paths are the hardest class to detect afterwards, because they
are indistinguishable from correct rows *and* they cluster around exactly the moments when
something interesting was happening.

**I11 — Rows found untrustworthy after the fact are quarantined by derivation, never by
mutation or deletion.**

This is forced, not chosen. Append-only (E2) forbids deletion; immutability (E7) forbids
marking the row in place. The only remaining consistent option is that quarantine is a
**read-time filter under a named, versioned policy** — a derivation like any other, owing I8.

The result is better than the alternatives it was forced to replace. The corpus can be
*corrected for analysis* without being edited: the quarantined rows remain, the reason is
named and versioned, the exclusion is auditable, and a later judgement that the quarantine was
mistaken is a policy revision rather than an unrecoverable loss. A deletion would have been
irreversible and invisible; a mutation would have made the corpus's past a function of when it
was last read.

Quarantine propagates **forward along provenance**: a row that depends on a quarantined row
inherits suspicion transitively. This is the mirror of retention's backward closure (E9) over
the same DAG — evidence is conserved backwards, doubt propagates forwards — and the symmetry
is the reason one edge set can serve both.

### Coverage

**I12 — Observation coverage is itself evidence, and must be recorded as it changes.**

What the corpus was *capable of observing* at a given moment is not recoverable from what it
recorded. An absent value has two causes — the thing did not happen, or nothing was watching —
and they are indistinguishable in the data. Everywhere. Permanently.

E11's corollary ("an unobserved value is recorded as unobserved, never as a default") makes
the distinction visible *within* a row. It does not answer the question one level up: *was this
field capable of being populated in this build?* A field that reads null across an entire
period may mean the organism was in an unusual state for a year, or may mean the seam was
wired the following Tuesday, and those support opposite conclusions about everything measured
in that window.

So the set of active producers, wired seams, and observable fields is part of the record — a
witnessed property of the running system, admissible under I2, belonging naturally to the
scope within which it is constant. Recovering it from build metadata, source history, or
memory is not sufficient: those are outside the corpus, are not guaranteed to survive it, and
in the common case where build identity is unknown they resolve to nothing at all.

This is the clause with the least intuitive appeal and, on the evidence so far, the highest
expected value. It is the difference between a corpus that can say *"I did not observe this"*
and one that can only say *"this is not here."*

### The verifiers

**I13 — A verifier must prove it ran. A verifier that cannot distinguish "passed" from "did
not run" is worse than no verifier.**

A check emits a signal with two possible causes: the property holds, or the check did not
execute. If the output is identical in both cases, the check carries **zero information** — and
worse than zero in practice, because its consumer treats a null result as a positive one.
Absence of complaint is not evidence of correctness; it is evidence of silence, and silence has
many causes.

Therefore every verifier must produce a *positive* proof of execution — a structural artefact
that cannot exist unless the work was done, not a claim that it was. And the requirement is
recursive by construction: the proof itself must fail loudly when absent, or it has merely
moved the same ambiguity one level up.

The stronger form, which is the operational one: **a verifier's failure mode must be noisy by
design.** Where silence is the ambiguous signal, correctness requires arranging that failure is
never silent — not that success is well-reported.

**I14 — Verification machinery is part of the trusted computing base and is governed by this
ADR.**

Once architectural claims rest on acceptance suites, those suites are **instruments producing
evidence about the system**, and every rule above applies to them: they may not fabricate a
pass (I10), their failures may not be silently swallowed (I9), and their results are only as
trustworthy as their proof of execution (I13).

The practical consequence is a claim about scope: a suite that is not itself checked is not
part of the trusted computing base — it is an *unverified assertion about* the trusted
computing base, and its green result means only that it did not throw. A suite excluded from
the type checker can assert against a property that no longer exists and pass forever. **The
corpus and the machinery that certifies it are one system, and the weaker of the two sets the
ceiling on both.**

Corollary, and the reason this is a decision rather than an observation: **integrity
regressions in the verification layer are corpus defects and carry the same severity.** They
are not tooling chores to be scheduled behind product work.

## Alternatives considered

**Validate rows at read time instead of gating at write.** Rejected under I1. Read-time
validation catches malformed rows and is structurally incapable of catching well-formed
fabrications, which are the entire threat. It also arrives after the only moment at which the
missing information existed.

**Order the corpus by timestamp; it is what everyone means by "when."** Rejected under I5.
It is the intuitive design, it works until the first clock correction, and its failure is
retroactive and silent — the corpus does not change, its interpretation does. Timestamps are
retained and remain the right answer for anything a human reads; they are simply not the
authority on order.

**Store derived values on evidence rows when they are cheap and obviously correct.** Rejected
under I3/I4. "Obviously correct" is a claim about today's policy, and every policy in this
programme is expected to be revised. The derived value then becomes a second, frozen,
unversioned answer that silently contradicts the live one.

**Correct bad rows in place; the corpus is ours to fix.** Rejected under I11 and ADR-014 E7. A
corpus whose past can be edited cannot support any claim about development, because the claim
and its evidence would be mutually adjustable — and the edit is undetectable afterwards.

**Delete rows found to be corrupt.** Rejected under I11. Irreversible, invisible, and it
destroys the record of the corruption, which is itself the most interesting evidence about the
period in question.

**Skip malformed rows on load and carry on.** Rejected under I9. It is the standard defensive
reflex and it produces a corpus that is quietly smaller than it reports, which corrupts every
coverage-, rate-, and growth-based conclusion drawn from it — the same class of measurement
that motivated collecting the corpus.

**Recover observation coverage from build identity and source history when needed.** Rejected
under I12. It makes the corpus's interpretability depend on artefacts outside the corpus that
are not guaranteed to outlive it, and it fails completely whenever build identity was not
captured — which is precisely the case where nobody was paying attention, i.e. the common one.

**Treat verifier reliability as a tooling concern beneath the architecture.** Rejected under
I14. The architecture's claims are *carried by* the verifiers; a false pass and a false row
have the same effect on everything downstream, and the distinction between them is
organisational, not epistemic.

**Trust the verifier's own report that it ran.** Rejected under I13. That is the failure being
guarded against, restated as its own solution.

## Consequences

**Trust becomes checkable rather than assumed.** Every clause above is stated so that a
specific record, field, or tool can be tested against it and can fail. That is the point: the
previous state was not "trusted" but "unexamined."

**New producers are cheaper to admit and harder to admit carelessly.** ADR-017 and everything
after it inherit a settled contract instead of negotiating integrity per producer — but they
must pass a per-field test rather than a per-row one, and must declare their coverage.

**Some values move from the write path to the read path,** and read-time cost rises. Accepted
under I4: the exchange is a known performance cost for an unknowable correctness cost.

**Policies accumulate rather than being replaced.** I8 makes policy retention mandatory, which
means a growing set of small, immutable, runnable artifacts. This is a real cost and it buys
the only thing that makes derivation-over-storage worth doing: the ability to compare two
policies' readings of the same history.

**Quarantine, not repair, becomes the standard response to discovered corruption.** Teams
reach for deletion by reflex; I11 forecloses it, and the discipline will feel wrong the first
few times.

**The verification layer becomes load-bearing and is budgeted accordingly.** I14 means suite
integrity is not deferrable work. The cost is ongoing; the alternative is architectural claims
whose evidence nobody checked.

**Not yet proven:** that per-field admission is tractable at the volume of producers this
programme anticipates, and that observation-coverage recording stays small enough to be
free. Both are empirical. If either fails, the response is to narrow what is recorded — never
to weaken I2 or I12, which would trade a known cost for an unknowable one.

**What this ADR does not settle:** which producers exist, what any of them observes, how
outcomes are joined to decisions, or where the corpus is stored. It settles only what must be
true of any answer to those questions. The first of them is ADR-017.
