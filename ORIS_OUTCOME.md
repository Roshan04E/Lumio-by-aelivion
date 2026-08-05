# ORIS — Outcome Derivation

> **What this file is:** the canonical policy for how ORIS derives outcomes from editor history
> without ever recording an outcome. It is the authoritative reference for every future
> Prediction Ledger, calibration study, attribution mechanism, and consolidation pass.
>
> **What this file is not:** an ADR, an API, a schema, or an implementation. Where implementation
> pressure appears, the invariant is extracted instead. Appendix D is the only speculative section.
>
> **What this settles, and what it deliberately does not.**
> [`plans/oris-outcome-seam-design.md`](plans/oris-outcome-seam-design.md) settled the **write**
> boundary — what a producer may emit — and closed with an admission it did not resolve:
>
> > *"Deriving linkage is a research problem, not a lookup. §3 moves the difficulty from write
> > time to read time — it does not remove it."* — seam design §10
>
> **This paper is the read boundary.** It is the other half of that sentence.
>
> **Naming:** *Habitat* is the shipped Orreris Brain and editor, including its five adaptive
> loops [ICA Loops A–E]. *ORIS* is the resident being built. The distinction is load-bearing
> throughout Part 14 and is the reason this paper exists rather than a ledger specification.
>
> **Evidence discipline**, consistent with the audits. No source code was inspected; runtime
> claims cite the audit that established them.
>
> | Label | Meaning |
> |---|---|
> | **[EXISTS]** | Established by an audit or by the seam design's own measurements. |
> | **[CONFIRMED]** | Two independent documents agree, or a prediction was measured and held. |
> | **[INFERRED]** | Derived here by applying a document's stated rule to established fact. The inference step is named. |
> | **[OPEN QUESTION]** | Unsettled. What would settle it is named. |
> | **[ARCHITECTURAL RULE]** | A commitment this paper makes. Numbered `OD-n`. |
> | **[RESEARCH QUESTION]** | Requires an experiment, not a ruling. |
>
> **Sources:** [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) **[ARCH]** ·
> [`ORIS_VALUES.md`](ORIS_VALUES.md) **[VAL]** · [`ORIS_TIME.md`](ORIS_TIME.md) **[TIME]** ·
> [`ORIS_RESEARCH_PROGRAMME.md`](ORIS_RESEARCH_PROGRAMME.md) **[PROG]** ·
> [`ORIS_RUNTIME_STATE_AUDIT.md`](ORIS_RUNTIME_STATE_AUDIT.md) **[RSA]** ·
> [`ORIS_IMPLICIT_CYCLE_AUDIT.md`](ORIS_IMPLICIT_CYCLE_AUDIT.md) **[ICA]** ·
> [`ORIS_GAP_ANALYSIS.md`](ORIS_GAP_ANALYSIS.md) **[GAP]** ·
> [`ORIS_PROGRAMME_REVISION.md`](ORIS_PROGRAMME_REVISION.md) **[REV]** ·
> [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) **[AIA]** · seam design **[SEAM]**.
>
> **Status:** v0, 2026-08-04. Research paper. **Nothing here is implemented.**

---

## 0. The result in five sentences

1. **An outcome is not a thing that happens; it is a question asked of history at a moment.**
   Every outcome is a triple — *(what is being asked, under which policy, as of when)* — and
   changing any of the three legitimately changes the answer without anything being wrong.

2. **The unit of outcome is the action, not the decision.** A decision that applies four actions
   has four outcomes, and any single verdict about the decision is an aggregate under a named
   aggregation policy [Part 6].

3. **Three evidence classes exist and must never be blended: witnessed, declared, derived.** Some
   of the taxonomy the programme wants — execution failure, cancellation, the *occurrence* of an
   undo — is witnessed and needs no derivation at all. Confusing the three is how a corpus
   silently acquires interpretations [Part 3].

4. **Confidence in a derived outcome has two independent dimensions — linkage quality and window
   length — and collapsing them into one scalar destroys the only diagnostic that says which one
   is weak** [Part 8].

5. **The Two-Learner Problem does not resolve by precedence, because the two learners do not
   consume the same evidence class.** Habitat learns from *declarations*; ORIS learns from
   *derivations*. Declarations are the ground truth against which derivations are calibrated —
   which makes the relationship productive rather than merely tolerable [Part 14].

---

# PART 1 — The question, stated precisely

The seam design asked: *when the organism acts, how does it observe the consequences of its own
action?* [SEAM §1]. It answered the write half: the producer records committed mutations and never
records what they meant.

The unanswered half is harder and is this paper's subject:

> **Given a corpus of witnessed events and no recorded outcomes, by what deterministic,
> versioned, reproducible procedure does ORIS answer *"what happened as a result of that?"* —
> and what is it entitled to conclude?**

**[EXISTS]** The corpus material required is present: decision rows carrying prompt, route, owner,
structured actions, and (partially) confidence and start time; editor action rows carrying
operation, initiator declaration, action ids, graph version, and undo depth; a session row
carrying build, seat, schema, and a coverage record [RSA Part 1; ICA Part 6].

**[EXISTS]** No consumer of any of it exists — the Experience Stream has exactly two readers, both
in the observatory panel [ICA §7.1]. This paper defines what the first real consumer is entitled
to do.

---

# PART 2 — What an outcome is

## 2.1 The four layers, inherited

**[EXISTS]** The seam design established the structure and it is not reopened here [SEAM §3]:

```
1  OBSERVATION            "a commit occurred at seq 412"            witnessed · owned by a producer
2  OBSERVED CONSEQUENCE   "…which followed that decision"           sometimes witnessed, usually derived
3  DERIVED INTERPRETATION "…and the grade survived to delivery"     always derived
4  OUTCOME ASSESSMENT     "…therefore the grade was accepted"       always derived
```

