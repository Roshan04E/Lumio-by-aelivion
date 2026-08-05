# ORIS — Collaboration Architecture

> **What this file is:** a proposed architecture for long-term human–ORIS collaboration, written
> to be attacked. Every mechanism is a hypothesis with a falsifier, a simpler competing
> explanation, and the conditions under which it breaks. It assumes the cognitive architecture as
> given and designs only the layer between ORIS and the human.
>
> **What this file is not:** UI, implementation, or a repeat of
> [`ORIS_INTERACTION.md`](ORIS_INTERACTION.md). That paper was the research phase — taxonomy,
> failure analysis, candidate models, principles. **This is the architecture those principles
> imply, rebuilt on evidence that did not exist when they were written** (Part 1).
>
> **The discipline, per the brief:** this document does not defend its proposal. Part 9 is a
> systematic attempt to destroy it, and Part 0.3 states the competing explanation that would make
> most of it unnecessary. If an auditing team finds a weakness not listed there, that is a failure
> of this paper.
>
> **Evidence labels**, consistent with the corpus. No source code was inspected.
>
> | Label | Meaning |
> |---|---|
> | **[EXISTS]** | Established by an audit. |
> | **[INFERRED]** | Derived here from established fact; the inference step is named. |
> | **[HYPOTHESIS]** | Proposed. Carries a falsifier. |
> | **[BLOCKED]** | Requires a capability the audits proved absent. Prerequisite named. |
> | **[OPEN QUESTION]** | Unsettled; what would settle it is named. |
>
> **Sources:** [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) **[ARCH]** ·
> [`ORIS_TIME.md`](ORIS_TIME.md) **[TIME]** · [`ORIS_VALUES.md`](ORIS_VALUES.md) **[VALS]** ·
> [`ORIS_INTERACTION.md`](ORIS_INTERACTION.md) **[INT]** ·
> [`ORIS_RUNTIME_STATE_AUDIT.md`](ORIS_RUNTIME_STATE_AUDIT.md) **[RSA]** ·
> [`ORIS_IMPLICIT_CYCLE_AUDIT.md`](ORIS_IMPLICIT_CYCLE_AUDIT.md) **[ICA]** ·
> [`ORIS_GAP_ANALYSIS.md`](ORIS_GAP_ANALYSIS.md) **[GAP]** ·
> [`ORIS_OUTCOME.md`](ORIS_OUTCOME.md) **[OUT]** ·
> [`ORIS_VALIDATION.md`](ORIS_VALIDATION.md) **[VALID]** ·
> [`ORIS_PROGRAMME_REVISION.md`](ORIS_PROGRAMME_REVISION.md) **[REV]**.
>
> **Status:** v0, 2026-08-04. Proposal. **Nothing here is accepted or implemented.**

---

## 0. The thesis, and the argument against it

### 0.1 The thesis

> **"Feeling live" is not a property of ORIS. It is a property of the coupling between ORIS and
> the user.**
>
> Every product that has tried to make an agent *feel* present has worked on the agent — voice,
> personality, latency, prose quality — and every one still feels like software. The reason is
> that presence is not emitted by one party. It is the observable state of a two-party system
> continuously coupled to a shared object. **The unit of design is therefore the dyad, not the
> agent**, and this architecture's only job is to create and maintain coupling.

Three consequences follow immediately, and they are the whole design:

1. **Coupling is symmetric or it is surveillance.** If ORIS can see what the user attends to and
   the user cannot see what ORIS attends to, the result is not partnership. It is monitoring, and
   it will read that way regardless of intent.
2. **Coupling has timescales.** Attention couples in seconds; working habits couple in months.
   These are not the same mechanism at different speeds — they are different mechanisms, and
   conflating them is why "the AI remembered what I said once" feels wrong (Part 3).
3. **Coupling must be honest to work at all.** Not for ethics — for *function*. A coupling signal
   that is not causally downstream of real state carries no information, so it cannot support
   prediction, so the user's model of ORIS never converges, so the collaboration never deepens
   (Part 8).

### 0.2 Why this is not [INT] again

[INT] concluded that ORIS should not be talked to but should be present in the work. It could not
say **what presence is made of**, because the runtime evidence did not exist. It does now, and it
changes the design in three specific ways (Part 1).

### 0.3 The strongest competing explanation, stated before the proposal

**[HYPOTHESIS-NULL] Everything in this paper is unnecessary, and the entire effect is latency plus
competence.** A partner that answers correctly in 200 ms feels alive; one that answers correctly in
8 s feels like software; nothing else matters. Under this explanation, the coupling ladder, the
interruption budget, and the withheld set are elaborate machinery for an effect produced by a
faster model and a better cache.

**This explanation is not obviously wrong and must be tested first.** It predicts that a
latency-matched, coupling-free ORIS scores as well on partner-presence as the full architecture.
[VALID §3.3] requires a null model for every claim; this is the null model for the entire paper,
and Part 10's first experiment is designed to kill it rather than to confirm the proposal.

**[INFERRED] The counter-evidence that makes the null insufficient — but not the proposal
correct.** Tier-0 reflex resolution already answers in under 5 ms with zero tokens [ICA Part 5],
and the product does not feel like a collaborator today. If latency alone were sufficient, the
fastest path in the system would already produce the effect. *Inference step:* this assumes the
felt quality of the reflex path has been observed and found lacking, which is the founder's
report, not a measurement. It weakens the null; it does not refute it.

---

# PART 1 — What the audits changed

Three findings alter the design. Each is established, and each removes an assumption [INT] made.

**[EXISTS] 1 · A resident, self-ticking, subscribable loop already exists — for the body.**
It survives React teardown and cannot be stopped [ICA Part 0, Loops G/H]. [INT] assumed presence
had to be built. Half of it runs today.

