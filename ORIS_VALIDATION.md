# ORIS — Validation

> **What this file is:** the definitive reference for how ORIS will be scientifically validated
> over the coming years. It answers one question: **how can we prove ORIS became what the
> architecture claims?** — and, where the honest answer is *we currently cannot*, it says so and
> names the prerequisite.
>
> **What this file is not:** implementation, API design, or redesign. It contains no software
> engineering. Appendix E is the only speculative section.
>
> **The central methodological problem, stated up front because everything else depends on it:**
> ORIS's validation instruments *are* ORIS's components. The Prediction Ledger is simultaneously
> the mechanism under test and the device that measures calibration. The Experience Stream is
> both the memory being evaluated and the corpus the evaluation reads. **A system cannot validate
> itself.** Part 1.4 is this paper's answer, and it determines the shape of everything after it.
>
> **Evidence discipline**, consistent with the corpus. No source code was inspected.
>
> | Label | Meaning |
> |---|---|
> | **[EXISTS]** | Established by an audit or by a document's own measurement. |
> | **[CONFIRMED]** | Two independent documents agree, or a prediction was measured and held. |
> | **[INFERRED]** | Derived here by applying a document's stated rule to established fact. The inference step is named. |
> | **[OPEN QUESTION]** | Unsettled; what would settle it is named. |
> | **[ARCHITECTURAL RULE]** | A validation commitment. Numbered `VAL-n`. |
> | **[RESEARCH QUESTION]** | Requires an experiment. Numbered `V-n` where it is a hypothesis. |
> | **[BLOCKED]** | Cannot be measured today. The prerequisite is named. |
>
> **Sources:** [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) **[ARCH]** ·
> [`ORIS_VALUES.md`](ORIS_VALUES.md) **[VAL-D]** · [`ORIS_TIME.md`](ORIS_TIME.md) **[TIME]** ·
> [`ORIS_RESEARCH_PROGRAMME.md`](ORIS_RESEARCH_PROGRAMME.md) **[PROG]** ·
> [`ORIS_RUNTIME_STATE_AUDIT.md`](ORIS_RUNTIME_STATE_AUDIT.md) **[RSA]** ·
> [`ORIS_IMPLICIT_CYCLE_AUDIT.md`](ORIS_IMPLICIT_CYCLE_AUDIT.md) **[ICA]** ·
> [`ORIS_GAP_ANALYSIS.md`](ORIS_GAP_ANALYSIS.md) **[GAP]** ·
> [`ORIS_PROGRAMME_REVISION.md`](ORIS_PROGRAMME_REVISION.md) **[REV]** ·
> [`ORIS_OUTCOME.md`](ORIS_OUTCOME.md) **[OUT]** ·
> [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) **[AIA]**.
>
> **Status:** v0, 2026-08-04. Research paper. **No validation has been performed.**

---

## 0. The result in six sentences

1. **The architecture's claims divide into three kinds that require three incompatible validation
   methods** — structural (proof), behavioural (measurement against baseline), developmental
   (longitudinal cohort comparison) — and the claims ORIS is most distinctive for are almost all
   in the third and most expensive class [Part 2].

2. **Nothing ORIS measures about itself is admissible without an external referent**, and the
   system currently has exactly one candidate: user-declared verdicts. That elevates
   [OUT R5] from "valuable measurement" to **the anchor of the entire validation programme**
   [Part 1.4].

3. **Of the eleven metrics [PROG §7] names, three are measurable today, three are partially
   measurable, and five are blocked** — and the blockers are named prerequisites, not unknowns
   [Part 4].

4. **No null model has ever been written for any ORIS hypothesis.** Every headline claim —
   divergence, calibration improvement, sublinear memory — has an ordinary explanation that would
   produce the same observation, and none is currently controlled for [Part 3.3].

5. **A previously unexamined line in [AIA] may invalidate [OUT]'s two-learner analysis and
   contaminate every longitudinal measurement**: Habitat is documented as already running an
   implicit, fixed-window, unversioned outcome derivation. This is now the highest-priority
   prerequisite in the programme [Part 5.1].

6. **The programme has kill criteria for its hypotheses but none for itself.** Part 13.4 supplies
   the missing one: the condition under which the honest conclusion is that ORIS's developmental
   claims are permanently unvalidatable and must be narrowed.

---

# PART 1 — Validation philosophy

## 1.1 What "prove" means here

**[EXISTS]** The architecture already did the hardest part of this. [ARCH §0] rejects *"an evolving
intelligent being"* as **unfalsifiable** — *"nothing can be measured against it, so nothing can be
wrong, so no design can be rejected"* — and replaces it with an engineering restatement plus a
metric per clause.

**[ARCHITECTURAL RULE VAL-1 · Validation means falsification, never demonstration.** A validation
activity that can only confirm is not validation. Every experiment in this paper states what
result would count against the architecture, and an experiment without such a statement is not
admitted.]

**[INFERRED]** This has an unpopular consequence worth stating early: **a successful demo is not
evidence.** The architecture is full of properties that a demo would show and a measurement would
not — situatedness, character, understanding. [ARCH §17] already names *"unfalsifiable success"*
(*"it feels alive" as the acceptance criterion*) as a failure mode. Validation's job is to make
that failure mode unreachable. *Inference step:* follows from VAL-1 plus ARCH §17.

## 1.2 What is being validated

Three different things, routinely conflated:

```
1. THE IMPLEMENTATION    does the code do what the architecture says?
                         → the eval harness already answers this class  [GAP §1.12]

2. THE ARCHITECTURE      do the mechanisms produce the claimed properties?
                         → this paper's subject

3. THE THESIS            is a resident cognitive architecture in a professional tool
                         worth building at all?
                         → answered only by 2 plus adoption; explicitly out of scope
```