**[EXISTS]** *"Layers 1 and the witnessed part of layer 2 are recorded. Layers 3 and 4 are never
recorded, at any latency, under any window"* [SEAM §3].

## 2.2 What this paper adds: outcomes are questions, not events

**[INFERRED]** The seam design established that a verdict cannot be stored because *one decision
has many outcomes* and *outcomes arrive unboundedly late* [SEAM §5]. Taken to its conclusion, that
is not merely a storage prohibition — it is a statement about what kind of object an outcome is.

> **An outcome is a query result, and like every query result it is meaningless without its
> query.** The bare sentence *"the grade was accepted"* is not a fact that was true at some point
> and became false later. It is an answer to *"was there a contradicting mutation to these targets
> within 30 minutes, under linkage policy v2, as of seq 900?"* — and that answer is permanently
> true of that question.

*Inference step:* this follows from SEAM §5's two properties plus ORIS-20's requirement that every
derivation name its policy. It is rejectable by arguing some outcomes *are* terminal — see
[OPEN QUESTION Q7] on delivery.

**[ARCHITECTURAL RULE OD-A · The outcome triple.** Every derived outcome is stated as
*(question, policy@version, as-of)*. An outcome quoted without all three is not a weaker claim; it
is not a claim at all, because nothing can check it.]

## 2.3 Why this is a feature and not a concession

**[INFERRED]** The refusal to store outcomes is usually presented as a cost paid for integrity.
It is better read as the mechanism that makes the hardest property free:

> **Because nothing was stored, later evidence never contradicts an earlier record.** It produces
> a different answer to a different question. There is no retraction, no migration, no
> append-only store holding a claim that tomorrow falsifies.

