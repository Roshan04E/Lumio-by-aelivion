# ORIS — Programme Revision Assessment

> **What this file is:** a determination of whether the research programme itself must change,
> given the evidence the audits collected. It is written from the chief-research-architect seat,
> not the auditor's: the question is no longer *what is missing from the runtime* but *what is
> wrong with the plan*.
>
> **What this file is not:** an audit, a redesign, an implementation plan, or a new architecture.
> No source code was inspected. Part 7 is the only speculative section and contains no findings.
>
> **Evidence rules**, with one adaptation stated honestly because the ground truth has moved:
>
> | Label | Meaning **in this document** |
> |---|---|
> | **[EXISTS]** | Established as fact by an audit. The audit and its section are cited; the audit holds the `file:line`. |
> | **[INFERRED]** | A conclusion drawn here by applying a *document's own stated rule* to an audited fact. The inference step is always named so it can be rejected. |
> | **[UNKNOWN]** | Not settled by any document. What would settle it is named. |
> | **[SPECULATIVE]** | Part 7 only. |
>
> **Sources**, all treated as ground truth:
> [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) **[ARCH]** ·
> [`ORIS_RESEARCH_PROGRAMME.md`](ORIS_RESEARCH_PROGRAMME.md) **[PROG]** ·
> [`ORIS_RUNTIME_STATE_AUDIT.md`](ORIS_RUNTIME_STATE_AUDIT.md) **[RSA]** ·
> [`ORIS_IMPLICIT_CYCLE_AUDIT.md`](ORIS_IMPLICIT_CYCLE_AUDIT.md) **[ICA]** ·
> [`ORIS_GAP_ANALYSIS.md`](ORIS_GAP_ANALYSIS.md) **[GAP]** ·
> [`ORIS_INTERACTION.md`](ORIS_INTERACTION.md) **[INT]** ·
> [`ORIS_VALUES.md`](ORIS_VALUES.md) **[VAL]** ·
> [`ORIS_TIME.md`](ORIS_TIME.md) **[TIME]** ·
> [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) **[AIA]**.
>
> **Status:** v0, 2026-08-04. Nothing here is a proposal to build.

---

## 0. Verdict

**The programme does not need rewriting. It needs one scoping correction, and that correction
changes what happens next.**

Three findings carry the document:

> **1. The programme was written as though ORIS were the only learner in the runtime. It is not,
> and never was.** Five adaptive loops predate the programme [ICA Loops A–E]. Every assumption
> that becomes false in Part 1 becomes false for this one reason. The fix is a scope, not a
> rewrite.
>
> **2. The real damage is not a broken rule — it is an uninterpretable corpus.** The Experience
> Stream records which route was taken; it does not record the trust state that selected the
> route [RSA Part 1]. **[INFERRED]** A year of Epoch 0 data will therefore show behaviour drifting
> with no recorded cause, which is fatal to H1, H3, H5 and H6 — not because the hypotheses are
> wrong, but because the data cannot test them. This is a measurement-precondition failure of
> exactly the class this repo already has doctrine about.
>
> **3. Stage B's boundary is wrong at both ends.** [PROG §3] claims phases ①②④⑤ already ship and
> that Stage B adds only ⑥⑦⑧. ② and ① do not ship as evidence [RSA Part 1], and ⑧ already ships
> as behaviour [ICA Loops A–E]. Stage B is simultaneously larger and smaller than written.

---

# PART 1 — Assumptions now false

## 1.1 Obsolete — must be rewritten

### O1 · "No adaptation above band B2, for the entire programme"

> [PROG §10]: *"**No adaptation above band B2**, for the entire programme."*
> [TIME §5]: *"run with everything above B2 read-only for a long time. Full instrumentation,
> zero adaptation."*

**[EXISTS — disproven by ICA Loops A–E.]** Five loops adapt behaviour today: rule trust gating
four routing sites, the plan cache, learned phrases, memory facts, and the transcript.

