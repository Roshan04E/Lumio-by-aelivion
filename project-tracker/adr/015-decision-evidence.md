# ADR-015 — Decision Evidence Schema

- Status: **Accepted**
- Normative: Yes (D1–D10)
- Date adopted: 2026-08-02

```
Depends on:
  ADR-014 (Experience Stream: envelope/payload, producer boundaries, observations over
           classifications, immutable evidence)
  ORIS_CALCULUS.md (phases ①②④⑤; L2 "no credit without a claim"; L3 "no adaptation
           without attribution")

Scope: the `ai` producer's payload — what one decision records about itself.
       Says nothing about any other producer.

Implemented by: ORIS Stage A
```

## Context

ADR-014 settles the *shape* of the journal. This ADR settles the *content* of its first
payload: what an AI decision preserves about itself at the moment it happens.

The question is narrower than it sounds, and it has one right test. A decision already
produced a human-readable trace — a route label, a list of step summaries, an applied/failed
count — enough to answer *"what did you just do?"* in a chat panel. That surface is adequate
for explanation and **inadequate as evidence**, for a reason that only appears later: the
prose is a *summary of state that is now gone*. The facts consulted have since been
invalidated. The alternatives considered were never written down. The confidence was computed
and discarded. None of it can be recovered, and every one of them is required by a phase we
intend to build.

So the governing question for each field is not "is this useful now" but **"if we do not
record this at the instant it exists, can it ever be recovered?"** Where the answer is no, the
field is recorded now, while the corpus is empty and adding it is free.

## Decision

**D1 — A decision records observations, not a summary of itself.**
The human-readable rendering is retained, but it is a *view*, never the record. Prose is
one-way: a summary can always be generated from structure, and structure can never be parsed
back out of a summary with confidence. Everything the summary was derived from is stored
beside it. (ADR-014 E11, applied to one payload.)

**D2 — The situation is snapshotted at the moment of decision.**
Which project, which composition, what was selected, what mode and focus were active. This is
calculus phase ②, and without it two identical asks made in different contexts are
indistinguishable in the corpus — which would make context-scoped analysis impossible and
silently mislead any segmentation that tries to cluster work.

The situation is **state, not an event**: it is true until changed, rather than something that
occurs. It is therefore maintained as standing state and *snapshotted* on write, not
accumulated as occurrences. This distinction is load-bearing — modelling it as an event stream
would make "what was true then" a reconstruction rather than a reading.

**D3 — Facts consulted are snapshotted with their values and provenance, scoped to exactly one
decision.**
This is the sharpest instance of the recoverability test in the whole schema. The fact store
cascade-invalidates: the value a decision relied on is *destroyed* the moment its inputs
change. The snapshot is the only thing that survives, and without it attribution can never ask
"what did it believe about the footage when it made that call?"

The scoping is equally deliberate: **a fact belongs to exactly one decision.** Evidence
collection is explicitly opened and closed per decision, facts observed outside an open scope
are refused rather than carried forward, and an abandoned scope is discarded rather than
merged. A drain-on-next-write buffer would be simpler and would silently attribute one
decision's evidence to the next — a contamination that is invisible at write time and surfaces
much later as attribution that inexplicably "looks wrong," with no way to identify which rows
are affected. Contamination is made impossible rather than unlikely, and any occurrence is
counted and surfaced rather than swallowed.

**D4 — The owner of the claim is recorded structurally.**
Which tier, which rule, which recipe, which provider — as data, not as the display label that
happens to mention them. Calculus L3 forbids adaptation without attribution, and attribution
needs a *referent*, not a string to parse. Display labels are written for humans and change
for cosmetic reasons; a corpus that depends on parsing them breaks silently on a wording
change and cannot be repaired retroactively.

**D5 — Actions are recorded structurally, alongside their prose.**
The registry action and its target, not only "Applied Noir @ 55%." This is what makes a
decision replayable and makes attribution able to name the operation that failed rather than
the turn that contained it. Where a step is not a registry action, it is **omitted rather than
given a placeholder** — a fabricated identifier is worse than an absent one, because it is
indistinguishable from a real observation.

**D6 — The confidence claimed at decision time is recorded.**
The system already forms a confidence and then discards it. Calibration — *how often is it
right when it says it is sure* — is arithmetic over claims and outcomes, and is not merely
harder without the claim but **impossible**: there is nothing to score. Recording it is the
minimum precondition for the system ever knowing what it knows.

