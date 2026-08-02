# ORIS — Outcome Seam, First-Principles Design

> **What this is:** the design work that must precede ADR-016. Not an ADR. Nothing here is
> accepted; the point is to find the boundary before freezing it.
>
> **Why it gets this treatment:** ADR-014 and ADR-015 were foundational because they settled
> the substrate before implementation. This is the first irreversible decision *after* the
> substrate, and everything downstream — prediction scoring, calibration, reflection,
> competence, belief revision — inherits whatever boundary is drawn here.
>
> **Status:** draft, 2026-08-02. Open questions in §9 are genuinely open.

---

## 1. The question

> When the organism acts, how does it observe the consequences of its own action?

The naive answer, and the one the research programme has been carrying since Finding 0, is:
*the editor emits outcome rows referencing the decision they follow.* Working it through from
first principles, that answer is **wrong in a specific and consequential way**, and the error
is not obvious until ADR-014's own rules are applied to it.

---

## 2. What an outcome is

An outcome is **the world's response to an action**. It is not:

- the system's assessment of its action,
- the user's opinion of the result,
- a verdict on whether the action was good.

Those are interpretations. The outcome itself is a *subsequent observable state change*.

For an editor, the world's response to an AI edit is a **human doing something afterward** —
keeping it, adjusting it, reverting it, ignoring it, shipping it. That is the raw material.
Everything else in this document follows from asking who is entitled to say what about it.

---

## 3. The central finding — restated after review

**The first draft of this section overclaimed, and the error was in the word *outcome*.** It
used "outcome" as a synonym for *evaluation*, and under that definition the claim "nothing
observes an outcome" is true but circular — it redefines an ordinary word to win an argument.

There are objective consequences. *The project was exported.* *An undo was committed.* *The
subtitle was deleted.* Nobody inferred those; they happened, and a surface witnessed them.

The corrected structure is four layers, not two:

```
OBSERVATION            "an export completed at T"              witnessed · owned by a producer
      ↓
OBSERVED CONSEQUENCE   "…which followed that grade"            SOMETIMES witnessed (§4),
                                                                usually derived
      ↓
DERIVED INTERPRETATION "…and the grade survived to delivery"   always derived
      ↓
OUTCOME ASSESSMENT     "…therefore the grade was accepted"     always derived
```

The load-bearing subtlety is that **layer 2 is the one that splits**. A consequence is only a
consequence *relative to something*, so it always requires a linkage — and whether that
linkage was itself witnessed is exactly the observed/inferred distinction in §4. Sometimes it
is an observation (the undo affordance was bound to that commit). Usually it is a view.

So the corrected claim is narrower and survives:

> **Layers 1 and the witnessed part of layer 2 are recorded. Layers 3 and 4 are never
> recorded, at any latency, under any window.**

The rest of this section shows why the naive design collapses layers 1–4 into one row.

## 3.1 Why the naive row is wrong

Apply ADR-014 E6 (*a producer may observe only its own boundary*) and E11 (*observations,
never classifications*) to the naive design:

```
editor emits:  { kind: "rejected", refDecision: "xp-...", param: "saturation", delta: -12 }
                       ▲                    ▲
                       │                    │
              a CLASSIFICATION     an INFERENCE
```

**The editor observed neither.** It observed a slider moving. Whether that constitutes
*rejection*, and whether it was a response to *that* decision, are both interpretations laid
on top — and under E6 the editor has no standing to make them, exactly as the AI has no
standing to report acceptance.

What the editor actually observes is narrow and completely factual:

> *A user-initiated mutation occurred, on these targets, with these parameters, at this time,
> through this registry action.*

That is an observation. `rejected` is a conclusion drawn from it later, under a policy that
will change.

> **The producer is not an "outcome producer." It is a user-action producer.**
> Outcome *assessments* are a view over observations, computed at read time.

Which also fixes the producer ontology. The taxonomy is not a list of concepts —
`AI producer`, `outcome producer` — it is a list of **observers**, each named by what it
witnesses:

```
AI decision producer        witnesses its own deliberation and act
User action producer        witnesses committed user mutations
System event producer       witnesses lifecycle: session, build, upgrade
Environment producer        witnesses device, storage, network state          (future)
Ledger producer             witnesses its own claims                          (future)
```