**[INFERRED — the band classification, by the documents' own definitions.]** [TIME §2] places
*"skills, habits, user model, competence"* at B4 (period: months). Rule trust is written from a
single turn, persisted across sessions and projects with no decay, and encodes both a user
preference and a competence belief. Its **period is B1 and its reach is B4-or-slower**.

[TIME §2.1] supplies the diagnostic without needing a new one:

> *"Reach ≈ k × period… A proposed subsystem whose period and reach are mismatched by orders of
> magnitude is almost certainly two subsystems."*

*Inference step:* the classification applies TIME's own content and period definitions to ICA's
audited facts. It is rejectable by arguing rule trust is a B2 working belief — but that reading
must explain why it survives every session boundary with no decay.

**Verdict: REWRITE.** The sentence is stated as an absolute over the whole programme and is false
of the runtime it governs. The minimal correction is Part 2.

**Mitigation already present, and it matters.** [ICA Part 7] establishes the trust gate requires
≥2 explicit signals, is Laplace-smoothed, and recovers. That is materially better than the
industry pattern [INT §7.1.2] and is *partial* compliance with [ARCH §5.2] prescription 1. What
is absent is interleaving, decay, and any band boundary.

### O2 · "The B6 learning loop's negative signal is currently dead in the running app"

> [PROG §12.1, Finding 0 related observation]: *"`recordRuleRejected` and `recordRuleConfirmed`…
> called **only from eval tests** — no production call site exists."*

**[EXISTS — disproven by ICA Part 7.]** Both have production call sites; the negative signal is
live.

**Verdict: REWRITE (factual correction).** It is cited as a known gap, so leaving it propagates a
false premise into anything that reads it.

### O3 · "The literal next step"

> [PROG §11]: *"One thing, small enough to start today: **Persist `DecisionTrace` as an
> append-only Experience Stream**… Everything else in this document waits on that file existing."*

**[EXISTS — satisfied.]** The stream ships, persisted, segmented on read, integrity-enforced
[GAP §1.6].

**Verdict: REWRITE.** Not false, but spent. §11 is the programme's forward pointer and now points
backwards; Part 6 supplies what replaces it.

## 1.2 Partially obsolete — update, do not rewrite

### P1 · Stage B's scope

> [PROG §3]: *"phases ①②④⑤ already ship inside the K4 planner. Stage B adds exactly the missing
> ones: ⑥ compare ⑦ attribute ⑧ adapt."*

**[EXISTS]** ② does not ship as evidence — `setSituation` has zero production call sites; ① does
not either — `beginDecision`/`observeFact` likewise [RSA Part 1; GAP §1.5].
**[EXISTS]** ⑧ ships as behaviour — five loops adapt [ICA Loops A–E].

**[INFERRED]** The claim conflates *the runtime does this* with *the corpus records this*. Both
readings are defensible for ④⑤; neither is for ①②. *Inference step:* the distinction is read from
Stage B's own dependency on recorded evidence for ⑥⑦.

**Verdict: UPDATE.** Stage B's scope is wrong at both ends — it under-counts (①② must be captured
before ⑥⑦ can run) and over-counts (⑧ exists, ungoverned). The stage survives; its boundary moves.

### P2 · Finding 0's severity

> [PROG §12.1, Finding 0]: *"the dominant outcome signals are not merely unjoined — **they are
> entirely invisible to Stage A as shipped**."*

**[EXISTS — partially disproven.]** ADR-017 shipped the second capture point Finding 0 called for:
editor action rows carrying `operation`, `initiator`, `actionIds`, `graphVersion`, `undoDepth`
[RSA Part 1; ICA Part 6].

**Verdict: UPDATE.** The raw material is now visible. What remains absent is the *derivation* —
and per ORIS-19 that was always going to be a policy, never a record. Finding 0's diagnosis was
right; its "entirely invisible" is now overstated.

### P3 · Stage A's acceptance test

> [PROG §A.3]: *"Stage A is done when a randomly chosen action from 30 days ago yields a complete,
> link-resolvable trace and a deterministic replay."*

**[EXISTS]** Unreachable as stated: facts, situation, and candidates are never emitted; confidence
lands on one path of three; `startedAt` on two of three [RSA Part 1].

**Verdict: UPDATE.** The test is correct and should not be weakened. It should name *which* fields
currently block it, so "Stage A is not done" is a diagnosis rather than a mood.

### P4 · Stage A ships "one thing… plus the Prediction Ledger"

> [PROG §2, A.1]: *"What ships: One thing: **the Experience Stream** (O1)… Plus the **Prediction
> Ledger** (O2), which is the only new *concept* in Stage A."*

**[EXISTS]** The stream ships; the ledger producer is declared with an empty kind list
[GAP §1.8; ICA Part 9].

**Verdict: UPDATE.** Stage A is not one stage but two with very different maturities. Treating it
as a unit makes "Stage A is incomplete" hide that half of it is finished and integrity-enforced.

## 1.3 Still valid — strengthened or untouched

