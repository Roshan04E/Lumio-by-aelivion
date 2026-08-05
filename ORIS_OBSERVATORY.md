# ORIS Observatory — Visible Cognition as a Research Instrument

> **What this file is:** an investigation into whether exposing ORIS's cognition improves
> collaboration, and whether the shipped `?aiThinkingShow=1` panel can serve as the instrument
> that validates — or falsifies — the interaction architecture proposed in
> [`ORIS_INTERACTION.md`](ORIS_INTERACTION.md).
>
> **What this file is not:** a redesign of ORIS, the planner, or cognition. No new state, no new
> operators, no new subsystems, no UI. Where the argument reaches the point at which the next
> question is visual, it stops and says so. The freeze in
> [`ORIS_RESEARCH_PROGRAMME.md`](ORIS_RESEARCH_PROGRAMME.md) §1 is treated as binding, and §7.1
> gives the admissibility argument for everything recommended here.
>
> **Method note.** §3 is an evaluation of the *code as it stands on this branch*, read directly —
> `apps/web/src/components/ai/AiThinkingPanel.tsx`, `apps/web/src/ai/experience/stream.ts`,
> `apps/web/src/ai/decision-trace.ts`, and the three call sites in `AiChatPanel.tsx`. Three
> findings in §3.4 are not recorded in any document and were found by reading the call sites.
>
> **Status:** v0, 2026-08-03. Research document. **Nothing here is shipped or decided.**
> Tags as in the sibling docs: **[PRIOR ART]**, **[NOVEL]**, **[HYPOTHESIS]**.

---

## 0. The three findings, up front

> **1. The panel exposes cognition in the past tense, and presence is a present-tense
> property.** Every row is appended when a decision *finishes*. There is no representation of a
> decision in flight, a hypothesis under consideration, or a wait. Watching a colleague think is
> watching *process*; reading this panel is reading a *log*. That single property — not field
> coverage, not layout — is why it reads as telemetry. (§3.2)
>
> **2. Its correct architectural role is *provenance*, and the properties that make it excellent
> provenance make it hostile as presence.** ORIS-19 forces it to record observations and refuse
> interpretations; ORIS-20 forces every derivation to name its policy. That is exactly right for
> a corpus and exactly wrong for a partner: a presence surface must be *recipient-designed*,
> which means interpreted, summarised, and lossy. The resolution is not to compromise the corpus
> but to recognise that a presence surface is a **view** — and `ORIS_CALCULUS.md` §1.4 already
> declares views free, exempt from the admission test, and forbidden from ever becoming state.
> **No new subsystem is required, and none is proposed.** (§4, §7.1)
>
> **3. The flag is a randomisable treatment with an invariant measurement channel, and this is
> the most valuable property the instrument has.** `?aiThinkingShow=1` gates *the view*; the
> Experience Stream records identically whether or not the panel is mounted (verified:
> `appendDecisionEvent` is called from `decision-trace.ts`, `appendEditCommit`/
> `appendHistoryAction` from `EditorPage.tsx` — none of them consult the flag). So the
> observatory can measure its own effect on behaviour, within-subject, with the dependent
> variable recorded the same way in both arms. Very few research instruments get this for free,
> and none of the experiments in §6 are possible without it. (§6.1)

---

# PART 1 — Why watching a human think increases trust

## 1.1 The question, sharpened

The naive answer — *"transparency builds trust"* — is wrong, or at least uselessly incomplete.
Transparency is not monotonic: watching a surgeon's hands shake reduces trust, correctly.
Watching someone reason through a problem you cannot follow can reduce trust too. So the
question is not *whether* visibility helps but **which visible properties do what work**.

The useful framing is that observing another's thinking supplies things that are otherwise
unavailable at any price, and each has a distinct mechanism.

## 1.2 The seven mechanisms

**M1 · The intervention window.** [The most important, and the most overlooked.] Visible thinking
creates a period *before commitment* during which the observer can redirect cheaply. An editor
who watches a colleague reach for the wrong bin says "not that one" for the cost of three words.
If the same correction arrives after the act, it costs an undo, an explanation, and a small trust
debit. **Visibility converts expensive post-hoc repair into cheap in-flight repair** — the exact
mechanism `ORIS_INTERACTION.md` §3.3 identifies as the most under-implemented in software (IX-8).

Note the consequence, which is decisive for §3.2: **a post-hoc log provides no intervention
window at all.** The mechanism requires present tense.

**M2 · Effort calibration.** Seeing how hard something was teaches the observer what to ask for
next. This is `ORIS_INTERACTION.md` §2.4 and IX-13 arriving from the observer's side rather than
the actor's.

**M3 · Competence evidence via the search, not the answer.** A good answer is weak evidence of
competence — it could be luck or recall. Watching someone *reject* four plausible alternatives is
strong evidence, because it reveals the size and shape of the space they considered. This is why
`candidates[]` (the roads not taken) is disproportionately valuable and why the programme's audit
calls it "the most irrecoverable class in the system" (§12.1 item 4).

**M4 · Model-building, which enables prediction, which enables non-interruption.** Watching
someone work teaches you *how they work*, so you can predict what they will do, so you stop
asking. This is the observer's half of the expectation gap (`ORIS_ARCHITECTURE.md` §9.3): as the
human's model of ORIS converges, both explanation and pre-emptive checking should decline. It
predicts something specific and testable — **visible cognition should reduce prompt volume**, not
increase engagement (OH-3).

**M5 · Failure attribution.** When a visible thinker gets it wrong, you can usually see *where* —
bad input, bad assumption, bad execution. When an opaque one fails, all you learn is "it failed."
The first is survivable and correctable; the second accumulates into distrust of the whole system.
This is the trust-relevant twin of calculus phase ⑦.

**M6 · Common ground accrual.** [PRIOR ART: Clark] Watching someone reason tells you what they
know, which is exactly what you no longer need to say. This is grounding acquired for free — the
cost centre `ORIS_INTERACTION.md` §2.2 identifies as the largest recoverable one.

**M7 · Vicarious learning — the apprentice mechanism.** Craft transmits by watching, and this is
how the assistant editor becomes the editor. It matters here beyond the general case: ORIS-3
obliges ORIS to optimise the *user's* capability rather than its own predictive comfort. **Visible
cognition is a mechanism by which a tool can make its user better rather than more dependent** —
which makes it the first candidate surface with a direct claim on ORIS-3.

## 1.3 The properties, ranked by what they contribute

The brief lists nine. They do not do the same job, and treating them as one bucket is how thinking
displays become noise.