That is E6 restated as an ontology rather than a rule, and it yields the admission test for
any proposed producer: **name what it directly witnesses.** "Reflection producer" fails —
reflection witnesses nothing, it computes. "Outcome producer" fails for the same reason.

This is the same move ADR-015 D10 makes for beliefs (state at runtime, view across time) and
the same move the segmentation design makes for episodes (store the signals, cut the
boundaries at read time). Finding it a third time is mild evidence the rule is real rather
than a preference.

---

## 4. Observed linkage vs. inferred linkage

The above would be too strong if it claimed *all* causal linkage is inference. It is not, and
the distinction is the sharpest thing in this design.

| | Example | Who observed it | Recordable? |
|---|---|---|---|
| **Observed linkage** | User clicks Undo on the commit the AI just made; user clicks 👎 on *this* result; user reverts *this specific* undo-stack entry | The editor genuinely observed the causal attachment — the affordance was bound to that commit | **Yes** — it is an observation |
| **Inferred linkage** | A saturation slider moves 40 s after an AI grade, on the same layer | Nobody. Proximity is not causation | **No** — derive at read time |

So an action row may carry a causal reference **only when the causal attachment was itself
observed**, and must carry nothing when it was not. An empty reference is not missing data
here — it is the honest statement that no causal link was observed, and it leaves the
derivation free.

Getting this wrong in either direction is costly. Recording inferred links as observed
poisons attribution permanently. Refusing to record observed links throws away the highest-
quality causal evidence the system will ever get.

---

## 5. Why a verdict can never be stored

Two properties of outcomes make any stored verdict wrong:

**One decision has many outcomes.** Kept now, adjusted in ten minutes, shipped on Thursday,
reverted next month. There is no single terminal verdict, and there never will be.

**Outcomes arrive unboundedly late.** *Survived to delivery* is observable days later. Any
fixed window that classifies at its close — "no correction within 60 s, therefore accepted" —
is a claim that tomorrow's revert falsifies, written into an append-only store that forbids
correction.

Both collapse to the same conclusion:

> **"The outcome of a decision" is a read-time query over a window, not a stored field.**
> Different questions want different windows — immediate rejection, durable acceptance,
> shipped-in-the-final-cut — and storing raw actions lets every window be applied
> retroactively, while storing a verdict freezes exactly one.

---

## 6. Where the observation point is — for editor mutations

**Corrected after review: the registry is the observation point for *editor mutations*, not
for consequence in general.** The first draft said "the observation point," which would have
frozen a hole into the architecture. Several real consequences never cross the registry:

```
filesystem import · autosave · render/export completion · cloud sync ·
collaboration events · plugin-side mutations
```

The general law is **not** "everything passes one seam." It is:

> **Every observation has exactly one natural owner.**

The registry is the natural owner of *committed timeline mutations*. It is not the natural
owner of an export finishing, and forcing it to be would either lose that observation or make
the registry lie about what it witnessed — the E6 violation in a new costume.

Within its own domain, the registry is the right seam for reasons that are not coincidental:

- **It is the sole path for timeline mutation.** Registry-only mutation is law (ORRERIS_OS
  invariant 1), so no timeline mutation can escape observation. The "no holes" claim is real,
  but it is bounded to that domain — which is narrower than "consequence," and the first
  draft's argument overreached by exactly that gap.
- **It already sees authorship.** AI-initiated and user-initiated mutations both cross it,
  which makes *who acted* an observation rather than an inference — and that is precisely the
  signal §4 needs.
- **Its grain is already the right grain.** The registry operates on committed, undoable
  transactions. Recording every intermediate drag frame would be enormous and mostly noise;
  recording only committed transactions matches both the undo model and the unit a human would
  call "a change."
- **It is already the explainability boundary**, so observation there is consistent with how
  the rest of the system accounts for itself.

The cost is that the registry is the most load-bearing component in the product. Observation
attached to it must be strictly non-blocking, failure-isolated, and incapable of altering
mutation semantics — the same rule already applied to the stream append, held harder.

---

## 7. What the producer emits (conceptually)

Not a schema — the shape of the claim:

```
"A mutation was committed."
    who initiated it        user | ai | system      ← observed
    which registry action   the action's identity   ← observed
    what it targeted        layer/clip identities   ← observed
    what changed            params, before → after  ← observed
    was it an undo/redo     and of which entry      ← observed
    observed causal link    only if the affordance was bound to a prior commit (§4)
    situation               the standing context, snapshotted
```

Everything there is something the registry directly witnesses.

---

## 8. What it never contains

- A quality judgment — *good*, *bad*, *better*
- An outcome class — *accepted*, *rejected*, *ignored*
- An error class or tier — the value hierarchy is applied at read time, and its taxonomy is
  expected to change
- A confidence
- An attribution to any belief
- Any inference about the user's intent
- Any causal reference that was not directly observed

The general form: **the producer records what happened; it never records what it meant.**

---

## 9. Open questions — resolved 2026-08-02 against ADR-016 I1–I14

> **Resolution pass.** Q1–Q7 were worked against the accepted integrity contract, and the
> empirical ones were answered by reading the registry rather than reasoning about it (§12).
> Two answers **contradict this document's own §4 and §6**. Corrections are in §12; the
> original text is left standing below, because a design doc that quietly agrees with whatever
> was found later is worth nothing.
>
> **No F1–F4 exception fired.** All seven resolve by paying costs ADR-016 anticipated:
> read-time derivation, honest absence, and coverage recording. See §13.

**Q1 — Parameter granularity. RESOLVED: the action's own params are the grain.**
The registry's `after` is a whole composition, so a before→after diff at that seam is exactly
the unusable extreme the question feared. But the action's *arguments* are already the right
grain and are already witnessed — `("setEffectParam", { layerId, param, value })` is precisely
*"they reduced my grade by 20%"*. So the answer is not a line drawn per action type; it is that
**the params are the observation and the composition is not.** No policy, no threshold, and the
grain question dissolves.

**Q2 — Is `user` vs `ai` initiation knowable at the registry? RESOLVED: NO.** See §12.1. This
is the §6 argument weakening exactly as the question anticipated. It does not force an
exception: what the registry witnesses is *what the caller declared*, which is admissible, and
`user` is recorded only where a surface genuinely observed a human. Everything else is
`unattributed`, which is honest rather than missing.

**Q3 — Do non-registry consequences need a producer? RESOLVED: YES, and sooner than expected.**
Not only export/import/sync — there is a second *timeline* mutation path inside the editor
itself (§12.3). Under I12 an uninstrumented path is a coverage hole that must be **stated in
the corpus**, not merely known to the team. This is I12 earning its place on the first
producer, which is the strongest evidence so far that it was worth insisting on.

**Q4 — Undo semantics. RESOLVED: an undo is NOT currently attributable.** See §12.2. This
retracts the strongest example in §4's "observed linkage" column. Under I2 the link is simply
not recorded; the derivation moves to read time, and the capability is recoverable only by a
product change that binds undo entries to the commits that created them.

**Q5 — Volume. PARTIALLY RESOLVED.** The grain is committed transactions, so drag frames are
not automatically rows — but whether a slider commits per-frame or per-gesture is not settled
by the registry's shape and remains pressure point #1. The ADR-016 answer stands regardless:
sampling is permitted, an unrecorded sampling policy is not.

**Q6 — Does the AI's own commit produce a user-action row too? RESOLVED: YES, deliberately.**
The executor calls the same `runAction`, so one event is witnessed by two producers from two
boundaries. That is correct under I2 — both are honest about what they saw — and the
double-counting risk lives at read time, where a view must decide whether it is counting events
or observations. It is not a write-time problem and must not be "fixed" by suppressing a row.

**Q7 — Clock trust. RESOLVED by I5/I7.** Linkage derivation runs on `seq`, never on `t`.
Cross-recorder ordering is a derivation under a named policy. Nothing further is owed here.

---

## 9.1 Original open questions (superseded, retained)

1. **Parameter granularity.** "Before → after" for a whole composition is unusable; for a
   single scalar it is ideal. Where is the line, and is it per action type? This decides
   whether the corpus can answer *"they reduced my grade by 20%"* or only *"they changed the
   grade."*