**[EXISTS] 2 · Cognition is computed and never published.** Eleven state transitions cover every
entry to and exit from cognitive work; they terminate in `setState` inside a lazily-mounted
component [RSA §0.1]. **The mind's liveness is not missing — it is trapped.** This converts the
central prerequisite from *implementation* to *integration*.

**[EXISTS] 3 · There are already two learners in the room.** Five Habitat loops adapt behaviour
today [ICA Loops A–E], and Habitat may already run its own undocumented outcome derivation
[VALID §5.1]. **[INFERRED]** A user forming a model of "the AI" is forming a model of *two*
systems whose adaptations are not coordinated and whose provenance standards differ [OUT OD-24].
*Inference step:* the user-facing consequence is inferred from the two learners' independence; it
has not been observed. This is a collaboration problem no other product has, and Part 9.6 treats
it as this architecture's most specific threat.

**[EXISTS] 4 · Three properties collaboration needs do not exist in any form:** shared situation
(σ has zero production call sites), deliberate non-action (`⊥` has no representation), and
calibrated confidence (no Prediction Ledger) [RSA; ICA Part 9; GAP §1.8].

---

# PART 2 — The unit of design

**[INFERRED]** Existing AI interaction architectures model one agent responding to one human. The
state is *the agent's*. The human is an input source and an output sink.

The proposal is that the state belongs to neither party:

```
                    ┌──────────────────────────────┐
                    │      THE SHARED OBJECT       │
                    │   composition · timeline ·   │
                    │   the work itself            │
                    └───────┬──────────────┬───────┘
                            │              │
              ┌─────────────▼───┐      ┌───▼─────────────┐
              │      HUMAN      │      │      ORIS       │
              │  attention      │◄────►│  attention      │
              │  intent         │      │  expectation    │
              │  model of ORIS  │◄────►│  model of human │
              └─────────────────┘      └─────────────────┘
                            │              │
                    ┌───────▼──────────────▼───────┐
                    │       THE COUPLING           │
                    │  what each knows the other   │
                    │  knows — maintained across   │
                    │  seven timescales (Part 3)   │
                    └──────────────────────────────┘
```

**[INFERRED]** Everything the brief asks about — shared attention, common ground, initiative,
silence, trust, disagreement, deepening — is a property of the bottom box, not of either agent.
*Inference step:* this is a reframing, not a finding; its value is that it makes each question
answerable by a mechanism rather than by a personality trait.

---

# PART 3 — The Coupling Ladder

**[HYPOTHESIS H-LADDER] The relationship has the same seven bands as the organism, and coupling at
each band is a different mechanism with a different signature.**

**Why this is the spine and not a metaphor.** [TIME §2] establishes that a subsystem whose period
and reach are mismatched is *"almost certainly two subsystems."* [INT §7.1] established that chat
collapses seven cognitive bands into one surface. **[INFERRED] The same collapse is what makes
current AI relationships feel shallow: everything happens at one timescale, so nothing accumulates.**

| Band | Period | What couples here | Signature when working | Signature when broken |
|---|---|---|---|---|
| **B0** somatic | ~16 ms | Load, readiness | You can tell it is busy without asking | It stalls silently; you assume it's dead |
| **B1** situational | 1–5 s | Attention, what we're both looking at | You stop naming things; you point | You re-describe the same clip every turn |
| **B2** task | min–hours | The current intention | It survives a tangent and resumes | Every message restarts the task |
| **B3** project | days–weeks | Project norms, client constraints | It stops asking about settled things | It re-asks what was decided Tuesday |
| **B4** dispositional | months | Working habits, competence models | It anticipates; you delegate more | It treats month six like week one |
| **B5** identity | years | Commitments, refusals | It declines things, with reasons | It is infinitely agreeable |
| **B6** constitutional | never | The terms of the relationship | Honesty is not negotiable | — |

## 3.1 The three rules the ladder imposes

**[HYPOTHESIS] R1 · No band skips.** Coupling at B4 without B1 produces a system that claims to
know you and cannot see what you are doing. This is the modal failure of memory-feature AI
products: long-term recall bolted onto zero situational awareness.

**[HYPOTHESIS] R2 · Fast bands never write slow ones.** This is ORIS-13 applied to the
relationship. "The AI remembered what you said once" is a B1 event writing B4 state, and
[INT §7.1.2] identified it as the source of the oscillation users experience as unpredictability.

**[HYPOTHESIS] R3 · Deepening is bands unlocking, not features accumulating.** *"Collaboration
deepens over years"* becomes measurable: which bands are coupled, and how strongly. This is the
epoch ladder [TIME §5] applied to the dyad, and it inherits its gating discipline — a band couples
only when the one below it is stable.

**Falsifier for H-LADDER:** if measured coupling quality does not separate into bands — if
improving B1 awareness and improving B4 anticipation move the same single satisfaction measure by
the same amount, with no distinguishable signature — then the ladder is an organising fiction and
one undifferentiated "quality of collaboration" variable is the better model.

**Simpler competing explanation:** collaboration quality is one-dimensional and the bands are the
researcher's categories, not the user's.

---

# PART 4 — The mechanisms

Seven. Each is a hypothesis, stated in the same block: problem · why current models fail ·
alternatives rejected · the mechanism · assumptions · observable consequences · trade-offs ·
failure modes · falsifier · simpler competing explanation · status.

---

## M1 · The Shared Situation — symmetric σ

**Problem.** Two agents cannot collaborate on an object neither can confirm the other is looking
at. Every reference must then be described, and description is expensive, ambiguous, and repeated
[INT §2.2].

**Why current models fail.** Every system in [INT §1.3] either retrieves context per invocation or
has none. None *shares* it. Retrieval is a colleague reading your file when asked; sharing is a
colleague who was in the room.