| Property | Primary mechanism | Trust contribution | Failure if faked |
|---|---|---|---|
| **Attention** (what it is looking at) | M1, M6 | **Highest.** Enables joint attention with no utterance; the cheapest to supply and the least intrusive | Reads as surveillance; a false attention display is a lie about the system's state |
| **Uncertainty** | M2, M5 | **High**, but only if calibrated. Uncalibrated uncertainty display is worse than none | Manufactured humility — reads as hedging, then as noise |
| **Revisions** (changed its mind) | M3, M5 | High. Evidence of live evaluation rather than lookup | Theatrical self-correction is the most corrosive fake in the list |
| **Abandonment** (dropped a line) | M3 | High and rare. Nobody shows this; it is the strongest competence signal available | — (nobody fakes it, because it looks bad) |
| **Preparation** (work already done) | M2, M4 | High. `ORIS_INTERACTION.md` IX-15 — the value arrives before the interaction | Claiming preparation that did not happen is an integrity (T0) failure |
| **Timing** (how long, and when) | M2 | Moderate. Honest latency is informative; it is also the most-faked property in the industry | Fake delay is a pure ORIS-2 violation (§2.3) |
| **Confidence** | M2, M5 | Moderate alone, **high when paired with a calibration record** — this is ORIS's differentiator | Unearned confidence is a T0 honesty failure |
| **Hesitation** | — | **Low, and dangerous.** In humans it is an involuntary tell; in software it is always authored | Always theater. See §1.4 |
| **Waiting** (deliberately withholding) | M4 | Moderate. Makes silence legible as a decision rather than absence (IX-5) | Displaying a decision to wait that was not made |

Two observations worth carrying forward. **Attention is the highest-value and lowest-cost property
in the table**, which corroborates `ORIS_INTERACTION.md`'s Candidate E from an entirely different
starting point. And **hesitation is the one property that cannot transfer honestly**: human
hesitation is informative *because* it is involuntary, and nothing a program displays is
involuntary. Any hesitation ORIS displays was authored, which makes it performance, which ORIS-2
forbids. This is a clean, non-obvious ruling that falls straight out of the invariant.

## 1.4 What should never be exposed

Six classes, with the reason each is different from the others.

**N1 · Anything not causally downstream of real state.** The general rule that subsumes most of
§2. If the display would look the same when the underlying state differs, it is decoration.

**N2 · The model of the user, and especially predictions about the user.** *"I expect you will
reject this"* is level-2 theory of mind (`ORIS_ARCHITECTURE.md` §9.3) and exposing it is corrosive
in two independent ways: it invites the user to perform against the prediction (destroying the
measurement), and it shades into manipulation regardless of intent. The *consequences* of the user
model may surface — a better-targeted proposal, a decision to stay quiet. The model itself should
not. **[NOVEL as a ruling; the asymmetry is the point: ORIS may show what it thinks about the
work, and should not show what it thinks about the person.]**

**N3 · Unconsolidated contradictions.** `ORIS_ARCHITECTURE.md` §5.2 requires episodic memory to
*hold* contradictions — "warm here, cool there" — and leaves resolution to consolidation. Exposing
raw contradictory episodes reads as instability, not honesty. The consolidated belief with its
evidence chain is the honest artifact; the unresolved pile beneath it is not a finding, it is a
work-in-progress.

**N4 · Drives and valence as felt states.** ORIS-2, directly. Body state may be reported as
telemetry ("decode pressure high, deferring"); it may never be rendered as mood.

**N5 · Anything whose exposure creates pressure to perform.** [The EURISKO shape, applied to
display.] If a thinking display becomes something the system is evaluated on, thinking will
optimise for the display. Today ORIS does not adapt, so this is prospective — but the guard is
architectural and cheap now: **whatever is displayed must never become an input to any scoring or
promotion path.** This is ORIS-5's logic extended one hop, and it is much easier to hold before
Stage B than after.

**N6 · Other seats' rows, and any corpus content leaving the device unreviewed.** ORIS-16. The
corpus contains raw user prompts, which in this product carry client names, project titles, and
working notes. See §5.5 for a specific instance in the current implementation.

---

# PART 2 — Comparison with existing AI thinking interfaces

## 2.1 The discriminator

One question separates the honest from the theatrical, and it is not "does it look real":

> **Is the display a causal consequence of the state it depicts — such that if the state were
> different, the display would differ?**

A spinner bound to an outstanding request passes. A spinner on a timer fails. A token stream
rendered as it arrives passes. A pre-computed answer replayed character-by-character fails. The
test is mechanical and it settles most of the field.

A second question separates the *faithful* from the merely real, and it is the one the field
mostly ignores:

> **Is the display the computation, or a narration of it produced by the same system that did
> the computing?**

## 2.2 The survey