2. **Is `user` vs `ai` initiation always knowable at the registry?** If some paths lose
   authorship, the boundary has a hole and §6's main argument weakens.
3. **Do non-registry consequences need a producer?** Export, delivery, project close, and
   file-level operations are outcomes that may not cross the registry. If so, either the
   registry is not the only observation point, or those become a separate producer.
4. **Undo semantics.** An undo of an *AI* commit is the strongest rejection signal available.
   Is that always distinguishable from an undo of a user commit at the registry, including
   across grouped/batched transactions?
5. **Volume.** Every committed mutation is far more traffic than every AI decision. Does the
   retention bound survive it, and does the answer change §6?
6. **Does the AI's own commit produce a user-action row too?** Arguably yes — it is a
   mutation — and then a decision row and an action row describe the same event from two
   producers' standpoints. That is probably correct and should be deliberate, not accidental.
7. **Clock trust.** Causal derivation depends on ordering, and wall-clock time is
   user-settable. Sequence is trustworthy; timestamps are not. Does linkage derivation need
   to run on sequence alone?

---

## 10. Risks

**The seam is in the most dangerous file in the product.** Any regression in registry
behaviour is a data-integrity bug in the user's project. This argues for observation being
strictly additive and independently disableable.

**Volume may force retention changes**, which under ORIS-17 cannot be answered by weakening
provenance. Q5 must be answered before, not after.

**Deriving linkage is a research problem, not a lookup.** §3 moves the difficulty from write
time to read time — it does not remove it. The upside is that the difficulty becomes
*revisable* instead of frozen, which is the whole argument; the downside is that nothing is
free at the end of it.

---

## 11. What this changes about ADR-016

If §3 holds, ADR-016 is not "Outcome Observation Architecture." It is closer to
**"User-Action Observation, and why outcomes are derived."** The ADR's central decision would
be the refusal to store outcomes at all — which is a stronger and more useful thing to freeze
than a schema for outcome rows.

That is the claim to attack before anything is written.

> **Outcome, 2026-08-02:** §3 held. Integrity was extracted into ADR-016 and accepted first;
> this producer becomes **ADR-017 — User-Action Observation**, and the refusal to store
> outcomes remains its central decision.

---

## 12. What the registry actually shows (empirical, 2026-08-02)

Read from `editorStore.ts`, not inferred. Two findings contradict §4 and §6 of this document.

### 12.1 Initiation is DECLARED by the caller, not witnessed by the registry

```
runAction: (actionId, params, options?: { ai?: boolean }) => RegistryOutcome
```

`ai` is an **optional argument the caller supplies**. A UI control calls `runAction(id, p)` and
`options.ai` is `undefined`; the executor calls `runAction(id, p, { ai: true })`. So the
registry never observes who acted — it observes *what it was told*, and it is told nothing in
the default case.

Therefore `!options.ai ⇒ user` is an **inference, and recording it as observation is exactly
the I10 fabrication pattern**: `undefined` means *the caller did not say*, not *a human did
this*. Two honest observers disagree immediately — one reads it as "a user acted," the other as
"nobody declared anything," and both are reasoning correctly from the same data.

The admissible field is therefore three-valued and describes the declaration, not the actor:

```
ai            the caller declared AI initiation          ← witnessed
user          a surface that genuinely saw a human said so ← witnessed, where wired
unattributed  no declaration was made                     ← witnessed (the absence is the fact)
```

`unattributed` is not missing data. It is the accurate record of what the seam knows, and it
leaves attribution free to be derived — or to be made witnessable later by widening the
declaration, which is a product change with a known shape.

### 12.2 The undo stack holds compositions, not commits

```
undoStack: TimelineComposition[]      // whole-composition snapshots
undo(): pops the previous composition; nothing names the action that produced the entry
```

An undo restores a **snapshot**. No binding exists between an undo and the commit whose effect
it reverses, so *"the user undid the AI's edit"* — §4's headline example of **observed**
linkage, and the strongest rejection signal the design hoped for — **is not observable at this
seam today.** §4's table is wrong on its own primary case.

