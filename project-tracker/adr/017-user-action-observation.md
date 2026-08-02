# ADR-017 — User-Action Observation

- Status: **Accepted**
- Normative: Yes (U1–U12)
- Date adopted: 2026-08-02

```
Depends on:
  ADR-014 (Experience Stream: envelope/payload, producer boundaries, append-only)
  ADR-015 (Decision Evidence: the `ai` producer's payload)
  ADR-016 (Evidence Integrity: I1–I14 — when a record may be trusted)

Scope: the second producer — what the editor witnesses when the composition changes.
       Says nothing about how outcomes are scored, or what any later producer records.

Design record: plans/oris-outcome-seam-design.md (§9 resolutions, §12 empirical findings,
       §13 stress test, §14 measurements)

Every clause below describes a boundary that was OBSERVED working, at runtime, in the real
editor. Nothing here rests on a code reading or a typecheck.
```

## Context

ADR-016 settled when evidence may be trusted. This is the first producer defined under it, and
it was deliberately written last: a producer specified against an untrustworthy substrate
inherits the untrustworthiness, and one specified against an *imagined* boundary inherits
something worse — fields nobody observes, which cannot be distinguished from fields that were
observed and found empty.

The design that preceded this ADR was wrong in three places, and each was found by measurement
rather than review:

- It named the **Timeline Action Registry** as the observation point. The registry is
  AI-only in the shipped product; every human edit reaches `updateGraph` without passing
  through it.
- It claimed a **user's undo of an AI edit** was observable linkage. The undo stack holds
  whole-composition snapshots, so the occurrence is witnessed and its target is not.
- It assumed the editor had **one commit grain**. It had two: timeline gestures committed once,
  parameter gestures committed per pointer-move — 20 writes and 19 undo entries for one slider
  drag.

Those are not review findings. Every one of them would have been frozen into the first
producer, and the third would have made the corpus's most common row type meaningless.

## Decision

**U1 — The producer witnesses user actions. It never records outcomes.**
There is no outcome producer and there will not be one: *accepted*, *rejected*, *ignored*,
*good* are interpretations, and interpretations have no natural observer (ORIS-19). One
decision has many outcomes — kept now, adjusted in ten minutes, reverted next month — and
outcomes arrive unboundedly late, so any stored verdict is a claim a later event falsifies
inside an append-only store that forbids correction. *"The outcome of a decision"* is a
read-time query over a window, and storing raw actions lets every window be applied
retroactively while storing a verdict freezes exactly one.

**U2 — The observation point is the composition write choke point, not the action registry.**
The registry is the natural owner of *AI-initiated registry actions*; it is not the path human
edits take. The choke point is where both arrive, and it is the only boundary that sees every
committed change to the composition.

This is a correction, not a preference: the registry's attraction was that it "already sees
authorship," and it does not — it never sees a human edit at all.

**U3 — One committed transaction is one gesture, and the signal is the history entry.**
A producer keys on **whether an undo entry was pushed**. Not on the number of graph writes — a
parameter drag makes twenty, all driving live preview. Not on the history-recording flag —
that is true for all twenty, because coalescing happens inside that branch.

This is the clause most likely to be implemented wrongly, because two nearby properties look
like it and both are off by the length of a gesture.

**U4 — Interaction that does not change the composition produces nothing.**
Playhead movement, scrubbing, selection, panel navigation. This is not a filtering policy; it
is a measured fact about the seam — transport never reaches it. The corpus is therefore about
work, not about UI activity, without anyone having to decide what counts as meaningful.

**U5 — An undo is recorded as an occurrence, never as a rejection.**
Undo and redo reach the choke point distinguishably. What is witnessed is *that an undo
occurred*; what it undid is not, because the stack holds snapshots rather than commits. Under
I2 the causal reference is therefore absent, and *"the user rejected the AI"* is derived at read
time with all the uncertainty that carries.

This is the sharpest live instance of ADR-016's central split: an admissible occurrence whose
interpretation remains inadmissible. It would have been the most valuable signal in the corpus
and it is not available, and recording it anyway would have been undetectably wrong.

**U6 — Initiation is declared by callers that know, never inferred from absence.**
A commit carries an initiator only where a caller genuinely possessed that fact. Absence means
**undeclared** — it does not mean *user*. Treating an omitted declaration as evidence of a human
is the I10 fabrication pattern, and it is the specific error the seam was built to make
impossible.

**U7 — Operation identity is preserved where it exists, and is a list.**
Where a caller came through the registry and kept the action identity, it travels with the
commit. It is a **list**: one commit may carry several registry actions, and a scalar would
silently record only the last.