*Inference step:* this is ORIS-19 and SEAM §5 combined. The seam design anticipated the
mechanism (*"storing raw actions lets every window be applied retroactively, while storing a
verdict freezes exactly one"*); the observation that this dissolves the contradiction problem
entirely is stated here for the first time. See Part 9.

---

# PART 3 — The three evidence classes

**[ARCHITECTURAL RULE OD-1 · Three classes, never blended.** Every input to an outcome derivation
belongs to exactly one class, and the class travels with it.]

```
WITNESSED    a producer directly observed the occurrence at its own boundary
             → admissible as evidence; needs no derivation to be true

DECLARED     an agent asserted a meaning, and the assertion itself was witnessed
             → the assertion is evidence; the meaning is the agent's, never the corpus's

DERIVED      computed from witnessed and declared rows under a named policy
             → never evidence; never written back (OD-7)
```

## 3.1 Witnessed

**[EXISTS]** What the runtime genuinely witnesses, per the audits:

| Witnessed fact | Where | Source |
|---|---|---|
| A commit occurred; graph version; undo depth after | choke point | RSA Part 1 |
| An undo or redo *occurred*, distinguishably from an edit | same seam, history-suppressed | SEAM §14.3 |
| Which registry actions a commit carried | `actionIds`, a **list** | SEAM §14.0.3 |
| A decision was made; which route and owner resolved it | decision row | RSA Part 1 |
| Applied and failed counts; per-action error | decision row | RSA Part 1 |
| A run stopped, and how (`done · cancelled · cap · error · offline`) | agent loop | RSA Part 5 |
| What the build was capable of observing | coverage record | RSA Part 1 |

**[CONFIRMED] The transaction boundary is keyed correctly.** SEAM §14.0.1 warned that *"a producer
keying on `recordHistory` would still see 20 transactions per drag and would be wrong"* — the
property meaning one committed transaction is whether an undo entry was actually pushed. RSA Part 1
and ICA Part 6 establish the shipped choke point keys on exactly that. **The warning was heeded**;
two documents agree independently.

## 3.2 Declared

**[EXISTS]** Declarations are witnessed *as declarations* and are the corpus's only access to
meaning asserted by an agent:

| Declaration | Declared by | Witnessed | Source |
|---|---|---|---|
| `initiator: ai` | the executing caller | that the caller said so | SEAM §12.1 |
| `initiator: user` | a surface that genuinely saw a human | ditto, where wired | SEAM §12.1 |
| *undeclared* | nobody | **the absence is the fact** | SEAM §12.1 |
| A 👍 / 👎 on a brain-resolved turn | the user | the button press | ICA Part 7 |
| A plan approved, modified, or cancelled at review | the user | the choice | RSA Part 5 |

**[EXISTS] Initiation is declared, never witnessed.** *"`ai` is an optional argument the caller
supplies… the registry never observes who acted — it observes what it was told"* [SEAM §12.1].
The admissible field is three-valued: `ai · user · unattributed`.

**[ARCHITECTURAL RULE OD-2 · A declaration is evidence of the declaring, never of the fact.**
`initiator: ai` licenses *"a caller declared AI initiation"*. It licenses *"an AI acted"* only as a
derivation, under a policy, justified by coverage.]

## 3.3 Derived

Everything else. Part 5 defines how.

---

# PART 4 — What evidence may never create an outcome

**[ARCHITECTURAL RULE OD-3 · The exclusion list.** These may never, under any policy, produce or
contribute to an outcome derivation. Each has a reason, and the reasons differ.]

| Excluded | Why | Source |
|---|---|---|
| **Transport** — scrubbing, playhead motion | Not a mutation. Twenty-one scrub moves produce **zero** graph writes; the highest-frequency interaction in an editor never enters the corpus | SEAM §14.2 |
| **The AI's own commit, read as a response to itself** | An AI apply produces both a decision row and an action row from two producers [SEAM Q6]. A derivation that does not exclude self-observation reads the AI's own mutation as the user's reaction to it — **the single most dangerous trap in this paper** | SEAM Q6 |
| **A clarify question; a pause to watch playback** | Named anti-signals: they look like boundaries and are not | TIME §3 |
| **Panel, tab, or workspace changes** | Not mutations; weak segmentation candidates at best | TIME §3 |
| **Any linkage that was not witnessed, asserted as if it were** | *"Recording inferred links as observed poisons attribution permanently"* | SEAM §4 |
| **Silence, where coverage does not license it** | See OD-9 and Part 5.4 | ADR-016 I12 via RSA |
| **Any previously derived value** | Derivations are not evidence (OD-7) | ORIS-21 |

**[INFERRED] The self-observation exclusion deserves its severity.** Because an AI commit is
witnessed twice, and because the second witnessing is an *action row on the targets the decision
just touched*, the naive proximity heuristic — *a mutation to D's targets shortly after D* — will
match the AI's own commit before it matches anything the user did. A derivation that omits this
exclusion does not merely lose accuracy; it systematically reports self-acceptance. *Inference
step:* follows from SEAM Q6 plus the shape of any proximity-based linkage rule; not measured.

---

# PART 5 — How outcomes are derived

## 5.1 The shape of a derivation

**[ARCHITECTURAL RULE OD-4 · A derivation is a pure function of a corpus prefix.**

```
derive(question, policy@version, as_of_seq) → outcome set
```

It reads only rows with `seq ≤ as_of_seq`. It writes nothing. It consults no state outside the
corpus and the named policy.]

**[EXISTS]** Ordering is by `seq`, never by wall clock: *"linkage derivation runs on `seq`, never
on `t`. Cross-recorder ordering is a derivation under a named policy"* [SEAM Q7]. Wall clock is
user-settable; sequence is monotonic and survives eviction [RSA Part 1].

## 5.2 The three stages

**[INFERRED]** Every outcome question decomposes the same way. *Inference step:* the decomposition
is derived from SEAM's four layers (Part 2.1); it is a restatement for the read direction, not a
new claim.

```
STAGE 1 · SCOPE      which rows are candidates?
                     targets, action ids, seq range, coverage window
STAGE 2 · LINK       which candidates are consequences of D?
                     observed · proximate · inferred  (Part 7)
STAGE 3 · READ       what do the linked rows say about D, under this question?
                     survival · adjustment · reversal · supersession · … (Part 11)
```

Each stage is separately versioned, and this matters more than it looks:

**[ARCHITECTURAL RULE OD-5 · Stages version independently.** A policy identifier names all three
stage versions. Improving linkage without changing the reading must not silently invalidate
comparisons that only depended on scope.]

## 5.3 Windows are inputs, not constants

**[EXISTS]** *"Any fixed window that classifies at its close — 'no correction within 60 s,
therefore accepted' — is a claim that tomorrow's revert falsifies"* [SEAM §5].

**[ARCHITECTURAL RULE OD-6 · The window is part of the question.** There is no default window and
there is no "the" outcome. Immediate reaction, session survival, and survival-to-delivery are three
questions, and a policy that supplies a window silently has hidden a research decision inside an
implementation detail.]

## 5.4 Absence, and what licenses it

The most tempting derivation in the entire space is *nothing happened, therefore it was accepted*.
It is also the one most likely to be wrong for reasons the corpus can detect.

**[ARCHITECTURAL RULE OD-7 · Absence of evidence is evidence only where coverage licenses it.**
A derivation may conclude *"no contradicting mutation occurred"* only if the session's coverage
record shows the build could have observed one. Where coverage is absent, the honest reading is
*"unobserved"*, which is a third value and not a synonym for either outcome.]

**[EXISTS]** This is the mechanism ADR-016 I12 exists for, and the seam design already demonstrated
it paying: *"'undeclared at a committed write' licenses the derivation 'not AI-initiated' — at read
time, under a named policy, justified by a recorded coverage fact"* [SEAM §14.0.2].

**[EXISTS] There is a known coverage hole inside the timeline domain.** A second mutation path
bypasses the registry and, with history recording off, bypasses history [SEAM §12.3]. Any
derivation over a period where that path was active and uninstrumented must read absence as
unobserved.

---

# PART 6 — The unit of outcome: actions, not decisions

**[EXISTS]** A decision row carries a structured `actions[]` list, and `actionIds` on a commit is a
**list, not a scalar** — because the chat panel runs several registry actions and commits once
[RSA Part 1; SEAM §14.0.3].

**[INFERRED]** Therefore partial success is the normal case, not an edge case. A four-action plan
where three survive and one is reverted has no single truthful verdict.

**[ARCHITECTURAL RULE OD-8 · The unit of outcome is the action.** Outcomes attach to actions.
A decision-level outcome is an *aggregate* over its actions' outcomes under a named aggregation
policy, and the aggregation is part of the policy identifier.]

**[INFERRED] Why this is not merely tidiness.** Attribution (calculus phase ⑦) assigns error to the
belief that produced a claim. A plan's four actions may come from four different rules or recipes
[RSA Part 1: `owner {tier, ruleId, recipeId, provider}`]. Collapsing to a decision-level verdict
destroys the correspondence between the unit of blame and the unit of evidence — which is precisely
the granularity H4 is testing [PROG §6]. *Inference step:* follows from the owner field's
granularity plus H4's definition; the empirical question of whether action-level attribution is
achievable remains H4's.

**[OPEN QUESTION Q1]** Some actions have no independently observable consequence — a step that
opens a tool window carries no `actionId` at all, and the trace deliberately does not invent one
[RSA Part 1]. Whether such steps are *outcome-bearing* or *outcome-transparent* is unsettled. They
are currently invisible to any derivation, which may be correct or may be a silent recall loss.
*Settles by:* counting actionId-less steps in the existing corpus.

---

# PART 7 — Linkage

## 7.1 The distinction, inherited and corrected

**[EXISTS]** The seam design drew the sharpest line in the whole design here — *"an action row may
carry a causal reference only when the causal attachment was itself observed"* [SEAM §4] — and then
**retracted its own headline example**:

> **[EXISTS]** *"The undo stack holds compositions, not commits… 'the user undid the AI's edit' —
> §4's headline example of observed linkage, and the strongest rejection signal the design hoped
> for — is not observable at this seam today. §4's table is wrong on its own primary case."*
> [SEAM §12.2]

**[CONFIRMED]** RSA Part 1 independently establishes that the action row carries `operation`,
`graphVersion` and `undoDepth` but no reference to what an undo reversed.

**[INFERRED]** The consequence for this paper is foundational: **the highest-value linkage in the
entire outcome space is currently derived, not observed.** Every acceptance and rejection statement
ORIS makes about its own edits will rest on inference until a product change binds undo entries to
the commits that created them. That is not a defect to route around; it is the central uncertainty
the confidence model in Part 8 exists to represent honestly.

## 7.2 The three linkage classes

**[ARCHITECTURAL RULE OD-9 · Linkage is a three-valued, recorded property of every derived
outcome.**

```
OBSERVED    the causal attachment was itself witnessed
            (an affordance bound to a specific prior commit; a 👍 on this result;
             a plan-review decision about this plan)
            → today: available for declarations, NOT for undo   [SEAM §12.2]

PROXIMATE   the same targets and parameters, within a bounded seq distance,
            with no intervening decision touching them
            → a strong but defeasible reading; the exclusions in Part 4 apply first

INFERRED    same targets, wider window, or intervening activity
            → admissible only for aggregate statistics, never for single-case attribution
```
]

**[ARCHITECTURAL RULE OD-10 · Linkage class never upgrades.** A derivation may weaken a link on
later evidence; it may never promote INFERRED to PROXIMATE or PROXIMATE to OBSERVED. Promotion of
linkage confidence is the mechanism by which a corpus quietly acquires certainty it never earned.]

---

# PART 8 — Confidence

## 8.1 Two dimensions, never one

**[INFERRED]** A derived outcome's trustworthiness has two independent sources of weakness, and
they call for opposite responses:

```
                  strong linkage              weak linkage
short window   ▸ trustworthy               ▸ wrong link, sharp reading
               (act on it)                    (the dangerous quadrant)

long window    ▸ right link, diluted        ▸ statistical only
               (aggregate, don't attribute)   (never single-case)
```

*Inference step:* the two dimensions are read off Parts 5.3 and 7; the claim that collapsing them
loses diagnostic power is an argument, not a measurement.

**[ARCHITECTURAL RULE OD-11 · Confidence in a derived outcome is a pair — (linkage class, window)
— and is never collapsed to a scalar.** A scalar cannot distinguish *"I am unsure this is related"*
from *"I am sure it is related but a lot has happened since"*, and those demand different
responses: the first weakens attribution, the second weakens recency.]

**[INFERRED]** This is the ACh/NE distinction [ARCH §6.2] appearing at the outcome layer: weak
linkage is *expected* uncertainty (this derivation is inherently noisy → learn slower); a surprising
outcome under strong linkage is *unexpected* uncertainty (the model broke → re-perceive). Preserving
the pair is what keeps them distinguishable. *Inference step:* the mapping is an interpretation of
ARCH §6.2, not something either document states.

## 8.2 What confidence is not

**[ARCHITECTURAL RULE OD-12 · A derived outcome carries no probability.** It carries a linkage
class, a window, and a policy identifier. A probability would be a second-order derivation whose own
calibration is unmeasured — precisely the error the Prediction Ledger exists to prevent in the
other direction.]

---

# PART 9 — Delayed outcomes and contradiction

## 9.1 Outcomes never terminate

**[EXISTS]** *"One decision has many outcomes. Kept now, adjusted in ten minutes, shipped on
Thursday, reverted next month. There is no single terminal verdict, and there never will be"*
[SEAM §5].

**[ARCHITECTURAL RULE OD-13 · Every derived outcome is as-of, and as-of is never optional.**
A derivation without an as-of point is not a claim about history; it is a claim about *now*, which
will silently become false.]

## 9.2 Contradiction is not correction

**[INFERRED]** This is the largest single payoff of the architecture's refusal to store outcomes,
and it deserves stating plainly because every other agent-memory system pays for it:

```
A system that STORES outcomes:
    t1   store "accepted"
    t2   user reverts
    → the store now contains a false record. Options: mutate an append-only store (forbidden),
      append a correction (which readers must know to look for), or live with corruption.

A system that DERIVES outcomes:
    t1   derive(D, policy@v1, as_of=500) → survived
    t2   derive(D, policy@v1, as_of=900) → reversed
    → BOTH ARE PERMANENTLY TRUE. Nothing is retracted because nothing was claimed
      beyond its as-of.
```

*Inference step:* follows from OD-A and OD-13. The comparison to stored-outcome systems is an
argument by contrast, not a measurement of any specific product.

**[ARCHITECTURAL RULE OD-14 · Later evidence produces a new reading, never a retraction.** A
derivation is never "wrong because things changed." It is wrong only if it misapplied its own
policy to its own prefix — which is checkable, because derivation is deterministic (Part 12).]

## 9.3 The consequence for the Prediction Ledger

**[INFERRED]** A ledger entry pairs a claim with an outcome. Since outcomes are as-of, **a ledger
score is also as-of**, and calibration curves are therefore functions of the scoring horizon, not
constants.

*Inference step:* follows directly from OD-13. It has a sharp consequence: **H5 as written is
under-specified.** [PROG §6] H5 predicts *"claimed confidence converges toward realised frequency
in ≥3 domains"* without naming a scoring horizon, and a system can be well-calibrated at 60 seconds
and badly calibrated at 30 days. See [REV Appendix B] for the programme edits this implies.

**[RESEARCH QUESTION R1]** Does calibration measured at short horizons predict calibration at long
horizons? If yes, the cheap measurement suffices. If no, every calibration claim must name its
horizon forever, and H5 needs a horizon per domain.

---

# PART 10 — Undo and redo

## 10.1 What is and is not witnessed

**[EXISTS]** Three established facts that must be held together, because each alone is misleading:

1. **An undo's occurrence is witnessed**, distinguishably from an ordinary edit, by a property
   already present at the seam [SEAM §14.3].
2. **What it undid is not witnessed.** The stack holds whole compositions [SEAM §12.2].
3. **`graphVersion` and `undoDepth` after the operation are witnessed** [RSA Part 1].

**[INFERRED]** Fact 3 is more useful than either audit noted. Undo depth after each operation gives
a derivation a *shape* to reason over: a depth that decreases and then returns is an undo followed
by a redo; a depth that decreases and stays down is a reversal that stood. This is a genuine handle
on undo semantics that requires no product change. *Inference step:* follows from depth being
recorded per operation; whether depth is unambiguous under grouped transactions is
**[OPEN QUESTION Q2]**.

## 10.2 Undo–redo pairs

**[ARCHITECTURAL RULE OD-15 · Undo and redo are netted before reading, never counted separately.**
An undo followed by a redo that restores the same depth is, at minimum, not a durable reversal. A
derivation that counts undos without netting redos will systematically over-report rejection.]

**[INFERRED]** A tight undo–redo pair is more plausibly *comparison* than *rejection* — the user
looked at the alternative and came back. Whether that reading is correct is
**[RESEARCH QUESTION R2]**: does undo–redo latency separate comparison from indecision? Measurable
on the existing corpus with no new capture.

## 10.3 The honest position on undo as a rejection signal

**[ARCHITECTURAL RULE OD-16 · Undo is PROXIMATE linkage at best, never OBSERVED, until undo
entries are bound to the commits that created them.** Any document, ledger, or study that treats
undo-after-AI-commit as an observed rejection is relying on a capability [SEAM §12.2] established
does not exist.]

---

# PART 11 — The taxonomy

## 11.1 The split that must be preserved

**[ARCHITECTURAL RULE OD-17 · Witnessed and derived outcome classes never share a vocabulary.**
Some of what the programme calls "outcomes" needs no derivation at all, and blending them produces
a taxonomy where some members are facts and others are opinions.]

### Witnessed classes — no policy required

| Class | What it means | Witnessed at | Source |
|---|---|---|---|
| **Execution failure** | The action itself errored | decision row: `failed`, per-action `error` | RSA Part 1 |
| **Cancellation** | The run stopped before applying | `stopped: "cancelled"` | RSA Part 5 |
| **Declination at review** | The user rejected the plan before it acted | plan-review decision | RSA Part 5 |
| **Reversal occurrence** | An undo happened (not *of what*) | history-suppressed write | SEAM §14.3 |

**[INFERRED]** Cancellation and declination are outcomes of a **deliberation**, not of an action —
nothing was applied, so there is nothing for the world to respond to. They belong to a different
question and must not be aggregated with action outcomes. *Inference step:* follows from SEAM §2's
definition of an outcome as *the world's response to an action*.

### Derived classes — policy required

| Class | The question | Minimum linkage | Depends on |
|---|---|---|---|
| **Survival** | No contradicting mutation to these targets within W | PROXIMATE + coverage (OD-7) | — |
| **Adjustment** | Same targets, same params, changed value within W | PROXIMATE | param grain [SEAM Q1] |
| **Reversal** | A netted undo plausibly covering this commit | PROXIMATE (OD-16) | undo netting (OD-15) |
| **Supersession** | A later *decision* rewrote the same targets | PROXIMATE | — |
| **Replacement** | Targets removed and re-created | PROXIMATE | identity across delete/create |
| **Abandonment** | The episode ended with no further engagement | INFERRED | **episode segmentation** |
| **Survival to delivery** | Present in an exported composition | OBSERVED, if export is instrumented | export producer [SEAM Q3] |

## 11.2 Three dependencies this table exposes

**[INFERRED]**

1. **Abandonment cannot be derived before Stage C.** It is the only class that requires an episode
   boundary, and [PROG §4] establishes segmentation as the programme's central empirical problem.
   Any ledger that scores abandonment before segmentation is validated is scoring an artifact of an
   arbitrary window. *Inference step:* follows from the class definition; the dependency is not
   noted in any existing document.
2. **Survival-to-delivery needs a producer that does not exist.** Export does not cross the
   registry [SEAM §6, Q3]. Until an export producer exists, the strongest positive outcome signal
   in the product is unavailable — and its absence is asymmetric: the corpus will be far richer in
   evidence of rejection than of success.
3. **Adjustment depends on parameter grain**, which SEAM Q1 resolved *at the registry* and then
   invalidated when §14.0.2 established the registry is not the human path. Whether human parameter
   changes carry enough grain to support "they reduced my grade by 20%" is
   **[OPEN QUESTION Q3]** — SEAM §14.0.3 states human-side operation identity remains absent across
   57 call sites.

**[INFERRED] The asymmetry in point 2 is the most important structural bias in the outcome
corpus.** Rejection is cheap to observe (an undo, a tweak) and success is expensive (survival to
delivery). A ledger trained on this corpus will see failure more clearly than success, and any
calibration study must correct for it or report it. *Inference step:* follows from points 1–2; the
magnitude is unmeasured and is **[RESEARCH QUESTION R3]**.

---

# PART 12 — Determinism

**[ARCHITECTURAL RULE OD-18 · Derivation is deterministic and reproducible forever.** Same corpus
prefix + same policy@version + same as-of ⇒ same result, on any machine, at any later date.]

Four requirements follow, each already supported by an established property:

| Requirement | Supported by | Source |
|---|---|---|
| Order by `seq`, never `t` | `seq` is monotonic and survives eviction | RSA Part 1; SEAM Q7 |
| Evidence rows must still exist | ORIS-17: no dangling references; provenance beats the ceiling | RSA Part 1 |
| Policies must remain runnable after supersession | The repo's existing convention: superseded policies are retained, never deleted | RSA Part 1 |
| Derived values never re-enter | OD-19 below | ORIS-21 |

**[ARCHITECTURAL RULE OD-19 · No derived value is ever written to the Experience Stream, and no
derivation consumes another derivation without naming both policies.** A derivation chain that
loses one of its policy identifiers is not reproducible, and an unreproducible derived value
persisted "just in case" is a cached view that owes ORIS-20 — the laundering channel ORIS-21 exists
to close.]

**[RESEARCH QUESTION R4 — the cost of determinism.** Re-derivation over the whole corpus is the
operation that makes every other guarantee here real. Nobody has measured it. If re-deriving a
year of history is not interactive, "derive at read time" degrades in practice into "derive once
and cache," which OD-19 forbids and which would therefore force a genuine architectural choice.
This is [REV M3] restated at its point of application; a kill criterion is available.]

---

# PART 13 — Provenance

**[INFERRED]** Provenance for a *stored* value is a record. Provenance for a *derived* value cannot
be — the value does not persist. The correct form is therefore different in kind:

> **Provenance for a derived outcome is a recipe, not a record: the policy identifier, the as-of
> point, and the corpus. Anyone holding those three can regenerate the value and check it.**

*Inference step:* follows from OD-18 plus the value's non-persistence. It resolves an apparent
tension with ORIS-8 (*every learned parameter carries the episodes that justify it*): a learned
parameter still carries its episode ids, but the *outcome* those episodes were read as is
regenerated, not stored.

**[ARCHITECTURAL RULE OD-20 · Citing a derived outcome means citing its recipe.** A study, a
belief, or a ledger score that cites an outcome without the triple is uncheckable and must be
treated as an assertion, not evidence.]

**[INFERRED] This produces a permanent asymmetry with Habitat**, and it is the bridge into Part 14:
ORIS's derived conclusions will be fully auditable and regenerable, while Habitat's five learning
stores keep *"counters and payloads, not evidence chains"* [ICA K3; GAP §1.12 — ORIS-8 marked
ABSENT]. Two learners, two epistemic standards, one corpus.

---

# PART 14 — The Two-Learner Problem

## 14.1 The situation, established

**[EXISTS]** Habitat contains five closed adaptive loops that change behaviour today [ICA Loops
A–E]. ORIS's ledger does not exist [ICA Part 9]. Both will observe the same user, the same events,
and — at the outcome seam — the same undo.

**[EXISTS]** [REV M1] named this as a research question no document had asked. This part answers it
at architecture level.

## 14.2 The dissolving observation

The problem is usually posed as *two learners will disagree about the same evidence; who wins?*
**[INFERRED] That framing is wrong, and seeing why removes most of the difficulty:**

> **They do not consume the same evidence class.**
>
> - **Habitat learns from DECLARATIONS.** Its trust counters are moved by 👍/👎 on a resolved turn
>   and by plan-review decisions [ICA Part 7] — user assertions of meaning, witnessed as
>   assertions (Part 3.2).
> - **ORIS learns from DERIVATIONS.** Its ledger scores claims against outcomes computed from
>   witnessed behaviour under a named policy (Parts 5–11).

*Inference step:* the classification of Habitat's signal as declaration-class rests on ICA Part 7's
identification of its write sites as explicit feedback and review affordances. **[OPEN QUESTION Q4]:**
whether *every* Habitat write is declaration-class, or whether some are behavioural, was not
established by any audit. If some are behavioural, the two learners overlap more than this part
assumes and §14.4 needs revisiting. *Settles by:* enumerating the trigger of each write site.

## 14.3 Why this makes the relationship productive

**[INFERRED]** Declarations are sparse, high-precision, and unambiguous. Derivations are dense,
lower-precision, and defeasible. That is not a rivalry; it is the standard structure of a labelled
set inside an unlabelled one.

> **Habitat's declarations are the highest-quality labels available for calibrating ORIS's
> derivation policies.** A 👎 on a turn is ground truth against which a derivation that reads the
> subsequent behaviour as *reversal* can be scored. Where the derivation agrees, the policy is
> earning its complexity. Where it disagrees, the disagreement localises the error to the linkage
> stage, the window, or the reading.

*Inference step:* this is the standard weak-supervision argument applied to these two evidence
classes; it assumes Q4 resolves as stated.

**[RESEARCH QUESTION R5]** What is the agreement rate between declared verdicts and derived
outcomes on the same events? This is the single most valuable measurement the existing corpus can
support, it requires no new capture, and it is a direct precursor to H4 (attribution granularity).

## 14.4 The five commitments

**[ARCHITECTURAL RULE OD-21 · Ownership.** Each learner owns its own store exclusively. Neither
writes the other's. Habitat's counters are Habitat's; the ledger will be ORIS's. There is no shared
store and no synchronisation.]

**[ARCHITECTURAL RULE OD-22 · Authority is domain-scoped, not global.** Habitat has authority over
routing because it *is* the routing system [AIA]. ORIS has authority over nothing that acts, by
ORIS-1 and by the epochs — during Epochs 0–1 it observes and predicts and does not act. **The
conflict is therefore deferred by construction, not resolved by precedence**, and the epoch ladder
is already the mechanism that sequences it.]

**[ARCHITECTURAL RULE OD-23 · Disagreement is a finding, never an error.** When a declared verdict
and a derived outcome disagree, neither is corrected. The disagreement is itself the highest-value
observation available about the derivation policy (§14.3) and is reported.]

**[ARCHITECTURAL RULE OD-24 · Provenance asymmetry is recorded, not equalised.** ORIS's derived
conclusions carry recipes; Habitat's counters do not carry evidence chains [ICA K3]. This paper
does not require Habitat to change. It requires that any analysis mixing the two states which side
a conclusion came from, because only one side is regenerable.]

**[ARCHITECTURAL RULE OD-25 · Reconciliation requires mutual observability, and it is currently
absent.** Habitat's adaptive state is not recorded in the corpus [RSA Part 1; REV §2.2], so a
routing change caused by a trust flip is indistinguishable from one caused by a different prompt.
**Until that is fixed, no derivation may attribute a behavioural change to ORIS, and no comparison
between the two learners is valid.**]

## 14.5 This paper supplies the reason for a programme edit already proposed

**[CONFIRMED]** [REV §2.3 E2] proposed adding an Epoch 0 entry gate — *the habitat's adaptive state
must be observable in the corpus* — on the grounds that drift would otherwise be unattributable.
OD-25 arrives at the identical requirement from a different direction: outcome derivation cannot
distinguish the two learners' effects without it.

**[INFERRED]** Two independent derivations of the same precondition, from measurement validity and
from derivation validity, is the strongest available argument that E2 is load-bearing rather than
tidy. *Inference step:* the convergence is real; that it implies correctness is an argument.

---

# PART 15 — The invariants

Numbered for citation. `OD-A` is the framing rule; `OD-1`…`OD-25` are the commitments.

| # | Invariant |
|---|---|
| **OD-A** | Every outcome is a triple: *(question, policy@version, as-of)*. |
| **OD-1** | Three evidence classes — witnessed, declared, derived — never blended. |
| **OD-2** | A declaration is evidence of the declaring, never of the fact. |
| **OD-3** | The exclusion list (Part 4) may never contribute to a derivation. |
| **OD-4** | A derivation is a pure function of a corpus prefix; it writes nothing. |
| **OD-5** | Scope, link, and read stages version independently. |
| **OD-6** | The window is part of the question; there is no default. |
| **OD-7** | Absence is evidence only where coverage licenses it; otherwise *unobserved*. |
| **OD-8** | The unit of outcome is the action; decision-level verdicts are named aggregates. |
| **OD-9** | Linkage is three-valued — observed · proximate · inferred — and always recorded. |
| **OD-10** | Linkage class never upgrades. |
| **OD-11** | Confidence is the pair (linkage, window) and is never collapsed to a scalar. |
| **OD-12** | A derived outcome carries no probability. |
| **OD-13** | Every derived outcome is as-of, and as-of is never optional. |
| **OD-14** | Later evidence produces a new reading, never a retraction. |
| **OD-15** | Undo and redo are netted before reading. |
| **OD-16** | Undo is PROXIMATE at best until undo entries are bound to commits. |
| **OD-17** | Witnessed and derived outcome classes never share a vocabulary. |
| **OD-18** | Derivation is deterministic and reproducible forever, ordered by `seq`. |
| **OD-19** | No derived value re-enters the stream or another derivation unnamed. |
| **OD-20** | Citing a derived outcome means citing its recipe. |
| **OD-21** | Each learner owns its store exclusively. |
| **OD-22** | Authority is domain-scoped; the conflict is deferred by the epochs, not resolved. |
| **OD-23** | Learner disagreement is a finding, never an error. |
| **OD-24** | Provenance asymmetry between learners is recorded, not equalised. |
| **OD-25** | No cross-learner attribution or comparison until Habitat's adaptive state is observable. |

**[INFERRED]** Five of these are consequences of existing invariants rather than new commitments:
OD-1 and OD-17 restate ORIS-19 for this domain; OD-19 restates ORIS-21; OD-18 depends on ORIS-17;
OD-20 restates ORIS-20. The genuinely new commitments are OD-A, OD-8, OD-11, OD-13, OD-15, OD-16,
and OD-21…OD-25.

---

# PART 16 — Open questions and blocking risks

## 16.1 The blocking risk

**[OPEN QUESTION Q5 — BLOCKING. That an AI commit declares itself is still unverified.**

> *"The probe now drives the real AI panel. Result: panel opened, prompt sent, **zero graph
> writes**, so no commit occurred and the positive case is **inconclusive — not confirmed**."*
> [SEAM §14.0.4]

**[INFERRED] This is the single largest risk to everything in this paper.** The derivation
*"undeclared at a committed write ⇒ not AI-initiated"* is licensed by coverage only if **every** AI
commit path declares [SEAM §14.0.2]. If one does not, then AI commits appear as user commits, and
the self-observation exclusion (Part 4) silently fails to fire — producing exactly the
self-acceptance error that part identifies as the most dangerous trap. The failure is silent, and
nothing downstream can detect it.

*Settles by:* what SEAM §14.0.4 already names — an AI prompt that reaches an apply in a blank
one-clip project, or driving the commit path directly. **No ledger work should begin before this
is confirmed in the positive direction.**]

## 16.2 Open questions

| # | Question | Settles by |
|---|---|---|
| **Q1** | Are actionId-less steps outcome-bearing or outcome-transparent? (Part 6) | counting them in the existing corpus |
| **Q2** | Is `undoDepth` unambiguous under grouped transactions? (Part 10.1) | reading the history model |
| **Q3** | Does the human parameter path carry enough grain for adjustment magnitude? (Part 11.2) | SEAM §14.0.3's 57 undeclared call sites |
| **Q4** | Is *every* Habitat learning write declaration-class? (Part 14.2) | enumerating trigger sites |
| **Q6** | Does the second mutation path [SEAM §12.3] remain uninstrumented? | coverage record |
| **Q7** | Is *survival to delivery* terminal, or merely the longest window? (Part 2.2) | conceptual, then export producer |

## 16.3 Research questions

| # | Question | Why it matters | Cost |
|---|---|---|---|
| **R1** | Does short-horizon calibration predict long-horizon calibration? | H5 is under-specified without a horizon (Part 9.3) | corpus only |
| **R2** | Does undo–redo latency separate comparison from indecision? | OD-15's netting rule assumes it does | corpus only |
| **R3** | How asymmetric is the corpus between rejection and success evidence? | biases every calibration study (Part 11.2) | corpus only |
| **R4** | What does full re-derivation cost at corpus scale? | determines whether OD-18/OD-19 survive contact | synthetic corpus |
| **R5** | What is the agreement rate between declared and derived verdicts? | the highest-value measurement available; precursor to H4 | corpus only |

**[INFERRED]** Four of five research questions are answerable on the existing corpus with no new
capture — consistent with [REV Part 3]'s finding that Tier 0 research is unusually cheap at this
stage.

## 16.4 Contradictions isolated, not resolved

**[EXISTS]** Two, both recorded rather than settled:

1. **SEAM §4 vs SEAM §12.2** — the design's headline example of observed linkage is retracted by
   its own later measurement. *Resolved within the source document*; noted here because §4's table
   remains in the corpus and will mislead a reader who stops there. This paper's OD-16 is the
   operative rule.
2. **[PROG §7] / [ARCH §12.2] vs [ARCH §14]** — the zero-wrong-fire gate versus promoting compiled
   reflexes into novel contexts [REV C8]. It bears on this paper because **any wrong-fire
   measurement will be a derived outcome**, and OD-11 says derived outcomes carry no probability —
   so "zero wrong-fire" must be defined over a linkage class and a window or it is not measurable
   at all. Isolated here; not resolved.

---

# PART 17 — What this unlocks

**[INFERRED]** Against [GAP Part 8]'s dependency graph:

| Unlocked | How |
|---|---|
| **The Prediction Ledger** | Its only unmet input was an outcome; OD-A…OD-20 define one |
| **Phase ⑥ `compare`** | Now has a typed input; [VAL §6]'s tiering applies at read time over derived classes |
| **Phase ⑦ `attribute`** | OD-8's action-level unit matches the owner field's granularity |
| **Surprise → τ → forgetting** | `tauInputs.surprise` is `null` pending exactly this [RSA Part 1] |
| **H3, H4, H5** | All require claim↔outcome pairing; H5 additionally needs a horizon (R1) |
| **H1 via [PROG §4 C.2]** | If the ledger is the segmenter, segmentation inherits this policy |
| **Calibration as a user-facing artifact** | Stage A's one legitimate output [PROG §A.4] |
| **The Two-Learner coexistence** | OD-21…OD-25, and the reason for [REV E2] |

**[INFERRED] What it does not unlock, and should not be read as unlocking:** abandonment (needs
segmentation), survival-to-delivery (needs an export producer), and any cross-learner comparison
(needs OD-25). Those dependencies are stated in Part 11.2 and Part 14.4 precisely so that a future
ledger does not quietly assume them.

---

## Appendix A — Goal index

| Goal | Answered in |
|---|---|
| 1 · What is an outcome? | Part 2 |
| 2 · What evidence may create one? | Part 3 |
| 3 · What may never? | Part 4 |
| 4 · How are outcomes derived? | Part 5 |
| 5 · Provenance | Part 13 |
| 6 · Confidence | Part 8 |
| 7 · Delayed outcomes | Part 9.1 |
| 8 · Partial success | Part 6 |
| 9 · Undo / redo | Part 10 |
| 10 · Contradiction | Part 9.2 |
| 11 · The taxonomy | Part 11 |
| 12 · Determinism | Part 12 |
| 13 · Invariants | Part 15 |
| The Two-Learner Problem | Part 14 |

## Appendix B — What this paper changes elsewhere

Corrections and additions this paper implies for other documents. **Recorded, not applied.**

| Target | Change |
|---|---|
| [PROG §6] H5 | Under-specified: needs a scoring horizon per domain (Part 9.3, R1) |
| [PROG §12.1] item 1 | The proposed outcome *record* shape is superseded: outcomes are derived, not appended. SEAM §3 already established this; the programme still lists the row |
| [SEAM §4] | Table remains uncorrected in place; OD-16 is the operative rule |
| [REV §2.3 E2] | Gains a second, independent justification (Part 14.5) |
| [ARCH §7] | The ledger's outcome input is now specified; the claim side remains partial [RSA Part 1] |

## Appendix C — Terms

| Term | Meaning here |
|---|---|
| **Witnessed** | A producer directly observed the occurrence at its own boundary |
| **Declared** | An agent asserted a meaning; the assertion was witnessed |
| **Derived** | Computed from the corpus under a named policy; never evidence |
| **Linkage** | The causal attachment between a decision and a later event; three-valued |
| **Window** | The seq range a question is asked over; part of the question |
| **As-of** | The corpus prefix a derivation reads; never optional |
| **Netting** | Resolving undo/redo pairs before reading reversal |
| **Recipe** | Policy identifier + as-of + corpus; provenance for a non-persistent value |
| **Habitat** | The shipped brain and editor, including its five adaptive loops |

## Appendix D — Speculative

**Contains no findings. Nothing above depends on anything here.**

- Whether binding undo entries to the commits that created them is worth a product change — it
  would convert the most valuable linkage in the system from PROXIMATE to OBSERVED (OD-16) — is a
  product decision this paper does not make.
- Whether an export producer should exist, and what it would witness, is [SEAM Q3]'s territory.
- Whether Habitat's five loops should eventually adopt ORIS's provenance standard (OD-24) or remain
  as they are is not determinable from any evidence collected so far; both are coherent.
- Whether derived outcomes ever become dense enough to make declared feedback affordances
  unnecessary is a product question, and the reverse — that declarations remain the calibration
  ground truth permanently — is equally consistent with everything above.
