# ADR-014 — Experience Stream Architecture

- Status: **Accepted**
- Normative: Yes (E1–E14)
- Date adopted: 2026-08-02

```
Depends on:
  ORIS_ARCHITECTURE.md   (the organism; ORIS-1, ORIS-4, ORIS-8, ORIS-9, ORIS-17, ORIS-18)
  ORIS_CALCULUS.md       (state E; laws L1, L8, L9; the eight phases)
  ORIS_TIME.md           (two clocks; the band ladder)

Extends:
  ORRERIS_OS.md Layer 2  (the fact store — unchanged; this sits beside it, not over it)

Implemented by: ORIS Stage A
Followed by:    ADR-015 (decision evidence), ADR-016 (outcome capture — not yet written)
```

## Context

The runtime's knowledge layer is **amnesic by design**. The fact store holds one live fact per
`(type, target)` and cascade-invalidates it the moment its inputs change: a fact read today is
destroyed when its clip is trimmed. That is exactly right for facts — a graph that confidently
reports last week's histogram is worse than no graph — and it means **no component in the
running system can answer "what happened, and in what order."**

Everything the cognitive programme intends to build is a function of that history. Calibration
is claims scored against outcomes over time. Attribution is error traced to the belief that
produced it. Consolidation is pattern extraction across episodes. Competence, growth, and
identity are all trajectories. None of them can be computed from current state, and — this is
the decisive property — **history cannot be reconstructed retroactively.** A year of missing
observation is a year that must be re-lived.

So the decision recorded here is not "add logging." It is the establishment of the substrate
that every later cognitive capability is a *view* over, at a moment when the corpus is empty
and its shape is still free.

## Decision

**E1 — The Experience Stream is the runtime's history substrate, and the only one.**
Facts are caches; experience is ground. Where the two disagree about the past, experience
wins, because the fact store does not claim to have one. No second history is created
elsewhere — a component that needs to know what happened queries the stream.

**E2 — Append-only.**
Rows are never edited, reordered, or deleted in place. Information arriving after a row is
written becomes a *new row*, never a revision of the old one. This is what makes the corpus
usable as evidence: an analysis run twice over the same interval yields the same answer, and
a row's meaning does not depend on when it was read.

**E3 — Envelope and payload are separated.**
The **envelope** carries what is universal — identity, ordering, both clocks, provenance
references, segmentation signals, episode and session membership. The **payload** carries what
only one kind of observation has. Consequence: a new observation type adds a payload type and
changes nothing else. Had rows been shaped like the first producer's observation, every later
producer would inherit fields that are meaningless for it, and that denormalisation is
unfixable once a corpus exists.

**E4 — `producer` and `kind` are independent axes.**
*Who observed it* and *what kind of observation it is* are separate facts, and collapsing them
into a single enum destroys information the moment a producer can emit more than one kind, or
a kind can come from more than one producer. Keeping them apart is also what makes E5/E6
statable at all.

**E5 — Producers write through typed entry points; there is no generic append.**
Each producer has exactly one narrow, typed way to write its own kind. No general-purpose
"append anything" surface exists at any level of the module.

**E6 — ORIS-18: a producer may observe only its own boundary.**
The AI cannot report that an edit was *accepted* — it does not observe the user's reaction.
The editor cannot report a *claimed confidence* — it never held that claim. Every observation
has a natural owner, and no producer may synthesise another's.

E5 is the enforcement of E6, and the distinction matters: a documented rule is honoured until
someone is in a hurry, whereas an absent function cannot be called. Epistemic honesty is a
property of the API surface here, not of anyone's discipline.

**E7 — Rows are immutable evidence.**
Once written, a row records what was observed at that time by that observer, permanently. It
may be superseded, contradicted, or annotated by later rows; it is never corrected. A corpus
whose past can be edited cannot support any claim about development, because the claim and its
evidence would be mutually adjustable.

**E8 — Rows declare their provenance as a graph.**
A row names the rows it depends on. The stream is therefore a DAG, not a flat log, and
"what did this observation rest on" is answerable without inference.

**E9 — ORIS-17: provenance outranks retention.**
The stream is bounded, but a row is never evicted while any surviving row depends on it,
transitively. Where the bound and the graph conflict, **the graph wins and the overrun is
reported.** The asymmetry is deliberate: exceeding a retention target is visible, measurable,
and recoverable, while a broken evidence chain silently corrupts every analysis that touches
it, permanently and undetectably.

**E10 — Segmentation operates on the envelope, never on payloads.**
Episode boundaries are facts about *chronology*, not about any particular producer's
observations. Any row may carry boundary evidence. A segmenter that could only see decisions
would be blind to a boundary announced by the editor or the system — which is precisely the
case we expect to matter most.