| Assumption | Status | Evidence |
|---|---|---|
| [PROG §1] The freeze: physics frozen, biology near-frozen, **psychology open** | **VALID, and load-bearing** | [GAP §4] used it to admit a presence *view* without new state; [INT §7.2] used it to reject a new operator |
| [PROG §4 C.1] Segmentation is model selection, not labelling | **VALID, untested** | No audit bears on it |
| [PROG §4 C.2] The Prediction Ledger is also the episode segmenter | **VALID, untested** | Creates a dependency Part 3 makes explicit |
| [PROG §4 C.3] The N=1 hazard | **VALID — strengthened** | The sole subject is also the architect *and* the panel reader [INT §5.7 / observatory §5.7] |
| [PROG §5] The Closed-Loop Trace Test at ≥95% | **VALID** | Currently unpassable for the reasons in P3; the bar itself is untouched |
| [PROG §6] H1–H9 as pre-registered | **VALID** | See §1.4 for one that gained prior evidence |
| [PROG §7] Metrics, and body cost as a gate | **VALID — confirmed** | [ICA Loops G/H] show the body already self-regulates; ORIS-6 is enforceable |
| [PROG §8] Kill criteria | **VALID** | Unchanged |
| [PROG §11.1] The envelope freeze; producer ≠ kind; situation/facts/signals have three lifetimes | **VALID — confirmed** | Schema went v4→v6 additively [RSA Part 1] |
| [PROG §11.3] Suites are part of the trusted computing base | **VALID — confirmed** | [GAP §1.12]: the immune system ships and guards its own failure modes |
| [PROG §12] Record observations, never classifications | **VALID — structurally enforced** | [ICA Part 2] |

## 1.4 One hypothesis that gained prior evidence

**[INFERRED]** H9 — *"a single professional generates enough decision events to calibrate
anything"* — now has evidence bearing on it that the programme never counted. R1 distrusts a rule
after **≥2 explicit signals** [ICA Part 7] and ships as working behaviour. That is per-install
learning succeeding at very low data volume.

*Inference step:* this is evidence about **coarse-grained** learning (rule-level trust), and H9
asks about **calibration** (per-domain confidence curves), which is finer. It weakens the
pessimistic prior; it does not answer H9.

**Verdict: UPDATE H9's framing** to note that a coarse-grained per-install learner already works
in this runtime, so the question is one of *granularity*, not of *possibility*.

---

# PART 2 — Epoch validity

## 2.1 Can Epoch 0 still be called "records only, zero adaptation"?

**No.**

> [PROG §14]: *"**0 · Instrumented** | weeks | Records only. Full experience stream, full ledger,
> **zero adaptation**."*
> [TIME §5]: *"Epoch 0 Instrumented — B0–B2 live · E and P recording · **nothing above B2 writes**."*

**[EXISTS]** Five loops adapt [ICA Loops A–E]. **[INFERRED]** At least rule trust and learned
phrases write cross-session, cross-project structure at B4 reach (§1.1 O1). Therefore *"nothing
above B2 writes"* is false of the runtime.

## 2.2 Why this matters, and why the obvious reading is the wrong one

The tempting reading is *a rule is being violated*. **[INFERRED]** That reading is too weak and
slightly wrong.

Too weak, because ORIS-13 governs *ORIS's operators*, and no ORIS operator exists yet. Nothing
illegal is happening; the shipped brain's learning is [AIA]'s design, working as intended, and it
predates the programme.

The real consequence is **measurement**, and it is severe:

```
EXISTS   R1 changes which tier resolves a prompt, per user, over time   [ICA Loop A]
EXISTS   the corpus records `route` and `owner {tier, ruleId, …}`       [RSA Part 1]
EXISTS   the corpus does NOT record rule-trust state at decision time   [RSA Part 1]
─────────────────────────────────────────────────────────────────────────────────────
INFERRED a route change caused by a trust flip is indistinguishable, in the corpus,
         from a route change caused by a different prompt or a different timeline.
```

*Inference step:* follows from the coverage record's own semantics — an absent token means the
build could not observe the thing [RSA Part 1]. Rule-trust state is not among the coverage tokens.

**[INFERRED] What this breaks.** H1 (boundaries predicting corrections) reads corrections whose
cause is partly unrecorded drift. H3 (impasse learning vs continuous) cannot separate its two arms
because continuous learning is already running underneath. H5 (calibration convergence) measures a
moving target. H6 (divergence between installs) is the worst affected — **divergence caused by
R1–R5 will be attributed to ORIS**, which is precisely the claim H6 exists to test.