| Interface | Causally downstream? | Faithful? | Verdict | ORIS values |
|---|---|---|---|---|
| **Simulated typing** (replaying a finished response character-by-character) | ✗ | n/a | **Pure theater.** Depicts production that already ended | ORIS-2 violation — honesty (T0) |
| **Artificial delay** ("thinking…" padding to feel considered) | ✗ | n/a | **Pure theater**, and it spends the user's time to buy an impression | ORIS-2; also a T3 timing error deliberately incurred |
| **Animated thinking dots** | ✗ (usually) | n/a | **Theater by default.** Depicts nothing; an animation that runs identically whether the system is busy, stalled, or dead | ORIS-2 unless bound to real outstanding work |
| **Genuine streaming** (tokens as generated) | **✓** | ✓ for the token stream | **Honest.** The only universally-adopted honest one | Permitted |
| **Progress indicators** | Sometimes | — | **Depends entirely.** Honest against a countable denominator (3 of 7 clips); theater when the denominator is invented | Permitted iff the denominator is real |
| **Chain-of-thought display** (raw) | ✓ | **✗ — this is the problem** | **Real but unfaithful.** [PRIOR ART: the CoT-faithfulness results — models' stated reasoning demonstrably does not always describe the computation that produced the answer.] The user builds a model of a narrative, not of a system | Honesty risk: presenting narration as mechanism |
| **Reasoning summaries** (o1-style, summarised traces) | ✓ | ✗✗ | **Worse on faithfulness, better on noise.** A summary of an unfaithful trace | Same, compounded |
| **Agent step lists** (Cursor/Replit/Manus: "reading file… editing… running tests") | **✓** | **✓** | **Honest and the best in class.** Each row corresponds to an actual tool invocation with an actual result | Permitted; closest existing analogue to the ORIS panel |
| **Diff previews before apply** | ✓ | ✓ | **Honest, and it supplies M1** — the intervention window, which nothing else here does | Permitted; ORIS-1 and IX-9 aligned |
| **Confidence scores, uncalibrated** | ✓ | — | **Honest about the claim, dishonest by implication.** A number presented as though it means a frequency, when nothing checks it | Calibration (T2); becomes honest only with a ledger |

## 2.3 The finding that matters most for ORIS

Read the "faithful?" column. **The entire industry's flagship thinking display — chain of thought
— is the one that fails it.** A language model narrating its reasoning is producing text
conditioned on the same context that produced the answer; the narration is a plausible account,
not an instrumented trace, and the literature shows the two come apart.

> **[NOVEL, and it is ORIS's genuine structural advantage.]** ORIS's cognition is not a token
> stream that must be narrated. It is symbolic and recorded: a tier, a rule id, a registry action,
> a fact with an observer and an access path, a candidate with a score and a rejection reason.
> **The trace does not describe the decision — it *is* the decision path**, emitted by the code
> that took it. ORIS can therefore expose *faithful* cognition, which no LLM-first product can do
> at any level of model capability.

This is the strongest available answer to the brief's question of whether exposing cognition can
improve collaboration: **for chat-first systems the honest answer is "only weakly, because what
they can expose is not what they did." For ORIS the answer is open, because what it exposes is
what it did.** That asymmetry is why the experiment is worth running here and would not be worth
running elsewhere.

The second-order point: the agent step list (Cursor, Replit) is the closest existing analogue and
it is honest — but it is a list of *tool calls*, which is activity. It shows what the system
*touched*, never what it *considered and rejected*. Nobody ships M3. That gap is available.

---

# PART 3 — Evaluation of `?aiThinkingShow=1` as it stands

## 3.1 What it actually exposes

Read from the code, not the docs. The panel is a pure reader over the Experience Stream: it
subscribes, renders the last 200 rows newest-first, expands to the raw envelope, and offers
`copy json`, `clear`, `rows/list`, minimise, and drag. It never writes to the stream (except the
explicit Clear).

Per-row, expanded: `id`, `sessionId`, `refs`, `t`/`τ`/`dτ`, `tauInputs`, `tauPolicy`, `signals`,
and a kind-specific payload. Header stats: rows, decisions, sessions, episodes, τ,
bytes/row, and four health counters (`evicted`, `pinned`, `orphan facts`, `malformed`) that turn
amber or red when they should be zero.

**Wiring status, verified against production call sites:**

| Field | Phase | Wired? | Evidence |
|---|---|---|---|
| `prompt`, `route`, `zeroTokens`, `applied`/`failed`, `steps` | ⑤ | **✓** all three call sites | `AiChatPanel.tsx` |
| `owner` `{tier, ruleId, recipeId, provider}` | ④⑦ | **✓** all three | — |
| `actions[]` (structured) | ⑤ | **✓** two of three (reflex path applies nothing) | — |
| `startedAt` | ⑤ | **✗ partial — 2 of 3** | wired on the reflex and brain paths; **absent on the LLM model path** (§3.4 F1) |
| `confidence` | ④ | **✗ partial — 1 of 3** | brain/plan path only |
| `candidates[]` | ④ | **✗ never** | no production call site emits them |
| `situation` (σ) | ② | **✗ never** | `setSituation` has **zero** production call sites — every field is `null` |
| `factsConsulted[]` | ① | **✗ never** | `beginDecision`/`observeFact` have **zero** production call sites |
| `signals` | — | **✗ never** | `noteBoundarySignal` has **zero** production call sites |
| editor `action` rows (commit/undo/redo, `graphVersion`, `undoDepth`, `initiator`, `actionIds`) | ⑤ | **✓** | `EditorPage.tsx` via `appendEditCommit`/`appendHistoryAction` |
| `body` (frame headroom, decode pressure, gate) | ①⑦ | **✗ absent from the schema** | programme §12.1 item 10 — listed, not built |
| prediction rows | ④⑥ | **✗ reserved** | `ledger` producer declared with an empty kind list |

The `BUILD_COVERAGE` constant records this honestly and in the corpus — `decision.situation`,
`decision.facts`, `decision.candidates` are listed as *notably absent, on purpose*. That is the
implementation doing exactly what ADR-016 I12 demands, and it is the difference between a gap and
a hole: absence here is interpretable rather than ambiguous.

## 3.2 Does it reveal cognition, or activity? **Activity — and in the past tense**

This is the central evaluation and it has two parts.

**Part one: it shows outcomes of cognition, not cognition.** Of the eight calculus phases, the
panel can currently render evidence bearing on ⑤ (act) and partially ④ (the owner of the claim).
Phase ① is unwired (no facts), ② is unwired (σ all null), ④'s counterfactuals are unwired
(no candidates), and ⑥⑦⑧ do not exist yet by design (Stage B). **What remains visible is: a
prompt went in, a route was taken, N actions applied, M failed.** That is a record of activity.
It is a very good one — structured, faithful, joinable — but the deliberation is not in it,
because the deliberation is not yet captured.

**Part two, and the more fundamental one: every row is appended at completion.** All three call
sites construct the trace with `at: Date.now()` *after* the work is done and pass it to
`recordDecisionTrace`. There is no pending row, no in-flight state, no representation of "a
decision is happening now," no candidate visible while it is still a candidate, and no
representation of waiting or of a deliberate decision not to act.

Against §1.2, this eliminates the mechanisms outright:

| Mechanism | Available today? |
|---|---|
| M1 intervention window | **No** — requires present tense; there is none |
| M2 effort calibration | **Partial** — latency is derivable where `startedAt` is wired (§3.4 F1) |
| M3 competence via the search | **No** — `candidates[]` never emitted |
| M4 model-building | **Weakly** — route and owner are real and do teach the tier structure |
| M5 failure attribution | **Partial** — `applied`/`failed` and per-action `error`, but no phase ⑦ |
| M6 common ground | **No** — σ and facts are the grounding content, both unwired |
| M7 vicarious learning | **No** — nothing about craft is exposed |

> **Verdict: the panel is an excellent record of what the runtime did and a poor window into
> thinking, and the gap is not primarily field coverage — it is tense.** Even fully wired, a
> log that only ever describes completed decisions supplies M2, M4, M5 and not M1, M3, M7. Those
> three need cognition visible *while it is happening*, which is a different object (§7.2).

## 3.3 The brief's questions, answered directly

| Question | Verdict |
|---|---|
| Does it help a human understand what ORIS is doing? | **A developer, yes; a user, no.** It renders raw field names, τ, seq ids, and JSON. It is recipient-designed for someone who knows the schema — which is correct for its stated purpose and disqualifying for any other |
| Does it create shared attention? | **No, and it currently cannot** — σ is the representation of shared attention and it is entirely `null`. This is the single most consequential gap for the interaction research |
| Does it increase trust? | **Untested, and probably yes for a developer, via M4/M5.** No instrument exists to measure it. §6 proposes one |
| Does it improve interruption? | **No.** Interruption quality depends on knowing what ORIS is doing *now* and whether it is at a boundary. A completion log answers neither |
| Does it reduce uncertainty? | **About the past, yes — substantially.** About the present or the immediate future, no |
| Is it merely developer telemetry? | **It is developer telemetry, and that is not "merely."** It is unusually principled telemetry that happens to be built on the exact corpus a presence surface would need. Calling it a failed presence surface would be misreading what it was built to be |

## 3.4 Three findings not recorded in any document

Reported, not fixed. Two are gaps in coverage; the third is a question about an invariant.

**F1 · `startedAt` is missing on the LLM model path.** `AiChatPanel.tsx` supplies `startedAt` on
the reflex path and the brain/plan path, but the model-planned trace (`modelTrace`) omits it. The
consequence is precise and unfortunate: **latency is unmeasurable exactly on the slow route where
it matters most.** Every timing analysis (M2, OH-2, programme item 9's "temporal overlap"
rationale) is therefore blind on tier 3/4 traffic — the traffic whose duration is the entire
reason the tier cascade exists. The programme's §12.1 item 9 argues at length for keeping the
timestamp *pair* rather than a scalar; on this path neither exists.

**F2 · `confidence` is emitted on one path of three.** Only the brain/plan path carries
`{label, percent}`. H5 (calibration) is scoped, in practice, to plan-shaped decisions only —
narrower than the programme's framing suggests, and worth knowing before a year of corpus
accumulates and the reflex and model routes turn out to have no confidence history at all.

**F3 · `copy json` is an unreviewed export path for the whole corpus.** The button serialises
`{stats, events}` — every row, including raw `prompt` text — to the clipboard. ORIS-16 states
that *a psyche export is reviewable by the user before it leaves the device*, precisely because
prompts carry client names and project titles. A clipboard write is a leaving-the-device path.
Today this is behind a developer flag and the corpus is the developer's own, so the practical
risk is nil. But the invariant is written about the corpus, not about the flag — and §7 recommends
widening who sees this instrument. **This should be decided deliberately before that happens, not
discovered afterwards.** Flagged as a governance question, not a defect.

## 3.5 What is notably right

Recorded because the evaluation would be misleading without it, and because these properties are
what make the instrument reusable rather than disposable:

- **`null` renders as "null — not observed."** An unwired field is never visually
  indistinguishable from a measured absence. Most telemetry surfaces get this wrong and quietly
  poison every conclusion drawn from them.
- **The corpus records its own coverage** (`BUILD_COVERAGE`, `coveragePolicy`). Absence is
  interpretable.
- **Health counters are visible and go amber/red** — `malformed`, `orphan facts`, `evicted`,
  `pinned`. The instrument reports its own integrity, which is the property §5.6 depends on.
- **τ carries its inputs and its policy**, so the whole stream is re-derivable under a better
  model. This is the property that makes the corpus outlive the current guesses.
- **Episodes are derived on read, not stored** (schema v4). The provisional cut holds no
  privilege, so a year-old corpus can be re-segmented under a hypothesis nobody has had yet.
- **The panel cannot corrupt what it observes** — pure reader, and a throw in it cannot reach
  the stream.

That last set is why this document recommends *extending* the instrument rather than replacing it.

---

# PART 4 — The architectural role of the thinking timeline

## 4.1 The classification

The brief offers six candidates. Taking them in turn against the code:

| Candidate | Is it this? | Why |
|---|---|---|
| **Cognition** | **No** | It is a record of cognition. The map is not the territory, and conflating them is how a display becomes something the system optimises for (N5) |
| **Interaction** | **No** | It is one-way and affordance-free by design: subscribe, render, never write. Nothing the user does in it reaches ORIS |
| **Observability** | **Yes — this is what it is today** | Purpose-built to answer "what did the runtime actually do," for someone who knows the schema |
| **Explanation** | **No** | Explanation requires a recipient model and an addressee. This renders raw fields identically to everyone. (ORIS already has a real explanation path — the `t0.why` rule, deliberately guarded so a WHY answer never clobbers the trace it explains) |
| **Provenance** | **Yes — this is what it is *for*** | Every row is evidence with an owner, a policy, and a reference chain. Observability is the use; provenance is the architecture |
| **Something else** | Partially | Its most valuable property is one none of the six names: it is a **measurement instrument with a built-in control** (§6.1) |

> **The role, stated once:** the thinking timeline is the **read surface of the Experience Stream —
> a provenance instrument used for observability, whose flag makes it doubles as a randomisable
> experimental treatment.** It is not a presence surface, not an explanation, and not cognition,
> and every problem in §3.3 follows from having asked it to be one of those.

## 4.2 The tension, and why it does not need resolving

The corpus is governed by two rules that are exactly wrong for a partner:

- **ORIS-19** — interpretations have no natural observer, so nothing may be recorded as
  *accepted*, *rejected*, *good*, *frustrating*. Only events.
- **ORIS-20** — every derivation names its policy and version.

A human collaborator does the opposite: they interpret aggressively, summarise lossily, address
you specifically, and never cite a policy version. **Recipient design is interpretation.** So the
properties that make this corpus trustworthy are the same properties that make it unreadable as
presence, and no amount of field-wiring changes that.

The resolution is already in the architecture and requires nothing new:

```
ONE CORPUS  (state — expensive, governed by ORIS-17/18/19/20, grows under protest)
     │
     ├── evidence view    raw rows, nulls visible, policy ids, τ, seq      ← today's panel
     │                    audience: developer / researcher
     │
     └── presence view    derived, interpreted, recipient-designed          ← a VIEW
                          audience: the working editor
                          owes ORIS-20: names the policy that derived it
```

`ORIS_CALCULUS.md` §1.4 already declares views first-class: freely registered, documented,
independently evaluable, **exempt from the admission test**, and forbidden by rule V3 from ever
becoming load-bearing state. `ORIS_RESEARCH_PROGRAMME.md` §1 restates it — *"Psychology is open.
Views are free."* A presence surface is therefore admissible **today, under the freeze, with no
new state, no new operator, and no new subsystem.** That is the whole admissibility argument and
it is why this document proposes no architecture.

## 4.3 What that implies for the interaction research

`ORIS_INTERACTION.md` §10.4 sequences the presence substrate (Candidate E) second, after
interaction instrumentation. This investigation refines that:

- The **instrumentation** step is largely built. The Experience Stream *is* interaction
  instrumentation, and it already satisfies ORIS-18/19 — which the interaction document
  independently demanded in its §7.6.
- The **presence** step is a view over that corpus, not a new capture layer.
- The three fields the presence view most needs — σ, `candidates`, `confidence` — are the same
  three the programme's §12.1 audit already lists as must-capture-now (items 3, 4, 5).

> **The convergence is the practical result of this document.** Two research programmes derived
> from different premises — cognitive development, and interaction architecture — arrive at the
> same next action: **wire σ, candidates, and confidence.** Neither programme has to be
> prioritised over the other, and neither is being bent to fit; the work is genuinely shared.

---

# PART 5 — Risks of exposing internal cognition

## 5.1 The observer effect, in both directions [the primary validity threat]

**On the human.** A user who can see the machine's reasoning changes how they prompt — often
toward the machine's vocabulary. This is a *confound in every experiment in §6* and simultaneously
possibly a *benefit* (M4, M7). It cannot be eliminated; it must be measured, which is exactly what
§6.1's control arm is for.

**On the system.** Not live today — ORIS does not adapt (programme §10: no adaptation above B2 for
the entire programme). But the moment Stage B closes the loop, anything visible becomes something
the system's outcomes are conditioned on, and N5 becomes live. **The cheap guard is available now
and expensive later: whatever is displayed must never be an input to scoring or promotion.**

The repo has institutional memory here — the measurement-preconditions rule, and a
`flarex-observer-effect` probe in `tmp/`. The same discipline applies: prove the instrument is not
producing the reading.

## 5.2 Trust miscalibration, both directions

[PRIOR ART: Lee & See — the goal is *calibrated* trust; overtrust and undertrust are both
failures.]

- **Overtrust via the appearance of rigour.** A dense, technical, fast-scrolling display reads as
  competence independent of whether the reasoning was good. This is the specific way a thinking
  display can make things *worse*: it raises confidence without raising accuracy. It is also why
  the industry's chain-of-thought displays are risky — impressive narration, unverified relation
  to the computation (§2.3).
- **Undertrust via visible uncertainty.** Showing genuine uncertainty may reduce trust below the
  system's actual reliability. Note this is only a *failure* if the trust drop is unwarranted; if
  ORIS is genuinely unreliable in a domain, the drop is the system working.

The discriminator is calibration, and ORIS is the only system in this survey positioned to supply
it — which makes *"I'm 60% here, and historically when I say 60% in this domain I'm right 45% of
the time"* the honest form and a bare percentage the dishonest one. The programme already names
this as Stage A's one legitimate user-facing artifact (§A.4).

## 5.3 Attention theft — a craft cost wearing a fluency disguise

Editors look at frames for a living. Any persistent visible-cognition surface competes with the
picture for foveal attention. Per `ORIS_VALUES.md`, craft is T2 and fluency is T3: **spending
picture attention to buy interaction smoothness is a losing trade by the value hierarchy**, not a
matter of taste. This is `ORIS_INTERACTION.md` Q10 and it constrains every recommendation in §7 —
which is why nothing here proposes an always-visible surface and why the ambient class in §4's
taxonomy is deliberately the smallest.

## 5.4 False legibility — the user models the display, not the system

If the display is a lossy view, the user builds a model of the *view*. When view and system
diverge — and they will, since the view is derived under a policy that changes — the user's
predictions fail in ways they cannot diagnose, because they were never modelling the system.

This is the strongest argument for ORIS-20 applied to the presence view: **a derived presence
surface must name the policy that derived it**, so a divergence is attributable rather than
mysterious. It is also an argument for keeping the evidence view alive permanently rather than
replacing it: the raw corpus is the ground truth a confused user (or engineer) can fall back to.

## 5.5 Privacy and the corpus

The corpus contains raw prompts. In this product those carry client names, project titles, and
working notes. Two live consequences: §3.4 F3 (`copy json` is an unreviewed export path), and the
`seatId` partitioning question — a shared workstation produces one corpus with several people in
it, which ORIS-16 and `ORIS_ARCHITECTURE.md` §20 Q7 both leave open. Widening who sees this
instrument makes both questions live.

## 5.6 Exposure as a substitute for correctness

The subtlest risk. A visible thinking surface is *satisfying to build and demo*, and it can absorb
effort that belongs on being right. The programme's §9 rule is the antidote — write down results,
including nulls — and §6's kill criteria exist so this instrument can be judged rather than
admired.

## 5.7 The N=1 hazard, doubled

`ORIS_RESEARCH_PROGRAMME.md` §4 C.3 already warns about a single-user corpus. Here it is worse:
the sole subject is also the author of the architecture and the reader of the panel, so every
trust and legibility measurement is taken on someone with perfect prior knowledge of the schema.
**Trust findings from N=1-with-the-architect are not evidence about users**, and §6 marks which
hypotheses are subject-invariant (behavioural, corpus-derived) and which are not (trust,
legibility) precisely for this reason.

---

# PART 6 — Classification of observable cognitive events

## 6.1 An admission test for visibility

Mirroring `ORIS_CALCULUS.md` §5's admission test for state, and in the same spirit: the point is to
be able to **reject** proposals rather than accumulate them. Four questions, in order.

```
1. WITNESSED OR DERIVED?    If derived, does it name a policy and version (ORIS-20)?
                            → no policy ⇒ not displayable, at any class.

2. DOES IT CHANGE WHAT THE USER SHOULD DO NEXT?
                            → no ⇒ at best on-demand (V2). This alone demotes most of it.

3. WOULD DISPLAYING IT CREATE PRESSURE TO PERFORM, or is it a model OF THE USER?
                            → yes ⇒ never user-visible (V5). N2 and N5.

4. WHICH BAND PRODUCED IT?  Band sets the cadence; a B4 belief must not arrive at B1 speed
                            (ORIS_TIME.md §2.1, reach ≈ k × period).
```

## 6.2 The visibility classes

| Class | Meaning | Attention cost | Governing rule |
|---|---|---|---|
| **V0 · Ambient** | Continuously present, peripheral, never demands a glance | Must be ~zero (§5.3) | Honest state only; the smallest class |
| **V1 · Anchored** | Appears at the object it concerns, when it concerns it | Zero to ignore (IX-3) | Must resolve to a scoreable outcome (IX-6) |
| **V2 · On-demand** | Available, never pushed. The `t0.why` shape | Zero until requested | The default for anything failing test 2 |
| **V3 · Ceremonial** | Rare, announced, provenance-bearing | High, and appropriately so | Reserved for B5 events; none exist yet |
| **V4 · Instrument-only** | Developer/researcher surface | n/a — audience opted in | Today's panel |
| **V5 · Never** | Not displayed to the user at any time | — | N2, N4, N5 |

## 6.3 The classification

Events grouped by calculus phase, with band, class, and the mechanism each would serve. **Nothing
here is a proposal to build a surface** — it is a classification of events that already exist or
are already scheduled, so that the question "should this be visible" has an answer that is not
taste.

**Phase ② — situation (σ). Band B1.**

| Event | Class | Mechanism | Note |
|---|---|---|---|
| What ORIS is attending to (project, composition, panel, selection, target layers) | **V0** | M1, M6 | The highest-value/lowest-cost item in the entire classification (§1.3). Currently `null` |
| Whether ORIS is engaged or idle | **V0** | M4 | Distinguishes "not answering" from "not listening" |
| Body state — decode pressure, frame headroom, gate closed | **V0** | M2 | The honest reason to be quiet (`ORIS_INTERACTION.md` §7.7). Not in the schema yet |
| Which framing ORIS inferred (`C@B2` — "you are colour grading") | **V1** | M1, M5 | A mis-framing is an attributable error; making it visible makes it correctable *before* it costs anything |

**Phase ① — evidence. Band B1.**

| Event | Class | Mechanism | Note |
|---|---|---|---|
| Facts consulted, with observer and access path | **V2** | M5, M6 | Fails test 2 in the general case; decisive when something goes wrong. Classic on-demand |
| Cost of consulting them (`costMs`) | **V4** | — | Instrument. No user action depends on it |
| An observation ORIS could not make (coverage gap) | **V2** | M5 | *"I can't see that"* is more useful than most positive facts |

**Phase ④ — expectation. Band B1–B2.**

| Event | Class | Mechanism | Note |
|---|---|---|---|
| Candidates considered and rejected, with reasons | **V1** | **M3** | The single most under-supplied signal in the industry (§2.3). Never emitted today |
| Claimed confidence | **V1** | M2, M5 | Only honest **paired with its calibration record**; alone it is §5.2's overtrust device |
| Predicted outcome (what ORIS expects to happen to the work) | **V1** | M1, M5 | Stage B |
| Predicted *user reaction* | **V5** | — | N2. The asymmetry ruling: about the work yes, about the person no |

**Phase ⑤ — action. Band B1.**

| Event | Class | Mechanism | Note |
|---|---|---|---|
| A decision in flight (started, not finished) | **V0** | **M1** | The missing tense (§3.2). Present-tense state — a view, never a corpus row (§7.2) |
| What is about to be applied, before it is | **V1** | **M1** | The intervention window. Diff-preview shape (§2.2) |
| What was applied | **V1→V2** | M5 | Anchored briefly, then on-demand |
| A deliberate decision to wait (`⊥`), and why | **V1** | M4 | IX-5. Makes silence a contribution rather than an absence |
| Abandonment of a line of work | **V1** | M3 | Rare, honest, and nobody ships it |
| Preparation completed (warmed, analysed, indexed) | **V0** | M2, IX-15 | Availability, not a notification |

**Phases ⑥⑦⑧ — error, attribution, adaptation. Band B2. (Stage B; none exist yet.)**

| Event | Class | Note |
|---|---|---|
| A typed, tiered error | **V2** | Ranked by `V`; a T0 error is the one case that escalates to V1 |
| Attribution — which belief was wrong | **V2** | M5 in its strongest form |
| A belief changed, and by how much | **V2** | With its evidence chain (ORIS-8) |
| Raw contradictions not yet consolidated | **V5** | N3 |

**Off-loop — consolidation, promotion. Bands B3–B5.**

| Event | Class | Note |
|---|---|---|
| A pattern extracted across episodes | **V2** | B3–B4 cadence; must not arrive at B1 speed (test 4) |
| A promotion or revocation | **V3** | `ORIS_ARCHITECTURE.md` §10.3 already requires these to be *"logged, inspectable, user-visible events with full provenance"* — that is a V3 requirement already in the architecture |
| The character sheet | **V3** | Whether a working editor wants to read it is an open product question (`ORIS_ARCHITECTURE.md` §20 Q6) |
| Drives, valence scalars | **V5** | N4, ORIS-2 |

**Instrument-level.**

| Event | Class |
|---|---|
| τ, `dτ`, `tauInputs`, `tauPolicy`, `seq`, `refs`, schema version | **V4** |
| Health counters — malformed, orphaned, evicted, pinned | **V4** |
| Coverage record | **V4** |

## 6.4 What the classification shows

Three results worth stating separately.

1. **V0 is small — four items.** The ambient budget is nearly exhausted by attention, engagement,
   body state, and preparation. That is a useful constraint arriving from a values argument (§5.3)
   rather than from a design opinion, and it means "expose cognition" cannot mean "expose a lot."
2. **The two highest-value classes are the two least built.** V0's σ has zero call sites; V1's
   `candidates` has zero emitters. Everything currently rendered is V4.
3. **V5 is non-empty and principled.** The user model, unconsolidated contradictions, valence, and
   anything creating performance pressure. A visibility programme with an empty never-class has
   not been thought about.

---

# PART 7 — Experiments that can be performed immediately

## 7.1 The instrument's key property: a treatment with an invariant channel

`?aiThinkingShow=1` gates *the view*, not *the recording*. Recording happens in
`decision-trace.ts` and `EditorPage.tsx`, neither of which consults the flag. Therefore:

```
ARM A   flag off   ORIS behaves identically · corpus recorded identically · user sees nothing
ARM B   flag on    ORIS behaves identically · corpus recorded identically · user sees the trace
```

The dependent variables — prompt volume, prompt shape, undo latency, route distribution, session
structure — are measured **the same way in both arms**, by the same code, into the same schema.
Assignment can be randomised per session by the URL. There is no separate analytics path to
disagree with, and no instrumentation that exists only in the treatment arm.

> **This is the experimental design result of the document.** The observatory can measure its own
> effect on behaviour, within-subject, with no new code. Every hypothesis below that concerns
> *whether visibility helps* depends on this property, and it exists by accident of how the flag
> was implemented.

## 7.2 Runnable now, with zero code

The corpus as shipped contains AI decision rows (prompt, route, owner, applied/failed, timing on
two of three paths) and editor action rows (commit/undo/redo, `initiator`, `actionIds`,
`graphVersion`, `undoDepth`). Joined at read time and licensed by the session's coverage record,
that supports several real measurements today:

- **Undo-after-AI-commit latency and rate.** A rejection *proxy* — derived at read time, never
  stored (ORIS-19), licensed because `ai.initiator` is in coverage so an undeclared commit
  legitimately reads as not-AI-initiated. This is the closest thing to an outcome signal that
  exists before the ledger, and it is the dependent variable for OH-1 and OH-4.
- **Route distribution and escalation rate** — how much traffic actually reaches tiers 3/4.
- **Prompt-shape analysis** — directly answers `ORIS_INTERACTION.md` IH-1 (the grounding tax) and
  IH-10 (the chat-ablation) against a live corpus rather than the frozen `AI_REFINEMENT.md` log.
- **Session and episode structure** under the provisional policy, plus the baseline policies
  already exported for comparison.

**Recommendation: run the arm-A/arm-B split on these four before wiring anything.** They cost
analysis time only, and they establish the baseline against which every later change is measured —
which is exactly the measurement-preconditions discipline this repo already enforces.

## 7.3 The hypotheses

Numbered `OH-n`, cross-referenced to `ORIS_INTERACTION.md` (`IH-n`) and the programme (`H-n`).
Each states the instrument state required, so that "we cannot test this yet" is visible rather
than discovered halfway through.

**OH-1 · Visibility reduces prompt volume.** [M4; ↔ IH-3] Seeing what ORIS is doing lets the user
predict it, so they ask less. *Runnable:* **now** (arm split).
*Metric:* prompts per applied action; prompts per session; share of prompts classified as
status-seeking ("did you do X", "what did you do").
*Predicted:* status-seeking prompts fall materially in arm B. *Kill:* prompt volume rises in
arm B — visibility is generating conversation rather than replacing it, which would be a genuine
and important negative result for the whole "presence" thesis.

**OH-2 · Honest latency changes asking behaviour.** [M2; ↔ IH-13/IX-13] Users who can see route
and duration shift their asks toward cheaper routes.
*Runnable:* **after F1 is fixed** — latency is currently unmeasurable on the LLM path, which is
the only path where this effect could appear.
*Metric:* tier distribution over time, arm B vs arm A. *Predicted:* tier-3/4 share declines in
arm B. *Kill:* no shift, meaning route labels are not being read as cost signals.

**OH-3 · Visible attention (σ) reduces referential prompt tokens.** [M6; ↔ IH-1, and the
strongest test of `ORIS_INTERACTION.md`'s central claim] If the user can see *what ORIS is looking
at*, they stop describing it.
*Runnable:* **requires σ wired** (the top recommendation in §8).
*Metric:* mean referring-expression tokens per prompt, arm B vs arm A, matched by intent class.
*Predicted:* a large drop. *Kill:* no drop — which would falsify IH-1's mechanism even if IH-1's
volume measurement holds, and would be the single most informative negative result available.

**OH-4 · Pre-commitment visibility reduces undo rate.** [M1 — the intervention window; ↔ IH-11]
If what is about to be applied is visible before it is applied, corrections move earlier and
undos fall.
*Runnable:* **requires a present-tense view** (§8, item 3). Note the guardrail: an in-flight row
is not evidence — it has not happened — so it must live in the view and never be written to the
corpus.
*Metric:* undo-within-60s rate after AI commits; time-to-correction. *Predicted:* undo rate falls,
time-to-correction falls sharply. *Kill:* undo rate unchanged, meaning the window is not being
used and M1 does not transfer to software.

**OH-5 · Rejected candidates increase trust more than confidence scores do.** [M3 vs a bare
number; ↔ §2.3] The roads not taken are stronger competence evidence than a percentage.
*Runnable:* **requires `candidates[]` emitted**.
*Metric:* trust-calibration instrument plus a behavioural proxy — plan-review acceptance rate at
matched confidence. *Predicted:* candidates beat confidence alone. *Kill:* no difference, which
would mean M3 does not transfer and would save building the most expensive capture in the audit.
**Subject-sensitive** — see §5.7.

**OH-6 · Calibrated confidence beats bare confidence.** [↔ H5, §5.2] *"60%, and I'm right 45% of
the time when I say that here"* produces better-calibrated user trust than "60%".
*Runnable:* **requires the Prediction Ledger** (Stage B) *and* F2 fixed.
*Metric:* user acceptance rate as a function of stated confidence, versus realised accuracy —
i.e. whether the user's trust curve tracks the system's actual accuracy curve.
*Kill:* users respond to the number and ignore the record.

**OH-7 · Visible waiting is read as a decision, not a failure.** [IX-5] An explicit `⊥` with a
reason changes how silence is interpreted.
*Runnable:* **requires `⊥` to be representable** — it currently is not, since only completed
decisions produce rows.
*Metric:* re-prompt rate during periods where ORIS deliberately withheld. *Predicted:* re-prompts
fall. *Kill:* unchanged — silence is illegible regardless of annotation.

**OH-8 · Visible preparation reduces redundant requests.** [M2, IX-15; ↔ IH-5] If prepared work is
visible as *available*, users stop asking for what is already done.
*Runnable:* **requires preparation to exist** — it does not yet.
*Metric:* utilisation rate of prepared artifacts; requests for already-prepared work.
*Kill:* prepared work goes unused, which would collapse `ORIS_INTERACTION.md`'s Candidate F.

**OH-9 · The observer effect on prompting is real and bounded.** [§5.1 — a validity check, not a
feature test] Arm-B users converge toward ORIS's own vocabulary.
*Runnable:* **now**. *Metric:* lexical overlap between prompts and route/rule vocabulary, over
sessions. *Predicted:* measurable convergence. *Interpretation:* this is a confound for every
other hypothesis and possibly a benefit (M7) — it must be measured either way, and measuring it
first is what keeps the rest honest.

**OH-10 · Exposure does not degrade the editor.** [ORIS-6 — the gate every other result passes
through] *Runnable:* **now**. *Metric:* frame time and dropped frames with the panel mounted vs
not, via the existing `FrameProfiler`. *Kill:* any measurable frame cost — in which case the
surface is wrong regardless of how well it scores on OH-1 through OH-9. Worth running early and
cheaply, because a positive trust result on a surface that stutters playback is not a result.

## 7.4 Sequencing

```
NOW (no code)          OH-9 (confound), OH-10 (gate), OH-1 (headline), §7.2 baselines
AFTER F1/F2 fixed      OH-2, and honest timing for everything else
AFTER σ wired          OH-3   ← the strongest single test of the interaction thesis
AFTER candidates       OH-5
AFTER present-tense    OH-4, OH-7
STAGE B                OH-6
LATER                  OH-8
```

Run OH-9 and OH-10 **first**. One measures the confound that contaminates everything else; the
other is the invariant that voids everything else. That ordering is the repo's own
measurement-preconditions discipline applied to this instrument.

---

# PART 8 — Recommendations

Ordered by leverage. Every item is either a wiring of a seam that already exists, a view (free per
§4.2), or a decision. **No new state, no new operators, no new subsystems, no UI.**

**R1 · Wire σ (`setSituation`).** Zero production call sites today; every field renders `null`.
This is simultaneously: programme §12.1 item 3 (must-capture-now, irrecoverable, blocks Stage C
segmentation and H6), the V0 top entry in §6.3, the enabler of OH-3, and the content of
`ORIS_INTERACTION.md`'s presence substrate. **One wiring, four programmes.** Nothing else in this
document has that ratio.

**R2 · Close the two coverage gaps in §3.4.** `startedAt` on the LLM model path (F1), and
`confidence` on the reflex and model paths (F2). Both are single-call-site additions to data that
already exists at the call site, and both are irrecoverable once a corpus accumulates without
them. F1 in particular blinds timing analysis on exactly the traffic where timing matters.

**R3 · Emit `candidates[]`.** The most irrecoverable class in the system (programme §12.1 item 4),
the M3 mechanism, and the one thing no competing product exposes (§2.3). Higher effort than R1/R2
because the router must surface what it rejected — which is why it is third and not first.

**R4 · Decide the `copy json` question (F3) before widening the audience.** A governance decision
about ORIS-16, not a defect. Cheap to settle now; awkward to retrofit onto a corpus that has
already been shared.

**R5 · Introduce a present-tense representation — as a view, never as corpus rows.** This is the
fix for the tense finding (§0.1, §3.2), and it carries the sharpest guardrail in this document:

> **An in-flight decision has not happened. It is not evidence, and it must never be written to
> the Experience Stream.** A pending row would assert an occurrence that may never occur — the
> ADR-016 I10 fabrication pattern in its purest form. Present-tense cognition is standing state
> rendered by a view, and it disappears when it resolves into a row that *is* evidence.

**R6 · Fork the reader into two views over one corpus** (§4.2): the existing evidence view
(V4, unchanged, permanently) and a presence view (V0/V1, derived, recipient-designed, naming its
policy per ORIS-20). Admissible today under the freeze because views are free. This is the point
at which the next question becomes visual, and **this document stops here deliberately** — what
the presence view looks like is a design question that should not be answered until OH-3 and OH-9
have reported.

**R7 · Keep the flag as the treatment variable, and add a second flag rather than replacing it.**
Three arms — none / evidence / presence — with recording invariant across all three. The moment
the presence view is gated by something that also changes recording, §7.1's property is lost and
every subsequent result becomes uninterpretable.

**R8 · Do not let the observatory become a feature.** Programme §A.4 already says Stage A is not a
feature and names its one legitimate user-facing artifact (calibrated confidence). This document
adds a reason specific to visibility: the moment the thinking display is something the product is
judged on, N5 goes live and the display starts shaping the cognition. **Whatever is displayed must
never become an input to scoring or promotion** — cheap to hold now, expensive after Stage B.

## 8.1 What would falsify the premise

Recorded so the whole line of work can fail, per house convention:

- **OH-1 inverts** — visibility increases prompt volume. Exposure generates conversation rather
  than replacing it, and the presence thesis in `ORIS_INTERACTION.md` weakens considerably.
- **OH-3 shows no drop in referential tokens after σ is wired.** The grounding mechanism does not
  transfer, and IH-1's remedy fails even if its measurement holds. This is the most consequential
  possible negative result and it becomes available immediately after R1.
- **OH-10 shows measurable frame cost.** ORIS-6 is not negotiable; the surface is wrong at any
  trust score.
- **OH-5 shows candidates do not beat a bare confidence number.** M3 does not transfer, and R3 —
  the most expensive recommendation here — is not worth building.

## 8.2 The one-sentence form

> **The thinking timeline is not a window into cognition and should not be made into one; it is a
> provenance instrument whose flag makes it a controlled experiment, and its correct evolution is
> to wire the three seams that are already overdue, add a present-tense *view* that never becomes
> evidence, and use the arm split to find out whether visible cognition helps at all — before
> anyone designs what it should look like.**

---

## Appendix A — Where each brief question is answered

| Brief question | Section |
|---|---|
| Why watching a human think increases trust | §1.2 (seven mechanisms) |
| Which properties matter (timing, uncertainty, revision, …) | §1.3 |
| Which properties should never be exposed | §1.4 (N1–N6), §6.3 (class V5) |
| Why current AI thinking displays feel artificial | §2.1 (the discriminator), §2.2 |
| Which are theatrical / genuine / values-violating | §2.2 (the survey table) |
| What `?aiThinkingShow=1` currently exposes | §3.1 (verified against call sites) |
| What is missing | §3.1, §3.4 (three undocumented findings) |
| Cognition or activity? | §3.2 — activity, and in the past tense |
| Shared attention / trust / interruption / uncertainty | §3.3 |
| Correct architectural role | Part 4 — provenance, used for observability, doubling as an experimental treatment |
| Should every internal process be visible | §6.1 (admission test), §6.2 (classes) |
| Which events belong in shared attention / stay private | §6.3 (the classification) |
| Risks of exposure | Part 5 |
| Experiments performable immediately | §7.2 (zero-code), §7.3 (OH-1…OH-10), §7.4 (order) |
| Recommendations for evolving the instrument | Part 8 |

## Appendix B — Claims believed novel

1. **The tense finding** (§3.2). A completed-decision log cannot supply the intervention window,
   the search, or vicarious learning, regardless of field coverage. Presence is present-tense.
2. **The faithfulness asymmetry** (§2.3). ORIS can expose cognition that *is* the decision path;
   chain-of-thought products expose a narration that demonstrably diverges from the computation.
   This is why the experiment is worth running here and not elsewhere.
3. **The flag is a treatment with an invariant measurement channel** (§7.1). The observatory can
   measure its own effect, within-subject, with no new code.
4. **An admission test for visibility** (§6.1), mirroring the calculus's test for state — with a
   non-empty never-class, and built to reject rather than accumulate.
5. **The exposure asymmetry** (N2): ORIS may show what it thinks about the work and should not
   show what it thinks about the person.
6. **Hesitation cannot transfer honestly** (§1.3). Human hesitation informs *because* it is
   involuntary; anything ORIS displays was authored, so ORIS-2 rules it out — a clean ruling from
   an existing invariant.
7. **The three-programme convergence** (§4.3). Cognitive development and interaction architecture,
   derived from different premises, name the same next action: wire σ, candidates, confidence.
8. **In-flight state must never be a corpus row** (R5). A pending row asserts an occurrence that
   may never occur — the fabrication pattern ADR-016 I10 already forbids, in a new place.