**E11 — Observations are recorded; classifications are not.**
A classification can always be applied retroactively to a stored observation. An observation
can never be recovered from a classification. Wherever a taxonomy is expected to change — and
every taxonomy in this programme is — the raw observation is stored and the interpretation is
computed on read. Corollary: an unobserved value is recorded as *unobserved*, never as a
plausible default, so that missing data stays distinguishable from measured absence.

**E12 — Facts constant within a scope are recorded at that scope, not on every row.**
Session-invariant context belongs to the session row; other rows reference it. Duplicating it
per row is denormalisation whose cost compounds for the life of the corpus and buys nothing.
E9 protects the resulting join: the referenced row cannot be evicted out from under its
dependents.

**E13 — Subjective time advances only on consequential events.**
The stream carries two clocks. Wall time governs scheduling and anything a human reads.
Subjective time governs decay, recency, and consolidation, and it advances because *the
organism's situation changed* — not because a process started or elapsed. A lifecycle event
that moves nothing advances it by zero. Additionally, the terms subjective time is computed
from are stored alongside it, so the entire history can be re-derived when the model improves;
today's model is an acknowledged approximation and is recorded as one.

**E14 — Future producers are additive by construction.**
Adding a producer means: declaring it, declaring the kinds it may emit (E6), giving it a typed
entry point (E5), and defining its payload (E3). It does not touch the envelope, the ordering,
the segmentation, the provenance rules, or any existing producer. This is the property the
whole design exists to buy, and it is the test a proposed change must pass: **if a new
observation type would require changing the envelope, the envelope is wrong or the observation
is not what it appears to be.**

## Alternatives considered

**One stream per producer.** Rejected. Every downstream question — what happened next, what
did this rest on, where does this episode end — is a question about *global ordering*.
Separate streams turn all of them into a merge, permanently, and merges across independently
bounded logs are lossy at exactly the moments that matter.

**Mutable rows; late information updates the row it concerns.** Rejected under E2/E7. It is
the obvious way to attach an outcome to the decision it followed, and it destroys the corpus's
value as evidence: history would become a function of when it was last written.

**A decision-shaped row, extended per producer.** Rejected under E3. It is cheaper on day one
and leaves every later producer carrying fields it cannot fill.

**A single `producer_kind` enum.** Rejected under E4. Convenient while there is one producer
per kind, and irreversible once there is not.

**A documented producer-boundary rule without structural enforcement.** Rejected under E5. The
rule is exactly the kind that is honoured until it is inconvenient, and a single fabricated
observation makes the whole corpus untrustworthy — not merely the row it appears in.

**A hard retention ceiling that evicts regardless of references.** Rejected under E9. It trades
a permanent, silent, undetectable corruption for a bounded, visible, recoverable one, in the
wrong direction.

**Deriving history from what already exists** — the fact store, the undo stack, the routing
ledger. Rejected: the fact store is amnesic by design, the undo stack is session-scoped and
truncates, and the ledger records routing without the observations that produced it. None of
them is a history, and treating them as one would have produced a corpus with silent holes.

**Classifying at write time** (typing errors, scoring outcomes, labelling boundaries as they
occur). Rejected under E11. Every taxonomy this programme will use is expected to be revised;
baking today's into the corpus would make the revision unaffordable.

## Consequences

**The corpus outlives the hypotheses that motivated it.** Because signals, not conclusions,
are recorded (E10/E11) and subjective time is re-derivable (E13), a corpus collected under
today's assumptions can be re-analysed under assumptions nobody has had yet. This is the
single most valuable property of the design and the reason it was worth settling before
collection began.

**Every later cognitive phase becomes a view rather than a subsystem.** Beliefs, calibration,
competence, and growth are all computable from a complete stream. This is what keeps the
state ontology small: they do not need to be stored, and storing them would create second
sources of truth that could not be re-derived when the rules improve.

**Adding a producer is deliberate, and cheap.** E5 makes it impossible to add one by accident
and easy to add one correctly.

**The retention bound is soft.** E9 guarantees it. Overrun is reported rather than prevented,
and a persistently rising overrun is a real signal — reference chains outliving the retention
window — not a defect to be silenced.

**Storage pressure becomes an early forcing function.** Richer observation raises per-row cost
against a bound the graph may push past. The substrate question this raises is an
implementation decision beneath this ADR; the ADR's contribution is that it must not be
answered by weakening E9.

**The next architectural boundary is the outcome producer.** It introduces the first
non-runtime producer and completes the phases this stream exists to serve. It is deliberately
not settled here and will carry its own ADR. Nothing in E1–E14 anticipates its design beyond
reserving its right to exist.

**What this ADR does not settle:** which observations any producer records (ADR-015 for the
first one), how outcomes are captured, how predictions are scored, where the corpus is stored,
and how it is displayed. Those are implementation and later decisions beneath this contract.