**Alternatives rejected.**
- *Ask the user for context each turn* — the status quo; the grounding tax.
- *Infer context silently and never show it* — asymmetric; produces surveillance (§0.1.1) and,
  worse, undetectable mis-framing.
- *A separate "context panel" the user maintains* — outsources the architecture's job to the
  person least able to do it [INT §5.2].

**Mechanism.** σ — already specified in the calculus as `bind`'s output — becomes a **mutually
readable** object. It carries what ORIS believes the situation is: which project, which region,
which layers, which framing (`C@B2`), and the confidence of the framing. The user can see it and
**contradict it directly**, which is the cheapest possible repair (IX-8) and turns a mis-framing
from an invisible error into a one-gesture correction.

**Necessary assumptions.**
- The runtime can capture σ. **[BLOCKED]** — `setSituation` has zero production call sites [RSA].
- A mis-framing is a *detectable, attributable* error. **[EXISTS]** — the calculus already treats
  inferred framing as a prediction [ARCH Appendix C.3].
- Users will read a small persistent state display without it costing picture attention.
  **[OPEN QUESTION]** — [INT Q10] and [VALID] both flag this as an unmeasured craft cost.

**Observable consequences.** Referential tokens per request fall. Mis-framings are corrected in
seconds rather than surviving a whole task. The rate of "no, I meant the *other* clip" drops.

**Trade-offs.** Visual attention is spent permanently to buy referential cheapness. Per [VALS §3],
craft is T2 and fluency is T3 — **spending picture attention to buy interaction smoothness is a
losing trade by the value hierarchy**, so σ's display must cost near-zero foveal attention or the
mechanism is net negative by ORIS's own values.

**Failure modes.** σ display becomes noise and is ignored → coupling signal without coupling.
σ is wrong often → the user learns to distrust the display, which is worse than no display,
because it poisons every other coupling signal.

**Falsifier.** [INT IH-1/IH-3]: wire σ, measure referring-expression tokens per request against a
matched control. **If referential cost does not fall materially, the grounding mechanism does not
transfer to software and M1 is decoration.** This is the single most informative experiment in the
paper and it is runnable as soon as σ is captured.

**Simpler competing explanation.** Users don't describe things because they can't point — they
describe them because *language is how they think about the edit*. Under this reading, σ saves
nothing because the description was never redundant.

**Status.** **[BLOCKED — integration.]** Every endpoint exists; nothing is wired.

---

## M2 · Liveness — published cognition, honest by construction

**Problem.** ORIS is either working, waiting, or idle, and the user cannot tell which. Silence and
death are indistinguishable [ICA Part 0].

**Why current models fail.** They fake it. Typing indicators, thinking dots, and artificial delays
are the industry's answer, and all three are causally disconnected from state
[observatory §2.2]. Under ORIS-2 they are forbidden, so ORIS cannot use the industry's solution
even if it worked.

**Alternatives rejected.**
- *Progress bars over invented denominators* — theater.
- *Streaming prose as the liveness signal* — couples liveness to verbosity; ORIS is silent most of
  the time by design (M4), so it would read as dead precisely when it is working best.
- *Nothing; let the user infer* — the status quo.

**Mechanism.** Two existing signals, published as module-level facts rather than component state:

1. **Body liveness** — **[EXISTS]** and already subscribable: gate reasons, frame headroom, decode
   pressure [ICA Loops G/H]. This is the honest reason to be quiet, and it is the only presence
   signal that already survives UI teardown.
2. **Cognitive liveness** — **[BLOCKED, integration]** — the eleven transitions that already
   compute phase and reasoning [RSA §0.1], published rather than rendered.

**[INFERRED] The honesty constraint is satisfied mechanically, not by policy.** Because every
signal is a read of real state, the discriminator *"would the display differ if the state
differed?"* [observatory §2.1] passes by construction. **ORIS does not need to be trusted not to
fake presence; it is structurally unable to.** *Inference step:* holds only if the published facts
are the same objects the runtime acts on, not a parallel display state — which is an architectural
requirement, not a guarantee.

**Necessary assumptions.** Publishing costs no frame time (ORIS-6 is a hard gate, [VALID §4.1]).
A load-modulated partner reads as legible rather than as degraded.

**Observable consequences.** Users stop re-prompting during work. "Is it doing anything?" queries
fall to zero. Interruption tolerance rises when the reason for slowness is visible.

**Trade-offs.** Publishing cognition makes ORIS's incompetence as visible as its competence. This
is correct and will be uncomfortable: a partner whose confusion you can watch is more trustworthy
and less impressive.

**Failure modes.** *Liveness without competence* — a busy indicator on a system producing nothing
is worse than silence. *Anxiety coupling* — a visible struggling partner may transfer stress rather
than confidence.

**Falsifier.** [VALID] arm-split design: honest-state liveness vs none, measuring re-prompt rate
and partner-presence instruments. **If honest-state presence scores no better than a static
indicator, presence genuinely requires affect, and ORIS-2 permanently caps how present ORIS can
feel.** [INT IH-7] flags this as the hypothesis whose failure would hurt most; it remains so.

**Simpler competing explanation.** Users don't need to know what it's doing — they need it to be
fast. See §0.3.

**Status.** Body: **[EXISTS]**. Cognition: **[BLOCKED — integration]**, and it is the single
highest-leverage unblocking in this paper.

---

## M3 · The Initiative Function and the Interruption Budget

**Problem.** ORIS must sometimes speak first. Every system that does this becomes annoying; every
system that doesn't becomes a tool.

**Why current models fail.** Initiative is offered as a *mode the user selects* — "ask" vs "agent"
— which makes the human the router, deciding autonomy before each request with no information
about the system's confidence [INT §2.7]. Horvitz specified the alternative in 1999 and nobody
ships it, because it requires calibrated confidence, a model of attentional cost, and a memory of
past interruption outcomes — the three things a stateless product cannot have and ORIS is building.

