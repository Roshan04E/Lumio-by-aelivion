# ORIS Cognitive Calculus — v0

> **What this file is:** the formal core of ORIS. It defines the complete set of state
> variables, the closed set of operators that transform them, and the laws those
> transformations must satisfy. Its purpose is **admission control**: once this exists, a
> proposed subsystem is not judged by whether it sounds important but by whether it can state
> its variables, its operator signature, its coordinates, and the laws it could violate.
>
> **What this file is not:** an implementation. No types here are TypeScript; they are
> specifications that a TypeScript implementation must satisfy.
>
> **Reading order:** [`ORRERIS_OS.md`](ORRERIS_OS.md) (the habitat) →
> [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) (the organism, in prose) → this file (the
> organism, formally) → [`ORIS_VALUES.md`](ORIS_VALUES.md) ·
> [`ORIS_SELF.md`](ORIS_SELF.md) · [`ORIS_TIME.md`](ORIS_TIME.md) (three variables in depth).
>
> **Status:** v0, 2026-08-02. **This is expected to be wrong in specific, predicted places**
> — see §7. A calculus written before the data exists is a hypothesis with good syntax.

---

## 0. Why a calculus, and the honest caveat

The failure mode this document exists to prevent is **box accretion**: an architecture that
stays coherent for two years and then acquires a "Reflection Module," a "Narrative Engine,"
and a "Motivation Layer" because each sounded necessary and nothing could rule them out.
Prose cannot rule things out. A closed operator set can.

The counter-risk, stated up front so we don't repeat a famous mistake: **formalising before
measuring is how Cyc happened.** A beautiful calculus fitted to zero data will be beautiful
and wrong. Two rules follow:

1. **The calculus must describe the *shipped* system first.** §6 traces a real, already-live
   Orreris interaction through every operator. If the calculus cannot express what already
   works, it is fiction.
2. **The calculus must not gate Epoch 0.** Instrument first (O1–O2 in
   ORIS_ARCHITECTURE.md §19); the data revises the calculus, not the reverse. §7 names in
   advance which parts we expect the data to break, so that revising them is a *result*
   rather than an embarrassment.

---

## 1. State

### 1.1 The partition

ORIS's Markov blanket (ORIS_ARCHITECTURE.md §3.3) divides all state into three classes. The
distinction is not bookkeeping — it determines what may be written, by whom.

```
SENSED (read-only to ORIS; owned by Orreris OS)
    W   World facts        exteroception — the project, the footage, the user's actions
    S   Structural self    proprioception — subsystems, capabilities, health, declared limits

OWNED (ORIS's own state; the only things ORIS may write)
    E   Experience         append-only episodes
    B   Beliefs            held propositions, typed by subject
    C   Commitments        C ⊆ B — minimal-plasticity beliefs carrying refusals.
                           SPANS BANDS: an intention is C@B2 (session-lived), a project
                           norm is C@B3, an identity trait is C@B5. Same object, same
                           refusal semantics, different lifetime. (§1.5)
    V   Values             tiered partial order over error classes
    D   Drives             homeostatic scalars
    P   Predictions        open claims awaiting outcome
    Θ   Meta-parameters    global modulators of every learning process

FIXED (band B6; no operator may write here — see L9)
    the operator definitions · the compare/attribute machinery · V's constitutional tier ·
    the blanket itself · the Timeline Action Registry
```

**Seven owned variables, two sensed, one fixed core.** That is the whole ontology. The claim
being made — falsifiable, and the thing to attack first — is that **no eighth owned variable
is needed**, and that everything the founding hypothesis called a "model" is either one of
these, a *view* over one of these, or a *trajectory* of one of these.

### 1.2 The ten hypothesised models, reduced

| Founding model | Reduction |
|---|---|
| World Model | `W` — sensed, not owned. Belongs to the habitat. |
| User Model | a **view**: `B[subject=user]` ∪ `P` about the user |
| Internal Self Model | a **view**: `B[subject=self]` (learned, fallible) — *distinct from* `S` (measured) |
| Persistent Situated Cognition | a **read-out**: the current `bind` output σ, maintained across ticks |
| Identity Model | a **view**: `C[subject=self]` |
| Meta Cognition | **operators** over `(P, B[subject=self])` |
| Future Simulation | the **operator** `simulate` |
| Homeostasis | `D` (+ `Θ` via `modulate`) |
| Growth | a **trajectory**: the time-series of `B`, `C`, `Θ` |
| Self Modification | the **operators** `promote` / `revoke` / `modulate`, under governance |

Three of the ten are views, three are operators, one is a trajectory, one belongs to the
habitat, and two are genuine state. **The founding hypothesis was ~80% type error** — which
is the expected result of a good first pass, not a criticism of it.

### 1.3 Record types

Specified structurally. Field names are normative; representations are not.