> **This is a measurement-precondition failure, not a design failure.** The programme's own
> doctrine applies: before trusting a number, prove the subsystem ran, the flag applied, and the
> instrument can tell the answers apart. Here the instrument cannot.

## 2.3 The minimal rewrite

Three edits. All reuse machinery the programme already has; none touches the ladder.

**E1 · Scope the phrase.** *"Zero adaptation"* → *"zero adaptation **by ORIS**; the habitat's
pre-existing learning (rule trust, plan cache, phrase learning, memory facts, transcript) continues
and is treated as part of the environment being observed."*
This is the whole correction. It restores truth and costs nothing, because it names what was
always the case.

**E2 · Add the precondition the epoch currently lacks.** Epoch 0's exit is calibration-gated
[ARCH §14]. It needs an *entry* gate too: **the habitat's adaptive state must be observable in the
corpus.** This is not a new mechanism — [PROG §12.1 item 3 / ADR-016 I12] already established that
absence is only interpretable against a coverage record. A learner whose state is invisible is the
same problem one band down.

**E3 · Apply C.3's existing split until E2 holds.** [PROG §4 C.3] already separates *development*
data from *evaluation* data. Until E2 is satisfied, all Epoch 0 data is development data: good for
"is the instrument working?", not for "is the theory right?" **[INFERRED]** This is the correct
status for the corpus today and requires no new rule.

## 2.4 Should the numbering change?

**No.** Two reasons, both from the documents.

1. **[TIME §5] makes an epoch a permission, not a phase** — *"an epoch is a band becoming
   writable."* Renumbering would imply the permission ladder changed. It did not: the bands ORIS
   may write are unchanged, and B6 still never opens.
2. **[INFERRED]** The pressure to renumber comes from wanting a slot for "the state where the
   habitat learns and ORIS only watches." That is not a new epoch — it is Epoch 0 correctly
   described. Inventing Epoch −1 or 0a would encode a scoping error as architecture, which is the
   failure [ARCH §1] warns about: building a box for something that is not a component.

**Verdict: numbering stands; the definition acquires a scope and an entry gate.**

---

# PART 3 — Research ordering

Derived from [GAP Part 8]'s dependency graph. **Research order, not implementation order** — each
item is a question, and each states what becomes answerable once it is answered. Items on the same
tier are independent.

```
TIER 0 — cheap, independent, no dependencies. Run in parallel.

  Q1 · Does Loop F close?
       Is there already an implicit self-model influencing behaviour?
       Evidence: [ICA Loop F] builds `user.aiProfile`; [ICA U1] no consuming query traced.
       ANSWERS NEXT: whether §1.8's self-model status is ABSENT or DISCONNECTED — which
       changes whether the Agent Model schema is new work or a formalisation.

  Q2 · Is the signal dense enough? (H9, partially)
       Evidence: existing corpus + [§1.4]'s prior that coarse learning already works.
       ANSWERS NEXT: whether the programme exists. [PROG §8] pivots hang on it.

  Q3 · Is habitat adaptation observable at the decision seam?
       Evidence: [RSA Part 1] coverage record excludes trust state.
       ANSWERS NEXT: whether ANY longitudinal claim from the corpus is attributable.
       ── This is the gate on H1, H3, H5, H6. Nothing longitudinal is answerable before it.

TIER 1 — the keystone.

  Q4 · What is the outcome derivation policy?
       ORIS-19 forbids recording outcomes; ORIS-20 requires derivations to name a policy;
       no policy has been written. Raw material exists [ICA Part 6].
       ANSWERS NEXT: the Prediction Ledger becomes constructible; phases ⑥⑦⑧ acquire an
       input; H3, H4, H5 become testable; Stage B acquires a start condition.
       ── [GAP §8.1] — five of seven top-level capabilities bottom out here.

TIER 2 — unlocked by Q4.

  Q5 · Is attribution tractable at useful granularity? (H4)
       ANSWERS NEXT: whether `adapt` can be belief-level or must be subsystem-level.
       [PROG §8] already states the survivable-but-weaker fallback.

  Q6 · What advances τ? [TIME §6 Q2]
       ANSWERS NEXT: H2, and every forgetting curve. Needs the surprise term, i.e. Q4.

  Q7 · Do error-spike boundaries beat fixed windows? (H1)
       Needs Q3 (attributable corrections) and, per [PROG §4 C.2], Q4.
       ANSWERS NEXT: whether episodes are the unit of consolidation at all.
       Baselines can be scored before Q4; the hypothesis cannot.

TIER 3 — unlocked by Q7.

  Q8 · Are the B2/B3/B4 boundaries real? [TIME §6 Q4]
       ANSWERS NEXT: whether epoch gating can be the mechanical permission check
       [TIME §5] promises, or stays a judgement call.

  Q9 · Is memory growth sublinear? (H7)
       Needs surprise-weighted retention, i.e. Q4 and Q6.
       ANSWERS NEXT: whether local-first survives.
```