Under I2 the consequence is immediate and unarguable: the causal reference is not recorded, and
the link is derived at read time from ordering and content, with all the uncertainty that
carries. The capability is not lost forever — binding undo entries to the commits that created
them would make it genuinely witnessed — but it is a product change, not an observation
change, and ADR-017 must not assume it.

This is the single most valuable thing this pass found, because the naive design would have
recorded the link confidently and been wrong in a way nothing downstream could detect.

### 12.3 There is a second timeline mutation path

`applyComposition` is exposed on the store and mutates the composition **without passing
through `runAction`** (tool Apply uses it; `recordHistory: false` skips history entirely).
`setComposition` clears both stacks.

So "registry-only mutation is law" is narrower in practice than §6 assumed — the hole is not
merely export and import, it is inside the timeline domain. Under I12 this must be recorded as
a coverage gap **in the corpus**, so that a future analysis reading a period with no rows from
that path can tell "nothing happened" from "nothing was watching."

---

## 13. Stress-test result against the ADR-016 pre-registration

Checked against `ORIS_RESEARCH_PROGRAMME.md` §11.4.

| Criterion | Fired? | Why |
|---|---|---|
| **F1** inexpressibility | no | every witnessed fact found is representable; the two contradictions are cases where the fact *was not witnessed*, which is a seam limit, not a model limit |
| **F2** recurrent exception | no | no carve-out was requested by any of the seven |
| **F3** impracticability | no | the costs paid are the three ADR-016 anticipated |
| **F4** unfalsifiability | **no — and this is the notable one** | I2, I10 and I12 each came close to binding, on Q2, Q4 and Q3 respectively. Clauses that bite are not decoration |

**Corroboration shape matched.** All seven resolved by moving complexity into read-time
derivation (Q4, Q6, Q7), honest absence (Q2), and coverage recording (Q3) — the exact three
escape routes ADR-016 provides, with no exception introduced.

One caveat against over-reading this: the pass covered the *design*, not an implementation.
Pressure point #1 (gesture coalescing, Q5) is only partially resolved and is the most likely
remaining source of an F3, because it is where volume meets provenance. It should be settled
with a measurement, not an argument.

> **Settled by measurement, 2026-08-02 — see §14.** Coalescing already exists. Pressure point
> #1 did not fire.

---

## 14. Q5 measured, not argued (2026-08-02)

Instrument: `apps/web/src/editor/oris-write-probe.ts` (gated on `?orisWriteProbe=1`) at the
graph write choke point; harness `apps/worker/src/oris-write-grain-probe.ts`, driving the real
editor through the real product flow with real pointer gestures.

| Gesture | Pointer moves | Graph writes | History |
|---|---|---|---|
| **Clip drag** | 20 | **1** | recording |
| **Playhead scrub** | 21 | **0** | — |
| **3× undo + 3× redo** | — | **2** | **both suppressed** |

### 14.0 RESULT: the two gesture families have different commit grains

Measured, after expanding the inspector (it defaults to collapsed, `useState(true)`, which is
why three earlier runs found no control and read as "no parameter control exists"):

| Gesture | Pointer moves | Graph writes | Undo entries | Median gap |
|---|---|---|---|---|
| Clip drag | 20 | **1** | 0 | — |
| **Parameter drag (scrubpad)** | 20 | **20** | **19** | 943 ms |
| **Parameter drag (range slider)** | 20 | **17** | **16** | 960 ms |
| Playhead scrub | 21 | 0 | 0 | — |
| Undo + redo | — | 2 (suppressed) | — | — |

**Pressure point #1 fires.** A parameter drag writes *per pointer-move*, each write recording
history. The timeline path coalesces; the parameter path does not.

**F3 does not fire, and the distinction matters.** The finding is not that ADR-016 over-
constrains the system — it is that the *editor* is internally inconsistent: two gesture families
with two different commit grains, and no policy anywhere that chose it. The integrity model's
answer stands unchanged (sampling is permitted; an unrecorded sampling policy is not), and a
better option exists than sampling: make the parameter path coalesce the way the timeline path
already does.