**[ARCHITECTURAL RULE VAL-2 · Never validate level 2 with level 1 evidence.** *"The consolidation
pass ran and produced patterns"* is an implementation fact. *"Consolidation produced better
predictions than not consolidating"* is an architecture fact. The first is routinely mistaken for
the second, and the eval harness's excellence makes that mistake easier here than elsewhere.]

## 1.3 Instrument before subject

**[EXISTS]** The repo already holds this doctrine and has paid for it repeatedly. [SEAM §14.3]
records a probe placed inside the wrong branch, which *"duly reported 'undo does not write'"* — a
number wrong for reasons having nothing to do with the system. [PROG §11.3] records a ratchet whose
first two versions *"reported success without running tsc at all."* [SEAM §14.0] records three runs
reading "no parameter control exists" because a panel defaults to collapsed.

**[EXISTS]** [SEAM §14.0.4] states the asymmetry precisely: *"A probe that confirms absence proves
nothing about presence."*

**[ARCHITECTURAL RULE VAL-3 · No measurement of ORIS is admissible until its instrument has
demonstrated both directions** — detecting a signal known to be present, *and* reporting absence
for one known to be absent. One-directional instrument validation is the modal failure in this
repo's history and is not a hypothetical risk.]

## 1.4 The instrument–subject circularity, and the only escape

**[INFERRED] This is the central methodological problem of the ORIS programme, and no document has
stated it.**

```
Claim               "ORIS is well calibrated"
Measured by         the Prediction Ledger
Which is            an ORIS component under test
Against             outcomes derived by a policy ORIS owns  [OUT]
Which was           written by the same programme

→ a closed loop. A miscalibrated ledger scoring against a mis-specified derivation
  can report excellent calibration indefinitely, and nothing inside the system
  can detect it.
```

*Inference step:* the circularity follows from [OUT Part 5] (outcomes are derived under a policy
ORIS names) plus [ARCH §7] (calibration is measured by the ledger). Neither document states the
consequence.

The same shape recurs: memory quality judged by retrieval ORIS performs; attribution judged by
ORIS's own error signal; identity judged by ORIS's own character sheet.

**[ARCHITECTURAL RULE VAL-4 · Every ORIS claim requires an external referent, and a claim without
one is marked unvalidatable rather than assumed.** Four referent classes exist, in descending
strength:

| Referent | Strength | Availability |
|---|---|---|
| **Deterministic replay** — the renderer is ground truth | strongest; no model bias | **[EXISTS]** [ARCH §8.1]; pixel gates ship |
| **Human labelling** — hand-labelled held-out traces | strong; expensive; N-limited | **[BLOCKED]** — see Part 8.3 |
| **Declared verdicts** — user assertions of meaning | moderate; sparse; the only *live* referent | **[EXISTS]** [OUT Part 3.2] |
| **Ablation** — remove the mechanism, re-measure | moderate; the workhorse | **[BLOCKED]** — needs the mechanisms |
]

**[INFERRED] The consequence is the single most useful result in this paper.** Of the four, only
deterministic replay and declared verdicts exist today. Replay validates *simulation* and nothing
else. **Therefore declared verdicts are currently the only external anchor for every behavioural
claim ORIS makes** — which promotes [OUT R5] (*agreement rate between declared and derived
verdicts*) from a useful measurement to **the foundation the rest of the programme stands on.**
Nothing downstream is trustworthy until it is measured.

## 1.5 What will never be validated, and is not a target

**[EXISTS]** [ARCH §0]: *"Nothing in this document claims or requires phenomenal consciousness…
Treating subjective experience as an engineering target reliably produces theater."*

**[ARCHITECTURAL RULE VAL-5 · The following are permanently out of scope and no experiment may be
proposed for them:** phenomenal experience; whether ORIS "understands"; whether it "really" has a
self; user-reported impressions of aliveness. Subjective instruments are admissible **only** for
claims explicitly about human perception (e.g. [OUT]'s interaction hypotheses), never as evidence
about ORIS's internal states.]

---

# PART 2 — The claim taxonomy

**[INFERRED]** Every architectural claim falls into exactly one class, and the class determines
the method, the cost, and the earliest possible result. *Inference step:* the taxonomy is
constructed here from the claims in [ARCH §0]'s metric table; it is a classification, not a finding.

| Class | Question | Method | Referent | Earliest result | Example claims |
|---|---|---|---|---|---|
| **S · Structural** | Does the system have the property by construction? | Inspection, proof, deterministic test | none needed | **now** | ORIS-19 enforcement; band coherence; determinism of derivation [OUT OD-18]; ORIS-1 |
| **B · Behavioural** | Does the mechanism outperform its absence? | Measurement vs baseline + ablation | ablation / replay / declarations | months | calibration; segmentation validity; attribution accuracy; memory growth |
| **D · Developmental** | Did the system *become* something over time? | Longitudinal cohort comparison | cohorts + null model | **years** | divergence; identity formation; competence growth; explanation decay |

## 2.1 The uncomfortable finding

**[INFERRED]** Sorting [ARCH §0]'s own metric table by class:

```
STRUCTURAL     ~4 claims    validatable now, cheaply, and several already are
BEHAVIOURAL    ~6 claims    validatable within the programme, all currently blocked (Part 4)
DEVELOPMENTAL  ~5 claims    the architecture's most distinctive claims — divergence,
                            identity, "becomes something" — and NONE is validatable
                            within a horizon the programme has planned for
```

*Inference step:* the counts are a classification of ARCH §0's seven vision rows plus the
programme's H1–H9; another reader might sort two or three differently. The ratio is the finding,
not the exact numbers.

**[ARCHITECTURAL RULE VAL-6 · Class D claims are provisional until cohort data exists, and must be
labelled as such in every document that makes them.** An architecture whose distinguishing claims
are all class D is not thereby wrong — but it must not present class S successes as evidence for
them. This is VAL-2 at the programme level.]

---

# PART 3 — Observable behaviours, and their null models

## 3.1 Operationalisation

**[INFERRED]** A claim is only validatable once it names a behaviour an outsider could observe.
Translating the architecture's claims:

| Architectural claim | Observable behaviour | Class |
|---|---|---|
| Situated cognition [ARCH §3] | Cognitive policy differs measurably between loaded and idle body states | B |
| Resident, not assistant [ARCH §3.4] | Useful work is produced on ticks with no user query | B |
| Calibrated self-knowledge [ARCH §7] | Stated confidence tracks realised frequency per domain | B |
| Knows its weaknesses [ARCH §0] | A measurable fraction of its own failures were pre-flagged low-confidence | B |
| Learns from impasses [ARCH §5.3] | Repeated impasses of one shape stop escalating | B |
| Memory is bounded [ARCH §13] | Bytes per episode falls as models mature | B |
| Adapts without instruction [ARCH §0] | Behaviour changes with evidence chains and zero explicit instruction | B |
| Identity forms [ARCH §10] | A stratum exists whose learning rate has decayed and whose contents survive contradiction | D |
| Installs diverge [ARCH §14.2] | Two installs produce different outputs on an identical held-out corpus | D |
| Optimises user capability [ARCH §6.4] | User competence rises; perfect predictability is flagged | D |
| Explanation declines [ARCH §9.3] | Explanations per accepted contribution falls over months | D |

## 3.2 What each measurement is against

**[ARCHITECTURAL RULE VAL-7 · No measurement without a baseline named in advance.** A number with
no comparator is a description. [PROG §4 C.1] already applies this to segmentation (*"a
segmentation that cannot beat a fixed window is not earning its complexity"*); it generalises to
every row above.]

## 3.3 The missing null models

**[INFERRED] No ORIS hypothesis has ever had a null model written for it, and every headline claim
has an ordinary explanation that would produce the same observation.** *Inference step:* absence
established by having read the corpus; [PROG §6]'s falsifiers state what result refutes each
hypothesis but not what *else* could produce a confirming result.

| Claim | The ordinary explanation that would look identical | Required control |
|---|---|---|
| **Installs diverge** (H6) | Two users differ. A *frozen-psyche* install would diverge too, because the inputs differ | A non-learning install on the same inputs. **Without this, H6 measures nothing** |
| **Calibration improved** (H5) | The user's asks got easier, or the domain mix shifted | Stratify by domain and by task difficulty; report the mix |
| **Memory growth is sublinear** (H7) | Usage declined; the user got busier | Normalise by decision volume, not by wall time |
| **Explanation declined** (H8) | The user stopped reading explanations; the UI changed | Hold the surface constant; measure per *accepted contribution* |
| **Impasses stopped escalating** | The user learned to phrase requests the fast paths accept | **Habitat already causes this** — [ICA Loop C] learns the user's phrasings. The confound is inside the system |
| **Competence grew** | The projects got easier | Fixed held-out benchmark corpus (Part 12) |

**[ARCHITECTURAL RULE VAL-8 · Every hypothesis carries a null model naming what else could produce
a confirming result.** [PROG §6] should be extended accordingly; the falsifier and the null model
are different objects and both are required.]

**[INFERRED] The H6 case is the most severe** and is worth isolating: divergence is [ARCH §16]'s
third-ranked novel claim and [ARCH §14.2] states *"no divergence machinery is required"* because
path dependence produces it mechanically. But path dependence *also* produces divergence in a
system with no learning at all, purely from different inputs. **H6 as currently written cannot
distinguish the architecture's claim from the trivial one.** The control is a frozen-psyche install
— which [ARCH §10.5]/ORIS-7's portable, resettable psyche volume already makes conceivable, though
[GAP §1.12] establishes it is six localStorage keys rather than one volume today.

---

# PART 4 — What can honestly be measured today

Per the brief's instruction. Grounded in the audits; the prerequisite is named in every blocked row.

## 4.1 The metrics [PROG §7] names

| Metric | Status | Evidence / prerequisite |
|---|---|---|
| **Body cost** (frame time, gate occupancy) | **MEASURABLE NOW** | Frame stats and gate are subscribable module singletons [ICA Parts 2–3] |
| **Wrong-fire count** | **MEASURABLE NOW** (with a caveat) | `brain:eval` ships [GAP §1.12]. Caveat: wrong-fire is itself a *derived outcome*, so under [OUT OD-11] it needs a linkage class and window or it is not well-defined. See [REV C8] |
| **Override rate** | **MEASURABLE NOW** | Decision rows + action rows exist; derivable per [OUT]. **This is the first real consumer of the Experience Stream** [ICA §7.1] |
| **Memory growth** (bytes/episode) | **PARTIAL** | Stream reports bytes/row and derives episodes [RSA Part 1]. Blocked for the *whole* system: Habitat's five stores lack ceilings and instrumentation [ICA K3] |
| **Segmentation predictive validity** | **PARTIAL** | Baselines are runnable on the existing corpus [PROG §4]. The hypothesis (H1) needs the ledger |
| **Explanation rate** | **PARTIAL** | A `t0.why` route exists [OUT/observatory]. **[OPEN QUESTION V-Q1]:** whether explanation events are distinguishable in the corpus was not established by any audit |
| **Calibration (ECE/Brier)** | **BLOCKED** | No ledger [ICA Part 9]; confidence recorded on 1 of 3 paths [RSA Part 1]. Prerequisites: ledger + confidence coverage + [OUT] derivation |
| **Attribution accuracy** | **BLOCKED** | No attribution phase; and it needs a human-labelled held-out corpus that does not exist (Part 8.3) |
| **Next-action top-k** | **BLOCKED** | No user model; no Agent Model schema [GAP §1.8] |
| **Divergence** | **BLOCKED** | Needs ≥2 installs, a portable psyche volume, and a null-model control (§3.3) |
| **Identity / character sheet** | **BLOCKED** | No plasticity gradient [GAP §1.12] |

**Tally: 3 measurable, 3 partial, 5 blocked.**

## 4.2 Measurements available today that no metric currently names

**[INFERRED]** The audits exposed measurable quantities the programme never listed:

| Quantity | Why it matters | Availability |
|---|---|---|
| **Declared-vs-derived agreement rate** | The external anchor (§1.4); precursor to H4 | Now [OUT R5] |
| **Tier distribution of live traffic** | Bears directly on H9, the programme's existence question | Now [REV Part 3 Q2] |
| **Habitat drift rate** — how often rule trust flips | Quantifies the confound in §5.1 | **[BLOCKED]** — trust state is unrecorded [REV §2.2] |
| **Undo–redo netting statistics** | Validates [OUT OD-15]'s assumption | Now [OUT R2] |
| **Corpus asymmetry** — rejection vs success evidence | Biases every calibration study | Now [OUT R3] |
| **Re-derivation cost** | Determines whether [OUT OD-18/19] survive contact | Synthetic corpus [OUT R4] |

---

# PART 5 — The confound register

**[ARCHITECTURAL RULE VAL-9 · Confounds are registered permanently, with a status, and reported in
every result.** A confound discovered and then forgotten is worse than one never found, because
the intervening results carry unearned credibility.]

## 5.1 C-1 · Habitat's concurrent learning — and a newly surfaced escalation

**[EXISTS]** Five Habitat loops adapt behaviour today [ICA Loops A–E]. **[EXISTS]** The corpus
records which route was taken but not the trust state that selected it, so drift is unattributable
[REV §2.2]. **[EXISTS]** [REV] rates this the blocking programme question; [OUT OD-25] forbids
cross-learner attribution until it is fixed.

> **[EXISTS] — and this escalates the problem materially.** [AIA] documents the B6 learning loop as
> shipping with *"implicit signals (undo-a-brain-edit-within-60 s = reject; moving on to a new
> prompt with edits standing = weak confirm)."*
>
> **[INFERRED] If accurate, Habitat already runs an outcome derivation** — behavioural, not
> declaration-class: a fixed 60-second window, an unversioned linkage rule, and no recorded policy.
> That is precisely what [OUT OD-6] forbids (*"there is no default window"*), what [OUT OD-16]
> constrains (*undo is PROXIMATE at best*), and what [OUT OD-2] requires be named.
>
> **[OPEN QUESTION V-Q2 — HIGHEST PRIORITY IN THE PROGRAMME.** [ICA Part 7] enumerated the
> production write sites of Habitat's trust counters but **did not enumerate their triggers**. So
> no audit confirms or refutes that the documented implicit rule is live. Three consequences follow
> if it is:
>
> 1. **[OUT §14.2]'s dissolving observation is weakened.** [OUT] explicitly flagged this as its
>    Q4 — *"if some are behavioural, the two learners overlap more than this part assumes and
>    §14.4 needs revisiting."* This is that condition firing.
> 2. **Two derivation policies would be acting on the same events**, one of them unversioned and
>    unrecorded — making [OUT OD-23] (disagreement is a finding) unmeasurable, because one side's
>    reasoning is not inspectable.
> 3. **Every longitudinal measurement is contaminated at the source**, since the corpus was
>    generated by a system already acting on a competing reading of the same undos.
>
> *Settles by:* enumerating the trigger of each trust-counter write site. This is a lookup, not an
> experiment, and it should precede all other validation work.]

**[INFERRED] Isolated, not resolved**, per the corpus convention: [AIA] is a status document and
[ICA] is an audit; they do not contradict each other, because the audit never examined the
question. The contradiction is *potential*, and resolving it is a one-lookup prerequisite.

## 5.2 The register

| # | Confound | Status | Mitigation | Source |
|---|---|---|---|---|
| **C-1** | Habitat learns concurrently; possibly via a hidden derivation | **OPEN — blocking** | Record trust state (REV E2); settle V-Q2 | REV §2.2; AIA B6 |
| **C-2** | Observer effect — the subject reads the instrument | **OPEN** | Randomised panel-on/off arms; the flag gates the view, not the recording | [OUT]/observatory |
| **C-3** | N=1, and the subject is the architect | **OPEN** | [PROG §4 C.3]'s corpus split; ≥3 editors before fitting | PROG §4 C.3 |
| **C-4** | The body changes — renderer updates move the ground truth | **OPEN** | Partition by `buildId`; treat renderer changes as belief-invalidating events | [REV M6] |
| **C-5** | The user is non-stationary — users learn too | **OPEN** | Change-point detection; recency-weighted stats | ARCH §9.4 |
| **C-6** | Instrument–subject circularity | **STRUCTURAL** | VAL-4's external referents | §1.4 |
| **C-7** | Corpus asymmetry — rejection is cheap to observe, success expensive | **OPEN** | Measure it (R3); correct or report | [OUT Part 11.2] |
| **C-8** | Coverage holes — a second mutation path bypasses the seam | **OPEN** | Coverage record; read absence as *unobserved* | [OUT OD-7]; SEAM §12.3 |

---

# PART 6 — Hypotheses

## 6.1 Audit of the existing set

**[EXISTS]** [PROG §6] pre-registers H1–H9 with falsifiers. Their status after the audits:

| # | Status | Change required |
|---|---|---|
| H1 segmentation | **Valid; blocked** on the ledger; baselines runnable now | Add null model |
| H2 τ decay | **Valid; blocked** — `tauInputs.surprise` is `null` pending the ledger [RSA] | Add null model |
| H3 impasse learning | **Valid; confounded** — Habitat already runs continuous learning underneath, so the two arms are not separable today | Resolve C-1 first |
| H4 attribution | **Valid; blocked** — needs a human-labelled corpus that does not exist | Part 8.3 |
| H5 calibration | **Under-specified** — no scoring horizon named; a system can be calibrated at 60s and not at 30 days | [OUT Part 9.3]; add horizon per domain |
| H6 divergence | **Not currently a test** — no null model; a frozen install would also diverge | §3.3; add control arm |
| H7 memory growth | **Valid; partial** — measurable for the stream, not for Habitat's five stores | Normalise by decision volume |
| H8 explanation decline | **Valid; blocked** on V-Q1 (are explanation events distinguishable?) | Settle V-Q1 |
| H9 signal density | **Valid; reframed** — [REV §1.4] shows a coarse per-install learner already works, so the question is granularity, not possibility | Reframe |

**[INFERRED] Two of nine are not currently tests** (H5 under-specified, H6 lacks a control), and
one is confounded at the source (H3). That is a substantial finding about a pre-registered set, and
it is exactly what pre-registration exists to expose before data collection rather than after.

## 6.2 New hypotheses

Each with a prediction, a falsifier, a class, and its prerequisite.

| # | Hypothesis | Falsified if | Class | Prerequisite |
|---|---|---|---|---|
| **V1 · Anchor** | Derived outcomes agree with declared verdicts above a chance-adjusted floor | Agreement at or below floor — the derivation policy is not tracking meaning, and every downstream measure loses its external referent | B | **none — runnable now** |
| **V2 · Confound reality** | Habitat's implicit signals measurably alter the corpus (route drift correlates with trust flips) | No correlation — C-1 is smaller than feared | B | Trust state recorded (REV E2) |
| **V3 · Simulation fidelity** | Pre-act rollout predicts the rendered result exactly | Any divergence — [ARCH §8.1]'s "unfair advantage" claim fails, and model-bias-free planning is lost | S | Rollout invocation [GAP D4] |
| **V4 · Body modulation** | Cognitive policy modulated by body state produces better outcomes per unit body cost than static policy | No difference — [ARCH §3.2]'s falsifiable consequence fails, and situatedness is decorative | B | Body→cognition bridge [ICA K5] |
| **V5 · Interleaving** | Offline interleaved consolidation prevents interference that continuous learning exhibits | Continuous learning matches it — [ARCH §5.2] prescription 2 is unnecessary here | B | Consolidation |
| **V6 · Plasticity** | Commitments in the low-plasticity stratum survive contradiction rates that would flip a fast-stratum belief | They flip at similar rates — identity is not a real stratum, only a label | D | Plasticity gradient |
| **V7 · Learning progress** | Attention allocated by error-slope outperforms uniform allocation | No difference — [ARCH §6.3]'s developmental controller is inert | B | Ledger + drives |
| **V8 · Divergence null** | A learning install diverges more from its twin than a frozen-psyche install does, on identical held-out inputs | Equal divergence — **H6 measures user difference, not architecture** | D | Psyche volume + ≥2 installs |
| **V9 · Self-surprise** | ORIS's learned self-model is sometimes wrong about ORIS | Never wrong — it is a mirror, not a self-model [ARCH §4]'s own engineering test | B | Learned self-model |

**[INFERRED]** V1 is the only one runnable today, and V3 is the only class-S member — meaning it is
cheap, decisive, and validates the architecture's top-ranked novel claim. Both should be early.

---

# PART 7 — Per-subsystem evaluation

Each subsystem: what would count as working, the external referent, the metric, and the honest
status.

## 7.1 Outcome correctness

**What "correct" means.** [OUT] establishes outcomes are derived, so correctness is not
*"did we get the right answer"* but **agreement with an external referent, and stability under
policy revision**.

| Property | Metric | Referent | Status |
|---|---|---|---|
| Agreement | Chance-adjusted agreement with declared verdicts | declarations | **NOW** (V1) |
| Determinism | Same prefix + policy + as-of ⇒ identical result | replay | **NOW** [OUT OD-18] |
| Stability | How much do conclusions move when the policy is revised? | — | NOW, on the existing corpus |
| Self-observation exclusion | AI commits never read as user responses | inspection | **NOW**, and blocked on [OUT Q5] |

**[INFERRED]** Stability under policy revision is a *new* metric this paper introduces and is
uniquely available to a derive-don't-store architecture: re-run every historical derivation under
policy v2 and measure how many conclusions change. A policy whose revisions flip most conclusions
is not converging. *Inference step:* the measurement follows from [OUT OD-18]'s reproducibility
guarantee; no document proposes it.

## 7.2 Attribution correctness

**[EXISTS]** [PROG §7]: agreement with human labelling, chance-adjusted, on held-out traces.
**[BLOCKED]** — no attribution phase, and no labelled corpus. Prerequisites: phase ⑦; a labelling
protocol (Part 8.3).

**[INFERRED]** [OUT OD-8] (the unit of outcome is the action) sharpens H4: attribution should be
evaluated at *action* granularity, matching the owner field's granularity, not at decision
granularity. Evaluating at the wrong unit would make attribution look worse than it is.

## 7.3 Confidence calibration

**Method.** ECE and Brier, per submodel, per domain, per **horizon** — the third dimension [OUT
Part 9.3] showed is missing from H5.

**[BLOCKED]** — no ledger; confidence on 1 of 3 paths [RSA]. Prerequisites: ledger; confidence
coverage across all routes; [OUT] derivation; a named horizon per domain.

**[ARCHITECTURAL RULE VAL-10 · Calibration is always reported with its scoring horizon and its
outcome policy version.** A calibration number without both is uninterpretable and uncomparable
across time.]

**[INFERRED] The reliability-diagram requirement.** A single ECE number can hide compensating
errors (overconfident high, underconfident low). Full reliability diagrams per domain are the
minimum honest report — and [ARCH §7.2]'s promised second-order honesty (*"historically when I say
60% here I'm right 45% of the time"*) is a *statement of a reliability curve*, so the curve must
exist before the claim can be made.

## 7.4 Prediction quality

Distinct from calibration: calibration asks *is confidence honest*, prediction quality asks *is the
prediction any good*.

| Sub-claim | Metric | Baseline | Status |
|---|---|---|---|
| Predicts user acceptance | Top-k accuracy | base rate | BLOCKED — user model |
| Predicts its own resource cost | Absolute error on latency/tokens | naive per-route mean | **PARTIAL** — cost recorded on 2 of 3 paths [RSA F1] |
| Predicts route success | AUC | always-escalate | BLOCKED — ledger |

**[INFERRED]** Self-resource prediction is the cheapest genuine prediction test available and is
nearly measurable now — it needs only the missing `startedAt` on the LLM path [RSA F1]. It is a
real test of [ARCH §4.1]'s structural self and requires no user model.

## 7.5 Memory evaluation

| Claim | Metric | Baseline | Status |
|---|---|---|---|
| Growth is sublinear (H7) | bytes per **decision**, over cumulative decisions | linear | **PARTIAL** — stream only; Habitat's stores uninstrumented [ICA K3] |
| Retrieval doesn't degrade with volume | retrieval precision vs corpus size | — | BLOCKED — no retrieval |
| Residual storage works | compression ratio vs surprise | store-everything | BLOCKED — needs surprise |

**[ARCHITECTURAL RULE VAL-11 · Memory growth is normalised by decision volume, never by wall
time.** Wall-time normalisation makes a quiet month look like improving compression — the null
model in §3.3.]

## 7.6 Forgetting evaluation

**[INFERRED]** Forgetting is the hardest thing in this paper to validate, and the reason is
structural: **the evidence that forgetting was wrong is the thing that was forgotten.**

**[ARCHITECTURAL RULE VAL-12 · Forgetting is validated by held-out retention, never by outcome
alone.** A control cohort retains what the policy would have evicted; the metric is whether
retaining it would have changed any later conclusion. Without a retained shadow set, an eviction
policy cannot be shown to be wrong — only lucky.]

**[BLOCKED]** — needs ACT-R activation, which needs τ, which needs surprise, which needs the ledger.

## 7.7 Consolidation evaluation

| Claim | Metric | Baseline | Status |
|---|---|---|---|
| Episode→pattern extraction is real | Do patterns predict held-out episodes? | per-episode statistics | BLOCKED |
| Interleaving prevents interference (V5) | Performance on old domains after new learning | non-interleaved arm | BLOCKED |
| Consolidation is worth its cost | Prediction gain per unit offline compute | no consolidation | BLOCKED |

**[INFERRED]** V5 is the cleanest ablation in the entire programme — interleaved vs non-interleaved
on an identical corpus, offline, deterministic, repeatable, no user involvement. When consolidation
exists, this should be among the first experiments run.

## 7.8 Simulation evaluation

**[EXISTS]** [ARCH §8.1] ranks deterministic ground-truth simulation as the programme's #1 novel
claim.

**[INFERRED]** It is therefore notable that it is the **cheapest claim to validate in the entire
architecture and is class S**. The pixel-comparison harness already ships [GAP §1.10]. V3 asks
whether a pre-act rollout's prediction matches the rendered result exactly; determinism says it
must; any divergence falsifies the claim outright and would be found in hours, not years.

**[ARCHITECTURAL RULE VAL-13 · Near-future and long-future simulation are validated separately and
never reported together.** [TIME §4.1] establishes the confidence gap between exact renderer
rollout and approximate self-simulation against held-out history is *"enormous and must never be
elided."* A single "simulation accuracy" number would elide exactly that.]

## 7.9 Drive evaluation

| Claim | Metric | Baseline | Status |
|---|---|---|---|
| Learning progress targets the frontier (V7) | Prediction improvement per unit attention spent | uniform allocation | BLOCKED |
| Noisy-TV avoidance | Attention spent on irreducibly random domains | novelty-seeking arm | BLOCKED |
| Anti-sycophancy (ORIS-3) | User competence trajectory; predictability flagged | — | **BLOCKED, and see below** |

**[INFERRED] ORIS-3 may be the least validatable claim in the architecture.** *"Optimise the user's
capability, not the system's predictive comfort"* requires measuring **user competence growth** —
a construct with no operational definition anywhere in the corpus, no instrument, and a null model
(users improve anyway) that is very hard to control. [ARCH §6.4] gives one usable proxy — *perfect
predictability of the user is a warning, not a victory* — which is measurable once a user model
exists, but it is a proxy for the absence of a failure, not evidence of the success.
**[RESEARCH QUESTION V-Q3]:** is there any operational definition of user capability growth in a
creative tool that is not confounded by ordinary skill acquisition?

## 7.10 Identity evaluation

| Claim | Metric | Referent | Status |
|---|---|---|---|
| The stratum is real (V6) | Contradiction rate required to flip, by stratum | — | BLOCKED |
| Promotion is justified | Held-out validity of promoted commitments | replay against held-out history | BLOCKED |
| Divergence is architectural (V8) | Distance between installs vs frozen-psyche control | **the null model** | BLOCKED |
| Identity is explainable | Can every commitment produce its evidence chain? | inspection | BLOCKED — ORIS-8 absent [GAP §1.12] |

**[INFERRED]** Identity evaluation is the furthest from possible and the most likely to be reached
for prematurely, because the character sheet is the architecture's most vivid artifact. VAL-6
applies with full force: a character sheet that exists is a class-S fact and is not evidence for
any class-D claim.

## 7.11 Learning-rate evaluation

**[INFERRED]** [ARCH §10.2] defines identity *by* learning rate — *"identity is the low-plasticity
stratum… defined by learning rate, not by content."* That makes learning rate itself a
first-class measurable, and it is measurable earlier than identity: **how much does one datum move
this belief?** — answerable per belief class, over any corpus, without waiting years.

**[ARCHITECTURAL RULE VAL-14 · The plasticity gradient is validated as a gradient before identity
is validated as a stratum.** If measured learning rates do not separate into distinct bands, there
is no gradient, and identity has nothing to be the low end of. This is a cheap early test of an
expensive late claim.]

---

# PART 8 — Longitudinal design

## 8.1 Cohorts

**[EXISTS]** [PROG §4 C.3] sets minimum standards: self-traces are *development* data; other
editors' traces are *evaluation* data and never used for fitting; **≥3 editors, ≥20 real project
sessions each, across ≥2 genres** before any model is fitted.

**[INFERRED]** The audits require adding two arms that C.3 does not have:

| Arm | Purpose | Status |
|---|---|---|
| **Development (self)** | Instrument validation only | exists |
| **Evaluation (≥3 editors)** | Model fitting and testing | **BLOCKED** — recruitment |
| **Frozen-psyche control** | The null model for divergence (V8, §3.3) | **BLOCKED** — psyche volume is six keys [GAP] |
| **Habitat-only control** | Isolates Habitat's learning from ORIS's (C-1) | **BLOCKED** — needs V-Q2 settled |

## 8.2 Corpus requirements

**[ARCHITECTURAL RULE VAL-15 · A corpus is admissible for a claim only if it carries the coverage
record for every field the claim depends on.** [OUT OD-7] applies at corpus scale: a period where
a field was unwired is not weak evidence, it is *no* evidence, and must be excluded rather than
averaged in.]

Minimum properties: coverage record present; `buildId` partitionable (C-4); `seatId` partitionable
(C-3); no unaccounted eviction; a stated derivation policy version for every derived quantity.

**[EXISTS]** All five are supported by the shipped envelope [RSA Part 1] — an unusually strong
position, and the direct payoff of [PROG §12]'s insistence on recording coverage.

## 8.3 The labelling protocol — a named prerequisite

**[BLOCKED]** H4 and attribution correctness both require *"agreement with human labelling,
chance-adjusted, held-out"* [PROG §7]. **No labelling protocol exists anywhere in the corpus.**

**[INFERRED]** Minimum requirements before any labelled study: ≥2 independent labellers; an
inter-rater agreement floor reported before results; labellers blind to ORIS's own attribution;
a written label taxonomy fixed in advance. Without these, "agreement with human labelling" is
agreement with one person's post-hoc reading, which is not a referent.

**[ARCHITECTURAL RULE VAL-16 · Human labelling is an instrument and is subject to VAL-3.**
Inter-rater agreement is measured and reported *before* any system-vs-human agreement number.]

## 8.4 Epoch gating

**[EXISTS]** [TIME §5]: *"an epoch is a band becoming writable"*, making the developmental gate a
permission check rather than a judgement.
**[EXISTS]** [REV Part 2] establishes Epoch 0's *"zero adaptation"* is currently false and proposes
edits E1–E3.

**[ARCHITECTURAL RULE VAL-17 · No epoch transition without a published validation report for the
previous epoch**, containing null results. [PROG §9] already demands results-not-claims; VAL-17
makes it the gate rather than a norm.

---

# PART 9 — Intervention and ablation

## 9.1 Why ablation is the workhorse

**[INFERRED]** For behavioural claims, ablation is the strongest referent actually reachable
(§1.4). ORIS is unusually well suited: the architecture is data-and-tables-first [ARCH §19], and
[ARCH §12.2]'s shadow stage is an ablation design already specified for a different purpose —
*"the change runs in parallel with the incumbent and predicts, but does not act."*

**[INFERRED] Shadow mode is a validation instrument that already has an architectural home.** A
mechanism running in shadow produces predictions without consequences, which is exactly a
counterfactual arm. *Inference step:* [ARCH §12.2] specifies shadow for governance; its use as the
programme's primary ablation vehicle is proposed here.

## 9.2 The ablation register

| Ablation | Tests | Class | Status |
|---|---|---|---|
| Consolidation off | V5, interference | B | BLOCKED |
| τ decay → wall-clock decay | H2 | B | BLOCKED |
| Learning-progress drive → uniform | V7 | B | BLOCKED |
| Body→cognition bridge off | V4 | B | BLOCKED |
| Habitat learning frozen | C-1 magnitude, V2 | B | **Needs V-Q2** |
| Psyche frozen | V8, divergence null | D | BLOCKED |
| Panel visible / hidden | C-2, observer effect | B | **NOW** |
| Outcome policy v1 / v2 | §7.1 stability | B | **NOW** |

## 9.3 Intervention experiments

**[ARCHITECTURAL RULE VAL-18 · Interventions on a live user's work require the same standard as
any product change: reversible, disclosed, and never at T0 risk.** [VAL-D §3] places integrity and
honesty at T0. A validation experiment that degrades a user's project to obtain a measurement has
violated the value system it is trying to validate.]

**[INFERRED]** This forecloses the most informative intervention class — deliberately making ORIS
wrong to observe recovery — on real projects. It remains available on synthetic corpora and in
shadow mode, which is a further argument for §9.1.

---

# PART 10 — Statistical validity

**[ARCHITECTURAL RULE VAL-19 · Pre-registration before data.** [PROG §6] establishes this and
[PROG §4 C.3] restates it: *"a hypothesis written after seeing the data is a description."* Every
V-hypothesis in Part 6 is registered by this document's existence.

**[ARCHITECTURAL RULE VAL-20 · Multiplicity is controlled and the family is declared.** Nine H
plus nine V hypotheses, several with per-domain breakdowns, is a large family. Without correction,
one "significant" domain out of five is expected by chance — and [PROG §6] H5's *"in ≥3 domains"*
is exactly the shape that invites it.]

**[ARCHITECTURAL RULE VAL-21 · N is the number of independent subjects, never the number of
events.** A single editor generating 50,000 decisions is N=1. This is the most likely statistical
error in a programme whose corpus is large and whose subject pool is tiny.]

**[ARCHITECTURAL RULE VAL-22 · Non-stationarity is modelled, not averaged.** Both the system
(C-1) and the user (C-5) change during measurement. Pooling across a window in which the generating
process changed produces a number describing no period. [ARCH §6.2]'s expected/unexpected
uncertainty distinction is the architecture's own version of this rule.]

**[INFERRED]** Effect sizes and confidence intervals, not p-values, should be the reporting
standard, because most claims here are comparative and the practical question is *how much better*.
[PROG §9]'s own example report is already written in that style.

---

# PART 11 — Reproducibility

**[EXISTS]** ORIS-7 — divergence is data, never code; the deterministic core is byte-identical
everywhere. **[EXISTS]** [GAP §1.12] confirms all divergence lives in local storage today, though
as six keys rather than one portable volume.

**[ARCHITECTURAL RULE VAL-23 · Every published result names: build id, schema version, coverage
policy, outcome policy version, segmentation policy version, τ policy version, corpus window
(seq range), and seat partition.** [OUT OD-20] requires the recipe for a single derived value;
VAL-23 is the same requirement at the level of a result.]

**[INFERRED]** This is achievable today: every one of those eight identifiers is already recorded
in the shipped envelope or its policy constants [RSA Part 1]. Reproducibility is the one
methodological property the programme is *already* equipped for, which is a direct return on the
integrity work.

**[ARCHITECTURAL RULE VAL-24 · A result that cannot be regenerated from the archived corpus is
withdrawn, not footnoted.**]

---

# PART 12 — Benchmark design

**[INFERRED]** Longitudinal in-situ measurement cannot answer *"did competence improve?"* because
the tasks change. A fixed benchmark is required, and none exists.

**Requirements for an ORIS benchmark:**

| Requirement | Why |
|---|---|
| **Fixed, held-out, never trained on** | Otherwise it measures memorisation |
| **Deterministic ground truth where possible** | The renderer supplies it for anything pixel-checkable [ARCH §8.1] |
| **Spans domains** | H5 requires ≥3; a single-domain benchmark cannot test it |
| **Includes negative cases** | Cases where the right action is *to decline* — precision-first requires it [AIA] |
| **Includes non-stationary items** | Where the right answer changed; tests belief revision, not recall |
| **Cheap to re-run** | Run every epoch, so trajectories exist |

**[EXISTS]** A seed exists: the 50-prompt ledger reborn as `brain:eval` [AIA]. **[INFERRED]** It is
a *router acceptance* corpus — it tests level 1 (implementation), not level 2 (architecture), per
VAL-2. Extending it into a cognitive benchmark is a distinct exercise, not a reuse.

**[ARCHITECTURAL RULE VAL-25 · The benchmark is versioned and frozen per epoch, and results are
never compared across benchmark versions without re-running the old version.**]

---

# PART 13 — Success and failure criteria

## 13.1 Success

**[INFERRED]** Success is per claim and per class, never global. Minimum for each:

- **Class S:** the property holds by inspection, and a test exists that would fail if it stopped
  holding. *(The `pending()` harness pattern [ARCH §7.3] applied to architecture.)*
- **Class B:** beats a pre-declared baseline, with a null model excluded, effect size reported,
  on evaluation-arm data not used for fitting.
- **Class D:** the above, plus a cohort, plus a control arm, plus a trajectory over ≥2 epochs.

**[EXISTS]** The programme-level success condition already exists and is well drawn:
[PROG §5]'s Closed-Loop Trace Test at ≥95% — *"a loop that closes 80% of the time is not a loop."*
This paper does not weaken it. [OUT] adds a rider: since outcomes are as-of, **the trace test must
name its as-of point**, or "what happened" is undefined.

## 13.2 Failure

**[EXISTS]** [PROG §8] supplies kill criteria for H9, H1, H4, H7. They stand.

## 13.3 Additional kill criteria implied by the audits

| Trigger | Consequence |
|---|---|
| **V1 fails** — derived outcomes don't beat chance against declarations | The external anchor is gone (§1.4). Every behavioural claim becomes unvalidatable until another referent is found. **The most severe single failure available** |
| **V3 fails** — rollout doesn't match the render exactly | [ARCH §8.1]'s #1 novel claim falls; model-bias-free planning is lost |
| **V8 fails** — frozen-psyche installs diverge as much as learning ones | H6 measures user difference; the divergence claim must be withdrawn |
| **V4 fails** — body modulation produces no benefit | [ARCH §3.2]'s falsifiable consequence fails; situatedness is decorative |
| **R4 fails** [OUT] — re-derivation isn't interactive | [OUT OD-18/19] cannot hold in practice; the derive-don't-store commitment needs revisiting |

## 13.4 The programme's own kill criterion

**[INFERRED] The programme has kill criteria for its hypotheses and none for itself.** Supplying it:

> **If, after Epoch 1, no external referent has been established for developmental claims — no
> cohort, no frozen control, no labelled corpus — then class-D claims are permanently
> unvalidatable, and the honest response is to narrow the architecture's claims to classes S and B
> rather than to continue asserting D.**

*Inference step:* follows from VAL-4 (no referent ⇒ unvalidatable) plus VAL-6 (class D is
provisional until cohort data exists). It is a scope decision, not a technical failure, and it
preserves everything the programme would still have proved.

---

# PART 14 — Roadmap

Ordered by dependency and by cost, not by interest. Every item names what becomes validatable
after it.

```
STAGE V0 — PREREQUISITES (lookups and rulings; no experiments)
  P1  Settle V-Q2 — enumerate Habitat's trust-counter triggers        [C-1, blocking]
        → unlocks: whether ANY longitudinal measurement is interpretable
  P2  Settle [OUT Q5] — confirm an AI commit declares itself
        → unlocks: the self-observation exclusion; without it, silent self-acceptance
  P3  Settle V-Q1 — are explanation events distinguishable?
        → unlocks: H8

STAGE V1 — INSTRUMENT VALIDATION (VAL-3; before any subject measurement)
  I1  Both-direction validation of every existing instrument
  I2  Corpus admissibility check against VAL-15
        → unlocks: permission to trust any later number

STAGE V2 — MEASURABLE NOW (no new mechanisms)
  E1  V1 · declared-vs-derived agreement          ← THE ANCHOR (§1.4)
  E2  Outcome-policy stability under revision      (§7.1)
  E3  Override rate; tier distribution (H9)        [REV Part 3]
  E4  C-2 observer-effect arms                     (panel on/off)
  E5  [OUT R2, R3, R4] — netting, asymmetry, re-derivation cost
        → unlocks: a validated derivation policy, which everything else scores against

STAGE V3 — CHEAP DECISIVE TESTS (class S, small prerequisites)
  E6  V3 · simulation fidelity                     ← cheapest test of the #1 novel claim
  E7  Self-resource prediction error               (needs [RSA F1] only)
  E8  VAL-14 · does the plasticity gradient separate into bands?
        → unlocks: early evidence on the architecture's most expensive late claim

STAGE V4 — LEDGER-DEPENDENT
  E9  Calibration per domain per horizon (H5, VAL-10)
  E10 Attribution vs human labels (H4) — requires the Part 8.3 protocol
  E11 Segmentation vs baselines (H1)
  E12 τ vs wall-clock decay (H2)

STAGE V5 — LONGITUDINAL / COHORT
  E13 Consolidation ablation (V5)
  E14 Body-modulation ablation (V4)
  E15 Memory growth normalised by decision volume (H7, VAL-11)
  E16 Divergence with frozen-psyche control (V8, H6)
  E17 Identity stratum stability (V6)
```

**[INFERRED] Two properties of this order are worth stating.** Stages V0–V2 require **no new
mechanisms at all** — they are lookups, instrument checks, and analyses of the existing corpus,
consistent with [REV Part 3]'s finding that Tier 0 research is unusually cheap here. And **the
single most decisive early experiment is E6**, because it is class S, costs hours, and would
falsify the architecture's top-ranked novel claim outright if it failed.

---

# PART 15 — Open questions

| # | Question | Settles by | Priority |
|---|---|---|---|
| **V-Q2** | Are Habitat's implicit behavioural signals live? (§5.1) | enumerate trigger sites | **BLOCKING** |
| **V-Q1** | Are explanation events distinguishable in the corpus? | inspect the `t0.why` path's recording | high (H8) |
| **V-Q3** | Is there a non-confounded operational definition of user capability growth? (§7.9) | conceptual, then instrument | high (ORIS-3) |
| **V-Q4** | What is the minimum cohort for a class-D claim? | power analysis once effect sizes exist | medium |
| **V-Q5** | Can shadow mode serve as the primary ablation vehicle without perturbing the live system? | measurement (ORIS-6 gate) | medium |
| **V-Q6** | Is inter-rater agreement achievable on attribution labels at all? | pilot with 2 labellers | high (H4) |

## 15.1 Contradictions isolated, not resolved

1. **[AIA] B6 vs [OUT §14.2].** Documentation states Habitat runs implicit behavioural signals;
   [OUT]'s two-learner analysis assumed declaration-class only and flagged the condition as its
   Q4. No audit examined the triggers, so this is a *potential* contradiction awaiting a lookup
   (V-Q2). **Isolated here; not resolved.**
2. **[PROG §7] / [ARCH §12.2] vs [ARCH §14].** Zero wrong-fire versus promoting compiled reflexes
   [REV C8]. It bears on validation because wrong-fire is a derived outcome and, per [OUT OD-11],
   needs a linkage class and window to be well-defined at all. **Isolated; not resolved.**

---

## Appendix A — Deliverable index

| Requested | Section |
|---|---|
| Validation philosophy | Part 1 |
| Observable behaviours | Part 3.1 |
| Measurable hypotheses | Part 6 |
| Success / failure criteria | Part 13.1–13.2 |
| Longitudinal experiments | Part 8, Stage V5 |
| Calibration methodology | §7.3, VAL-10 |
| Prediction quality | §7.4 |
| Identity evaluation | §7.10 |
| Memory evaluation | §7.5 |
| Simulation evaluation | §7.8 |
| Drive evaluation | §7.9 |
| Consolidation evaluation | §7.7 |
| Attribution correctness | §7.2 |
| Outcome correctness | §7.1 |
| Confidence calibration | §7.3 |
| Learning-rate evaluation | §7.11 |
| Forgetting evaluation | §7.6 |
| Intervention experiments | §9.3 |
| Ablation studies | §9.1–9.2 |
| Reproducibility | Part 11 |
| Statistical validity | Part 10 |
| Corpus requirements | §8.2 |
| Benchmark design | Part 12 |
| Kill criteria | §13.2–13.4 |
| Research roadmap | Part 14 |

## Appendix B — The validation invariants

| # | Rule |
|---|---|
| VAL-1 | Validation means falsification, never demonstration. |
| VAL-2 | Never validate the architecture with implementation evidence. |
| VAL-3 | Instruments prove both directions before any subject measurement. |
| VAL-4 | Every claim needs an external referent, or is marked unvalidatable. |
| VAL-5 | Phenomenal claims are permanently out of scope. |
| VAL-6 | Class-D claims are provisional until cohort data exists. |
| VAL-7 | No measurement without a baseline named in advance. |
| VAL-8 | Every hypothesis carries a null model. |
| VAL-9 | Confounds are registered permanently and reported in every result. |
| VAL-10 | Calibration is reported with horizon and outcome-policy version. |
| VAL-11 | Memory growth is normalised by decision volume, never wall time. |
| VAL-12 | Forgetting is validated by held-out retention. |
| VAL-13 | Near-future and long-future simulation are validated separately. |
| VAL-14 | The plasticity gradient is validated before identity is. |
| VAL-15 | A corpus is admissible only with coverage for every field a claim uses. |
| VAL-16 | Human labelling is an instrument and is subject to VAL-3. |
| VAL-17 | No epoch transition without a published report including null results. |
| VAL-18 | Interventions never risk T0 values. |
| VAL-19 | Pre-registration before data. |
| VAL-20 | Multiplicity controlled; the family declared. |
| VAL-21 | N is subjects, never events. |
| VAL-22 | Non-stationarity is modelled, not averaged. |
| VAL-23 | Every result names its eight identifiers. |
| VAL-24 | Non-regenerable results are withdrawn, not footnoted. |
| VAL-25 | Benchmarks are versioned and frozen per epoch. |

## Appendix C — Prerequisite register

Capabilities that must exist before named experiments. **Not proposals to build them.**

| Prerequisite | Blocks | Class |
|---|---|---|
| Habitat trust state recorded | C-1, V2, all longitudinal | integration [REV E2] |
| AI-commit declaration confirmed | self-observation exclusion | verification [OUT Q5] |
| Prediction Ledger | H2, H3, H5, calibration, drives, forgetting | implementation |
| Attribution phase ⑦ | H4, §7.2 | implementation |
| Human labelling protocol | H4, §7.2 | **methodological — nothing exists** |
| Consolidation | V5, §7.7 | implementation |
| Body→cognition bridge | V4 | integration [ICA K5] |
| Rollout invocation | V3 | integration [GAP D4] |
| Plasticity gradient | V6, VAL-14 | implementation |
| Portable psyche volume | V8, H6 | implementation |
| Cohort ≥3 editors | every class-D claim | **recruitment — nothing exists** |
| Cognitive benchmark | competence trajectories | **methodological — nothing exists** |

**[INFERRED]** Three prerequisites are neither code nor integration but *methodological* — the
labelling protocol, the cohort, and the benchmark. **None has ever been started, and all three gate
the architecture's most distinctive claims.** They have longer lead times than any engineering
item here and should not be discovered late.

## Appendix D — Relationship to prior papers

| Paper | What this one inherits | What it adds |
|---|---|---|
| [ARCH §0] | The falsifiable restatement and its metric table | The claim taxonomy; null models; the circularity problem |
| [PROG §6–8] | H1–H9, metrics, kill criteria | Audit of the set; null models; programme-level kill criterion |
| [OUT] | Derivation policy; R1–R5 | Elevates R5 to the programme's external anchor |
| [REV] | The two-learner problem; Epoch scoping | Escalates C-1 via the [AIA] B6 finding |
| [RSA] / [ICA] / [GAP] | What exists and what is blocked | Translates status into measurability |

## Appendix E — Speculative

**Contains no findings. Nothing above depends on anything here.**

- Whether a cohort of professional editors can be recruited under a local-first, privacy-preserving
  corpus model is unknown; ORIS-16's reviewed-export requirement makes it conceivable, and nothing
  more can be said from the evidence.
- Whether class-D claims could be validated faster by simulating years of history against synthetic
  users is attractive and dangerous: a synthetic user is a model, and validating a user model
  against a synthetic user is [Part 1.4]'s circularity in a new costume.
- Whether the architecture would be *more* valuable if narrowed to classes S and B — abandoning
  identity and divergence as claims while keeping the observability, calibration, and derivation
  machinery — is a strategic question this paper does not answer, though §13.4 makes it reachable.
