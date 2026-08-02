# ORIS Research Programme — v0

> **What this file is:** the empirical protocol. Not architecture — the architecture is
> frozen (§1). This document says what gets measured, what counts as a result, what would
> falsify each hypothesis, and when to stop.
>
> **Why it exists:** everything before it is theory. A theory with no measurement schedule
> becomes doctrine within about a year, and doctrine cannot be corrected by evidence because
> it never invited any.
>
> **Companions:** [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) (prose) ·
> [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) (formal) ·
> [`ORIS_VALUES.md`](ORIS_VALUES.md) · [`ORIS_SELF.md`](ORIS_SELF.md) ·
> [`ORIS_TIME.md`](ORIS_TIME.md).
>
> **Status:** v0, 2026-08-02. Hypotheses in §6 are **pre-registered** — recorded before any
> data exists, so that revising them later is visible rather than silent.

---

## 0. Naming: Stages are not Epochs

Two ladders exist and they must not share vocabulary, or in two years nobody will know which
one a document means.

| | Axis | Defined by | Where |
|---|---|---|---|
| **Epoch** 0–5 | the organism's *development* | a band becoming writable | [`ORIS_TIME.md`](ORIS_TIME.md) §5 |
| **Stage** A–D | our *research programme* | what we are measuring | this file |

The relationship is the reassuring part:

> **Stages A–D all take place inside Epoch 0.** Nothing above band B2 is ever writable during
> this entire programme. The organism records, predicts, and is scored; it does not adapt, it
> does not form preferences, and it certainly does not form identity.

That is a deliberate risk posture: **the whole research programme is unfalsifiably safe**,
because the system under study cannot change itself. If the theory is wrong, we learn it from
traces rather than from a tool that has quietly become strange.

---

## 1. The freeze

Effective now, until Stage C data exists:

- **Physics is frozen.** No new state variables. The stopping rule from
  [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §7.7 stands: two near-misses are on record; a third
  that does not resolve means the seven-variable reduction has failed and gets re-derived —
  not accommodated a third time.
- **Biology is near-frozen.** New operators only via the admission test
  ([`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §5), and the expected answer is no.
- **Psychology is open.** Views are free (§5.0 conservation rule). Add as many as are useful.

Every proposal meets three questions in order — view? operator? existing state? — and only a
"no" to all three permits considering new state.

---

## 2. Stage A — the observatory

**Goal: observability, not intelligence.** Build the instrument before the experiment.

### A.1 What ships

One thing: **the Experience Stream** (O1), as a persisted, segmented, queryable log — seeded
directly on the shipped `DecisionTrace`, which already records intent → route → facts →
operations → outcome at every apply/answer seam.

Plus the **Prediction Ledger** (O2), which is the only new *concept* in Stage A: a claim
recorded before the act, scored after.

### A.2 The trace record

Every cognitive event writes one record. Field semantics are defined in
[`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §1.3 and are not restated here.

```
per phase:  phase ①–⑧ · band · t · τ · inputs · outputs · latency_ms · cost
per claim:  claim · claimed_confidence · owner_belief · horizon
per outcome: observed · ε{class, magnitude, direction, tier, uncertainty_kind}
per update: which beliefs changed · by how much · why (attributed error)
```

### A.3 Acceptance

Stage A is done when a randomly chosen action from 30 days ago yields a complete,
link-resolvable trace and a deterministic replay. Not "logging exists" — **the loop closes**.

### A.4 What Stage A is not

It is not a feature. There is one legitimate user-facing artifact — honest calibrated
confidence (*"I'm 60% here, and historically when I say 60% in this domain I'm right 45% of
the time"*) — and it ships only because it costs nothing extra and is worth having on its own
merits.

---

## 3. Stage B — the minimum loop

**Goal: implement only the phases that don't exist.**

The [worked trace](ORIS_CALCULUS.md) (§6) establishes that phases ①②④⑤ already ship inside
the K4 planner. Stage B adds exactly the missing ones:

```
⑥ compare      typed, tiered error — not a scalar
⑦ attribute    the phase almost every architecture skips
⑧ adapt        gated by plasticity, forbidden above B2 (L7)
```

Nothing else. No consolidation, no simulation, no promotion, no drives beyond what `modulate`
needs. If ⑥⑦⑧ do not work, no amount of the rest matters.

**Acceptance:** attribution agreement with human labelling on a held-out sample (§7), and
zero wrong-fire regressions in `brain:eval` — the existing bar, unchanged.

---

## 4. Stage C — the segmentation study

**This is the programme's central empirical problem**, and the assessment that it is the
largest risk is correct: episodes are the unit of consolidation, so bad boundaries do not
merely misfile memories — **they miscalibrate every promotion threshold in the system.**

### C.1 The reframe that makes it tractable

The apparent blocker is ground truth: nobody knows where the real boundaries are, and asking
editors to mark them mid-work destroys the phenomenon being measured.

> **Segmentation is not a labelling problem. It is a model-selection problem.**

We do not need to know where boundaries *are*. We need boundaries that make downstream
statistics **predictive**. That is measurable with no labels at all:

```
For each candidate segmentation S:
    aggregate episode-level statistics under S
    → predict the next user correction / rejection / override
    → score

Baselines that must be beaten:
    fixed 5-min windows · fixed 20-action windows · session-as-episode ·
    activity-gap threshold
```

A segmentation that cannot beat a fixed window is not earning its complexity, whatever it
does to our intuitions about where episodes "really" end.

### C.2 The generative hypothesis worth testing first

Event Segmentation Theory (Zacks et al.) holds that humans maintain event models that
generate predictions, and perceive a boundary exactly where prediction error transiently
spikes. That is directly implementable, requires no new machinery, and closes a loop that has
now closed several times in this architecture:

> **The Prediction Ledger is also the episode segmenter.** Boundaries are where attributed
> error spikes above the local baseline.

If true, this is a significant simplification: segmentation stops being a hand-tuned rule
table and becomes a read-out of a mechanism already required for other reasons. Candidate
signals from [`ORIS_TIME.md`](ORIS_TIME.md) §3 remain as features, but as *baselines to beat*
rather than as the design.

### C.3 The N=1 hazard — read before collecting data

The proposed method is "use Orreris Pro yourself for weeks." That is the fastest possible
signal and it will catch gross errors, so it should happen. It is also **the most biased
subject available**:

- the architect knows what the system is trying to detect and will unconsciously edit in ways
  that make it detectable;
- every belief formed is about one person, so the user model is fitted to a sample of one;
- the developer's workflow is not a working editor's workflow — more tool-switching, more
  interruption, more deliberate exercising of features.

**Mitigation, mandatory before any model is fitted:**

1. **Split the corpus.** Self-traces are *development* data. Traces from other editors are
   *evaluation* data and are never used for fitting.
2. **Pre-register** (§6) before looking at traces. A hypothesis written after seeing the data
   is a description.
3. **Minimum n before fitting:** ≥3 editors, ≥20 real project sessions each, spanning at
   least two genres. Below that, report observations only — no model.

The honest framing: Stage C on self-traces alone answers *"is the instrument working?"* It
does not answer *"is the theory right?"*, and conflating those is how a research programme
convinces itself.

---

## 5. Stage D — the closed-loop milestone

The proposed milestone is correct and needs one thing to become science: a pass condition.

> **The Closed-Loop Trace Test.** Sample *k* actions uniformly at random from the last *N*
> days. For each, ORIS must produce:
>
> ```
> what it claimed  →  what evidence it used  →  what it predicted  →
> what happened    →  what it attributed the difference to  →  what changed in itself
> ```
>
> Every link resolvable. Every cited episode retrievable. The replay reproduces.
>
> **Pass:** ≥95% of sampled traces complete, with a stated and stable per-link failure
> budget. **Fail:** anything less — a loop that closes 80% of the time is not a loop.

Once this passes, growth, identity, competence estimation, and adaptation are increments on a
working mechanism rather than separate inventions. That claim is itself testable: each should
require registering data, not modifying the runtime — the habitat's existing rule of
engagement, applied to cognition.

---

## 6. Pre-registered hypotheses

Recorded before data. Each has a prediction and an explicit falsifier.

| # | Hypothesis | Falsified if |
|---|---|---|
| **H1** | Prediction-error-spike boundaries beat fixed windows at predicting the next correction | Fixed windows score equal or better |
| **H2** | Decay in subjective time `τ` beats wall-clock decay at predicting which beliefs stay useful | Wall-clock equal or better |
| **H3** | Impasse-triggered learning (SOAR chunking) yields better calibration per byte stored than continuous learning | Continuous learning matches it at equal or lower storage |
| **H4** | Attribution to the owning belief reaches useful granularity | Agreement with human labelling ≤ chance-adjusted floor on held-out traces |
| **H5** | Claimed confidence converges toward realised frequency in ≥3 domains | Calibration error flat or rising after the target session count |
| **H6** | Two installs on different users diverge measurably on identical held-out inputs | Divergence indistinguishable from run-to-run noise |
| **H7** | Residual storage makes memory growth sublinear in episodes | Bytes/episode flat or rising as models mature |
| **H8** | Explanation frequency declines for a given user as the expectation gap closes | Flat or rising over months |
| **H9** | A single professional generates enough decision events to calibrate anything | Calibration cannot beat constant-confidence in **any** domain — see §8 |

H1 and H9 are load-bearing. H9 is the programme's existence question and is the reason
Stage A must run for a long time before anything is concluded.

---

## 7. Metrics

Defined once, so that later results are comparable.

```
Calibration          ECE and Brier score, per submodel, per domain
Attribution accuracy agreement with human labelling, chance-adjusted, held-out sample
Segmentation         predictive validity of episode-level stats vs. baselines (§4.1)
Override rate        fraction of applied actions the user reverses within N actions
Next-action top-k    accuracy of the user model's forward prediction
Memory growth        stored bytes per episode, plotted against cumulative episodes
Divergence           distance between installs' outputs on an identical held-out corpus
Explanation rate     explanations offered per session, over time
Wrong-fire count     MUST remain zero — existing precision-first bar, non-negotiable
Body cost            added frame-time, decode contention, gate occupancy — must be ~0
```

The last two are gates, not measurements. A programme that improves calibration while
degrading playback has failed on the architecture's own terms (ORIS-6).

---

## 8. Kill and pivot criteria

Written now, because they are worthless written later.

**If H9 fails** — a solo professional's decision stream is too sparse to calibrate anything —
then per-install learning as conceived does not work. Pivot, in order of preference:
(a) fleet-aggregated priors under explicit consent with local personalisation on top
(invariant 7 permits this; it changes the local-first story and must be treated as a product
decision, not a technical one); (b) narrow the claim to a few dense domains; (c) abandon the
learning thesis and keep the observatory, which is independently valuable as explainability.

**If H1 fails** and no segmentation beats fixed windows — episodes may not be the right unit.
Consolidation is re-derived over windows, and identity's evidence base changes shape. This
does not kill the programme but it invalidates §5.3 of the architecture and much of
[`ORIS_TIME.md`](ORIS_TIME.md) §3.

**If H4 fails badly** — attribution is not tractable at useful granularity — then L3 needs a
granularity qualifier and learning becomes coarse-grained only (subsystem-level blame, not
belief-level). Survivable, significantly weaker.

**If H7 fails** — memory growth stays linear — the local-first property is on a timer, and
either retention gets far more aggressive or the psyche volume needs a server. This is the
failure most likely to be discovered late, so bytes/episode is plotted from day one.

---

## 9. What gets written down

Per the assessment that this is the part almost nobody does. Results, not claims:

```
NOT   "ORIS has a Self Model."
YES   "Across 500 sessions from 6 editors: attribution agreement 0.93 (n=1,200
       hand-labelled); segmentation predictive validity 0.71 vs 0.58 for fixed
       windows; calibration ECE fell 0.21 → 0.06 in 3 of 5 domains and did not
       move in 2; memory grew at 0.6 KB/episode, declining; added frame cost 0.0 ms."
```

Including the null results. **Especially** the null results — an architecture that only ever
reports confirmations is not being tested, and the two domains where calibration did not move
are more informative than the three where it did.

---

## 10. What this programme deliberately does not do

- **No new architecture.** The freeze (§1) holds until Stage C data exists.
- **No adaptation above band B2**, for the entire programme.
- **No user-facing "AI personality."** ORIS-2 stands: valence may modulate and report, never
  perform.
- **No pause in the product's shipping cadence.** Inherited verbatim from
  ORRERIS_OS.md — any stage that requires stopping feature work is mis-scoped and should be
  cut down until it doesn't.

---

## 11. The literal next step

One thing, small enough to start today:

> **Persist `DecisionTrace` as an append-only Experience Stream, with an episode id and a
> subjective-time stamp on every record.**

No segmentation model yet — write a provisional boundary marker on the strongest signals
(project switch, export, session end) and *record the candidate signals alongside it* so that
Stage C can re-segment the same corpus retroactively under any hypothesis. That single
decision — logging the features, not just the decision — is what makes Stage C possible
without re-collecting data.

Everything else in this document waits on that file existing.

### 11.1 Frozen as of 2026-08-02 — unfrozen once, corrected, re-frozen at schema v4

The following are **long-lived architectural decisions, not implementation details**, and are
frozen for the duration of the programme:

- **The envelope** — `{id, seq, sessionId, t, τ, dτ, tauInputs, tauPolicy, producer, kind,
  refs, signals, payload}`. New producers add payload types, never envelope fields.

  **Amended 2026-08-02 (schema v4), deliberately and once.** The freeze was lifted the day it
  was set, because the admission test (ORIS-19) was applied to the envelope itself and
  rejected two of its fields: `episodeId`/`openedEpisode` (a producer never witnesses an
  episode — two observers running different segmentation policies disagree about where one
  begins) and `tau` carrying no policy identifier (violating L12 — `τ = 128, according to…
  something`). Both were corrected while the corpus was empty; a year later they would have
  been migrations rather than edits. Removing the episode fields also deleted the write-time
  episode state machine outright: episodes are now purely `segment(events, policy)` on read,
  and the provisional cut holds no privilege in the corpus.
- **`producer` ≠ `kind`** — every observation has a natural owner (ORIS-18).
- **ORIS-17 provenance precedence** — provenance beats the ceiling, and the overflow is
  reported.
- **Situation is state; facts are scoped; signals are buffered.** Three different lifetimes,
  three different APIs, deliberately not unified: `setSituation` (true until changed),
  `beginDecision`/`observeFact` (belongs to exactly one decision), `noteBoundarySignal`
  (drains onto the next event).

### 11.2 Looking at it — `?aiThinkingShow=1`

Stage A exists so we stop assuming what the AI is doing. Add `?aiThinkingShow=1` to any URL
and a live panel renders the Experience Stream as it fills: every row, newest first,
expandable to the raw record — envelope, τ inputs, signals, situation, facts consulted,
owner, confidence, actions, candidates.

Two deliberate properties:

- **It renders what is recorded, not a summary of it.** A `null` renders as
  *"null — not observed"*, so an unwired field is never visually indistinguishable from a
  measured absence.
- **"copy json" exports the whole corpus + stats**, which is how a real session becomes
  evidence in a conversation rather than an impression.

Health counters in the header turn amber/red when they should be zero: `evicted`, `pinned`,
and `orphan facts` (a forgotten `beginDecision`/append pairing).

### 11.3 The suites are part of the trusted computing base

Architectural correctness now rests on the acceptance suites — ORIS-19 was validated by them,
and the schema v4 correction was found by them. But `tsconfig.json` excludes
`src/**/*.test.ts`, so **every eval script in the package sat outside the compiler.**

That is not an ordinary gap. It produces *false confidence* rather than failure: a check can
assert against a property that no longer exists and still report green. One instance was
already live — `world-eval` built a `SourceAsset` with `source: "stock"`, a value `AssetSource`
does not contain, and passed. Because `bySource` is a `Record<string, number>`, it counted a
category that cannot occur in production, so the check never exercised the real source
vocabulary. Fixed.

Three mechanisms now guard it, and all three exist because **evidence is only as trustworthy
as the machinery that certifies it**:

1. **`typecheck:tests`** — a second tsconfig that compiles the suites, with node types scoped
   to it alone so no component can reach for `process`.
2. **A ratchet, not a cleanup.** 17 known errors remain (strictness, stale fixture shapes).
   The script fails if the count *rises*, so the debt is bounded and visible while being paid
   down incrementally, rather than blocking on a cross-subsystem sweep.
3. **A shrinkage guard** in `experience:eval` — a green run with fewer checks than expected is
   a regression that reports success, so the suite asserts its own minimum size.

The ratchet carries a **proof-of-life** check, for a reason worth recording: its own first two
versions reported success *without running tsc at all* (a `.cmd` spawn that Node refuses
without a shell, yielding empty output read as "0 errors"). A checker that reports success
when it did not run is the exact failure it exists to prevent, so it now must prove tsc
executed — and parsed diagnostics — before it is allowed to report anything.

### 11.4 Pre-registration — how ADR-016 could be shown to be wrong

Written **before** ADR-017 exists, and not to be revised afterwards. ADR-016 is now the
specification every producer is judged against, which makes it the thing least likely to be
found at fault when something goes wrong — the failure will always look local. This section
exists so that "the integrity model is over-constrained" remains a reachable conclusion rather
than a rhetorical one.

ADR-017 (the user-action producer) is the first real test: high volume, an ambiguous boundary,
and a genuine need for values that are not witnessed. If it can be designed with no exceptions
to I1–I14, that is meaningful evidence. If it cannot, the fault is presumed to be in 016.

**Expected pressure points** (named in advance; §016 I3/I6/I8/I9/I12 are the clauses at risk):

| # | Pressure | What it tests | 016's answer, and what it costs |
|---|---|---|---|
| 1 | **Gesture coalescing** — forty frames of slider drag arriving as one commit | whether convenience can override provenance | the coalescing rule is a named, retained policy (I8); either the raw values are evidence or the commit is, never a merged object presented as raw. Costs volume or fidelity. |
| 2 | **Initiator attribution** — `user` vs `ai` on an action row | whether the boundary observes what we assume it does | if the registry cannot distinguish them, the field is an inference (I2) and initiation becomes a read-time join against decision rows. Costs convenience at every downstream query. |
| 3 | **Volume and sampling** | whether the model holds when integrity becomes expensive | sampling is permitted; an unrecorded sampling policy is not (I9 + I12). Costs the first real payment for coverage recording. |

**Falsification criteria.** Any one of these means ADR-016 is amended, not worked around:

- **F1 — Inexpressibility.** A genuinely witnessed fact cannot be represented without violating
  some clause of I1–I14. The integrity model is then *incomplete*: it forbids recording
  something real, which is a defect in the model and never a reason to discard the observation.
- **F2 — Recurrent exception.** Two or more independent producers require the *same* carve-out.
  A repeated exception is not an exception; it is an unstated rule, and it belongs in the
  architecture where it can be reasoned about rather than in three implementations where it
  cannot.
- **F3 — Impracticability.** The only way to make a producer viable is to weaken provenance.
  The model has then over-constrained the system, and the correct response is a stated,
  bounded, versioned relaxation — not silent non-compliance, which converts a design failure
  into a corpus failure.
- **F4 — Unfalsifiability in practice.** A clause that no producer could ever violate is
  decoration. If I1–I14 survive every producer *without any of them ever being close to
  binding*, the model is not constraining anything and should be reduced.

**Corroboration criterion.** The converse must be stated too, or "it survived" is unearned:
ADR-016 is corroborated if ADR-017 succeeds by **moving complexity into read-time derivation,
coverage recording, or policy versioning** — the three escape routes 016 deliberately provides
— *without introducing an exception*. That is the specific shape of success. Anything else
(017 succeeding because nothing was tested, or because a clause was quietly read narrowly) is
not.

**Standing rule until then:** ADR-016 is not reopened for wording. A document edited to keep
agreeing with the implementation loses the ability to disagree with it, which is the only
property that makes it worth having.

---

## 12. Stage A schema audit — what must be captured before the corpus fills

`ExperienceEvent` v1 (shipped) records what the *runtime* did. This section audits it against
the full eight-phase calculus and classifies every field the later hypotheses will need.

**The test, applied field by field:**

> A field **must be captured now** iff it is **ephemeral** (existed only during the decision)
> or **destructively overwritten** (derived from state that mutates before we look).
> It is **derivable later** iff it is a pure function of other recorded fields.
> It should be **intentionally absent** iff recording it requires committing to a schema we
> expect to be wrong.

The governing principle, and the sharpest line in the audit:

> **Record observations. Never record classifications.**
>
> A classification can be applied retroactively to a stored observation. An observation
> cannot be recovered from a classification. Every "absent until later" item below is absent
> because it is a *classification*; every "capture now" item is present because it is an
> *observation*.

### 12.1 MUST CAPTURE NOW — irrecoverable if missed

Ordered by severity. The first three are severe enough that collecting a year of corpus
without them would produce a dataset that cannot answer the questions it was collected for.

> **Finding 0 — the capture seam itself is too narrow for phase ⑥.** *(Verified against the
> code, 2026-08-02; this corrects an earlier assumption in this section's first draft.)*
>
> The Experience Stream is wired to `recordDecisionTrace`, which fires **only on AI-mediated
> turns**. But the user's *reaction* to an AI edit is almost always a direct editor action —
> a keyboard `Ctrl+Z`, or dragging a saturation slider back down. Those never pass through
> the AI layer, so they never become events, so **the dominant outcome signals are not merely
> unjoined — they are entirely invisible to Stage A as shipped.**
>
> Two consequences: (a) capturing outcomes requires a **second capture point in the editor's
> action/undo path**, not a richer field on the existing one; (b) `ExperienceEvent.kind` was
> correctly typed as an open union — `"decision"` is one kind among several, and `"outcome"`
> is the next.
>
> Related observation, **reported not fixed** (shipped code, needs a decision):
> `recordRuleRejected` and `recordRuleConfirmed` are exported by `brain/feedback.ts` and
> called **only from eval tests** — no production call site exists. The B6 learning loop's
> negative signal is currently dead in the running app. That is a pre-existing gap, not one
> this work introduced, and fixing it changes shipped learning behaviour.

| # | Field | Phase | Why it is unrecoverable | Blocks |
|---|---|---|---|---|
| **1** | `outcome` records — **separate append-only rows** `{refEventId, kind: accepted ǀ tweaked ǀ undone ǀ ignored ǀ superseded ǀ survived-to-export, at, τ, detail{actionId, param, delta}}`, written from a **new editor-side capture point** (Finding 0) | ⑥ | The reaction happens in a window of seconds to minutes, as a direct editor action that never reaches the AI seam. Once the undo stack rolls or the slider moves again, it is gone. | **Everything.** With no outcome there is no error signal, so ⑥⑦⑧ and all of Stage B are unbuildable, and H3–H5 untestable. |
| **2** | `factsConsulted[]` `{factId, type, target, value (compact), confidence, observerId, observerVersion, inputSignature, accessPath, costMs}` | ① | **The fact store cascade-invalidates.** A fact read today is *destroyed* the moment its clip is trimmed. The value at decision time cannot be reconstructed from anything. | Attribution (⑦), L8 belief citations, observer calibration, H4 |
| **3** | `situation` `{projectId, compositionHash, mode, focusPanel, selectionCount, targetLayerIds, activeTool}` | ② | Editor state is not journaled anywhere. **This also silently breaks the shipped `project-switch` signal** — today we can detect that a switch happened but not *which project either side was*. | Stage C segmentation, context-scoped habits (§5.4), contextual value weights, H6 divergence |
| **4** | `candidates[]` `{id, score, whyRejected}` — the hypotheses considered and *not* chosen | ④ | **The most irrecoverable class in the system.** You can always replay what happened; you can never reconstruct what was almost chosen. Exists only during planning. | Counterfactual replay (§8.2), attribution, clarify-economics analysis, H1/H3 |
| **5** | `claimedConfidence` — carry BOTH `AiPlan.confidence` (the categorical `"Exact" ǀ "High Quality" ǀ "Approximation" ǀ "Experimental"`) and `AiPlan.confidencePercent` when the model supplied it | ④ | Both fields exist on the plan **at the trace call site today** and are dropped. (`ai/confidence.ts` is display formatting only — it does not compute confidence; the plan carries it.) | **H5 (calibration) is impossible without it** — and H5 is load-bearing |
| **6** | `owner` `{tier, ruleId, recipeId?, provider?}` — structured, not the display string | ④⑦ | `route` is a human-readable label (`"⚡ Instant local tier (t0.apply-look)"`). Parsing it is fragile and labels change; the structured ids exist at the call site and are flattened into prose. | `P.owner` (calculus L3 — no adaptation without attribution) |
| **7** | `actions[]` `{actionId, params, targetLayerIds, ok, error?}` — structured, not prose | ⑤ | **Prose is one-way.** Summaries can be rendered from structure; structure can never be parsed back out of summaries. | Replay, Closed-Loop Trace Test, attribution granularity |
| **8** | `preStateHash` | ⑤ | Compositions mutate in place. | Replay *validity* (see §12.4 for why this is not replay *capability*) |
| **9** | `cost` `{startedAt, finishedAt, estTokens, provider, retries}` — **two timestamps, not a scalar `latencyMs`** | ⑤ | Ephemeral. A scalar duration destroys temporal *overlap*: it can never tell you that a slow decision was concurrent with an interruption, a context switch, a decode stall, or another decision. Two timestamps preserve that relationship forever; a subtraction throws it away at write time and it cannot be recovered. `latencyMs` is derivable from the pair — the reverse is not. | Self-model resource predictions (§7.1), T4 efficiency errors, body-state correlation (item 10) |
| **10** | `body` `{frameHeadroom, decodePressure, gateOpen, gpuTier}` | ①⑦ | Frame time last Tuesday is gone. | Self-attribution — *was it my reasoning or my body?* (ORIS_SELF §3.3) — and it is the **only** way the §3.2 claim "cognitive policy is visibly modulated by body state" can ever be tested |
| **11** | `buildId` | — | ORIS_SELF §6: an upgrade changes the body. Without it the corpus cannot be partitioned by *which body this was*, and self-competence beliefs cannot cascade on upgrade. | Upgrade-as-autobiographical-event; competence validity |
| **12** | `seatId` (stable, local, non-PII) | — | An unlabelled multi-user corpus is unpartitionable **forever**. | ORIS_CALCULUS §8.4 multi-subject identity |
| **13** | `schemaVersion` | — | A corpus spanning schema evolution is unparseable without it. | All later analysis |
| **14** | `interrupted` | ⑤ | Whether the user cancelled mid-run is ephemeral. | Abandonment as an outcome class |

**On item 1 and the append-only tension.** Outcomes arrive *after* the event they describe,
which appears to conflict with L1 (append-only ground). It does not: **outcomes are new
records referencing the event id, never mutations of it.** The event stays immutable; the
join happens at read time. This is the correct resolution and it also gives late-arriving
outcomes (`survived-to-export`, observed hours later) somewhere to live.

### 12.2 DERIVABLE LATER — do not record

| Field | Derived from |
|---|---|
| `tau`, `dTau` | `tauInputs` (already correct — this is why they are stored) |
| `episodeId` and all segmentation | `signals` via `segment()` (already correct) |
| `idle-gap`, `intent-class-change`, `outcome-error` signals | `t` deltas, `prompt`, `failed`. Stored as convenience only — **they must never become the sole record of their inputs** |
| `zeroTokens` | presence of `provider` |
| **Explicit "undo that" rejections** | the stream itself — an event whose `prompt` matches the router's `UNDO_RE` shortly after a prior applied event *is* a rejection, joinable at read time. **This is the one slice of outcome signal that is already derivable**, and it is worth stating precisely so Finding 0's scope is not overstated: spoken/typed undo is recoverable, keyboard undo and direct parameter tweaks are not |
| prose `notes[]` / `steps[]` | structured facts + actions. **The current direction is backwards** — items 2 and 7 fix it |
| calibration curves, ECE/Brier, competence graph, growth trajectories, divergence | aggregates over the event log |
| **beliefs themselves** | see below |

**Beliefs are the important entry.** At runtime `B` is state. *Across time, `B` is a view over
`E` under a consolidation policy* — if the corpus is complete, the entire belief state is
re-derivable, and re-derivable under a **revised** policy, which is the whole point. This is
the deepest justification for the Experience Stream existing, and it means **nothing should
ever snapshot `B`.** A belief snapshot would be a second source of truth that cannot be
re-derived when the consolidation rules improve.

### 12.3 INTENTIONALLY ABSENT — until a later stage

Absent because recording them requires committing to a schema we expect to be wrong.

| Field | Stage | Why absent now |
|---|---|---|
| Belief deltas (*what changed and by how much*) | B | No belief schema exists. Inventing one to log against would bake in the error. |
| Attribution / blame assignment | B | ⑦ is *enabled* by recording items 4 and 6 now; the assignment itself waits. |
| **Error classification into `V` tiers** | B | The taxonomy is expected-wrong (ORIS_VALUES §8.1). Record the raw correction; apply the taxonomy retroactively. This is the canonical case of *observation over classification*. |
| Prediction *scoring* (claimed vs realised) | B | Stage A records the claim and the outcome. Scoring them is the Ledger's job. |
| Drives / valence scalars | B–C | Derivable from `body` + `outcome` once both are recorded; the model is unsettled. |
| Commitments, identity, plasticity | Epoch 4 | L7 forbids writes above band B2 for the entire programme. |
| Simulation outputs | C+ | No simulator exists. |

### 12.4 DEFERRED FOR COST — not for prematurity

A fourth category, distinguished because it has a **different revisit trigger**: §12.3 unblocks
on *schema maturity*, this unblocks on *storage economics*.

| Field | Enables | Revisit when |
|---|---|---|
| Full composition snapshot per event | True counterfactual replay — §8.2's labelled-pairs multiplier, the largest learning-signal multiplier in the architecture | Project version history exists, or a bounded diff journal is cheap |
| Raw model input/output | Provider-level debugging, prompt calibration | Never without explicit consent — large and privacy-loaded |
| Frame/media captures | Visual outcome comparison | Never in the stream; the renderer is deterministic, so a hash suffices |

**The honest limit on item 8.** `preStateHash` lets us *verify* that a replay is valid. It does
not let us *perform* one — that needs the composition at that version, which is deferred here.
Stating this now prevents a Stage C plan that assumes replay capability it does not have.

### 12.5 One log, many producers

Finding 0 requires a second *capture point*. It must not become a second *stream*.

```
   ai       →  decision event      (wired)
   system   →  session event       (wired)
   editor   →  outcome event       (Finding 0 — reserved, unwired)
   ledger   →  prediction event    (Stage B — reserved, unwired)
                     │
                     ▼
        ONE append-only journal, globally ordered
```

Parallel streams would make *"what happened next"* a merge problem forever — and every
downstream question (segmentation, attribution, replay) is a question about ordering. One log
keeps replay a single pass.

This is what forces the **envelope** shape: `{id, seq, sessionId, episodeId, t, τ, dτ,
tauInputs, producer, kind, signals, payload}` with a typed payload per kind. A
decision-shaped record would push `applied`/`failed` onto session and outcome rows where they
are meaningless, and that denormalisation is unfixable once a corpus exists.

Two consequences fell out of the envelope that were not anticipated:

- **Session-scoped facts normalise onto the session row.** `schemaVersion`, `buildId`, and
  `seatId` (items 11–13) do not change within a session, so writing them per-event is
  denormalisation that H7 pays for forever. They live on the session row; every other row
  joins by `sessionId`.
- **Eviction must pin referenced session rows**, or survivors lose that join and become
  unanalysable. This is calculus L8 (provenance conservation) applied to the session key, and
  it makes the ceiling deliberately *soft* by the number of live sessions.

### 12.6 Two consequences to decide before implementing

**Storage.** The shipped envelope measures **417 bytes/event** (up from 353 flat — envelope
overhead, partly repaid by normalising session facts). The §12.1 set roughly doubles it, to
an estimated 900–1,100 bytes/event — about 1.5 MB at the current 1,500-event ceiling. That is
past comfortable localStorage territory and **forces the OPFS decision earlier than planned**
(the habitat already uses OPFS for artifacts). It also makes H7 (sublinear growth) more urgent,
not less: residual storage stops being an elegant idea and becomes the thing that decides
whether the corpus fits on the device.

**Governance.** Prompts are user text and may contain client names. That is fine while the
corpus is local-first — but ORIS-7's psyche volume is explicitly *portable and shareable for
support*. A redaction and consent policy is cheap to define now and expensive to retrofit onto
a year of accumulated corpus. This is a product decision, not a technical one, and it should be
made before §12.1 ships rather than after.