**This is a product defect, discovered by the ORIS instrument and independent of it.** Nineteen
undo entries for one slider drag means nineteen `Ctrl+Z` presses to undo one adjustment. The
~950 ms median gap between writes — against a 16 ms input cadence — says each write is
serialising behind something slow, so a single drag also produces ~20 persisted graph versions.
Neither is an ORIS problem; both are consequences of the same missing coalescing.

**Consequence for ADR-017:** the producer cannot be specified until this is decided, because the
answer changes what a "committed transaction" *is*. Two routes:
1. **Fix the grain** — coalesce parameter gestures at the choke point. The corpus grain, the
   undo UX, and the write volume are all corrected by one change, and ADR-017 then records
   committed transactions with no sampling policy at all.
2. **Record the raw stream and coalesce on read** — admissible under ADR-016 (the raw writes
   *are* witnessed), but it pushes gesture reconstruction into every future analysis and
   inflates the corpus by ~20× on the most common editing gesture.

Route 1 is better on every axis and is a product fix rather than an architectural concession —
but it is a change to shipped editor behaviour and is not this document's call to make.

### 14.0.1 Route 1 implemented and re-measured

`apps/web/src/editor/gesture-scope.ts` gives the parameter path the gesture concept the
timeline already had. Values still commit per pointer-move — live preview depends on it, and a
controlled React input cannot use the timeline's imperative approach — so what coalesces is the
**history entry**: the first write in a gesture records the pre-gesture state and the rest amend
it.

| Gesture | Undo entries BEFORE | AFTER |
|---|---|---|
| Parameter drag (scrubpad) | 19 | **1** |
| Parameter drag (range slider) | 16 | **1** |
| Clip drag | 0 (already 1 write) | unchanged |
| Playhead scrub | 0 | unchanged |

Outside a gesture `shouldRecordHistoryEntry()` is unconditionally true, so every pre-existing
caller behaves exactly as before — which is what makes this safe to add at the write choke
point.

**Two of the four hoped-for benefits landed; two did not, and the difference matters to
ADR-017.**

*Landed:* one gesture → one undo entry, and one gesture → one semantic transaction.

*Did not land:* **write volume is unchanged** (still 20 and 17 graph writes), because the
writes drive the live preview and only the history push was coalesced. The median gap between
writes also stayed at ~1000 ms against a 16 ms input cadence, so a single parameter drag still
issues ~20 graph writes that serialise over ~20 s. That is a genuine performance defect, it is
**separate from the grain problem**, and it is not fixed here — conflating the two would have
meant a much larger change to the most load-bearing file in the product.

**The signal ADR-017 must key on, stated precisely:** after this change `recordHistory !== false`
is still true for all 20 writes — the coalescing happens *inside* that branch. The property that
now means "one committed transaction" is **whether an undo entry was actually pushed**, i.e.
whether `shouldRecordHistoryEntry()` returned true. A producer keying on `recordHistory` would
still see 20 transactions per drag and would be wrong.

### 14.0.2 The declaration seam

Q1 (grain content) and Q2 (initiator) were resolved in §9 against the **registry**, and §12 then
established that the registry is not the human path. Both resolutions were therefore invalid,
because at `updateGraph` there is no action identity, no params, and — since
`commitComposition: (after) => updateComposition(after)` discards `{ ai: true }` — no
authorship either. An AI commit and a human commit were indistinguishable at the only boundary
both cross.

`CommitIntent` (`editor/gesture-scope.ts`) is the fix: an **optional** declaration threaded
`updateComposition → updateGraph`, carried by callers that genuinely know and absent everywhere
else. Absence is a reading, not a gap.

Verified by probe: human parameter drags record `{"undeclared": 20}` and `{"undeclared": 17}`.
**Not yet verified: that an AI commit records `ai`.** The wiring is in place and typechecks, but
the probe does not drive the AI panel, so only the negative case is measured. A probe that
confirms absence proves nothing about presence — the same asymmetry as I13.

**Why `undeclared` is still useful, and does not become a fabrication.** The AI commit paths
are enumerable and few. If every one of them declares, then "undeclared at a committed write"
licenses the *derivation* "not AI-initiated" — at read time, under a named policy, justified by
a **recorded coverage fact** (I12): *this build declared AI initiation at N sites*. The
attribution is never written as evidence; what is written is the declaration and the coverage.
This is the first concrete payoff from insisting on I12, and it is what turns an honest absence
into usable evidence instead of a permanent hole.