Identity is *preserved*, never *recovered*. Reconstructing it later from before/after
composition diffs would be a derivation on an evidence row (I3/I4), and it is unavailable
anyway — the corpus stores no composition snapshots to diff.

**U8 — Declaration coverage is recorded, and is what makes absence usable.**
The set of call sites that declare is a witnessed property of the running system and belongs in
the corpus (I12). With it, *"undeclared at a committed write"* licenses the derivation *"not
AI-initiated"* — at read time, under a named policy, justified by a recorded fact about what
the build was capable of declaring. Without it, every absence is permanently ambiguous.

This is the clause that converts honest absence into usable evidence instead of a hole, and it
is the reason I12 was worth insisting on before any producer existed.

**U9 — No causal reference unless the causal attachment was itself observed.**
An action row may carry a reference to a prior decision only where the affordance was bound to
that commit. Today no such binding exists, so no action row carries one. Proximity is not
causation, and an empty reference is the honest statement that no link was observed — it leaves
the derivation free rather than poisoning it.

**U10 — Observation at this seam is strictly additive and failure-isolated.**
The choke point is the most load-bearing path in the product: a regression there is a
data-integrity bug in the user's project. Observation may never alter commit semantics, block a
write, or propagate a throw. This is the rule already applied to the stream append, held
harder because the blast radius is the user's work.

**U11 — What an action row never contains.**
A quality judgement; an outcome class; an error class or tier; a confidence; an attribution to
any belief; any inference about intent; any causal reference that was not observed; any
initiator or operation identity that was not declared. **The producer records what happened; it
never records what it meant.**

**U12 — A field ships only after its observer has been watched working.**
Not typechecked, not code-reviewed — observed producing the value at runtime, through the real
path. This is a normative clause because the alternative was demonstrated during this ADR's own
verification: initiation and operation identity were wired across five files, typechecked
clean, and passed every negative test — while a wrapper silently dropped operation identity
from every plan-driven commit. Optional parameters make that class of defect invisible to the
compiler, and only a positive-direction observation catches it.

## Alternatives considered

**An outcome producer emitting `{ kind: "rejected", refDecision }`.** Rejected under U1/U9. Both
fields are interpretations the editor has no standing to make, and it was the design this
programme started from.

**Observe at the Timeline Action Registry.** Rejected under U2 — and it was the plan of record
until the call sites were read. It would have produced a corpus containing only AI edits while
appearing to contain all of them, which is worse than an obviously empty one.

**Key transactions on graph writes, or on the history-recording flag.** Rejected under U3. Both
are available, both look correct, and both count a parameter drag as ~20 user actions.

**Infer `user` from the absence of an AI declaration at write time.** Rejected under U6/U8. The
same conclusion is available as a read-time derivation licensed by coverage, which keeps it
revisable and keeps the corpus honest. Writing it costs nothing today and is unfixable later.

**Record a causal link between an undo and the commit it reverses.** Rejected under U5/U9. It is
the single most valuable signal the corpus could hold, which is exactly why fabricating it
would have been so damaging.

**Recover operation identity from composition diffs.** Rejected under U7. A derivation on an
evidence row, and not computable — nothing stores the snapshots it would need.

**Sample high-frequency writes to bound volume.** Considered and unnecessary. Measurement showed
the commit boundary already sits at the human grain once U3 is honoured, so no sampling policy
exists to define. Had it been necessary, ADR-016 permits it only with the sampling policy
recorded as coverage.

## Consequences

**The corpus records work, not activity.** U4 and U3 together mean rows correspond to what a
human would call a change. No filtering heuristic was needed to achieve it.

**Attribution is possible for AI edits and derived for human ones.** U6 plus U8 gives a sound
basis for both without a fabricated field. Human-side operation identity remains unavailable —
57 call sites each know their operation and none declares it — and that gap is recorded rather
than guessed.

**Two live product consequences, both outside this ADR.** Parameter drags still issue ~20 graph
writes serialising at ~1 s each; that is a performance defect, separate from the grain, and
deliberately not fixed here. And human-side declaration remains unwired, which is the natural
next increment if attribution proves valuable.

**Not yet proven:** that the observation set is sufficient for calibration and attribution at
realistic volume, and that declaration coverage stays cheap. Both are empirical. If either
fails, the response is to narrow what is recorded — never to weaken U6 or U8, which would trade
a known limit for an unknowable one.

**What this ADR does not settle:** how outcomes are derived, how predictions are scored, how
episodes are cut, or what any later producer records. It settles only what the editor witnesses
when the composition changes.