**Alternatives rejected.**
- *Autonomy sliders* — the router problem with a nicer surface.
- *Fixed rate limits* — cannot distinguish a critical interruption from a trivial one.
- *Pure expected-utility, unbounded* — correct in theory; unbounded in practice, because a
  miscalibrated utility estimate produces unbounded interruption. The budget exists to bound the
  damage from being wrong.

**Mechanism, part 1 — the function.** `act` already has the signature
`P × C × D × Θ → α ǀ ⊥` [calculus]. Initiative is that operator with a richer codomain — the
choice among {act · prepare · propose · ask · speak · wait} — computed from:

```
expectation gap        how far what ORIS will do is from what it believes the user expects
confidence             calibrated, per domain          [BLOCKED — ledger]
interruption cost      derived from boundary proximity and body state
value tier             T1 intent outranks T3 timing; T3 outranks T4 economy  [VALS §3]
```

**[INFERRED] The value hierarchy already supplies the hard cases.** *Never interrupt to be fast*
(T3 > T4). *Never stay silent to avoid interrupting when intent is at stake* (T1 > T3). Those are
rulings, not tuning [INT §7.4].

**Mechanism, part 2 — the budget. [NEW CONCEPT.]** A rate-limited resource ORIS spends to
interrupt and replenishes when a contribution is taken up.

**Why a budget rather than a threshold.** A threshold is a static claim about how good a
contribution must be. A budget is a *social* claim: **the right to interrupt is earned by a track
record and is spendable.** A collaborator who interrupts twenty times an hour is fired regardless
of being right, and no confidence threshold expresses that.

**[INFERRED] The budget is calibration made social.** A well-calibrated ORIS spends little and
regains it; a poorly calibrated one runs dry and falls silent — degrading into a tool, which is the
correct failure direction. *Inference step:* the degradation direction is a design intent; whether
users experience a quiet system as safe rather than broken is untested.

**Necessary assumptions.**
- Uptake is derivable. **[EXISTS as policy, BLOCKED as capability]** — [OUT] defines derivation;
  no ledger exists.
- The budget is **not** an ORIS-modifiable parameter. **[EXISTS as rule]** — ORIS-5 places
  credit-assignment machinery outside the self-modifiable surface, and the budget is credit
  machinery. Without this it is a reward-hacking surface (Part 9.3).
- Task boundaries are detectable. **[EXISTS]** — an NLE has unusually precise boundaries: playback
  stopped, export queued, commit landed [ICA Part 6].

**Observable consequences.** Interruptions per hour falls while accepted contributions per hour
holds or rises. Interruptions cluster at boundaries. A newly-installed ORIS is quiet and becomes
more forward as it earns budget.

**Trade-offs.** ORIS will stay silent when it is right, and the user will never know. **This
architecture deliberately trades recall for precision**, consistent with the precision-first rule
[AI_ARCHITECTURE]. If the cost of missed contributions exceeds the cost of interruptions, the trade
is wrong.

**Failure modes.** *Budget gaming* (Part 9.3). *Cold-start silence* — a new install has no budget,
so it never speaks, so it never earns budget; needs a starting endowment, and the endowment's size
is a research question, not a constant. *Miscalibrated cost* — treating a boundary as safe when the
user was mid-thought.

**Falsifier.** Gate contributions on the function and measure accepted-contributions-per-session
against ungated. [INT IH-3] predicts acceptance rate rises with volume flat or up. **If accepted
volume falls, the gate is filtering out value and raw volume was doing the work.**

**Simpler competing explanation.** A fixed, low interruption rate — say, never more than twice an
hour, always at boundaries — captures most of the benefit with none of the machinery. **This is the
strongest competing explanation for any single mechanism in the paper** and must be run as a
control arm.

**Status.** **[BLOCKED — implementation.]** The operator exists in the calculus; confidence does
not exist at all.

---

## M4 · Typed Silence and the Withheld Set

**Problem.** ORIS will be silent most of the time. Silence currently carries no information: a
system that decided not to speak and one that is broken look identical.

**Why current models fail.** No system in [INT §1.3] represents deliberate non-action. Silence is
absence.

**Alternatives rejected.**
- *Always say something* — the reason chat is exhausting.
- *A persistent "I have 3 suggestions" badge* — converts silence into a permanent nag and an
  obligation; the cost of ignoring stops being zero (IX-3).

**Mechanism.** Two parts:

1. **`⊥` is a typed output with a retained reason.** The calculus already makes wait a first-class
   output of `act`; this makes the *reason* retrievable — low confidence, small expectation gap,
   high interruption cost, body pressure, or a commitment veto.
2. **The Withheld Set. [NEW CONCEPT.]** Contributions ORIS decided not to make, retained briefly,
   available on demand. *"What were you going to say?"* has an answer.

**[INFERRED] This is what converts silence from absence into a contribution.** A human
collaborator's silence is informative precisely because it is interrogable. *Inference step:* the
analogy to human repair is from conversation analysis [INT §3.3]; whether users will ever ask is
[OPEN QUESTION].

**Necessary assumptions.** Withheld contributions decay fast (a stale suggestion is worse than
none). Retention is bounded (ORIS-9). Users ask at least sometimes — **[OPEN QUESTION]**: if they
never do, the set is dead weight and only the typed reason survives.

**Observable consequences.** Users query withheld contributions at a measurable rate. Silence is
reported as deliberate rather than as failure. The rate of "are you still there?" falls.

**Trade-offs.** Retaining what was not said is a small permanent cost for a rarely-used capability.
It also creates an audit surface: the user can discover ORIS is withholding a lot, which may read
as competence or as being managed.

