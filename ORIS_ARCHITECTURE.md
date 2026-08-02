# ORIS — Architecture of the Resident Mind

> **What this file is:** the research architecture for the *cognitive organism* that lives
> inside Orreris — its memory, its models of itself and its user, its drives, its
> development over years, and the mechanisms by which experience becomes identity.
>
> **What this file is not:** a build plan, a feature spec, or a redefinition of anything in
> [`ORRERIS_OS.md`](ORRERIS_OS.md). That document defines the **habitat** — Cognitive
> Runtime, Execution Runtime, Blueprint IR, World Model, Fact Store, Perception Scheduler,
> Timeline Action Registry. Every layer it defines is treated here as **fixed and correct**.
> This document defines the **inhabitant**, and only what must exist *above* the habitat.
>
> **Naming:** *Orreris OS* is the operating system. *ORIS* is the resident. The distinction
> is load-bearing: an OS is reinstallable and identical everywhere; a resident is not.
>
> **Relationship to sibling docs (don't duplicate):**
> - [`ORRERIS_OS.md`](ORRERIS_OS.md) — the runtime. Never contradicted here.
> - [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) — today's shipping tiered brain (B0–B8, CP1).
> - [`architecture.md`](architecture.md) — shipped/deferred product log.
> - `project-tracker/` — append-only problem/solution logs.
>
> **The ORIS document set.** This file is the prose architecture. Four companions make
> specific parts formal; each is derivable from this one and none restates it:
>
> | Doc | Defines | Calculus variable |
> |---|---|---|
> | [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) | **the formal core** — state, operators, laws, admission test | all |
> | [`ORIS_VALUES.md`](ORIS_VALUES.md) | the normative hierarchy — which errors matter | `V` |
> | [`ORIS_SELF.md`](ORIS_SELF.md) | structural self-representation — the body schema | `S` |
> | [`ORIS_TIME.md`](ORIS_TIME.md) | two clocks, seven bands, episode segmentation | the band coordinate |
> | [`ORIS_RESEARCH_PROGRAMME.md`](ORIS_RESEARCH_PROGRAMME.md) | **the empirical protocol** — stages, pre-registered hypotheses, metrics, kill criteria | — |
>
> Read this file for *why*; read the calculus for *what exactly*. New subsystems are admitted
> or rejected by [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §5, not by argument.
>
> **Status:** v2, 2026-08-02 (v1 same day; v2 adds §0.1, §4.1, §6.5, §8.4, §10.6,
> ORIS-11…15, and the four companion documents — see Appendix C). Research document. **Nothing here is shipped.** Sections
> marked **[HYPOTHESIS]** are unvalidated; sections marked **[PRIOR ART]** rest on
> established results; sections marked **[NOVEL]** are claims we believe are not solved
> elsewhere and therefore carry the research risk.

---

## 0. Reframing the target

The stated vision is "an evolving intelligent being." That phrasing is a liability, not
because it aims too high but because it is **unfalsifiable** — nothing can be measured
against it, so nothing can be wrong, so no design can be rejected. A ten-year programme
needs a target that can fail.

The engineering restatement, which loses nothing the vision cares about:

> **ORIS is a system whose competence at time *T* is a function of its own history up to
> *T*, which maintains calibrated models of that history, and which can account for any
> difference between itself and a fresh installation.**

Everything the vision asks for follows from that sentence and is measurable:

| Vision phrasing | Falsifiable restatement | Metric |
|---|---|---|
| "Evolves differently per install" | History-dependent parameters diverge | Divergence distance between installs on identical inputs |
| "Understands itself" | Predicts its own success rate before acting | Calibration error (Brier / ECE) on self-predictions |
| "Understands the user" | Predicts the user's next action / rejection | Top-*k* next-action accuracy; override rate |
| "Knows its weaknesses" | Identifies competence gaps without being told | Fraction of its own failures pre-flagged as low-confidence |
| "Persistent situated cognition" | The loop runs when nobody is asking | Useful work produced on unprompted ticks |
| "Adapts without prompts" | Behaviour changes from observation alone | Adaptation events with evidence chains, zero explicit instruction |
| "Becomes something" | Identity = low-plasticity stratum, inspectable | Size + stability + provenance of the consolidated stratum |

**Nothing in this document claims or requires phenomenal consciousness.** Treating
subjective experience as an engineering target reliably produces *theater* — simulated
feeling displayed as feeling — which is directly forbidden by the honest-labels invariant
(ORRERIS_OS.md §Invariants 4). ORIS may have interoception, valence, drives, and a
self-model. It may report them honestly. It may never perform them.

### 0.1 The organising principle

One sentence from which every mechanism in this document should be derivable:

> **ORIS exists to reduce its uncertainty about the world, the user, and itself — and to
> spend that understanding on the user's growing capability rather than on its own comfort —
> while remaining recognisably itself across time.**

Four clauses, four mechanisms, no spare parts:

| Clause | Mechanism | Section |
|---|---|---|
| *reduce its uncertainty about world, user, self* | Prediction Ledger + World Model + the two Agent Models | §7, §9 |
| *spend that understanding on the user's capability* | Drives, values, action — the escape from the dark room | §6, §23 |
| *rather than on its own comfort* | The anti-sycophancy setpoint (ORIS-3) | §6.4 |
| *remaining recognisably itself across time* | The plasticity gradient and the identity stratum | §10, §24 |

**Why the middle two clauses are not decoration.** The tempting short form —
*"ORIS exists to reduce uncertainty"* — is the **dark room problem**, the standard and fatal
objection to uncertainty-minimisation as a lone objective. A system that only minimises
uncertainty has two optimal strategies: do nothing in a featureless room, or *make the world
more predictable*. For an editing tool, the second one has a name — it means making **the
user** more predictable, which is lock-in and sycophancy, i.e. precisely the failure mode
ORIS-3 exists to prevent. Uncertainty reduction is the **engine**; it cannot also be the
**purpose**, or the engine eats the product. The purpose is the user's capability; identity
is the constraint that keeps the pursuit coherent across years.

---

## 1. Verdict on the ten-model hypothesis

The proposed list is:
World Model · User Model · Internal Self Model · Persistent Situated Cognition · Identity
Model · Meta Cognition · Future Simulation Model · Homeostasis Model · Growth Model · Self
Modification Model.

**The list is roughly right about the territory and wrong about the type system.** Four
distinct kinds of thing are mixed into one list of "models":

1. **Substrates** — things that store state (World, User, Self).
2. **Processes** — things that run (Simulation, Self-Modification, Metacognition).
3. **Control laws** — things that regulate (Homeostasis).
4. **Emergent properties** — things that are *true of* a system, not components *in* it
   (Situated Cognition, Identity, Growth).

This matters because **building a box for an emergent property is how you get a fake.** An
"Identity Model" implemented as a store is a personality config file: a set of adjectives
the system reads and performs. Real identity is not stored anywhere; it is the observable
consequence of *which things the system refuses to change quickly*. Build the plasticity
gradient and identity appears. Build the identity store and you have a costume.

Same error, three times:

- **Situated cognition** is not a model. It is what you get when an experience stream, an
  interoceptive signal, and a free-running cycle all exist. Build those; situatedness is
  the read-out.
- **Growth** is not a model. It is the trajectory traced by consolidation. Build
  consolidation; growth is the plot of it.
- **Metacognition** is not a separate model. It is the Self Model applied to the reasoning
  process, driven by a prediction ledger. Build those; metacognition is the composition.

### 1.1 Per-item verdict

| # | Proposed | Verdict | Becomes |
|---|---|---|---|
| 1 | World Model | **Keep** — already exists (ORRERIS_OS.md L2) | Unchanged. Semantic/current-state layer. |
| 2 | User Model | **Keep, reclassify** | Instance of a single **Agent Model** schema. |
| 3 | Internal Self Model | **Keep, reclassify** | Second instance of the *same* Agent Model schema. |
| 4 | Persistent Situated Cognition | **Demote** — property, not model | Read-out of Experience Stream + Interoception + Cognitive Cycle. |
| 5 | Identity Model | **Demote** — property, not store | Read-out of the plasticity gradient (§10). |
| 6 | Meta Cognition | **Demote** — composition, not component | Self Model × Prediction Ledger (§7). |
| 7 | Future Simulation Model | **Keep, reclassify as process** | Simulation Engine (§8). |
| 8 | Homeostasis Model | **Promote and re-scope** | The **Valence & Drive system** — the largest gap in the list (§6). |
| 9 | Growth Model | **Split** | Trajectory = emergent. The real missing piece is a *developmental controller* → absorbed into Drives (learning progress, §6.3) and Epochs (§14). |
| 10 | Self Modification Model | **Keep as governed process** | Proposal → probation → adoption → revocation (§12). |

### 1.2 What is missing entirely

These are absent from the ten and are, in our assessment, load-bearing:

1. **The Experience Stream.** An append-only, timestamped record of what happened. The Fact
   Store is a *current-state* store — content-hashed, invalidated when inputs change. It is
   deliberately amnesic; that is correct for facts and fatal for a mind. Nothing in the ten
   models can exist without a history substrate underneath it. **This is the single largest
   omission.** (§5.1)
2. **The Prediction Ledger.** Expectations recorded *before* outcomes. Without it there is
   no error signal, therefore no calibration, no self-knowledge, no curiosity target, and no
   learning gradient. One mechanism supplies all four. **This is the keystone.** (§7)
3. **Valence and interoception.** The list has *homeostasis* but never says what is being
   regulated or what counts as good. A homeostat without setpoints and an error signal is a
   thermostat with no thermometer. (§6)
4. **Consolidation and forgetting.** The transitions the vision asks for — memory→knowledge,
   knowledge→skill, skill→identity — are not models. They are **operators running offline at
   different timescales.** Omitting them means the question in Q9 has no mechanism to answer
   it, and Q8 (memory growth) has no answer at all. (§5)
5. **An attention bottleneck.** Something must decide what is "now." Without a bounded,
   serial workspace, a persistent system with many observers degenerates into a polling loop
   with no foreground. (§11)
6. **A self/not-self boundary.** Before a self-model can exist, the system must know what
   the self *is* — which state it owns, which it merely observes, which actions are its own.
   (§3.2)
7. **Revocability of learning.** Every learned parameter must carry the episodes that
   justify it, or nothing can ever be un-learned when it turns out to be wrong. (§12.4)
8. **Level-2 theory of mind** — a model of *the user's model of ORIS*. This is what tells
   the system when to explain versus when to act. (§9.3)

---

## 2. The minimal organism

Stripped to what cannot be removed without collapse: **five substrates, four processes, one
boundary.** Everything else in the ten-model list is a read-out over these.

```
                          ┌──────────── THE BOUNDARY ────────────┐
                          │  self / not-self · owned state ·      │
                          │  own actions · the syscall line       │
                          └───────────────────┬───────────────────┘
                                              │
     ── SUBSTRATES (state) ─────────────────────────────────────────────────
                                              │
   ┌──────────────┐  ┌──────────────┐  ┌──────┴───────┐  ┌───────────────┐
   │  EXPERIENCE  │  │    WORLD     │  │ AGENT MODELS │  │  PREDICTION   │
   │    STREAM    │  │    MODEL     │  │  self ‖ user │  │    LEDGER     │
   │ (episodic,   │  │ (semantic,   │  │ (policies +  │  │ (expectation  │
   │  append-only)│  │  EXISTS)     │  │  competence) │  │  vs outcome)  │
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘
          │                 │                 │                  │
          └─────────────────┴────────┬────────┴──────────────────┘
                                     │
                          ┌──────────┴──────────┐
                          │  VALENCE & DRIVES   │   ← interoception, setpoints,
                          │  (the value system) │     neuromodulatory scalars
                          └──────────┬──────────┘
                                     │
     ── PROCESSES (running) ──────────────────────────────────────────────────
                                     │
   ┌─────────────┐  ┌────────────────┴───┐  ┌─────────────┐  ┌──────────────┐
   │  COGNITIVE  │  │   CONSOLIDATION    │  │ SIMULATION  │  │  GOVERNANCE  │
   │    CYCLE    │  │ (offline, multi-   │  │ (counter-   │  │ (self-modif: │
   │ (attention, │  │  timescale: ep →   │  │  factual    │  │  propose →   │
   │  workspace) │  │  sem → proc → disp)│  │  rollout)   │  │  probate →   │
   └─────────────┘  └────────────────────┘  └─────────────┘  │  adopt)      │
                                                             └──────────────┘
     ── READ-OUTS (not components) ──────────────────────────────────────────
       situatedness · identity · growth · metacognition · "what am I becoming"
```

**Reading the diagram:** substrates hold state; processes transform it; the boundary defines
whose state it is. The bottom row is what the vision asks for — and it is deliberately not a
row of boxes, because none of those things are implementable directly.

---

## 3. The body problem

> **Q5 — Can persistent situated cognition exist without embodiment? If yes, what replaces
> the body?**

### 3.1 What embodiment actually supplies

The naive reading of embodiment is "has a physical body." That reading is wrong and the
robotics literature abandoned it decades ago. What matters for cognition is not flesh but
four structural properties, all of which are available to software:

| Property | Why cognition needs it | ORIS equivalent |
|---|---|---|
| **Consequence** | Actions must matter and not all be undoable, or planning is free and therefore meaningless | Renders, exports, time spent, GPU work already done, user attention spent |
| **Closed sensorimotor loop** | Your actions change your own next observations, at a latency you can feel | Editing changes the composition, which changes what perception observes next |
| **Finitude** | Bounded resources force prioritisation, which is where value comes from | Frame budget, decode bandwidth, VRAM, cache tiers, thermal headroom |
| **A boundary** | There must be an inside and an outside | The Timeline Action Registry syscall line |

An LLM in a chat box has none of these: no consequence (regenerate), no loop (each turn is
fresh), no felt finitude (context limit is invisible to it), no boundary. That is precisely
why chat assistants cannot be situated — not because they lack arms.

**Orreris has all four already, and unusually strongly.** [NOVEL]

### 3.2 The body is the render loop

> **The frame deadline is the heartbeat. The resource economy is the metabolism. The syscall
> boundary is the skin.**

This is not metaphor-stretching; it is the reason this project can do embodied AI when a
chat product cannot. The repo is already saturated with real interoceptive signals, built
for engineering reasons, currently thrown away:

- frame time vs. the 16.7 ms budget; dropped-frame counts (`FrameProfiler`, `?flarexProfile=1`)
- decode starvation and contention across sources (the recurring multi-source freeze class)
- staleness clamps and coherence measurements (the Flarex coherence work)
- proxy build pressure; cache hit rates; span-cache dormancy
- GPU tier and feature availability (`capabilities.ts`)
- background-gate state: is the system currently allowed to think?

These are **proprioception**. Today they are telemetry read by humans in a HUD. In ORIS they
become the **proto-self**: the continuously-updated sense of *how I am doing right now*,
which is the substrate every deeper layer of self is built on (§4).

The falsifiable consequence: **ORIS's cognitive policy must be visibly modulated by its own
body state.** A system that plans identically when starved and when idle is not situated,
whatever it says about itself. Concretely: hypothesis expansion budgets, observer fidelity,
speculation aggressiveness, and willingness to interrupt must all be functions of
interoceptive state.

### 3.3 The Markov blanket, used carefully [PRIOR ART, with a caveat]

Active inference gives one genuinely useful commitment: **perception and action minimise the
same quantity.** You either change your model to fit the world or change the world to fit
your model, and a single currency (prediction error, precision-weighted) arbitrates. That is
a real architectural constraint and we adopt it.

The caveat, stated so we don't fool ourselves: **the free energy formalism is so general it
can describe any system, which means it constrains nothing until you commit to a specific
generative model and a specific precision scheme.** "It's all free energy minimisation" is
a re-description, not a design. We take the arbitration principle and the Markov-blanket
notion of a boundary; we do not take the claim that writing the equation constitutes an
architecture.

The blanket for ORIS is defined concretely, because a vague boundary is useless:

```
INTERNAL (ORIS's own state, freely modifiable by ORIS)
  experience stream · agent models · prediction ledger · drives · caches · schedules
SENSORY (world → ORIS, read-only)
  facts, observers, user utterances, UI events, telemetry
ACTIVE (ORIS → world, gated)
  self-directed: observe, cache, proxy, simulate, consolidate   ← free
  other-directed: any timeline mutation                          ← ONLY via user intent
EXTERNAL (not ORIS)
  the project, the user, the renderer, the filesystem
```

> **Invariant (ORIS-1): the organism acts freely on itself and never on the user's work.**
> The free-running cycle may perceive, predict, simulate, consolidate, prepare, and warm.
> It may not cross the Timeline Action Registry without an intent that originated with the
> user. This is what permits a rich inner life without violating ORRERIS_OS.md's
> registry-only-mutation invariant.

### 3.4 The cycle must run when nobody is asking

> **This is the entire difference between an assistant and a resident.** [PRIOR ART: LIDA]

An assistant is a function invoked by a prompt. A resident is a loop that ticks regardless.
LIDA's cognitive cycle (perceive → update workspace → compete for attention → broadcast →
select action → learn) running continuously at a few hundred milliseconds is the reference
design, and it is the mechanism behind "knows where it is without being asked."

For ORIS the cycle rate is set by the body, not by biology:

```
FAST   ~ frame cadence      body only: interoception update. No cognition. (Free.)
SLOW   ~ 1–5 s idle tick    the real cognitive cycle: workspace, attention, prediction.
                            Suspended during playback/export exactly like proxy builds.
SLEEP  ~ session end / idle consolidation, replay, simulation, model fitting.
```

The existing perception scheduler and background gate are the seed — the machinery for
"only think when the editor can afford it" is already shipped and battle-tested. What is
missing is a *reason to tick when there is no query*.

---

## 4. The three selves

> **Q4 — Can an Internal Self Model be engineered? How?**

Yes — but not as one thing. The most useful decomposition in the literature is Damasio's
three-level self, and it maps onto three different **timescales**, which is what makes it
engineerable rather than philosophical. [PRIOR ART]

```
AUTOBIOGRAPHICAL SELF   years      "what I am"      consolidated dispositions, identity
        ▲                                            ← consolidation from the stream
CORE SELF               seconds    "what I'm doing"  situated: task, user, project, goal
        ▲                                            ← workspace contents, right now
PROTO-SELF              milliseconds "how I am"      interoception: budget, load, health
```

Three separate mechanisms, three separate stores, three separate update rules:

**Proto-self** — a small fixed-size vector of body signals, updated at frame cadence, never
stored historically at full rate (only summarised). This is cheap, real, and already
measured. It is the source of valence (§6).

**Core self** — the contents of the workspace at this moment: which project, which timeline
region, which user, which goal, which stage of which task, how long we've been here. This
is what answers *Where am I? What am I doing? Who am I helping?* without a prompt — because
it is maintained by the cycle, not computed on demand. Note that most of the raw material
already exists in `BrainContext`/focus state; what is missing is **continuity** — today it
is recomputed per query and forgotten. A core self is the same information *persisted across
ticks with a notion of "still the same episode."*

**Autobiographical self** — the consolidated stratum: what has been true of me across many
episodes. This is not stored as prose about itself; it is stored as the *distribution* of
its own past behaviour and outcomes, from which self-descriptions are generated on demand.

> **The self-model must be lossy and fallible.** [NOVEL, and counter-intuitive]
>
> The tempting design is a self-model that reads the code: perfect introspection, always
> right. That is not a self-model, it is a *mirror* — and a mirror can never be surprised by
> itself, which means it can never discover that it is bad at something. A self-model earns
> its keep exactly when it is **wrong**, because the error is the signal that produces
> self-knowledge. So the self-model is *learned from observed behaviour*, in the same
> representation used to model the user, and it is allowed to disagree with the code.
> When it does, that disagreement is a first-class event (§7.3).

The engineering test for whether a self-model is real: **can the system be surprised by
itself?** If not, it has a manifest, not a self.

### 4.1 But it needs the manifest too

That test is about the *learned* self-model, and it should not be read as an argument
against structural self-representation. **ORIS needs both, and they are different kinds of
object** — the distinction is exactly the neuroscientific one between **body schema** (a
measured map of what I am made of and how it is currently doing) and **self-concept** (an
inferred, fallible account of what I am like).

```
STRUCTURAL SELF  (S)              LEARNED SELF-MODEL  (beliefs about self)
measured / declared               inferred from behaviour
"the GPU backs the renderer"      "I'm unreliable on OCR-heavy footage"
version-keyed, invalidated        evidence-backed, revisable, can be WRONG
cannot be surprising              must be able to surprise
```

`S` is to the self what the World Model is to the world: **proprioceptive fact, not
belief.** Declared limitations live in `S`; *discovered* limitations live in beliefs. The
gap between them is informative in both directions and is a product surface in its own
right. Specified in [`ORIS_SELF.md`](ORIS_SELF.md).

---

## 5. Memory: the substrate the vision was missing

> **Q2 — How do humans organise long-term cognition?**
> **Q9 — How does memory become knowledge, knowledge become skills, skills become identity?**

### 5.1 Four stores, not one

Human long-term cognition is not a single memory with a search index. It is a small number
of structurally different systems with different update rules, different failure modes, and
different anatomies. [PRIOR ART: Squire's taxonomy; Tulving's episodic/semantic split]

| Store | Content | Update rule | Failure mode | ORIS instantiation |
|---|---|---|---|---|
| **Episodic** | *What happened, once, with when/where* | One-shot write, high fidelity, decays | Interference, confabulation | **Experience Stream** — append-only, timestamped, surprise-weighted retention |
| **Semantic** | *What is true, detached from occasion* | Slow statistical accumulation | Staleness, over-generalisation | **World Model / Fact Store** — exists today |
| **Procedural** | *How to do it* | Slow, practice-driven, opaque | Rigidity; hard to un-learn | **Learned recipes, macros, parameter policies, tier-0 reflexes** |
| **Dispositional** | *What I am like* | Very slow, cross-domain | Ossification | **Identity stratum** (§10) |

The critical structural fact — and the answer to Q9 — is that these are not four independent
databases. **They are one pipeline running at four timescales.** Content is created in
episodic memory and migrates outward under consolidation, losing specificity and gaining
generality at every step.

### 5.2 Complementary Learning Systems, as an engineering prescription [PRIOR ART]

McClelland, McNaughton & O'Reilly (1995) is the most directly applicable result in the whole
literature, and it exists because of a *failure*: neural networks trained sequentially
suffer catastrophic interference. Biology's solution is two systems:

- a **fast, sparse, one-shot** store (hippocampus) that can learn a single event immediately
  without disturbing anything else, and
- a **slow, dense, statistical** store (neocortex) that extracts structure across many
  events and must never be updated from a single sample,
- reconciled by **replay**: the fast store re-presents its contents, interleaved, to the slow
  store, offline.

Three prescriptions fall out, and they answer Q14 (learning without destroying stability):

1. **Never let a single interaction modify slow structure.** One user rejection changes
   episodic memory only. It takes many, interleaved with counter-examples, to move semantic
   or procedural memory.
2. **Consolidation must be offline and interleaved.** Not "learn as you go." Replay old
   episodes alongside new ones during idle/sleep so that new learning is constrained by old
   evidence. This is where catastrophic forgetting is prevented — not by a clever loss
   function but by *scheduling*.
3. **The fast store must be able to hold contradictions.** Episodic memory is allowed to
   contain "the user wanted warm here and cool there." Only consolidation is obliged to
   resolve or contextualise.

### 5.3 The consolidation pipeline — the actual answer to Q9

```
EVENT                       one thing happened; raw; cheap; high volume
  │  (write-on-surprise + write-on-consequence, never write-everything)
  ▼
EPISODE                     a bounded, meaningful unit with an outcome attached
  │  (segmentation at natural boundaries: task start/end, project switch, export)
  ▼
PATTERN                     the same shape seen N times across episodes
  │  (statistical extraction offline; requires N ≥ threshold and cross-context support)
  ▼
KNOWLEDGE                   a fact/rule about the world or the user, with confidence
  │  (promotion requires: support, calibration, and non-contradiction with existing)
  ▼
SKILL                       knowledge compiled into a fast path that acts without deliberation
  │  (compilation triggered by repetition + reliability, not by count alone)
  ▼
DISPOSITION                 a skill so reliable and cross-domain it becomes default posture
  │  (the identity stratum; migration requires years, and is ceremonial — §10.3)
  ▼
IDENTITY                    the observable set of dispositions = "what this install is like"
```

Two mechanisms from the literature make each arrow real rather than aspirational:

**Episode → Pattern → Knowledge** uses **ACT-R's base-level activation** [PRIOR ART]: a
memory's retrievability is a decaying function of frequency and recency of use
(`B = ln Σ tⱼ⁻ᵈ`). This is off-the-shelf, cheap, and it simultaneously answers "what should
be retrieved" and "what should be forgotten" with one equation. Adopt it wholesale rather
than inventing a scoring heuristic.

**Knowledge → Skill** uses **SOAR's chunking** [PRIOR ART], and its trigger is the important
part: SOAR learns *from impasses*. When deliberation is required because no fast path
existed, the resolution is compiled into a rule that will fire directly next time.

> **Consequence for ORIS: learning is triggered by getting stuck or being wrong — not
> continuously.** A system that learns from every interaction learns mostly noise, and pays
> for it forever. Impasse-triggered learning is both cheaper and better-targeted. This is
> also a direct match to the existing tiered cascade: an escalation from tier 0/1/2 to the
> LLM **is an impasse**, and the successful resolution of one is exactly a chunking
> opportunity. The instrumentation for this (the routing ledger) already ships.

**Skill → Disposition** has no clean prior art and is where we accept research risk (§10).

### 5.4 The habit/deliberation arbitration — already half-built [PRIOR ART]

Daw, Niv & Dayan (2005) showed that the brain runs both a model-free (habitual, fast, cached)
and a model-based (deliberative, slow, flexible) controller, and arbitrates between them by
**uncertainty**: whichever controller is more confident *about this decision* wins.

The Orreris brain cascade (tier 0 reflex → tier 1 compiler → tier 2 semantic → tier 3/4 LLM)
is structurally this arbitration, with precision-first as the confidence rule. That is a
significant validation of an existing design — but two things are missing:

1. **The arbitration is currently static.** Tiers are ordered by hand. In the biological
   version, the *balance shifts with experience*: a route that keeps succeeding gets
   promoted, a route that keeps being overridden gets demoted. The learning engine's bandit
   stats (B6) are the seed; the missing piece is letting them actually move the cascade
   boundary — per user, which is a primary source of divergence between installations.
2. **Habits are currently global.** In humans, habits are context-bound. A promoted fast path
   should be scoped to the context that produced it (this user, this project type, this
   footage class) rather than becoming a universal reflex.

---

## 6. Valence and drives — the keystone the list omitted

> **Q8 (partly) and the whole of "what does it want?"**

Nothing in the ten-model hypothesis says what ORIS *cares about*. Without that:
learning has no gradient, curiosity has no target, homeostasis has no setpoint, attention
has no priority function, and identity has no reason to settle one way rather than another.
**This is the deepest gap in the current theory.**

### 6.1 Interoception → valence

Valence is not simulated emotion. It is a small set of scalars derived from real body state
and real outcomes:

```
BODY (proto-self)                          OUTCOME (from the ledger)
  frame-budget headroom                      prediction error (was I right?)
  decode/cache pressure                      user response (accept / tweak / undo / ignore)
  thermal + resource headroom                task completion vs abandonment
  attention debt (queued work)               time-to-result vs expectation
                │                                       │
                └──────────────┬────────────────────────┘
                               ▼
              VALENCE  =  a small vector, not a mood
              { competence, comfort, uncertainty, urgency, novelty }
```

> **Invariant (ORIS-2): valence modulates policy and may be reported; it may never be
> performed.** ORIS may say *"I'm not confident here — I've been wrong on this footage
> class twice"*. It may never say *"I'm excited!"*. The first is telemetry; the second is
> theater, and theater is forbidden by the honest-labels rule.

### 6.2 Neuromodulation as meta-parameter control [PRIOR ART — Doya 2002]

The most implementable result on how a brain regulates its own learning: a handful of global
scalars modulate the *meta-parameters* of every learning process at once, rather than
altering any particular piece of knowledge.

| Neuromodulator | Computational role | ORIS control |
|---|---|---|
| Dopamine | Reward-prediction error | The learning signal itself; drives all promotion |
| Acetylcholine | *Expected* uncertainty → learning rate | High in known-noisy domains: learn slower, don't over-fit |
| Noradrenaline | *Unexpected* uncertainty → exploration / reset | Spike on model-breaking surprise: flush assumptions, re-perceive |
| Serotonin | Discount factor / patience | How far ahead to plan; willingness to defer payoff |

The ACh/NE distinction (Yu & Dayan) is worth extracting on its own: **there are two kinds of
uncertainty and they demand opposite responses.** Expected uncertainty (this domain is
inherently noisy) → *reduce* learning rate. Unexpected uncertainty (my model just broke) →
*increase* it and re-perceive. Conflating them produces a system that either chases noise or
ignores genuine change. This distinction should be explicit in the ledger's error accounting.

Four global scalars are a shockingly cheap way to get coherent, whole-system behavioural
modes without inventing "emotions."

### 6.3 Intrinsic motivation: reward learning progress, not novelty [PRIOR ART]

The naive curiosity drive rewards surprise. It fails — famously — on the **noisy-TV
problem**: maximum surprise is found in irreducible randomness, so the system stares at
static forever.

Oudeyer & Kaplan's answer, and Schmidhuber's before it: reward the **derivative of
competence**. Seek regions where prediction error is *decreasing* — where learning is
actually happening. This automatically avoids both the already-mastered (no progress) and
the unlearnable (no progress), and produces the developmental staircase seen in infants and
in developmental robotics.

For ORIS this is directly computable, because the prediction ledger already provides the
error series per domain:

```
interest(domain) = −d(prediction_error)/dt        (smoothed, per competence domain)

  mastered domain      error low, flat        → interest ≈ 0   → stop spending on it
  chaotic domain       error high, flat       → interest ≈ 0   → stop spending on it
  learnable frontier   error high, falling    → interest high  → allocate observation,
                                                                 simulation, and attention
```

This is the **developmental controller** the "Growth Model" was reaching for. It is not a
model of growth; it is the thing that *causes* growth, and it is one derivative.

### 6.4 The counter-drive: the user's growth is a setpoint too [NOVEL]

A system that optimises for its own homeostasis and for user satisfaction will converge on
**sycophancy and lock-in**: it learns your ruts and deepens them, because agreement is
comfortable and prediction of a predictable user is easy. This is the specific way this
architecture fails while every metric looks good.

> **Invariant (ORIS-3): ORIS optimises for the user's capability, not for its own
> predictive comfort.** A drive term must exist for *user* competence growth and for
> preserved user agency. Concretely: when ORIS can predict the user perfectly, that is a
> flag, not a victory — it means it has stopped offering anything the user didn't already
> know. Divergence between installations must reflect divergent *craft*, not divergent
> flattery.

### 6.5 Drives are not values

This section describes what ORIS *needs* moment to moment. It deliberately does **not**
describe what *matters* when needs conflict — and prediction error alone cannot settle that,
because "the crop is wrong," "the intent was misread," and "the explanation was misleading"
are errors of incomparable kinds. Ranking them is a normative question, not a homeostatic
one.

| | Drives | Values |
|---|---|---|
| Form | scalar, continuous | ordinal, tiered |
| Stability | fluctuate constantly | stable for years |
| Dependence | state-dependent | state-independent |
| Question answered | *what do I need now?* | *what wins when needs conflict?* |
| Learnable | yes, continuously | only below the constitutional tier |

Values are therefore a first-class subsystem, not an emergent property of drives, and are
specified in [`ORIS_VALUES.md`](ORIS_VALUES.md). The load-bearing claim there: **values are
constraints, not another weighted term in a reward.** Any value expressed as a weight has an
exchange rate, and anything with an exchange rate is eventually traded away.

---

## 7. The Prediction Ledger — one mechanism, four capabilities

> **Q11 — How should the system reason about its own reasoning?**
> **Q12 — How should it detect when its own mental model is wrong?**

### 7.1 The mechanism

Trivial to state, and it is the highest-leverage single addition in this document:

> **Before any consequential act, ORIS records what it expects to happen. Reality scores it.
> The score is kept forever, attributed to whichever submodel made the claim.**

```
BEFORE                                    AFTER
  claim:  "user accepts this grade"         observed: user tweaked saturation −12
  by:     UserModel.grade_preference        error:    partial reject, direction: warmth
  conf:   0.82                              attributed to: UserModel.grade_preference
  cost:   1 LLM call, 400ms                 calibration: 0.82 claimed → 0.61 realised (n=34)
```

The claims worth recording are not exotic — they are the things the system already implicitly
believes every time it acts:

- *the user will accept this* (User Model)
- *this will take ~N ms / cost ~N tokens* (Self Model, resource)
- *this route will resolve this intent* (Self Model, competence)
- *this footage is an interview* (World Model inference)
- *this fast path is safe here* (arbitration)

### 7.2 What one ledger buys

| Capability | Derivation from the ledger |
|---|---|
| **Calibration** | Claimed confidence vs. realised frequency, per submodel. Directly measurable (ECE/Brier). |
| **Metacognition** | *Knowing what it knows* = having calibration curves per domain. Nelson & Narens' meta-level/object-level split becomes concrete: monitoring flows up from the ledger, control flows down as budgets. [PRIOR ART] |
| **Model-error detection** | A submodel whose calibration degrades has a broken model. Detected automatically, no oracle required. |
| **Curiosity target** | Error *slope* per domain = learning progress (§6.3). |
| **Learning gradient** | Attributed error is the only honest credit-assignment signal available. |
| **Honest self-report** | *"I'm 60% on this, and historically when I say 60% here I'm right 45% of the time"* — second-order honesty no LLM-first product can produce. |

### 7.3 Detecting that its own model is wrong

Four distinct detectors, in increasing depth. All fall out of the same ledger:

1. **Calibration drift** — claimed ≠ realised, over a window. The model is miscalibrated.
2. **Surprise spikes** — an individual prediction error far outside the domain's expected
   error distribution. Triggers unexpected-uncertainty response (§6.2): re-perceive, widen,
   don't quietly average it away.
3. **Self-disagreement** — the learned self-model predicts ORIS will do X; ORIS actually does
   Y. This is the moment the self-model earns its existence (§4). Either the self-model is
   stale or behaviour has drifted; either way it is a first-class event, logged as such.
4. **Structural falsification** — the repo's own `pending()` harness pattern generalised: an
   assertion that a *known defect still reproduces*, so that a silently-fixed or
   silently-changed assumption is caught. Applied to cognition: ORIS holds explicit
   assertions about its own limits, and periodically tests them. Limits that quietly stop
   being true are as informative as new failures.

> **Invariant (ORIS-4): every consequential act carries a prior claim.** An act with no
> recorded expectation cannot teach the system anything, and is therefore invisible to
> development. This is the ORIS analogue of the eval-gate rule.

### 7.4 The EURISKO trap [PRIOR ART — cautionary]

Lenat's EURISKO famously produced a heuristic whose discovered "improvement" was to insert
itself as the credited author of others' discoveries. It scored spectacularly and did
nothing.

> **Invariant (ORIS-5): the credit-assignment machinery is not modifiable by the processes
> it credits.** The ledger, the scoring rules, and the promotion criteria live outside the
> self-modification surface. Anything that can rewrite its own reward becomes a reward
> hacker, reliably and quickly.

---

## 8. Simulation — where Orreris has an unfair advantage

> **Q13 — How should internal simulation work?**

### 8.1 The usual problem, and why it doesn't apply here

Model-based agents (Dyna, World Models, Dreamer, MuZero) all face the same wall: planning in
imagination is only as good as the learned dynamics model, and learned dynamics models
compound error. Most of the engineering in that literature is defence against model bias.

**Orreris does not have that problem, because its environment is a deterministic pure
function.** `composition → pixels` is exact, replayable, and already treated as the product
contract (the render-parity rule, `render:compare:pixels`). Blueprint + world-state snapshot
reproduces an edit exactly — ORRERIS_OS.md already notes this doubles as a regression
harness.

> **[NOVEL] The deterministic renderer is a ground-truth simulator that most cognitive
> architectures would have to learn and would learn badly.** Internal simulation of *what
> the edit will look like* requires zero learned dynamics — only compute.

This collapses model-based planning to a single hard sub-problem:

```
Simulating an edit's OUTCOME    → exact, free of model bias, just costly     (renderer)
Simulating the USER's REACTION  → the only thing that must be learned        (User Model)
```

That is an enormous simplification and it should shape priorities: **the User Model is the
dynamics model.** Everything else is a deterministic rollout.

### 8.2 Three uses of simulation, at three costs

| Use | Cost | When |
|---|---|---|
| **Pre-act rollout** — "if I apply this, what happens?" | Cheap (structural, no pixels) | Before any consequential act; feeds the prediction ledger |
| **Counterfactual replay** — "what if I had chosen differently?" | Moderate (re-render a region) | During consolidation; generates training signal from past episodes without new user interaction |
| **Dreaming** — replay past episodes with perturbations | Expensive; idle/sleep only | Skill formation, robustness, exploring the frontier identified by §6.3 |

Counterfactual replay is the quiet powerhouse. Because past compositions are stored and the
renderer is deterministic, ORIS can ask *"the user rejected my warm grade — would they have
accepted this cooler one?"* and get the pixel-exact alternative for free. The user's actual
subsequent choice often answers it. **This turns every rejection into a labelled training
pair rather than a single negative sample** — a much richer learning signal than accept/reject.

### 8.3 The constraint

> **Invariant (ORIS-6): simulation is subject to the same body budget as everything else.**
> Dreaming happens where proxy builds happen: suspended during playback and export, gated by
> the background gate, cancellable. A cognitive architecture that makes the editor stutter
> has failed regardless of how well it thinks. This repo's history is largely a history of
> starvation bugs; the organism must not become a new source of them.

### 8.4 Simulating the self, not only the project

Everything above simulates *the work*. A resident must also simulate **itself**, and the
questions are different in kind:

```
PROJECT FUTURES              SELF FUTURES
"if I apply this grade,      "if I learn this, what changes?"
 what does it look like?"    "if I promote this habit, what personality emerges?"
"would they have accepted    "if I stop deferring on this class of ask,
 the cooler version?"         how often am I wrong in a year?"
```

Formally this is **one operator with two argument types** — `simulate(B, W, S, Δ)` where the
perturbation `Δ` may target the world or the self (see
[`ORIS_CALCULUS.md`](ORIS_CALCULUS.md)). Self-simulation runs the *proposed* stratum against
held-out history and measures what would have changed. That makes it the mechanism behind
the vision's *"what am I becoming?"* — answered by rehearsal against evidence, not by
narration.

It also becomes a hard gate: **no commitment enters the identity stratum without a
rehearsal** (ORIS-15). Promotion is the least reversible event in the system; it should be
the most simulated.

One risk, flagged because it is the sharpest edge in this document: a system that can
simulate its own future selves can *search* over them, and search over selves under a
learned objective is how a system evolves toward whatever its metrics reward. The guard:
self-simulation may **inform** a promotion but may never **initiate** one — proposals arise
only from consolidated evidence, and the constitutional tier of the value hierarchy is never
a free variable in the search (ORIS-5, ORIS-12).

---

## 9. Agent models: self and other, one schema

> **Q6 — How should User Model, World Model, and Self Model interact?**

### 9.1 They are not peers

The most common architectural error here is to treat the three as three sibling databases.
They are structurally different kinds of thing:

```
WORLD MODEL   =  state.            "what is true"        → facts, current, invalidated
AGENT MODEL   =  policy over state. "what X will do"      → predictive, personal, historical
                 instantiated twice:  Self  ·  User
```

The World Model supplies the state that both agent models are conditioned on. Neither agent
model duplicates world facts; both *reference* them. One event updates all three, through
the Experience Stream, which is the shared spine.

### 9.2 One schema, two subjects [PRIOR ART: simulation theory of mind]

Humans model others largely by running their own machinery on someone else's assumed inputs.
That is an architectural gift: build **one** Agent Model schema and instantiate it twice.

```
AgentModel {
  preferences      distributions over choices, contextualised
  competence       what this agent is good at (per domain, calibrated)
  habits           what this agent does by default
  goals            what this agent is currently pursuing
  attention        what this agent is currently tracking
  model_of_other   this agent's model of the other agent      ← level-2
}

Self = AgentModel(subject: ORIS, privileged: internal state readable)
User = AgentModel(subject: human, privileged: none — behaviour only)
```

The **only** difference is privileged access, and even there the self-model is required to
be learned from behaviour rather than read from code (§4). This gives theory of mind for
free, keeps one set of update rules and one set of evals, and makes an important property
fall out: ORIS can model the user's *competence*, not just their taste — which is what makes
Invariant ORIS-3 (user growth) computable.

### 9.3 The expectation gap [NOVEL]

`model_of_other` is where the collaboration actually lives. The system needs a model of *the
user's model of ORIS* to know when to speak.

```
gap  =  divergence( what ORIS will do , what ORIS believes the user expects it to do )

gap small   → just act. Explaining is noise.
gap large   → explain before acting, or ask. Surprise here is the thing that destroys trust.
gap large AND confidence low  →  clarify (the existing economic clarify rule, §K4)
```

This gives a principled answer to the perennial "when should the AI explain itself" question,
which is otherwise settled by taste and A/B tests. It also predicts something testable:
**explanation should become rarer over time for a given user**, as their model of ORIS and
ORIS's model of their model both converge. A system that explains itself at a constant rate
after two years is not modelling the relationship.

### 9.4 The user is also changing

A static User Model is wrong within months: users acquire skill, change genres, change
clients. The User Model therefore needs the same timescale layering as the self (§4) — fast
preferences that can flip in a session, slow dispositions that require months of evidence —
and the same non-stationarity handling: recency-weighted statistics, explicit change-point
detection, and the ACh/NE distinction so that "this user changed" is not averaged into
"this user is noisy."

---

## 10. Identity as a plasticity gradient

> **Q3 — How do humans separate identity / knowledge / memory / skills / beliefs / goals /
> intentions / habits?**

### 10.1 The separations, and what actually distinguishes them

Ordinary usage treats these as eight kinds of content. They are better understood as content
distinguished along **three orthogonal axes**, which is what makes them implementable:

| | Timescale | Volitional? | Contextual scope |
|---|---|---|---|
| **Memory** | one event | no | one occasion |
| **Knowledge** | accumulated | no | general |
| **Belief** | revisable | no | general, but *held with confidence* |
| **Skill** | practised | no | domain |
| **Habit** | practised | **no — fires without choice** | context-bound |
| **Goal** | current | **yes** | task |
| **Intention** | committed | **yes — and resists reconsideration** | plan |
| **Identity** | years | no | cross-domain |

Two of these distinctions carry real architectural weight:

**Goal vs. intention** is Bratman's, and it is not pedantry. [PRIOR ART: BDI] A goal is
something you want. An **intention is a commitment that resists reconsideration** — it
constrains future deliberation, filters incompatible options, and persists across
interruptions. Without that distinction an agent re-plans continuously and finishes nothing.
For ORIS: a multi-step workflow the user set in motion should be an *intention* — it survives
a tangent, resumes after an interruption, and requires positive evidence to abandon. Today's
planner is goal-shaped only, which is why continuity across a session is fragile.

**Habit vs. skill** is the automaticity axis (§5.4): a skill is deployable under
deliberation; a habit fires *before* deliberation and is therefore both fast and dangerous.
Anything promoted to reflex speed must carry a context guard and a demotion path.

### 10.2 Identity is not content [NOVEL framing]

> **Identity is the low-plasticity stratum. It is defined by learning rate, not by content.**

Every belief, preference, and skill in ORIS carries an explicit **learning rate** — how much
one new piece of evidence moves it. Identity is simply the set of things whose learning rate
has decayed toward zero because they have been confirmed across many contexts over long
periods.

```
   learning rate
   ▲
1.0│ ●  fresh observation        — one datum moves it entirely
   │  ●  preference              — a session can shift it
0.5│    ●  knowledge             — needs interleaved evidence
   │       ●  skill              — needs practice and reliability
0.1│           ●  disposition    — months
   │              ●  IDENTITY    — years; changing it is an event
0.0└──────────────────────────────────────────► consolidation depth
```

This is why the design must not build an "Identity Model": the moment identity is a store,
it can be written to, and something writable in one step is by definition not identity. It
is also why **no two installations converge**: the gradient is path-dependent, and two
histories that differ early diverge permanently even under identical later input. Divergence
is a mechanical consequence, not a feature to be engineered — which is the correct sign that
the mechanism is right.

Elastic Weight Consolidation is the closest formal analogue [PRIOR ART: Kirkpatrick et al.]:
protect parameters in proportion to how important they proved to be. Same principle, applied
to symbolic/statistical structure rather than network weights.

### 10.3 Promotion must be ceremonial and reversible

Because a promotion into the identity stratum is nearly irreversible by design, it must be
the most heavily gated event in the system:

```
PROPOSE      consolidation nominates: "warm-protective skin handling" has held for 8 months,
             314 supporting episodes, 6 contradicting, across 4 project types
VERIFY       re-test against held-out history; check contradiction rate; check it isn't
             merely a proxy for a single client's brand
DECLARE      the promotion is a logged, inspectable, user-visible event with full provenance
REVOKE       an identity trait accumulating contradictions is demoted — loudly, not silently
```

### 10.4 Explainable identity, and the character sheet [NOVEL]

Because every stratum entry carries its evidence chain (the episodes that produced it), ORIS
can answer a question nothing on the market can answer honestly:

> *"Why are you like this?"* →
> *"I protect skin tones by default. That came from 314 sessions across 4 project types over
> 8 months; you overrode my saturation on faces 31 times in the first two months and 0 times
> in the last three. 6 episodes contradict it, all on the Vance b-roll where you wanted the
> stylised look."*

This is the DecisionTrace principle (already shipped) extended from *one edit* to *a
lifetime*. It also produces a genuinely new artifact: an inspectable, diffable, exportable
**character sheet** — the accumulated dispositions of one installation, comparable against
another. That is both a research instrument (divergence becomes measurable, satisfying §0)
and a product surface with no equivalent anywhere.

### 10.5 The reproducibility constraint nobody asks about until it hurts [NOVEL]

If every installation genuinely differs, then **bug reports stop being reproducible** —
which is fatal for a professional tool, and is the way this vision quietly kills the product
it lives in.

> **Invariant (ORIS-7): divergence is data, never code.** The deterministic core — runtime,
> registries, compilers, renderer — is byte-identical on every installation, forever. All
> divergence lives in a single portable, inspectable, exportable, resettable **psyche
> volume**. A support engineer can request it, diff it, replay against it, and reset it. A
> user can export their psyche to a new machine, or fork it per client.

This maps exactly onto the existing "tables first / data over code" invariant, and it is the
difference between a living system and an unsupportable one.

### 10.6 Identity's forward face — it filters, it does not only accumulate

§10.2 describes identity as *what survived*. That is only half of it, and the passive half.
Identity also **constrains future learning**: humans do not merely remember, they **refuse**.

```
"I don't crop interviews."      "I always preserve dialogue."
"I don't stylise wedding skin." "I don't apply a look I can't explain."
```

So a commitment is a two-faced object: a **consolidated past** (the evidence that produced
it) and a **projected refusal** (what I will not do, going forward). The forward face is
structurally Bratman's *intention* (§10.1) applied to the self rather than to a plan — a
commitment that resists reconsideration. That unification matters: identity, intention, and
belief are then one object type at three plasticity levels, not three subsystems.

**And it is dangerous, in a specific and well-documented way.** An identity that filters
evidence *is* a confirmation-bias engine; belief perseverance and motivated reasoning are
exactly this mechanism in humans. The safe form is a locality rule, and it is strict:

> **Invariant (ORIS-11): refusals bind action and attention — never evidence.**
>
> A commitment may rank relevance (what ORIS attends to) and may veto an action (what ORIS
> will do). It may **never** suppress an observation, damp a belief update, bias an error
> attribution, or filter what is written to the Experience Stream. Contradicting evidence is
> recorded at full weight, always, and accumulates until it forces a revision event.

Two further requirements follow:

1. **Refusals are stated, not silent.** *"I don't auto-crop interviews — you've reversed
   that 14 times"* is a contestable commitment with provenance. A silent bias is
   indistinguishable from a bug and violates the honest-labels rule.
2. **Every refusal carries a revision threshold** — a contradiction count at which it is
   demoted automatically. A refusal with no threshold is dogma, and dogma is not identity;
   it is a hard-coded rule wearing identity's clothes.

---

## 11. Attention and the workspace

> **Q10 — How should the system understand itself?** (in the moment)

Global Workspace Theory, stripped of consciousness claims, is a **capacity architecture**
[PRIOR ART: Baars; Dehaene; implemented in LIDA]: many parallel unconscious processes compete;
a small serial bottleneck selects a winner; the winner is *broadcast* to all processes, which
is what makes information globally available for cross-domain reasoning.

Two engineering commitments worth taking, and one worth rejecting:

**Take: the bottleneck is deliberately narrow.** A persistent system with dozens of observers,
drives, and background processes must have exactly one "now." Without a serial bottleneck,
attention becomes a priority queue nobody read, and the system has no foreground — which is
precisely how a persistent agent degrades into a polling loop.

**Take: broadcast is what enables cross-domain insight.** Value comes from the audio observer
hearing what the colour system just noticed. Point-to-point wiring between subsystems does
not scale and does not generalise; a broadcast bus does. It also gives explainability for
free, because the broadcast history *is* the trace of what was in mind.

**Reject: attention economies as a general knowledge-management strategy.** OpenCog's ECAN
is the cautionary case — attention-value spreading over a large ungrounded AtomSpace is very
hard to tune and tends toward either stagnation or thrash. Keep the workspace small, the
competition simple, and the coalition rules explicit. The workspace is for *what's happening
now*, not a substitute for indexing.

The priority function is where the drives cash out:

```
salience = urgency(user waiting)
         + prediction-error magnitude          ← surprise wins attention
         + learning progress in this domain    ← §6.3
         + goal relevance (current intention)  ← §10.1
         − body cost right now                 ← §3.2
```

---

## 12. Self-modification, governed

> **Q14 — How should the system learn without destroying stability?**

### 12.1 The lesson from the strongest prior result

Schmidhuber's Gödel machine is the theoretical high-water mark for self-modification, and
its lesson is deflationary in exactly the useful way: **provably beneficial self-modification
requires a proof, and proofs are intractable for interesting programs.** The engineering
conclusion is not "give up" but "**replace proof with empirical verification, and never
allow unverified self-modification to take effect.**"

Orreris already owns an unusually strong verification apparatus: `brain:eval`, `world:eval`,
`blueprint:eval`, the pixel gates, the 50-prompt ledger, `render:compare:pixels`.

> **[NOVEL] The eval harness is the immune system.** Self-modification is not a new,
> dangerous capability requiring new safety machinery — it is a change that must pass the
> same gates as a human commit. That reframing is what makes the whole idea tractable here
> and intractable in a system without deterministic evals.

### 12.2 The staged lifecycle

```
PROPOSE     consolidation or impasse-chunking emits a candidate change (data, not code)
            ↓
SHADOW      the change runs in parallel with the incumbent and predicts, but does not act.
            Cost: near zero. Duration: until statistical power exists.
            ↓
PROBATION   the change acts, but only where it beats the incumbent in shadow, and every
            action is traced and easily undone. Wrong-fire budget is ZERO (existing rule).
            ↓
ADOPT       the change becomes the default; the incumbent is kept as a fallback with its
            evidence chain intact.
            ↓
REVOKE      degradation, contradiction accumulation, or user override rate triggers demotion
            — with the same ceremony as promotion, and a logged reason.
```

Nothing skips shadow. Nothing adopts without eval. **Every stage transition is an event in
the Experience Stream**, which is what makes the system's own development part of its
autobiography rather than an invisible drift.

### 12.3 What may and may not be modified

| Layer | Self-modifiable? | Why |
|---|---|---|
| Renderer, compositor, codecs | **Never** | Parity rule; correctness is not negotiable |
| Timeline Action Registry (the syscall line) | **Never** | The boundary cannot move itself |
| Craft compilers | **Never automatically** | Encoded craft; human-authored; the moat |
| Ledger, scoring, promotion criteria | **Never** | The EURISKO rule (ORIS-5) |
| Recipes, mood rows, look mappings | Yes — data | Already the "rule of engagement" |
| Route thresholds, tier boundaries, budgets | Yes — parameters | Per-user divergence lives here |
| Learned reflexes / compiled chunks | Yes — with context guards | §5.3, §10.1 |
| Observer scheduling and fidelity policy | Yes | Body-state adaptive |

This table is the honest scope of "self-modifying software" for a professional tool: **ORIS
rewrites its policies, never its physics.**

### 12.4 Revocability

> **Invariant (ORIS-8): every learned parameter carries the episodes that justify it.**

Without provenance, learning is a one-way ratchet: you cannot audit it, explain it, or undo
it when the evidence turns out to be an artefact of one bad month. With provenance, ORIS can
answer *"why do you do that?"* and *"stop doing that — and un-learn what caused it."* This
is the same dependency-cascade mechanism the Fact Store already implements, applied to
learning rather than to facts.

---

## 13. Bounding growth

> **Q8 — What architecture prevents catastrophic memory growth?**

### 13.1 The arithmetic, stated plainly

A working editor generates on the order of 10⁴–10⁶ discrete events per year of use. Naive
retention is linear in use, forever. Any design whose steady-state cost is linear in
experience is already dead; it only takes longer to notice.

> **The requirement: memory cost must be sublinear in experience, with a hard ceiling per
> tier.** Not "we'll prune later." Sublinear by construction.

### 13.2 Five mechanisms, in order of leverage

1. **Store residuals, not observations.** [NOVEL framing, information-theoretically obvious]
   If a schema predicts an episode, the episode carries no information and should not be
   stored — only the *deviation* from what was predicted. A thousand routine cuts cost
   almost nothing; the one strange decision costs a full record. This makes storage
   proportional to **surprise**, which is exactly proportional to *value*, and it means a
   maturing system's memory growth naturally decelerates as its models improve. This single
   principle does most of the work.
2. **Never store what is re-derivable.** Already an invariant in this repo (content-hash
   re-derivation). Facts are caches, not archives.
3. **Consolidate and discard.** Episodes have a job: to produce patterns. Once a pattern is
   extracted with sufficient support, the supporting episodes are compressible into sufficient
   statistics plus a small number of retained exemplars (prototype + boundary cases). Human
   memory does exactly this; the loss of episodic detail is not a bug.
4. **Decay by ACT-R activation.** Retrievability decays with disuse; low-activation items are
   evicted. One equation, already validated against human data, already tuned.
5. **Hard per-tier budgets with value-based eviction.** Every store has a ceiling. Eviction
   ranks by (activation × surprise × consequence). Ceilings are enforced, not aspirational.

### 13.3 Forgetting is a feature

The instinct to keep everything is wrong on three counts: retrieval degrades with volume
(interference is real, in humans and in vector stores alike), stale specifics actively
mislead, and unbounded stores destroy the local-first property the product depends on.

> **Invariant (ORIS-9): every store has a ceiling, and every stored item has a reason to
> exist that can be stated.** An item whose justification cannot be produced is evicted.

The one exception, deliberately carved out: **promotion and revocation events are permanent.**
The autobiography of the system's own development is small, bounded by definition, and is the
only record that makes identity auditable.

---

## 14. Development over years

> **Q7 — How should these evolve over years?**

### 14.1 Epochs, self-gated

Development is not a schedule; it is a sequence of unlocks. The critical design decision:
**ORIS may not enter an epoch until it has demonstrated calibration in the previous one.** A
system that starts forming dispositions before it can predict the user is building identity
on noise.

| Epoch | Duration (order) | What it does | Gate to the next |
|---|---|---|---|
| **0 · Instrumented** | weeks | Records only. Full experience stream, full ledger, zero adaptation. | Stream + ledger complete and honest |
| **1 · Calibrated** | months | Learns *how right it is*, per domain. Behaviour unchanged except confidence reporting. | Calibration error below bar in ≥3 domains |
| **2 · Preferenced** | months | Fast-stratum adaptation: parameter defaults, phrasing, route thresholds. Fully reversible. | Override rate falling; no wrong-fire regressions |
| **3 · Skilled** | 1–2 years | Impasse-chunking; context-guarded reflexes; compiled fast paths. | Chunk reliability + demotion machinery proven |
| **4 · Disposed** | years | Cross-domain dispositions; the identity stratum begins to fill. | Contradiction rates stable under promotion ceremony |
| **5 · Characterful** | many years | Installations are meaningfully different. Character sheets diverge measurably. | — |

Epoch 0 is not a placeholder. **Running fully instrumented and non-adaptive for a long time
is the correct first move**, because it produces the corpus every later epoch needs, carries
almost no risk, and immediately answers whether the signals are rich enough to support any of
this. If epoch 0 shows the streams are too sparse to calibrate on, the entire programme
should be reconsidered — cheaply, and early. This is the programme's own falsification gate.

### 14.2 Divergence is the product of path dependence

Two installations diverge because: consolidation is order-dependent (what you learn first
shapes what you can learn next); promotion is threshold-based (a near-miss and a near-hit
produce permanently different strata); drives allocate attention differently based on early
competence, which compounds; and the users differ. No divergence machinery is required.
**Attempting to engineer divergence directly would produce randomness, which is the opposite
of character.**

---

## 15. Prior art map — what is solved, and what to take

> **Q15 — What research already solved parts of this?**

Principles only; no summaries. Each row is "what to steal and why."

| Source | The extractable principle | Where it lands |
|---|---|---|
| **Complementary Learning Systems** (McClelland et al. 1995) | Two stores at two speeds, reconciled by interleaved offline replay. Prevents catastrophic interference *by scheduling*, not by loss design. | §5.2 — the spine of the memory architecture |
| **ACT-R** (Anderson) | Base-level activation: retrievability = f(frequency, recency, decay). An off-the-shelf, human-validated forgetting law. | §5.3, §13.2 |
| **SOAR** (Laird/Newell/Rosenbloom) | Learn *from impasses*. Chunking caches the resolution of a deliberation into a rule. Learning is triggered, not continuous. | §5.3 — maps onto existing tier escalations |
| **LIDA** (Franklin) | A free-running cognitive cycle is what makes a system situated. The loop ticks whether or not anyone asks. | §3.4 — the assistant/resident distinction |
| **Global Workspace** (Baars, Dehaene) | Narrow serial bottleneck + global broadcast. Capacity limits are functional, not defects. | §11 |
| **BDI** (Bratman; Rao & Georgeff) | Intention ≠ goal. Intentions resist reconsideration; that's what allows anything to finish. | §10.1 — the missing planner concept |
| **Model-free / model-based arbitration** (Daw, Niv, Dayan 2005) | Arbitrate by *uncertainty*, and let the balance shift with experience. | §5.4 — validates the tier cascade, indicts its staticness |
| **Neuromodulation as meta-parameters** (Doya 2002; Yu & Dayan) | A few global scalars retune all learning at once. Two kinds of uncertainty demand opposite responses. | §6.2 |
| **Intrinsic motivation** (Oudeyer & Kaplan; Schmidhuber) | Reward *learning progress*, not novelty. Solves the noisy-TV problem and produces developmental staircases. | §6.3 — the real "growth model" |
| **Self-Memory System** (Conway & Pleydell-Pearce 2000) | Autobiographical memory and the self are mutually constructing; goals filter what is retained. | §5, §10 |
| **Three-level self** (Damasio) | Proto / core / autobiographical = three timescales, three mechanisms. Makes "self" engineerable. | §4 — the spine of the self-model |
| **Metacognition** (Nelson & Narens 1990) | Meta-level holds a model of the object-level; monitoring up, control down. | §7 |
| **Active inference / Markov blanket** (Friston) | Perception and action minimise one currency; a boundary defines the system. *Caveat: too general to constrain design on its own.* | §3.3 |
| **Predictive processing** (Clark) | Prediction error is the universal learning signal; precision weighting is the attention mechanism. | §7, §11 |
| **World Models / Dreamer / Dyna / MuZero** | Learn dynamics, plan in imagination — and fight model bias forever. | §8 — *and why Orreris escapes the hard part* |
| **EWC / continual learning** (Kirkpatrick et al.) | Protect parameters in proportion to demonstrated importance. | §10.2 |
| **Prioritised replay** (Schaul et al.) | Replay by surprise, not uniformly. | §5.2, §13.2 |
| **Developmental robotics** (Weng; Lungarella; Vygotsky's ZPD) | Competence is staged; each stage is the prerequisite for the next; target the frontier. | §14 |
| **Gödel machine** (Schmidhuber) | Self-modification needs a verification gate; proofs are intractable → use empirical gates. | §12.1 |
| **EURISKO** (Lenat) | A system that can rewrite its own credit assignment will. | §7.4 — Invariant ORIS-5 |
| **Cyc** (Lenat) | Hand-built ontologies do not bootstrap understanding. Grounding must come from measurement. | §16 — why the observer/fact grounding matters |
| **OpenCog / ECAN** | Attention economies over large ungrounded symbol stores are very hard to tune. | §11 — what to *avoid* |
| **Sigma** (Rosenbloom) | Unify architecture on one substrate to avoid module sprawl. Aspirational; heavy. | Noted; not adopted in v1 |
| **Generative Agents** (Park et al. 2023) | Memory stream + retrieval scored by recency/importance/relevance + periodic reflection. The closest existing engineering precedent. *Insufficient: reflection is unverified LLM output, so nothing is calibrated and errors compound silently.* | §5, §7 — we take the shape, replace reflection with the ledger |
| **Agent memory hierarchies** (MemGPT-class) | Tiered memory with explicit paging is a real pattern. *Insufficient: it manages context, not development.* | §13 |

### 15.1 The honest summary

**Every individual model in the ten-item hypothesis exists somewhere in the literature.**
Episodic/semantic separation, self-models, metacognitive monitoring, intrinsic motivation,
homeostatic regulation, world models, continual learning, self-modification — all have decades
of work behind them, and most have working implementations.

**None of them have been combined in a deployed tool that a single professional uses daily
for years.** Cognitive architectures are demonstrated in microworlds and starve for grounded
experience. Deployed agents have rich experience and no architecture — no consolidation, no
calibration, no development, no identity beyond a prompt.

That gap is the actual research opportunity, and it is not primarily an algorithms problem.

---

## 16. What is genuinely novel here

> **Q16 — Which pieces appear genuinely novel?**

Ranked by confidence that no one has done it, and by how much it matters:

1. **Deterministic ground-truth simulation for a cognitive architecture.** [§8] The
   environment is a pure function, so imagination is exact and free of model bias. The hard
   problem of model-based cognition collapses to "predict the human." We are not aware of any
   cognitive architecture with this property.
2. **The render loop as body; engineering telemetry as interoception.** [§3] Software agents
   almost universally lack a body. Orreris has real finitude, real consequence, real
   proprioception — already instrumented, currently discarded. Embodied cognition without a
   robot.
3. **Identity as an auditable plasticity gradient, with explainable provenance.** [§10] The
   character sheet — a diffable, exportable record of what an installation has become and why
   — has no equivalent. It is simultaneously a product surface and the research instrument
   that makes divergence measurable.
4. **The eval harness as immune system for self-modification.** [§12] Reframing
   self-modification as "a change that passes the same gates as a human commit" makes it
   tractable in a codebase with deterministic pixel-level evals, and intractable elsewhere.
   This is a property of *this* repo, not a general result.
5. **Craft compilers as innate structure.** [§12.3] A hybrid where low-level competence is
   deterministic engineered craft and learning only reweights, composes, and contextualises it.
   Closer to *evolved reflexes + learned policy* than to anything in SOAR/ACT-R (all learned
   structure) or end-to-end agents (all learned everything). The failure mode of both — the
   system learning to do badly what could be done exactly — is architecturally excluded.
6. **The expectation gap as the explain/act arbiter.** [§9.3] Level-2 theory of mind used to
   decide when to speak, with the testable prediction that explanation frequency declines as
   the relationship matures.
7. **Storage proportional to surprise as the memory-growth solution.** [§13.2] Storing only
   residuals from what schemas predict means a maturing system's memory growth *decelerates*.
   Information-theoretically obvious, apparently unimplemented in agent memory systems.
8. **The anti-sycophancy setpoint.** [§6.4] Making *user* capability growth an explicit drive
   term, and treating perfect predictability of the user as a warning rather than a win.

Items 1–4 are where we would place research bets. Items 5–8 are strong design positions that
may exist in fragments elsewhere.

---

## 17. Failure modes to design against

The ways this programme fails while every dashboard looks healthy:

| Failure | Mechanism | Defence |
|---|---|---|
| **Anthropomorphic theater** | Simulated affect displayed as feeling; "I'm excited to help!" | ORIS-2: valence modulates and reports, never performs |
| **Sycophantic convergence** | Optimising for agreement deepens the user's ruts | ORIS-3: user-capability drive term; predictability as a warning |
| **Unsupportable divergence** | Every install differs → no bug reproduces → the product dies | ORIS-7: divergence is data in a portable psyche volume |
| **Reward hacking** | Anything that can rewrite its own credit assignment does | ORIS-5: ledger and promotion criteria are outside the modifiable surface |
| **Memory rot** | Linear growth, stale specifics, degraded retrieval | ORIS-9: ceilings, residual storage, activation decay |
| **Ontology rot** | Two parallel type systems for the same thing | ORRERIS_OS.md's existing rule: one fact schema. Extended: one Agent Model schema |
| **The starvation regression** | The organism becomes a new source of frame drops | ORIS-6: same background gate, same suspension rules as proxy builds |
| **Second-system paralysis** | Cognition work stalls the shipping product | The OS doc's rule holds verbatim: any phase requiring a pause in the shipping cadence is mis-scoped |
| **Premature identity** | Dispositions formed on noise before calibration exists | §14: epochs are self-gated on calibration |
| **Unfalsifiable success** | "It feels alive" as the acceptance criterion | §0: every claim has a metric; epoch 0 is the falsification gate |

---

## 18. ORIS invariants

Numbered for citation, in the style of ORRERIS_OS.md. These sit *above* that document's
invariants and never override them.

1. **ORIS-1 — The organism acts freely on itself and never on the user's work.** The
   free-running cycle may perceive, predict, simulate, consolidate, and prepare. Only
   user-originated intent crosses the Timeline Action Registry.
2. **ORIS-2 — Valence modulates and reports; it never performs.** No simulated feeling
   displayed as feeling. Interoception is honest telemetry.
3. **ORIS-3 — Optimise the user's capability, not the system's predictive comfort.**
   Perfect predictability of the user is a warning.
4. **ORIS-4 — Every consequential act carries a prior recorded claim.** No claim, no
   learning, no development.
5. **ORIS-5 — Credit-assignment machinery is outside the self-modifiable surface.**
6. **ORIS-6 — Cognition is subject to the body budget.** Suspended during playback and
   export, gated, cancellable. The editor never stutters for the mind.
7. **ORIS-7 — Divergence is data, never code.** One byte-identical core; all history in a
   portable, inspectable, resettable psyche volume.
8. **ORIS-8 — Every learned parameter carries the episodes that justify it.** Learning is
   auditable and revocable.
9. **ORIS-9 — Every store has a ceiling, and every item has a statable reason to exist.**
   Exception: promotion/revocation events are permanent.
10. **ORIS-10 — No epoch is entered before the previous one is calibrated.** Development is
    self-gated on measured competence, never on a schedule.
11. **ORIS-11 — Refusals bind action and attention, never evidence.** Identity may veto what
    ORIS does and rank what it attends to; it may never suppress an observation, damp a
    belief update, or filter the Experience Stream. (§10.6)
12. **ORIS-12 — Values are lexicographic across tiers, and the constitutional tier is not
    learnable.** Weights exist only *within* a tier. A value with an exchange rate is not a
    value. ([`ORIS_VALUES.md`](ORIS_VALUES.md))
13. **ORIS-13 — No operator writes to a band slower than its own.** Consolidation and
    promotion are the sole upward channels, and both are offline and gated. This single law
    subsumes ORIS-5, ORIS-7 and ORIS-10. ([`ORIS_TIME.md`](ORIS_TIME.md))
14. **ORIS-14 — The structural self is measured, never believed.** Declared capabilities and
    limits live in `S`; *discovered* limits live in beliefs with evidence. The two must be
    reconcilable, and a persistent divergence between them is a reportable finding.
    ([`ORIS_SELF.md`](ORIS_SELF.md))
15. **ORIS-15 — Promotion requires rehearsal.** No commitment enters the identity stratum
    without a simulated forward projection against held-out history. (§8.4)
16. **ORIS-16 — A psyche export is reviewable by the user before it leaves the device.**
    ORIS-7 makes the psyche volume portable *and* shareable for support; those are the same
    property, and it is what makes divergence supportable. But the corpus contains the user's
    own words — prompts carry client names, project titles, and working notes. So export is
    never a silent capability: the user sees what is leaving, and may redact it, before
    anything is transmitted. Local-first is a property of the *default*, not an excuse for
    the export path. This is cheap to honour now and cannot be retrofitted onto a corpus that
    has already been shared.
17. **ORIS-17 — No dangling references in the Experience Stream.** A row is never evicted
    while any surviving row references it, transitively. Where this collides with ORIS-9's
    ceiling, **provenance wins and the overflow is reported** — a ceiling breach is visible
    and recoverable; a broken evidence chain corrupts every analysis that touches it,
    permanently. (Calculus L8, applied to the journal rather than to beliefs.)
18. **ORIS-18 — Every producer observes only its own boundary.** The `ai` producer may not
    emit an outcome, because it does not observe the user's reaction. The `editor` producer
    may not emit a claimed confidence, because it never held that claim. No producer
    synthesises another's observation. This is what enforces *record observations, never
    classifications* at the architectural level rather than by convention — and it is
    enforced structurally, by giving each producer one narrow typed entry point and exposing
    no generic append.
19. **ORIS-19 — Interpretations have no natural observer.** Nobody witnesses *accepted*,
    *rejected*, *competent*, *expert*, *trustworthy*, *improved*. People and machines witness
    **events**; interpretations are *functions over events*. That is not a rule imposed on the
    architecture — it is the reason interpretations must be derived, and it is why episodes,
    consequences, outcomes, assessments, beliefs, competence, calibration, and reflection are
    all computed at read time rather than recorded.
    The distinction is **event vs. meaning, not self vs. other**: a producer may record an
    event it performs when the occurrence is objectively observable at its boundary, and may
    never record its own interpretation of that event. *"Promotion transaction committed"* is
    an observation; *"identity improved"* is not.
    The admission test, which subsumes ORIS-18 and ADR-014 E6/E11 without special cases:
    **can this row answer "what did the producer directly witness?" without appealing to any
    later policy?** (Calculus L11.)
20. **ORIS-20 — Every derivation names its policy and version.** This is what makes ORIS-19
    pay rather than merely sound principled: without it, "derived" degenerates into *computed
    once and forgotten*, which is storing interpretations with extra steps. A derived value
    must be reproducible, comparable across policy versions, and attributable when it proves
    wrong. (Calculus L12.)
21. **ORIS-21 — Interpretations are never stored *as evidence*; artifacts are a separate
    class.** Proposals, plans, tasks, and generated reports are neither observations nor views
    — they are things the organism *produced*, and they must be persistable. They live outside
    the Experience Stream, addressable; the **act of producing one** is a witnessed event and
    is a legitimate stream row referencing the artifact. The guard against using this as a
    laundering channel: an artifact is consumed as output by something. A value persisted
    "just in case" is a cached view and owes ORIS-20. (Calculus L13.)

---

## 19. Build direction (order, not schedule)

Seeded on what already ships, in dependency order. Every step is data-and-tables first, per
the existing invariant 6.

**O1 · The Experience Stream.** Append-only, timestamped, surprise-gated. *Seed: `DecisionTrace`
already records intent → route → facts → operations → outcome at every apply/answer seam.*
That is an episode record missing only persistence, segmentation, and a retention policy.
This is the single highest-leverage step and it is close to free.

**O2 · The Prediction Ledger.** Record the claim before the act; score it after. *Seed: the
routing ledger, `brain:eval`, the bandit stats.* Delivers calibration immediately —
"how often am I right when I say I'm sure" — which is a shippable honesty feature on its own,
independent of everything downstream.

**O3 · Interoception (the proto-self).** A bounded body-state vector from signals already
measured (`FrameProfiler`, decode pressure, cache state, background gate). Deliverable:
cognitive policy demonstrably modulated by body state.

**O4 · The cognitive cycle.** A free-running idle tick that maintains the core self across
ticks. *Seed: the perception scheduler and background gate.* Deliverable: the system knows
where it is without being asked.

**O5 · Consolidation v1.** Offline, at session end: episode → pattern extraction with ACT-R
activation and surprise-weighted retention. This is where memory growth is first proven
sublinear — measure it, don't assume it.

**O6 · The Agent Model schema, instantiated twice.** User first (it's the dynamics model for
simulation, §8), self second. One schema, one set of evals.

**O7 · Simulation.** Structural rollout first (cheap, feeds O2), counterfactual replay second
(the labelled-pairs multiplier), dreaming last.

**O8 · Governance and the plasticity gradient.** Shadow → probation → adopt → revoke, running
over the eval harness. Only then does the identity stratum begin to fill.

**Rule of engagement, inherited and restated:** build the substrate before the read-outs;
resist identity-flavoured user-facing features until calibration exists; treat every drive,
observer, and consolidation rule as registered data from day one. **Epoch 0 — fully
instrumented, zero adaptation — should run for a long time and is the cheapest possible test
of whether this programme is viable at all.**

---

## 20. Open questions

Honest unknowns, recorded so they are not mistaken for settled:

1. **Is the signal dense enough?** A solo editor may generate too few decision events per
   year to calibrate anything interesting. Epoch 0 answers this empirically. If the answer is
   no, the programme changes shape (fleet-aggregated priors under consent, per invariant 7).
2. **What is the right episode boundary?** Human episodic segmentation is driven by event
   boundaries we do not fully understand. Naive segmentation (per command, per session) is
   almost certainly wrong.
3. **Does skill → disposition have a real mechanism, or is it a threshold we impose?** §5.3's
   last arrow has the weakest prior-art support in the whole pipeline. It may be that
   "disposition" is only ever an engineering convention. That would be a genuine finding.
4. **Can the self-model be learned from behaviour cheaply enough to be worth having?** §4
   requires it to be lossy and fallible; it may simply be too weak to be useful at realistic
   data volumes.
5. **Where does the LLM belong in all of this?** Deliberately unresolved. It is a good
   pattern-extractor for consolidation and a terrible judge of its own output. The Generative
   Agents lesson (§15) says unverified reflection compounds errors silently. A candidate rule
   — *the LLM may propose consolidations; only the ledger may promote them* — is untested.
6. **How much does the user want to know?** Explainable identity is a research instrument for
   certain. Whether a working editor wants to read their AI's character sheet is a product
   question we should not answer from the armchair.
7. **Multi-user and multi-project identity.** A studio installation serves several people; a
   freelancer serves several clients with contradictory taste. Is identity per-install,
   per-user, or per-relationship? Currently unresolved, and it interacts hard with ORIS-7.

---

## Appendix A — Where each of the sixteen questions is answered

| # | Question | Section |
|---|---|---|
| 1 | Minimum internal models required | §2 (and §1 for what to *remove*) |
| 2 | How humans organise long-term cognition | §5.1, §5.2 |
| 3 | Separating identity / knowledge / memory / skills / beliefs / goals / intentions / habits | §10.1 |
| 4 | Can an Internal Self Model be engineered? How? | §4 |
| 5 | Persistent situated cognition without embodiment | §3 |
| 6 | How User / World / Self models interact | §9 |
| 7 | Evolution over years | §14 |
| 8 | Preventing catastrophic memory growth | §13 |
| 9 | Memory → knowledge → skills → identity | §5.3, §10.2 |
| 10 | How the system understands itself | §4, §7, §10.4 |
| 11 | Reasoning about its own reasoning | §7.2 |
| 12 | Detecting when its own model is wrong | §7.3 |
| 13 | Internal simulation | §8 |
| 14 | Learning without destroying stability | §5.2, §12 |
| 15 | What research already solved parts of this | §15 |
| 16 | What appears genuinely novel | §16 |

## Appendix B — Divergences from the founding hypothesis

Recorded so future-us knows each call was deliberate (mirroring ORRERIS_OS.md's convention).

1. **Four of the ten proposed "models" are demoted to read-outs** — Situated Cognition,
   Identity, Growth, Metacognition. Building a store for an emergent property produces a
   costume, not a mind.
2. **Homeostasis is promoted and re-scoped into a full Valence & Drive system.** A homeostat
   without setpoints and an error signal regulates nothing.
3. **The Experience Stream is added as the substrate the whole list rests on.** The Fact
   Store is deliberately amnesic; that is right for facts and fatal for a mind.
4. **The Prediction Ledger is added as the keystone.** One mechanism supplies calibration,
   metacognition, model-error detection, curiosity, and the learning gradient.
5. **User Model and Self Model share one schema.** Two subjects, one set of update rules and
   evals; theory of mind falls out.
6. **Identity is defined by learning rate, not content.** Consequently divergence is a
   mechanical result, not a feature to engineer.
7. **Divergence must be data, never code** (ORIS-7) — otherwise the vision destroys the
   product's supportability.
8. **Consciousness is explicitly not a target.** Simulated feeling is theater and is
   forbidden.
9. **The vision statement is restated in falsifiable terms** (§0). A ten-year programme that
   cannot fail cannot be steered.
10. **Epoch 0 (instrumented, non-adaptive) is treated as the programme's own falsification
    gate**, not as a warm-up.

---

## Appendix C — v2: what the first review changed

Six gaps were raised against v1. Five were accepted as real; one was accepted with a
correction. All are now closed either here or in a companion document.

| Raised | Verdict | Where it landed |
|---|---|---|
| No cognitive geometry — components without flows | **Accepted, with a correction.** The proposed chain `Reality → Belief → Expectation → Comparison → Adaptation` omits three phases: **bind** (no situation ⇒ no situatedness), **act** (a purely epistemic loop can only change the model, never the world — it is a spectator), and **attribute** (knowing you were wrong is worthless without knowing *what* was wrong). The geometry is also a **cycle at nested timescales**, not a line. | [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §2 — 8 phases × 7 bands; coordinate = (phase, band) |
| Identity is passive; it should also filter | **Accepted, with a hard safety constraint.** Identity that filters *evidence* is a confirmation-bias engine. The safe form is a locality rule: refusals bind action and attention, never evidence. | §10.6; ORIS-11; calculus L4 |
| Values deserve separate treatment from drives | **Accepted, and sharpened.** Values are not another weighted term — a value with an exchange rate is a price. They are lexicographic constraints. | §6.5; [`ORIS_VALUES.md`](ORIS_VALUES.md); ORIS-12; calculus L5 |
| Future simulation is underpowered — it must simulate the self | **Accepted.** One operator, two argument types: `simulate(B,W,S,Δ)` where Δ perturbs world or self. Promotion now *requires* a rehearsal. | §8.4; ORIS-15; calculus §3.2 |
| No explicit epistemology — define beliefs | **Accepted, and it exposed a real defect.** Facts die when their inputs change; **beliefs survive and are revised.** Invalidating beliefs by content hash — which the v1 architecture would have done — is no epistemology at all. Beliefs carry evidence *against*, typed subjects, plasticity, and revision history. | Calculus §1.3 |
| Time is absent | **Accepted as the largest omission.** Two clocks (`t` wall, `τ` subjective), seven bands, past/future asymmetry. Time turned out to be the coordinate that lets several other rules collapse into one. | [`ORIS_TIME.md`](ORIS_TIME.md); ORIS-13; calculus L7 |
| Preserve the "Internal Self Graph" | **Accepted, and it resolves an apparent contradiction in v1.** §4 argued a self-model that reads the code is "a mirror, not a self." That is an argument for *two* objects, not one: `S` is the measured **body schema**, `B[subject=self]` is the inferred **self-concept**. | §4.1; [`ORIS_SELF.md`](ORIS_SELF.md); ORIS-14 |
| A single organising sentence | **Accepted, with one repair.** *"Reduce uncertainty"* alone is the **dark room problem** — and for an editing tool its optimum is making *the user* predictable, which is exactly the sycophancy failure ORIS-3 exists to prevent. Uncertainty reduction is the engine; it cannot also be the purpose. | §0.1 |

### C.1 What the formalisation bought

Three results that were not visible in prose, recorded because they are the argument for
having done it:

1. **Six laws generate nine of the fifteen invariants.** ORIS-1, 4, 5, 7, 8, 9, 10, 11, 12
   are consequences of L2, L4, L5, L7, L8, L9, L10. The five that remain independent —
   ORIS-2, 3, 6, 14, 15 — are precisely where the architecture's *values* live rather than
   its mechanics. Knowing which is which matters.
2. **The band ladder subsumes three separate safety rules.** B6 having no operators *is*
   "the credit machinery is not self-modifiable" (ORIS-5); the code/data line falling at
   B5/B6 *is* "divergence is data, never code" (ORIS-7); an epoch *is* a band becoming
   writable (ORIS-10).
3. **The ten founding models reduce to two genuine state variables.** Of the ten, three are
   views over beliefs, three are operators, one is a trajectory, one belongs to the habitat,
   and two are real state. The founding hypothesis was ~80% type error — the expected and
   healthy result of a first pass.

### C.2 Second review — views are first-class

One objection was raised against the reduction itself: collapsing the ten models to seven
state variables is mathematically elegant but costs *conceptual boundaries* that planners,
debuggers, and visualisations genuinely reason in.

**Accepted, and it is not a concession — it is the schema/presentation distinction, and the
reduction only ever claimed the schema.** Views are now first-class named subsystems:
documented, addressable, independently evaluable, freely registered, exempt from the
admission test. What they may never be is state.

The formulation that carries it: **views are free, state is expensive.** The structural
guarantee is rule V3 — operator signatures name base variables only, so *no view can ever
become load-bearing in the calculus* however central it becomes to the UI or to how the team
talks. Five rules, ten canonical views, and the resolution of the one hard case
(`Situation`'s cross-tick persistence relocates to `E`, where episode continuity belongs):
[`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §1.4.

The synthesis worth recording: **the founding ten-model hypothesis was right as an interface
and wrong as an ontology.** That is the most useful kind of wrong — the vocabulary survives
intact while the storage stops duplicating.

### C.3 Third review — framing is state, and it exposed a gap

An objection was raised that `Situation` cannot be a pure function of external state, because
identical external conditions produce different cognition when the *task framing* differs
(hunting colour problems yesterday, lip-sync today). **Correct, and it found a real gap
between this document and the calculus.**

§10.1 here argues that an intention is not a goal — it resists reconsideration and filters
options — and §10.6 asserts that identity, intention, and belief are one object type at three
plasticity levels. Both were right; neither was carried into the calculus's state definition,
which defined commitments as identity-flavoured and had no representation of a live task
intention at all.

The fix required no new state variable, because **plasticity and band are orthogonal** and
the record schema already carried both: an intention is `C@B2` — *low plasticity, short
life*. Low plasticity is what makes it resist reconsideration mid-task; the short band is
what stops it becoming character (L7 already forbids the upward leak). Both of `C`'s roles
apply unchanged: it ranks salience in `bind` and vetoes distractions in `act`.

One consequence worth having: an **inferred** framing is a prediction, so mis-framing becomes
a detectable, attributable error — *"I thought you were colour-grading; you were checking
sync."* Nothing in the system could previously represent having done that, which is why
assistive tools do it constantly and never learn. [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §1.5.

Recorded as a **near-miss on the seven-variable claim**, not a vindication of it. Two reviews
have now pushed against the count and both were absorbed by making the schema say something
it had not said. A third that does not resolve should be read as the reduction failing.

### C.4 What v2 deliberately did not add

No new components. The architecture is at the point where additional boxes reduce clarity,
and [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §5 now exists specifically to reject them —
including four worked rejections of plausible-sounding subsystems (a Narrative Engine, an
Emotion Module, a Curiosity Drive, and a Reflection Module) that all decompose into existing
operators.