**[INFERRED] Two structural facts about this order.**

- **Tier 0 is entirely answerable with existing instruments and no new code** [RSA U3; ICA U4;
  GAP §7]. That is unusual at this stage and should be exploited before anything is built.
- **Q3 and Q4 are both architectural rulings, not experiments.** [GAP Appendix B] counts three
  remaining architectural gaps; two of them are here, at the front of the order.

---

# PART 4 — Missing research questions

Questions no document asks. Each: why it matters, what evidence already exists, what would answer
it. **[INFERRED]** in every case that the question is absent — established by having read all nine
documents, which is weaker than a search over a corpus.

### M1 · The two-learner problem

**Question:** When ORIS's learning and the habitat's existing learning form conflicting beliefs
about the same user, which wins, and does either know the other exists?

**Why it matters.** [ARCH §9] defines one Agent Model schema instantiated twice, and defines its
relationship to the World Model. It defines no relationship to R1–R5, because those were not known
to be there. Both learners will conclude things about the same user from the same events. [VAL §5]
gives a conflict procedure for competing *error classes*, not competing *learners*.

**Evidence that exists.** [ICA Loops A–E]; [ARCH §9.2]; [VAL §5].

**What would answer it.** Not an experiment first — a ruling on precedence and observability,
followed by a measurement of how often the two diverge on the same corpus.

### M2 · One clock or two?

**Question:** Should the mind's cognitive tick be a subscriber to the body's existing loop, or a
second independent timer?

**Why it matters.** [ARCH §3.4] specifies FAST/SLOW/SLEEP cadences and [ICA Loops G/H] establish
that a body loop already runs, unstoppably, with a shared gate. ORIS-6 subordinates cognition to
the body budget. Nobody has asked whether "subordinate" means *inside the loop* or *beside it* —
and the two produce different failure modes under load.