```
Episode  ∈ E
  id, t_wall, τ_subjective, band
  situation        σ at the time (compressed)
  action           α | ⊥
  outcome          observed consequence
  ε                the typed error, if a prediction was open
  salience         surprise × consequence — governs retention (ORIS-9)
  citations        ← back-references from any B/C element justified by this episode

Belief   ∈ B
  id
  subject          self | user | world | (user's model of self)   ← typed, enables level-2 ToM
  proposition      the claim, in a registered dialect
  confidence       [0,1]
  evidence_for     [episode_id]        non-empty (L8)
  evidence_against [episode_id]        MUST be maintained — see L4 rationale
  plasticity  λ    [0,1] — how much one new datum moves it; monotone decreasing (L6)
  band             which timescale owns it
  age, revisions   revision history is retained, not overwritten

Commitment ∈ C ⊆ B
  ...all Belief fields, with λ ≈ 0
  refusal          the action predicate this commitment vetoes
  threshold        contradiction count at which revoke fires   ← no threshold = dogma
  declared         the statable form, for honest surfacing

Prediction ∈ P
  id, claim, claimed_confidence
  owner            the Belief id that made the claim   ← required for attribution (L3)
  cost_estimate    what ORIS expected to spend
  horizon          when this resolves
  opened_at        τ

Error ε
  class            which error class in V (never just a scalar)
  magnitude
  direction
  tier             V-tier of the class — determines commensurability (L5)
  uncertainty_kind expected | unexpected      ← ACh vs NE; opposite responses
```

Two fields carry unusual weight. `evidence_against` is what separates an epistemology from a
confidence score: a belief that only accumulates support cannot be revised, only reinforced.
`uncertainty_kind` prevents the single most common learning failure — averaging a genuine
change into a noise estimate, or treating noise as a change.

### 1.4 Views — the presentation layer

§1.2 reduces the founding ten models to views, operators, and trajectories. That reduction
is about **ontology**, not about **interface**, and conflating the two would be a real
mistake. Planners, debuggers, evals, visualisations, and humans all reason naturally in
terms of *"the user model"* — not *"a filtered projection of beliefs by subject."* Forcing
every consumer to speak in base variables buys mathematical tidiness at the cost of
engineering clarity, and that is a bad trade.

So: **views are first-class named subsystems.** They are documented, addressable, queryable,
independently evaluable, and independently visualisable. What they are not is *state*.

> **Views are free. State is expensive.**
>
> Adding a view is not an architectural change and requires no admission test (§5). Adding a
> state variable requires re-deriving the reduction in §1.2. That asymmetry is the entire
> point of the distinction — it lets the conceptual vocabulary grow without the ontology
> growing.

There is a stronger argument for views than ergonomics, and it is worth making explicitly:
**views are the natural unit of explanation and of evaluation.** "Show me the user model" is
a debugging surface. "Did the user model's calibration degrade this week?" is an eval
question. "Why are you like this?" is a query against the identity view. Base variables are
the wrong grain for all three. The explainability surface — half the moat, per
ORRERIS_OS.md — lives at the view layer, not the state layer.

#### The discipline

Without rules, a view acquires a cache, then a write path "just for convenience," then a
second source of truth that drifts. This is the **materialised view trap**, and it is
precisely the "second hidden planner" failure the habitat document already forbids in the
data layer. Five rules, checkable by inspection:

- **V1 · Pure.** A view is a pure function of base state. It holds no state of its own.
- **V2 · Read-only.** A view has no write path. There is no "update the user model"; there
  is `adapt` writing to `B[subject=user]`, which the view then reflects.
- **V3 · Never an operator argument.** Operator signatures (§3) name base variables only.
  This is the structural guarantee: because no operator can take a view, **no view can ever
  become load-bearing in the calculus**, no matter how central it becomes to the UI or to
  how the team talks.
- **V4 · Caches are derivation-keyed.** A view may be memoised only under the fact store's
  existing rule — keyed by input content hash plus derivation version, cascade-invalidated
  through dependencies. A cache that can drift from its base is a second source of truth.
- **V5 · Freely registered.** `registerView()` alongside the habitat's other registration
  surfaces. Adding one is a normal day's work.

#### The canonical views

Which returns the founding hypothesis almost intact — now correctly typed:

| View | Definition | Primary consumers |
|---|---|---|
| `WorldModel` | `W` (the habitat's existing five-branch facade — already shipped) | planner, observers |
| `UserModel` | `B[subject=user]` ∪ `P[about=user]` | planner, `simulate`, explainability |
| `SelfModel` | `B[subject=self]` ∪ `S` | honest decline, routing, attribution |
| `CompetenceGraph` | `B[subject=self]` indexed by capability id | decline, routing, self-report |
| `Identity` | `C[subject=self]` + declared refusals + thresholds | character sheet, refusal surfacing |
| `Situation` | `bind(o, E_recent, C)` | core self, workspace, "where am I" |
| `Autobiography` | `E` filtered to promotion / revocation / upgrade events | *"why are you like this"*, support |
| `Calibration` | `P` × outcomes, grouped by owning belief | metacognition, honest confidence |
| `Growth` | trajectory of `B`, `C`, `Θ` over `τ` | development dashboards, epoch gating |
| `BodyState` | `S.health` ∪ `D` | HUD, budget gating, ORIS-6 enforcement |

Ten views over seven variables. **The founding ten-model hypothesis was right as an
interface and wrong as an ontology** — which is the most useful kind of wrong, because the
vocabulary survives intact while the storage stops duplicating.

#### The hard cases

`Situation` (σ) is where the purity rule is tested twice, and the second test found a real
omission.

**Case 1 — episode continuity.** σ must persist across ticks; that persistence is what makes
it a *core self* rather than a recomputed snapshot. A view with memory is not a view.

*Resolution — relocation, not exception:* **episode continuity belongs to `E`.** The episode
id, its opening `τ`, and its boundary state are episodic facts and are stored as such. σ
remains a pure function of `(o, E_recent, C)` and inherits continuity by reading `E`.

**Case 2 — framing.** Same project, same timeline, same user, same history — but yesterday
ORIS was looking for colour problems and today for lip-sync. Nothing external differs. What
is salient, what gets simulated, and which evidence is prioritised all differ. If nothing in
state represents that, **two identical external situations produce different cognition with
no representable difference in state** — which destroys determinism, replay, and
explainability in one stroke. That is a genuine defect, not a philosophical worry.

*Resolution — see §1.5.* Framing is an **intention**, intentions are commitments, and
commitments already span bands. `C` was under-specified, not missing.

---

### 1.5 Framing, intention, and why `C` spans bands

ORIS_ARCHITECTURE.md §10.1 argues that **a goal is not an intention**: an intention is a
commitment that *resists reconsideration*, filters incompatible options, and persists across
interruptions — and that today's planner is goal-shaped only, which is why session continuity
is fragile. §10.6 then asserts that identity, intention, and belief are one object type at
three plasticity levels. Both claims were correct and neither was carried into the state
definition. This section closes that gap.

**Plasticity and band are orthogonal coordinates.** The `Belief`/`Commitment` records
already carry both (§1.3), so the structure was latent; it was simply never stated.

| | Plasticity λ | Band | Lifetime | Example |
|---|---|---|---|---|
| Belief | 0.1 – 1.0 | any | evidence-bound | *"this user prefers cool grades"* |
| **Intention** | **≈ 0** | **B2** | **session / task** | *"I am checking lip-sync"* |
| Project norm | ≈ 0 | B3 | this project | *"this client's brand is warm"* |
| Identity | ≈ 0 | B5 | years | *"I don't stylise wedding skin"* |

An intention is therefore `C@B2`: **low plasticity, short life.** Low plasticity is what
makes it resist reconsideration mid-task (Bratman's whole point — an intention you re-derive
every tick is not an intention). The short band is what makes it evaporate at session end
rather than becoming character. L7 (no upward writes) already guarantees that a session
intention cannot leak into B5 except through `consolidate`/`promote`.

Both of `C`'s roles apply to intentions, which is the test of whether the unification is real
rather than convenient:

- **Attention ranking** (in `bind`): *"I'm checking lip-sync"* raises the salience of
  audio-video offset observations. This is exactly the ranking role L4 permits.
- **Action veto** (in `act`): it makes *"let me regrade this shot"* an inadmissible
  distraction. A soft, session-scoped refusal — the same predicate machinery as an identity
  refusal, with a lower threshold.

And `threshold` maps cleanly: an intention's threshold is the evidence at which it is
abandoned. Intentions resist reconsideration; they do not survive arbitrary contradiction.

#### Declared versus inferred framing

The user rarely announces their framing. So intentions arrive two ways, and the distinction
is load-bearing:

```
DECLARED    "I'm doing a sync pass"        confidence ≈ 1.0, owner: user
INFERRED    from behaviour — scrubbing      confidence < 1.0, owner: a belief,
            audio, soloing tracks, small    therefore ATTRIBUTABLE when wrong
            nudges on one clip
```

An **inferred intention is a prediction**, so it registers in `P` like any other claim, and
when it is wrong the ledger catches it: *"I thought you were colour-grading; you were
checking sync."* That is a concrete, testable, and rather valuable failure mode to be able to
detect — mis-framing is one of the most annoying things an assistive tool does, and today
nothing in the system can even represent having done it.

Seed: `intent-continuity.ts` already ships as part of the habitat's Editor State branch. It
is the closest existing thing to `C@B2` and is where this would land.

#### Why attention itself is *not* state

One could argue instead for an explicit attention variable. That would be a mistake:
attention is *produced* by the salience function over `C`, `D`, `V`, and current error
(ORIS_ARCHITECTURE.md §11). Storing it would create a second source of truth about what is
salient — the materialised view trap, one level up.

> **The cut: attention is a read-out; the intention that shapes it is state.**

That keeps V1 intact and keeps the variable count at seven — but only just. Had framing not
fitted `C`, it would have been the eighth variable and §7 item 7 would be resolved against
us. Recorded as a near-miss rather than a vindication (§7).

---

## 2. Geometry: the loop and the ladder

Cognition is not a component list, and it is not a chain either. It is a **cycle**, run
concurrently at several **timescales**. Two coordinates locate everything:

```
                        PHASE  (where on the cycle)
                              ①  sense
                    ⑧ adapt   ┌──────────┐   ② bind
                          ╲   │          │   ╱
                 ⑦ attribute ─┤   loop   ├─ ③ believe
                          ╱   │          │   ╲
                  ⑥ compare   └──────────┘   ④ expect
                              ⑤  act / wait

                        BAND   (which timescale)
   B0 somatic → B1 situational → B2 task → B3 project → B4 dispositional
              → B5 identity → B6 constitutional (fixed)
```

**Coordinate = (phase, band).** Every subsystem, present or future, has one. This is the
admission test in §5.

### 2.1 On the proposed linear geometry

The review proposed `Reality → Belief → Expectation → Comparison → Adaptation`. That is
phases ①③④⑥⑧ and it omits three, each consequentially:

- **② bind** — the step that turns observations into a *situation*. Without it there is no
  "now," therefore no core self, therefore no situatedness. It is also the only legitimate
  place for identity to filter attention (L4).
- **⑤ act** — the chain is purely epistemic, so it can only close error by changing the
  model. Active inference's real contribution is that error closes **two** ways: change the
  model, or change the world. Omitting action makes the loop a spectator.
- **⑦ attribute** — the step nearly every agent architecture skips, and the reason most
  cannot learn from failure. Knowing you were wrong is worthless without knowing *what* was
  wrong. Credit assignment is a phase, not a footnote.

The loop is also **not a line because it is reentrant**: phase ⑤ at B1 (act now) runs inside
phase ④ at B3 (this project's expectation), which runs inside phase ⑧ at B5 (who I am
becoming). Bands are nested contexts, not a queue.

### 2.2 Three layers

The document's structure has converged on a decomposition worth naming, because it tells you
where any question belongs before you try to answer it:

```
PSYCHOLOGY   views          Identity · Self · Situation · World · Growth · Competence ·
             (§1.4)         Autobiography · Calibration · BodyState · UserModel
                            → how the system and its humans make sense of the cognition
                            → freely added; never load-bearing (V3)
             ─────────────────────────────────────────────────────────────────────────
BIOLOGY      operators      sense bind believe expect act compare attribute adapt
             (§3)           consolidate simulate promote revoke modulate
                            → how cognition changes; closed set; extended by registration
             ─────────────────────────────────────────────────────────────────────────
PHYSICS      state          E · B · C · V · D · P · Θ   (sensed: W · S   fixed: B6)
             (§1)           → the irreducible; small; grows only under protest
```

The layers have different growth rates by design, and that asymmetry is the architecture's
defence against decay: **psychology grows freely, biology grows rarely, physics grows almost
never.** A proposal is located by asking which layer it wants to live in — and the honest
answer is usually one layer lower than it first appears to be.

---

## 3. Operators

Thirteen. The set is closed: a new capability is a new *registration* into an existing
operator, never a fourteenth operator.

### 3.1 On-loop (the cognitive cycle; bands B0–B2)

| # | Operator | Signature | Note |
|---|---|---|---|
| ① | `sense` | `W × S → o` | Exteroception and proprioception, unified. Pull-based; costed by the access-path planner (habitat). |
| ② | `bind` | `o × E_recent × C → σ` | Produces the situation — "where am I, what am I doing, who am I helping." `C` ranks **relevance only** (L4) and spans bands: `C@B2` is the active framing, `C@B5` the identity refusals (§1.5). Continuity is read from `E`, not held in σ. |
| ③ | `believe` | `σ × B → B′` | Revision, never overwrite. Writes to `evidence_for` **and** `evidence_against`. |
| ④ | `expect` | `B × V × σ → P` | `V` selects *what is worth predicting* — you cannot afford to predict everything, and what you choose to predict is a normative act. |
| ⑤ | `act` | `P × C × D × Θ → α ǀ ⊥` | The **only** operator crossing the blanket. `C` may veto. `⊥` (wait) is a first-class output, not a failure. |
| ⑥ | `compare` | `P × outcome × V → ε` | Produces a *typed, tiered* error, never a bare scalar. |
| ⑦ | `attribute` | `ε × P → (belief_id, blame)` | Uses `P.owner`. Unattributable error is logged and **discarded for learning purposes** (L3). |
| ⑧ | `adapt` | `ε × B × Θ × λ → B′` | Magnitude gated by plasticity `λ` and modulated by `Θ`. Cannot write above its own band (L7). |

### 3.2 Off-loop (idle / sleep; bands B3–B5)

| Operator | Signature | Note |
|---|---|---|
| `consolidate` | `E × B → (B′, E′)` | Episode → pattern → knowledge. Interleaved and offline (CLS). **One of only two upward channels** (L7). Also compresses `E` — the memory-ceiling mechanism. |
| `simulate` | `B × W × S × Δ → Ω` | `Δ` perturbs the **world** (project futures — exact, via the deterministic renderer) or the **self** (what would I become — approximate, via replay against held-out history). One operator, two argument types. |
| `promote` | `B × evidence × Ω → C` | Ceremonial. **Requires** a `simulate` rehearsal `Ω` (ORIS-15). The second upward channel. |
| `revoke` | `C × contradictions → B` | Demotion. The only operator that may *increase* plasticity (L6), and it is always a logged event. |
| `modulate` | `D × ε_history → Θ` | Neuromodulation: four global scalars retune every learning process at once, without touching any particular belief. |

### 3.3 What is deliberately absent

No `reflect`, no `narrate`, no `introspect`, no `decide`. Each of those is a composition:

```
metacognition   =  compare ∘ attribute  restricted to  B[subject=self]
introspection   =  a query over S ∪ B[subject=self]  — not an operator
narration       =  a rendering of E ∪ C  for output  — a view, not cognition
deliberation    =  expect ∘ simulate ∘ act  when no fast path resolved (a SOAR impasse)
curiosity       =  d(ε)/dτ  per domain, read from the ledger  — a derivative, not a drive
```

If a proposed mechanism decomposes into existing operators, it is a **function**, and
functions do not get to be architecture.

---

## 4. Laws

Ten. Each is checkable — statically over the operator implementations, or dynamically as a
runtime assertion. A law that cannot be checked is a slogan and should be deleted.

**L1 · Append-only ground.**
`E` grows only by append. `consolidate` may compress an episode's *representation* but may
never delete an episode cited by a live element of `B` or `C`.
*Rationale:* history is the only thing that cannot be re-derived. Everything else is a cache.

**L2 · No credit without a claim.**
`compare(P, ·, ·)` accepts an outcome only if `P` was registered **before** `act`.
Retrospective prediction is not prediction. *(= ORIS-4.)*

**L3 · No adaptation without attribution.**
`adapt` accepts only an `ε` that has passed `attribute`. Unattributed error may update
nothing.
*Rationale:* diffuse updating from unattributed error is how a system drifts while every
component reports health.

**L4 · Refusals bind action and attention, never evidence.**
The refusal predicate of `C` may appear in the bodies of `bind` and `act` — and nowhere else.
It may not appear in `believe`, `compare`, `attribute`, or any write to `E`.
*Rationale:* an identity that filters evidence is a confirmation-bias engine. This is the
one law that is purely a safety property, and it is checkable by inspection. *(= ORIS-11.)*

**L5 · Lexicographic values.**
For error classes in different tiers of `V`, ordering is lexicographic; weights exist only
*within* a tier. No magnitude of lower-tier gain offsets a higher-tier violation.
*Rationale:* a value with an exchange rate is a price. *(= ORIS-12.)*

**L6 · Monotone plasticity.**
`λ` decreases only through `consolidate` and `promote`. It increases only through `revoke`,
which is always logged and surfaced.
*Rationale:* identity that can be quietly re-plasticized is not identity.

**L7 · Band coherence.**
No operator writes to a band slower than its own. An operator may read its own band or
slower. `consolidate` and `promote` are the **sole** upward channels, and both are offline
and gated.
*Rationale:* this is the structural defence against premature identity — a single bad
session cannot reach B5 — while still letting slow structure constrain fast behaviour.
*(= ORIS-13. Subsumes ORIS-10.)*

**L8 · Provenance conservation.**
Every element of `B` carries at least one citation into `E`. An element whose citations have
all been evicted is itself evicted.
*Rationale:* joins revocability and the memory ceiling into one law — you may only keep what
you can justify, and you may only justify what you kept. *(= ORIS-8 + ORIS-9.)*

**L9 · Closure of the modifiable set.**
No operator writes to band B6: the operator definitions, the `compare`/`attribute`
machinery, `V`'s constitutional tier, the blanket, the Timeline Action Registry.
*Rationale:* anything that can rewrite its own credit assignment will (EURISKO). *(= ORIS-5;
with L7 it also yields ORIS-7, since B6 is exactly the code and B0–B5 exactly the data.)*

**L10 · Action monopoly.**
`act` is the only operator with a codomain outside the blanket. Its self-directed range
(observe, cache, simulate, consolidate, warm) is unrestricted; its other-directed range is
exactly the Timeline Action Registry, and only with user-originated intent. *(= ORIS-1.)*

**L11 · Witnessed or derived.**
A record contains only what its producer directly witnessed — either an event at that
producer's own surface, or the producer's **own act**. Everything else — episodes,
consequences, outcomes, assessments, beliefs, competence, calibration, reflection — is derived
at read time and is never written as observation.
*Rationale:* an observation cannot be recovered from an interpretation, and every taxonomy in
this programme is expected to be revised. One producer recording what it did not witness makes
the corpus untrustworthy **everywhere**, not merely in that row, because nothing downstream can
tell witnessed rows from inferred ones.
*The distinction is event vs. meaning, NOT self vs. other.* An earlier draft of this law was
framed around self-observation — *"an actor witnessing its own act is witnessing"* — which is
true and abusable: *"the system observed itself concluding X"* smuggles every interpretation
back in wearing a self-observation badge. The correct framing:

> **A producer may record an event it performs, if the occurrence of that event is objectively
> observable at the producer's boundary. It may never record its own interpretation of that
> event.**

```
✔  decision committed            ✘  the decision was good
✔  mutation committed            ✘  the belief became correct
✔  promotion transaction ran     ✘  identity improved
```

*An event may embody a judgement; recording that it occurred is still observation.* A decision
row records that the AI decided, not that it decided well. A promotion transaction encodes a
threshold judgement, and recording that the transaction ran is observation — recording "the
system is now more competent" is not. What is forbidden is lifting the judgement out of the
event and storing it as a separate fact.

*Admission test — the operational form:*

> **Could two honest observers disagree about whether this occurred?**

If no, it happened, and it is evidence. If yes, it required a policy, and it is not.

```
✔ undo transaction committed      ✘ the user rejected the AI
✔ slider changed                  ✘ the AI succeeded
✔ export completed                ✘ identity improved
✔ user pressed Reject             ✘ the outcome was positive
```

This is the same test as *"what did the producer directly witness, without appealing to any
later policy?"* — and it is easier to apply under pressure, because disagreement between
honest observers is a concrete thing to imagine and "witness" is not. It subsumes ADR-014
E6/E11 and ORIS-19 without special cases.

*It has teeth against shipped code.* Applied to the Experience Stream's own envelope it
rejected two fields that had already been frozen: episode identity (two observers running
different segmentation policies disagree about where an episode begins) and subjective time
carrying no policy identifier (two observers running different τ models disagree about the
value). Both were corrected in schema v4. A law that only ever validates existing designs is
not doing any work.

**L12 · Every derivation names its policy.**
A derived value carries the identity and version of the policy that produced it.
*Rationale:* this is what makes L11 pay rather than merely sound principled. Without it,
"derived" degenerates into *computed once and forgotten*, which is storing interpretations
with extra steps — and the re-derivability L11 exists to protect is silently lost. L11 says
do not store interpretations; L12 says the interpretation you compute must be reproducible,
comparable across policy versions, and attributable when it turns out to be wrong.
*Corollary:* a derivation cache is permitted only under V4 (derivation-keyed, cascade-
invalidated). A cache that can drift from its inputs is a stored interpretation.
*What this buys:* `accepted(policy=v2.1)` and `accepted(policy=v3.0)` may legitimately
disagree about the same corpus, and both remain reproducible. Without the version, the corpus
would carry `accepted(according to… something)` — reproducible by nobody.

**L13 · Artifacts are outputs, not evidence.**
Proposals, plans, tasks, reminders, generated reports: these are neither observations nor
views. They are **things the organism produced**, intended for a consumer, and they must be
persisted — a proposal that cannot be stored is useless.

So the persistence ontology is four classes, not three:

```
OBSERVED EVENTS      witnessed · immutable · the Experience Stream         evidence
DERIVED VIEWS        recomputed on read · never stored (V4 caches aside)   not evidence
INTERPRETATIONS      derived under a named policy (L12)                    not evidence
PRODUCED ARTIFACTS   stored, addressable, immutable, OUTSIDE the stream    not evidence
```

Hence the precise form of L11's prohibition: **interpretations are never stored *as evidence*
—** not "never stored." The corrected boundary matters, because the unqualified version would
forbid the organism from ever producing anything.

*Where artifacts live:* outside the stream, addressable. The **act of producing one** is
itself a witnessed event with a boundary, so it is a legitimate stream row that *references*
the artifact. The stream can therefore answer *"on Tuesday it proposed X"* without becoming a
document store, and the artifact keeps its own lifecycle.

*Guard against laundering:* an artifact is something a consumer takes as output. An
interpretation persisted "just in case" is not an artifact — it is a cached view and owes V4
and L12. The test: **does something consume this as output, or is it a claim about history?**

### 4.1 The reduction

The fifteen prose invariants of ORIS_ARCHITECTURE.md §18 are not fifteen independent rules.
Under the calculus:

```
L7 + L9   ⟹  ORIS-5, ORIS-7, ORIS-10, ORIS-13
L8        ⟹  ORIS-8, ORIS-9
L10       ⟹  ORIS-1
L2        ⟹  ORIS-4
L4        ⟹  ORIS-11
L5        ⟹  ORIS-12
L11       ⟹  ORIS-18, ORIS-19
L12       ⟹  ORIS-20
```

Six laws generate nine invariants. The remainder — ORIS-2 (no performed affect), ORIS-3
(user capability), ORIS-6 (body budget), ORIS-14 (measured self), ORIS-15 (rehearsal) — are
**not** derivable and are therefore genuinely independent commitments. That is worth knowing
precisely: those five are where the architecture's values live, as opposed to its mechanics.

---

## 5. The admission test

### 5.0 The four persistence classes

Before the conservation rule, one classification. **Every persisted object belongs to exactly
one of four classes, and it must be classifiable *before* it is designed:**

| Class | Property | Mutable? | History? | Lives in |
|---|---|---|---|---|
| **Evidence** | directly witnessed | never | append-only | the Experience Stream |
| **Derivation** | reproducible from evidence under a named policy (L12) | disposable | none — recomputed | caches (V4) or nowhere |
| **State** | the organism's current condition | yes | none | the state variables (§1.1) |
| **Artifact** | an output the organism produced, for a consumer (L13) | no — superseded, not edited | addressable | outside the stream, referenced by evidence |

> **If a proposed persisted object cannot be placed unambiguously in one of these four, the
> design is incomplete.** Not "pick the closest" — ambiguity is the finding, and it means the
> object is two things wearing one name.

One worked case, because it is the one people get wrong: the **situation** is *State* — it is
true until changed and has no history. The situation *snapshot on a decision row* is
*Evidence* — it is what was witnessed at that moment and can never change. Same data, two
classes, and conflating them would have made either the state un-updatable or the evidence
mutable.

Every future ADR introducing a persisted object satisfies this test first. It replaces a
growing collection of special-case rules with one reusable governance question.

### 5.1 The conservation rule

Above the four questions sits one rule, and it is the load-bearing one — everything else in
this section is procedure for applying it:

> **Views are free. Operators are rare. State is expensive.**
>
> Every proposal must first answer: **is this new information, or another interpretation of
> information we already hold?** If it is an interpretation, make a view (§1.4) and ship it.
> If it is genuinely new information, the burden is to prove a new state variable is
> *unavoidable* — and the prior against that is §1.2, where eight of ten candidate "models"
> turned out not to be state.

This is a conservation law, not a style guide. Without it, an architecture accretes an
Emotion Engine, a Creativity Engine, a Reflection Engine, an Intuition Engine and a Wisdom
Engine, each of which quietly stores state overlapping the others — and by the time the
overlap is discovered, five subsystems have write paths to the same truth and none of them
can be removed.

### 5.2 The four questions

Any proposed addition must answer all four.

1. **State.** Which of the seven owned variables does it read and write? If it needs an
   eighth, argue why it is not a view, a trajectory, or a composition (§1.2 is the prior).
2. **Signature.** Which operator does it register into, with what types? If it needs a
   fourteenth operator, show that it does not decompose (§3.3).
3. **Coordinates.** Its `(phase, band)`. A subsystem that claims every band is unbounded; a
   subsystem that claims no phase is not cognition.
4. **Laws.** Which laws could it violate, and what prevents that structurally rather than by
   convention?

> **A proposal that cannot answer all four is a box.** Boxes are rejected — not because the
> idea is bad, but because an unlocated idea cannot be tested, budgeted, or reasoned about
> two years later.

**Exemption: views are admitted without test.** A proposal that reduces to a pure, read-only
projection of existing state (§1.4) is registered, documented, and shipped — it is not
architecture and does not consume architectural budget. So the test's real question is
narrower and more useful than it first appears: *is this new state, or a new way of looking
at state we already have?* Most good ideas turn out to be the latter, and the test exists to
make that answer cheap rather than embarrassing.

Worked rejections, to show the test has teeth:

- *"A Narrative Engine that tells the system's story to itself."* → No state it writes that
  `E` and `C` do not already hold; decomposes into a view (§3.3). **Rejected as a view.**
- *"An Emotion Module."* → Writes `D`; but the only legitimate consumers of `D` are `act`
  and `modulate`, both existing. **Rejected as `modulate` with extra vocabulary** — and if
  its output were user-facing, rejected outright under ORIS-2.
- *"A Curiosity Drive."* → Claims to write `D`; but curiosity is `d(ε)/dτ`, a read over the
  ledger, not a stored quantity. **Rejected as a derivative.**
- *"A Self Graph."* → Reads/writes `S`; sensed, version-keyed, band B0/B6. Answers all four.
  **Admitted** ([`ORIS_SELF.md`](ORIS_SELF.md)).
- *"A Value System."* → `V`; tiered; consumed by `expect` and `compare`; constitutional tier
  in B6. Answers all four, and L5 exists because of it. **Admitted**
  ([`ORIS_VALUES.md`](ORIS_VALUES.md)).

---

## 6. Worked trace — the calculus against shipped behaviour

The test from §0: can the calculus express something Orreris already does? Below is the
**live K4 mood pipeline** (ORRERIS_OS.md, "make it moody"), rewritten in the calculus. Every
element on the left already ships.

```
USER: "make this feel dramatic"

① sense      W ← composition-text fact (L2 observer, cached)
             S ← GPU tier, background gate open, frame budget healthy
② bind       σ = { project: current, focus: timeline, intent: vibe-ask("dramatic"),
                   episode: continues previous (τ gap < boundary threshold) }
             C consulted for RELEVANCE only — no refusal applies
③ believe    B unchanged (no new evidence yet; a vibe-ask asserts nothing)
④ expect     V: this is a T2 error class (intent fidelity), not T4 (novelty)
             → two hypotheses, deliberate prior near-tie:
               P₁ "grade the picture will satisfy"   conf 0.5  owner: B[mood-recipe/dramatic]
               P₂ "restyle the titles will satisfy"  conf 0.5  owner: B[mood-recipe/dramatic]
             information gain per cost → buy the CHEAP discriminating fact only
             (this is the shipped economic-clarify rule, unchanged)
⑤ act        α = closeBlueprint(color ⊕ motion ⊕ text) → Timeline Action Registry
             — or ⊥ (clarify) if entropy stays high and the next fact is expensive.
             ⊥ is a legitimate output, not a failure. C could have vetoed here.
⑥ compare    outcome: user tweaked intensity −20, kept the look
             ε = { class: intent-fidelity, tier: T2, magnitude: 0.3,
                   direction: "over-applied", uncertainty_kind: expected }
⑦ attribute  P₁.owner → B[mood-recipe/dramatic].intensity   (blame: 0.8)
                       → B[user/tolerance-for-strong-grades] (blame: 0.2)
⑧ adapt      λ(mood-recipe) = 0.3 → small update, band B4
             λ(user-tolerance) = 0.6 → larger update, band B3
             NEITHER may write B5. (L7)

… τ advances; more episodes accumulate …

consolidate  after 40 episodes: pattern "user reduces dramatic intensity by 15–25%
             on client work, not on personal work"  → new B[subject=user], band B4,
             cited to 40 episodes, evidence_against: 6
simulate     Δ = self: "if I default dramatic to 0.8 intensity on client projects,
             what happens?" → replay held-out history → 31/37 fewer corrections
promote      → C only after months, with rehearsal Ω, ceremonially, with a threshold
```

Three things this trace establishes:

1. **The calculus is descriptive, not aspirational.** Phases ①②④⑤ are shipped today, in
   `hypothesis-route.ts` and the staged planner. The *missing* phases are exactly ⑥⑦⑧ and
   the off-loop operators — which is precisely the O1/O2 build order (Experience Stream,
   Prediction Ledger) arrived at independently in ORIS_ARCHITECTURE.md §19. Two derivations
   converging on the same first step is mild evidence the decomposition is real.
2. **The existing staged planner is the loop's phase ④.** It does not need to be rebuilt; it
   needs to be *located*. Its seven registered stages sit inside `expect`.
3. **The economic clarify rule is `act → ⊥`.** Making "wait" a first-class operator output
   rather than an error path is not new behaviour — it is naming behaviour that already
   ships correctly.

---

## 7. What we expect to be wrong

Named in advance, so revision is a result rather than a retreat. Ranked by our confidence
that it will need to change.

1. **The error taxonomy in `V` (high confidence it is wrong).** Four or five error classes
   invented at a desk will not survive contact with real usage. Epoch 0 must derive the
   taxonomy from observed correction types, not the reverse.
2. **Band boundaries (high).** B2/B3/B4 are drawn by intuition. The real boundaries are
   wherever consolidation statistics show natural separation — an empirical question.
3. **Episode segmentation (high).** `bind`'s "episode continues" test is currently
   hand-waved. Human event segmentation is not solved, and naive per-command or per-session
   boundaries are almost certainly wrong. ([`ORIS_TIME.md`](ORIS_TIME.md) §3.)
4. **Whether `C` deserves to be separate from `B` (medium).** It is currently a subset
   distinguished by `λ ≈ 0` plus a refusal field. That may collapse into `B` entirely, which
   would be a welcome simplification — or the refusal semantics may prove to need their own
   operator, which would be a genuine finding.
5. **Whether `attribute` is tractable (medium).** Credit assignment is the hard problem in
   every learning system. It may be that only coarse attribution ("the user model, not the
   world model") is achievable, in which case L3 needs a granularity qualifier.
6. **Whether `Θ` earns its place (medium-low).** Four global scalars may turn out to be
   under-determined by available signal, collapsing to one (learning rate) or none.
7. **The claim that seven owned variables suffice (low confidence that it breaks, but this
   is the load-bearing one).** If an eighth is genuinely needed, the reduction in §1.2 is
   weaker than claimed and the whole document needs re-derivation.
   **Two near-misses are on record, both from review rather than from data**, which is worth
   noting because it means the pressure is real: *episode continuity* (resolved by relocating
   to `E`, §1.4) and *task framing* (resolved by `C` spanning bands, §1.5). Neither required
   a new variable; both required the schema to say something it had not said. A third
   near-miss that does **not** resolve should be treated as the claim failing, not as another
   clever accommodation — the failure mode of a reduction this tidy is defending the number
   past the point where it is earning anything.

**The falsification schedule:** Epoch 0 (instrumented, non-adaptive) produces the data for
1–3 within months. Nothing in 4–7 can be settled without Epoch 1 calibration data, and
attempting to settle them earlier by argument is the exact Cyc failure this section exists
to prevent.

---

## 8. Open formal questions

1. **Is `bind` a function or a fixpoint?** Situations are partly self-determining — what you
   attend to changes what the situation *is*. Written as a function here; may need to be an
   iteration to convergence, which would change the cycle's cost model materially.
2. **Confidence algebra under derivation.** The habitat already specifies weakest-link
   propagation for derived facts. Does the same rule hold for beliefs derived from beliefs
   across many hops, or does it collapse everything to near-zero confidence at depth?
3. **Is `simulate` sound over self-perturbations?** World simulation is exact (deterministic
   renderer). Self simulation replays held-out history against a *counterfactual self* — but
   the user's responses in that history were conditioned on the *actual* self. This is
   off-policy evaluation, and it has known bias. Unresolved, and it directly limits ORIS-15.
4. **Multi-subject identity.** If one installation serves several users, is `C[subject=self]`
   shared or partitioned? Partitioned identity is arguably not identity; shared identity
   across contradictory clients is arguably incoherent. Interacts hard with ORIS-7.
5. **Does `τ` need to be per-band?** Subjective time may run at different rates for different
   timescales — plausible, and it would complicate every decay computation.