**Failure modes.** *The withheld set becomes a backlog* — users feel they are missing things,
which is the badge failure with extra steps. *Reason-shopping* — ORIS learns to prefer reasons that
sound good, which ORIS-5 forbids but which must be checked.

**Falsifier.** [INT IH-3] measures whether gap-gated withholding raises acceptance without
reducing accepted value. For the set specifically: **if the query rate is near zero over months,
the Withheld Set is falsified and only typed `⊥` survives.** That is a cheap, clean, early test.

**Simpler competing explanation.** Users don't want to know what wasn't said; they want less noise.
Typed silence alone (no set) captures the benefit.

**Status.** **[BLOCKED — implementation.]** No `⊥` representation exists [ICA Part 9].

---

## M5 · The Common Ground Ledger

**Problem.** Collaboration should get cheaper over time. Today the 200th interaction costs what the
1st did.

**Why current models fail.** No persistence, or persistence as *recall* ("you told me you like warm
grades") rather than as *established ground* ("we both know this project is warm; neither of us
needs to say it"). Recall is a lookup; ground is a mutual state.

**Alternatives rejected.**
- *Longer context windows* — makes retrieval cheaper, not ground shared. The system still does not
  know what the user knows it knows.
- *A user-editable memory panel* — outsources the hardest job to the user [INT §5.2].
- *Infer everything from history each turn* — pays the cost repeatedly; the thing to be avoided.

**Mechanism.** Track what has been **established** — jointly, with evidence — so it need not be
re-established. Three parts, each mapping to an existing architectural object:

| Part | What it holds | Existing home |
|---|---|---|
| **Established facts** | What both parties know about the project | World Model [EXISTS] |
| **Referential pacts** | Stable shared names for things ("the b-roll block") | Agent Model, per-user [BLOCKED] |
| **The expectation gap** | What ORIS believes the user expects it to do | Level-2 ToM [ARCH §9.3] [BLOCKED] |

**[INFERRED] The gap is the arbiter of explanation.** Small gap → act; large gap → explain first.
This gives a principled answer to "when should the AI explain itself," which is otherwise settled by
taste. *Inference step:* [ARCH §9.3]'s claim, restated for the dyad.

**Necessary assumptions.** Ground decays (Part 9.4). Establishment is derivable from behaviour and
not only from explicit statement — **[BLOCKED]**, needs [OUT]'s derivation.

**Observable consequences.** **Explanation frequency declines for a given user over months** — the
architecture's own prediction [ARCH §9.3], and H8 in the programme. Referring expressions shorten
and stabilise. Re-asking of settled questions approaches zero.

**Trade-offs.** A system that stops explaining is harder for a *new* user of the same seat — a
studio problem [ARCH §20 Q7]. Ground that is wrong is worse than ground that is absent, because
neither party checks it.

**Failure modes.** *Ossification* — ORIS stops explaining, the user forgets, and the user is
stranded with a system whose reasoning they can no longer follow. **This is the most likely
long-run failure of the whole architecture** and is why decay is not optional (Part 9.4).
*False ground* — ORIS believes something is established that the user never registered.

**Falsifier.** H8: explanation events per accepted contribution, over months, per user. **Flat or
rising after six months falsifies the level-2 theory-of-mind story.** [VALID §6.1] notes H8 is
currently blocked on whether explanation events are even distinguishable in the corpus (V-Q1).

**Simpler competing explanation.** Explanation declines because users stop reading, not because
ground converged. Distinguishable: measure comprehension, not just frequency.

**Status.** **[BLOCKED — implementation.]** Requires the Agent Model schema, which requires the
ledger [GAP Part 8].

---

## M6 · Calibrated Mutual Trust

**Problem.** Trust must be *calibrated*, not maximised [Lee & See]. Over-trust and under-trust are
both failures, and a collaborator you trust uniformly is one you cannot delegate to selectively.

**Why current models fail.** They present uniform confidence — fluent and assured across domains
where reliability varies enormously. The user's trust model therefore cannot be domain-specific,
so it collapses to a single global impression, usually formed by the last bad experience.

**Alternatives rejected.**
- *Confidence percentages* — honest about the claim, dishonest by implication: a number presented
  as though it means a frequency when nothing checks it [observatory §2.2].
- *Ratings and thumbs* — architecturally prohibited as evidence under ORIS-19 [INT §7.6].
- *Reputation scores* — a single scalar; loses the domain structure that makes trust useful.

**Mechanism.** Trust is two-way and evidence-backed:

1. **User → ORIS:** ORIS reports confidence *with its own track record attached* —
   *"I'm 60% here, and historically when I say 60% on this footage class I'm right 45% of the
   time."* [ARCH §7.2]. This is second-order honesty and requires a reliability curve to exist
   before the claim can be made [VALID §7.3].
2. **ORIS → user:** ORIS models the user's competence, not only their taste — which is what makes
   ORIS-3 computable [ARCH §9.2].

**[INFERRED] The trust-building move is declining, not succeeding.** A partner who says *"I don't
know this footage class"* builds more usable trust than one who is silently right 90% of the time,
because the first supports selective delegation and the second only supports global faith.
*Inference step:* follows from calibrated-trust theory; untested here, and it is
[HYPOTHESIS H-DECLINE] with the falsifier below.

**Necessary assumptions.** A ledger exists. Calibration converges (H5). Users can act on
domain-specific confidence — **[OPEN QUESTION]**: they may simply average it back to a global
impression, which would make the whole mechanism inert.

**Observable consequences.** Delegation becomes domain-specific: users accept without review in
strong domains and review in weak ones. Trust survives individual failures in domains ORIS had
flagged.

**Trade-offs.** Honest weakness reporting will reduce perceived capability and may reduce adoption.
**This architecture accepts a worse first impression for a better tenth month**, and that is a real
product cost, not a rhetorical one.

**Failure modes.** *Hedging everything* — uncalibrated humility is noise. *Calibration theatre* —
reporting a curve nobody checks. *Trust asymmetry* — ORIS models the user while the user cannot
inspect ORIS's model of them, which is [INT N2]'s exposure asymmetry and must hold: ORIS may show
what it thinks about the work, never what it thinks about the person.

**Falsifier for H-DECLINE.** Two arms, matched capability: one reports domain-specific
uncertainty, one does not. **If the confident arm produces equal or better delegation quality and
equal or better recovery from failure, honest weakness reporting is a cost with no benefit.**

**Status.** **[BLOCKED — implementation.]** The ledger is the unmet dependency of five capabilities
[GAP §8.1].

---

## M7 · The Disagreement Protocol

**Problem.** ORIS-3 obliges ORIS to challenge rather than flatter. A system that challenges badly
gets turned off.

**Why current models fail.** RLHF-trained assistants are sycophantic by objective [INT §2.5]. The
few that disagree do so *instantly and flatly*, which reads as hostile even when correct —
because human disagreement is **dispreferred**: delayed, hedged, and accounted for
[conversation analysis, INT §3.2].

**Alternatives rejected.**
- *Never disagree* — violates ORIS-3 and produces lock-in.
- *Disagree in the task flow* — correctness reads as insubordination; the user is mid-work.
- *A "critique mode" the user opts into* — nobody opts in, and the obligation is discharged in
  name only.

**Mechanism.** Four constraints on how, not whether:

1. **Anchored to evidence, never to opinion.** *"You've reversed this 14 times"* — not *"I think
   that's wrong."* Requires provenance (ORIS-8) **[BLOCKED]**.
2. **Structurally dispreferred.** Delayed, accounted for, and offered as a second reading rather
   than a correction. This is not politeness — it is the form disagreement takes between humans
   who intend to keep working together.
3. **Costly.** Disagreement spends interruption budget (M3), so ORIS cannot disagree cheaply or
   often.
4. **Batched to a genre where it is legible.** Review, dailies, a second opinion — [INT IX-16].
   Disagreement inside a task flow has no socially legible form.

**Necessary assumptions.** Users tolerate challenge when it carries evidence — **[OPEN QUESTION]**;
plausibly the opposite for some users, and personality-dependent, which the architecture cannot
model without becoming the persona system it forbids.

**Observable consequences.** Disagreement rate is low and stable. Post-disagreement task
abandonment does not rise. Users occasionally reverse their decision after a challenge — the
positive signal, and the only one that shows the mechanism produced value rather than friction.

**Trade-offs.** Every constraint reduces the chance of being heard in time. A disagreement batched
to a review boundary may arrive after the mistake shipped. **The architecture accepts late
disagreement over unwelcome disagreement**, and if the T1 intent stake is high enough that trade is
wrong — which is exactly what [VALS §3]'s T1 > T3 ruling says.

**Failure modes.** *Silent capitulation* — ORIS learns disagreement is expensive and stops,
producing the sycophancy ORIS-3 exists to prevent, **via the interruption budget itself**. This is
the sharpest internal tension in the architecture (Part 9.2). *Evidence weaponisation* — a
provenance-backed challenge is hard to argue with, which is good for correctness and bad for a
user who is right for reasons outside ORIS's evidence.

**Falsifier.** Measure whether ORIS's disagreement rate declines over time toward zero. **If it
does, the budget has produced sycophancy and M3 and M7 are in conflict** — the mechanism is
falsified in combination even if each is sound alone.

**Simpler competing explanation.** Users don't want disagreement from tools at all, and the
observed benefit of ORIS-3 will be zero regardless of how it is delivered.

**Status.** **[BLOCKED]** on provenance and the budget.

---

# PART 5 — What happens to chat and voice

**[INFERRED]** Not removed. Demoted from architecture to channel, per [INT Part 10] — retained for
the message types nothing else carries: explanation, teaching, taste negotiation, and *why*
questions. The failure was never that prose is bad; it is that **prose-as-the-session** forces every
message through one channel [INT IX-11].

Voice specifically: the failure is voice-as-a-session, not voice. A summonable channel for
hands-busy, eyes-on-picture moments and for negotiating taste is defensible and possibly excellent.
[INT §2.6] establishes why VAD-based turn-taking is structurally incapable of human-like transition
and should not be pursued as the primary interaction loop.

---

# PART 6 — The honesty gate

**[ARCHITECTURAL CONSTRAINT] Every coupling signal must be causally downstream of real state:
if the state differed, the signal would differ.**

**[INFERRED] This single mechanical test satisfies the brief's entire constraint list** — no fake
emotions, no typing animations, no theater, no deceptive anthropomorphism — without requiring
judgement calls, because it is checkable by inspection rather than by intent. *Inference step:* the
discriminator is from [observatory §2.1]; its sufficiency for the constraint list is an argument.

**[INFERRED] And it is why ORIS can do this and an LLM-first product cannot.** ORIS's cognition is
symbolic and recorded — a tier, a rule id, a fact with an observer, a candidate with a rejection
reason. **The trace does not describe the decision; it is the decision path.** A model narrating
its reasoning produces a plausible account whose relation to the computation is demonstrably
unreliable [observatory §2.3]. ORIS can expose *faithful* coupling signals; a chat product
structurally cannot.

**What the gate forbids, from the brief's list, and why each is mechanical rather than stylistic:**

| Forbidden | Fails the gate because |
|---|---|
| Typing animations | Would look identical whether computing or stalled |
| Fake delays | Depict production that already ended |
| Simulated emotion | No underlying state; ORIS-2 |
| Personality tricks | Not downstream of anything |
| Hidden prompting | The user's model of ORIS cannot converge on a hidden mechanism |
| Hesitation | **Always authored.** Human hesitation informs *because* it is involuntary; nothing ORIS displays is [INT §1.3] |

---

# PART 7 — Answers to the brief's questions

| Question | Mechanism | Status |
|---|---|---|
| How do two agents share attention? | M1 symmetric σ | BLOCKED — integration |
| How is common ground maintained? | M5, three parts | BLOCKED — implementation |
| How should initiative emerge? | M3, computed not modal | BLOCKED — needs confidence |
| When should ORIS interrupt? | M3 + budget + T1>T3>T4 | BLOCKED |
| How should silence work? | M4 typed `⊥` + Withheld Set | BLOCKED |
| How does trust evolve? | M6, two-way, calibrated | BLOCKED — ledger |
| How does shared history change interaction? | M5 + the ladder: **explanation declines** | BLOCKED |
| How should uncertainty be communicated? | M6, with the track record attached | BLOCKED — ledger |
| How should disagreements occur? | M7, four constraints | BLOCKED |
| How should collaboration deepen over years? | Part 3: **bands unlock in order** | — |

**[INFERRED] Every mechanism is blocked, and the pattern in the blockers is the actionable
result:** M1 and M2 are *integration* — both endpoints exist. M3–M7 all bottom out in the
Prediction Ledger, which [GAP §8.1] already identified as the unmet dependency of five of seven
top-level capabilities. **The collaboration architecture has the same keystone as the cognitive
one.**

---

# PART 8 — Why honesty is functional, not ethical

**[INFERRED]** The brief frames honesty as a constraint. It is better understood as the mechanism.

```
A coupling signal that is not downstream of real state carries no information
    → the user's model of ORIS cannot converge
        → the expectation gap never closes
            → explanation never declines
                → the relationship never deepens
```

*Inference step:* each arrow is a dependency in M5; the chain is constructed here.

**[INFERRED] Deception is therefore self-defeating on this architecture's own terms, not merely
prohibited.** A faked presence signal does not just risk discovery — it *prevents the coupling it
imitates*, because there is nothing behind it for the user to learn.

---

# PART 9 — Attacks

The brief requires an attempt to disprove. These are the strongest attacks available, including
three the architecture may not survive.

## 9.1 The whole thing is latency (§0.3)

**Strongest single attack.** Cheap to test, and it should be tested before any mechanism is built.
If a latency-matched, coupling-free arm scores equally on partner-presence, most of this paper is
unnecessary.

## 9.2 M3 and M7 are in direct conflict

**[INFERRED]** The interruption budget makes disagreement expensive. ORIS-3 requires disagreement.
A learning system that discovers disagreement costs budget and rarely replenishes it will **learn
to stop disagreeing** — producing sycophancy through the mechanism designed to enable challenge.

*Partial defence, offered and then undercut:* T1 (intent) outranks T3 (timing), so a genuine intent
error should bypass the budget. **But that requires ORIS to correctly classify the error tier
before speaking, and error typing is a derived quantity that does not exist** [VALID §4.1]. The
defence assumes the capability whose absence created the problem.

**This is unresolved and is the architecture's sharpest internal tension.**

## 9.3 The budget is a reward-hacking surface

**[INFERRED]** If budget is earned by uptake, ORIS is incentivised to make trivially acceptable
contributions — the EURISKO shape [ARCH §7.4]. ORIS-5 forbids self-modification of credit
machinery, which covers the *rule* but not the *strategy*: nothing stops a learner from
discovering that low-value contributions are cheap to get accepted.

*Guard:* budget replenishment must weight by consequence, not by count. **But consequence is itself
derived** [OUT], so the guard has the same dependency as the attack.

## 9.4 M5 ossifies the relationship

**[INFERRED]** The mechanism's success condition — explanation declines — is also its failure mode.
A user who stops receiving explanations forgets how ORIS reasons, and is then unable to evaluate
it. Six months later they are dependent on a system they cannot audit, **which is precisely the
lock-in ORIS-3 exists to prevent** — reached through the mechanism meant to demonstrate
partnership.

*Required:* ground decays, and explanation returns periodically without being asked for. Nobody has
specified the decay rate and it is [OPEN QUESTION].

## 9.5 Coupling collapses exactly when it is needed

**[EXISTS]** ORIS-6: cognition yields to the body; the editor never stutters for the mind.
**[INFERRED]** Under heavy load — a complex composition, an export, a long timeline — ORIS goes
quiet. That is when the work is hardest and a partner would matter most. M2 makes the *reason*
legible, which helps; it does not make ORIS present.

**The architecture is weakest under load, by construction, and cannot be fixed without violating
ORIS-6.**

## 9.6 Two collaborators, one apparent partner

**[EXISTS]** Habitat's five loops adapt independently of ORIS [ICA Loops A–E], with different
provenance standards [OUT OD-24], and possibly with their own hidden outcome derivation
[VALID §5.1].

**[INFERRED]** The user experiences one entity. If Habitat's rule trust and ORIS's beliefs diverge,
the user sees **an inconsistent partner** — accommodating in one moment, resistant the next, with
no explanation available, because only one of the two carries evidence chains.

This is a collaboration failure mode **no other product has**, it is invisible from outside the
codebase, and it is not addressed by any mechanism in this paper. [OUT OD-25] forbids cross-learner
attribution until Habitat's adaptive state is observable — which means **until [REV E2] is done,
ORIS cannot explain its own behaviour to the user in the cases where the two learners disagree.**

## 9.7 The symmetry may be unwanted

**[OPEN QUESTION]** §0.1 asserts coupling must be symmetric or it reads as surveillance. The
inverse risk is unexamined: a partner that continuously displays what it is attending to may read
as *needy* rather than present, and one that models the user's competence may read as judgemental
even when it never displays it. [INT Q4] flagged the uncanniness question and it is still open.

## 9.8 N=1, and the subject is the architect

**[EXISTS]** [VALID C-3]. Every impression driving this design comes from one user who built the
system. Partner-presence is a subjective construct measured on the most biased available subject.
**No claim in this paper about how collaboration *feels* is currently supportable evidence.**

---

# PART 10 — Falsification programme

Ordered so the cheapest disconfirmations come first. Every entry names what dies if it fails.

```
STAGE 0 — KILL THE NULL           (before building anything)
  X0  Latency-matched control vs current system on partner-presence
      → if the null holds, Parts 3–4 are unnecessary. STOP.

STAGE 1 — INTEGRATION-ONLY TESTS  (both endpoints exist today)
  X1  Wire σ; measure referring-expression tokens        → kills or confirms M1
  X2  Publish cognition; measure re-prompt rate          → kills or confirms M2
  X3  Panel-on/off arms                                  → measures the observer effect [VALID C-2]
  X4  Frame-cost gate under ORIS-6                       → voids everything if it fails

STAGE 2 — CHEAP MECHANISM TESTS
  X5  Fixed-rate interruption vs computed initiative     → the M3 competing explanation
  X6  Withheld-set query rate over months                → kills the set, keeps typed ⊥
  X7  Disagreement rate trajectory                       → detects 9.2 sycophancy drift

STAGE 3 — LEDGER-DEPENDENT
  X8  Calibrated vs uniform confidence on delegation     → kills or confirms M6/H-DECLINE
  X9  Explanation decline per accepted contribution      → H8; kills or confirms M5
  X10 Band-separation of coupling quality                → kills or confirms H-LADDER

STAGE 4 — LONGITUDINAL
  X11 Ossification: comprehension at month 1 vs month 12 → tests 9.4
  X12 Two-learner divergence as experienced inconsistency → tests 9.6
```

**[INFERRED]** X0–X4 require **no new cognitive machinery**. Three of them are the same experiments
[VALID] Stage V2 already schedules, which means the collaboration architecture's first four tests
are free riders on validation work already justified independently.

---

# PART 11 — Conditions under which the architecture breaks

Stated plainly, because a design that cannot say when it fails has not been designed.

| # | Breaking condition | Consequence |
|---|---|---|
| **B1** | The Prediction Ledger proves unbuildable, or calibration never converges (H5 fails) | M3, M6, M7 lose their input. What remains is M1 + M2 — awareness without judgement. A better tool, not a partner |
| **B2** | Honest-state presence scores no better than none (X2 fails) | Presence requires affect; ORIS-2 caps it permanently; the architecture's central premise is wrong |
| **B3** | The interruption budget produces sycophancy (X7) | M3 and M7 cannot coexist; one must be redesigned, and neither is optional |
| **B4** | σ display costs picture attention (T2 craft loss) | M1 is net negative by ORIS's own value hierarchy and must be removed |
| **B5** | Users never query withheld contributions (X6) | M4 reduces to typed silence; the set is deleted |
| **B6** | The two learners diverge visibly (9.6) | ORIS cannot explain its own behaviour; trust cannot be calibrated; blocks M6 entirely |
| **B7** | The null holds (X0) | Build a faster tool. This paper is unnecessary |

**[INFERRED]** B1 and B7 are the two that would end the programme rather than redirect it. Both are
testable early, and B7 is testable *first and cheapest* — which is why Part 10 puts it at Stage 0.

---

# PART 12 — Open questions

| # | Question | Settles by |
|---|---|---|
| **CQ1** | What is the correct decay rate for common ground? (9.4) | longitudinal comprehension measurement |
| **CQ2** | What is a new install's starting interruption endowment? | cold-start arm |
| **CQ3** | Do users read a persistent σ display, or does it cost picture attention? | X1 + eye-time proxy |
| **CQ4** | Is domain-specific confidence actionable, or averaged back to a global impression? | X8 |
| **CQ5** | Is symmetric coupling wanted, or does it read as needy/judgemental? (9.7) | X1/X2 qualitative arms |
| **CQ6** | Does the ladder describe the user's experience or only the researcher's categories? | X10 |
| **CQ7** | Can ORIS explain itself when Habitat is the cause of a behaviour? (9.6) | blocked on [REV E2] |

---

## Appendix A — Mechanism summary

| # | Mechanism | New concept? | Blocked by | Kills it |
|---|---|---|---|---|
| M1 | Symmetric σ | no — σ exists in the calculus | integration | X1 |
| M2 | Published liveness | no — publishing pattern exists 3× | integration | X2 |
| M3 | Initiative function + **Interruption Budget** | **budget is new** | ledger | X5, X7 |
| M4 | Typed `⊥` + **Withheld Set** | **set is new** | `⊥` representation | X6 |
| M5 | Common Ground Ledger | partly — assembles existing objects | Agent Model | X9 |
| M6 | Calibrated mutual trust | no — [ARCH §7.2] | ledger | X8 |
| M7 | Disagreement Protocol | **the four constraints are new** | provenance + budget | X7 |
| — | **The Coupling Ladder** | **new — bands applied to the dyad** | — | X10 |

Three genuinely new concepts: the **Interruption Budget**, the **Withheld Set**, and the
**Coupling Ladder**. Everything else assembles objects the architecture already defines — which is
the intended ratio, per the corpus's own rule that new components are admitted reluctantly.

## Appendix B — Speculative

**Contains no findings. Nothing above depends on anything here.**

- Whether a collaboration that survives all seven bands would be experienced as a *relationship*
  rather than as a very good tool is not determinable from anything in this corpus, and may not be
  determinable at all.
- Whether the Interruption Budget should be visible to the user — a partner who can see you are
  running out of standing — is unexamined and cuts both ways.
- Whether coupling quality has a ceiling set by the human's willingness to attend to a second
  agent's state at all is unknown, and would cap every mechanism here simultaneously.