**Evidence that exists.** [ICA Loops G/H, Part 10's single bridge]; ORIS-6; [ARCH §3.4].

**What would answer it.** A measurement of the existing bridge's latency and jitter
(`whenBackgroundIdle` → perception start), against the SLOW band's 1–5s requirement.

### M3 · What does honesty cost?

**Question:** Is read-time derivation affordable at corpus scale?

**Why it matters.** ORIS-19/ORIS-20 push interpretation to read time; [PROG §12.2] pushes
*everything derivable* to read time; [ARCH §21/ORIS-21] warns that a value persisted "just in
case" is a cached view that owes ORIS-20. If re-segmenting a year of corpus is not interactive,
the architecture's central epistemic commitment quietly degrades into "derive once and cache" —
which is the laundering channel ORIS-21 exists to close.

**Evidence that exists.** The stream has a 1500-row ceiling and `segment()` runs on read
[RSA Part 1; ICA Part 2]. No cost measurement exists anywhere.

**What would answer it.** Time `segment()` and a full τ recomputation over a synthetic corpus at
1×, 10×, and 100× the current ceiling. A kill criterion is available: if re-derivation is not
interactive at the intended retention, either retention or the commitment must change.

### M4 · Does the instrument change the corpus?

**Question:** Does developer-visible cognition change how the developer edits — and therefore what
Epoch 0 records?

**Why it matters.** [PROG §4 C.3] covers N=1 *subject* bias. It does not cover *instrument-induced*
bias. The observatory panel is read by the same person who generates the corpus, and
[INT / observatory §5.1] establishes the observer effect as a live validity threat.

**Evidence that exists.** The observatory's arm-split property — the flag gates the view, not the
recording — makes this measurable with no new code.

**What would answer it.** Randomised panel-on / panel-off sessions on the same seat, comparing
prompt shape, tier distribution, and undo rate.

### M5 · Is a zero wrong-fire budget compatible with learning at all?

**Question:** Can any promotion ever occur under a strictly-zero wrong-fire gate?

**Why it matters.** [PROG §7] makes wrong-fire *"MUST remain zero — non-negotiable"* and
[ARCH §12.2] gives probation a *"wrong-fire budget of ZERO"*. But [ARCH §14] Epoch 3 promotes
compiled reflexes into novel contexts. **[INFERRED]** A newly compiled reflex firing in a context
it has never seen cannot carry a guaranteed-zero error rate; the only way to guarantee zero is to
promote nothing genuinely new. If that is right, the gate does not slow Epochs 2–4 — it forecloses
them. This is a programme-killing constraint hiding in a metrics table, and it has never been
examined.

**Evidence that exists.** [PROG §7]; [ARCH §12.2, §14]; and, positively, [ICA Loop A] — R1 is
precision-preserving by *escalating* rather than firing, which is one existence proof that some
learning is compatible with the gate.

**What would answer it.** A definitional analysis first: does "wrong-fire" mean *a rule fired and
was wrong*, or *a promotion caused a regression*? R1's escalate-don't-fire pattern suggests the
gate is satisfiable by construction for a class of changes. Whether that class includes compiled
reflexes is the actual question.

### M6 · Do beliefs survive a change of body?

**Question:** When the renderer changes, are craft beliefs formed under the previous build still
valid?

**Why it matters.** [ORIS_SELF §6] treats an upgrade as an autobiographical event and `buildId` is
recorded [RSA Part 1]. But this product's renderer changes constantly, and the render-parity rule
means a change to `composition → pixels` changes the ground truth every craft belief was fitted
to. Nothing specifies whether such a change should cascade-invalidate beliefs the way the fact
store cascade-invalidates facts.

**Evidence that exists.** `buildId` in the session payload; the fact store's dependency cascade;
the pixel gates.

**What would answer it.** Partition an existing corpus by `buildId` and test whether beliefs
fitted before a known renderer change predict outcomes after it.

### M7 · Is there a minimum viable episode?

**Question:** Below what event count can an episode support any statistic at all?

**Why it matters.** [TIME §3] and [PROG §4] treat segmentation as a boundary-placement problem.
Neither asks about *size*. Since episode count drives every promotion threshold [TIME §3], a
segmentation that produces many tiny episodes is not merely wrong, it is silently miscalibrating.
This is distinct from H9: H9 asks about total volume, this asks about per-episode density.

**Evidence that exists.** [TIME §3]'s anti-signals exist precisely because naive segmentation
shreds a creative act — the concern is stated, the threshold never is.

**What would answer it.** Sweep minimum-episode-size as a parameter inside the existing Stage C
model-selection frame; it costs one more axis on an analysis already planned.

---

# PART 5 — Contradictions

Genuine cross-document contradictions: one document assumes X, another establishes not-X. Wording
differences excluded.

### C1 · Adaptation above B2

- **Assumes:** [PROG §10] *"no adaptation above band B2, for the entire programme"*; [TIME §5]
  *"nothing above B2 writes"*.
- **Establishes not-X:** [ICA Loops A–E] — five adaptive loops, at least two with B4 reach
  (§1.1 O1).
- **Severity: HIGH.** Two documents affected. Resolution in Part 2.

### C2 · The history-substrate universal

- **Assumes:** [ARCH §1.2 item 1] *"**Nothing in the ten models can exist without a history
  substrate underneath it.** This is the single largest omission."*
- **Establishes not-X:** [ICA Loops A–E] — five learning loops exist and change behaviour with **no
  history substrate at all**. [GAP §5.1] already recorded this.
- **Severity: MEDIUM.** The universal is falsified; the practical claim (a stream is needed for
  *good* learning) is untouched. It matters because the architecture uses this universal to justify
  the stream's priority, and the true justification is different: not *learning is impossible
  without it* but *learning is ungovernable without it*.

### C3 · Where the cascade boundary already moves

- **Assumes:** [ARCH §5.4 item 1] *"the missing piece is letting them actually move the cascade
  boundary — per user."*
- **Establishes not-X:** [ICA Loop A] — `isRuleTrusted` gates four routing sites; a distrusted rule
  escalates, per user, persisted.
- **Severity: LOW.** One named gap closes. [ARCH §5.4 item 2] (context-bound habits) remains open
  and is confirmed.

### C4 · Which phases ship

- **Assumes:** [PROG §3] *"phases ①②④⑤ already ship inside the K4 planner."*
- **Establishes not-X:** [RSA Part 1] — ② (σ) and ① (facts) have zero production call sites.
- **Severity: MEDIUM.** Stage B's start condition is wrong. §1.2 P1.

### C5 · The negative learning signal

- **Assumes:** [PROG §12.1] *"no production call site exists… currently dead in the running app."*
- **Establishes not-X:** [ICA Part 7].
- **Severity: LOW but propagating.** It is cited as a known gap.

### C6 · Are interoceptive signals discarded?

- **Assumes:** [ARCH §3.2] *"Today they are telemetry read by humans in a HUD"* — i.e. unused.
- **Establishes not-X:** [ICA Part 3] — every idle and speculative observation already awaits
  `whenBackgroundIdle()`; the gate is a working consumer.
- **Severity: LOW.** The architecture *understates* its own position. The gap [ARCH §3.2] asserts
  (cognitive policy modulated by body state) remains real [ICA K5] — the bridge exists and is
  narrow, not absent.

### C7 · Values are checkable against `act`

- **Assumes:** [VAL §6] *"T0 classes function as VETOES, not costs… this is checkable by inspecting
  `act`'s implementation."*
- **Establishes not-X:** [ICA Part 9; GAP §1.11] — no `act` operator exists; `V` is absent at
  runtime.
- **Severity: LOW.** A forward-looking statement written in the present tense. Worth marking as
  aspirational so [VAL §7]'s *"values as theatre"* defence is not mistaken for something currently
  enforced.

### C8 · Zero wrong-fire vs. compiled reflexes — an internal contradiction

- **Assumes (A):** [PROG §7] *"Wrong-fire count MUST remain zero… non-negotiable"*; [ARCH §12.2]
  probation carries a *"wrong-fire budget of ZERO"*.
- **Assumes (B):** [ARCH §14] Epoch 3 promotes *"impasse-chunking; context-guarded reflexes"* —
  fast paths acting in contexts they have not seen.
- **[INFERRED]** A and B cannot both hold in full: a reflex promoted into a novel context cannot
  carry a guaranteed-zero error rate.
- **Severity: HIGH — and it is the only contradiction here that no audit revealed.** It was
  latent in the documents before any code was read. See M5.

---

# PART 6 — The next paper

> ## Write **`ORIS_OUTCOME.md`** — the outcome derivation policy, and the two-learner reconciliation it forces.

**Not the ledger. Not a revised programme. The outcome policy.**

## 6.1 What it must settle

One question with two faces, which is exactly why it is one document rather than two:

1. **The derivation.** ORIS-19 rules that outcomes are never recorded, because no producer
   witnesses *accepted* or *rejected*. ORIS-20 rules that every derived value names its policy and
   version. **No such policy exists.** The raw material does: editor action rows carrying
   `operation`, `initiator`, `actionIds`, `graphVersion`, `undoDepth`, joinable to decision rows
   [ICA Part 6]. The document names how *accepted · tweaked · undone · ignored · superseded ·
   survived-to-export* are computed from witnessed events, with a version.
2. **The reconciliation.** An undo following an AI commit is simultaneously an outcome for ORIS's
   future ledger and a rejection signal for R1, which already consumes it today [ICA Loop A].
   **The outcome seam is the precise site where the two-learner problem (M1) becomes concrete** —
   the same event, two consumers, no specified relationship. Writing the derivation without ruling
   on this would produce a policy that silently competes with shipped behaviour.

## 6.2 Why it unlocks the most

| Unlocked | Evidence |
|---|---|
| **The Prediction Ledger** — the architecture's own keystone | [ARCH §1.2 item 2]; it needs outcomes and nothing else it lacks |
| **Phases ⑥ ⑦ ⑧** — the whole of Stage B | [PROG §3]; ⑥ needs an outcome to compare against |
| **H3, H4, H5** | all require claim↔outcome pairing |
| **H1 via [PROG §4 C.2]** — if the ledger is the segmenter, segmentation waits here too | [PROG §4 C.2] |
| **Surprise weighting → τ → forgetting → H2, H7** | [ARCH §13.2]; `tauInputs.surprise` is `null` pending exactly this |
| **Calibration — Stage A's one legitimate user-facing artifact** | [PROG §A.4] |
| **Five of seven top-level capabilities** | [GAP §8.1] |

**[INFERRED]** No other single document has comparable fan-out. A revised programme (Part 2's E1–E3)
is three edits, not a paper. The Agent Model schema depends on the ledger. Consolidation depends on
segmentation which depends on the ledger. Every path runs through here.

## 6.3 Why now, and why it is a paper rather than a task

- **It is a ruling, not code.** [GAP Appendix B] counts three remaining architectural gaps; this is
  one, and rulings are what documents produce.
- **Its prerequisites are already met.** The corpus records both sides; the join mechanism (`refs`)
  ships; the integrity model that constrains the answer is enforced [ICA Part 2].
- **Work has already begun.** `plans/oris-outcome-seam-design.md` exists and its Q5 motivated the
  shipped write-grain probe [RSA Part 6]. This is a continuation, not a start.
- **It converts Part 2's contradiction from a blocker into a scoped precondition.** Ruling on who
  owns the outcome signal is what makes E1's scope meaningful rather than semantic.
- **[UNKNOWN]** Whether the derivation can achieve useful precision from commit/undo rows alone is
  not settled by any audit. That uncertainty belongs *in* the paper, as its central risk — not as
  a reason to defer it.

## 6.4 What should not be written next, and why

- **A revised `ORIS_RESEARCH_PROGRAMME.md`.** Part 2's rewrite is three edits to existing text.
  Rewriting the programme before the outcome policy exists would re-plan around an unresolved
  keystone.
- **The Prediction Ledger specification.** It is the obvious candidate and it is premature: its
  only unmet input is the outcome policy.
- **Anything about identity, drives, or governance.** [GAP Part 8] places all of them below the
  ledger.

---

# PART 7 — Speculative

**Contains no findings. Nothing above depends on anything here.**

- Whether the five habitat loops should eventually be subsumed by ORIS's machinery, governed in
  place, or left alone permanently is not determinable from the audits. All three are coherent.
- Whether M5's zero-wrong-fire contradiction resolves by redefining wrong-fire, by bounding it per
  context, or by accepting that Epoch 3 is unreachable is unknown.
- Whether a coarse learner that already works (R1) is evidence that the fine-grained learning the
  programme wants is *unnecessary* rather than merely *harder* is a question this document does not
  raise as a finding.
- No claim is made about effort, sequencing beyond Part 3's dependency ordering, or priority
  against product work.

---

## Appendix A — Answer index

| Question asked | Section |
|---|---|
| Assumptions now false — obsolete | §1.1 (O1–O3) |
| — partially obsolete | §1.2 (P1–P4) |
| — still valid | §1.3, §1.4 |
| Rewrite vs update, per assumption | verdict line in each entry |
| Epoch 0 validity | §2.1 |
| Why exactly | §2.2 |
| Minimal rewrite | §2.3 (E1–E3) |
| Should numbering change | §2.4 — no |
| Research ordering | Part 3 (Q1–Q9, four tiers) |
| Missing research questions | Part 4 (M1–M7) |
| Contradictions | Part 5 (C1–C8) |
| The next paper | Part 6 |
| Speculative, isolated | Part 7 |

## Appendix B — Change list for the programme

Consolidated so the edits are actionable without re-reading this document. **These are corrections
to existing text, not new content.**

| # | Target | Change | Class |
|---|---|---|---|
| 1 | [PROG §10] | Scope "zero adaptation" to ORIS; name the habitat's five loops as environment | rewrite |
| 2 | [PROG §14] / [TIME §5] | Add Epoch 0's entry gate: habitat adaptive state must be observable | rewrite |
| 3 | [PROG §4 C.3] | Extend the development/evaluation split to cover the E2 precondition | update |
| 4 | [PROG §12.1] | Correct the "negative signal is dead" observation | correction |
| 5 | [PROG §12.1] | Soften Finding 0's "entirely invisible" — the second capture point shipped | update |
| 6 | [PROG §3] | Restate Stage B's boundary: ①② absent as evidence, ⑧ present as behaviour | update |
| 7 | [PROG §2 A.1] | Split Stage A's two halves by maturity | update |
| 8 | [PROG §A.3] | Name the fields currently blocking the acceptance test | update |
| 9 | [PROG §6] H9 | Reframe as granularity, not possibility (§1.4) | update |
| 10 | [PROG §11] | Replace the spent "literal next step" with Part 6's recommendation | rewrite |
| 11 | [ARCH §1.2 item 1] | Weaken the universal; restate the stream's justification as governability | correction |
| 12 | [ARCH §5.4 item 1] | Mark as achieved; keep item 2 open | correction |
| 13 | [ARCH §3.2] | Note the gate as an existing interoception consumer | correction |
| 14 | [VAL §6] | Mark the `act` veto claim as aspirational until `act` exists | correction |
| 15 | [PROG §7] / [ARCH §12.2, §14] | Record C8 as an open contradiction; do not resolve it here | new open question |
