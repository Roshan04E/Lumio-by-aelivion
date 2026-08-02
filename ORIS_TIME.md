# ORIS Temporal Cognition — v0

> **What this file is:** the specification of time inside ORIS — two clocks, seven bands,
> the asymmetry between past and future, and episode segmentation. Time was absent from the
> founding hypothesis and from v1 of the architecture; it turns out to be the coordinate that
> makes several other mechanisms simplify.
>
> **Position in the calculus:** time is not a state variable — it is the **second coordinate
> of every state variable and every operator** (`band`), and the clock in which decay,
> recency, and consolidation are computed (`τ`). Law L7 (band coherence) is stated here in
> full. See [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §2, L7.
>
> **Status:** v0, 2026-08-02. **Band boundaries and episode segmentation are the two things
> most likely to be wrong** (ORIS_CALCULUS.md §7, items 2–3).

---

## 1. Two clocks

A mind does not run on wall-clock time, and building one that does produces a system whose
memory is wrong in a way that is hard to diagnose.

```
t   WALL-CLOCK          seconds since epoch. Used for: scheduling, budgets, deadlines,
                        anything the body or the OS cares about.

τ   SUBJECTIVE TIME     advances on surprise-weighted change, not on duration.
                        Used for: decay, recency, consolidation triggers, episode
                        boundaries — everything cognition cares about.
```

`τ` advances roughly as accumulated prediction error and consequential action, so an
idle hour advances it barely at all while a dense hour of contested editing advances it a
great deal.

### 1.1 Why this matters concretely

The users this product is built for do not work on a uniform schedule. A freelancer may edit
intensively for nine days and then not open the app for five weeks. Under wall-clock decay:

- five quiet weeks erode hard-won knowledge that nothing contradicted, and
- nine dense days barely age anything, so contradicted beliefs linger.

Both are backwards. Under `τ`, **memory ages with experience rather than with absence**,
which is both the correct engineering behaviour and what the phenomenology reports. ACT-R's
base-level activation (ORIS_ARCHITECTURE.md §5.3, §13.2) is computed in `τ`, not `t`.

> **The one place `t` must win:** anything the user perceives. "You last worked on this three
> weeks ago" is a wall-clock statement, and expressing it in subjective time would be
> nonsense. `τ` governs cognition; `t` governs communication and scheduling.

---

## 2. The band ladder

Seven bands. Each is defined by two numbers — how often it updates (**period**) and how far
it reaches in either direction (**reach**) — and these are correlated but not identical.

| Band | Period | Reach back | Reach fwd | What lives here | Operators |
|---|---|---|---|---|---|
| **B0 Somatic** | frame (~16 ms) | ~1 s | ~1 s | interoception, health graph, proto-self | `sense` |
| **B1 Situational** | 1–5 s | minutes | seconds | workspace, σ, core self, attention | `bind` `act` `compare` |
| **B2 Task** | minutes–hours | this session | this task | intentions, episode assembly, working goals | `believe` `expect` `attribute` `adapt` |
| **B3 Project** | days–weeks | project history | delivery | project beliefs, client norms, genre priors | `consolidate` |
| **B4 Dispositional** | months | many projects | next projects | skills, habits, user model, competence | `consolidate` `modulate` |
| **B5 Identity** | years | autobiography | who I remain | commitments, inherited values | `promote` `revoke` |
| **B6 Constitutional** | never | — | forever | operators, T0 values, credit machinery, the blanket | **none** |

Three structural observations:

1. **B6 has no operators.** That is not an oversight — it *is* the definition of the
   constitutional band, and it means ORIS_CALCULUS.md L9 ("closure of the modifiable set")
   is not an extra rule but a restatement of the ladder's top rung.
2. **The code/data line falls exactly at B5/B6.** B6 is byte-identical on every
   installation; B0–B5 is the portable psyche volume. ORIS-7 ("divergence is data, never
   code") is therefore also a consequence of the ladder rather than an independent
   commitment.
3. **`consolidate` appears in two bands** because it is the bridge — the only operator, with
   `promote`, permitted to move information upward (§2.2).

### 2.1 Reach ≈ k × period

Fast systems reach shortly; slow systems reach far. This is not a coincidence but a design
constraint: a process that updates every 16 ms cannot usefully reason about next year, and a
process that updates yearly cannot respond to this frame. A proposed subsystem whose period
and reach are mismatched by orders of magnitude is almost certainly two subsystems.

### 2.2 L7 — Band coherence, in full

> **No operator writes to a band slower than its own. An operator may read its own band or
> slower. `consolidate` and `promote` are the sole upward channels, and both are offline and
> gated.**

The two directions do different work, and both are needed:

```
READING DOWNWARD (slow → fast) — always permitted
  identity constrains the moment; values constrain the action;
  project norms constrain the task.
  This is how a persistent system stays coherent from second to second.

WRITING UPWARD (fast → slow) — forbidden, except through two gated channels
  a single session cannot rewrite who the system is.
  This is the structural defence against premature identity, and it is why
  ORIS-10 (no epoch before calibration) does not need separate enforcement.
```

Without the downward read, identity is inert decoration. Without the upward prohibition, one
bad afternoon becomes character. **Most agent-memory systems have neither rule**, which is
why they oscillate: they write user preferences straight into long-term storage from single
interactions, and then read them back with no notion of how much evidence stands behind them.

---

## 3. Episode segmentation

`bind` must decide whether the present moment continues the current episode or starts a new
one. This is the single least-solved mechanism in the whole architecture, and the honest
position is that **human event segmentation is not understood well enough to copy.**

What we can do is enumerate the candidate boundary signals that Orreris actually emits, and
let Epoch 0 data decide their weights rather than guessing them now:

```
STRONG candidates          project switch · export started · session end ·
                           long idle (in t, not τ) · explicit save/version
MEDIUM candidates          intent-class change (grading → cutting) ·
                           timeline region jump · tool/workspace change ·
                           an undo cluster (≥3 undos in a short window)
WEAK candidates            playback stop · panel change · single undo
ANTI-SIGNALS              (things that look like boundaries and are not)
                           a clarify question · a pause to watch playback ·
                           scrubbing · an idle spell inside continuous work
```

The anti-signals matter more than they look. Naive segmentation on "user stopped typing"
would shred a single creative act into dozens of episodes, and episode count directly drives
consolidation thresholds — so bad segmentation does not merely mis-file memories, it
**miscalibrates every promotion threshold in the system.**

> **Design position, held loosely:** segment on *goal change*, not on activity gaps. An
> episode is a bounded attempt at something with an outcome attached. This is testable
> against Epoch 0 data by checking whether episode-level statistics predict user corrections
> better than fixed-window statistics do. If they do not, this section is wrong.

---

## 4. Past and future are not one axis

They meet at the present but they are different structures, stored differently, produced by
different operators, and subject to different failure modes.

```
                    ← PAST                 NOW                 FUTURE →
structure        one branch, lossy       σ (bound)        many branches, pruned
data             sampled + compressed    workspace         generated on demand
operator         consolidate             bind              simulate
grows by         accumulation            —                 branching
bounded by       eviction + ceilings     capacity limit    budget + depth limit
failure mode     confabulation           thrash            combinatorial explosion
```

Two consequences that are easy to miss:

**Storing the past and simulating the future are not symmetric operations.** The past is a
compression problem (what can I throw away); the future is a search problem (what can I
afford to consider). Architectures that treat memory as "prediction in both directions"
usually get one of the two badly wrong.

**Identity spans both directions.** ORIS_ARCHITECTURE.md §10.6 argues that a commitment has
a consolidated past face (the evidence) and a projected forward face (the refusal). In this
frame that is not a metaphor: identity is the only structure that occupies band B5 on **both
sides of the present**, which is exactly why it can both explain what has happened and
constrain what will.

### 4.1 The near/far future split

The review proposed distinguishing near from long future. This is right, and the distinction
is operator-level rather than cosmetic:

```
NEAR FUTURE   (B1–B2, seconds to hours)
  simulate with the deterministic renderer → EXACT outcomes, no model bias
  used by: expect, act
  cost: compute only

LONG FUTURE   (B4–B5, months to years)
  simulate against held-out history with a perturbed self → APPROXIMATE, biased
  used by: promote (the ORIS-15 rehearsal)
  cost: replay, and an off-policy-evaluation bias that is currently unbounded
        (ORIS_CALCULUS.md §8.3)
```

The confidence gap between these two is enormous and must never be elided. Near-future
simulation is trustworthy enough to act on. Long-future simulation is trustworthy enough to
*inform* a promotion, and nothing more — which is precisely why ORIS-15 makes rehearsal a
*gate* on promotion rather than a *trigger* for it.

---

## 5. Developmental time

The epochs of ORIS_ARCHITECTURE.md §14 are the ladder unlocking from the bottom.

```
Epoch 0  Instrumented    B0–B2 live · E and P recording · nothing above B2 writes
Epoch 1  Calibrated      B3 opens: project-scoped beliefs, calibration per domain
Epoch 2  Preferenced     B4 opens for weights only: fast-stratum, fully reversible
Epoch 3  Skilled         B4 opens for procedural compilation: context-guarded reflexes
Epoch 4  Disposed        B5 opens: promotion ceremony live, identity stratum begins
Epoch 5  Characterful    B5 populated; installations measurably diverge
B6 never opens.
```

This makes the developmental gate mechanical rather than a matter of judgement: **an epoch
is a band becoming writable.** ORIS-10 ("no epoch before the previous is calibrated") is then
enforced by a single permission check, not by a review meeting.

It also makes the safest possible starting position obvious and cheap: **run with everything
above B2 read-only for a long time.** Full instrumentation, zero adaptation, no risk of
premature identity, and it produces exactly the corpus needed to settle §3's segmentation
question and §2's band boundaries empirically.

---

## 6. Open questions

1. **Is `τ` scalar or per-band?** A single subjective clock is simpler, but plausibly wrong —
   somatic and identity time may run at genuinely different rates. Per-band `τ` complicates
   every decay computation and every cross-band comparison.
2. **What exactly advances `τ`?** "Surprise-weighted change" is under-specified. Candidates:
   summed attributed error, count of consequential actions, information gain. Different
   choices produce materially different forgetting curves.
3. **Episode segmentation** (§3) — the largest open problem in the architecture.
4. **Are the B2/B3/B4 boundaries real?** Drawn by intuition. Real boundaries are wherever
   consolidation statistics show natural separation, which is measurable but not yet measured.
5. **Sleep scheduling.** Consolidation must run offline, but a browser-resident system has no
   guaranteed offline period — the user closes the tab. Is consolidation opportunistic
   (idle-time, interruptible, resumable) or deferred to explicit session end? Interruptible
   consolidation risks partial commits into slow bands, which L7 exists to prevent.
6. **Does a long absence deserve special handling?** Under `τ`, five weeks away costs almost
   nothing. But the *world* changed — the user's taste, their clients, their skills. There may
   need to be a "re-entry" procedure that reduces confidence in user-model beliefs on
   wall-clock grounds, which would be the one place `t` legitimately drives cognition.