**D7 — Candidates are recorded, including the rejected ones.**
The chosen hypothesis carries almost no information; the *distribution* carries nearly all of
it. A winner at 0.91 against a runner-up at 0.90 and the same winner against a runner-up at
0.12 are radically different internal states that produce identical outcomes, and the
difference is exactly what a later question — *why does it keep asking for clarification
here?* — needs.

Counterfactuals are the most irrecoverable class of observation in the system. What happened
can always be replayed; what was *almost* chosen exists only during deliberation and is gone
the instant it ends.

**D8 — Start and finish are recorded as a pair, never as a duration.**
A scalar latency destroys *temporal overlap*. It can never establish that a slow decision
coincided with an interruption, a resource stall, or another decision — and those correlations
are precisely what a self-model needs in order to attribute a failure to the body rather than
to the reasoning. Duration is derivable from the pair; the pair is not recoverable from the
duration. The subtraction is a classification, and D1/E11 forbid classifying at write time.

**D9 — New observations are optional during staged rollout, and absence is recorded honestly.**
Widening the observation surface must never require a coordinated change across every
producer of a decision. New fields are therefore introduced as optional, and existing writers
remain valid unchanged.

The corresponding obligation: **an unobserved field is recorded as unobserved, never as a
default.** A zero, an empty string, or an empty list in place of "not measured" makes a
staged rollout permanently indistinguishable from a measured absence, and the corpus cannot
be repaired afterwards because the distinction was never captured. Optionality is a rollout
mechanism; it is not permission to fabricate.

**D10 — Beliefs are deliberately not recorded.**
A decision records what it *observed* and what it *claimed* — never what it concluded about
itself or the user, and never how any belief changed.

Two reasons, both structural. First, at runtime a belief is state, but *across time a belief
is a view over the experience stream under a consolidation policy*: given a complete corpus,
belief state is re-derivable — and re-derivable under a **revised** policy, which is the
entire point. Snapshotting beliefs would create a second source of truth that could not be
re-derived when the rules improve. Second, recording belief deltas now would require
committing to a belief schema before the observations that should shape it exist, which is the
classification-before-observation error this programme exists to avoid.

## Alternatives considered

**Keep the prose trace and parse it later.** Rejected under D1/D4. It is free today and
converts every future analysis into a fragile parser against a string written for humans.

**Record a summary of the facts consulted rather than their values.** Rejected under D3. The
values are the part that is destroyed; a summary of destroyed values cannot be reopened.

**Collect facts in a buffer that drains on the next write**, matching how boundary signals are
collected. Rejected under D3. The failure mode differs by orders of magnitude: a late signal
is harmless, a mis-attributed fact is silent corruption of the evidence base.

**Record latency.** Rejected under D8, and it was the original design. Overlap is unrecoverable
once the subtraction is made.

**Record only the winning hypothesis.** Rejected under D7 — it discards nearly all of the
information the deliberation produced.

**Record belief updates as they happen.** Rejected under D10. It is the intuitive design and it
would freeze a belief schema invented ahead of its evidence, while duplicating state that is
re-derivable from the stream.

**Wait until every field can be captured, then introduce them together.** Rejected under D9.
It would delay the corpus indefinitely in exchange for tidiness, and the corpus is the thing
whose absence cannot be recovered.

## Consequences

**Calibration, attribution, and counterfactual analysis become possible in principle.** D6
supplies the claim, D4 the referent, D3 the evidence, D7 the alternatives. None of these is
implemented by this ADR; all of them are blocked without it, which is why it is written now
rather than when they are built.

**A decision costs more to record.** Materially more per row than a prose trace. Accepted
deliberately: the alternative is a cheap corpus that cannot answer the questions it was
collected for.

**Rollout is staged and visibly incomplete.** Several observations are specified here and not
yet captured at every seam. D9 makes that state legible rather than silent — an unwired field
reads as unobserved, and the gap is a known quantity rather than a discovery.

**Not yet proven:** that the fully enriched observation set can be captured at every decision
seam without disturbing the runtime, and that its storage cost is sustainable at realistic
usage. Both are empirical and neither is settled by this ADR. If either fails, the response is
to narrow which observations are recorded — never to weaken D9 by substituting defaults for
absences, which would trade a known limit for an unknowable one.

**What this ADR does not settle:** how outcomes are captured and joined to decisions, how
claims are scored, or what any other producer records. The first of those is the next
architectural boundary and will carry its own ADR.