### 14.0.3 Q1 settled — operation identity is preserved, not recovered

Identity now travels with the commit instead of being reconstructed from whole-composition
diffs: `CommitIntent.actionIds` is threaded `registry → commitComposition → updateComposition →
updateGraph`. `PlanExecutor` passes `[step.actionId]`; the chat panel passes the whole list it
executed.

**It is a list, not a scalar** — the chat panel runs several registry actions and commits once,
so a scalar would silently have recorded only the last one. That is the kind of quiet loss this
whole pass exists to catch, and it was visible only by reading the call sites.

*Human-side operation identity remains absent.* The 57 `updateComposition` call sites each know
their own operation and none declares it. That is a much larger question than the AI seam and is
deliberately not answered here; under I12 the honest position is that the corpus records the
gap rather than guessing at it.

### 14.0.4 STILL UNVERIFIED: that an AI commit declares itself

The probe now drives the real AI panel. Result: panel opened, prompt sent, **zero graph
writes**, so no commit occurred and the positive case is **inconclusive — not confirmed**.

The wiring typechecks and is four call sites, but that is exactly the evidence this programme
does not accept. Until an AI apply is observed carrying `initiator: "ai"`, the declaration seam
is verified in the negative direction only: human gestures correctly read `undeclared`. Nothing
should be built on the assumption that the positive direction works.

What would settle it: an AI prompt that actually reaches an apply in a blank one-clip project
(the probe's "make it moody" did not), or driving `commitComposition` directly.

### 14.1 Why the earlier generalisation was wrong (retained)

Twenty pointer-moves on a clip produce **one** graph write. For that gesture the design's
hoped-for property is a measured fact rather than something to engineer.

**This does not generalise, and the first draft of this section wrongly said it did.** The
measurement covers one gesture family. Parameter drags are a different code path —
`NumberControl.handlePadPointerMove → commitValue → onChange`, which fires *per pointer-move*
— and that is precisely the shape pressure point #1 is about. Two attempts to measure it found
no inspector control present: with a clip selected the panel renders `0` scrubpads and `0`
range inputs, because it needs the Effects tab open and an effect on the layer, which the probe
does not reach.

```
measured    clip drag        20 moves → 1 write      coalesces
measured    playhead scrub   21 moves → 0 writes     not a mutation
measured    undo / redo      → 2 writes, history-suppressed, distinguishable
NOT MEASURED  parameter drag  ← pressure point #1 lives here
```

**Consequence for ADR-017:** on the evidence available the producer records committed
transactions and needs no sampling policy — *for timeline gestures*. Pressure point #1 is **not
cleared**. If parameter drags write per-move, the volume and provenance trade-off is live after
all, and F3 becomes reachable.

The generalisation is exactly the error this pass exists to catch: one gesture family measured,
a second assumed to behave the same because it would be convenient. Closing it needs a probe
that opens the Effects tab and adds an effect first.

### 14.2 Transport is not a mutation

Twenty-one scrub moves produce **zero** graph writes. Moving the playhead never enters the
corpus. This kills the volume concern at its source: the highest-frequency interaction in a
video editor is not a mutation at all.

### 14.3 Undo/redo IS witnessed, and is distinguishable

Undo and redo write through the same choke point with `recordHistory: false`. So the seam
witnesses *that an undo occurred*, distinguishably from an ordinary edit, by a property already
present.

This does **not** revive §12.2. What is witnessed is that an undo happened, never *what it
undid* — the stack still holds compositions, not commits. But it is more than §12.2 implied:
the event is observable even though its target is not, which is precisely an ADR-016 I2 split
between an admissible occurrence and an inadmissible interpretation.

*Instrument caveat, recorded because it nearly became a finding:* the probe was first placed
**inside** the history-recording branch, making history-suppressed writes invisible — and the
first run duly reported "undo does not write." The number was wrong for a reason that had
nothing to do with the system. Both defects in this instrument (this one, and the lazily
installed global that the harness's proof-of-life check caught) were in the measuring
apparatus, not the measured system — which is the fourth time today that pattern has appeared.
